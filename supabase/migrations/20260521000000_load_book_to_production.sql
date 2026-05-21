-- ============================================================
-- load_book_to_production
-- Atomic replacement of Books, Books_Units, Books_Pieces
-- from books_staging for a single verified book.
--
-- Eligibility map remapping — two-phase approach:
--   Phase A (before DELETE): temporarily remap all eligibility
--     map rows to a safe anchor (first piece of another book,
--     or NULL if FK allows) so the books_pieces DELETE succeeds.
--     Actually: we set earliest_piece_id to NULL temporarily
--     using a deferred constraint, OR we remap to the book
--     fallback piece AFTER insert. Correct sequence:
--
--   Correct sequence:
--   1. Snapshot old piece identity (unit, page, title)
--   2. Nullify earliest_piece_id on affected eligibility rows
--      (requires FK to be deferrable, or we use a two-step remap)
--   3. Delete + reinsert books_pieces
--   4. Remap using three-step cascade (direct → unit → book)
--
-- Since the FK may not be deferrable, we use a workaround:
--   Before DELETE: point all affected eligibility rows at a
--   DIFFERENT valid piece_id (from another book) temporarily.
--   After INSERT: run the three-step cascade to correct them.
--   This avoids any FK violation at any point in the transaction.
--
-- Run once in the Supabase SQL editor.
-- Re-run safely — DROP + CREATE handles signature changes.
--
-- Called exclusively by the load-book Edge Function,
-- which has already verified the caller is an admin.
--
-- SECURITY DEFINER: runs with owner privileges so it can
-- write to production tables regardless of RLS.
-- ============================================================

DROP FUNCTION IF EXISTS public.load_book_to_production(UUID);

CREATE OR REPLACE FUNCTION public.load_book_to_production(p_book_id UUID)
RETURNS TABLE (
  success                BOOLEAN,
  books_action           TEXT,     -- 'inserted' or 'updated'
  units_loaded           INTEGER,
  pieces_loaded          INTEGER,
  eligibility_direct     INTEGER,  -- rows preserved via direct piece match
  eligibility_unit       INTEGER,  -- rows remapped via unit fallback
  eligibility_book       INTEGER,  -- rows remapped via book fallback
  error_message          TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_staging_count        INTEGER;
  v_status               TEXT;
  v_book_exists          BOOLEAN;
  v_units_loaded         INTEGER := 0;
  v_pieces_loaded        INTEGER := 0;
  v_eligibility_direct   INTEGER := 0;
  v_eligibility_unit     INTEGER := 0;
  v_eligibility_book     INTEGER := 0;
  v_safe_anchor_id       UUID;
  v_fallback_piece_id    UUID;
  v_books_action         TEXT;

  -- Book-level fields read from staging (same on every row)
  v_series_id            UUID;
  v_display_name         VARCHAR(200);
  v_full_display         VARCHAR(300);
  v_edition              VARCHAR(80);
  v_sequence_num         INTEGER;

BEGIN

  -- ── 1. Confirm staging rows exist and are verified ──────────────────
  SELECT COUNT(*), MAX(book_status)
  INTO v_staging_count, v_status
  FROM books_staging
  WHERE book_id = p_book_id;

  IF v_staging_count = 0 THEN
    RETURN QUERY SELECT false, NULL::TEXT, 0, 0, 0, 0, 0,
      'No staging rows found for book_id ' || p_book_id::TEXT;
    RETURN;
  END IF;

  IF v_status != 'verified' THEN
    RETURN QUERY SELECT false, NULL::TEXT, 0, 0, 0, 0, 0,
      'Book status is ''' || v_status || ''' — must be ''verified'' before load.';
    RETURN;
  END IF;

  -- ── 2. Read book-level fields from staging ──────────────────────────
  SELECT series_id, book_display_name, full_display_name,
         edition, sequence_number
  INTO v_series_id, v_display_name, v_full_display,
       v_edition, v_sequence_num
  FROM books_staging
  WHERE book_id = p_book_id
  LIMIT 1;

  -- ── 3. Determine INSERT vs UPDATE on Books ──────────────────────────
  SELECT EXISTS (
    SELECT 1 FROM books WHERE book_id = p_book_id
  ) INTO v_book_exists;

  -- ── 4. Books write ──────────────────────────────────────────────────
  IF v_book_exists THEN
    UPDATE books SET
      display_name      = v_display_name,
      full_display_name = v_full_display,
      edition           = v_edition,
      sequence_number   = v_sequence_num,
      updated_at        = NOW()
    WHERE book_id = p_book_id;

    v_books_action := 'updated';
  ELSE
    INSERT INTO books (
      book_id, series_id, display_name, full_display_name,
      edition, sequence_number, is_active, created_at, updated_at
    ) VALUES (
      p_book_id, v_series_id, v_display_name, v_full_display,
      v_edition, v_sequence_num, true, NOW(), NOW()
    );

    v_books_action := 'inserted';
  END IF;

  -- ── 5. Replace Books_Units ──────────────────────────────────────────
  DELETE FROM books_units WHERE book_id = p_book_id;

  INSERT INTO books_units (
    series_id, book_id, unit_label, unit_sort_order,
    unit_title, unit_skill_focus, created_at
  )
  SELECT DISTINCT ON (unit_label)
    v_series_id,
    p_book_id,
    unit_label,
    unit_sort_order,
    unit_title,
    unit_skill_focus,
    NOW()
  FROM books_staging
  WHERE book_id = p_book_id
    AND unit_label IS NOT NULL
  ORDER BY unit_label, row_id;

  GET DIAGNOSTICS v_units_loaded = ROW_COUNT;

  -- ── 6. Snapshot old piece identity before deleting ──────────────────
  --    Captures unit_label, page_start, piece_title for each
  --    eligibility map row so we can re-anchor after the new
  --    pieces are inserted.
  CREATE TEMP TABLE _elig_snapshot ON COMMIT DROP AS
  SELECT
    sem.eligibility_map_id,
    bp.unit_label   AS old_unit_label,
    bp.piece_title  AS old_piece_title,
    bp.page_start   AS old_page_start
  FROM supplement_eligibility_map sem
  JOIN books_pieces bp ON bp.piece_id = sem.earliest_piece_id
  WHERE sem.book_id = p_book_id;

  -- ── 7. Find a safe temporary anchor from a DIFFERENT book ──────────
  --    We need to point affected eligibility map rows away from
  --    this book's pieces before we delete them, satisfying the FK.
  --    We use the first piece_id from any other book as a placeholder.
  SELECT piece_id INTO v_safe_anchor_id
  FROM books_pieces
  WHERE book_id != p_book_id
  LIMIT 1;

  IF v_safe_anchor_id IS NULL THEN
    RAISE EXCEPTION
      'No pieces found in other books to use as temporary FK anchor. Cannot proceed.';
  END IF;

  -- ── 8. Temporarily remap eligibility map rows to safe anchor ────────
  --    This satisfies the FK so the DELETE in Step 9 can proceed.
  UPDATE supplement_eligibility_map sem
  SET earliest_piece_id = v_safe_anchor_id
  FROM _elig_snapshot snap
  WHERE sem.eligibility_map_id = snap.eligibility_map_id;

  -- ── 9. Replace Books_Pieces ─────────────────────────────────────────
  --    FK is now satisfied — no eligibility rows reference this book.
  DELETE FROM books_pieces WHERE book_id = p_book_id;

  INSERT INTO books_pieces (
    series_id, book_id, unit_label, unit_sort_order,
    piece_title, piece_type, page_start, page_end,
    student_instructions, created_at
  )
  SELECT
    v_series_id,
    p_book_id,
    unit_label,
    unit_sort_order,
    piece_title,
    piece_type,
    page_start,
    page_end,
    student_instructions,
    NOW()
  FROM books_staging
  WHERE book_id = p_book_id
  ORDER BY unit_sort_order, page_start, row_id;

  GET DIAGNOSTICS v_pieces_loaded = ROW_COUNT;

  -- ── 10. Count integrity check ────────────────────────────────────────
  IF v_pieces_loaded != v_staging_count THEN
    RAISE EXCEPTION
      'Piece count mismatch: staging had % rows, production inserted %. Rolling back.',
      v_staging_count, v_pieces_loaded;
  END IF;

  -- ── 11. Remap eligibility map — three-step cascade ───────────────────
  --    New pieces are now in place. Remap from the safe anchor
  --    to the correct new pieces using best available match.

  -- Book fallback anchor: first piece of this book by sort order + page
  SELECT piece_id INTO v_fallback_piece_id
  FROM books_pieces
  WHERE book_id = p_book_id
  ORDER BY unit_sort_order, page_start
  LIMIT 1;

  -- Step 11a — Direct match
  --   unit_label + page_start + normalized piece_title all match.
  --   Manual curation is preserved exactly.
  UPDATE supplement_eligibility_map sem
  SET earliest_piece_id = (
    SELECT bp.piece_id
    FROM books_pieces bp
    WHERE bp.book_id    = p_book_id
      AND bp.unit_label = snap.old_unit_label
      AND bp.page_start = snap.old_page_start
      AND REGEXP_REPLACE(LOWER(TRIM(bp.piece_title)), '[^a-z0-9]', '', 'g')
        = REGEXP_REPLACE(LOWER(TRIM(snap.old_piece_title)), '[^a-z0-9]', '', 'g')
    LIMIT 1
  )
  FROM _elig_snapshot snap
  WHERE sem.eligibility_map_id = snap.eligibility_map_id
    AND EXISTS (
      SELECT 1 FROM books_pieces bp
      WHERE bp.book_id    = p_book_id
        AND bp.unit_label = snap.old_unit_label
        AND bp.page_start = snap.old_page_start
        AND REGEXP_REPLACE(LOWER(TRIM(bp.piece_title)), '[^a-z0-9]', '', 'g')
          = REGEXP_REPLACE(LOWER(TRIM(snap.old_piece_title)), '[^a-z0-9]', '', 'g')
    );

  GET DIAGNOSTICS v_eligibility_direct = ROW_COUNT;

  -- Step 11b — Unit fallback
  --   No direct match but unit_label exists in new pieces.
  --   Remap to earliest page_start piece in that unit.
  UPDATE supplement_eligibility_map sem
  SET earliest_piece_id = (
    SELECT bp.piece_id
    FROM books_pieces bp
    WHERE bp.book_id    = p_book_id
      AND bp.unit_label = snap.old_unit_label
    ORDER BY bp.page_start
    LIMIT 1
  )
  FROM _elig_snapshot snap
  WHERE sem.eligibility_map_id = snap.eligibility_map_id
    AND NOT EXISTS (
      SELECT 1 FROM books_pieces bp
      WHERE bp.book_id    = p_book_id
        AND bp.unit_label = snap.old_unit_label
        AND bp.page_start = snap.old_page_start
        AND REGEXP_REPLACE(LOWER(TRIM(bp.piece_title)), '[^a-z0-9]', '', 'g')
          = REGEXP_REPLACE(LOWER(TRIM(snap.old_piece_title)), '[^a-z0-9]', '', 'g')
    )
    AND EXISTS (
      SELECT 1 FROM books_pieces bp
      WHERE bp.book_id    = p_book_id
        AND bp.unit_label = snap.old_unit_label
    );

  GET DIAGNOSTICS v_eligibility_unit = ROW_COUNT;

  -- Step 11c — Book fallback
  --   Unit label not found in new pieces at all.
  --   Remap to first piece of the book.
  UPDATE supplement_eligibility_map sem
  SET earliest_piece_id = v_fallback_piece_id
  FROM _elig_snapshot snap
  WHERE sem.eligibility_map_id = snap.eligibility_map_id
    AND NOT EXISTS (
      SELECT 1 FROM books_pieces bp
      WHERE bp.book_id    = p_book_id
        AND bp.unit_label = snap.old_unit_label
    );

  GET DIAGNOSTICS v_eligibility_book = ROW_COUNT;

  -- ── 12. Clear staging rows on success ───────────────────────────────
  DELETE FROM books_staging WHERE book_id = p_book_id;

  -- ── 13. Return success ───────────────────────────────────────────────
  RETURN QUERY SELECT
    true,
    v_books_action,
    v_units_loaded,
    v_pieces_loaded,
    v_eligibility_direct,
    v_eligibility_unit,
    v_eligibility_book,
    NULL::TEXT;

EXCEPTION
  WHEN OTHERS THEN
    RETURN QUERY SELECT
      false,
      NULL::TEXT,
      0,
      0,
      0,
      0,
      0,
      SQLERRM;
END;
$func$;

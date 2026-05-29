"""
discover_supplements.py
Creative Note — Supplement Ingestion Phase 1: Discovery

Crawls WunderKeys listing pages and inserts new-only supplement URLs
to the supplement_staging table in Supabase.

Usage:
    python discover_supplements.py --catalog toolkit --series-id <UUID>
    python discover_supplements.py --catalog piano-books --series-id <UUID>

Reads credentials from .env in the same directory:
    SUPABASE_URL
    SUPABASE_SECRET_KEY
    WK_POSTPASS   (required for toolkit catalog only)

Logs to logs/discover_YYYYMMDD.log
"""

import argparse
import logging
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import html
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WK_BASE = "https://www.wunderkeys.com"

TOOLKIT_LISTING_PATH = "/members-only-printables/"
PIANO_BOOKS_LISTING_PATH = "/piano-books-music/"

# Known category slugs for the toolkit catalog (Pass B).
# Update this list if WK adds new category filters.
TOOLKIT_CATEGORY_SLUGS = [
    "intermediate",
    "level-1",
    "level-2",
    "older-beginner",
    "preschool",
    "primer",
    "studio-tools",
    "v-u-library",
]

# FacetWP topic taxonomy slugs for the toolkit catalog (Pass C).
# Update this list if WK adds new topic filters.
FACETWP_TOPICS = [
    "brag-tags", "card-packs", "certificates",
    "christmas", "composing", "dynamics", "ear-training",
    "halloween", "lesson-sheets", "level-a", "level-b", "level-c",
    "level-d", "level-e", "level-f", "level-g", "level-h", "level-i",
    "level-j", "level-k", "level-l", "level-m", "level-n", "level-o",
    "level-p", "level-q", "level-x", "level-y", "music-history",
    "note-printing", "note-reading", "other-holidays",
    "parent-information", "photo-props", "practice-trackers",
    "pre-reading", "primer-1", "primer-2", "primer-3",
    "primer-one-1st-edition-games", "primer-three-1st-edition",
    "primer-two-1st-edition-games", "punch-cards",
    "recital-resources", "rhythm", "sheet-music", "sight-reading",
    "summer-theme", "wall-decor", "welcome-resources",
]

# Topics that indicate studio_admin match_context.
STUDIO_ADMIN_TOPICS = {
    "brag-tags", "certificates", "parent-information",
    "photo-props", "punch-cards", "recital-resources",
    "wall-decor", "welcome-resources", "practice-trackers",
}

# Studio-admin topics that are actually practice_behaviour.
PRACTICE_TOPICS = {"practice-trackers", "punch-cards"}

# Topic-to-season map. Keys are FacetWP topic slugs; values are canonical
# season_label values from the season_windows table. Keep in sync with
# season_windows if new seasons are added.
TOPIC_SEASON_MAP = {
    "christmas":    "Christmas",
    "halloween":    "Halloween",
    "summer-theme": "Summer",
}

# Title keyword patterns for season detection. Checked before topic map.
# Labels must exactly match season_label values in the season_windows table.
SEASON_TITLE_PATTERNS = {
    "Christmas":      r"\b(?:Christmas|Holiday|Festive|Advent|Xmas|Jingle|Reindeer|Santa|Yuletide|Noel)\b",
    "Halloween":      r"\b(?:Halloween|Spooky|Pumpkin|Trick|Haunt|Witch)\b",
    "Valentine":      r"\b(?:Valentine|Heart(?:\s+Day)?|Love\s+Day)\b",
    "Easter":         r"\b(?:Easter|Bunny|Egg\s+Hunt)\b",
    "Summer":         r"\b(?:Summer|Beach|Vacation)\b",
    "Fall":           r"\b(?:Fall\b|Autumn|Harvest|Scarecrow)\b",
    "Winter":         r"\b(?:Winter|Snowman|Snow\b)\b",
    "Spring":         r"\b(?:Spring\b|Flower|Garden)\b",
    "St. Patrick":    r"\b(?:St\.?\s*Patrick|Shamrock|Leprechaun|Irish)\b",
    "Thanksgiving":   r"\b(?:Thanksgiving|Turkey)\b",
    "New Year":       r"\b(?:New\s+Year|Auld\s+Lang)\b",
    "Back to School": r"\b(?:Back\s+to\s+School|New\s+School\s+Year)\b",
    "Father's Day":   r"\b(?:Father|Dad\b|Papa)\b",
}

# Regex to extract VU level code (single letter A-Y) from piano-book titles.
# Matches patterns like "Level A:", "Level B —", "Level J:"
VU_LEVEL_RE = re.compile(r'\bLevel\s+([A-Y])\b', re.IGNORECASE)

# Password form detection — cookie has expired if this input is present.
COOKIE_EXPIRED_MARKER = 'name="post_password"'

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

def setup_logging():
    log_dir = Path("logs")
    log_dir.mkdir(exist_ok=True)
    log_filename = log_dir / f"discover_{datetime.now().strftime('%Y%m%d')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_filename, encoding="utf-8"),
        ],
    )
    return logging.getLogger(__name__)


log = setup_logging()

# ---------------------------------------------------------------------------
# Supabase helpers (plain REST — no SDK dependency)
# ---------------------------------------------------------------------------

def sb_headers(secret_key):
    return {
        "apikey": secret_key,
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def fetch_existing_urls(supabase_url, secret_key, series_id):
    """Return a set of all source_urls already in supplements or supplement_staging."""
    existing = set()

    for table in ("supplements", "supplement_staging"):
        url = (
            f"{supabase_url}/rest/v1/{table}"
            f"?select=source_url&series_id=eq.{series_id}"
        )
        resp = requests.get(url, headers=sb_headers(secret_key), timeout=30)
        resp.raise_for_status()
        rows = resp.json()
        for row in rows:
            existing.add(row["source_url"])
        log.info("  %s: %d existing URLs loaded from %s", series_id[:8], len(rows), table)

    log.info("Total existing URLs (both tables): %d", len(existing))
    return existing



def insert_staging_rows(supabase_url, secret_key, rows):
    """Batch-insert new rows to supplement_staging. Returns count inserted."""
    if not rows:
        return 0

    url = f"{supabase_url}/rest/v1/supplement_staging"
    resp = requests.post(
        url,
        headers=sb_headers(secret_key),
        json=rows,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        log.error("Insert failed: %s  %s", resp.status_code, resp.text[:500])
        resp.raise_for_status()

    log.info("Inserted %d new rows to supplement_staging", len(rows))
    return len(rows)


# ---------------------------------------------------------------------------
# WK HTTP helpers
# ---------------------------------------------------------------------------

def wk_session(postpass_cookie=None):
    """Return a requests.Session with WK headers set."""
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    })
    if postpass_cookie:
        # Split name=value and use the cookie jar so requests handles encoding correctly.
        name, value = postpass_cookie.split("=", 1)
        s.cookies.set(name, value, domain="wunderkeys.com")
    return s


def check_cookie_expired(html):
    """Raise if the page is a password form (cookie expired)."""
    if COOKIE_EXPIRED_MARKER in html:
        log.error(
            "Cookie expired — page returned a password form. "
            "Refresh WK_POSTPASS in .env and the Config table, then re-run."
        )
        sys.exit(1)


def fetch_page(session, url, label="page"):
    """GET a URL and return the response text, or None on error."""
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        return resp.text
    except requests.RequestException as exc:
        log.warning("  Fetch failed: %s  (%s)", url, exc)
        return None


# ---------------------------------------------------------------------------
# Toolkit catalog — Pass A (unfiltered) + Pass B (category iteration)
# ---------------------------------------------------------------------------

def clean_title(anchor):
    """
    Extract a clean title from a toolkit listing anchor tag.
    The WK listing page wraps both the title and a "Check it out" CTA
    inside the same <a> tag. Strategy:
      1. Try the first block-level or span child element (most specific).
      2. Fall back to full anchor text with known CTA strings stripped.
    """
    # Try first meaningful child element
    for child in anchor.children:
        if hasattr(child, 'get_text'):
            text = child.get_text(strip=True)
            if text and text.lower() not in ('check it out', 'view', 'download', ''):
                return html.unescape(text)
    # Fallback: strip known CTA suffixes from full text
    full = anchor.get_text(strip=True)
    for cta in ('Check it out', 'check it out', 'View', 'Download'):
        full = full.replace(cta, '')
    return html.unescape(full.strip())


def crawl_toolkit(session, existing_urls):
    """
    Returns a dict: { source_url: { 'title': str, 'wk_categories': [str], 'wk_topics': [str] } }
    Pass A collects all URLs and titles.
    Existing URLs are filtered out after Pass A so Passes B and C only
    process genuinely new items.
    Pass B enriches new items with category memberships.
    Pass C enriches new items with topic taxonomy.
    """
    items = {}  # url -> { title, wk_categories }

    # --- Pass A: unfiltered pagination ---
    log.info("Toolkit Pass A — unfiltered listing")
    page_num = 1
    while True:
        url = f"{WK_BASE}{TOOLKIT_LISTING_PATH}?_paged={page_num}"
        log.info("  Fetching page %d: %s", page_num, url)
        html = fetch_page(session, url, label=f"toolkit page {page_num}")
        if html is None:
            log.warning("  Fetch returned None — stopping Pass A pagination")
            break

        check_cookie_expired(html)
        soup = BeautifulSoup(html, "html.parser")
        toolkit_links = soup.find_all("a", href=re.compile(r"/toolkit/"))

        if not toolkit_links:
            log.info("  No items on page %d — end of listing", page_num)
            break

        new_on_page = 0
        for a in toolkit_links:
            href = a.get("href", "").strip().rstrip("/") + "/"
            if not href.startswith("http"):
                href = WK_BASE + href
            if href not in items:
                title = clean_title(a)
                items[href] = {"title": title, "wk_categories": []}
                new_on_page += 1

        log.info("  Page %d: %d toolkit links found, %d new", page_num, len(toolkit_links), new_on_page)
        page_num += 1

    log.info("Pass A complete — %d unique toolkit URLs collected", len(items))

    # Filter out existing URLs before Passes B and C — no point tagging items
    # that will be skipped at insert time. This significantly reduces HTTP
    # requests when most toolkit items are already in production.
    before_filter = len(items)
    items = {url: data for url, data in items.items() if url not in existing_urls}
    log.info(
        "After existing-URL filter: %d new items remain (%d existing skipped)",
        len(items), before_filter - len(items)
    )

    # --- Pass B: category iteration ---
    log.info("Toolkit Pass B — category iteration for wk_categories")
    for slug in TOOLKIT_CATEGORY_SLUGS:
        log.info("  Category: %s", slug)
        cat_page = 1
        while True:
            url = f"{WK_BASE}{TOOLKIT_LISTING_PATH}?_category={slug}&_paged={cat_page}"
            html = fetch_page(session, url, label=f"category {slug} page {cat_page}")
            if html is None:
                break

            check_cookie_expired(html)
            soup = BeautifulSoup(html, "html.parser")
            toolkit_links = soup.find_all("a", href=re.compile(r"/toolkit/"))

            if not toolkit_links:
                break

            for a in toolkit_links:
                href = a.get("href", "").strip().rstrip("/") + "/"
                if not href.startswith("http"):
                    href = WK_BASE + href
                if href in items:
                    if slug not in items[href]["wk_categories"]:
                        items[href]["wk_categories"].append(slug)
                # Items found in a category but not in Pass A are unusual but possible
                # (e.g., unpaged edge case). Add them.
                elif href not in existing_urls:
                    # Item found in a category page but missed by Pass A
                    # (unpaged edge case). Add only if genuinely new.
                    title = clean_title(a)
                    items[href] = {"title": title, "wk_categories": [slug]}
                    log.info("    New item found only in category %s: %s", slug, href)

            cat_page += 1

    categorised = sum(1 for v in items.values() if v["wk_categories"])
    log.info(
        "Pass B complete — %d/%d items have at least one category",
        categorised, len(items)
    )

    # --- Pass C: topic iteration ---
    log.info("Toolkit Pass C — topic iteration for wk_topics (match_context derivation)")
    for item in items.values():
        item["wk_topics"] = []

    for topic in FACETWP_TOPICS:
        log.info("  Topic: %s", topic)
        topic_page = 1
        while True:
            url = f"{WK_BASE}{TOOLKIT_LISTING_PATH}?_topic={topic}&_paged={topic_page}"
            html = fetch_page(session, url, label=f"topic {topic} page {topic_page}")
            if html is None:
                break

            check_cookie_expired(html)
            soup = BeautifulSoup(html, "html.parser")
            toolkit_links = soup.find_all("a", href=re.compile(r"/toolkit/"))

            if not toolkit_links:
                break

            for a in toolkit_links:
                href = a.get("href", "").strip().rstrip("/") + "/"
                if not href.startswith("http"):
                    href = WK_BASE + href
                if href in items and topic not in items[href]["wk_topics"]:
                    items[href]["wk_topics"].append(topic)

            topic_page += 1

    topic_tagged = sum(1 for v in items.values() if v["wk_topics"])
    log.info(
        "Pass C complete — %d/%d items have at least one topic",
        topic_tagged, len(items)
    )

    return items


# ---------------------------------------------------------------------------
# Piano Books catalog — single page with section headings
# ---------------------------------------------------------------------------

def crawl_piano_books(session):
    """
    Returns a dict: { source_url: { 'title': str, 'catalog_section': str, 'wk_level': str|None } }
    Core curriculum workbooks are not excluded here — they are identified manually during Phase 3 review.
    """
    items = {}

    url = f"{WK_BASE}{PIANO_BOOKS_LISTING_PATH}"
    log.info("Piano Books — fetching listing page: %s", url)
    page_html = fetch_page(session, url, label="piano-books listing")
    if page_html is None:
        log.error("Failed to fetch piano-books listing page. Aborting piano-books pass.")
        return items

    soup = BeautifulSoup(page_html, "html.parser")

    # Scope to div.entry-content to avoid the book-nav block at the top of the
    # page, which contains anchor links that would pollute current_section.
    content_div = soup.find("div", class_="entry-content")
    if content_div is None:
        log.warning("div.entry-content not found — falling back to full page walk")
        content_div = soup

    # Walk entry-content sequentially. h2 tags are section boundaries.
    # /piano-book/ links are items to collect.
    current_section = "Unknown"

    for element in content_div.find_all(True):
        if element.name == "h2":
            text = element.get_text(strip=True)
            if text:
                current_section = text
                log.info("  Section: %s", current_section)

        elif element.name == "a":
            href = element.get("href", "").strip()
            if "/piano-book/" not in href:
                continue

            href = href.rstrip("/") + "/"
            if not href.startswith("http"):
                href = WK_BASE + href

            if href in items:
                continue  # duplicate link on page

            title = html.unescape(element.get_text(strip=True))  # html = module (not local var)

            # Extract VU level from title
            wk_level = None
            m = VU_LEVEL_RE.search(title)
            if m:
                wk_level = m.group(1).upper()

            items[href] = {
                "title": title,
                "catalog_section": current_section,
                "wk_level": wk_level,
            }
            log.info(
                "    Found: %s  [section=%s, level=%s]",
                title[:60], current_section, wk_level or "—"
            )

    log.info("Piano Books pass complete — %d items collected", len(items))
    return items


# ---------------------------------------------------------------------------
# match_context inference
# ---------------------------------------------------------------------------

def infer_match_context(topics, categories):
    """
    Derive match_context from FacetWP topic and category taxonomy.
    Toolkit catalog only — piano-books defaults to lesson_skill at row build time.

    Priority:
      1. STUDIO_ADMIN_TOPICS hit — studio_admin (unless also PRACTICE_TOPICS — practice_behaviour)
      2. sheet-music topic — lesson_skill
      3. Any non-studio skill topic — lesson_skill
      4. studio-tools category — studio_admin
      5. No signal — lesson_skill (safe default for pedagogical content)
    """
    if any(t in STUDIO_ADMIN_TOPICS for t in topics):
        if any(t in PRACTICE_TOPICS for t in topics):
            return "practice_behaviour"
        return "studio_admin"
    if "sheet-music" in topics:
        return "lesson_skill"
    if any(t not in STUDIO_ADMIN_TOPICS for t in topics if t not in (
        "christmas", "halloween", "summer-theme", "other-holidays",
        "level-a", "level-b", "level-c", "level-d", "level-e", "level-f",
        "level-g", "level-h", "level-i", "level-j", "level-k", "level-l",
        "level-m", "level-n", "level-o", "level-p", "level-q", "level-x", "level-y",
        "primer-1", "primer-2", "primer-3",
        "primer-one-1st-edition-games", "primer-two-1st-edition-games",
        "primer-three-1st-edition",
    )):
        return "lesson_skill"
    if "studio-tools" in categories:
        return "studio_admin"
    return "lesson_skill"


# ---------------------------------------------------------------------------
# Season detection
# ---------------------------------------------------------------------------

def detect_season(topics, title):
    """
    Derive season label from title keywords and FacetWP topic taxonomy.
    Returns a canonical season_label string matching the season_windows table,
    or None if no seasonal signal is detected.

    Title scan runs first (more specific). Topic map is fallback.
    """
    for season, pattern in SEASON_TITLE_PATTERNS.items():
        if re.search(pattern, title or '', re.IGNORECASE):
            return season
    for topic in topics:
        if topic in TOPIC_SEASON_MAP:
            return TOPIC_SEASON_MAP[topic]
    return None


# ---------------------------------------------------------------------------
# Build staging rows
# ---------------------------------------------------------------------------

def build_toolkit_rows(items, existing_urls, series_id):
    """Filter and convert toolkit items to staging insert dicts."""
    rows = []
    skipped = 0
    for url, data in items.items():
        if url in existing_urls:
            skipped += 1
            continue
        topics = data.get("wk_topics", [])
        categories = data.get("wk_categories", [])
        rows.append({
            "series_id": series_id,
            "source_url": url,
            "source": "wunderkeys",
            "catalog": "toolkit",
            "title": data["title"] or None,
            "wk_categories": categories,  # may be empty list — that's correct
            "wk_topics": topics,           # may be empty list — that's correct
            "match_context": infer_match_context(topics, categories),
            "season": detect_season(topics, data["title"] or ""),
            "status": "discovered",
        })
    log.info(
        "Toolkit: %d new rows to insert, %d already exist (skipped)",
        len(rows), skipped
    )
    return rows


def build_piano_books_rows(items, existing_urls, series_id):
    """Filter and convert piano-books items to staging insert dicts."""
    rows = []
    skipped = 0
    for url, data in items.items():
        if url in existing_urls:
            skipped += 1
            continue
        rows.append({
            "series_id": series_id,
            "source_url": url,
            "source": "wunderkeys",
            "catalog": "piano-books",
            "title": data["title"] or None,
            "catalog_section": data["catalog_section"],
            "wk_level": data["wk_level"],
            "is_free": None,  # set during Phase 2 enrichment
            "match_context": "lesson_skill",  # piano-books are pedagogical content
            "season": detect_season([], data["title"] or ""),  # title-only, no topics for piano-books
            "wk_topics": [],  # no topic taxonomy available for piano-books catalog
            "status": "discovered",
        })
    log.info(
        "Piano Books: %d new rows to insert, %d already exist (skipped)",
        len(rows), skipped
    )
    return rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Creative Note — Supplement Discovery (Phase 1)")
    parser.add_argument(
        "--catalog",
        required=True,
        choices=["toolkit", "piano-books"],
        help="Which WK catalog to crawl",
    )
    parser.add_argument(
        "--series-id",
        required=True,
        help="WunderKeys series UUID",
    )
    args = parser.parse_args()

    # Load credentials
    load_dotenv()
    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    secret_key = os.environ.get("SUPABASE_SECRET_KEY", "")
    postpass_cookie = os.environ.get("WK_POSTPASS", "")

    if not supabase_url or not secret_key:
        log.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env")
        sys.exit(1)

    if args.catalog == "toolkit" and not postpass_cookie:
        log.error("WK_POSTPASS must be set in .env for toolkit catalog")
        sys.exit(1)

    series_id = args.series_id
    log.info("=== discover_supplements.py  catalog=%s  series=%s ===", args.catalog, series_id)

    # Fetch existing URLs upfront (new-only detection)
    log.info("Loading existing URLs from Supabase...")
    existing_urls = fetch_existing_urls(supabase_url, secret_key, series_id)

    # Crawl and build rows
    if args.catalog == "toolkit":
        session = wk_session(postpass_cookie)
        items = crawl_toolkit(session, existing_urls)
        rows = build_toolkit_rows(items, existing_urls, series_id)

    else:  # piano-books
        session = wk_session()  # no cookie needed
        items = crawl_piano_books(session)
        rows = build_piano_books_rows(items, existing_urls, series_id)

    # Insert
    if not rows:
        log.info("No new items to insert. supplement_staging is already up to date.")
    else:
        inserted = insert_staging_rows(supabase_url, secret_key, rows)
        log.info("Done. %d rows inserted to supplement_staging.", inserted)

    log.info("=== Run complete ===")


if __name__ == "__main__":
    main()

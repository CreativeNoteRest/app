// message-tokens.js
// Platform message token registry and resolver.
// Imported by main_menu.html for banner token substitution.
// TOKEN_REGISTRY is also consumed by the admin UI token chip list (wdn-096).
//
// Adding a new token: add an entry to TOKEN_REGISTRY and a substitution
// case inside resolveTokens(). Deploy via GitHub push. No other changes needed.
//
// Deferred token: {{days_overdue}} -- requires reliable Stripe-written
// past_due rows in series_subscriptions. Add when Stripe integration is live.

export const TOKEN_REGISTRY = [
  { token: '{{seats_used}}',        label: 'seats_used',        example: '3'    },
  { token: '{{seat_limit}}',        label: 'seat_limit',        example: '10'   },
  { token: '{{seats_remaining}}',   label: 'seats_remaining',   example: '7'    },
  { token: '{{subscription_tier}}', label: 'subscription_tier', example: 'pro'  },
  { token: '{{pending_count}}',     label: 'pending_count',     example: '2'    },
];

/**
 * resolveTokens(messageText, supabase, teacherId, seriesId)
 *
 * Resolves {{token}} placeholders in a message string.
 * Returns messageText unchanged if no {{ pattern is present (no DB fetch).
 * On any fetch error, returns messageText unchanged -- tokens render literally
 * rather than breaking the banner.
 *
 * @param {string} messageText  - Raw message_text from platform_messages row
 * @param {object} supabase     - Supabase JS client instance
 * @param {string} teacherId    - Current teacher UUID
 * @param {string} seriesId     - Current series UUID
 * @returns {Promise<string>}   - Resolved message text
 */
export async function resolveTokens(messageText, supabase, teacherId, seriesId) {
  // Fast path — no tokens present
  if (!messageText || !messageText.includes('{{')) return messageText;

  try {
    // One query: current subscription row + active student count in parallel
    const [subResult, countResult] = await Promise.all([
      supabase
        .from('v_current_subscriptions')
        .select('subscription_tier, student_seat_limit')
        .eq('teacher_id', teacherId)
        .eq('series_id', seriesId)
        .single(),
      supabase
        .from('students')
        .select('student_id', { count: 'exact', head: true })
        .eq('teacher_id', teacherId)
        .eq('student_status', 'active'),
    ]);

    if (subResult.error || countResult.error) {
      console.warn('resolveTokens fetch error:', subResult.error?.message || countResult.error?.message);
      return messageText;
    }

    const tier       = subResult.data?.subscription_tier  ?? '';
    const seatLimit  = subResult.data?.student_seat_limit ?? 0;
    const seatsUsed  = countResult.count                  ?? 0;
    const seatsLeft  = Math.max(0, seatLimit - seatsUsed);

    return messageText
      .replaceAll('{{subscription_tier}}', tier)
      .replaceAll('{{seat_limit}}',        String(seatLimit))
      .replaceAll('{{seats_used}}',        String(seatsUsed))
      .replaceAll('{{seats_remaining}}',   String(seatsLeft))
      .replaceAll('{{pending_count}}',      String(parseInt(sessionStorage.getItem('pending_count') ?? '0', 10)));

  } catch (err) {
    console.warn('resolveTokens error:', err.message);
    return messageText;
  }
}

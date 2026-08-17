// lib/database-lifecycle/stamp.mjs
// Bangkok-timezone timestamp formatter for database version auto-stamping.
// Zero npm dependencies — Intl.DateTimeFormat (Node built-in).
// Output format: YYYYMMDD-HHMM — the '-' separator guarantees a non-numeric result,
// which satisfies the yaml-subset numeric-coercion round-trip contract (§3.3).

const _fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Return the current Asia/Bangkok time as a version-pattern-safe stamp string.
 * Format: YYYYMMDD-HHMM (e.g. "20260603-1530").
 *
 * The '-' separator between the date and time parts guarantees the result is
 * never all-numeric, so it survives the yaml-subset coerceScalar pass unchanged
 * and satisfies VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.
 *
 * @returns {string} Timestamp matching /^[0-9]{8}-[0-9]{4}$/.
 */
export function formatBangkokStamp() {
  const parts = Object.fromEntries(
    _fmt.formatToParts(new Date()).map(({ type, value }) => [type, value])
  );
  // Clamp hour '24' → '00' (some runtimes emit 24 for midnight with hour12:false).
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}${parts.month}${parts.day}-${hour}${parts.minute}`;
}

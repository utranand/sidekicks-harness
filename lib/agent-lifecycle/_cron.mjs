// lib/agent-lifecycle/_cron.mjs
// Pure 5-field cron subset for routine schedules — numeric-only, evaluated on
// the Asia/Bangkok fixed +07:00 wall clock.
//
// Grammar (per field, standard vixie forms):
//   field   := element ("," element)*
//   element := "*" | "*/"step | N | N"-"M | N"-"M"/"step
//   minute 0-59 · hour 0-23 · dom 1-31 · month 1-12 · dow 0-7 (0 and 7 = Sun)
//
// Deliberately NOT supported (rejected with a naming error): month/dow names
// (jan, mon), L/W/#, @daily macros, 6-field seconds. Numeric-only is what makes
// the expression provably safe for the yaml-subset store: the parser's poison
// pre-scan rejects '*' before a WORD character, and a numeric cron only ever
// puts '*' before '/', ' ', ',' or end — never a word char (verified by test).
//
// dom/dow follow the vixie OR rule: when BOTH are restricted, a day matches if
// EITHER matches; when only one is restricted, it alone governs.
//
// Zero imports — throws plain Error (callers wrap with flag context); the
// fixed-offset wall-clock math is self-contained (mirrors bangkokParts in
// _routines.mjs; a fixed +07:00 has no DST, which the whole scan rests on).

const BKK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

// A cron with a dom/month combination that never lands (e.g. "0 0 30 2 *")
// must be detectable: scan bounded to cover the leap cycle (Feb 29 recurs
// within 4 years = 1461 days; one extra for safety).
const MAX_SCAN_DAYS = 1462;

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 7 }, // 7 folded to 0 (Sunday)
];

/**
 * Parse a 5-field cron expression.
 * @param {string} expr
 * @returns {{ minute:Set<number>, hour:Set<number>, dom:Set<number>,
 *             month:Set<number>, dow:Set<number>,
 *             domStar:boolean, dowStar:boolean, canonical:string }}
 * @throws {Error} single-line, field-naming message
 */
export function parseCron(expr) {
  const raw = String(expr ?? '').trim().replace(/\s+/g, ' ');
  const parts = raw ? raw.split(' ') : [];
  if (parts.length !== 5) {
    throw new Error(`expected 5 fields (minute hour dom month dow), got ${parts.length}`);
  }
  const sets = [];
  const stars = [];
  for (let i = 0; i < 5; i++) {
    const f = FIELDS[i];
    if (/[a-z]/i.test(parts[i])) {
      throw new Error(`${f.name} field '${parts[i]}': names are not supported — numeric only (dow 0-7, month 1-12)`);
    }
    const { set, isStar } = parseField(parts[i], f);
    sets.push(set);
    stars.push(isStar);
  }
  // Fold dow 7 → 0 so matching only ever sees 0-6.
  const dow = new Set([...sets[4]].map((n) => (n === 7 ? 0 : n)));
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domStar: stars[2],
    dowStar: stars[4],
    canonical: raw,
  };
}

function parseField(text, f) {
  if (text === '') throw new Error(`${f.name} field is empty`);
  const set = new Set();
  for (const element of text.split(',')) {
    if (element === '') throw new Error(`${f.name} field '${text}': empty list element`);
    const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(element);
    if (!m) throw new Error(`${f.name} field '${element}': not a supported element (use * N N-M */step N-M/step)`);
    const step = m[2] != null ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`${f.name} field '${element}': step must be >= 1`);
    let lo;
    let hi;
    if (m[1] === '*') {
      lo = f.min;
      hi = f.max;
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-').map(Number);
      if (a > b) throw new Error(`${f.name} field '${element}': reversed range (${a} > ${b})`);
      lo = a;
      hi = b;
    } else {
      lo = Number(m[1]);
      hi = m[2] != null ? f.max : lo; // vixie: N/step means N-max/step
    }
    if (lo < f.min || hi > f.max) {
      throw new Error(`${f.name} field '${element}': out of range ${f.min}-${f.max}`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  // The dom/dow OR rule keys off "was the whole field left unrestricted" —
  // only a literal bare '*' counts ('*/step' restricts the field).
  return { set, isStar: text === '*' };
}

// ---------------------------------------------------------------------------
// Wall-clock parts (self-contained mirror of _routines.mjs bangkokParts)
// ---------------------------------------------------------------------------

function wallParts(ms) {
  const d = new Date(ms + BKK_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dowNum: d.getUTCDay(), // 0=Sun … 6=Sat, cron's own numbering
  };
}

function wallToMs({ y, m, d, hh, mm }) {
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - BKK_OFFSET_MS;
}

/** Does this calendar day (month + dom/dow OR rule) match the spec? */
function dayMatches(spec, p) {
  if (!spec.month.has(p.m)) return false;
  const domOk = spec.dom.has(p.d);
  const dowOk = spec.dow.has(p.dowNum);
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk; // both restricted → vixie OR
}

/** Does the spec match this exact wall-clock minute? */
export function cronMatches(spec, { mm, hh, d, m, dowNum }) {
  return spec.minute.has(mm) && spec.hour.has(hh)
    && dayMatches(spec, { m, d, dowNum });
}

/**
 * The next matching instant STRICTLY AFTER `nowMs`, or null when none lands
 * within the 4-year scan (an impossible date like "0 0 30 2 *").
 */
export function nextCronInstant(spec, nowMs) {
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);
  const start = wallParts(nowMs);
  for (let k = 0; k < MAX_SCAN_DAYS; k++) {
    // Anchor each scanned day at its own noon to sidestep any day-length edge,
    // then re-derive the calendar parts.
    const dayAnchor = wallToMs({ y: start.y, m: start.m, d: start.d, hh: 12, mm: 0 }) + k * DAY_MS;
    const p = wallParts(dayAnchor);
    if (!dayMatches(spec, p)) continue;
    for (const hh of hours) {
      for (const mm of minutes) {
        const t = wallToMs({ y: p.y, m: p.m, d: p.d, hh, mm });
        if (t > nowMs) return t;
      }
    }
  }
  return null;
}

/**
 * The most recent matching instant AT OR BEFORE `nowMs`, or null within the
 * same 4-year bound. The due-math's `lastScheduledInstant` branch.
 */
export function prevCronInstant(spec, nowMs) {
  const hours = [...spec.hour].sort((a, b) => b - a);
  const minutes = [...spec.minute].sort((a, b) => b - a);
  const start = wallParts(nowMs);
  for (let k = 0; k < MAX_SCAN_DAYS; k++) {
    const dayAnchor = wallToMs({ y: start.y, m: start.m, d: start.d, hh: 12, mm: 0 }) - k * DAY_MS;
    const p = wallParts(dayAnchor);
    if (!dayMatches(spec, p)) continue;
    for (const hh of hours) {
      for (const mm of minutes) {
        const t = wallToMs({ y: p.y, m: p.m, d: p.d, hh, mm });
        if (t <= nowMs) return t;
      }
    }
  }
  return null;
}

/**
 * The smallest gap (minutes) between consecutive fires over the next `samples`
 * occurrences — feeds the computed grace default (an every-5-minutes cron
 * should not get a 60-minute grace; firing 55 minutes late is several
 * occurrences stale). Returns null when the spec never fires.
 */
export function cronMinIntervalMinutes(spec, fromMs, samples = 8) {
  let prev = nextCronInstant(spec, fromMs);
  if (prev === null) return null;
  let min = Infinity;
  for (let i = 0; i < samples; i++) {
    const next = nextCronInstant(spec, prev);
    if (next === null) break;
    min = Math.min(min, (next - prev) / 60_000);
    prev = next;
  }
  return Number.isFinite(min) ? Math.round(min) : null;
}

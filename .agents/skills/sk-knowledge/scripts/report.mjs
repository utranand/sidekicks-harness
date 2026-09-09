// report.mjs — the shareable report renderer for the sk-knowledge store.
//
// Produces reports/<slug>.html: a self-contained, presentation-grade page you can hand to someone
// who will never open the markdown. It is DERIVED output, exactly like entries/<slug>.html — the
// entry markdown stays canonical, and `reindex` must be able to rebuild this file byte-for-byte
// from an unchanged entry. Two consequences run through everything below:
//
//   1. NOTHING here may read the clock, the filesystem, the environment, or git. Every value comes
//      from the entry's frontmatter or its body. A generation timestamp would make two runs differ
//      and silently break the self-healing property the store is built on.
//   2. The prose language is NOT produced here. A Node script cannot translate deterministically,
//      so `result_language` selects which `## Report (<lang>)` section of the entry to render and
//      which chrome labels to use — never a translation. The agent authors that section inside the
//      entry markdown during CAPTURE / TRACE / REFRESH; an entry without one falls back to a
//      narrative derived from its own sections (see deriveReportBlock).
//
// Zero dependencies. Imports only ./md.mjs, a sibling inside this same skill.

import { escapeHtml, inlineMd, mdToHtml, short, htmlShell } from './md.mjs';

// ---------- language ----------

// `result_language` is free text a human typed into config ("Thai", "th", "ไทย", "English"). Map it
// to a label set, and keep the aliases so `## Report (th)` and `## Report (Thai)` both match.
const LANGS = {
  th: { code: 'th', aliases: ['th', 'thai', 'ไทย', 'ภาษาไทย'] },
  en: { code: 'en', aliases: ['en', 'eng', 'english'] },
};

/** Normalize a configured language name to a supported code. Unknown languages fall back to 'en'. */
export function normalizeLang(lang) {
  const want = String(lang || '').trim().toLowerCase();
  for (const entry of Object.values(LANGS)) if (entry.aliases.includes(want)) return entry.code;
  return 'en';
}

// Chrome only — headings, table columns, badges. Never content.
export const REPORT_LABELS = {
  en: {
    htmlLang: 'en',
    report: 'Report',
    tldr: 'TL;DR',
    asked: 'Asked',
    caveatFlag: 'unverified point(s) below',
    question: 'Question',
    answer: 'Answer',
    findings: 'Findings',
    corrections: 'Corrections to the original assumption',
    caveat: 'Not verified',
    caveatLead: 'The following was not verified. Treat it as open, not as a finding.',
    evidence: 'Evidence',
    sources: 'Tracked sources',
    noSources: 'no tracked sources',
    target: 'Target',
    scope: 'Scope',
    captured: 'Captured at',
    created: 'Created',
    updated: 'Updated',
    branchAt: 'branch',
    colType: 'type',
    colSource: 'source',
    colBranch: 'branch',
    colCommit: 'commit',
    colHash: 'sha256',
    entryMd: 'entry markdown',
    entryHtml: 'entry page',
    indexLink: 'knowledge index',
    footer: 'Derived from the entry markdown — edit the markdown, then re-register.',
  },
  th: {
    htmlLang: 'th',
    report: 'รายงาน',
    tldr: 'สรุปสั้น (TL;DR)',
    asked: 'คำถาม',
    caveatFlag: 'ประเด็นที่ยังไม่ได้ตรวจสอบด้านล่าง',
    question: 'คำถาม',
    answer: 'คำตอบ',
    findings: 'สิ่งที่พบ',
    corrections: 'สิ่งที่แก้จากสมมติฐานเดิม',
    caveat: 'ยังไม่ได้ตรวจสอบ',
    caveatLead: 'ส่วนต่อไปนี้ยังไม่ได้ตรวจสอบ ถือเป็นประเด็นค้าง ไม่ใช่ข้อสรุป',
    evidence: 'หลักฐาน',
    sources: 'แหล่งที่ติดตาม',
    noSources: 'ไม่มีแหล่งที่ติดตาม',
    target: 'เป้าหมาย',
    scope: 'ขอบเขต',
    captured: 'บันทึกที่',
    created: 'สร้างเมื่อ',
    updated: 'แก้ไขล่าสุด',
    branchAt: 'branch',
    colType: 'ประเภท',
    colSource: 'แหล่ง',
    colBranch: 'branch',
    colCommit: 'commit',
    colHash: 'sha256',
    entryMd: 'ไฟล์ markdown ของ entry',
    entryHtml: 'หน้า entry',
    indexLink: 'ดัชนีความรู้',
    footer: 'สร้างจากไฟล์ markdown ของ entry — แก้ที่ markdown แล้ว register ใหม่',
  },
};

// ---------- section extraction ----------

// Headings that mark a caveat or a correction, in either language. Matched case-insensitively
// against the heading text. The caveat set is deliberately wide: losing a "not verified" note is
// the one failure this renderer must never have, so a near-miss heading still gets caught.
const CAVEAT_RE = /(not\s*verified|unverified|unconfirmed|caveat|ยังไม่ได้ตรวจสอบ|ไม่ได้ตรวจสอบ|ยังไม่ยืนยัน|ข้อควรระวัง)/i;
const CORRECTION_RE = /(correction|corrected|revised assumption|hypothesis|แก้จากสมมติฐาน|สมมติฐาน|ข้อแก้ไข)/i;
const ANSWER_RE = /^(answer|summary|คำตอบ|สรุป)\s*$/i;
const TLDR_RE = /^(tl;?dr|สรุปสั้น|สรุปย่อ)\s*(?:\(tl;?dr\))?\s*$/i;
const EVIDENCE_RE = /^(evidence|หลักฐาน)\s*$/i;
const REVLOG_RE = /^(revision log|changelog|บันทึกการแก้ไข)\s*$/i;

/** Split markdown into `{ heading, level, text }` sections at ATX headings of `level` or shallower. */
function splitSections(md, level) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let current = { heading: '', level: 0, lines: [] };
  const marker = new RegExp(`^#{1,${level}}\\s+(.*)$`);
  for (const line of lines) {
    const m = line.match(marker);
    if (m) {
      out.push(current);
      current = { heading: m[1].trim(), level: line.match(/^#+/)[0].length, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  out.push(current);
  return out.map((s) => ({ heading: s.heading, level: s.level, text: s.lines.join('\n').trim() }));
}

/**
 * The `## Report (<lang>)` section of an entry body, or null.
 *
 * Matches `## Report (th)`, `## Report (Thai)`, the localized `## รายงาน (th)`, and a bare
 * `## Report` with no language marker. A language-tagged block for the REQUESTED language wins over
 * an untagged one, which in turn wins over a block tagged for some other language — so an entry can
 * carry two localized reports and each render picks its own.
 */
export function pickReportBlock(body, lang) {
  const code = normalizeLang(lang);
  const aliases = LANGS[code].aliases;
  const sections = splitSections(body, 2);
  let exact = null;
  let untagged = null;
  let other = null;
  for (const s of sections) {
    const m = s.heading.match(/^(?:report|รายงาน)\s*(?:\(([^)]*)\))?\s*$/i);
    if (!m) continue;
    const tag = (m[1] || '').trim().toLowerCase();
    if (!tag) untagged ??= s.text;
    else if (aliases.includes(tag)) exact ??= s.text;
    else other ??= s.text;
  }
  return exact ?? untagged ?? other ?? null;
}

/**
 * Fallback narrative for an entry that carries no report block — an entry written before reports
 * existed, or one whose author skipped the step. Everything in the body except the title heading,
 * the Evidence section (rendered separately from the tracked sources) and the Revision log.
 */
export function deriveReportBlock(body) {
  const sections = splitSections(body, 2);
  const keep = [];
  for (const s of sections) {
    if (!s.heading) { if (s.text) keep.push(s.text); continue; }   // preamble before the first heading
    if (/^report\b/i.test(s.heading) || /^รายงาน/.test(s.heading)) continue;
    if (EVIDENCE_RE.test(s.heading) || REVLOG_RE.test(s.heading)) continue;
    // The entry's `# <title>` h1 is already the report's own <h1>; keep its prose, drop the heading.
    if (s.level === 1) { if (s.text) keep.push(s.text); continue; }
    keep.push(`## ${s.heading}\n\n${s.text}`.trim());
  }
  return keep.join('\n\n').trim();
}

/**
 * The entry's "not verified" surface, searched across the WHOLE body — not just the report block.
 *
 * TRACE mandates an Unverified note under Evidence (a hop suspected but not confirmed never enters
 * a diagram), and that note is exactly what must not be polished away when the finding is packaged
 * for a reader. So this looks at every heading at any level, plus a bare `**Unverified:**`-style
 * lead line, and returns the first match.
 */
export function extractCaveat(body) {
  for (const s of splitSections(body, 6)) {
    if (s.heading && CAVEAT_RE.test(s.heading) && s.text) return s.text;
  }
  // The emphasis marker can close on EITHER side of the colon — `**Unverified:**` is at least as
  // common as `**Unverified**:` — so both are optional, and a trailing marker is trimmed off.
  const lead = String(body).replace(/\r\n?/g, '\n')
    .match(/^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*(?:not\s*verified|unverified|ยังไม่ได้ตรวจสอบ)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+)$/im);
  return lead ? lead[1].replace(/(?:\*\*|__)\s*$/, '').trim() : null;
}

/**
 * The answer subsection of a report block, or null.
 *
 * When present it WINS over frontmatter `summary`: the summary is the index's one-liner and is
 * written in whatever language the entry is, while this is the answer the reader of this report
 * asked for, in their language. Showing the English summary on a Thai report defeats the point.
 */
export function extractAnswer(md) {
  for (const s of splitSections(md, 6)) {
    if (s.heading && ANSWER_RE.test(s.heading) && s.text) return s.text;
  }
  return null;
}

/**
 * An explicitly authored `### TL;DR` subsection, or null.
 *
 * Optional by design: the generator can always compose a TL;DR from the question plus the answer,
 * so an author who writes nothing still gets one. This exists for the finding whose headline is not
 * simply its answer — a trace whose point is "three of the five hops are unverified", say.
 */
export function extractTldr(md) {
  for (const s of splitSections(md, 6)) {
    if (s.heading && TLDR_RE.test(s.heading) && s.text) return s.text;
  }
  return null;
}

/** The corrections subsection of a report block, or null. */
export function extractCorrections(md) {
  for (const s of splitSections(md, 6)) {
    if (s.heading && CORRECTION_RE.test(s.heading) && s.text) return s.text;
  }
  return null;
}

/** Drop the subsections rendered elsewhere (caveat, corrections, answer) from the findings body. */
function stripLiftedSections(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const h = m[2].trim();
      skipping = CAVEAT_RE.test(h) || CORRECTION_RE.test(h) || ANSWER_RE.test(h) || TLDR_RE.test(h);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n').trim();
}

/** Drop a lone subsection heading that just repeats the section label rendered above it. */
function unwrapRedundantHeading(md, label) {
  const sections = splitSections(md, 6).filter((s) => s.heading || s.text);
  if (sections.length !== 1) return md;
  const only = sections[0];
  return only.heading && only.heading.trim().toLowerCase() === label.trim().toLowerCase()
    ? only.text
    : md;
}

// ---------- proportion bars ----------

// A figure is only worth a bar when the reader is comparing it to its siblings, so the qualifying
// shape is narrow on purpose: one numeric column among text columns is a composition (counts split
// across categories); two numeric columns is a data table where a bar on one of them would imply a
// relationship that isn't there.
const NUMERIC_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

function cellText(html) {
  return html.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .trim();
}

function numericValue(text) {
  if (!NUMERIC_RE.test(text)) return null;
  const n = Number(text.replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Add an inline proportion bar to the single numeric column of every qualifying table.
 *
 * A table qualifies with at least two data rows, EXACTLY one fully numeric column, and at least two
 * non-zero values in it. The bar is max-normalized — the largest row is 100.0% — so the bars sit on
 * the same scale as the numbers printed beside them. The width is rounded to one decimal because a
 * full-precision float would make the output differ between runs on different platforms; byte-stable
 * regeneration matters more than a tenth of a percent.
 */
export function proportionBars(html) {
  return String(html).replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    const bodyMatch = table.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!bodyMatch) return table;
    const rows = bodyMatch[1].match(/<tr>[\s\S]*?<\/tr>/g) || [];
    if (rows.length < 2) return table;

    const cellsPerRow = rows.map((r) => r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []);
    const width = cellsPerRow[0].length;
    if (!width || cellsPerRow.some((c) => c.length !== width)) return table;

    const numericCols = [];
    const values = new Map();
    for (let col = 0; col < width; col++) {
      const parsed = cellsPerRow.map((c) => numericValue(cellText(c[col])));
      if (parsed.some((v) => v === null)) continue;
      numericCols.push(col);
      values.set(col, parsed);
    }
    if (numericCols.length !== 1) return table;

    const col = numericCols[0];
    const parsed = values.get(col);
    const max = Math.max(...parsed.map((v) => Math.abs(v)));
    if (!(max > 0) || parsed.filter((v) => v !== 0).length < 2) return table;

    const patched = rows.map((row, i) => {
      const cells = cellsPerRow[i];
      const pct = (Math.abs(parsed[i]) / max * 100).toFixed(1);
      const text = cellText(cells[col]);
      cells[col] = `<td class="num"><span class="bar" style="--w:${pct}%"></span><span class="numv">${escapeHtml(text)}</span></td>`;
      return `<tr>${cells.join('')}</tr>`;
    }).join('');
    return table.replace(bodyMatch[1], patched);
  });
}

// ---------- portability ----------

// The same shapes register already refuses in frontmatter. A report is the artifact most likely to
// leave this machine, so a leaked home directory here is both a privacy leak and a dead path for
// every reader. Thrown, not silently stripped: the caller decides (it warns and skips the report
// rather than failing the whole reindex), and the entry still tells the truth about itself.
const MACHINE_PATH_RE = /(\/Users\/[\w.-]+|\/home\/[\w.-]+|[A-Za-z]:\\Users\\[\w.-]+)/;

export class UnportablePathError extends Error {
  constructor(match) {
    super(`report would contain a machine-absolute path (${match}) — use repo-relative paths`);
    this.name = 'UnportablePathError';
    this.match = match;
  }
}

// ---------- the page ----------

const FONT_HEAD = '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
  + 'family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Thai:wght@400;500;600'
  + '&family=IBM+Plex+Mono:wght@400;500&display=swap">';

// Three-state theme, per the repo's artifact convention: the bare :root carries the COMPLETE light
// palette (never a token whose only definition sits inside a media query), the media block is
// guarded so an explicit light choice wins over the OS, and the [data-theme="dark"] block lets an
// explicit dark choice win in the other direction. Both webfont families carry a real fallback
// stack, so an offline read degrades to system fonts instead of losing Thai glyphs.
export const REPORT_CSS = `
:root{
  --bg:#fbfbfa;--surface:#fff;--fg:#16191d;--muted:#5b6470;--faint:#8b95a1;
  --line:#e4e7eb;--line-strong:#ccd2d9;--accent:#0b5fa5;--accent-soft:#e8f1fa;
  --bar:#9dc4e8;--warn:#8a4b00;--warn-bg:#fdf4e6;--warn-line:#e0b071;
  --good:#0a6b2e;--stale:#9a4a08;--code:#f1f3f5;--shadow:0 1px 2px rgba(16,24,32,.06);
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0e1216;--surface:#151b21;--fg:#e8ebee;--muted:#98a3af;--faint:#717d89;
    --line:#252d35;--line-strong:#38424c;--accent:#66aeee;--accent-soft:#152430;
    --bar:#2f5f8c;--warn:#f0b46a;--warn-bg:#2a2015;--warn-line:#6b4a1c;
    --good:#4fbd77;--stale:#e0a05c;--code:#1a2128;--shadow:0 1px 2px rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"]{
  --bg:#0e1216;--surface:#151b21;--fg:#e8ebee;--muted:#98a3af;--faint:#717d89;
  --line:#252d35;--line-strong:#38424c;--accent:#66aeee;--accent-soft:#152430;
  --bar:#2f5f8c;--warn:#f0b46a;--warn-bg:#2a2015;--warn-line:#6b4a1c;
  --good:#4fbd77;--stale:#e0a05c;--code:#1a2128;--shadow:0 1px 2px rgba(0,0,0,.4);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:'IBM Plex Sans','IBM Plex Sans Thai',-apple-system,'Segoe UI',Roboto,'Noto Sans Thai',sans-serif;
  font-size:16px;line-height:1.7;-webkit-text-size-adjust:100%}
main{max-width:820px;margin:0 auto;padding:3rem 1.25rem 4rem;overflow-wrap:break-word}
a{color:var(--accent)}
h1{font-size:1.9rem;line-height:1.25;font-weight:600;margin:0 0 .4rem}
h2{font-size:1.15rem;font-weight:600;letter-spacing:.01em;margin:2.4rem 0 .8rem;
  padding-bottom:.35rem;border-bottom:1px solid var(--line)}
h3{font-size:1rem;font-weight:600;margin:1.6rem 0 .5rem}
p{margin:.7rem 0}
.eyebrow{font-size:.75rem;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
  font-weight:600;margin:0 0 .5rem}
.chips{margin:.7rem 0 1.4rem;display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}
.chip{display:inline-block;border:1px solid var(--line-strong);border-radius:999px;
  padding:.12em .7em;font-size:.78rem;color:var(--muted)}
.chip.fresh{color:var(--good);border-color:var(--good)}
.chip.stale{color:var(--stale);border-color:var(--stale)}
.facts{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  box-shadow:var(--shadow);padding:1rem 1.2rem;margin:0 0 1.8rem;font-size:.86rem}
.facts dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1.1rem;margin:0}
.facts dt{color:var(--faint);font-weight:600;text-transform:uppercase;font-size:.7rem;
  letter-spacing:.05em;align-self:center}
.facts dd{margin:0}
.answer{background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;
  padding:.9rem 1.2rem;margin:.6rem 0 0;font-size:1.1rem;line-height:1.6}
.tldr{background:var(--accent-soft);border:1px solid var(--accent);border-radius:12px;
  padding:1.1rem 1.3rem;margin:1.4rem 0 1.8rem}
.tldr h2{margin:0 0 .5rem;border:0;padding:0;font-size:.78rem;letter-spacing:.09em;
  text-transform:uppercase;color:var(--accent)}
.tldr .asked{margin:0 0 .5rem;font-size:.85rem;color:var(--muted)}
.tldr .asked b{color:var(--muted);font-weight:600}
.tldr .gist{margin:0;font-size:1.12rem;line-height:1.6}
.tldr .gist>:first-child{margin-top:0}.tldr .gist>:last-child{margin-bottom:0}
.tldr .flag{margin:.7rem 0 0;font-size:.83rem;color:var(--warn);font-weight:600}
.callout{border:1px solid var(--warn-line);background:var(--warn-bg);border-radius:10px;
  padding:1rem 1.2rem;margin:1.6rem 0}
.callout h2{margin:0 0 .4rem;border:0;padding:0;font-size:1rem;color:var(--warn)}
.callout .lead{margin:0 0 .6rem;font-size:.85rem;color:var(--warn)}
.callout>:last-child{margin-bottom:0}
.scroll{overflow-x:auto;margin:1.1rem 0;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{border-bottom:1px solid var(--line);padding:.5rem .7rem;text-align:left;vertical-align:top}
thead th{border-bottom:1px solid var(--line-strong);color:var(--faint);font-weight:600;
  text-transform:uppercase;font-size:.72rem;letter-spacing:.05em;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td.num{position:relative;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.num .bar{position:absolute;left:0;top:.35rem;bottom:.35rem;width:var(--w);
  background:var(--bar);opacity:.35;border-radius:2px}
td.num .numv{position:relative}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font-size:.87em;
  font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:1rem;
  overflow-x:auto;font-size:.84rem}
pre code{background:none;padding:0;border:0}
blockquote{border-left:3px solid var(--line-strong);margin:1.1rem 0;padding:.1rem 1rem;color:var(--muted)}
ul,ol{padding-left:1.3rem}
li{margin:.25rem 0}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.mono{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
pre.mermaid{text-align:center;background:none;border:0;padding:0}
pre.mermaid svg{max-width:100%;height:auto}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);
  color:var(--faint);font-size:.8rem}
footer a{margin-right:.9rem}
`;

function section(title, inner) {
  return inner ? `<h2>${escapeHtml(title)}</h2>\n${inner}` : '';
}

function scrolled(html) {
  // Every table and code block gets its own horizontal scroller so a wide TRACE table never makes
  // the whole page scroll sideways on a phone.
  return html
    .replace(/<table>/g, '<div class="scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

function sourcesTable(sources, L) {
  if (!Array.isArray(sources) || !sources.length) return `<p class="mono">${escapeHtml(L.noSources)}</p>`;
  const rows = sources.map((s) => {
    if (s.type && s.type !== 'file') {
      return `<tr><td>${escapeHtml(s.type)}</td><td class="mono">${escapeHtml(s.ref || s.path || '')}</td>`
        + `<td colspan="3">${escapeHtml(s.note || '')}</td></tr>`;
    }
    return `<tr><td>file</td><td class="mono">${escapeHtml(s.path || '')}</td>`
      + `<td class="mono">${escapeHtml(s.branch || '')}</td>`
      + `<td class="mono">${escapeHtml(short(s.file_commit || s.commit))}</td>`
      + `<td class="mono">${escapeHtml(short(s.sha256))}</td></tr>`;
  }).join('');
  const head = [L.colType, L.colSource, L.colBranch, L.colCommit, L.colHash]
    .map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** The `## Evidence` prose of the entry body, rendered, or ''. */
function evidenceProse(body) {
  for (const s of splitSections(body, 2)) {
    if (s.heading && EVIDENCE_RE.test(s.heading) && s.text) return scrolled(mdToHtml(s.text));
  }
  return '';
}

/**
 * Render the complete standalone report page.
 *
 * Deterministic: given the same `meta` and `body` it returns the identical string, on any platform.
 * Throws UnportablePathError when the assembled page would carry a machine-absolute path.
 *
 * @param {{slug: string, meta: object, body: string, lang?: string}} input
 * @returns {string} a complete HTML document
 */
export function buildReportHtml({ slug, meta, body, lang }) {
  const code = normalizeLang(lang);
  const L = REPORT_LABELS[code];
  const text = String(body || '');

  const picked = pickReportBlock(text, code);
  const narrative = picked ?? deriveReportBlock(text);
  const caveat = extractCaveat(text);
  const corrections = picked ? extractCorrections(picked) : null;
  const answer = (picked ? extractAnswer(picked) : null) ?? (meta.summary ? String(meta.summary) : null);
  const tldr = (picked ? extractTldr(picked) : null) ?? answer;
  const findings = unwrapRedundantHeading(stripLiftedSections(narrative), L.findings);

  const status = meta.status || 'unknown';
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  const chips = [
    `<span class="chip ${escapeHtml(status)}">${escapeHtml(status)}</span>`,
    `<span class="chip">${escapeHtml(meta.section || 'general')}</span>`,
    ...tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`),
  ].join('');

  const facts = [
    meta.target ? `<dt>${escapeHtml(L.target)}</dt><dd class="mono">${escapeHtml(meta.target)}</dd>` : '',
    meta.scope ? `<dt>${escapeHtml(L.scope)}</dt><dd class="mono">${escapeHtml(meta.scope)}</dd>` : '',
    `<dt>${escapeHtml(L.captured)}</dt><dd class="mono">${escapeHtml(L.branchAt)} `
      + `${escapeHtml(meta.captured_branch || '?')} @ ${escapeHtml(short(meta.captured_commit) || '?')}</dd>`,
    `<dt>${escapeHtml(L.updated)}</dt><dd class="mono">${escapeHtml(meta.updated_at || '')}</dd>`,
  ].filter(Boolean).join('');

  const parts = [
    `<p class="eyebrow">${escapeHtml(L.report)}</p>`,
    `<h1>${escapeHtml(meta.title || slug)}</h1>`,
    `<div class="chips">${chips}</div>`,
  ];

  // TL;DR first — before the metadata card, before anything. A reader who gets one screen must
  // leave with the answer, what was asked, and whether anything in it is unverified. It is composed
  // from the answer unless the author wrote an explicit `### TL;DR`, so no entry lacks one.
  if (tldr) {
    parts.push(`<div class="tldr"><h2>${escapeHtml(L.tldr)}</h2>`
      + (meta.question ? `<p class="asked"><b>${escapeHtml(L.asked)}:</b> ${inlineMd(String(meta.question))}</p>` : '')
      + `<div class="gist">${scrolled(mdToHtml(tldr))}</div>`
      + (caveat ? `<p class="flag">${escapeHtml(L.caveatFlag)}</p>` : '')
      + '</div>');
  }

  parts.push(`<div class="facts"><dl>${facts}</dl></div>`);

  // The caveat sits ABOVE the findings, always. A reader who stops after the answer must still have
  // seen what is unverified — burying it under the evidence is how a caveat gets lost in practice.
  if (caveat) {
    parts.push(`<div class="callout"><h2>${escapeHtml(L.caveat)}</h2>`
      + `<p class="lead">${escapeHtml(L.caveatLead)}</p>${scrolled(mdToHtml(caveat))}</div>`);
  }

  // The question and the answer already lead the page inside the TL;DR; repeating them as their own
  // sections is the padding that makes a report feel long without saying more. They only get a
  // section of their own when there is no TL;DR to have carried them.
  if (!tldr) {
    if (meta.question) parts.push(section(L.question, `<p>${inlineMd(String(meta.question))}</p>`));
    if (answer) parts.push(section(L.answer, `<div class="answer">${scrolled(mdToHtml(answer))}</div>`));
  }
  if (findings) parts.push(section(L.findings, proportionBars(scrolled(mdToHtml(findings)))));
  if (corrections) {
    parts.push(`<div class="callout"><h2>${escapeHtml(L.corrections)}</h2>${scrolled(mdToHtml(corrections))}</div>`);
  }

  const evidence = evidenceProse(text);
  parts.push(section(L.evidence, `${evidence}<h3>${escapeHtml(L.sources)}</h3>${sourcesTable(meta.sources, L)}`));

  parts.push(`<footer><a href="../entries/${encodeURIComponent(slug)}.md">${escapeHtml(L.entryMd)}</a>`
    + `<a href="../entries/${encodeURIComponent(slug)}.html">${escapeHtml(L.entryHtml)}</a>`
    + `<a href="../index.html">${escapeHtml(L.indexLink)}</a><br>${escapeHtml(L.footer)}</footer>`);

  const html = htmlShell(meta.title || slug, parts.filter(Boolean).join('\n'), REPORT_CSS,
    { lang: L.htmlLang, head: FONT_HEAD });

  const offender = html.match(MACHINE_PATH_RE);
  if (offender) throw new UnportablePathError(offender[1]);
  return html;
}

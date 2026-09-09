// md.mjs — the markdown/HTML rendering primitives shared by the sk-knowledge store engine.
//
// Extracted from knowledge.mjs unchanged in behaviour so BOTH consumers can use them without
// duplicating ~90 lines and without an import cycle: knowledge.mjs renders the entry twin
// (entries/<slug>.html) and report.mjs renders the shareable report (reports/<slug>.html).
// Each caller supplies its OWN css to htmlShell — the two pages look nothing alike, but they
// parse the same markdown, so only the palette differs, never the renderer.
//
// Zero dependencies, no node builtins at all: every function here is pure string work, which is
// what makes both renderers deterministic (a report must regenerate byte-identically from an
// unchanged entry). Cross-platform by construction — mdToHtml normalizes \r\n on entry.

// ---------- minimal markdown -> HTML ----------

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function inlineMd(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}


export function mdToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      closeList();
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      if (lang === 'mermaid') out.push(`<pre class="mermaid">${escapeHtml(buf.join('\n'))}</pre>`);
      else out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^(\s*)([-*])\s+/.test(line)) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`); i++; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ''))}</li>`); i++; continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }
    if (line.startsWith('>')) {
      closeList();
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${buf.map(inlineMd).join('<br>')}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      // Split on UNESCAPED pipes only, then unescape. GFM lets a cell hold a literal pipe as `\|`
      // (including inside a code span), and TRACE tables routinely carry JS conditions where `||`
      // appears — a naive split('|') shatters such a row into extra cells and drags <code>/<strong>
      // across cell boundaries, silently corrupting the human twin. Known limit: an escaped
      // backslash immediately before a real delimiter still mis-splits; no entry does that today.
      const cells = (l) => l.replace(/^\s*\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/)
        .map((c) => inlineMd(c.trim().replace(/\\\|/g, '|')));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${buf.map(inlineMd).join(' ')}</p>`);
  }
  closeList();
  return out.join('\n');
}

// ---------- HTML shells ----------

// Mermaid renders client-side from CDN when the page carries a diagram; offline the raw
// mermaid text stays visible in its <pre> block — a readable fallback, never a blank box.
export const MERMAID_SNIPPET = `<script type="module">
try {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
  mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default' });
  await mermaid.run({ querySelector: '.mermaid' });
} catch { /* offline — keep the mermaid source visible */ }
</script>`;

/** 10-char hash prefix — enough to identify a commit or blob in a table cell. */
export function short(hash) { return hash ? String(hash).slice(0, 10) : ''; }

/**
 * Wrap rendered body HTML in a complete standalone document.
 *
 * `css` is a parameter rather than a module constant because the entry twin and the report are
 * deliberately different designs over the same renderer. `head` carries anything a caller needs
 * before the style block (the report links its webfonts there); `lang` sets the document language.
 */
export function htmlShell(title, body, css, { lang = 'en', head = '' } = {}) {
  const mermaid = body.includes('class="mermaid"') ? MERMAID_SNIPPET : '';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${head}<style>${css}</style></head>
<body><main>${body}</main>${mermaid}</body></html>\n`;
}

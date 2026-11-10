// Malý a bezpečný Markdown renderer: všechno se nejdřív escapuje, pak se teprve formátuje.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[n])}</code>`);
}

const indentOf = l => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;

function parseList(lines, i, base) {
  const first = lines[i].match(LIST_RE);
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  let html = ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>` : '<ul>';
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(LIST_RE);
    if (!m) {
      if (!line.trim()) {
        if (i + 1 < lines.length && LIST_RE.test(lines[i + 1]) && indentOf(lines[i + 1]) >= base) { i++; continue; }
        break;
      }
      if (indentOf(line) > base) { html = html.replace(/<\/li>$/, '') + `<br>${inline(line.trim())}</li>`; i++; continue; }
      break;
    }
    const ind = indentOf(line);
    if (ind < base) break;
    if (ind > base) {
      const [sub, ni] = parseList(lines, i, ind);
      html = html.replace(/<\/li>$/, '') + sub + '</li>';
      i = ni;
      continue;
    }
    let content = m[3];
    const task = content.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) content = (task[1] === ' ' ? '☐ ' : '☑ ') + task[2];
    html += `<li>${inline(content)}</li>`;
    i++;
  }
  return [html + (ordered ? '</ol>' : '</ul>'), i];
}

function isBlockStart(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || /^#{1,6}\s/.test(l) || LIST_RE.test(l) || /^\s*>/.test(l) ||
    (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]));
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(FENCE_RE);
    if (m) {
      const fence = m[1][0].repeat(3);
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      html += `<pre class="code"><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lvl = Math.min(m[1].length + 2, 6);
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const split = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = split(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(split(lines[i++]));
      html += '<div class="table-wrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>';
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    if (LIST_RE.test(line)) {
      const [h, ni] = parseList(lines, i, indentOf(line));
      html += h;
      i = ni;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines, i))) buf.push(lines[i++]);
    html += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  return html;
}

// Text vhodný k předčítání (bez kódu, odkazů a Markdown značek).
export function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?(```|$)/g, ' (ukázka kódu) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'odkaz')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .trim();
}

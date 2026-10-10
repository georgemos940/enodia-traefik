// Enough Markdown for release notes: headings, lists, code, bold, italics and links. Built with h(), so
// nothing in the text can become HTML.
import { h } from './dom.js';

function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', { class: 'mono' }, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, m[2].slice(2, -2)));
    else if (m[3]) out.push(h('em', {}, m[3].slice(1, -1)));
    else if (m[4]) out.push(h('a', { href: m[5], target: '_blank', rel: 'noreferrer', class: 'torch-text' }, m[4].slice(1, m[4].indexOf(']'))));
    else if (m[6]) out.push(h('a', { href: m[6], target: '_blank', rel: 'noreferrer', class: 'torch-text' }, m[6]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function markdown(src = '') {
  const root = h('div', { class: 'md' });
  const lines = String(src).replace(/\r/g, '').split('\n');
  let list = null;
  let code = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) { root.append(h('pre', { class: 'json' }, code.join('\n'))); code = null; } else { list = null; code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (head) { list = null; root.append(h(`h${Math.min(6, head[1].length + 2)}`, {}, ...inline(head[2]))); }
    else if (item) {
      if (!list) { list = h('ul'); root.append(list); }
      list.append(h('li', {}, ...inline(item[1])));
    } else if (!line.trim()) list = null;
    else { list = null; root.append(h('p', {}, ...inline(line))); }
  }
  if (code) root.append(h('pre', { class: 'json' }, code.join('\n')));
  return root;
}

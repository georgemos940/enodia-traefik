// Traefik rule syntax: Host(`a`) && (PathPrefix(`/b`) || !Method(`POST`)). Tokenised here so every page
// shows a rule the same way. The route tester extends this with a parser and a matcher.
import { h } from './dom.js';

/** Tokens: { type: 'fn' | 'arg' | 'op' | 'paren' | 'comma' | 'space' | 'text', value } */
export function tokenize(rule = '') {
  const out = [];
  let i = 0;
  while (i < rule.length) {
    const ch = rule[i];
    if (ch === '`' || ch === '"') {
      const end = rule.indexOf(ch, i + 1);
      const j = end < 0 ? rule.length : end + 1;
      out.push({ type: 'arg', value: rule.slice(i, j) });
      i = j;
    } else if (rule.startsWith('&&', i) || rule.startsWith('||', i)) { out.push({ type: 'op', value: rule.slice(i, i + 2) }); i += 2; }
    else if (ch === '!') { out.push({ type: 'op', value: '!' }); i++; }
    else if (ch === '(' || ch === ')') { out.push({ type: 'paren', value: ch }); i++; }
    else if (ch === ',') { out.push({ type: 'comma', value: ch }); i++; }
    else if (/\s/.test(ch)) { let j = i; while (j < rule.length && /\s/.test(rule[j])) j++; out.push({ type: 'space', value: rule.slice(i, j) }); i = j; }
    else if (/[A-Za-z]/.test(ch)) { let j = i; while (j < rule.length && /[A-Za-z0-9]/.test(rule[j])) j++; out.push({ type: rule[j] === '(' ? 'fn' : 'text', value: rule.slice(i, j) }); i = j; }
    else { out.push({ type: 'text', value: ch }); i++; }
  }
  return out;
}

/** A rule as coloured inline code. */
export function ruleView(rule, { cls = '' } = {}) {
  if (!rule) return h('span', { class: 'muted small' }, 'no rule (catches everything on its entry points)');
  return h('code', { class: `rule ${cls}`.trim() }, ...tokenize(rule).map((t) => {
    if (t.type === 'fn') return h('span', { class: 'fn' }, t.value);
    if (t.type === 'arg') return h('span', { class: 'arg' }, t.value);
    if (t.type === 'op') return h('span', { class: 'op' }, t.value === '&&' ? ' && ' : t.value === '||' ? ' || ' : '!');
    if (t.type === 'paren') return h('span', { class: 'paren' }, t.value);
    if (t.type === 'space') return ' ';
    return t.value;
  }));
}

/** The hosts a rule names (Host, HostSNI, HostRegexp shown as written). */
export function hostsOf(rule = '') {
  return [...rule.matchAll(/Host(?:SNI|Regexp)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]));
}

/** The paths a rule names (Path, PathPrefix, PathRegexp). */
export function pathsOf(rule = '') {
  return [...rule.matchAll(/Path(?:Prefix|Regexp)?\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/[`"]([^`"]*)[`"]/g)].map((x) => x[1]));
}

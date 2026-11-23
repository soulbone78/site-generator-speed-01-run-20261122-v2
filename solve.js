// A fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Rebuilt from scratch against makefun-site's README and its reference code:
// byte-for-byte identical answers, less CPU. No dependencies, no imports,
// plain JavaScript. The speed comes from doing less work per character, never
// from changing an answer: inline markup is escaped in bulk chunks, slugify
// is memoised with an ASCII shortcut, template output is joined from one
// array, and word counting is a single pass.

/** Code-unit order, the comparator the reference uses everywhere. */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- escaping

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_ESCAPABLE = /[&<>"']/;
const ESCAPABLE_ALL = /[&<>"']/g;

/** `text` with & < > " ' escaped; untouched when it holds none of them. */
function htmlEscape(text) {
  return HAS_ESCAPABLE.test(text) ? text.replace(ESCAPABLE_ALL, (ch) => HTML_ESCAPES[ch]) : text;
}

// ---------------------------------------------------------------- slugs

const MAX_SLUG = 64;
const slugMemo = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters outside a-z0-9 collapsed to one "-", no "-" at either end,
 * at most MAX_SLUG characters (a "-" stranded at the cut is dropped), and
 * "untitled" when nothing survives. slugify is a pure function, so its
 * results are memoised across the whole run.
 */
function slugOf(text) {
  const known = slugMemo.get(text);
  if (known !== undefined) return known;
  let body = text;
  let hasWide = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { hasWide = true; break; }
  }
  // ASCII text is unchanged by NFKD and holds no combining marks, so the
  // normalise-and-strip step is skipped for it.
  if (hasWide) body = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let slug = '';
  let pendingDash = false;
  for (let i = 0; i < body.length; i++) {
    let c = body[i];
    if (c >= 'A' && c <= 'Z') c = c.toLowerCase();
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      if (pendingDash) slug += '-';
      slug += c;
      pendingDash = false;
    } else if (slug.length > 0) {
      pendingDash = true;
    }
  }
  slug = slug.slice(0, MAX_SLUG).replace(/-+$/, '');
  const result = slug === '' ? 'untitled' : slug;
  slugMemo.set(text, result);
  return result;
}

/** `slug`, made unique inside `used` (and recorded there): s, s-2, s-3, ... */
function makeUnique(slug, used) {
  let candidate = slug;
  let n = 2;
  while (used.has(candidate)) candidate = `${slug}-${n++}`;
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------- dates, words

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date spelled out, from the string alone. */
function dateLong(iso) {
  const parts = iso.split('-');
  return `${Number(parts[2])} ${MONTH_NAMES[Number(parts[1]) - 1]} ${parts[0]}`;
}

/**
 * The word count of `text`: its runs of non-whitespace characters, counted
 * in one pass. An ASCII character is whitespace exactly for space, tab,
 * newline, carriage return, vertical tab and form feed; anything wider is
 * whitespace exactly when /\s/ says so.
 */
function countWords(text) {
  let count = 0;
  let inside = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const blank = code <= 127
      ? code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13
      : /\s/.test(text[i]);
    if (blank) inside = false;
    else if (!inside) { inside = true; count++; }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_LINE = /^[ \t]*$/;

/** Days in a month, Gregorian leap rule. */
function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * A string value: a quoted "..." string, whose only escapes are \" and \\, or
 * a bare string, which never opens on " or [. The loop is the reference's
 * own: an escape whose next character is the final quote is an error, since
 * it would leave the string unclosed.
 */
function parseString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c !== '\\') {
        if (c === '"') return { error: 'a quoted string holds a stray quote' };
        out += c;
        continue;
      }
      const next = raw[i + 1];
      if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      out += next;
      i++;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or why it is refused. */
function parseValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body. The matter opens on a line `---` and
 * closes on the next exact `---`; inside it, blank lines and `#` comments
 * are skipped and every other line is `key: value`. The first problem found
 * is the one reported.
 */
function readFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (BLANK_LINE.test(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = parseValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(end + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const FENCE_START = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_END = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RULE_RE = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE_RE = /^>/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const INDENTED_RE = /^ {2,}\S/;

/** A line's heading, or null: 1-6 `#`, a space or tab, non-empty text. */
function parseHeading(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, a fence, a heading, a rule. */
function endsPara(line) {
  return BLANK_LINE.test(line) || FENCE_START.test(line) || parseHeading(line) !== null || RULE_RE.test(line);
}

/** A line with its leading and trailing spaces and tabs dropped. */
const trimSpaces = (line) => line.replace(/^[ \t]+|[ \t]+$/g, '');

const ESCAPABLE_CHARS = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index at or after `from` where `s` holds `what` outside a
 * backslash escape, or -1. A backslash followed by an escapable character
 * is skipped as a pair.
 */
function scanUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE_CHARS.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/**
 * The first lone `*` at or after `from` — one that is not part of a `**`
 * run — outside a backslash escape, or -1.
 */
function scanLoneStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE_CHARS.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline into `out`, an array of string pieces. Only `\`,
 * backtick, `*` and `[` can open a token, so the scan jumps from one of
 * them to the next with indexOf and escapes each plain stretch between
 * them in a single call. A token whose closer is missing is left in the
 * plain text, exactly as the reference leaves it, and scanning resumes one
 * character past its opener.
 */
function renderInlineInto(s, env, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = n;
    const tick = s.indexOf('`', i);
    if (tick !== -1 && tick < j) j = tick;
    const star = s.indexOf('*', i);
    if (star !== -1 && star < j) j = star;
    const open = s.indexOf('[', i);
    if (open !== -1 && open < j) j = open;
    const slash = s.indexOf('\\', i);
    if (slash !== -1 && slash < j) j = slash;
    if (j === n) {
      out.push(htmlEscape(s.slice(i)));
      break;
    }
    if (j > i) out.push(htmlEscape(s.slice(i, j)));
    const ch = s[j];
    if (ch === '\\') {
      if (j + 1 < n && ESCAPABLE_CHARS.has(s[j + 1])) {
        out.push(s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', htmlEscape(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (ch === '*') {
      if (s[j + 1] === '*') {
        const k = scanUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          renderInlineInto(s.slice(j + 2, k), env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = scanLoneStar(s, j + 1);
      if (k > j + 1) {
        out.push('<em>');
        renderInlineInto(s.slice(j + 1, k), env, out);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i = j + 1;
      }
      continue;
    }
    // ch === '[': a link needs an unescaped ']', a '(' at once, a ')', and
    // a non-empty whitespace-free target; anything else leaves '[' literal.
    const k = scanUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push('<a href="', htmlEscape(env.link(target)), '">');
      renderInlineInto(s.slice(j + 1, k), env, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
}

/** `s` rendered inline, as one string. */
function renderInline(s, env) {
  const out = [];
  renderInlineInto(s, env, out);
  return out.join('');
}

/**
 * A body rendered: its HTML (each block followed by "\n"), its table of
 * contents (level 2/3 headings) and its excerpt (the first paragraph's
 * HTML, or ""). Blocks are read in the reference lexer's order: fence,
 * heading, rule, quote, list, paragraph.
 */
function renderBody(src, env) {
  const lines = src.split('\n');
  const usedIds = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (BLANK_LINE.test(line)) {
      i++;
      continue;
    }
    const fence = FENCE_START.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_END.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[1] === '' ? '' : ` class="language-${htmlEscape(fence[1])}"`;
      blocks.push(`<pre><code${lang}>${body.map((l) => `${htmlEscape(l)}\n`).join('')}</code></pre>`);
      continue;
    }
    const heading = parseHeading(line);
    if (heading !== null) {
      const id = makeUnique(slugOf(heading.text), usedIds);
      const html = renderInline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < n && QUOTE_RE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = body.map(trimSpaces).filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${renderInline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimSpaces(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (INDENTED_RE.test(lines[i])) {
          items[items.length - 1].push(trimSpaces(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const opener = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${ordered[1]}">` : `<${tag}>`;
      blocks.push(`${opener}\n${items.map((parts) => parts.join('\n')).map((item) => `<li>${renderInline(item, env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }
    const body = [trimSpaces(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimSpaces(lines[i++]));
    const html = renderInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const MAX_INCLUDE = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateFault extends Error {}

function parsePath(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateFault(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * A template's source split into tokens: text, `{{ path }}`, `{{{ path }}}`
 * and `{% tag %}`. A `{% %}` tag that stands alone on its line — only
 * spaces and tabs beside it — swallows the whole line and its newline;
 * text and `{{ }}` never do.
 */
function lexTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateFault(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: parsePath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateFault(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const alone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (alone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = alone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Tokens nested into a tree of text / var / raw / if / for / include nodes. */
function compileTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of lexTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: parsePath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: parsePath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateFault(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateFault(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateFault(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateFault(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain, or undefined. */
function resolveValue(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in digits, true/false, an array's items joined by ", ", else "". */
function asText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(asText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `scope`. A for-node reuses one frame
 * object across its items — its loop fields mutated per item — which is
 * indistinguishable from a fresh frame per item, provided the whole frame
 * state is saved and restored around the loop: a template that includes
 * itself re-enters the same for-node mid-iteration, and without the
 * save/restore the inner render would clobber the outer iteration's item,
 * loop fields and parent scope.
 *
 * One edge the reference settles by construction: its per-item scope is
 * `{ [name]: item, loop: {...} }`, so when the loop variable itself is
 * named `loop`, the loop object wins and the item is unreachable. This
 * render does the same — it never writes the item over `vars.loop`.
 */
function renderInto(nodes, scope, ctx, depth, out) {
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var':
        out.push(ctx.escape(asText(resolveValue(scope, nd.path))));
        break;
      case 'raw':
        out.push(asText(resolveValue(scope, nd.path)));
        break;
      case 'if': {
        const v = isTruthy(resolveValue(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const items = resolveValue(scope, nd.path);
        if (!Array.isArray(items)) break;
        let frame = nd.frame;
        if (frame === undefined) {
          frame = { vars: { loop: { index: 0, first: false, last: false, length: 0 } }, parent: null };
          nd.frame = frame;
        }
        const lp = frame.vars.loop;
        const savedParent = frame.parent;
        const savedItem = frame.vars[nd.name];
        const savedIndex = lp.index;
        const savedFirst = lp.first;
        const savedLast = lp.last;
        const savedLength = lp.length;
        const namesLoop = nd.name === 'loop';
        frame.parent = scope;
        for (let k = 0; k < items.length; k++) {
          if (!namesLoop) frame.vars[nd.name] = items[k];
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === items.length - 1;
          lp.length = items.length;
          renderInto(nd.body, frame, ctx, depth, out);
        }
        frame.parent = savedParent;
        if (!namesLoop) frame.vars[nd.name] = savedItem;
        lp.index = savedIndex;
        lp.first = savedFirst;
        lp.last = savedLast;
        lp.length = savedLength;
        break;
      }
      case 'include': {
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < MAX_INCLUDE) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_NAME = 'build-report.txt';
const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** `rel` resolved from the directory `dir`, or null when it climbs above the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The directory part of a path, or "" at the root. */
const parentDir = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `t` starts with a scheme (`[A-Za-z][A-Za-z0-9+.-]*:`), without a regex. */
function startsWithScheme(t) {
  if (t.length === 0) return false;
  const first = t.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** Files sorted by path; `.md` files are sources (line endings unified), the rest static. */
function collectInputs(st) {
  const files = [...st.input.files].sort((x, y) => cmpStr(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) st.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else st.statics.push({ path: f.path, content: f.content });
  }
}

/**
 * Front matter, in the reference's refusal order per source: a parse error,
 * then a source under `tags/` or `page/` (the generator's own directories),
 * then a post with no date, then a layout that is no parsed template, then
 * a draft. The first failing check is the one reported.
 */
function filterSources(st) {
  const kept = [];
  for (const s of st.sources) {
    const fm = readFrontMatter(s.text);
    if ('error' in fm) {
      st.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir = null;
    for (const d of RESERVED_DIRS) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { ownDir = d; break; }
    }
    if (ownDir !== null) {
      st.report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      st.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!st.templates.has(layout)) {
      st.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      st.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  st.sources = kept;
}

/** Permalinks: posts under `posts/`, pages under their source directory, slugs unique per directory. */
function assignUrls(st) {
  const takenByDir = new Map();
  const takenIn = (dir) => {
    if (!takenByDir.has(dir)) takenByDir.set(dir, new Set(dir === '' ? RESERVED_DIRS : []));
    return takenByDir.get(dir);
  };
  for (const s of st.sources) {
    const dir = s.post ? 'posts' : parentDir(s.path);
    const slug = makeUnique(s.data.slug ?? slugOf(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${st.base}/${s.outDir}/`;
    st.bySource.set(s.path, s);
  }
}

/** Bodies rendered, with links resolved against the built pages and statics. */
function renderBodies(st) {
  const staticPaths = new Set(st.statics.map((f) => f.path));
  for (const s of st.sources) {
    const dir = parentDir(s.path);
    const env = {
      link: (target) => {
        if (startsWithScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveRel(dir, rel);
        if (path !== null && st.bySource.has(path)) return `${st.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${st.base}/${path}${frag}`;
        st.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** Posts newest first, equal dates by slug; neighbours linked both ways. */
function orderPosts(st) {
  const posts = st.sources.filter((s) => s.post);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  st.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** A source's tag names, each slug once, first spelling kept. */
function ownTagNames(s) {
  const seen = new Set();
  const names = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugOf(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      names.push(name);
    }
  }
  return names;
}

/**
 * Tags: a post's tags collected walking the posts in collection order (a
 * tag is named as first met); a page's tags link to the post tag of the
 * same slug, or to "" where no post has it. Tags order by post count
 * descending, then by slug.
 */
function buildTagIndex(st) {
  const bySlug = new Map();
  for (const p of st.posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugOf(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${st.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of st.sources) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
  }
  st.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));
}

/** A neighbour as the templates see it, or null. */
const neighborOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : dateLong(s.data.date) });

/** A tag as its page sees it. */
const tagView = (st, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => st.cards.get(p)) });

/** A source as a card. */
function makeCard(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : dateLong(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A source as a page: its card plus slug, content, table of contents, neighbours and is_post. */
function makePage(s) {
  return {
    ...makeCard(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: neighborOf(s.newer ?? null),
    older: neighborOf(s.older ?? null),
    is_post: s.post,
  };
}

/** Every page through its layout, the index paginated, the tag pages, then the statics. */
function renderPages(st) {
  st.cards = new Map(st.posts.map((p) => [p, makeCard(p)]));
  const site = { title: st.input.site.title, base_url: st.base };
  const allTags = st.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = st.posts.slice(0, st.input.site.recent).map((p) => st.cards.get(p));
  const ctx = { templates: st.templates, escape: htmlEscape };
  const render = (name, vars) => {
    const nodes = st.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of st.sources) st.output[`${s.outDir}/index.html`] = render(s.layout, { page: makePage(s) });
  const per = st.input.site.per_page;
  const pages = Math.max(1, Math.ceil(st.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${st.base}/` : `${st.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: st.posts.slice((k - 1) * per, k * per).map((p) => st.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) st.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of st.tags) {
    const html = render('tag', { tag: tagView(st, t) });
    if (html !== null) st.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) st.output['tags/index.html'] = tagsHtml;
  for (const f of st.statics) {
    if (Object.hasOwn(st.output, f.path)) st.report.push(`shadowed ${f.path}: a built page has its path`);
    else st.output[f.path] = f.content;
  }
}

/** build-report.txt: every reported line sorted, then the built-counts line. */
function writeReport(st) {
  const lines = [...st.report, ...st.broken].sort(cmpStr);
  const pages = st.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${st.posts.length} posts, ${st.tags.length} tags and ${st.statics.length} static files`);
  st.output[REPORT_NAME] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateFault)) throw err;
      reportLines.push(err.message);
    }
  }
  const st = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  collectInputs(st);
  filterSources(st);
  assignUrls(st);
  renderBodies(st);
  orderPosts(st);
  buildTagIndex(st);
  renderPages(st);
  writeReport(st);
  return st.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}

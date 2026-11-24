// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Written from scratch in this session from the dialect's specification
// (the kit's vendor README): the same front matter, template dialect,
// Markdown subset, slug rule and report — byte for byte — with the hot
// paths rewritten for speed: Markdown is lexed and rendered in one pass
// with manual character scans instead of a regex per line, HTML escaping
// scans for the next special character instead of replacing per character,
// slugify has an ASCII fast path plus a cache, and templates are compiled
// to plain JavaScript functions (a tree-walking renderer is kept as a
// fallback when code generation is unavailable). No dependency, no network,
// no clock, no randomness: the output is a function of the input alone,
// so two runs are byte-identical.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether a code unit is JavaScript whitespace (what /\s/ matches). */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (start < i) out += text.slice(start, i);
    out += rep;
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left.
 */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  slugCache.set(text, out);
  return out;
}

function slugifySlow(text) {
  // One pass over the characters: ASCII is slugified directly, and the
  // first non-ASCII character bails to the normalising path (NFKD never
  // changes an ASCII character, so the partial result is discarded safely).
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return slugifyNonAscii(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugifyNonAscii(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  out = out.replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    const [y, m, d] = date.split('-');
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateCache.set(date, v);
  }
  return v;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isKeyName(key) {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // A "key: value" line: a key of a-z and _, a colon, one space and the value.
    const ci = line.indexOf(':');
    if (ci < 1 || !isKeyName(line.slice(0, ci))) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    const key = line.slice(0, ci);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** A fence's language, or null when the line does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the line closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let i = n;
  if (i >= line.length || (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9)) return null;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let j = line.length;
  while (j > i && (line.charCodeAt(j - 1) === 32 || line.charCodeAt(j - 1) === 9)) j--;
  if (j === i) return null;
  return { depth: n, text: line.slice(i, j) };
}

/** Whether the line is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const m = c0 === 45 ? '---' : '***';
  if (!line.startsWith(m)) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWS(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes. */
function isEscapable(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62
  );
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether the target holds whitespace (what /\s/ matches). */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // One scan for the next character that needs work: a Markdown mark
    // (\ ` * [) or an HTML escape (& < > " '). Everything between is
    // copied verbatim — it holds neither.
    let j = i;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91 || c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) {
      out += s.slice(i, j);
      i = j;
    }
    if (i >= n) break;
    const c = s.charCodeAt(i);
    if (c === 38) {
      out += '&amp;';
      i++;
      continue;
    }
    if (c === 60) {
      out += '&lt;';
      i++;
      continue;
    }
    if (c === 62) {
      out += '&gt;';
      i++;
      continue;
    }
    if (c === 34) {
      out += '&quot;';
      i++;
      continue;
    }
    if (c === 39) {
      out += '&#39;';
      i++;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        const nc = s.charCodeAt(i + 1);
        out += nc === 60 ? '&lt;' : nc === 62 ? '&gt;' : nc === 38 ? '&amp;' : nc === 34 ? '&quot;' : nc === 39 ? '&#39;' : s[i + 1];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWhitespace(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
      continue;
    }
    out += '[';
    i++;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      html += `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
      i++;
      while (i < n && !fenceClose(lines[i])) {
        html += escapeHtml(lines[i]);
        html += '\n';
        i++;
      }
      i++;
      html += '</code></pre>\n';
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const h = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.slice(l.charCodeAt(1) === 32 ? 2 : 1));
      }
      const ls = body.map(trimLine).filter((l) => l !== '');
      html += ls.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      const start = isOrdered ? Number(ordered.num) : 1;
      while (i < n) {
        const cur = lines[i];
        if (isOrdered) {
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(cur);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      html += isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const h = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

function isNameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isNameChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  const fail = () => {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  };
  if (text === '') fail();
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isNameStart(p.charCodeAt(0))) fail();
    for (let i = 1; i < p.length; i++) if (!isNameChar(p.charCodeAt(i))) fail();
  }
  return parts;
}

function isSpacesTabs(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
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
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesTabs(src.slice(lineStart, open)) && isSpacesTabs(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `{% for x in path %}` parsed, or null. */
function parseFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  if (!isNameStart(tag.charCodeAt(i))) return null;
  let j = i + 1;
  while (j < tag.length && isNameChar(tag.charCodeAt(j))) j++;
  const varName = tag.slice(i, j);
  if (tag.slice(j, j + 4) !== ' in ') return null;
  const path = tag.slice(j + 4);
  if (path === '') return null;
  for (let k = 0; k < path.length; k++) if (isWS(path.charCodeAt(k))) return null;
  return { name: varName, path };
}

/** `{% if [not] path %}` parsed, or null. */
function parseIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '') return null;
  for (let k = 0; k < rest.length; k++) if (isWS(rest.charCodeAt(k))) return null;
  return { not, path: rest };
}

/** `{% include "name" %}` parsed, or null. */
function parseInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return { name };
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = parseInclude(tag)) !== null) body.push({ kind: 'include', name: m.name });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
export function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile parsed nodes to a function (S, T, D, esc, txt, truthy) -> string.
 * S is one flat null-prototype scope object holding the page's values and
 * the loop bindings in force (a loop saves and restores the names it binds,
 * so a binding shadows a page value exactly while it runs); T maps template
 * names to their compiled functions; D is the include depth.
 */
function compileTemplate(nodes) {
  let src = "let o='';\nlet v0;\n";
  let uid = 0;
  const lookupStmts = (path) => {
    let s = `v0=S[${JSON.stringify(path[0])}];\n`;
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      s += `v0=(v0!==null&&typeof v0==="object"&&Object.hasOwn(v0,${seg}))?v0[${seg}]:void 0;\n`;
    }
    return s;
  };
  const gen = (ns) => {
    for (const n of ns) genNode(n);
  };
  const genNode = (n) => {
    switch (n.kind) {
      case 'text':
        src += `o+=${JSON.stringify(n.text)};\n`;
        break;
      case 'var':
        src += lookupStmts(n.path);
        src += 'o+=esc(txt(v0));\n';
        break;
      case 'raw':
        src += lookupStmts(n.path);
        src += 'o+=txt(v0);\n';
        break;
      case 'if': {
        src += lookupStmts(n.path);
        src += `if(truthy(v0)!==${n.not}){\n`;
        gen(n.then);
        src += '}';
        if (n.else !== null) {
          src += 'else{\n';
          gen(n.else);
          src += '}';
        }
        src += '\n';
        break;
      }
      case 'for': {
        const id = ++uid;
        const nm = JSON.stringify(n.name);
        src += lookupStmts(n.path);
        src += `if(Array.isArray(v0)){const _a${id}=v0;const _n${id}=_a${id}.length;const _l${id}={index:0,first:false,last:false,length:_n${id}};const _sv${id}=S[${nm}];const _hv${id}=Object.hasOwn(S,${nm});const _sl${id}=S.loop;S.loop=_l${id};for(let _i${id}=0;_i${id}<_n${id};_i${id}++){S[${nm}]=_a${id}[_i${id}];_l${id}.index=_i${id}+1;_l${id}.first=_i${id}===0;_l${id}.last=_i${id}===_n${id}-1;\n`;
        gen(n.body);
        src += `}if(_hv${id}){S[${nm}]=_sv${id};}else{delete S[${nm}];}S.loop=_sl${id};}\n`;
        break;
      }
      case 'include': {
        const id = ++uid;
        src += `if(D<${INCLUDE_DEPTH}){const _f${id}=T[${JSON.stringify(n.name)}];if(_f${id}!==undefined){o+=_f${id}(S,T,D+1,esc,txt,truthy);}}\n`;
        break;
      }
    }
  };
  gen(nodes);
  src += 'return o;\n';
  return new Function('S', 'T', 'D', 'esc', 'txt', 'truthy', src);
}

// ---------------------------------------------------------------- tree-walking renderer (fallback)

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
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

/** `nodes` rendered in the scope chain, used when code generation is unavailable. */
function renderNodesWalk(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodesWalk(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        xs.forEach((x, k) => {
          const vars = { [n.name]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodesWalk(n.body, { vars, parent: scope }, templates, depth);
        });
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodesWalk(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    // Skip whitespace: the ASCII whitespace characters inline, the rest through isWS.
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) { i++; continue; }
      if (c < 128 || !isWS(c)) break;
      i++;
    }
    if (i >= len) break;
    n++;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) break;
      if (c < 128) { i++; continue; }
      if (isWS(c)) break;
      i++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
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

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
  // 2. Templates, parsed in code-unit order of their name. One that does
  // not parse is reported and left out, as if it were not there.
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile each parsed template once; a failure anywhere falls back to
  // the tree-walking renderer for the whole build.
  const compiled = Object.create(null);
  let useCompiled = true;
  try {
    for (const [name, nodes] of parsed) compiled[name] = compileTemplate(nodes);
  } catch {
    useCompiled = false;
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 3. Each source's front matter, in the checks' order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let dirSet = taken.get(dir);
    if (dirSet === undefined) {
      dirSet = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, dirSet);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), dirSet);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Each body's Markdown, its links resolved to the pages and static files they name.
  // A link's answer depends only on its source directory and its target, so
  // the resolution is cached per build; a broken link is still reported for
  // every source that holds it, as the report names the source.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const brokenKeys = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const key = `${dir}\n${target}`;
        const hit = linkCache.get(key);
        if (hit !== undefined) {
          if (brokenKeys.has(key)) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit;
        }
        let href;
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) href = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            brokenKeys.add(key);
            href = target;
          }
        }
        linkCache.set(key, href);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order, as [name, slug] pairs. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(([name, slug]) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The cards and pages, each built once.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  /** A page as its layout reads it: its card, then its own fields. */
  const pageOf = (s) => ({
    title: s.card.title,
    url: s.card.url,
    date: s.card.date,
    date_long: s.card.date_long,
    summary: s.card.summary,
    excerpt: s.card.excerpt,
    reading_minutes: s.card.reading_minutes,
    tags: s.card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 8. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const S = Object.create(null);
  const render = (name, vars) => {
    if (useCompiled) {
      const fn = compiled[name];
      if (fn !== undefined) {
        S.site = site;
        S.tags = allTags;
        S.recent = recent;
        S.page = vars.page;
        S.posts = vars.posts;
        S.pager = vars.pager;
        S.tag = vars.tag;
        return fn(S, compiled, 0, escapeHtml, textOf, truthy);
      }
      return null;
    }
    const nodes = parsed.get(name);
    if (nodes === undefined) return null;
    return renderNodesWalk(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, parsed, 0);
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

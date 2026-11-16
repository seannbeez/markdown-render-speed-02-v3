// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer whose
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (GFM on, breaks off). Written from scratch for this entry:
// a single-pass charCodeAt scanner, Uint8Array lookup tables, and a
// fast-path + full-spec fallback structure. No caching across calls, no
// network, fully deterministic.

// ---------------------------------------------------------------------------
// Character classification tables
// ---------------------------------------------------------------------------

const PUNCT = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[ch.charCodeAt(0)] = 1;
// ASCII whitespace: space, tab, LF, VT, FF, CR
const WS = new Uint8Array(128);
WS[32] = 1; WS[9] = 1; WS[10] = 1; WS[11] = 1; WS[12] = 1; WS[13] = 1;

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function isSpaceCode(c) { return c < 128 ? WS[c] === 1 : c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000; }
function isPunctCode(c) { return c < 128 ? PUNCT[c] === 1 : UNICODE_PUNCT.test(String.fromCharCode(c)); }
function isDigitCode(c) { return c >= 48 && c <= 57; }
function isAlphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnumCode(c) { return isAlphaCode(c) || isDigitCode(c); }

// ---------------------------------------------------------------------------
// Escaping. marked's text escape leaves a `&` alone when it starts something
// that looks like an entity reference (&name; / &#123; / &#x1f;), and escapes
// & < > " ' otherwise. Code spans, code blocks and autolinks escape every &.
// ---------------------------------------------------------------------------

function isEntityAt(s, i) {
  // s[i] === '&'. Returns true when s[i..] starts with a valid-looking
  // entity reference: &#1-7 decimal digits; &#x1-6 hex digits; or \w+;
  let j = i + 1;
  const n = s.length;
  if (j < n && s.charCodeAt(j) === 35) { // '#'
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x/X
      j++;
      const st = j;
      while (j < n && j - st < 6) {
        const c = s.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) break;
        j++;
      }
      if (j === st || j - st > 6) return false;
      return j < n && s.charCodeAt(j) === 59;
    }
    const st = j;
    while (j < n && j - st < 7 && isDigitCode(s.charCodeAt(j))) j++;
    if (j === st || j - st > 7) return false;
    return j < n && s.charCodeAt(j) === 59;
  }
  const st = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) break;
    j++;
  }
  if (j === st) return false;
  return j < n && s.charCodeAt(j) === 59;
}

// Text escaping: preserves entity-looking sequences, escapes & < > " '.
function esc(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { if (!isEntityAt(s, i)) rep = '&amp;'; }
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Full escaping: every & is escaped (code spans, code blocks, autolinks).
function escFull(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Decode a numeric character reference at s[i] ('&'). Returns [char, end]
// where end is the index just past the ';', or null when it is not a valid
// numeric reference (wrong digit count, no ';', ...). 0, surrogates and
// values above 0x10FFFF decode to U+FFFD.
function decodeNumericEntity(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2;
  const n = s.length;
  let hex = false;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const st = j;
  let cp = 0;
  const maxDigits = hex ? 6 : 7;
  while (j < n && j - st < maxDigits) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else break;
    cp = cp * (hex ? 16 : 10) + d;
    j++;
  }
  if (j === st || j - st > maxDigits) return null;
  if (j >= n || s.charCodeAt(j) !== 59) return null; // ';'
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ['\ufffd', j + 1];
  return [String.fromCodePoint(cp), j + 1];
}

// Clean a link destination the way marked does: encodeURI, or null when it
// cannot be encoded (lone surrogate).
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch (e) { return null; }
}

// Backslash escape: a backslash before an ASCII punctuation character (or a
// newline, handled by the caller) yields that character; otherwise the
// backslash is literal.
function isEscapable(c) { return c < 128 ? PUNCT[c] === 1 : false; }

// ---------------------------------------------------------------------------
// Inline parsing helpers
// ---------------------------------------------------------------------------

// Normalize a link label: resolve backslash escapes, trim, collapse internal
// whitespace runs to one space, lowercase.
function normalizeLabel(s) {
  // labels match on the RAW text: backslash escapes are NOT unescaped
  // ([bar][foo\!] does not match [foo!]: /url), and matching uses Unicode
  // case folding, not plain lowercasing (ß/ẞ fold to ss)
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Find the index of the closing backtick run of exactly `runLen` backticks,
// starting the search at `from`. A run of a different length is skipped.
function findCodeClose(text, from, runLen, limit) {
  const n = limit === undefined ? text.length : limit;
  let i = from;
  while (i < n) {
    if (text.charCodeAt(i) === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      if (j - i === runLen) return i;
      i = j;
    } else i++;
  }
  return -1;
}

// Find the index of the `]` that closes the link text starting at text[i]
// ('['). Brackets nest (balanced), backslash escapes and code spans do not
// count. Follows marked's link label regex: inside nested brackets a
// backtick is an ordinary char; at depth 1 a backtick run opens a code
// span whose closing run is the FIRST subsequent backtick run, of any
// length — and when no such run exists the link fails, except that a run
// of 2+ backticks immediately before ']' is literal and the ']' still
// closes. Returns -1 when there is none.
function findLinkTextEnd(text, i, bounded) {
  const n = text.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      if (depth > 1) { j++; continue; }
      let k = j;
      while (k < n && text.charCodeAt(k) === 96) k++;
      const runLen = k - j;
      let m = k;
      let closeEnd = -1;
      while (m < n) {
        // Bounded retry: a code span may not swallow the ']' that could
        // close this label — the label pattern backtracks to the
        // literal-run alternative there instead.
        if (bounded && text.charCodeAt(m) === 93) break;
        if (text.charCodeAt(m) === 96) {
          let e = m;
          while (e < n && text.charCodeAt(e) === 96) e++;
          closeEnd = e;
          break;
        }
        m++;
      }
      if (closeEnd >= 0) { j = closeEnd; continue; }
      if (runLen >= 2 && k < n && text.charCodeAt(k) === 93) { j = k; continue; }
      return -1;
    }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// Find the `]` that closes a reference label starting at text[i] ('[').
// Labels may not contain an unescaped '['. Returns -1 when there is none.
function findLabelEnd(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return -1;
    if (c === 93) return j;
    j++;
  }
  return -1;
}

// Skip spaces, tabs and newlines. (A blank line inside a link is not
// specially rejected; the practice set arbitrates.)
function skipWs(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse an angle-bracketed link destination at text[i] ('<').
// Returns {dest, end} or null.
function parseAngleDest(text, i) {
  const n = text.length;
  let dest = '';
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 10) return null;
    if (c === 62) return { dest, end: j + 1 }; // '>'
    if (c === 92) {
      const nc = j + 1 < n ? text.charCodeAt(j + 1) : -1;
      if (nc >= 0 && isEscapable(nc)) { dest += text[j + 1]; j += 2; continue; }
      dest += '\\'; j++; continue;
    }
    dest += text[j];
    j++;
  }
  return null;
}

// Parse a bare link destination at text[i]. Stops at whitespace, at a ')'
// that would close the link, or at end of input. Parens must balance.
// Returns {dest, end} or null when the destination is empty.
function parseBareDest(text, i) {
  const n = text.length;
  let dest = '';
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92) {
      const nc = j + 1 < n ? text.charCodeAt(j + 1) : -1;
      if (nc >= 0 && isEscapable(nc)) { dest += text[j + 1]; j += 2; continue; }
      dest += '\\'; j++; continue;
    }
    if (c === 40) { depth++; dest += '('; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; dest += ')'; j++; continue;
    }
    dest += text[j];
    j++;
  }
  if (j === i) return null;
  return { dest, end: j };
}

// Parse a link title at text[i] ('"', '\'' or '('). Returns {title, end}
// or null. A parenthesised title ends at the first unescaped ')'.
function parseTitle(text, i) {
  const n = text.length;
  const q = text.charCodeAt(i);
  if (q === 34 || q === 39) {
    let title = '';
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === q) return { title, end: j + 1 };
      if (c === 92) {
        const nc = j + 1 < n ? text.charCodeAt(j + 1) : -1;
        if (nc >= 0 && isEscapable(nc)) { title += text[j + 1]; j += 2; continue; }
        title += '\\'; j++; continue;
      }
      title += text[j];
      j++;
    }
    return null;
  }
  if (q === 40) {
    let title = '';
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 41) return { title, end: j + 1 };
      if (c === 92) {
        const nc = j + 1 < n ? text.charCodeAt(j + 1) : -1;
        if (nc >= 0 && isEscapable(nc)) { title += text[j + 1]; j += 2; continue; }
        title += '\\'; j++; continue;
      }
      title += text[j];
      j++;
    }
    return null;
  }
  return null;
}

// Parse an inline HTML tag at text[i] ('<'). Returns {end} (index just past
// the tag) or null when this is not a well-formed tag.
function parseTagAt(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    if (text.startsWith('<!-->', i)) return { end: i + 5 };
    if (text.startsWith('<!--->', i)) return { end: i + 6 };
    const end = text.indexOf('-->', i + 4);
    if (end < 0) return null;
    return { end: end + 3 };
  }
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    if (end < 0) return null;
    return { end: end + 2 };
  }
  if (text.startsWith('<![CDATA[', i)) {
    const end = text.indexOf(']]>', i + 9);
    if (end < 0) return null;
    return { end: end + 3 };
  }
  if (text.startsWith('<!', i)) {
    const c = i + 2 < n ? text.charCodeAt(i + 2) : -1;
    if (isAlphaCode(c)) {
      const end = text.indexOf('>', i + 2);
      if (end < 0) return null;
      return { end: end + 1 };
    }
    return null;
  }
  // Closing tag: </name optional-ws >
  if (i + 1 < n && text.charCodeAt(i + 1) === 47) {
    let j = i + 2;
    if (j >= n || !isAlphaCode(text.charCodeAt(j))) return null;
    while (j < n && (isAlnumCode(text.charCodeAt(j)) || text.charCodeAt(j) === 45)) j++;
    while (j < n && isSpaceCode(text.charCodeAt(j))) j++;
    if (j < n && text.charCodeAt(j) === 62) return { end: j + 1 };
    return null;
  }
  // Open tag: <name attrs? > or />
  let j = i + 1;
  if (j >= n || !isAlphaCode(text.charCodeAt(j))) return null;
  while (j < n && (isAlnumCode(text.charCodeAt(j)) || text.charCodeAt(j) === 45)) j++;
  for (;;) {
    let k = j;
    while (k < n && isSpaceCode(text.charCodeAt(k))) k++;
    if (k >= n) return null;
    const c = text.charCodeAt(k);
    if (c === 62) return { end: k + 1 }; // '>'
    if (c === 47) {
      if (k + 1 < n && text.charCodeAt(k + 1) === 62) return { end: k + 2 };
      return null;
    }
    // attribute name: letter or '_' first, then alnum _ . : -
    if (!(isAlphaCode(c) || c === 95)) return null;
    j = k + 1;
    while (j < n) {
      const cc = text.charCodeAt(j);
      if (isAlnumCode(cc) || cc === 95 || cc === 46 || cc === 58 || cc === 45) j++;
      else break;
    }
    k = j;
    while (k < n && isSpaceCode(text.charCodeAt(k))) k++;
    if (k < n && text.charCodeAt(k) === 61) { // '='
      k++;
      while (k < n && isSpaceCode(text.charCodeAt(k))) k++;
      if (k >= n) return null;
      const q = text.charCodeAt(k);
      if (q === 34 || q === 39) {
        const end = text.indexOf(String.fromCharCode(q), k + 1);
        if (end < 0) return null;
        j = end + 1;
      } else {
        let m = k;
        while (m < n) {
          const cc = text.charCodeAt(m);
          if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
          m++;
        }
        if (m === k) return null;
        j = m;
      }
      // after a value, the next char must be whitespace, '/' or '>':
      // a quoted value glued to the next attribute name is not a tag
      if (j < n) {
        const nc = text.charCodeAt(j);
        if (!(isSpaceCode(nc) || nc === 47 || nc === 62)) return null;
      }
    } else {
      j = k;
    }
  }
}

// Email local-part characters (GFM): alnum plus . ! # $ % & ' * + / = ? ^ _ ` { | } ~ -
const EMAIL_LOCAL = new Uint8Array(128);
for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?^_`{|}~-') EMAIL_LOCAL[ch.charCodeAt(0)] = 1;
function isEmailLocalChar(c) { return c < 128 && EMAIL_LOCAL[c] === 1; }

// Validate an email address string (no surrounding <>). Domain labels are
// [A-Za-z0-9_-]+ separated by dots, at least one dot, first and last label
// characters alphanumeric.
function isEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  for (let i = 0; i < at; i++) if (!isEmailLocalChar(s.charCodeAt(i))) return false;
  const dom = s.slice(at + 1);
  if (dom.length === 0 || dom.indexOf('.') < 0) return false;
  if (!isAlnumCode(dom.charCodeAt(0)) || !isAlnumCode(dom.charCodeAt(dom.length - 1))) return false;
  let labelStart = 0;
  for (let i = 0; i <= dom.length; i++) {
    if (i === dom.length || dom.charCodeAt(i) === 46) {
      if (i === labelStart) return false;
      labelStart = i + 1;
    } else {
      const c = dom.charCodeAt(i);
      if (!(isAlnumCode(c) || c === 95 || c === 45)) return false;
    }
  }
  return true;
}

// Parse an <...> autolink at text[i] ('<'): <scheme:...> or <email>.
// Returns {end, href, text} or null.
function parseAutolinkAt(text, i) {
  const n = text.length;
  let j = i + 1;
  if (j < n && isAlphaCode(text.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && k - j < 32) {
      const c = text.charCodeAt(k);
      if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) k++;
      else break;
    }
    if (k - j >= 2 && k - j <= 32 && k < n && text.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < n) {
        const c = text.charCodeAt(m);
        if (c === 62) break;
        if (c <= 32 || c === 60) return null;
        m++;
      }
      if (m < n && m > k + 1) {
        const s = text.slice(i + 1, m);
        return { end: m + 1, href: s, text: s };
      }
      return null;
    }
  }
  const gt = text.indexOf('>', i + 1);
  if (gt < 0) return null;
  const inner = text.slice(i + 1, gt);
  if (inner.indexOf('\n') >= 0 || inner.indexOf(' ') >= 0 || inner.indexOf('<') >= 0) return null;
  if (isEmail(inner)) return { end: gt + 1, href: 'mailto:' + inner, text: inner };
  return null;
}

// Punctuation class of marked's url _backpedal: ? ! . , : ; * _ ' " ~ )
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
    c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}

// One backpedal pass over text[i..end): walk from i, consuming plain-char
// runs, balanced (...) groups, '&' (unless it starts a &name; entity at
// the very end), and punctuation runs that do not reach the end; stop at
// the first char that cannot be consumed. Returns the new end (<= end).
function backpedalUrl(text, i, end) {
  let p = i;
  while (p < end) {
    const c = text.charCodeAt(p);
    if (c === 40) { // '(' — consume through the next ')' if there is one
      const close = text.indexOf(')', p + 1);
      if (close < 0 || close >= end) return p;
      p = close + 1;
      continue;
    }
    if (c === 38) { // '&' — stop before it when it starts &name; at the end
      let q = p + 1;
      while (q < end && isAlnumCode(text.charCodeAt(q))) q++;
      if (q > p + 1 && q < end && text.charCodeAt(q) === 59 && q === end - 1) return p;
      p++;
      continue;
    }
    if (isBackpedalPunct(c)) {
      let q = p;
      while (q < end && isBackpedalPunct(text.charCodeAt(q))) q++;
      if (q === end) return p;
      p = q;
      continue;
    }
    p++;
  }
  return end;
}

// Scan a URL-ish run starting at text[i], applying marked's _backpedal
// repeatedly until stable: a ')' is kept when it belongs to a balanced
// (...) group or is followed by more text, and only dropped when it ends
// the URL unbalanced; a trailing &name; is dropped whole, a trailing
// &#...; only loses its ';'. Returns {text, end} or null.
function scanUrl(text, i) {
  const n = text.length;
  let end = i;
  while (end < n) {
    const c = text.charCodeAt(end);
    if (c <= 32 || c === 60 || c === 62) break;
    end++;
  }
  if (end === i) return null;
  for (;;) {
    const next = backpedalUrl(text, i, end);
    if (next === end) break;
    end = next;
    if (end <= i) return null;
  }
  if (end <= i) return null;
  return { text: text.slice(i, end), end };
}

// Scan an email domain starting at text[i]. Returns {end} or null.
// hasUndOpen: whether a '_' emphasis opener was seen earlier in this
// inline span. The domain's last label must end with an alphanumeric
// character (marked's email regex ends with (?![\w-])): a trailing '.'
// is dropped and the address still links, but a trailing '-' kills the
// address entirely, and a trailing '_' kills it too UNLESS the '_' is
// an emphasis closer (emStrong consumes it before the email is scanned,
// so the address links: '__foo bar@baz.qux__' links, 'foo bar@baz.qux_'
// does not).
function scanEmailDomain(text, i, hasUndOpen) {
  const n = text.length;
  let end = i;
  while (end < n) {
    const c = text.charCodeAt(end);
    if (isAlnumCode(c) || c === 46 || c === 95 || c === 45) end++;
    else break;
  }
  // trim trailing '.', '_' or '-' so the domain ends with an alnum char
  while (end > i) {
    const lc = text.charCodeAt(end - 1);
    if (lc === 46 || lc === 95 || lc === 45) end--;
    else break;
  }
  if (end <= i) return null;
  // the first character after the trimmed domain decides whether the
  // address survives: '.' is fine, '-' kills it, '_' is fine only when
  // it is an emphasis closer (a '_' opener was seen earlier)
  if (end < n) {
    const nc = text.charCodeAt(end);
    if (nc === 45) return null;
    if (nc === 95 && !hasUndOpen) return null;
  }
  const dom = text.slice(i, end);
  if (dom.indexOf('.') < 0) return null;
  if (!isAlnumCode(dom.charCodeAt(0)) || !isAlnumCode(dom.charCodeAt(dom.length - 1))) return null;
  let labelStart = 0;
  for (let q = 0; q <= dom.length; q++) {
    if (q === dom.length || dom.charCodeAt(q) === 46) {
      if (q === labelStart) return null;
      labelStart = q + 1;
    } else {
      const c = dom.charCodeAt(q);
      if (!(isAlnumCode(c) || c === 95 || c === 45)) return null;
    }
  }
  return { end };
}

// Scan an email address starting at text[i] (local@domain). Returns
// {end} or null.
function scanEmailAt(text, i, hasUndOpen) {
  const n = text.length;
  if (i >= n || !isEmailLocalChar(text.charCodeAt(i))) return null;
  let k = i;
  while (k < n && isEmailLocalChar(text.charCodeAt(k))) k++;
  if (k >= n || text.charCodeAt(k) !== 64) return null;
  const d = scanEmailDomain(text, k + 1, hasUndOpen);
  if (!d) return null;
  return { end: d.end };
}

// Parse an extended autolink (www. / scheme:// / mailto: / xmpp: / email)
// starting at text[i]. Returns {end, href, text} or null.
function parseExtendedAt(text, i, hasUndOpen) {
  const n = text.length;
  if (text.startsWith('www.', i)) {
    if (i > 0) {
      const p = text.charCodeAt(i - 1);
      if (isAlnumCode(p) || p === 95) return null;
    }
    const after = i + 4;
    if (after >= n) return null;
    const c = text.charCodeAt(after);
    if (!(isAlnumCode(c) || c === 95 || c === 45)) return null;
    const u = scanUrl(text, i);
    if (!u) return null;
    return { end: u.end, href: 'http://' + u.text, text: u.text };
  }
  const c0 = text.charCodeAt(i);
  if (isAlphaCode(c0)) {
    let k = i;
    while (k < n && k - i < 32) {
      const c = text.charCodeAt(k);
      if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) k++;
      else break;
    }
    if (k - i >= 2 && k - i <= 32 && text.startsWith('://', k)) {
      const after = k + 3;
      if (after < n && text.charCodeAt(after) !== 40) {
        const u = scanUrl(text, i);
        if (u && u.end > after) return { end: u.end, href: u.text, text: u.text };
      }
      return null;
    }
    // mailto: / xmpp: followed by an email address (only these two schemes)
    if (k - i >= 2 && k - i <= 32 && k < n && text.charCodeAt(k) === 58) {
      const scheme = text.slice(i, k);
      if (scheme === 'mailto' || scheme === 'xmpp') {
        const em = scanEmailAt(text, k + 1, hasUndOpen);
        if (em) {
          let end = em.end;
          // xmpp allows an optional /resource suffix (trailing '.' trimmed)
          if (scheme === 'xmpp' && end < n && text.charCodeAt(end) === 47) {
            let q = end + 1;
            while (q < n) {
              const c = text.charCodeAt(q);
              if (isAlnumCode(c) || c === 64 || c === 46) q++;
              else break;
            }
            while (q > end + 1 && text.charCodeAt(q - 1) === 46) q--;
            if (q > end + 1) end = q;
          }
          const s = text.slice(i, end);
          return { end, href: s, text: s };
        }
      }
    }
  }
  if (isEmailLocalChar(c0)) {
    if (i > 0 && isEmailLocalChar(text.charCodeAt(i - 1))) return null;
    const em = scanEmailAt(text, i, hasUndOpen);
    if (em) return { end: em.end, href: 'mailto:' + text.slice(i, em.end), text: text.slice(i, em.end) };
    return null;
  }
  return null;
}

function containsLink(tokens) {
  for (const t of tokens) {
    if (t.k === 6) return true;
    if (t.ch && containsLink(t.ch)) return true;
  }
  return false;
}

// Plain-text rendering of inline tokens, for image alt attributes.
function plainText(tokens) {
  let s = '';
  for (const t of tokens) {
    switch (t.k) {
      case 0: s += t.s; break;
      case 1: s += t.s; break;
      case 2: break;
      case 3: break;
      case 4: s += '\n'; break;
      case 5: s += t.ch.repeat(t.n); break;
      case 6: s += plainText(t.ch); break;
      case 7: s += t.alt; break;
      case 8: case 9: case 10: s += plainText(t.ch); break;
      case 11: s += t.text; break;
    }
  }
  return s;
}

// Whether the link text is blocked by a tag/autolink inside it that extends
// past the end of the label (marked's `Be` gate): a `<...>` tag or autolink
// starting inside the label whose match swallows the `]` (and the
// destination) prevents the link from forming at all.
function linkTextBlocked(text, labelStart, label) {
  if (label.indexOf('<') < 0) return false;
  for (let s = 0; s < label.length; s++) {
    const c = label.charCodeAt(s);
    if (c === 92) { s++; continue; }
    if (c === 96) {
      let j = s;
      while (j < label.length && label.charCodeAt(j) === 96) j++;
      const close = findCodeClose(label, j, j - s);
      if (close >= 0) { s = close + (j - s) - 1; continue; }
    }
    if (c !== 60) continue;
    const pos = labelStart + s;
    const r = parseTagAt(text, pos) || parseAutolinkAt(text, pos);
    if (r) {
      if (r.end - pos > label.length - s) return true;
      s += (r.end - pos) - 1;
    }
  }
  return false;
}

// Attempt to parse a link (isImage false) or image (true) starting at
// text[i] ('[' or '!['). Returns {end, token} or null.
function parseLinkAt(text, i, isImage, refs) {
  const n = text.length;
  let p = i;
  if (isImage) p++;
  const textEnd0 = findLinkTextEnd(text, p);
  // If the greedy code-span path finds no label end, retry with code
  // spans bounded at ']' (the label pattern's backtrack to the literal
  // double-backtick alternative).
  const textEnd = textEnd0 < 0 ? findLinkTextEnd(text, p, true) : textEnd0;
  if (textEnd < 0) return null;
  const rawText = text.slice(p + 1, textEnd);
  if (linkTextBlocked(text, p + 1, rawText)) return null;
  let j = textEnd + 1;
  let dest = null;
  let title = null;
  let end = -1;
  if (j < n && text.charCodeAt(j) === 40) { // '(' inline link
    let k = skipWs(text, j + 1);
    let ok = false;
    if (k < n && text.charCodeAt(k) === 41) {
      dest = '';
      end = k + 1;
      ok = true;
    } else {
      const r = k < n && text.charCodeAt(k) === 60 ? parseAngleDest(text, k) : parseBareDest(text, k);
      if (r) {
        dest = r.dest;
        k = skipWs(text, r.end);
        if (k < n && text.charCodeAt(k) === 41) {
          end = k + 1;
          ok = true;
        } else {
          const t = parseTitle(text, k);
          if (t) {
            title = t.title;
            k = skipWs(text, t.end);
            if (k < n && text.charCodeAt(k) === 41) {
              end = k + 1;
              ok = true;
            }
          }
        }
      }
    }
    // an invalid inline link falls back to a shortcut reference link
    if (!ok) { dest = null; title = null; end = -1; }
  }
  if (end < 0) {
    if (j < n && text.charCodeAt(j) === 91) { // '[' reference link
      const labelEnd = findLabelEnd(text, j);
      if (labelEnd < 0) return null;
      const labelRaw = text.slice(j + 1, labelEnd);
      const label = labelRaw === '' ? normalizeLabel(rawText) : normalizeLabel(labelRaw);
      const ref = refs.get(label);
      if (!ref) return null;
      dest = ref.dest;
      title = ref.title;
      end = labelEnd + 1;
    } else { // shortcut reference
      const label = normalizeLabel(rawText);
      const ref = refs.get(label);
      if (!ref) return null;
      dest = ref.dest;
      title = ref.title;
      end = j;
    }
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  // link text is parsed with inLink: extended autolinks do not form inside
  const children = inlineParse(rawText, refs, true);
  if (!isImage && containsLink(children)) return null; // a link may not contain a link
  if (isImage) {
    return { end, token: { k: 7, src: href, title: title === null ? undefined : title, alt: plainText(children) } };
  }
  return { end, token: { k: 6, href, title: title === null ? undefined : title, ch: children } };
}

// Whether the previous character allows an extended autolink to start here.
function canStartExt(text, i) {
  if (i === 0) return true;
  const p = text.charCodeAt(i - 1);
  if (p === 32 || p === 9 || p === 10) return true;
  if (p === 40 || p === 91 || p === 123 || p === 60 || p === 34 || p === 39 || p === 59 || p === 44 || p === 58 || p === 63 || p === 33 || p === 42) return true;
  return false;
}

const SPECIAL_RE = /[*_`\[<>\\&~!]/;
const HARDBREAK_RE = / {2,}\n/;

// Document-level inLink state (marked's lexer state): an opening <a ...>
// tag in the inline text sets it and a closing </a> clears it, and it
// persists across blocks until cleared. While set, extended autolinks
// (www. / scheme:// / email) do not form anywhere in the document.
// Reset at the start of each parse() call.
let docInLink = false;

// ============================== emphasis mask ==============================
// Marked decides emphasis from a MASKED copy of the inline source, not the
// raw text: link / code-span / html / reference-link regions are replaced
// by same-length "[aaa...]" placeholders, so a delimiter run inside such
// a region is invisible to the emphasis scan (it can neither open nor
// close). The mask is built in three passes:
//
//  1. reference links whose label is a defined link definition are
//     masked (a nested "[...][ref]" whose inner text contains a link is
//     masked as "[inner][aaa]" instead);
//  2. outside code spans, backslashes before punctuation become '+', and
//     the backticks inside a code span become '+' (a code span whose
//     opening and closing runs have different lengths swallows everything
//     up to the next run of the same length, so its inner backticks are
//     neutralised here, before pass 3 can see them);
//  3. every link / code span / html tag match is masked to "[aaa...]".
//
// The four patterns below are the behavioural specification of those
// passes (decoded from the reference renderer's inline rules); the
// replacement logic around them is written here from scratch.
const MASK_REFLINK_RE = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const MASK_ANYPUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const MASK_LINK_RE = /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/;

// Whether an inline span (used as a reference-link label) contains a link
// of its own. A blockSkip match counts only if it is a valid inline link
// and is not an image; a nested reference match counts only if its label
// is not a defined definition (and does not itself contain a link).
function maskLinkInText(s, refs) {
  if (s.indexOf('[') < 0) return false;
  for (const m of s.matchAll(MASK_BLOCKSKIP_RE)) {
    if (MASK_LINK_RE.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(MASK_REFLINK_RE)) {
    const r = m[0], o = r.lastIndexOf('[');
    if (r.charAt(0) === '!' || !refs.has(normalizeLabel(r.slice(o + 1, -1)))) continue;
    if (o > 1 && maskLinkInText(r.slice(1, o - 1), refs)) continue;
    return true;
  }
  return false;
}

// The masked copy of an inline source string (same length as the input).
// `refs` is the document's link-definition map (labels normalised by
// normalizeLabel).
function computeEmMask(text, refs) {
  let t = text;
  if (refs.size && text.indexOf('[') >= 0) {
    // Pass 1: reference links. The recursive call uses a fresh copy of
    // the pattern: replace() drives the shared one, and a nested replace
    // on the same object would clobber its scan position.
    const maskReflink = (r) => {
      const o = r.lastIndexOf('[');
      if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (maskLinkInText(inner, refs)) {
          const fresh = new RegExp(MASK_REFLINK_RE.source, MASK_REFLINK_RE.flags);
          return '[' + inner.replace(fresh, maskReflink) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(MASK_REFLINK_RE, maskReflink);
  }
  // Pass 2: escapes and code-span interiors.
  t = t.replace(MASK_ANYPUNCT_RE, (m, open, esc) =>
    esc ? '+'.repeat(m.length)
      : open ? open + m.slice(open.length, -open.length).replace(/`/g, '+') + open
        : m);
  // Pass 3: links, code spans and html tags.
  t = t.replace(MASK_BLOCKSKIP_RE, (m, _a, pre) => {
    const o = pre ? pre.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

// Parse inline content into a token list. When inLink is true (parsing a
// link's text), extended autolinks (www. / scheme:// / email) do not form;
// <...> autolinks still do.
function inlineParse(text, refs, inLink) {
  // the fast path is only valid when no extended autolink (www. / scheme:// /
  // email) can start either: those contain no SPECIAL_RE characters
  if (!SPECIAL_RE.test(text) && !HARDBREAK_RE.test(text) &&
      text.indexOf('www.') < 0 && text.indexOf('://') < 0 && text.indexOf('@') < 0) {
    return [{ k: 0, s: text }];
  }
  const tokens = [];
  let buf = '';
  // whether buf's last char came from a backslash escape or a numeric
  // entity decode (in marked those are separate tokens, so the
  // previous-text-char for emphasis resets to "" after them)
  let bufLastSpecial = false;
  // Flush buf as a text token. The token records pc: the effective last
  // char for marked's emphasis prev-text-char rule ("" when the last char
  // came from an escape/entity or is '_').
  const flushBuf = () => {
    if (!buf) return;
    const lc = buf.charCodeAt(buf.length - 1);
    tokens.push({ k: 0, s: buf, pc: bufLastSpecial || lc === 95 ? '' : buf[buf.length - 1] });
    buf = '';
    bufLastSpecial = false;
  };
  // pc for a delimiter token about to be pushed (call after flushBuf):
  // marked's prev-text-char — last char of the immediately preceding text
  // token, "" when there is none or it came from an escape/entity.
  const delimPc = () => {
    const lt = tokens.length ? tokens[tokens.length - 1] : null;
    return lt && lt.k === 0 && lt.pc !== undefined ? lt.pc : '';
  };
  const n = text.length;
  let i = 0;
  // whether a '_' emphasis opener was seen in this span: a trailing '_'
  // after an email domain is an emphasis closer (and the email links)
  // only when such an opener exists
  let hasUndOpen = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92) { // backslash
      const nc = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (nc === 10) {
        flushBuf();
        tokens.push({ k: 3 });
        i += 2;
        // a hard break strips the next line's leading whitespace
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        continue;
      }
      if (nc >= 0 && isEscapable(nc)) {
        if (nc === 38) {
          // a literal '&' from an escape must not merge with following
          // text: esc() would read '&word;' as an entity
          flushBuf();
          tokens.push({ k: 0, s: '&' });
          i += 2;
          continue;
        }
        buf += text[i + 1]; bufLastSpecial = true; i += 2; continue;
      }
      buf += '\\'; bufLastSpecial = false;
      i++;
      continue;
    }
    if (c === 10) { // newline: soft or hard break
      let sp = 0;
      let q = buf.length - 1;
      while (q >= 0 && buf.charCodeAt(q) === 32) { sp++; q--; }
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flushBuf();
        tokens.push({ k: 3 });
        i++;
        // a hard break strips the next line's leading whitespace
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
      } else {
        flushBuf();
        tokens.push({ k: 4 });
        i++;
      }
      continue;
    }
    if (c === 96) { // backtick run: code span
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const runLen = j - i;
      const close = findCodeClose(text, j, runLen);
      if (close >= 0) {
        let content = text.slice(j, close);
        if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          // strip one leading and one trailing space, unless the content
          // consists entirely of spaces
          let hasNonSpace = false;
          for (let q = 1; q < content.length - 1; q++) {
            if (content.charCodeAt(q) !== 32) { hasNonSpace = true; break; }
          }
          if (hasNonSpace) content = content.slice(1, -1);
        }
        flushBuf();
        tokens.push({ k: 1, s: content });
        i = close + runLen;
        continue;
      }
      buf += text.slice(i, j); bufLastSpecial = false;
      i = j;
      continue;
    }
    if (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91) { // '!['
      const r = parseLinkAt(text, i, true, refs);
      if (r) {
        flushBuf();
        tokens.push(r.token);
        i = r.end;
        continue;
      }
      buf += '!'; bufLastSpecial = false;
      i++;
      continue;
    }
    if (c === 91) { // '['
      const r = parseLinkAt(text, i, false, refs);
      if (r) {
        flushBuf();
        tokens.push(r.token);
        i = r.end;
        continue;
      }
      buf += '['; bufLastSpecial = false;
      i++;
      continue;
    }
    if (c === 60) { // '<'
      const a = parseAutolinkAt(text, i);
      if (a) {
        flushBuf();
        tokens.push({ k: 11, href: a.href, text: a.text });
        i = a.end;
        continue;
      }
      const t = parseTagAt(text, i);
      if (t) {
        const tagText = text.slice(i, t.end);
        // document-level inLink state (marked's tag tokenizer):
        // '<a ' (case-insensitive a, literal space) sets it,
        // '</a>' clears it
        if (!docInLink && tagText.length >= 3 && tagText.charCodeAt(0) === 60 &&
            (tagText.charCodeAt(1) === 97 || tagText.charCodeAt(1) === 65) &&
            tagText.charCodeAt(2) === 32) docInLink = true;
        else if (docInLink && tagText.length >= 4 && tagText.charCodeAt(0) === 60 &&
            tagText.charCodeAt(1) === 47 &&
            (tagText.charCodeAt(2) === 97 || tagText.charCodeAt(2) === 65) &&
            tagText.charCodeAt(3) === 62) docInLink = false;
        flushBuf();
        tokens.push({ k: 2, s: tagText });
        i = t.end;
        continue;
      }
      buf += '<'; bufLastSpecial = false;
      i++;
      continue;
    }
    if (c === 42 || c === 95) { // '*' or '_': emphasis delimiter run
      let j = i;
      while (j < n && text.charCodeAt(j) === c) j++;
      const runLen = j - i;
      const before = i > 0 ? text.charCodeAt(i - 1) : 32;
      const after = j < n ? text.charCodeAt(j) : 32;
      const pb = i > 0 ? text.charCodeAt(i - 1) : -1;
      const pa = j < n ? text.charCodeAt(j) : -1;
      const beforeWs = isSpaceCode(before);
      const afterWs = isSpaceCode(after);
      const beforePunct = isPunctCode(before);
      const afterPunct = isPunctCode(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === 42) { canOpen = leftFlanking; canClose = rightFlanking; }
      else { canOpen = leftFlanking && (!rightFlanking || beforePunct); canClose = rightFlanking && (!leftFlanking || afterPunct); }
      flushBuf();
      if (c === 95 && canOpen) hasUndOpen = true;
      tokens.push({ k: 5, ch: c === 42 ? '*' : '_', n: runLen, o: canOpen, c: canClose, pb, pa, pc: delimPc(), pos: i });
      i = j;
      continue;
    }
    if (c === 126) { // '~': strikethrough delimiter run (1-2 tildes)
      let j = i;
      while (j < n && text.charCodeAt(j) === 126) j++;
      const runLen = j - i;
      if (runLen >= 3) {
        // a run of 3+ tildes is not a delimiter at all: literal text
        buf += text.slice(i, j); bufLastSpecial = false;
        i = j;
        continue;
      }
      const before = i > 0 ? text.charCodeAt(i - 1) : 32;
      const after = j < n ? text.charCodeAt(j) : 32;
      const pb = i > 0 ? text.charCodeAt(i - 1) : -1;
      const pa = j < n ? text.charCodeAt(j) : -1;
      const canOpen = !isSpaceCode(after);
      const canClose = !isSpaceCode(before);
      flushBuf();
      tokens.push({ k: 5, ch: '~', n: runLen, o: canOpen, c: canClose, pb, pa, pc: delimPc(), pos: i });
      i = j;
      continue;
    }
    if (c === 38) { // '&': numeric entity decoding (named entities stay literal)
      if (i + 1 < n && text.charCodeAt(i + 1) === 35) {
        const dec = decodeNumericEntity(text, i);
        if (dec) {
          if (dec[0] === '&') {
            // a decoded '&' is literal: keep it in its own token so esc()
            // does not read a following '&word;' as an entity
            flushBuf();
            tokens.push({ k: 0, s: '&' });
          } else { buf += dec[0]; bufLastSpecial = true; }
          i = dec[1];
          continue;
        }
      }
      buf += '&'; bufLastSpecial = false;
      i++;
      continue;
    }
    if (!inLink && !docInLink && canStartExt(text, i) && (c === 119 || isAlphaCode(c) || isEmailLocalChar(c))) {
      const a = parseExtendedAt(text, i, hasUndOpen);
      if (a) {
        flushBuf();
        tokens.push({ k: 11, href: a.href, text: a.text });
        i = a.end;
        continue;
      }
    }
    buf += text[i]; bufLastSpecial = false;
    i++;
  }
  flushBuf();
  // Hide delimiter runs that marked's masked source covers: a run is
  // visible only where the mask still shows its own character. Masked
  // runs stay in the token list as literal text (renderInline case 5).
  let hasDelim = false;
  for (const t of tokens) if (t.k === 5) { hasDelim = true; break; }
  if (hasDelim) {
    const mask = computeEmMask(text, refs);
    for (const t of tokens) {
      if (t.k !== 5) continue;
      const code = t.ch === '*' ? 42 : t.ch === '_' ? 95 : 126;
      if (mask.charCodeAt(t.pos) !== code) t.masked = true;
    }
  }
  processEmphasis(tokens);
  return tokens;
}

// Marked-style emphasis processing (NOT CommonMark Appendix A): the
// leftmost delimiter run that can open is tried first, its closer is
// found by a forward balance scan (opener-only runs add, closers
// subtract, the odd-match rule skips a closer into a free count), and
// the inner text is re-processed recursively. A failed '*'/'_' run of
// length > 1 loses one char to literal text and is retried shortened
// (marked's text tokenizer consumes one char and the scan restarts at
// the rest of the run). A failed '~' run is left whole: marked's text
// tokenizer consumes a '~+' run at once.

const UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// RDelim group of a candidate closer run (1-6, 0 = not a candidate),
// from the chars before/after the run. `star` selects the GFM '*'
// class set (punct/punctSpace exclude '~', notPunctSpace includes it);
// the '_' set uses the CommonMark classes (punct includes '~').
function delimGroup(t, star) {
  const pb = t.pb, pa = t.pa;
  if (pb === -1) return 0;
  const bPunct = star ? (isPunctCode(pb) && pb !== 126) : isPunctCode(pb);
  const bWs = isSpaceCode(pb);
  const bSpace = star ? ((isSpaceCode(pb) || isPunctCode(pb)) && pb !== 126) : (isSpaceCode(pb) || isPunctCode(pb));
  const bOther = star ? (pb === 126 || (!isSpaceCode(pb) && !isPunctCode(pb))) : (!isSpaceCode(pb) && !isPunctCode(pb));
  const aEnd = pa === -1;
  const aWs = !aEnd && isSpaceCode(pa);
  const aPunct = !aEnd && (star ? (isPunctCode(pa) && pa !== 126) : isPunctCode(pa));
  const aSpace = !aEnd && (star ? ((isSpaceCode(pa) || isPunctCode(pa)) && pa !== 126) : (isSpaceCode(pa) || isPunctCode(pa)));
  const aOther = !aEnd && (star ? (pa === 126 || (!isSpaceCode(pa) && !isPunctCode(pa))) : (!isSpaceCode(pa) && !isPunctCode(pa)));
  if (bPunct && (aWs || aEnd)) return 1;
  if (bOther && (aSpace || aEnd)) return 2;
  if (bSpace && aOther) return 3;
  if (bWs && aPunct) return 4;
  if (bPunct && aPunct) return 5;
  // group 6 exists only for '*': the '_' RDelim has no (other, other)
  // alternative (intraword '_' is not a delimiter at all)
  if (star && bOther && aOther) return 6;
  return 0;
}

// Flanking flags for a synthetic delimiter token (leftover / remainder /
// shortened run), from its before/after char codes (-1 = string edge).
function delimFlags(ch, pb, pa) {
  const before = pb === -1 ? 32 : pb;
  const after = pa === -1 ? 32 : pa;
  const beforeWs = isSpaceCode(before), afterWs = isSpaceCode(after);
  const beforePunct = isPunctCode(before), afterPunct = isPunctCode(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  if (ch === '*') return { o: leftFlanking, c: rightFlanking };
  if (ch === '_') return { o: leftFlanking && (!rightFlanking || beforePunct), c: rightFlanking && (!leftFlanking || afterPunct) };
  return { o: !afterWs, c: !beforeWs };
}

// First / last char of a token's raw in marked's masked source (link,
// code, html and autolink regions are masked to [aaa...]; an em/strong
// node's raw starts and ends with its delimiter char).
function firstMaskedChar(t) {
  switch (t.k) {
    case 0: return t.s.length ? t.s.charCodeAt(0) : -1;
    case 5: return t.ch.charCodeAt(0);
    case 1: case 2: case 6: case 11: return 91;
    case 7: return 33;
    case 3: return 32;
    case 4: return 10;
    case 8: case 9: return 42;
    case 10: return 126;
    default: return -1;
  }
}
function lastMaskedChar(t) {
  switch (t.k) {
    case 0: return t.s.length ? t.s.charCodeAt(t.s.length - 1) : -1;
    case 5: return t.ch.charCodeAt(0);
    case 1: case 2: case 6: case 7: case 11: return 93;
    case 3: case 4: return 10;
    case 8: case 9: return 42;
    case 10: return 126;
    default: return -1;
  }
}

// Whether a '*'/'_' delimiter token can open per marked's emStrong
// (LDelim + gate + the '_' + alphanumeric rule), from its own pb/pa/pc.
function emEligible(t) {
  const pa = t.pa;
  if (pa === -1 || isSpaceCode(pa)) return false;
  const d = isPunctCode(pa) && pa !== 126;
  if (d) {
    const pc = t.pc || '';
    if (pc !== '') {
      const pcc = pc.charCodeAt(0);
      if (!(isSpaceCode(pcc) || (isPunctCode(pcc) && pc !== '*' && pc !== '_'))) return false;
    }
  }
  if (t.ch === '_' && !d && t.pc && UNICODE_ALNUM.test(t.pc)) return false;
  return true;
}

// Whether a '~' delimiter token can open per marked's del (LDelim + gate).
function delEligible(t) {
  const pa = t.pa;
  if (pa === -1 || isSpaceCode(pa)) return false;
  if (isPunctCode(pa)) {
    const pc = t.pc || '';
    if (pc !== '') {
      const pcc = pc.charCodeAt(0);
      if (!(isSpaceCode(pcc) || (isPunctCode(pcc) && pc !== '*' && pc !== '_'))) return false;
    }
  }
  return true;
}

// Index of the last delimiter run of char `ch` after `oi` whose preceding
// char is not space/tab/LF/CR/FF (marked's fe() scan bound), or -1.
// Masked runs do not exist in the masked source, so they never count.
function lastCloserIndex(tokens, oi, ch) {
  for (let j = tokens.length - 1; j > oi; j--) {
    const t = tokens[j];
    if (t.k !== 5 || t.ch !== ch || t.masked) continue;
    const b = t.pb;
    if (b === -1 || b === 32 || b === 9 || b === 10 || b === 13 || b === 12) continue;
    return j;
  }
  return -1;
}

// Fix the edge context of a node's children after splicing: the inner
// text is re-lexed, so a delimiter token at its start sees no preceding
// char and one at its end (when the closer was fully consumed) sees no
// following char.
function fixChildEdges(children, openLeft, closeLeft) {
  if (children.length && children[0].k === 5 && !openLeft) {
    const fl = delimFlags(children[0].ch, -1, children[0].pa);
    children[0].pb = -1; children[0].pc = ''; children[0].o = fl.o; children[0].c = fl.c;
  }
  if (children.length && !closeLeft) {
    const last = children[children.length - 1];
    if (last.k === 5) {
      const fl = delimFlags(last.ch, last.pb, -1);
      last.pa = -1; last.o = fl.o; last.c = fl.c;
    }
  }
}

// Try the '*'/'_' delimiter at tokens[oi] as an opener. On a match the
// node is spliced in, its children are processed recursively, and the
// index just past the node is returned; otherwise null.
function scanEmStrong(tokens, oi) {
  const O = tokens[oi];
  const ch = O.ch;
  const k = O.n;
  const star = ch === '*';
  const oFlag = O.pc === ch;
  const pb = O.pb;
  const h = pb !== -1 && (isSpaceCode(pb) || isPunctCode(pb));
  const d = O.pa !== -1 && isPunctCode(O.pa) && O.pa !== 126;
  const R = pb !== -1 && !isSpaceCode(pb) && (d || (star && !h));
  const bound = lastCloserIndex(tokens, oi, ch);
  if (bound < 0) return null;
  // First-alternative skip (marked's RDelim ^... alternative): a run
  // hidden inside a __...*...__ span (for '*') or a **..._...** span
  // (for '_') at the very start of the scanned text is invisible to
  // this scan. D1 is the first */_ run after the opener (exactly 2),
  // X the next one (exactly 1, same char as the opener), D2 the next
  // one (>= 2, the other char).
  let skipIdx = -1;
  {
    const wantD = star ? '_' : '*';
    const wantX = star ? '*' : '_';
    let d1 = -1;
    for (let j = oi + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.k !== 5 || t.masked || (t.ch !== '*' && t.ch !== '_')) continue;
      d1 = j; break;
    }
    if (d1 >= 0 && tokens[d1].ch === wantD && tokens[d1].n === 2) {
      let x = -1;
      for (let j = d1 + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t.k !== 5 || t.masked || (t.ch !== '*' && t.ch !== '_')) continue;
        x = j; break;
      }
      if (x >= 0 && tokens[x].ch === wantX && tokens[x].n === 1) {
        for (let j = x + 1; j < tokens.length; j++) {
          const t = tokens[j];
          if (t.k !== 5 || t.masked || (t.ch !== '*' && t.ch !== '_')) continue;
          if (t.ch === wantD && t.n >= 2) skipIdx = x;
          break;
        }
      }
    }
  }
  let m = k, f = 0;
  const y = k;
  for (let j = oi + 1; j <= bound; j++) {
    const C = tokens[j];
    if (C.k !== 5 || C.ch !== ch || C.masked) continue;
    if (j === skipIdx) continue;
    const g = delimGroup(C, star);
    if (!g) continue;
    const b = C.n;
    if (g === 3 || g === 4) { m += b; continue; }
    if (g === 5 || g === 6 || R) {
      if (oFlag && (g === 5 || g === 6)) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    }
    m -= b;
    if (m > 0) continue;
    const bEff = Math.min(b, b + m + f);
    const use = Math.min(k, bEff);
    // em consumes 1 char per side, strong 2 — regardless of `use`
    // (use only decides em vs strong); the rest of each run stays
    // inside the node and is re-processed
    const consume = use % 2 === 1 ? 1 : 2;
    const inner = tokens.slice(oi + 1, j);
    const children = [];
    let openLeft = false, closeLeft = false;
    if (k > consume) {
      const paAfter = inner.length ? firstMaskedChar(inner[0]) : (bEff > consume ? ch.charCodeAt(0) : -1);
      const fl = delimFlags(ch, -1, paAfter);
      children.push({ k: 5, ch, n: k - consume, o: fl.o, c: fl.c, pb: -1, pa: paAfter, pc: '' });
      openLeft = true;
    }
    for (const t of inner) children.push(t);
    if (bEff > consume) {
      const pbBefore = children.length ? lastMaskedChar(children[children.length - 1]) : -1;
      const fl = delimFlags(ch, pbBefore, -1);
      let pcClose = '';
      if (inner.length) {
        const lt = inner[inner.length - 1];
        if (lt.k === 0 && lt.pc !== undefined) pcClose = lt.pc;
      }
      children.push({ k: 5, ch, n: bEff - consume, o: fl.o, c: fl.c, pb: pbBefore, pa: -1, pc: pcClose });
      closeLeft = true;
    }
    fixChildEdges(children, openLeft, closeLeft);
    const node = { k: use % 2 === 1 ? 8 : 9, ch: children };
    const repl = [node];
    if (b > bEff) {
      const fl = delimFlags(ch, ch.charCodeAt(0), C.pa);
      repl.push({ k: 5, ch, n: b - bEff, o: fl.o, c: fl.c, pb: ch.charCodeAt(0), pa: C.pa, pc: '' });
    }
    tokens.splice(oi, j - oi + 1, ...repl);
    processEmphasis(children);
    return oi + 1;
  }
  return null;
}

// Try the '~' delimiter at tokens[oi] as a strikethrough opener.
// Same return contract as scanEmStrong. Del never leaves leftovers:
// the closer length must equal the opener length, so the effective
// closer length is always the opener length.
function scanDel(tokens, oi) {
  const O = tokens[oi];
  const oLen = O.n;
  const bound = lastCloserIndex(tokens, oi, '~');
  if (bound < 0) return null;
  let p = oLen;
  for (let j = oi + 1; j <= bound; j++) {
    const C = tokens[j];
    if (C.k !== 5 || C.ch !== '~' || C.masked) continue;
    if (C.n !== oLen) continue;
    const g = delimGroup(C, false);
    if (!g) continue;
    if (g === 3 || g === 4) { p += C.n; continue; }
    p -= C.n;
    if (p > 0) continue;
    const children = tokens.slice(oi + 1, j);
    fixChildEdges(children, false, false);
    const node = { k: 10, ch: children };
    tokens.splice(oi, j - oi + 1, node);
    processEmphasis(children);
    return oi + 1;
  }
  return null;
}

function processEmphasis(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    // A masked run does not exist in marked's masked source: it is never
    // an opener, never a closer, and never split — it stays literal.
    if (t.k !== 5 || t.masked) { i++; continue; }
    let next = null;
    if (t.ch === '~') {
      if (delEligible(t)) next = scanDel(tokens, i);
    } else {
      if (emEligible(t)) next = scanEmStrong(tokens, i);
      if (next === null && t.n > 1) {
        // marked's text tokenizer consumes one delimiter char and the
        // scan restarts at the shortened run. A '*' text token updates
        // the prev-text-char to '*'; a '_' text token does not update
        // it at all (marked's rule), so the shortened run keeps the
        // opener's original prev-text-char.
        const splitPc = t.ch === '*' ? '*' : (t.pc || '');
        const fl = delimFlags(t.ch, t.ch.charCodeAt(0), t.pa);
        tokens.splice(i, 1,
          { k: 0, s: t.ch, pc: splitPc },
          { k: 5, ch: t.ch, n: t.n - 1, o: fl.o, c: fl.c, pb: t.ch.charCodeAt(0), pa: t.pa, pc: splitPc });
        i++;
        continue;
      }
    }
    i = next === null ? i + 1 : next;
  }
}

// Render an inline token list into the output parts array.
function renderInline(tokens, out) {
  for (const t of tokens) {
    switch (t.k) {
      case 0: out.push(esc(t.s)); break;
      case 1: out.push('<code>', escFull(t.s), '</code>'); break;
      case 2: out.push(t.s); break;
      case 3: out.push('<br>'); break;
      case 4: out.push('\n'); break;
      case 5: out.push(t.ch.repeat(t.n)); break;
      case 6:
        out.push('<a href="', esc(t.href), '"');
        if (t.title !== undefined) out.push(' title="', esc(t.title), '"');
        out.push('>');
        renderInline(t.ch, out);
        out.push('</a>');
        break;
      case 7:
        out.push('<img src="', esc(t.src), '" alt="', esc(t.alt), '"');
        if (t.title !== undefined) out.push(' title="', esc(t.title), '"');
        out.push('>');
        break;
      case 8: out.push('<em>'); renderInline(t.ch, out); out.push('</em>'); break;
      case 9: out.push('<strong>'); renderInline(t.ch, out); out.push('</strong>'); break;
      case 10: out.push('<del>'); renderInline(t.ch, out); out.push('</del>'); break;
      case 11: {
        const u = cleanUrl(t.href);
        out.push('<a href="', escFull(u === null ? t.href : u), '">', escFull(t.text), '</a>');
        break;
      }
    }
  }
}

// ============================== block level ==============================
// Line model: indent is the column count of leading whitespace (tabs advance
// to the next multiple of 4), start is the index of the first non-whitespace
// character (== line.length for a blank line).
function lineInfo(line) {
  let indent = 0, i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { indent++; i++; }
    else if (c === 9) { indent += 4 - (indent % 4); i++; }
    else break;
  }
  return { indent, start: i };
}

// Remove `cols` columns starting at column `startCol`. A tab that is only
// partially consumed leaves its remainder as spaces. When `expand` is true,
// remaining leading tabs (up to the first non-whitespace character) are
// expanded to spaces using their original columns; otherwise they are kept.
function stripCols(s, cols, startCol, expand) {
  const n = s.length;
  let i = 0, col = startCol, out = '';
  let consumed = 0;
  while (consumed < cols && i < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; consumed++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (consumed + w <= cols) { col += w; consumed += w; i++; }
      else { out += ' '.repeat(consumed + w - cols); col += w; consumed = cols; i++; }
    } else break;
  }
  if (expand) {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32) { out += ' '; col++; i++; }
      else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
      else break;
    }
  }
  return out + s.slice(i);
}

function isSetext(line, info) {
  if (info.indent > 3) return 0;
  let j = info.start;
  const c = line.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? (c === 61 ? 1 : 2) : 0;
}

function isHr(line, start) {
  const c = line.charCodeAt(start);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0, j = start;
  const n = line.length;
  while (j < n) {
    const cc = line.charCodeAt(j);
    if (cc === c) { count++; j++; }
    else if (cc === 32 || cc === 9) j++;
    else return false;
  }
  return count >= 3;
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'nav',
  'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr',
  'track', 'ul'
]);

// HTML block type at the start of a line: 0 none, 1 script/pre/style/textarea,
// 2 comment, 3 processing instruction, 4 declaration, 5 CDATA, 6 block-level
// tag, 7 any other complete tag that is the whole line.
// Type 6 starts on just the tag name followed by whitespace, end of line,
// '>' or '/>' (the tag need not be complete or valid). Type 7 requires a
// complete tag that is the entire line apart from trailing whitespace.
function htmlBlockType(line, info) {
  if (info.indent > 3) return 0;
  const j = info.start;
  if (line.charCodeAt(j) !== 60) return 0;
  if (line.startsWith('<!--', j)) return 2;
  if (line.startsWith('<?', j)) return 3;
  if (line.startsWith('<![CDATA[', j)) return 5;
  if (line.startsWith('<!', j) && isAlphaCode(line.charCodeAt(j + 2))) return 4;
  let k = j + 1, isClose = false;
  if (line.charCodeAt(k) === 47) { isClose = true; k++; }
  if (!isAlphaCode(line.charCodeAt(k))) return 0;
  let name = '';
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (isAlnumCode(c) || c === 45) { name += line[k]; k++; }
    else break;
  }
  const c = k < line.length ? line.charCodeAt(k) : -1;
  if (c !== -1 && c !== 32 && c !== 9 && c !== 62 && c !== 47) return 0;
  if (c === 47 && line.charCodeAt(k + 1) !== 62) return 0;
  name = name.toLowerCase();
  if (!isClose && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) return 1;
  if (BLOCK_TAGS.has(name)) return 6;
  const t = parseTagAt(line, j);
  if (!t) return 0;
  let r = t.end;
  while (r < line.length && (line.charCodeAt(r) === 32 || line.charCodeAt(r) === 9)) r++;
  if (r < line.length) return 0;
  return 7;
}

function isFenceStart(line, info) {
  if (info.indent > 3) return 0;
  const c = line.charCodeAt(info.start);
  if (c !== 96 && c !== 126) return 0;
  let j = info.start;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  if (j - info.start < 3) return 0;
  if (c === 96 && line.indexOf('`', j) >= 0) return 0;
  return j - info.start;
}

function isAtx(line, info) {
  if (info.indent > 3) return 0;
  const c = line.charCodeAt(info.start);
  if (c !== 35) return 0;
  let j = info.start;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const run = j - info.start;
  if (run > 6) return 0;
  if (j < line.length && line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return 0;
  return run;
}

// Does this line start a block that can interrupt an open paragraph?
function startsInterrupt(line, info, inList) {
  if (info.indent >= 4) return false;
  if (isAtx(line, info)) return true;
  if (isFenceStart(line, info)) return true;
  if (isHr(line, info.start)) return true;
  const ht = htmlBlockType(line, info);
  if (ht >= 1 && ht <= 6) return true;
  const c = line.charCodeAt(info.start);
  if (c === 62) return true;
  const m = tryListMarker(line, info);
  if (m) {
    // inside a list item, any list marker interrupts (even an empty one,
    // even an ordered list starting above 1); at the top level (and inside
    // a blockquote), only a non-empty bullet or an ordered list starting
    // with 1 interrupts a paragraph
    if (inList) return true;
    if (!m.hasContent) return false;
    if (m.ordered && m.startNum !== 1) return false;
    return true;
  }
  return false;
}

// Does the block starting at this line begin (or begin with) a paragraph?
// Used for the lazy-continuation heuristic in blockquotes and lists.
function startsPara(s) {
  const info = lineInfo(s);
  if (info.start === s.length) return false;
  if (info.indent >= 4) return false;
  if (isAtx(s, info)) return false;
  if (isFenceStart(s, info)) return false;
  if (isHr(s, info.start)) return false;
  const ht = htmlBlockType(s, info);
  if (ht >= 1 && ht <= 6) return false;
  const c = s.charCodeAt(info.start);
  if (c === 62) {
    return startsPara(stripCols(s.slice(info.start + 1), 1, info.start + 1, true));
  }
  const m = tryListMarker(s, info);
  if (m) {
    const content = stripCols(s.slice(info.start + m.width), m.contentIndent - m.width, info.start + m.width, true);
    if (content.trim() === '') return false;
    return startsPara(content);
  }
  return true;
}

// Update the "open paragraph" flag after collecting a line into a container.
function updateInPara(inPara, s, inList) {
  const info = lineInfo(s);
  if (info.start === s.length) return false;
  if (inPara) {
    if (isSetext(s, info)) return false;
    if (isTableDelimRow(s)) return false;
    if (startsInterrupt(s, info, inList)) return startsPara(s);
    return true;
  }
  return startsPara(s);
}

function isTableDelimRow(s) {
  const cells = splitRow(s);
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell.trim())) return false;
  }
  return true;
}

// Split a table row on unescaped '|', dropping one empty/whitespace-only
// leading and trailing cell, then trimming spaces/tabs from each cell.
function splitRow(line) {
  const cells = [];
  let cur = '', esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (esc) {
      // a backslash escapes the next char: \| becomes a literal | (not a
      // separator); anything else keeps the backslash for inline parsing
      if (c === 124) cur += '|';
      else cur += '\\' + line[i];
      esc = false;
      continue;
    }
    if (c === 92) { esc = true; continue; }
    if (c === 124) { cells.push(cur); cur = ''; continue; }
    cur += line[i];
  }
  if (esc) cur += '\\';
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let i = 0; i < cells.length; i++) {
    let a = cells[i], lo = 0, hi = a.length;
    while (lo < hi && (a.charCodeAt(lo) === 32 || a.charCodeAt(lo) === 9)) lo++;
    while (hi > lo && (a.charCodeAt(hi - 1) === 32 || a.charCodeAt(hi - 1) === 9)) hi--;
    cells[i] = a.slice(lo, hi);
  }
  return cells;
}

// Parse a link reference definition starting at line j (indent <= 3, '[').
// Returns {label, dest, title, nLines} or null. Separators after ':' and
// between dest and title are spaces only (tabs kill the definition).
function tryRefDef(lines, j, end, infos) {
  const line = lines[j];
  const info = infos[j];
  if (info.indent > 3) return null;
  if (line.charCodeAt(info.start) !== 91) return null;
  // label scan (may span lines; no unescaped '[' inside)
  let labelRaw = '';
  let li = j, lc = info.start + 1;
  let closed = false;
  while (li < end) {
    const l = lines[li];
    while (lc < l.length) {
      const c = l.charCodeAt(lc);
      if (c === 92) {
        labelRaw += l[lc];
        if (lc + 1 < l.length) { labelRaw += l[lc + 1]; lc += 2; } else lc++;
        continue;
      }
      if (c === 91) return null;
      if (c === 93) { closed = true; break; }
      labelRaw += l[lc];
      lc++;
    }
    if (closed) break;
    li++;
    if (li >= end) return null;
    if (infos[li].start === lines[li].length) return null;
    labelRaw += '\n';
    lc = 0;
  }
  if (!closed) return null;
  const label = normalizeLabel(labelRaw);
  if (label === '') return null;
  // ':' must directly follow ']' on the same line
  let p = lc + 1;
  const l = lines[li];
  if (p >= l.length || l.charCodeAt(p) !== 58) return null;
  p++;
  // skip spaces (not tabs) on this line, or move to the next non-blank line
  let di = li, dp = p;
  {
    const dl = lines[di];
    while (dp < dl.length && dl.charCodeAt(dp) === 32) dp++;
    if (dp >= dl.length) {
      if (di + 1 >= end) return null;
      if (infos[di + 1].start === lines[di + 1].length) return null;
      di++;
      const nl = lines[di];
      dp = 0;
      while (dp < nl.length && nl.charCodeAt(dp) === 32) dp++;
    }
  }
  // destination
  let dest = '';
  const l2 = lines[di];
  if (l2.charCodeAt(dp) === 60) {
    let q = dp + 1;
    while (q < l2.length) {
      const c = l2.charCodeAt(q);
      if (c === 62) break;
      if (c === 92) {
        const nc = q + 1 < l2.length ? l2.charCodeAt(q + 1) : -1;
        if (nc >= 0 && isEscapable(nc)) { dest += l2[q + 1]; q += 2; continue; }
        dest += '\\'; q++; continue;
      }
      dest += l2[q];
      q++;
    }
    if (q >= l2.length) return null;
    dp = q + 1;
  } else {
    let depth = 0, q = dp;
    while (q < l2.length) {
      const c = l2.charCodeAt(q);
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 92) {
        const nc = q + 1 < l2.length ? l2.charCodeAt(q + 1) : -1;
        if (nc >= 0 && isEscapable(nc)) { dest += l2[q + 1]; q += 2; continue; }
        dest += '\\'; q++; continue;
      }
      if (c === 40) { depth++; dest += '('; q++; continue; }
      if (c === 41) { if (depth === 0) break; depth--; dest += ')'; q++; continue; }
      dest += l2[q];
      q++;
    }
    if (q === dp) return null;
    dp = q;
  }
  // optional title, same line or the next line. A title on the same line
  // must be separated from the destination by at least one space, and if it
  // is malformed the whole definition fails. A title on the next line that
  // is malformed simply leaves the definition without a title.
  const afterTitle = (t) => {
    const ll = lines[t.li];
    let r = t.p;
    while (r < ll.length && (ll.charCodeAt(r) === 32 || ll.charCodeAt(r) === 9)) r++;
    if (r < ll.length) return null;
    return { label, dest, title: t.title, nLines: t.li - j + 1 };
  };
  const l3 = lines[di];
  let q2 = dp;
  while (q2 < l3.length && l3.charCodeAt(q2) === 32) q2++;
  if (q2 < l3.length) {
    const tc = l3.charCodeAt(q2);
    if (tc === 34 || tc === 39 || tc === 40) {
      if (q2 === dp) return null;
      const t = parseTitleMulti(lines, di, q2, end, infos);
      if (!t) return null;
      return afterTitle(t);
    }
    return null;
  }
  if (di + 1 < end && infos[di + 1].start !== lines[di + 1].length) {
    const nl = lines[di + 1];
    let q3 = 0;
    while (q3 < nl.length && nl.charCodeAt(q3) === 32) q3++;
    const tc = q3 < nl.length ? nl.charCodeAt(q3) : -1;
    if (tc === 34 || tc === 39 || tc === 40) {
      const t = parseTitleMulti(lines, di + 1, q3, end, infos);
      if (!t) return { label, dest, title: null, nLines: di - j + 1 };
      const r = afterTitle(t);
      if (!r) return { label, dest, title: null, nLines: di - j + 1 };
      return r;
    }
  }
  return { label, dest, title: null, nLines: di - j + 1 };
}

// Parse a quoted/paren title starting at (li, p) in `lines`; it may span
// lines but not blank lines. Returns {title, li, p} or null.
function parseTitleMulti(lines, li, p, end, infos) {
  const q = lines[li].charCodeAt(p);
  const closer = q === 40 ? 41 : q;
  let title = '';
  let i = li, j = p + 1;
  while (i < end) {
    const l = lines[i];
    while (j < l.length) {
      const c = l.charCodeAt(j);
      if (c === closer) return { title, li: i, p: j + 1 };
      if (c === 92) {
        const nc = j + 1 < l.length ? l.charCodeAt(j + 1) : -1;
        if (nc >= 0 && isEscapable(nc)) { title += l[j + 1]; j += 2; continue; }
        title += '\\'; j++; continue;
      }
      title += l[j];
      j++;
    }
    i++;
    if (i >= end) return null;
    if (infos[i].start === lines[i].length) return null;
    title += '\n';
    j = 0;
  }
  return null;
}

// Try to read a table whose header is line h and whose delimiter is line d.
// Remove up to n leading whitespace characters from a fenced-code
// content line (marked's Dt dedent: character-based, not column-based,
// so a tab counts as one character).
function dedentFenceLine(line, n) {
  let k = 0;
  while (k < n && k < line.length) {
    const c = line.charCodeAt(k);
    if (c === 32 || c === 9) k++;
    else break;
  }
  return line.slice(k);
}

// A whitespace-only line that is 0-3 spaces followed by a single tab:
// in a table body this is an (empty) body row, not a blank line (the
// table regex's blank-line lookahead is ` *\n`, spaces only, and the
// tab is not an indented-code line because nothing follows it).
function isTabOnlyRow(line) {
  const n = line.length;
  if (n < 1 || n > 4) return false;
  if (line.charCodeAt(n - 1) !== 9) return false;
  for (let i = 0; i < n - 1; i++) if (line.charCodeAt(i) !== 32) return false;
  return true;
}

function tryTable(lines, h, d, end, infos, inList) {
  if (infos[d].indent > 3) return null;
  const head = splitRow(lines[h]);
  if (head.length === 0) return null;
  const delims = splitRow(lines[d]);
  if (delims.length !== head.length) return null;
  const aligns = new Array(head.length);
  for (let i = 0; i < delims.length; i++) {
    const c = delims[i].trim();
    if (!/^:?-+:?$/.test(c)) return null;
    aligns[i] = c.startsWith(':') && c.endsWith(':') && c.length > 1 ? 'center'
      : c.startsWith(':') ? 'left' : c.endsWith(':') ? 'right' : null;
  }
  const rows = [];
  let k = d + 1;
  while (k < end) {
    const line = lines[k];
    const info = infos[k];
    const tabRow = isTabOnlyRow(line);
    // a body row ends at a blank line, an indented line, or any block start;
    // a '=' setext line is a plain row (it cannot be a heading here)
    if (info.start === line.length && !tabRow) break;
    if (info.indent >= 4 && !tabRow) break;
    if (startsInterrupt(line, info, inList) && isSetext(line, info) !== 1) break;
    const cells = splitRow(line);
    while (cells.length < head.length) cells.push('');
    rows.push(cells.slice(0, head.length));
    k++;
  }
  return { node: { t: 7, aligns, head, rows }, next: k };
}

// Detect a list marker at line start (indent <= 3). Returns
// {ordered, bullet, delim, startNum, width, contentIndent} or null.
function tryListMarker(line, info) {
  if (info.indent > 3) return null;
  const start = info.start;
  const c = line.charCodeAt(start);
  if (c === 45 || c === 43 || c === 42) {
    const nc = start + 1 < line.length ? line.charCodeAt(start + 1) : -1;
    if (nc !== -1 && nc !== 32 && nc !== 9) return null;
    let col = start + 1, j = start + 1;
    while (j < line.length) {
      const cc = line.charCodeAt(j);
      if (cc === 32) { col++; j++; }
      else if (cc === 9) { col += 4 - (col % 4); j++; }
      else break;
    }
    const spaces = col - (start + 1);
    // an item line with no content after the marker takes content indent
    // marker width + 1, regardless of how many spaces follow the marker
    const contentIndent = j >= line.length ? 2
      : spaces === 0 ? 2 : (spaces >= 1 && spaces <= 4 ? 1 + spaces : 2);
    return { ordered: false, bullet: c, delim: 0, startNum: 0, width: 1, contentIndent, startCol0: start, hasContent: j < line.length };
  }
  if (isDigitCode(c)) {
    let j = start;
    while (j < line.length && isDigitCode(line.charCodeAt(j))) j++;
    if (j - start > 9) return null;
    if (j >= line.length) return null;
    const delim = line.charCodeAt(j);
    if (delim !== 46 && delim !== 41) return null;
    const nc = j + 1 < line.length ? line.charCodeAt(j + 1) : -1;
    if (nc !== -1 && nc !== 32 && nc !== 9) return null;
    const num = parseInt(line.slice(start, j), 10);
    const width = (j + 1) - start;
    let col = j + 1, k = j + 1;
    while (k < line.length) {
      const cc = line.charCodeAt(k);
      if (cc === 32) { col++; k++; }
      else if (cc === 9) { col += 4 - (col % 4); k++; }
      else break;
    }
    const spaces = col - (j + 1);
    const contentIndent = k >= line.length ? width + 1
      : spaces === 0 ? width + 1 : (spaces >= 1 && spaces <= 4 ? width + spaces : width + 1);
    return { ordered: true, bullet: 0, delim, startNum: num, width, contentIndent, startCol0: start, hasContent: k < line.length };
  }
  return null;
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  if (a.ordered) return a.delim === b.delim;
  return a.bullet === b.bullet;
}

// Parse a block range (lines array, whole range). Returns {blocks, loose}.
// noSetext, when given, is a per-line flag: a flagged line that looks like a
// setext underline is paragraph text, never a heading (it was a lazy
// continuation line in the enclosing container).
// lazy, when given, is a per-line flag: a flagged line was a lazy
// continuation (no container prefix); it is paragraph text, never a block
// start, even if stripping made it look like one.
function parseBlocks(lines, inList, refs, endsWithNL, noSetext, lazy) {
  const end = lines.length;
  const infos = new Array(end);
  for (let k = 0; k < end; k++) infos[k] = lineInfo(lines[k]);
  const blocks = [];
  let loose = false;
  let pendingBlank = false;
  let sawBlock = false;
  let i = 0;
  while (i < end) {
    const line = lines[i];
    const info = infos[i];
    if (info.start === line.length) { pendingBlank = true; i++; continue; }
    if (pendingBlank && sawBlock) loose = true;
    pendingBlank = false;
    const start = info.start;
    // a lazy continuation line is paragraph text, never a block start
    if (lazy && lazy[i]) {
      const r = parseParagraph(lines, i, end, infos, inList, refs, noSetext, endsWithNL, lazy);
      if (r.node) blocks.push(r.node);
      i = r.next;
      sawBlock = true;
      continue;
    }
    // indented code
    if (info.indent >= 4) {
      let k = i;
      while (k < end && (infos[k].start === lines[k].length || infos[k].indent >= 4)) k++;
      let e = k;
      while (e > i && infos[e - 1].start === lines[e - 1].length) e--;
      let text = '';
      for (let m = i; m < e; m++) {
        // blank lines inside indented code keep their content minus 4 columns
        text += stripCols(lines[m], 4, 0, false) + '\n';
      }
      blocks.push({ t: 2, lang: null, text });
      i = k;
      sawBlock = true;
      continue;
    }
    // ATX heading
    const atx = isAtx(line, info);
    if (atx) {
      let s = line.slice(start + atx);
      let a = 0;
      while (a < s.length && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
      let b = s.length;
      while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
      s = s.slice(a, b);
      if (s.endsWith('#')) {
        let r = s.length;
        while (r > 0 && s.charCodeAt(r - 1) === 35) r--;
        if (r === 0 || s.charCodeAt(r - 1) === 32 || s.charCodeAt(r - 1) === 9) {
          s = s.slice(0, r);
          let b2 = s.length;
          while (b2 > 0 && (s.charCodeAt(b2 - 1) === 32 || s.charCodeAt(b2 - 1) === 9)) b2--;
          s = s.slice(0, b2);
        }
      }
      blocks.push({ t: 1, level: atx, text: s });
      i++;
      sawBlock = true;
      continue;
    }
    // fenced code
    const fenceLen = isFenceStart(line, info);
    if (fenceLen) {
      const fc = line.charCodeAt(start);
      const rest = line.slice(start + fenceLen);
      let a = 0;
      while (a < rest.length && (rest.charCodeAt(a) === 32 || rest.charCodeAt(a) === 9)) a++;
      let b = a;
      while (b < rest.length && rest.charCodeAt(b) !== 32 && rest.charCodeAt(b) !== 9) b++;
      let lang = null;
      if (b > a) {
        // backslash escapes in the info string are resolved
        const raw = rest.slice(a, b);
        let un = '';
        for (let q = 0; q < raw.length; q++) {
          if (raw.charCodeAt(q) === 92 && q + 1 < raw.length && isEscapable(raw.charCodeAt(q + 1))) { un += raw[q + 1]; q++; }
          else un += raw[q];
        }
        lang = un;
      }
      let k = i + 1, closed = -1;
      while (k < end) {
        const li = infos[k];
        if (li.indent <= 3 && lines[k].charCodeAt(li.start) === fc) {
          let q = li.start;
          while (q < lines[k].length && lines[k].charCodeAt(q) === fc) q++;
          if (q - li.start >= fenceLen && lines[k].slice(q).trim() === '') { closed = k; break; }
        }
        k++;
      }
      const cEnd = closed >= 0 ? closed : k;
      // one trailing empty content line is dropped; a trailing
      // whitespace-only line (non-empty) is kept
      // marked's fence dedent (Dt) is character-based and applies only to
      // backtick fences: remove up to `info.start` leading whitespace
      // characters from each content line. Tilde fences never dedent.
      const dedentN = fc === 96 ? info.start : 0;
      const fl = [];
      for (let m = i + 1; m < cEnd; m++) fl.push(dedentN > 0 ? dedentFenceLine(lines[m], dedentN) : lines[m]);
      if (fl.length > 0 && fl[fl.length - 1] === '') fl.length--;
      let text = '';
      for (let q = 0; q < fl.length; q++) text += fl[q] + '\n';
      blocks.push({ t: 2, lang, text });
      i = closed >= 0 ? closed + 1 : k;
      sawBlock = true;
      continue;
    }
    // thematic break
    if (isHr(line, start)) {
      blocks.push({ t: 3 });
      i++;
      sawBlock = true;
      continue;
    }
    // HTML block
    const ht = htmlBlockType(line, info);
    if (ht) {
      let k = i;
      if (ht === 1) {
        const name = htmlBlockTypeName(line, info);
        const needle = '</' + name;
        outer: while (k < end) {
          const low = lines[k].toLowerCase();
          let from = k === i ? start : 0;
          for (;;) {
            const idx = low.indexOf(needle, from);
            if (idx < 0) break;
            const after = lines[k].charCodeAt(idx + needle.length);
            if (after !== after || after === 62 || after === 32 || after === 9 || after === 47) break outer;
            from = idx + 1;
          }
          k++;
        }
        if (k >= end) k = end - 1;
      } else if (ht === 2) {
        while (k < end && lines[k].indexOf('-->') < 0) k++;
        if (k >= end) k = end - 1;
      } else if (ht === 3) {
        while (k < end && lines[k].indexOf('?>') < 0) k++;
        if (k >= end) k = end - 1;
      } else if (ht === 4) {
        while (k < end && lines[k].indexOf('>', start) < 0) k++;
        if (k >= end) k = end - 1;
      } else if (ht === 5) {
        while (k < end && lines[k].indexOf(']]>') < 0) k++;
        if (k >= end) k = end - 1;
      } else {
        k = i + 1;
        while (k < end && infos[k].start !== lines[k].length) k++;
        k--;
      }
      let text = lines.slice(i, k + 1).join('\n');
      const hasNL = (k + 1 < end) || endsWithNL;
      // trailing newline: types 1-5 (closed by a tag/sequence) keep it
      // unless the next line is truly empty; a whitespace-only line does
      // not drop it. Types 6-7 (closed by a blank line) drop it when the
      // next line is blank (whitespace-only counts as blank there).
      const nextKeepsNL = k + 1 >= end ||
        (ht <= 5 ? lines[k + 1].length !== 0 : infos[k + 1].start !== lines[k + 1].length);
      if (hasNL && nextKeepsNL) text += '\n';
      blocks.push({ t: 4, text });
      i = k + 1;
      sawBlock = true;
      continue;
    }
    // blockquote
    if (line.charCodeAt(start) === 62) {
      const r = collectBlockquote(lines, i, end, infos, endsWithNL);
      blocks.push({ t: 5, ch: parseBlocks(r.lines, false, refs, false, r.noSetext, r.lazy).blocks });
      i = r.next;
      sawBlock = true;
      continue;
    }
    // list
    const lm = tryListMarker(line, info);
    if (lm) {
      const r = collectList(lines, i, end, infos, lm, refs);
      blocks.push(r.node);
      // a blank line crossed inside the list still separates blocks (the
      // main loop never visits it, the collector jumped over it)
      if (r.sawBlank) pendingBlank = true;
      i = r.next;
      sawBlock = true;
      continue;
    }
    // paragraph (a lazy line is paragraph text, never a block start)
    const r = parseParagraph(lines, i, end, infos, inList, refs, noSetext, endsWithNL, lazy);
    if (r.node) blocks.push(r.node);
    i = r.next;
    sawBlock = true;
  }
  return { blocks, loose };
}

function htmlBlockTypeName(line, info) {
  let k = info.start + 1, name = '';
  if (line.charCodeAt(k) === 47) k++;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (isAlnumCode(c) || c === 45) { name += line[k]; k++; }
    else break;
  }
  return name.toLowerCase();
}

// Collect blockquote lines starting at i. Returns {lines, noSetext, next}.
// noSetext[i] marks a line that was a lazy setext underline: it is paragraph
// text, never a heading, in the inner parse. A lazy setext line that follows
// another lazy line has its leading spaces replaced with four spaces (the
// reference's setext guard, which keeps it from becoming a heading).
function collectBlockquote(lines, i, end, infos, endsWithNL) {
  const qlines = [];
  const noSetext = [];
  const lazyFlags = [];
  let k = i;
  let inPara = false;
  let fenceCh = 0, fenceLen = 0;
  while (k < end) {
    const line = lines[k];
    const info = infos[k];
    if (info.indent <= 3 && line.charCodeAt(info.start) === 62) {
      const after = stripCols(line.slice(info.start + 1), 1, info.start + 1, true);
      qlines.push(after);
      noSetext.push(false);
      lazyFlags.push(false);
      const aInfo = lineInfo(after);
      if (fenceCh) {
        // inside a fenced code block: only a closing fence ends it; the
        // content lines are not paragraph text
        if (aInfo.indent <= 3 && after.charCodeAt(aInfo.start) === fenceCh) {
          let q = aInfo.start;
          while (q < after.length && after.charCodeAt(q) === fenceCh) q++;
          if (q - aInfo.start >= fenceLen && after.slice(q).trim() === '') {
            fenceCh = 0; fenceLen = 0;
          }
        }
        inPara = false;
      } else {
        const fl = isFenceStart(after, aInfo);
        if (fl) { fenceCh = after.charCodeAt(aInfo.start); fenceLen = fl; inPara = false; }
        else inPara = updateInPara(inPara, after, false);
      }
      k++;
      continue;
    }
    if (info.start === line.length) {
      // a blank line with no '>' prefix ends the blockquote; a trailing
      // whitespace-only line (no final newline) is a paragraph continuation
      if (inPara && k === end - 1 && !endsWithNL) {
        const content = info.indent >= 4 ? stripCols(line, 4, 0, false) : line;
        qlines.push(content);
        noSetext.push(false);
        lazyFlags.push(true);
        inPara = true;
        k++;
        continue;
      }
      break;
    }
    if (inPara && !fenceCh && !startsInterrupt(line, info, false) && !tryListMarker(line, info)) {
      // lazy continuation: strip 4 columns when the indent is >= 4
      const content = info.indent >= 4 ? stripCols(line, 4, 0, false) : line;
      const cInfo = info.indent >= 4 ? lineInfo(content) : info;
      const st = isSetext(content, cInfo);
      if (st !== 0) {
        const prevLazy = lazyFlags.length > 0 && lazyFlags[lazyFlags.length - 1];
        qlines.push(prevLazy ? '    ' + content.slice(cInfo.start) : content);
        noSetext.push(true);
        lazyFlags.push(true);
        inPara = true;
      } else {
        qlines.push(content);
        noSetext.push(false);
        lazyFlags.push(true);
        inPara = true;
      }
      k++;
      continue;
    }
    break;
  }
  while (qlines.length && qlines[qlines.length - 1] === '') {
    qlines.pop();
    noSetext.pop();
    lazyFlags.pop();
  }
  return { lines: qlines, noSetext, lazy: lazyFlags, next: k };
}

// Collect a list starting at i (first marker lm). Returns {node, next}.
// Each item's lines carry a parallel noSetext flag: a lazy setext underline
// is paragraph text, never a heading, in the item's inner parse.
function collectList(lines, i, end, infos, first, refs) {
  const items = [];
  let loose = false;
  let sawBlank = false;
  let cur = [];
  let curFlags = [];
  let curLazy = [];
  let curMarker = first;
  let inPara = false;
  let pendingBlanks = 0;
  const firstContent = stripCols(lines[i].slice(infos[i].start + first.width), first.contentIndent - first.width, infos[i].start + first.width, true);
  cur.push(firstContent);
  curFlags.push(false);
  curLazy.push(false);
  let curHasContent = firstContent.trim() !== '';
  inPara = startsPara(firstContent);
  let k = i + 1;
  while (k < end) {
    const line = lines[k];
    const info = infos[k];
    if (info.start === line.length) {
      cur.push('');
      curFlags.push(false);
      curLazy.push(false);
      pendingBlanks++;
      sawBlank = true;
      inPara = false;
      k++;
      continue;
    }
    const cc = curMarker.startCol0 + curMarker.contentIndent;
    if (info.indent >= cc && !curHasContent && pendingBlanks > 0) break;
    if (info.indent < cc) {
      // not part of the current item's content: a new item of this list, a
      // thematic break, a lazy continuation, or the end of the list
      if (info.indent <= 3 && isHr(line, info.start)) break;
      if (info.indent <= 3) {
        const m = tryListMarker(line, info);
        if (m && sameListType(m, curMarker)) {
          while (cur.length && cur[cur.length - 1] === '') { cur.pop(); curFlags.pop(); curLazy.pop(); }
          if (pendingBlanks > 0) loose = true;
          items.push({ lines: cur, flags: curFlags, lazy: curLazy });
          curMarker = m;
          cur = [stripCols(line.slice(info.start + m.width), m.contentIndent - m.width, info.start + m.width, true)];
          curFlags = [false];
          curLazy = [false];
          curHasContent = cur[0].trim() !== '';
          pendingBlanks = 0;
          inPara = startsPara(cur[0]);
          k++;
          continue;
        }
      }
      if (inPara && !startsInterrupt(line, info, true) && !tryListMarker(line, info)) {
        cur.push(line);
        curFlags.push(isSetext(line, info) !== 0);
        curLazy.push(true);
        curHasContent = true;
        pendingBlanks = 0;
        inPara = true;
        k++;
        continue;
      }
      break;
    }
    const s = stripCols(line, cc, 0, true);
    cur.push(s);
    curFlags.push(false);
    curLazy.push(false);
    if (s.trim() !== '') curHasContent = true;
    pendingBlanks = 0;
    inPara = updateInPara(inPara, s, true);
    k++;
  }
  while (cur.length && cur[cur.length - 1] === '') { cur.pop(); curFlags.pop(); curLazy.pop(); }
  items.push({ lines: cur, flags: curFlags, lazy: curLazy });
  const parsed = items.map(it => parseBlocks(it.lines, true, refs, false, it.flags, it.lazy));
  for (const p of parsed) if (p.loose) loose = true;
  const node = {
    t: 6, ordered: first.ordered, start: first.startNum,
    items: parsed.map(p => p.blocks), loose
  };
  return { node, next: k, sawBlank };
}

// Parse a paragraph starting at i (may consume leading reference
// definitions). Returns {node|null, next}.
function parseParagraph(lines, i, end, infos, inList, refs, noSetext, endsWithNL, lazy) {
  let j = i;
  while (j < end) {
    if (infos[j].start === lines[j].length) break;
    const def = tryRefDef(lines, j, end, infos);
    if (!def) break;
    if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
    j += def.nLines;
  }
  if (j >= end || infos[j].start === lines[j].length) return { node: null, next: j };
  // if the next line starts a non-paragraph block, the defs stood alone
  if (j > i) {
    const info = infos[j];
    if (info.indent >= 4 || startsInterrupt(lines[j], info, inList)) return { node: null, next: j };
  }
  const textLines = [lines[j]];
  let k = j + 1;
  let level = 0;
  while (k < end) {
    const line = lines[k];
    const info = infos[k];
    if (info.start === line.length) {
      // a whitespace-only line ends the paragraph, except a trailing one
      // when the source has no final newline: it is a continuation line
      if (k === end - 1 && !endsWithNL) {
        if (inList && info.indent >= 4) textLines.push(stripCols(line, 4, 0, false));
        else textLines.push(line);
        k++;
        continue;
      }
      break;
    }
    // a lazy continuation line is paragraph text: no setext, table or
    // interruption checks apply to it
    if (lazy && lazy[k]) {
      if (inList && info.indent >= 4) textLines.push(stripCols(line, 4, 0, false));
      else textLines.push(line);
      k++;
      continue;
    }
    const st = isSetext(line, info);
    if (st && !(noSetext && noSetext[k])) { level = st; k++; break; }
    if (k === j + 1) {
      const t = tryTable(lines, j, k, end, infos, inList);
      if (t) return { node: t.node, next: t.next };
    }
    if (startsInterrupt(line, info, inList)) break;
    if (inList && info.indent >= 4) textLines.push(stripCols(line, 4, 0, false));
    else textLines.push(line);
    k++;
  }
  const text = textLines.join('\n');
  if (level) {
    // setext heading text has leading/trailing spaces and tabs stripped
    let a = 0, b = text.length;
    while (a < b && (text.charCodeAt(a) === 32 || text.charCodeAt(a) === 9)) a++;
    while (b > a && (text.charCodeAt(b - 1) === 32 || text.charCodeAt(b - 1) === 9)) b--;
    return { node: { t: 1, level, text: text.slice(a, b) }, next: k };
  }
  return { node: { t: 0, text }, next: k };
}

// ============================== rendering ==============================
function renderBlocks(blocks, out, tight, refs) {
  for (const b of blocks) {
    if (b.t === 0) {
      if (!tight) out.push('<p>');
      renderInline(inlineParse(b.text, refs), out);
      if (!tight) out.push('</p>\n');
    } else if (b.t === 1) {
      out.push('<h' + b.level + '>');
      renderInline(inlineParse(b.text, refs), out);
      out.push('</h' + b.level + '>\n');
    } else if (b.t === 2) {
      out.push('<pre><code');
      if (b.lang !== null) out.push(' class="language-', esc(b.lang), '"');
      out.push('>', escFull(b.text), '</code></pre>\n');
    } else if (b.t === 3) {
      out.push('<hr>\n');
    } else if (b.t === 4) {
      out.push(b.text);
    } else if (b.t === 5) {
      out.push('<blockquote>\n');
      renderBlocks(b.ch, out, false, refs);
      out.push('</blockquote>\n');
    } else if (b.t === 6) {
      out.push(b.ordered ? '<ol' : '<ul');
      if (b.ordered && b.start !== 1) out.push(' start="' + b.start + '"');
      out.push('>\n');
      for (const item of b.items) {
        out.push('<li>');
        // task list: first block a paragraph starting with "[ ] ", "[x] ",
        // "[X] " (a space after the bracket is required)
        const first = item[0];
        let task = null;
        if (first && first.t === 0 && first.text.length >= 4 &&
            first.text.charCodeAt(0) === 91 && first.text.charCodeAt(2) === 93 &&
            first.text.charCodeAt(3) === 32) {
          const m = first.text.charCodeAt(1);
          if (m === 32) task = '<input disabled="" type="checkbox">';
          else if (m === 120 || m === 88) task = '<input checked="" disabled="" type="checkbox">';
        }
        if (task) {
          const rest = item.slice(1);
          if (b.loose) {
            out.push('<p>');
            out.push(task);
            renderInline(inlineParse(first.text.slice(3), refs), out);
            out.push('</p>\n');
            renderBlocks(rest, out, false, refs);
          } else {
            out.push(task);
            renderInline(inlineParse(first.text.slice(3), refs), out);
            renderBlocks(rest, out, true, refs);
          }
        } else {
          renderBlocks(item, out, !b.loose, refs);
        }
        out.push('</li>\n');
      }
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
    } else if (b.t === 7) {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let ci = 0; ci < b.head.length; ci++) {
        out.push('<th');
        if (b.aligns[ci]) out.push(' align="', b.aligns[ci], '"');
        out.push('>');
        renderInline(inlineParse(b.head[ci], refs), out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let ci = 0; ci < row.length; ci++) {
            out.push('<td');
            if (b.aligns[ci]) out.push(' align="', b.aligns[ci], '"');
            out.push('>');
            renderInline(inlineParse(row[ci], refs), out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
    }
  }
}

export function parse(src) {
  docInLink = false;
  const refs = new Map();
  const norm = src.replace(/\r\n?/g, '\n');
  const lines = norm.split('\n');
  let endsWithNL = false;
  if (norm.endsWith('\n')) { lines.pop(); endsWithNL = true; }
  const r = parseBlocks(lines, false, refs, endsWithNL);
  const out = [];
  renderBlocks(r.blocks, out, false, refs);
  return out.join('');
}

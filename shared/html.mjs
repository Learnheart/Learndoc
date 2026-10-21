// Minimal HTML tokenizer for the whitelisted lesson HTML subset, plus entity and escape helpers.
// Isomorphic: no node: imports, no DOM access.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', times: '×', minus: '−',
  larr: '←', rarr: '→', harr: '↔', le: '≤', ge: '≥', ne: '≠', deg: '°',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  thinsp: '\u2009', ensp: '\u2002', emsp: '\u2003', copy: '©',
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

// Reads one entity at `index` (which must point at '&').
// -> { value, length } for a known entity, { value: null, length } for an unknown name, or null.
export function readEntity(str, index) {
  ENTITY.lastIndex = index;
  const match = ENTITY.exec(str);
  if (!match) return null;
  const [raw, dec, hex, name] = match;
  if (name) {
    return { value: Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : null, length: raw.length };
  }
  const code = dec ? Number(dec) : parseInt(hex, 16);
  const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
  return { value: valid ? String.fromCodePoint(code) : null, length: raw.length };
}

export function decodeEntities(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '&') {
      const entity = readEntity(str, i);
      if (entity?.value != null) {
        out += entity.value;
        i += entity.length - 1;
        continue;
      }
    }
    out += str[i];
  }
  return out;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

export function escapeAttr(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const ATTR_NAME = /[^\s"'<>\/=]+/y;
const SPACE = /\s*/y;

function readAt(regex, str, index) {
  regex.lastIndex = index;
  const match = regex.exec(str);
  return match ? match[0] : null;
}

// Parses a start or end tag at `start` (pointing at '<'); returns a token or null when malformed.
function readTag(str, start) {
  let i = start + 1;
  const closing = str[i] === '/';
  if (closing) i += 1;
  const name = readAt(TAG_NAME, str, i);
  if (!name) return null;
  i += name.length;
  const attrs = [];
  for (;;) {
    const space = readAt(SPACE, str, i);
    i += space.length;
    if (str[i] === '>') {
      return { type: closing ? 'close' : 'open', name, attrs, selfClosing: false, start, end: i + 1 };
    }
    if (str.startsWith('/>', i) && !closing) {
      return { type: 'open', name, attrs, selfClosing: true, start, end: i + 2 };
    }
    if (closing || !space.length) return null;
    const attrStart = i;
    const attrName = readAt(ATTR_NAME, str, i);
    if (!attrName) return null;
    i += attrName.length;
    let value = null;
    if (str[i] === '=') {
      const quote = str[i + 1];
      if (quote !== '"' && quote !== "'") return null;
      const close = str.indexOf(quote, i + 2);
      if (close < 0) return null;
      value = decodeEntities(str.slice(i + 2, close));
      i = close + 1;
    }
    attrs.push({ name: attrName, value, start: attrStart, end: i });
  }
}

// Splits `str` into tokens covering it end to end:
//   { type: 'text', start, end }
//   { type: 'open', name, attrs: [{ name, value, start, end }], selfClosing, start, end }
//   { type: 'close', name, start, end }
//   { type: 'error', start, end, message }   (a '<' that does not start a well-formed tag, a comment, …)
// Attribute values are entity-decoded; quoted values are required.
export function tokenize(str) {
  const tokens = [];
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', start: textStart, end });
  };
  for (let i = str.indexOf('<'); i >= 0; i = str.indexOf('<', i)) {
    const tag = readTag(str, i);
    flushText(i);
    if (tag) {
      tokens.push(tag);
      i = tag.end;
    } else {
      const message = str.startsWith('<!--', i)
        ? 'HTML comments are not allowed'
        : "literal '<' must be written as &lt; (or \\lt inside math)";
      tokens.push({ type: 'error', start: i, end: i + 1, message });
      i += 1;
    }
    textStart = i;
  }
  flushText(str.length);
  return tokens;
}

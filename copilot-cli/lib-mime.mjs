// Turning a raw RFC 5322 message into something worth putting in a prompt.
//
// This is not a general MIME library and does not try to be. It handles what
// real mail actually arrives as — folded headers, encoded-word subjects,
// multipart/alternative with a text and an HTML twin, quoted-printable and
// base64 bodies, a handful of charsets — and gives up legibly on anything
// else rather than throwing.
//
// Zero dependencies, like the rest of the project, because the machine this
// runs on may not be allowed to install any.

/** Undo header line folding: a continuation line begins with space or tab. */
function unfold(head) {
  return head.replace(/\r?\n[ \t]+/g, ' ');
}

/** Split a header block into an ordered list of [name, value]. */
export function parseHeaders(head) {
  const out = [];
  for (const line of unfold(head).split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    out.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return out;
}

export function headerValue(headers, name) {
  const hit = headers.find(([k]) => k === name);
  return hit ? hit[1] : '';
}

/**
 * Decode bytes in whatever charset the message claimed.
 *
 * Node can decode a long tail of legacy encodings through TextDecoder, so the
 * named charset is tried first and only then fallen back on — getting this
 * wrong turns a French subject line into mojibake, which is exactly the sort
 * of thing that makes a digest untrustworthy.
 */
export function decodeBytes(buf, charset) {
  const name = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try {
    return new TextDecoder(name, { fatal: false }).decode(buf);
  } catch {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch { return buf.toString('latin1'); }
  }
}

/** Quoted-printable, per RFC 2045: =XX escapes and soft line breaks. */
export function decodeQuotedPrintable(text) {
  const withoutSoftBreaks = String(text).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const c = withoutSoftBreaks[i];
    if (c === '=' && /^[0-9a-f]{2}$/i.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
      bytes.push(parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** A body part's bytes, after undoing its transfer encoding. */
export function decodeTransfer(text, encoding) {
  const enc = (encoding || '7bit').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(String(text).replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(text);
  return Buffer.from(String(text), 'latin1');
}

/**
 * RFC 2047 encoded-words, which is how a non-ASCII Subject arrives:
 *   =?utf-8?B?SGVsbG8=?=  or  =?iso-8859-1?Q?Caf=E9?=
 * Adjacent encoded words are joined without the whitespace between them.
 */
export function decodeWords(value) {
  if (!value || !value.includes('=?')) return value || '';
  return String(value)
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)(\s+)(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, kind, text) => {
      try {
        const bytes = kind.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : decodeQuotedPrintable(text.replace(/_/g, ' '));
        return decodeBytes(bytes, charset);
      } catch {
        return whole;
      }
    });
}

/** Pull a parameter such as charset= or boundary= out of a structured header. */
export function param(value, name) {
  const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(value || '');
  if (quoted) return quoted[1];
  const bare = new RegExp(`${name}\\s*=\\s*([^;\\s]+)`, 'i').exec(value || '');
  return bare ? bare[1] : '';
}

/** A crude but predictable HTML to text pass, for mail with no plain part. */
export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split a raw message into its header block and its body. */
function splitMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const at = text.search(/\r?\n\r?\n/);
  if (at < 0) return { head: text, body: '' };
  const gap = /^\r\n\r\n/.test(text.slice(at)) ? 4 : 2;
  return { head: text.slice(0, at), body: text.slice(at + gap) };
}

/**
 * Walk a message and return the best text we can find, preferring a
 * text/plain part over its HTML twin the way a mail client would.
 *
 * `depth` is bounded: a malformed message can otherwise nest boundaries
 * forever, and a mail reader that hangs is worse than one that gives up.
 */
function bestText(head, body, depth = 0) {
  const headers = parseHeaders(head);
  const type = headerValue(headers, 'content-type') || 'text/plain';
  const encoding = headerValue(headers, 'content-transfer-encoding');
  const disposition = headerValue(headers, 'content-disposition');
  const mime = type.split(';')[0].trim().toLowerCase();

  if (mime.startsWith('multipart/') && depth < 8) {
    const boundary = param(type, 'boundary');
    if (!boundary) return '';
    const chunks = body.split(new RegExp(`\r?\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?\r?\n?`));
    const parts = [];
    for (const chunk of chunks.slice(1)) {
      if (!chunk || chunk === '--') continue;
      const inner = splitMessage(chunk);
      const text = bestText(inner.head, inner.body, depth + 1);
      if (text) {
        const innerType = (headerValue(parseHeaders(inner.head), 'content-type') || 'text/plain')
          .split(';')[0].trim().toLowerCase();
        parts.push({ innerType, text });
      }
    }
    if (!parts.length) return '';
    // alternative: the parts are the same message twice, so take the best one.
    if (mime === 'multipart/alternative') {
      const plain = parts.find((p) => p.innerType === 'text/plain');
      return (plain || parts[parts.length - 1]).text;
    }
    // mixed/related: the parts are different things, so keep them all.
    return parts.map((p) => p.text).join('\n\n').trim();
  }

  // An attachment is named rather than read. Its bytes are not text and we
  // are not downloading them anyway.
  if (/attachment/i.test(disposition) && !mime.startsWith('text/')) {
    const name = decodeWords(param(disposition, 'filename') || param(type, 'name')) || '(unnamed)';
    return `[attachment: ${name}, ${mime}]`;
  }

  if (mime === 'text/plain' || mime === 'text/html' || mime === '') {
    const bytes = decodeTransfer(body, encoding);
    const text = decodeBytes(bytes, param(type, 'charset'));
    return mime === 'text/html' ? htmlToText(text) : text.trim();
  }

  return `[${mime} part, not shown]`;
}

/**
 * Parse one raw message into the fields a digest needs.
 *
 * `truncated` says the raw text was cut short by a partial fetch, which
 * matters: a body that simply ends is otherwise indistinguishable from a
 * short one, and a summary built on half a message should say so.
 */
export function parseMessage(raw, { truncated = false } = {}) {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const get = (n) => decodeWords(headerValue(headers, n));
  let text = '';
  try {
    text = bestText(head, body);
  } catch (e) {
    text = `[could not parse this message: ${e.message}]`;
  }
  return {
    from: get('from'),
    to: get('to'),
    cc: get('cc'),
    subject: get('subject'),
    date: headerValue(headers, 'date'),
    messageId: headerValue(headers, 'message-id'),
    listId: get('list-id'),
    text: text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    truncated,
  };
}

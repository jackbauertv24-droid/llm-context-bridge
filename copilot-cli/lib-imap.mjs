// A deliberately read-only IMAP client.
//
// The requirement this was built for is not "read mail", it is "read mail and
// change nothing" — in particular, do not mark anything as read. Mail arriving
// already-read because a tool glanced at it is the kind of damage that is
// noticed days later and cannot be undone, so the restriction is enforced in
// four independent ways rather than trusted to care:
//
//   1. The mailbox is opened with EXAMINE, never SELECT. EXAMINE is the
//      read-only open: an RFC 3501 server rejects any attempt to change state
//      through that session, so even a bug here cannot write.
//   2. The server's own answer is checked. If EXAMINE does not come back
//      marked [READ-ONLY], the session is abandoned rather than continued.
//   3. Bodies are fetched with BODY.PEEK[], never BODY[]. Plain BODY[] sets
//      the \Seen flag as a side effect — this is the single mistake that
//      would silently mark an inbox read, and it is why the fetch spec is
//      built in one place and never taken from the caller.
//   4. Every command passes a deny list. Anything that could mutate — STORE,
//      APPEND, COPY, MOVE, EXPUNGE, CREATE, DELETE, RENAME, SELECT and the
//      rest — throws before a byte reaches the socket.
//
// Zero dependencies: node:tls and node:net only.

import tls from 'node:tls';
import net from 'node:net';

export class MailError extends Error {}

// Commands that can change anything on the server. SELECT is here because its
// only difference from EXAMINE is that it opens read-write.
const FORBIDDEN = [
  'SELECT', 'STORE', 'APPEND', 'COPY', 'MOVE', 'EXPUNGE', 'CREATE', 'DELETE',
  'RENAME', 'SUBSCRIBE', 'UNSUBSCRIBE', 'SETACL', 'DELETEACL', 'SETQUOTA',
  'SETMETADATA', 'UID STORE', 'UID COPY', 'UID MOVE', 'UID EXPUNGE',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The date format IMAP SEARCH wants: 01-Jan-2026. */
export function imapDate(d) {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** IMAP quoted string, with the two characters that must be escaped. */
function quoted(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class ImapReader {
  constructor(opts) {
    this.opts = opts;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.tag = 0;
    this.closed = false;
    this.capabilities = [];
    // Every command sent, so a caller (or a test) can prove nothing mutating
    // was ever issued.
    this.log = [];
  }

  // ------------------------------------------------------------ plumbing

  connect() {
    const { host, port = 993, useTls = true, timeoutMs = 30000 } = this.opts;
    return new Promise((resolve, reject) => {
      const onFail = (e) => reject(new MailError(`cannot reach ${host}:${port} — ${e.message}`));
      const socket = useTls
        ? tls.connect({ host, port, servername: host }, () => resolve(this.#ready()))
        : net.connect({ host, port }, () => resolve(this.#ready()));
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => socket.destroy(new MailError(`${host}:${port} stopped responding`)));
      socket.on('error', onFail);
      socket.on('close', () => { this.closed = true; this.#flushWaiters(new MailError('the server closed the connection')); });
      socket.on('data', (chunk) => { this.buf = Buffer.concat([this.buf, chunk]); this.#pump(); });
      this.sock = socket;
    });
  }

  async #ready() {
    const greeting = await this.#logicalLine();
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting.text)) {
      throw new MailError(`the server did not greet us: ${greeting.text.slice(0, 120)}`);
    }
    return greeting.text;
  }

  #flushWaiters(err) {
    const waiting = this.waiters.splice(0);
    for (const w of waiting) w.reject(err);
  }

  // Hand buffered bytes to whoever is waiting: either a line or a byte count.
  #pump() {
    for (;;) {
      const w = this.waiters[0];
      if (!w) return;
      if (w.bytes !== undefined) {
        if (this.buf.length < w.bytes) return;
        const out = this.buf.subarray(0, w.bytes);
        this.buf = this.buf.subarray(w.bytes);
        this.waiters.shift();
        w.resolve(out);
        continue;
      }
      const at = this.buf.indexOf('\r\n');
      if (at < 0) return;
      const line = this.buf.subarray(0, at).toString('latin1');
      this.buf = this.buf.subarray(at + 2);
      this.waiters.shift();
      w.resolve(line);
    }
  }

  #want(spec) {
    if (this.closed) return Promise.reject(new MailError('the connection is closed'));
    return new Promise((resolve, reject) => { this.waiters.push({ ...spec, resolve, reject }); this.#pump(); });
  }

  #line() { return this.#want({}); }
  #bytes(n) { return this.#want({ bytes: n }); }

  /**
   * One logical response line, following IMAP literals.
   *
   * A literal is announced as {N} at the end of a line; exactly N bytes then
   * follow, and the rest of the line resumes after them. Reading this
   * correctly is the whole difficulty of speaking IMAP by hand — a reader
   * that assumes one response is one line will corrupt any message
   * containing a CRLF, which is all of them.
   */
  async #logicalLine() {
    let text = '';
    const literals = [];
    for (;;) {
      const line = await this.#line();
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (!m) return { text: text + line, literals };
      text += line;
      literals.push(await this.#bytes(Number(m[1])));
    }
  }

  /** Send a tagged command and collect every untagged response to it. */
  async send(command, { continuation = null } = {}) {
    const bare = command.toUpperCase();
    for (const banned of FORBIDDEN) {
      if (bare === banned || bare.startsWith(banned + ' ')) {
        throw new MailError(`refusing to send "${banned}": this client is read-only`);
      }
    }
    const tag = `A${String(++this.tag).padStart(4, '0')}`;
    this.log.push(command);
    this.sock.write(`${tag} ${command}\r\n`);

    const untagged = [];
    for (;;) {
      const res = await this.#logicalLine();
      if (res.text.startsWith('+ ')) {
        if (continuation === null) throw new MailError(`server asked for more input unexpectedly: ${res.text}`);
        this.sock.write(`${continuation}\r\n`);
        continuation = null;
        continue;
      }
      if (res.text.startsWith(`${tag} `)) {
        const status = res.text.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new MailError(status.replace(/^(NO|BAD)\s*/i, '').trim() || status);
        return { status, untagged };
      }
      untagged.push(res);
    }
  }

  // ------------------------------------------------------------ session

  async login() {
    const { user, pass, oauthToken } = this.opts;
    try {
      const caps = await this.send('CAPABILITY');
      this.capabilities = (caps.untagged.find((u) => /^\* CAPABILITY/i.test(u.text))?.text || '')
        .replace(/^\* CAPABILITY\s*/i, '').split(/\s+/);
    } catch { /* not fatal; some servers answer it only after login */ }

    if (oauthToken) {
      // SASL XOAUTH2: the initial response is sent at the continuation.
      const payload = Buffer.from(`user=${user}\x01auth=Bearer ${oauthToken}\x01\x01`).toString('base64');
      await this.send('AUTHENTICATE XOAUTH2', { continuation: payload });
      return;
    }
    if (!pass) throw new MailError('no MAIL_PASS and no MAIL_OAUTH_TOKEN — nothing to authenticate with');
    if (this.capabilities.includes('LOGINDISABLED')) {
      throw new MailError(
        'the server advertises LOGINDISABLED, so password login is off. '
        + 'Microsoft 365 turned basic IMAP auth off by default in 2023; you need MAIL_OAUTH_TOKEN.',
      );
    }
    await this.send(`LOGIN ${quoted(user)} ${quoted(pass)}`);
  }

  /** Folder names, as the server spells them. */
  async folders() {
    const res = await this.send('LIST "" "*"');
    const names = [];
    for (const u of res.untagged) {
      const m = /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i.exec(u.text);
      if (!m) continue;
      if (/\\Noselect/i.test(m[1])) continue;
      let name = m[2].trim();
      if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\"/g, '"');
      else if (/\{\d+\}$/.test(name) && u.literals.length) name = u.literals[u.literals.length - 1].toString('utf8');
      names.push(name);
    }
    return names;
  }

  /**
   * Open a mailbox read-only.
   *
   * EXAMINE is the read-only open. The server's confirmation is checked too:
   * if it does not say [READ-ONLY] we are not in the state we asked for, and
   * continuing would risk the very thing this client exists to avoid.
   */
  async examine(folder) {
    const res = await this.send(`EXAMINE ${quoted(folder)}`);
    if (!/\[READ-ONLY\]/i.test(res.status)) {
      throw new MailError(
        `the server did not confirm a read-only open of ${folder} (said: ${res.status.trim()}); `
        + 'refusing to continue, because reading could mark messages as seen',
      );
    }
    const exists = /^\* (\d+) EXISTS/im.exec(res.untagged.map((u) => u.text).join('\n'));
    return { exists: exists ? Number(exists[1]) : 0 };
  }

  /** UIDs matching the criteria, oldest first as the server returns them. */
  async search(criteria) {
    const res = await this.send(`UID SEARCH ${criteria}`);
    const line = res.untagged.find((u) => /^\* SEARCH/i.test(u.text));
    if (!line) return [];
    return line.text.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
  }

  /**
   * Fetch one message without marking it read.
   *
   * BODY.PEEK[] is the whole point: plain BODY[] would set \Seen. The
   * partial form <0.N> also bounds what a single enormous message with
   * attachments can pull down.
   */
  async fetchMessage(uid, maxBytes) {
    const res = await this.send(`UID FETCH ${uid} (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${maxBytes}>)`);
    const hit = res.untagged.find((u) => /FETCH/i.test(u.text) && u.literals.length);
    if (!hit) return null;
    const size = /RFC822\.SIZE (\d+)/i.exec(hit.text);
    const when = /INTERNALDATE "([^"]+)"/i.exec(hit.text);
    const raw = hit.literals[hit.literals.length - 1];
    return {
      uid,
      size: size ? Number(size[1]) : raw.length,
      internalDate: when ? when[1] : '',
      raw,
      truncated: !!(size && Number(size[1]) > raw.length),
    };
  }

  async logout() {
    try { await this.send('LOGOUT'); } catch { /* going away regardless */ }
    try { this.sock.end(); } catch { /* already gone */ }
    this.closed = true;
  }
}

// A deliberately read-only Exchange Web Services client.
//
// This is the access method that is known to work on the target network: the
// firm's own sf-processor talks to an on-premises Exchange 2010 SP2 at an
// /EWS/Exchange.asmx endpoint with username-and-password credentials. There
// is no IMAP, no Graph and no OAuth in that environment, so there is none
// here either.
//
// What is NOT carried over from that system is just as important. It reads
// unread mail as a work queue and marks each message read when it is done
// with it, and it sends mail. This client does neither, and cannot:
//
//   1. Only three SOAP operations are ever built — FindFolder, FindItem and
//      GetItem. All three are reads.
//   2. Every request passes a deny list before it is sent. UpdateItem,
//      CreateItem, SendItem, DeleteItem, MoveItem, CopyItem,
//      MarkAllItemsAsRead and the rest throw rather than go out, so no future
//      edit can quietly add a write path.
//   3. The read flag is never touched. In EWS a message becomes read only
//      through an explicit UpdateItem setting message:IsRead — fetching an
//      item does not change it — and UpdateItem is on the deny list. IsRead
//      is requested as a property to *report*, never as one to set.
//
// Zero dependencies: node:https and a small amount of XML by hand. The
// responses this parses are machine-generated and narrow, which is what makes
// that defensible.

import https from 'node:https';
import http from 'node:http';
import { createType1Message, parseType2Message, createType3Message, splitUser } from './lib-ntlm.mjs';

export class EwsError extends Error {}

const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  t: 'http://schemas.microsoft.com/exchange/services/2006/types',
  m: 'http://schemas.microsoft.com/exchange/services/2006/messages',
};

// The only operations this client is allowed to perform.
const READ_OPERATIONS = new Set(['FindFolder', 'FindItem', 'GetItem']);

// Named so that an attempt to add one produces an obvious error rather than a
// silent mutation.
const FORBIDDEN_OPERATIONS = [
  'UpdateItem', 'CreateItem', 'SendItem', 'DeleteItem', 'MoveItem', 'CopyItem',
  'MarkAllItemsAsRead', 'CreateFolder', 'UpdateFolder', 'DeleteFolder',
  'EmptyFolder', 'CreateAttachment', 'DeleteAttachment', 'ArchiveItem',
  'MarkAsJunk', 'UpdateInboxRules', 'SetUserOofSettings', 'Subscribe',
];

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const unesc = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

/**
 * Every <tag ...>inner</tag> block, as raw strings including the open tag.
 *
 * The attribute group is lazy. Greedy, it swallows the slash of a
 * self-closing tag — <t:ItemId Id="..." ChangeKey="..."/> then looks like a
 * container, the close tag is never found, and every message in the response
 * is silently dropped. That bug produced an empty inbox from a mailbox with
 * thousands of messages in it.
 */
function blocks(xml, local) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${local}\\b([^>]*?)\\s*(/)?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) { out.push({ attrs: m[1], inner: '' }); continue; }
    const closeRe = new RegExp(`</(?:\\w+:)?${local}>`, 'g');
    closeRe.lastIndex = re.lastIndex;
    // Nested tags of the same name do not occur in these responses, so the
    // first close is the right one.
    const close = closeRe.exec(xml);
    // An unterminated tag is skipped rather than ending the scan: one
    // malformed element should not hide every element after it.
    if (!close) continue;
    out.push({ attrs: m[1], inner: xml.slice(re.lastIndex, close.index) });
    re.lastIndex = close.index;
  }
  return out;
}

/** The text of the first <tag>…</tag>, entities resolved. */
function text(xml, local) {
  const found = blocks(xml, local)[0];
  return found ? unesc(found.inner.replace(/<[^>]*>/g, '')) : '';
}

function attr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs || '');
  return m ? unesc(m[1]) : '';
}

/** Exchange wants an ISO instant with no fractional part. */
export function ewsDate(d) {
  return `${d.toISOString().replace(/\.\d+Z$/, 'Z')}`;
}

// Certificate problems are not connectivity problems, and saying "cannot
// reach" for one sends the reader off checking firewalls. An internal
// certificate authority is the normal case for an on-premises Exchange, so
// the error says which it is and what to do about it.
const TRUST_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED',
]);

export function describeConnectionError(e, url) {
  const code = e.code || '';
  if (TRUST_CODES.has(code)) {
    return new EwsError(
      `${url.host} presented a certificate this machine does not trust (${code}). `
      + 'That is normal for an internal Exchange with a company certificate authority, '
      + 'and it is a trust problem, not a connection problem — the server answered fine. '
      + 'Fix it in one of three ways, best first: run node with --use-system-ca so it '
      + 'uses the Windows certificate store; or export your company root CA to a .pem '
      + 'and set NODE_EXTRA_CA_CERTS to it; or, as a last resort, set '
      + 'MAIL_TLS_INSECURE=1 in mail.env, which stops the certificate being checked '
      + 'at all and should not be left on.',
    );
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return new EwsError(
      `${url.host} presented a certificate issued to a different name (${e.message}). `
      + 'Use the host the certificate is actually for in MAIL_EWS_URL.',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new EwsError(`${url.host} does not resolve from this machine — check the name, or the VPN.`);
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
    return new EwsError(`cannot reach ${url.host} (${code}) — check the VPN or a firewall.`);
  }
  return new EwsError(`cannot reach ${url.host} — ${e.message}`);
}

/** The authentication schemes a 401 says it will accept. */
function offeredSchemes(headers) {
  const raw = headers['www-authenticate'];
  const all = Array.isArray(raw) ? raw : [raw || ''];
  return all.join(', ').split(',').map((s) => s.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean);
}

export class EwsReader {
  constructor(opts) {
    this.opts = opts;
    this.log = [];
    // auto: try Basic, and switch to NTLM if the server will not take it.
    this.authMode = (opts.authMode || 'auto').toLowerCase();
    this.agent = null;
  }

  /**
   * One keep-alive socket for the whole session.
   *
   * NTLM authenticates a *connection*, not a request: the challenge and the
   * response have to travel over the same TCP socket, so the agent is pinned
   * to a single one and reused for every later call.
   */
  #keepAliveAgent(isHttps) {
    if (!this.agent) {
      const Agent = isHttps ? https.Agent : http.Agent;
      this.agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    }
    return this.agent;
  }

  /** A single HTTP request. Returns status, headers and body; throws only on transport failure. */
  #post(url, headers, body) {
    const isHttps = url.protocol === 'https:';
    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        agent: this.#keepAliveAgent(isHttps),
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'text/xml',
          Connection: 'keep-alive',
          'User-Agent': 'copilot-cli-mail/1.0',
          ...headers,
        },
        rejectUnauthorized: this.opts.insecureTls !== true,
        timeout: this.opts.timeoutMs || 30000,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        // The body must be drained even when it is not wanted, or the socket
        // is never released back to the agent and the next leg opens a new
        // connection — which loses the NTLM handshake.
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new EwsError(`${url.host} stopped responding`)));
      req.on('error', (e) => reject(describeConnectionError(e, url)));
      req.end(body);
    });
  }

  /** The three-leg NTLM handshake, then the real request on the same socket. */
  async #ntlmPost(url, envelope) {
    const { domain: fromUser, user } = splitUser(this.opts.user);
    const domain = this.opts.domain || fromUser || '';

    const negotiate = await this.#post(url, {
      Authorization: `NTLM ${createType1Message().toString('base64')}`,
    }, '');

    if (negotiate.status !== 401) {
      // Some servers accept the negotiate outright; nothing more to do.
      if (negotiate.status === 200) return negotiate;
      return negotiate;
    }
    const raw = negotiate.headers['www-authenticate'];
    const all = Array.isArray(raw) ? raw : [raw || ''];
    const challenge = all.map((h) => /^NTLM\s+(.+)$/i.exec(String(h).trim())).find(Boolean);
    if (!challenge) {
      throw new EwsError(
        'the server offered NTLM but did not send a challenge. '
        + (all.join(', ').toLowerCase().includes('negotiate')
          ? 'It may be insisting on Kerberos, which this client does not speak.'
          : `It answered: ${all.join(', ') || '(nothing)'}`),
      );
    }
    const type2 = parseType2Message(challenge[1]);
    const type3 = createType3Message({ user, domain, password: this.opts.pass, type2 });
    return this.#post(url, { Authorization: `NTLM ${type3.toString('base64')}` }, envelope);
  }

  /** Send the envelope, choosing or discovering the authentication scheme. */
  async #authorizedPost(url, envelope) {
    if (this.authMode === 'ntlm') return this.#ntlmPost(url, envelope);

    const basic = `Basic ${Buffer.from(`${this.opts.user}:${this.opts.pass}`).toString('base64')}`;
    const res = await this.#post(url, { Authorization: basic }, envelope);
    if (res.status === 401 && this.authMode === 'auto') {
      const schemes = offeredSchemes(res.headers);
      if (schemes.includes('ntlm')) {
        // Remembered, so later calls in this session skip the failed attempt.
        this.authMode = 'ntlm';
        return this.#ntlmPost(url, envelope);
      }
    }
    return res;
  }

  /** Build and send one SOAP request. The gate on mutation lives here. */
  async call(operation, body) {
    if (FORBIDDEN_OPERATIONS.includes(operation) || !READ_OPERATIONS.has(operation)) {
      throw new EwsError(`refusing to send ${operation}: this client is read-only`);
    }
    this.log.push(operation);

    const version = this.opts.version || 'Exchange2010_SP2';
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="${NS.soap}" xmlns:t="${NS.t}" xmlns:m="${NS.m}">
  <soap:Header><t:RequestServerVersion Version="${version}"/></soap:Header>
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;

    const url = new URL(this.opts.url);
    const res = await this.#authorizedPost(url, envelope);

    if (res.status === 401) {
      const scheme = String(res.headers['www-authenticate'] || '');
      const tried = this.authMode === 'ntlm' ? 'NTLM' : 'Basic';
      throw new EwsError(
        `the server rejected the credentials (401) after trying ${tried}${scheme ? `; it offers: ${scheme}` : ''}. `
        + (tried === 'NTLM'
          ? 'The handshake completed but the credentials were not accepted. Check the password, '
            + 'and set MAIL_DOMAIN, or write MAIL_USER as DOMAIN\\\\user — NTLM needs the right domain '
            + 'and a wrong one fails exactly like a wrong password.'
          : /negotiate/i.test(scheme) && !/ntlm/i.test(scheme)
            ? 'It wants Kerberos, which this client does not speak.'
            : 'Check MAIL_USER and MAIL_PASS.'),
      );
    }
    if (res.status !== 200) {
      throw new EwsError(`${url.host} answered HTTP ${res.status}: ${res.body.slice(0, 200).replace(/\s+/g, ' ')}`);
    }

    const fault = text(res.body, 'faultstring');
    if (fault) throw new EwsError(`the server returned a SOAP fault: ${fault}`);
    const bad = blocks(res.body, 'ResponseMessage').find((b) => /ResponseClass="Error"/.test(b.attrs));
    if (bad) {
      throw new EwsError(`${text(bad.inner, 'ResponseCode') || 'error'}: ${text(bad.inner, 'MessageText') || 'no detail given'}`);
    }
    return res.body;
  }

  // ------------------------------------------------------------- folders

  /** Folder display names, so a first run can learn what things are called. */
  async folders() {
    const xml = await this.call('FindFolder', `<m:FindFolder Traversal="Deep">
      <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
    </m:FindFolder>`);
    const names = [];
    for (const f of blocks(xml, 'Folder')) {
      const name = text(f.inner, 'DisplayName');
      const count = text(f.inner, 'TotalCount');
      if (name) names.push(count ? `${name}  (${count} items)` : name);
    }
    return names;
  }

  /**
   * How to address a folder. A well-known name is used directly; anything
   * else is looked up by display name, because EWS addresses arbitrary
   * folders by id rather than by name.
   */
  async folderElement(folder) {
    const wellKnown = {
      inbox: 'inbox', 'sent items': 'sentitems', sentitems: 'sentitems',
      drafts: 'drafts', 'deleted items': 'deleteditems', deleteditems: 'deleteditems',
      'junk email': 'junkemail', junkemail: 'junkemail', archive: 'archive',
      outbox: 'outbox',
    };
    const key = String(folder || 'inbox').trim().toLowerCase();
    if (wellKnown[key]) return `<t:DistinguishedFolderId Id="${wellKnown[key]}"/>`;

    const xml = await this.call('FindFolder', `<m:FindFolder Traversal="Deep">
      <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/></t:AdditionalProperties>
      </m:FolderShape>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds>
    </m:FindFolder>`);
    for (const f of blocks(xml, 'Folder')) {
      if (text(f.inner, 'DisplayName').toLowerCase() === key) {
        const id = blocks(f.inner, 'FolderId')[0];
        if (id) return `<t:FolderId Id="${esc(attr(id.attrs, 'Id'))}" ChangeKey="${esc(attr(id.attrs, 'ChangeKey'))}"/>`;
      }
    }
    throw new EwsError(`no folder called "${folder}"; <copilot:mailboxes/> lists the real names`);
  }

  // -------------------------------------------------------------- items

  /**
   * Find messages received since `since`, newest first.
   *
   * The date restriction is applied by the server because it is the volume
   * control; `from` and `subject` are matched here as well, but narrowing on
   * the server first is what keeps a busy mailbox from being paged through.
   */
  async findItems({ folderElement, since, limit, unreadOnly, from, subject, noRestriction = false }) {
    const conditions = since && !noRestriction ? [
      `<t:IsGreaterThanOrEqualTo>
         <t:FieldURI FieldURI="item:DateTimeReceived"/>
         <t:FieldURIOrConstant><t:Constant Value="${esc(ewsDate(since))}"/></t:FieldURIOrConstant>
       </t:IsGreaterThanOrEqualTo>`,
    ] : [];
    if (unreadOnly) {
      // A filter on the flag, not a change to it.
      conditions.push(`<t:IsEqualTo>
         <t:FieldURI FieldURI="message:IsRead"/>
         <t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant>
       </t:IsEqualTo>`);
    }
    if (subject) {
      conditions.push(`<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
         <t:FieldURI FieldURI="item:Subject"/><t:Constant Value="${esc(subject)}"/>
       </t:Contains>`);
    }
    const restriction = conditions.length === 0 ? ''
      : conditions.length === 1 ? conditions[0]
        : `<t:And>${conditions.join('')}</t:And>`;

    const xml = await this.call('FindItem', `<m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:HasAttachments"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${Math.max(1, Math.min(limit, 200))}" Offset="0" BasePoint="Beginning"/>
      ${restriction ? `<m:Restriction>${restriction}</m:Restriction>` : ''}
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>${folderElement}</m:ParentFolderIds>
    </m:FindItem>`);

    // What the server says it matched, straight from the response. If this
    // disagrees with how many we parsed, the fault is here and not there.
    const root = blocks(xml, 'RootFolder')[0];
    const totalInView = root ? Number(attr(root.attrs, 'TotalItemsInView') || 0) : null;
    const rawBlocks = blocks(xml, 'Message').length;

    const items = [];
    for (const msg of blocks(xml, 'Message')) {
      const id = blocks(msg.inner, 'ItemId')[0];
      if (!id) continue;
      const sender = blocks(msg.inner, 'From')[0];
      const senderName = sender ? text(sender.inner, 'Name') : '';
      const senderAddr = sender ? text(sender.inner, 'EmailAddress') : '';
      const one = {
        id: attr(id.attrs, 'Id'),
        changeKey: attr(id.attrs, 'ChangeKey'),
        subject: text(msg.inner, 'Subject'),
        received: text(msg.inner, 'DateTimeReceived'),
        from: senderName && senderAddr ? `${senderName} <${senderAddr}>` : senderAddr || senderName,
        isRead: text(msg.inner, 'IsRead') === 'true',
        hasAttachments: text(msg.inner, 'HasAttachments') === 'true',
      };
      if (from && !one.from.toLowerCase().includes(String(from).toLowerCase())) continue;
      items.push(one);
    }
    items.totalInView = totalInView;
    items.rawBlocks = rawBlocks;
    return items;
  }

  /**
   * Fetch bodies for the given items, in one request.
   *
   * BodyType Text asks Exchange for the plain-text rendering, which means no
   * MIME decoding here at all and no HTML-to-text guesswork. Reading a body
   * does not change IsRead; only UpdateItem does, and that cannot be sent.
   */
  async getItems(items) {
    if (!items.length) return [];
    const ids = items
      .map((i) => `<t:ItemId Id="${esc(i.id)}" ChangeKey="${esc(i.changeKey)}"/>`)
      .join('');
    const xml = await this.call('GetItem', `<m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:BodyType>Text</t:BodyType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="message:CcRecipients"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="message:InternetMessageId"/>
          <t:FieldURI FieldURI="item:HasAttachments"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>${ids}</m:ItemIds>
    </m:GetItem>`);

    const people = (inner, tag) => {
      const box = blocks(inner, tag)[0];
      if (!box) return '';
      return blocks(box.inner, 'Mailbox')
        .map((mb) => {
          const name = text(mb.inner, 'Name');
          const addr = text(mb.inner, 'EmailAddress');
          return name && addr ? `${name} <${addr}>` : addr || name;
        })
        .filter(Boolean).join(', ');
    };

    const out = [];
    for (const msg of blocks(xml, 'Message')) {
      const sender = blocks(msg.inner, 'From')[0];
      out.push({
        subject: text(msg.inner, 'Subject'),
        date: text(msg.inner, 'DateTimeReceived'),
        from: sender
          ? (() => {
            const n = text(sender.inner, 'Name'); const a = text(sender.inner, 'EmailAddress');
            return n && a ? `${n} <${a}>` : a || n;
          })()
          : '',
        to: people(msg.inner, 'ToRecipients'),
        cc: people(msg.inner, 'CcRecipients'),
        messageId: text(msg.inner, 'InternetMessageId'),
        isRead: text(msg.inner, 'IsRead') === 'true',
        hasAttachments: text(msg.inner, 'HasAttachments') === 'true',
        text: text(msg.inner, 'Body').trim(),
      });
    }
    return out;
  }
}

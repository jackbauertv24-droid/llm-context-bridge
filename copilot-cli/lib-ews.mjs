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

/** Every <tag ...>inner</tag> block, as raw strings including the open tag. */
function blocks(xml, local) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${local}\\b([^>]*)(/)?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    if (m[2]) { out.push({ attrs: m[1], inner: '' }); continue; }
    const closeRe = new RegExp(`</(?:\\w+:)?${local}>`, 'g');
    closeRe.lastIndex = re.lastIndex;
    // Nested tags of the same name do not occur in these responses, so the
    // first close is the right one.
    const close = closeRe.exec(xml);
    if (!close) break;
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

export class EwsReader {
  constructor(opts) {
    this.opts = opts;
    this.log = [];
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
    const isHttps = url.protocol === 'https:';
    const auth = `Basic ${Buffer.from(`${this.opts.user}:${this.opts.pass}`).toString('base64')}`;

    const res = await new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(envelope),
          Authorization: auth,
          Accept: 'text/xml',
          'User-Agent': 'copilot-cli-mail/1.0',
        },
        // An on-premises Exchange often has an internal CA. Verification stays
        // on unless it is explicitly turned off, and turning it off is a
        // decision the operator makes in mail.env, not one made here.
        rejectUnauthorized: this.opts.insecureTls !== true,
        timeout: this.opts.timeoutMs || 30000,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new EwsError(`${url.host} stopped responding`)));
      req.on('error', (e) => reject(new EwsError(`cannot reach ${url.host} — ${e.message}`)));
      req.end(envelope);
    });

    if (res.status === 401) {
      const scheme = String(res.headers['www-authenticate'] || '');
      throw new EwsError(
        `the server rejected the credentials (401)${scheme ? `; it offers: ${scheme}` : ''}. `
        + (/negotiate|ntlm/i.test(scheme) && !/basic/i.test(scheme)
          ? 'It wants NTLM or Kerberos rather than Basic, which this client does not speak.'
          : 'Check MAIL_USER and MAIL_PASS — the user is often DOMAIN\\\\user rather than an address.'),
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
  async findItems({ folderElement, since, limit, unreadOnly, from, subject }) {
    const conditions = [
      `<t:IsGreaterThanOrEqualTo>
         <t:FieldURI FieldURI="item:DateTimeReceived"/>
         <t:FieldURIOrConstant><t:Constant Value="${esc(ewsDate(since))}"/></t:FieldURIOrConstant>
       </t:IsGreaterThanOrEqualTo>`,
    ];
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
    const restriction = conditions.length === 1
      ? conditions[0]
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
      <m:Restriction>${restriction}</m:Restriction>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>${folderElement}</m:ParentFolderIds>
    </m:FindItem>`);

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

// The mail tools the agent can call.
//
// One verb that matters: read a window of recent mail and hand it back as
// text. Nothing here can change anything on the server — see lib-imap.mjs for
// how that is enforced — and nothing is written to disk.
//
// Kept apart from lib-fstools.mjs on purpose. That file is a verbatim port
// from clichat and is meant to stay one file in two places; mail is ours
// alone, and mixing them would make the next port a merge.

import fs from 'node:fs';
import path from 'node:path';
import { ImapReader, MailError, imapDate } from './lib-imap.mjs';
import { EwsReader, EwsError } from './lib-ews.mjs';
import { parseMessage } from './lib-mime.mjs';

export { MailError, EwsError };

const DEFAULTS = {
  days: 7,
  limit: 25,
  perMessageChars: 2000,
  totalChars: 40000,
  fetchBytes: 65536,
};

/**
 * Read a KEY=VALUE settings file.
 *
 * Deliberately not `export`-aware shell syntax: this file holds a password,
 * and something that looks like a shell script invites being sourced into one.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Where the settings come from, most specific first: a path given explicitly,
 * then mail.env beside the workspace, then beside the CLI itself. Real
 * environment variables win over all of them, so a one-off override needs no
 * file editing.
 */
export function loadMailConfig({ root, envPath, env = process.env } = {}) {
  const candidates = [
    envPath || env.MAIL_ENV,
    root && path.join(root, 'mail.env'),
    path.join(path.dirname(new URL(import.meta.url).pathname), 'mail.env'),
  ].filter(Boolean);

  let fromFile = {};
  let source = null;
  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fromFile = parseEnvFile(fs.readFileSync(file, 'utf8'));
        source = file;
        break;
      }
    } catch { /* an unreadable candidate is simply not the one */ }
  }

  const pick = (name) => (env[name] !== undefined && env[name] !== '' ? env[name] : fromFile[name]);
  // Exchange Web Services is the default when a URL is given, because it is
  // the method that works on the network this was built for: an on-premises
  // Exchange with no IMAP and no OAuth.
  const ewsUrl = pick('MAIL_EWS_URL');
  const protocol = (pick('MAIL_PROTOCOL') || (ewsUrl ? 'ews' : 'imap')).toLowerCase();
  const cfg = {
    protocol,
    ewsUrl,
    ewsVersion: pick('MAIL_EWS_VERSION') || 'Exchange2010_SP2',
    // auto tries Basic and falls back to NTLM when the server refuses it.
    authMode: (pick('MAIL_AUTH') || 'auto').toLowerCase(),
    domain: pick('MAIL_DOMAIN') || '',
    insecureTls: String(pick('MAIL_TLS_INSECURE') ?? '0') === '1',
    host: pick('MAIL_HOST'),
    port: Number(pick('MAIL_PORT') || 993),
    useTls: String(pick('MAIL_TLS') ?? '1') !== '0',
    user: pick('MAIL_USER'),
    pass: pick('MAIL_PASS'),
    oauthToken: pick('MAIL_OAUTH_TOKEN'),
    folder: pick('MAIL_FOLDER') || 'INBOX',
    redact: String(pick('MAIL_REDACT') ?? '1') !== '0',
    days: Number(pick('MAIL_DAYS') || DEFAULTS.days),
    limit: Number(pick('MAIL_LIMIT') || DEFAULTS.limit),
    perMessageChars: Number(pick('MAIL_MAX_BODY') || DEFAULTS.perMessageChars),
    totalChars: Number(pick('MAIL_MAX_TOTAL') || DEFAULTS.totalChars),
    fetchBytes: Number(pick('MAIL_FETCH_BYTES') || DEFAULTS.fetchBytes),
    timeoutMs: Number(pick('MAIL_TIMEOUT_MS') || 30000),
    source,
  };
  cfg.configured = cfg.protocol === 'ews'
    ? !!(cfg.ewsUrl && cfg.user && cfg.pass)
    : !!(cfg.host && cfg.user && (cfg.pass || cfg.oauthToken));
  return cfg;
}

/** What is missing, phrased as something a person can act on. */
export function configComplaint(cfg) {
  const missing = [];
  if (cfg.protocol === 'ews') {
    if (!cfg.ewsUrl) missing.push('MAIL_EWS_URL');
    if (!cfg.user) missing.push('MAIL_USER');
    if (!cfg.pass) missing.push('MAIL_PASS');
  } else {
    if (!cfg.host) missing.push('MAIL_HOST');
    if (!cfg.user) missing.push('MAIL_USER');
    if (!cfg.pass && !cfg.oauthToken) missing.push('MAIL_PASS (or MAIL_OAUTH_TOKEN)');
  }
  if (!missing.length) return null;
  return `mail is not set up for ${cfg.protocol.toUpperCase()}: ${missing.join(', ')} `
    + `${missing.length === 1 ? 'is' : 'are'} not set. `
    + 'Put them in mail.env next to the CLI (see README > Reading mail).';
}

// Secrets that turn up in mail more often than anyone would like. The mail is
// about to be pasted into a chat window, so they are worth removing on the way
// past; MAIL_REDACT=0 turns this off.
const SECRETS = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted jwt]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted aws key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted github token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted slack token]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1: [redacted]'],
];

export function redact(text) {
  let out = String(text);
  for (const [re, to] of SECRETS) out = out.replace(re, to);
  return out;
}

/** Build the IMAP SEARCH criteria. Every term here is a read-only filter. */
export function searchCriteria({ days, from, to, subject, unseenOnly }) {
  const since = new Date(Date.now() - Math.max(0, days) * 86400000);
  const parts = [`SINCE ${imapDate(since)}`];
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  if (from) parts.push(`FROM ${quote(from)}`);
  if (to) parts.push(`TO ${quote(to)}`);
  if (subject) parts.push(`SUBJECT ${quote(subject)}`);
  // UNSEEN is a filter, not a change: asking for unread mail does not read it.
  if (unseenOnly) parts.push('UNSEEN');
  return parts.join(' ');
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}\n... [message cut at ${n} characters]`);

/** Render the fetched mail as the text the model will see. */
export function renderDigest(messages, { folder, days, truncatedAt, cfg }) {
  if (!messages.length) return `No mail in ${folder} in the last ${days} day${days === 1 ? '' : 's'}.`;
  const lines = [
    `${messages.length} message${messages.length === 1 ? '' : 's'} in ${folder} `
    + `from the last ${days} day${days === 1 ? '' : 's'}, newest first.`,
    'Read-only: nothing was marked as read and nothing on the server changed.',
    '',
  ];
  messages.forEach((m, i) => {
    lines.push(`--- [${i + 1}] ---`);
    lines.push(`date:    ${m.date || m.internalDate}`);
    lines.push(`from:    ${m.from}`);
    if (m.to) lines.push(`to:      ${m.to}`);
    if (m.cc) lines.push(`cc:      ${m.cc}`);
    lines.push(`subject: ${m.subject || '(no subject)'}`);
    if (m.listId) lines.push(`list:    ${m.listId}`);
    lines.push('');
    let body = m.text || '(no readable text part)';
    if (cfg.redact) body = redact(body);
    lines.push(clip(body, cfg.perMessageChars));
    if (m.truncated) lines.push('... [only the first part of this message was downloaded]');
    lines.push('');
  });
  if (truncatedAt) {
    lines.push(`[stopped after ${truncatedAt} messages to stay inside the size budget; `
      + 'narrow it with days, from, subject or limit]');
  }
  return lines.join('\n');
}

/**
 * Read recent mail over Exchange Web Services.
 *
 * Three read operations and nothing else. The read flag is reported, never
 * set: in EWS that takes an explicit UpdateItem, which lib-ews.mjs refuses
 * to send.
 */
async function readMailEws(cfg, { days, folder, limit, args }) {
  const ews = new EwsReader({
    url: cfg.ewsUrl, user: cfg.user, pass: cfg.pass,
    version: cfg.ewsVersion, insecureTls: cfg.insecureTls, timeoutMs: cfg.timeoutMs,
    authMode: cfg.authMode, domain: cfg.domain,
  });
  const since = new Date(Date.now() - Math.max(0, days) * 86400000);
  const where = await ews.folderElement(folder);
  const found = await ews.findItems({
    folderElement: where,
    since,
    limit,
    unreadOnly: args.unread === 'true' || args.unread === '1',
    from: args.from,
    subject: args.subject,
  });

  const full = await ews.getItems(found.slice(0, limit));
  const messages = [];
  let spent = 0;
  let truncatedAt = 0;
  for (const m of full) {
    const cost = Math.min((m.text || '').length, cfg.perMessageChars) + 200;
    if (spent + cost > cfg.totalChars && messages.length) { truncatedAt = messages.length; break; }
    spent += cost;
    messages.push(m);
  }
  return {
    text: renderDigest(messages, { folder, days, truncatedAt, cfg }),
    count: messages.length,
    folder,
    commands: ews.log,
  };
}

/**
 * Read recent mail. Opens read-only, peeks at bodies, changes nothing.
 */
export async function readMail(cfg, args = {}) {
  const complaint = configComplaint(cfg);
  if (complaint) throw new MailError(complaint);

  const days = Math.max(0, Number(args.days ?? cfg.days) || cfg.days);
  const folder = args.folder || cfg.folder;
  const limit = Math.max(1, Math.min(Number(args.limit ?? cfg.limit) || cfg.limit, 200));

  if (cfg.protocol === 'ews') return readMailEws(cfg, { days, folder, limit, args });

  const imap = new ImapReader(cfg);
  try {
    await imap.connect();
    await imap.login();
    await imap.examine(folder);

    const uids = await imap.search(searchCriteria({
      days,
      from: args.from,
      to: args.to,
      subject: args.subject,
      unseenOnly: args.unread === 'true' || args.unread === '1',
    }));

    // Newest first, then cut: a 10-day window on a busy inbox is not going
    // into a prompt whole, and the recent end is the useful end.
    const wanted = uids.slice().sort((a, b) => b - a).slice(0, limit);

    const messages = [];
    let spent = 0;
    let truncatedAt = 0;
    for (const uid of wanted) {
      const got = await imap.fetchMessage(uid, cfg.fetchBytes);
      if (!got) continue;
      const parsed = parseMessage(got.raw, { truncated: got.truncated });
      const cost = Math.min(parsed.text.length, cfg.perMessageChars) + 200;
      if (spent + cost > cfg.totalChars && messages.length) { truncatedAt = messages.length; break; }
      spent += cost;
      messages.push({ ...parsed, internalDate: got.internalDate, uid: got.uid });
    }
    return {
      text: renderDigest(messages, { folder, days, truncatedAt, cfg }),
      count: messages.length,
      folder,
      commands: imap.log,
    };
  } finally {
    await imap.logout();
  }
}

/** The folder names, so a first run can find out what the server calls things. */
export async function listFolders(cfg) {
  const complaint = configComplaint(cfg);
  if (complaint) throw new MailError(complaint);

  if (cfg.protocol === 'ews') {
    const ews = new EwsReader({
      url: cfg.ewsUrl, user: cfg.user, pass: cfg.pass,
      version: cfg.ewsVersion, insecureTls: cfg.insecureTls, timeoutMs: cfg.timeoutMs,
      authMode: cfg.authMode, domain: cfg.domain,
    });
    const names = await ews.folders();
    return { text: names.length ? names.join('\n') : '(the server listed no folders)', commands: ews.log };
  }

  const imap = new ImapReader(cfg);
  try {
    await imap.connect();
    await imap.login();
    const names = await imap.folders();
    return { text: names.length ? names.join('\n') : '(the server listed no folders)', commands: imap.log };
  } finally {
    await imap.logout();
  }
}

/**
 * Why did a search come back empty?
 *
 * "No mail in the last N days" and "the search worked but nothing could be
 * read out of the answer" printed identically, and they need opposite fixes.
 * This asks the server three questions in one connection — the window you
 * wanted, a much wider one, and no date restriction at all — and reports both
 * what the server said it matched and how many of those we managed to parse.
 * One run then says whether the mailbox is quiet, the window is wrong, or the
 * client is at fault.
 */
export async function probeEwsSearch(cfg, { days }) {
  const ews = new EwsReader({
    url: cfg.ewsUrl, user: cfg.user, pass: cfg.pass,
    version: cfg.ewsVersion, insecureTls: cfg.insecureTls, timeoutMs: cfg.timeoutMs,
    authMode: cfg.authMode, domain: cfg.domain,
  });
  const where = await ews.folderElement(cfg.folder);
  const attempts = [
    { label: `last ${days} day(s)`, since: new Date(Date.now() - days * 86400000) },
    { label: 'last 30 days', since: new Date(Date.now() - 30 * 86400000) },
    { label: 'no date restriction at all', since: null, noRestriction: true },
  ];
  const out = [];
  for (const a of attempts) {
    try {
      const found = await ews.findItems({
        folderElement: where, since: a.since, limit: 5, noRestriction: a.noRestriction,
      });
      out.push({
        label: a.label,
        since: a.since ? a.since.toISOString() : null,
        matched: found.totalInView,
        parsed: found.length,
        newest: found[0] ? `${found[0].received}  ${found[0].subject || '(no subject)'}` : null,
      });
      if (found.length) break;      // answered; no need to widen further
    } catch (e) {
      out.push({ label: a.label, error: e.message });
    }
  }
  return { attempts: out, commands: ews.log, folder: cfg.folder };
}

/**
 * The tool definitions, in the same shape as lib-fstools.mjs so the agent
 * loop treats them identically. `mutates` is false for both: reading mail
 * changes nothing, which is the entire design constraint.
 */
export function mailTools(cfg) {
  return {
    mail: {
      summary: 'read recent mail messages',
      usage: '<copilot:mail days="10" folder="INBOX" limit="25" from="" subject="" unread="false"/>',
      describe: (a) => {
        const bits = [`last ${a.days || cfg.days} days`];
        if (a.folder) bits.push(a.folder);
        if (a.from) bits.push(`from ${a.from}`);
        if (a.subject) bits.push(`subject ~ ${a.subject}`);
        if (a.unread === 'true' || a.unread === '1') bits.push('unread only');
        return `read mail (${bits.join(', ')})`;
      },
      mutates: false,
      async run(_ctx, a) {
        const res = await readMail(cfg, a);
        return res.text;
      },
    },

    mailboxes: {
      summary: 'list the mail folders on the server',
      usage: '<copilot:mailboxes/>',
      describe: () => 'list mail folders',
      mutates: false,
      run: async () => (await listFolders(cfg)).text,
    },
  };
}

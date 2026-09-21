#!/usr/bin/env node
/**
 * Export mail over IMAP into LLM-readable text files.
 *
 * Layout it produces (see README):
 *   <out>/index.md              regenerated every run, one line per message
 *   <out>/manifest.md           what ran, when, with which filters
 *   <out>/INBOX/2026-09-20-1234-subject-slug.md
 *   <out>/_meta.jsonl           append-only metadata, source for index.md
 *   <out>/.state.json           UID checkpoints for incremental runs
 *
 * Re-running is incremental and cheap: it picks up from the last UID per
 * mailbox and only rewrites index.md / manifest.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';

const env = process.env;
const CFG = {
  host: env.MAIL_HOST,
  port: Number(env.MAIL_PORT || 993),
  secure: env.MAIL_TLS !== '0',
  user: env.MAIL_USER,
  pass: env.MAIL_PASS,
  accessToken: env.MAIL_OAUTH_TOKEN,          // set this instead of MAIL_PASS for XOAUTH2
  outDir: path.resolve(env.MAIL_OUT || '.llm/mail'),
  mailboxes: (env.MAIL_BOXES || 'INBOX').split(',').map((s) => s.trim()).filter(Boolean),
  sinceDays: Number(env.MAIL_SINCE_DAYS || 365),  // only used on a first, full run
  maxBody: Number(env.MAIL_MAX_BODY || 8000),     // chars of body per message file
  redact: env.MAIL_REDACT !== '0',
  full: env.MAIL_FULL === '1',                    // ignore checkpoints, re-export everything
};

if (!env.MAIL_SELFTEST) for (const k of ['host', 'user']) {
  if (!CFG[k]) {
    console.error(`missing MAIL_${k.toUpperCase()}. See README.md`);
    process.exit(1);
  }
}
if (!env.MAIL_SELFTEST && !CFG.pass && !CFG.accessToken) {
  console.error('set MAIL_PASS (password / app password) or MAIL_OAUTH_TOKEN (XOAUTH2)');
  process.exit(1);
}

const STATE_FILE = path.join(CFG.outDir, '.state.json');
const META_FILE = path.join(CFG.outDir, '_meta.jsonl');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const slug = (s, max = 60) =>
  (s || 'no-subject')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'no-subject';

const addr = (a) => {
  if (!a) return '';
  const list = Array.isArray(a) ? a : a.value || [];
  return list.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
};

// Narrow patterns only: the goal is to keep credentials out of files a model
// will read and quote back, not to scrub the prose.
const SECRETS = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED-JWT]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED-AWS-KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED-GITHUB-TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED-SLACK-TOKEN]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-PRIVATE-KEY]'],
  [/\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1: [REDACTED]'],
];

const redact = (text) =>
  CFG.redact ? SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), text) : text;

function bodyOf(parsed) {
  let text = parsed.text;
  if (!text && parsed.html) {
    text = htmlToText(parsed.html, {
      wordwrap: 100,
      selectors: [
        { selector: 'img', format: 'skip' },
        { selector: 'a', options: { ignoreHref: true } },
      ],
    });
  }
  text = (text || '(no text body)').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  let truncated = false;
  if (text.length > CFG.maxBody) {
    text = text.slice(0, CFG.maxBody);
    truncated = true;
  }
  return { text: redact(text), truncated };
}

const yaml = (v) => String(v ?? '').replace(/"/g, "'").replace(/\n/g, ' ');

function writeMessage(mailbox, uid, parsed) {
  const date = parsed.date || new Date();
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const subject = parsed.subject || '(no subject)';
  const dir = path.join(CFG.outDir, slug(mailbox, 40));
  fs.mkdirSync(dir, { recursive: true });

  const rel = path.join(slug(mailbox, 40), `${day}-${uid}-${slug(subject)}.md`);
  const attachments = (parsed.attachments || [])
    .filter((a) => a.filename)
    .map((a) => `${a.filename} (${Math.round((a.size || 0) / 1024)} KB)`);
  const { text, truncated } = bodyOf(parsed);

  const front = [
    '---',
    `id: ${mailbox}-${uid}`,
    `date: ${iso}`,
    `from: "${yaml(addr(parsed.from))}"`,
    `to: "${yaml(addr(parsed.to))}"`,
    parsed.cc ? `cc: "${yaml(addr(parsed.cc))}"` : null,
    `subject: "${yaml(subject)}"`,
    `mailbox: ${mailbox}`,
    parsed.messageId ? `message_id: "${yaml(parsed.messageId)}"` : null,
    parsed.inReplyTo ? `in_reply_to: "${yaml(parsed.inReplyTo)}"` : null,
    attachments.length ? `attachments: "${yaml(attachments.join('; '))}"` : null,
    truncated ? `truncated: true  # body cut at ${CFG.maxBody} chars` : null,
    '---',
  ].filter(Boolean).join('\n') + '\n\n';

  fs.writeFileSync(path.join(CFG.outDir, rel), `${front}${text}\n`);

  const meta = {
    id: `${mailbox}-${uid}`,
    uid,
    mailbox,
    date: iso,
    from: addr(parsed.from),
    subject,
    file: rel.split(path.sep).join('/'),
    attachments: attachments.length,
  };
  fs.appendFileSync(META_FILE, `${JSON.stringify(meta)}\n`);
  return meta;
}

function rebuildIndex() {
  const rows = fs.existsSync(META_FILE)
    ? fs.readFileSync(META_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

  // Last write wins, so a re-export of the same message replaces its row.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const all = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));

  const out = [
    '# Mail index',
    '',
    `${all.length} message${all.length === 1 ? '' : 's'}. Newest first. Read a line, then open its file for the full body.`,
    '',
  ];
  let month = '';
  for (const r of all) {
    const m = r.date.slice(0, 7);
    if (m !== month) {
      month = m;
      out.push('', `## ${month}`, '');
    }
    const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    out.push(
      `- \`${r.date.slice(0, 10)}\` **${clip(r.subject, 80)}** — ${clip(r.from, 50)}` +
      `${r.attachments ? ` [${r.attachments} attachment(s)]` : ''} → \`${r.file}\``
    );
  }
  fs.writeFileSync(path.join(CFG.outDir, 'index.md'), `${out.join('\n')}\n`);
  return all.length;
}

function writeManifest(stats, total) {
  const lines = [
    '# Mail export manifest',
    '',
    `generated_at: ${new Date().toISOString()}`,
    `source: ${CFG.host}:${CFG.port} as ${CFG.user}`,
    `redaction: ${CFG.redact ? 'on (credential patterns only)' : 'OFF'}`,
    `body_cap: ${CFG.maxBody} chars per message`,
    `total_messages_indexed: ${total}`,
    '',
    '## This run',
    '',
    ...stats.map((s) => `- ${s.mailbox}: ${s.added} new (checkpoint UID ${s.lastUid})`),
    '',
    '> This is a point-in-time snapshot, not a live mailbox. Anything after',
    '> `generated_at` is not here. Do not assume a message exists because it',
    '> would make sense — if it is not in index.md, it was not exported.',
    '',
  ];
  fs.writeFileSync(path.join(CFG.outDir, 'manifest.md'), lines.join('\n'));
}

// MAIL_SELFTEST=<file.eml> exercises the parse/write/index path with no network,
// so you can eyeball the output shape before pointing this at a real mailbox.
async function selfTest(file) {
  fs.mkdirSync(CFG.outDir, { recursive: true });
  const parsed = await simpleParser(fs.readFileSync(file));
  const meta = writeMessage('SELFTEST', 1, parsed);
  const total = rebuildIndex();
  writeManifest([{ mailbox: 'SELFTEST', added: 1, lastUid: 1 }], total);
  console.log(`wrote ${meta.file}`);
}

async function main() {
  fs.mkdirSync(CFG.outDir, { recursive: true });
  if (env.MAIL_SELFTEST) return selfTest(env.MAIL_SELFTEST);
  const state = CFG.full ? {} : readJson(STATE_FILE, {});

  const client = new ImapFlow({
    host: CFG.host,
    port: CFG.port,
    secure: CFG.secure,
    auth: CFG.accessToken
      ? { user: CFG.user, accessToken: CFG.accessToken }
      : { user: CFG.user, pass: CFG.pass },
    logger: false,
  });

  await client.connect();
  console.log(`connected to ${CFG.host} as ${CFG.user}`);

  if (env.MAIL_LIST === '1') {
    for (const box of await client.list()) console.log(`  ${box.path}`);
    await client.logout();
    return;
  }

  const stats = [];
  for (const mailbox of CFG.mailboxes) {
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
    } catch (err) {
      console.error(`  ${mailbox}: cannot open (${err.message}) — skipping`);
      continue;
    }

    try {
      const prev = state[mailbox];
      // UIDVALIDITY changing means the server renumbered: old UIDs are meaningless.
      const uidValidity = String(client.mailbox.uidValidity);
      const resync = !prev || prev.uidValidity !== uidValidity;
      if (prev && resync) console.log(`  ${mailbox}: UIDVALIDITY changed, full resync`);

      const since = new Date(Date.now() - CFG.sinceDays * 864e5);
      const range = resync ? { since } : `${prev.lastUid + 1}:*`;
      const opts = resync ? undefined : { uid: true };

      let added = 0;
      let lastUid = resync ? 0 : prev.lastUid;

      for await (const msg of client.fetch(range, { uid: true, source: true }, opts)) {
        // A `n:*` range always yields the final message even when nothing is new.
        if (msg.uid <= lastUid) continue;
        const parsed = await simpleParser(msg.source);
        writeMessage(mailbox, msg.uid, parsed);
        lastUid = Math.max(lastUid, msg.uid);
        if (++added % 50 === 0) process.stdout.write(`  ${mailbox}: ${added}\r`);
      }

      state[mailbox] = { uidValidity, lastUid };
      stats.push({ mailbox, added, lastUid });
      console.log(`  ${mailbox}: ${added} new message(s)`);
    } finally {
      lock.release();
    }
  }

  await client.logout();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  const total = rebuildIndex();
  writeManifest(stats, total);
  console.log(`\nindex: ${path.join(CFG.outDir, 'index.md')} (${total} messages)`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(err.message)) {
    console.error('Basic auth rejected. If this is Microsoft 365, that is expected —');
    console.error('the tenant almost certainly requires OAuth2. See README.md.');
  }
  process.exit(1);
});

#!/usr/bin/env node
/**
 * corp-probe — one read-only sweep of a locked-down corporate workstation.
 *
 *   node corp-probe.mjs you@corp.com
 *
 * Answers, in a single run, everything needed to decide how to feed external
 * context (mail, remote logs) to a VS Code LLM plugin that can only read text:
 *
 *   1. Runtime        what node/OS you have, and what a proxy is doing to you
 *   2. Egress + TLS   can you reach the internet, and is TLS being intercepted
 *   3. Mail           MX / SRV / autodiscover / IMAP / POP3 / EWS / Graph tenant
 *   4. VS Code        which extensions exist, and whether any of them keep a
 *                     chat transcript on disk (this decides if the loop can be
 *                     automated instead of copy-pasted)
 *   5. SSH            client, config aliases, agent, key presence
 *   6. Summary        the decision-relevant facts in one block
 *
 * Guarantees: it authenticates nothing, sends no credentials, reads no mail,
 * opens no key file, and writes nothing outside the report file it prints at
 * the end. Every check is a DNS lookup, a TCP/TLS connect, an unauthenticated
 * HTTPS GET, or a directory listing.
 *
 * Zero npm dependencies — node builtins only, so it runs where `npm install`
 * is blocked. Node 16+.
 *
 * Output is redacted by default (username and home path masked). Pass --raw to
 * disable, --mask-domain to also hide the company domain.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node corp-probe.mjs you@corp.com [--raw] [--mask-domain] [--quick]');
  process.exit(1);
}
const EMAIL = target.includes('@') ? target : '';
const DOMAIN = target.includes('@') ? target.split('@')[1] : target;
const RAW = FLAGS.has('--raw');
const QUICK = FLAGS.has('--quick');
const TIMEOUT = QUICK ? 3000 : 6000;

// ------------------------------------------------------------- output ----

const LINES = [];
const USER = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const HOME = os.homedir();

const escRe = (v) => v.replace(/[$^.*+?(){}|[\]\\]/g, '\\$&');
// Match only at a path boundary: a bare .split() turns the literal string
// "~/.ssh/config" into "~/.ssh~" on a machine whose home is /config.
const boundary = (v) => new RegExp(`(?<![A-Za-z0-9_.~-])${escRe(v)}(?![A-Za-z0-9_-])`, 'g');
const HOME_RE = HOME ? boundary(HOME) : null;
const USER_RE = USER && USER.length > 2 ? boundary(USER) : null;

function clean(s) {
  let out = String(s);
  if (!RAW) {
    if (HOME_RE) out = out.replace(HOME_RE, '~');
    if (USER_RE) out = out.replace(USER_RE, '<user>');
  }
  if (FLAGS.has('--mask-domain')) out = out.split(DOMAIN).join('<corp-domain>');
  return out;
}
const emit = (s = '') => { const t = clean(s); LINES.push(t); console.log(t); };
const section = (n, title) => { emit(); emit(`=== ${n}. ${title} ${'='.repeat(Math.max(0, 58 - title.length))}`); };
const ok = (s) => emit(`  [ok] ${s}`);
const no = (s) => emit(`  [--] ${s}`);
const hit = (s) => emit(`  [!!] ${s}`);
const info = (s) => emit(`  [..] ${s}`);
const sub = (s) => emit(`       ${s}`);

const FOUND = {
  mailProtocol: null, mailAuth: null, mailHost: null,
  tlsIntercepted: false, tlsIssuer: null, egress: false,
  m365: false, tenantId: null, ewsUrl: null,
  vscodeExts: 0, llmExts: [], transcriptCandidates: [],
  ssh: false, sshHosts: 0, npm: null,
};

// -------------------------------------------------------------- probes ----

function tcpProbe({ host, port, useTls, proto }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve({ host, port, ...r });
    };
    const timer = setTimeout(() => finish({ state: 'timeout' }), TIMEOUT);

    let greeting = '';
    let body = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (!greeting) {
        greeting = text.trim().split('\n')[0];
        if (proto === 'imap') socket.write('a1 CAPABILITY\r\n');
        else if (proto === 'pop3') socket.write('CAPA\r\n');
        else return finish({ state: 'open', greeting });
        return;
      }
      body += text;
      const done = proto === 'imap' ? /a1 (OK|NO|BAD)/i.test(body) : /^\.\r?$/m.test(body) || /^-ERR/m.test(body);
      if (done) finish({ state: 'open', greeting, body: body.trim() });
    };

    const socket = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
      : net.connect({ host, port });
    socket.setEncoding('utf8');
    socket.on('data', onData);
    socket.on('error', (e) => finish({ state: e.code || 'error' }));
    socket.on('close', () => finish({ state: greeting ? 'open' : 'closed', greeting, body }));
  });
}

function tlsInfo(host, port = 443) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(t); try { s.destroy(); } catch {} resolve(r); };
    const t = setTimeout(() => finish({ ok: false, err: 'timeout' }), TIMEOUT);
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const cert = s.getPeerCertificate() || {};
      finish({ ok: true, authorized: s.authorized, authError: s.authorizationError, issuer: cert.issuer || {}, subject: cert.subject || {} });
    });
    s.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
  });
}

function httpGet(url, { maxBytes = 4096 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(t); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, err: 'timeout' }), TIMEOUT);
    const req = https.get(url, { rejectUnauthorized: false, headers: { 'user-agent': 'corp-probe' } }, (res) => {
      let buf = '';
      res.on('data', (d) => { if (buf.length < maxBytes) buf += d; });
      res.on('end', () => finish({ ok: true, status: res.statusCode, headers: res.headers, body: buf.slice(0, maxBytes) }));
    });
    req.on('error', (e) => finish({ ok: false, err: e.code || e.message }));
  });
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const listDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };

// --------------------------------------------------------- 1. runtime ----

function runtime() {
  section(1, 'Runtime');
  info(`node      ${process.version}  (${process.arch})`);
  info(`os        ${os.platform()} ${os.release()}`);
  info(`shell     ${process.env.SHELL || process.env.ComSpec || 'unknown'}`);
  info(`home      ${RAW ? HOME : `${HOME.split(/[/\\]/).slice(0, -1).join('/')}/<user>`}`);
  if (process.platform === 'linux' && /microsoft/i.test(os.release())) hit('running under WSL — VS Code may live on the Windows side');

  const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
  const set = proxyVars.filter((v) => process.env[v]);
  if (set.length) {
    hit('proxy environment variables are set:');
    for (const v of set) sub(`${v}=${String(process.env[v]).replace(/\/\/[^@/]+@/, '//<credentials>@')}`);
    sub('note: node\'s builtin http/https do NOT use these automatically.');
  } else no('no proxy environment variables set');

  for (const v of ['NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    if (process.env[v]) hit(`${v}=${process.env[v]}`);
  }
}

// ------------------------------------------------- 2. egress and TLS ----


async function egress() {
  section(2, 'Egress and TLS interception');
  // Four unrelated hosts that normally chain to four different public CAs.
  // A corporate MITM proxy re-signs all of them with one internal CA, so a
  // single issuer covering most of the set is the giveaway — that test needs
  // no list of "known good" CA names, which is what makes it reliable.
  const hosts = ['github.com', 'registry.npmjs.org', 'login.microsoftonline.com', 'graph.microsoft.com'];
  const issuers = new Map();
  let untrusted = 0;
  let reached = 0;

  for (const h of hosts) {
    const r = await tlsInfo(h);
    if (!r.ok) { no(`${h.padEnd(28)} ${r.err}`); continue; }
    reached++;
    FOUND.egress = true;
    const issuer = r.issuer.O || r.issuer.CN || '(unknown)';
    issuers.set(issuer, (issuers.get(issuer) || 0) + 1);
    if (!r.authorized) untrusted++;
    const trusted = r.authorized ? 'trusted by node' : `NOT trusted (${r.authError})`;
    ok(`${h.padEnd(28)} reachable — issuer: ${issuer} — ${trusted}`);
  }

  if (!FOUND.egress) {
    hit('no outbound TLS worked at all — everything below that needs the network will fail.');
    return;
  }

  const [topIssuer, topCount] = [...issuers.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const oneCaForAll = reached >= 3 && topCount >= reached - 1;
  if (untrusted > 0 || oneCaForAll) {
    FOUND.tlsIntercepted = true;
    FOUND.tlsIssuer = topIssuer;
    hit(`TLS is being intercepted by a proxy re-signing as "${topIssuer}" (${topCount}/${reached} hosts).`);
    if (untrusted > 0) {
      sub(`${untrusted} of ${reached} certificates do NOT validate against node's trust store.`);
      sub('Node ships its own CA bundle and ignores the OS/Windows trust store, so the');
      sub('proxy CA your browser already trusts is invisible to it. Expect IMAP and');
      sub('HTTPS from node to fail with SELF_SIGNED_CERT_IN_CHAIN until you fix it:');
      sub('  1. export the proxy root CA from your browser or OS keychain as a .pem');
      sub('  2. set NODE_EXTRA_CA_CERTS=/path/to/ca.pem before running anything');
      sub('Do NOT use NODE_TLS_REJECT_UNAUTHORIZED=0 — that disables verification');
      sub('entirely, including for the credentials you are about to send.');
    } else {
      sub('Certificates still validate, so the proxy CA is already in node\'s path.');
      sub('Nothing to fix, but be aware the proxy can read this traffic in clear.');
    }
  } else {
    ok(`no TLS interception detected — ${issuers.size} distinct public CAs across ${reached} hosts`);
  }
}

// ------------------------------------------------------------ 3. mail ----

async function mailDns() {
  section(3, 'Mail — discovery');
  try {
    const rows = (await dns.resolveMx(DOMAIN)).sort((a, b) => a.priority - b.priority);
    emit('  MX records:');
    for (const r of rows) sub(`${String(r.priority).padStart(3)}  ${r.exchange}`);
    const all = rows.map((r) => r.exchange.toLowerCase()).join(' ');
    if (all.includes('mail.protection.outlook.com')) { FOUND.m365 = true; hit('Exchange Online (Microsoft 365)'); }
    else if (/google|googlemail/.test(all)) hit('Google Workspace');
    else if (/pphosted|proofpoint/.test(all)) hit('Proofpoint gateway — real mailbox is behind it, keep reading');
    else if (/mimecast/.test(all)) hit('Mimecast gateway — real mailbox is behind it, keep reading');
    else info('no big-cloud tenant signature — likely on-prem Exchange, Zimbra, or IMAP-native');
  } catch (e) { no(`MX lookup failed: ${e.code || e.message}`); }

  emit('  SRV autoconfig (RFC 6186):');
  let any = false;
  for (const name of [`_imaps._tcp.${DOMAIN}`, `_imap._tcp.${DOMAIN}`, `_pop3s._tcp.${DOMAIN}`, `_submission._tcp.${DOMAIN}`, `_autodiscover._tcp.${DOMAIN}`]) {
    try {
      for (const r of await dns.resolveSrv(name)) {
        any = true;
        const off = !r.name || r.name === '.' || r.port === 0;
        sub(`${name} -> ${off ? 'explicitly not offered' : `${r.name}:${r.port}`}`);
      }
    } catch { /* NXDOMAIN is normal */ }
  }
  if (!any) sub('none published');

  try {
    const cn = await dns.resolveCname(`autodiscover.${DOMAIN}`);
    hit(`autodiscover.${DOMAIN} -> ${cn.join(', ')}`);
    if (cn.join(' ').includes('outlook.com')) FOUND.m365 = true;
  } catch { no(`no autodiscover.${DOMAIN} CNAME`); }
}

async function mailTenant() {
  if (!FOUND.egress) return;
  emit('  Microsoft tenant discovery:');
  const r = await httpGet(`https://login.microsoftonline.com/${DOMAIN}/v2.0/.well-known/openid-configuration`);
  if (r.ok && r.status === 200) {
    const m = r.body.match(/login\.microsoftonline\.com\/([0-9a-f-]{36})/i);
    FOUND.m365 = true;
    FOUND.tenantId = m ? m[1] : null;
    hit(`domain IS a Microsoft 365 tenant${m ? ` (tenant id ${m[1]})` : ''}`);
    sub('=> Graph API is the supported route; needs an app registration with Mail.Read');
  } else if (r.ok) no(`not a Microsoft tenant (HTTP ${r.status})`);
  else no(`tenant lookup failed: ${r.err}`);

  if (EMAIL) {
    const a = await httpGet(`https://outlook.office365.com/autodiscover/autodiscover.json?Email=${encodeURIComponent(EMAIL)}&Protocol=EWS`);
    if (a.ok && a.status === 200 && a.body.includes('Url')) {
      const m = a.body.match(/"Url"\s*:\s*"([^"]+)"/);
      if (m) { FOUND.ewsUrl = m[1]; hit(`EWS endpoint advertised: ${m[1]}`); }
    } else if (a.ok) no(`autodiscover v2 returned HTTP ${a.status}`);
  }
}

async function mailPorts() {
  emit('  IMAP / POP3 endpoints:');
  const cands = [
    { host: `imap.${DOMAIN}`, port: 993, useTls: true, proto: 'imap' },
    { host: `mail.${DOMAIN}`, port: 993, useTls: true, proto: 'imap' },
    { host: `imap.${DOMAIN}`, port: 143, useTls: false, proto: 'imap' },
    { host: `mail.${DOMAIN}`, port: 143, useTls: false, proto: 'imap' },
    { host: `outlook.office365.com`, port: 993, useTls: true, proto: 'imap' },
    { host: `imap.gmail.com`, port: 993, useTls: true, proto: 'imap' },
    { host: `pop.${DOMAIN}`, port: 995, useTls: true, proto: 'pop3' },
    { host: `mail.${DOMAIN}`, port: 995, useTls: true, proto: 'pop3' },
    { host: `${DOMAIN}`, port: 993, useTls: true, proto: 'imap' },
  ];
  const seen = new Set();
  for (const c of cands) {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { await dns.lookup(c.host); } catch { continue; }

    const r = await tcpProbe(c);
    const label = `${c.host}:${c.port}`.padEnd(34);
    if (r.state !== 'open') { sub(`${label} ${r.state}`); continue; }
    sub(`${label} OPEN  (${c.proto})`);
    if (r.greeting) sub(`  ${r.greeting.slice(0, 150)}`);
    const caps = (r.body || '').match(/\* CAPABILITY [^\r\n]*/i);
    if (caps) sub(`  ${caps[0].slice(0, 220)}`);
    const auth = caps ? [...caps[0].matchAll(/AUTH=([A-Z0-9-]+)/gi)].map((m) => m[1]) : [];
    if (auth.length) {
      sub(`  auth: ${auth.join(', ')}`);
      const isCorp = c.host.includes(DOMAIN);
      if (isCorp && !FOUND.mailProtocol) {
        FOUND.mailProtocol = c.proto.toUpperCase();
        FOUND.mailHost = key;
        FOUND.mailAuth = auth.join(',');
      }
      if (auth.includes('PLAIN') || auth.includes('LOGIN')) sub('  => password auth available: the IMAP exporter works as-is');
      else if (auth.includes('XOAUTH2')) sub('  => OAuth2 only: password will be rejected, needs a token');
    }
    if (caps && /LOGINDISABLED/i.test(caps[0])) sub(c.useTls ? '  => LOGINDISABLED: password auth is off on this endpoint' : '  => LOGINDISABLED: needs STARTTLS first');
  }
}

async function mailEws() {
  if (!FOUND.egress) return;
  emit('  EWS / webmail endpoints:');
  for (const url of [`https://mail.${DOMAIN}/EWS/Exchange.asmx`, `https://${DOMAIN}/EWS/Exchange.asmx`, `https://webmail.${DOMAIN}/EWS/Exchange.asmx`, 'https://outlook.office365.com/EWS/Exchange.asmx']) {
    const host = new URL(url).hostname;
    try { await dns.lookup(host); } catch { continue; }
    const r = await httpGet(url);
    if (!r.ok) { sub(`${url.padEnd(52)} ${r.err}`); continue; }
    // 401 is the good answer: the endpoint exists and is asking us to authenticate.
    const verdict = r.status === 401 ? 'EXISTS (401 = wants auth, as expected)' : `HTTP ${r.status}`;
    sub(`${url.padEnd(52)} ${verdict}`);
    if (r.status === 401) {
      FOUND.ewsUrl = FOUND.ewsUrl || url;
      const www = r.headers['www-authenticate'];
      if (www) sub(`  accepts: ${Array.isArray(www) ? www.join(', ') : www}`);
    }
  }
}

// --------------------------------------------------------- 4. VS Code ----

const LLM_HINT = /copilot|llm|genai|\bai\b|chat|gpt|claude|anthropic|codeium|tabnine|continue|sourcegraph|cody|qodo|amazonq|codewhisperer|intellicode|bito|cursor|codegeex|tongyi|lingma|comate|codemate|assistant/i;

function vscodeDirs() {
  const appdata = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const bases = {
    win32: [path.join(appdata, 'Code'), path.join(appdata, 'Code - Insiders'), path.join(appdata, 'VSCodium'), path.join(appdata, 'Cursor')],
    darwin: [path.join(HOME, 'Library', 'Application Support', 'Code'), path.join(HOME, 'Library', 'Application Support', 'Code - Insiders'), path.join(HOME, 'Library', 'Application Support', 'Cursor')],
    linux: [path.join(HOME, '.config', 'Code'), path.join(HOME, '.config', 'Code - Insiders'), path.join(HOME, '.config', 'VSCodium'), path.join(HOME, '.config', 'Cursor')],
  }[process.platform] || [];
  return bases.filter(exists);
}

function vscode() {
  section(4, 'VS Code — extensions and on-disk chat state');

  const extRoots = [path.join(HOME, '.vscode', 'extensions'), path.join(HOME, '.vscode-server', 'extensions'), path.join(HOME, '.vscode-insiders', 'extensions'), path.join(HOME, '.cursor', 'extensions')].filter(exists);
  if (!extRoots.length) no('no VS Code extension directory found (is VS Code installed for this user?)');

  for (const root of extRoots) {
    const exts = listDir(root).filter((d) => d.isDirectory()).map((d) => d.name);
    FOUND.vscodeExts += exts.length;
    ok(`${root} — ${exts.length} extension(s)`);
    const interesting = exts.filter((e) => LLM_HINT.test(e));
    if (interesting.length) {
      hit('extensions that look like an LLM/chat plugin:');
      for (const e of interesting) { sub(`* ${e}`); FOUND.llmExts.push(e); }
    } else sub('(none matched the LLM/chat name heuristic — list all with --raw and eyeball it)');
  }

  const roots = vscodeDirs();
  if (!roots.length) { no('no VS Code user-data directory found'); return; }

  for (const root of roots) {
    const gs = path.join(root, 'User', 'globalStorage');
    if (!exists(gs)) continue;
    ok(`${gs}`);
    const dirs = listDir(gs).filter((d) => d.isDirectory()).map((d) => d.name);
    const relevant = dirs.filter((d) => LLM_HINT.test(d));
    sub(`${dirs.length} storage dir(s); ${relevant.length} match the LLM heuristic`);

    for (const d of relevant) {
      const full = path.join(gs, d);
      const files = listDir(full).filter((f) => f.isFile());
      const notable = files
        .map((f) => { try { return { name: f.name, size: fs.statSync(path.join(full, f.name)).size }; } catch { return null; } })
        .filter(Boolean)
        .filter((f) => /\.(json|jsonl|sqlite|db|vscdb|log|txt|ndjson)$/i.test(f.name))
        .sort((a, b) => b.size - a.size)
        .slice(0, 8);
      hit(`${d}/`);
      if (!notable.length) { sub('  (no obvious data files at the top level)'); continue; }
      for (const f of notable) {
        sub(`  ${f.name.padEnd(40)} ${(f.size / 1024).toFixed(1)} KB`);
        if (f.size > 4096) FOUND.transcriptCandidates.push(`${d}/${f.name}`);
      }
    }

    // state.vscdb is where most chat UIs persist history if they don't roll their own.
    const state = path.join(root, 'User', 'globalStorage', 'state.vscdb');
    if (exists(state)) {
      const size = fs.statSync(state).size;
      hit(`state.vscdb present (${(size / 1024 / 1024).toFixed(1)} MB) — SQLite key/value store`);
      sub('many chat extensions stash conversation history here under their own key');
    }
  }
}

// -------------------------------------------------------------- 5. SSH ----

function ssh() {
  section(5, 'SSH');
  const sshDir = path.join(HOME, '.ssh');
  if (!exists(sshDir)) { no('no ~/.ssh directory'); return; }
  FOUND.ssh = true;
  ok(`${sshDir} exists`);

  const cfg = path.join(sshDir, 'config');
  if (exists(cfg)) {
    try {
      // Host aliases only. Never reads key material, never prints hostnames/users.
      const hosts = fs.readFileSync(cfg, 'utf8')
        .split('\n').filter((l) => /^\s*Host\s+/i.test(l))
        .flatMap((l) => l.replace(/^\s*Host\s+/i, '').trim().split(/\s+/))
        .filter((h) => h && h !== '*');
      FOUND.sshHosts = hosts.length;
      ok(`~/.ssh/config defines ${hosts.length} host alias(es)`);
      for (const h of hosts.slice(0, 25)) sub(`* ${h}`);
      if (hosts.length > 25) sub(`... and ${hosts.length - 25} more`);
    } catch (e) { no(`could not read ~/.ssh/config: ${e.code}`); }
  } else no('no ~/.ssh/config');

  const keys = listDir(sshDir).filter((f) => f.isFile() && /^(id_|.*\.pem$)/.test(f.name) && !f.name.endsWith('.pub')).map((f) => f.name);
  if (keys.length) ok(`private key file(s) present (names only): ${keys.join(', ')}`);
  else no('no private key files in ~/.ssh — you may be using an agent or password auth');

  const kh = path.join(sshDir, 'known_hosts');
  if (exists(kh)) {
    try { ok(`known_hosts has ${fs.readFileSync(kh, 'utf8').split('\n').filter(Boolean).length} entries`); } catch {}
  }
  if (process.env.SSH_AUTH_SOCK) ok(`ssh-agent is running (SSH_AUTH_SOCK set)`);
  else no('no SSH_AUTH_SOCK — no agent in this shell');
}

// ---------------------------------------------------------- 6. summary ----

function summary() {
  section(6, 'SUMMARY — paste this whole output back');

  emit('  Mail:');
  if (FOUND.mailProtocol) {
    sub(`reachable ${FOUND.mailProtocol} at ${FOUND.mailHost}, auth = ${FOUND.mailAuth}`);
    if (/PLAIN|LOGIN/.test(FOUND.mailAuth || '')) sub('VERDICT: password IMAP works. Use the exporter as-is.');
    else sub('VERDICT: OAuth2 only. Needs a token, or go via Graph/EWS.');
  } else if (FOUND.m365) {
    sub('VERDICT: Microsoft 365 tenant, no usable password IMAP.');
    sub(`Route: Graph API${FOUND.tenantId ? ` (tenant ${FOUND.tenantId})` : ''}${FOUND.ewsUrl ? `, or EWS at ${FOUND.ewsUrl}` : ''}.`);
  } else sub('VERDICT: no mail endpoint reachable — see section 3 for why.');

  emit('  Network:');
  sub(FOUND.egress ? 'outbound TLS works' : 'NO outbound TLS — everything remote is blocked from this box');
  if (FOUND.tlsIntercepted) sub(`TLS intercepted by ${FOUND.tlsIssuer} — node needs NODE_EXTRA_CA_CERTS`);

  emit('  VS Code:');
  sub(`${FOUND.vscodeExts} extension(s) installed`);
  sub(FOUND.llmExts.length ? `LLM-ish extensions: ${FOUND.llmExts.join(', ')}` : 'no LLM extension matched the name heuristic');
  if (FOUND.transcriptCandidates.length) {
    sub(`possible chat transcripts on disk (${FOUND.transcriptCandidates.length}):`);
    for (const c of FOUND.transcriptCandidates.slice(0, 10)) sub(`  ${c}`);
    sub('=> if one of these holds the conversation, the request/response loop can be');
    sub('   fully automated by tailing it instead of copy-pasting.');
  } else sub('no obvious on-disk chat transcript — expect manual/clipboard relay');

  emit('  SSH:');
  sub(FOUND.ssh ? `client config present, ${FOUND.sshHosts} host alias(es)` : 'no ~/.ssh — remote log reading needs setup first');
}

// ----------------------------------------------------------------- run ----

emit(`corp-probe — ${new Date().toISOString()}`);
emit(`target: ${EMAIL || DOMAIN}${RAW ? '' : '   (output redacted; --raw to disable)'}`);
emit('read-only: no authentication, no credentials sent, no mail read, no key file opened');

runtime();
await egress();
await mailDns();
await mailTenant();
await mailPorts();
await mailEws();
vscode();
ssh();
summary();

const reportPath = path.join(process.cwd(), 'corp-probe-report.txt');
try {
  fs.writeFileSync(reportPath, `${LINES.join('\n')}\n`);
  emit();
  emit(`Full report also written to: ${reportPath}`);
} catch (e) {
  emit(`\n(could not write report file: ${e.code})`);
}

#!/usr/bin/env node
/**
 * Interactive CLI over a chat web UI you are already signed into.
 *
 * It attaches to a Chrome you launched with remote debugging, types your prompt
 * into the page's chat box, waits for the rendered answer to finish streaming,
 * and prints it. Auth stays entirely in your browser session; this reads and
 * writes only visible DOM, never network traffic, headers, cookies or tokens.
 *
 *   node chat.mjs                        interactive
 *   node chat.mjs "review @src/app.js"   one shot, answer on stdout
 *   git diff | node chat.mjs "review this"
 *
 * Write @path in a prompt and the file is read here and pasted into the page,
 * so the terminal does the copying. @file:40-80 attaches just a line range.
 *
 * Commands:  /probe  /debug  /config  /help  /quit
 *
 * Selectors auto-detect by default. Once probe.mjs shows the real DOM, pin them
 * with env vars (INPUT_SELECTOR, SEND_SELECTOR, ANSWER_SELECTOR) for reliability.
 */
import readline from 'node:readline';
import fs from 'node:fs';

// Stamped into every diagnostic, because a stale copilot-cli-lastturn.txt from
// a previous build is otherwise indistinguishable from a fresh one.
const VERSION = '2026-09-21.11';
import { CDP, findTab } from './lib-cdp.mjs';
import { expandPrompt, withStdin } from './lib-files.mjs';
import { askInPage } from './page-fn.mjs';
import { createAgentSession, runAgent, defaultTools } from './lib-agent.mjs';
import { resolveRoot, ToolError } from './lib-fstools.mjs';
import { loadMailConfig, configComplaint, mailTools, readMail, listFolders } from './lib-mailtool.mjs';

const CONFIG = {
  host: process.env.CDP_HOST || '127.0.0.1',
  port: Number(process.env.CDP_PORT || 9222),
  match: process.env.TAB_MATCH || 'copilot.cloud.microsoft',
  // Defaults pinned from a real probe of copilot.cloud.microsoft (2026-09-21).
  // Both fall back to auto-detection if they match nothing, so another chat UI
  // still works; override either with the env var.
  inputSelector: process.env.INPUT_SELECTOR || '#m365-chat-editor-target-element',
  sendSelector: process.env.SEND_SELECTOR || '',   // Copilot has none until you type; Enter sends
  answerSelector: process.env.ANSWER_SELECTOR || '[data-testid="markdown-reply"]',
  // The control the page shows while it is generating. Its disappearance is
  // how a turn knows it is finished; empty means auto-detect.
  stopSelector: process.env.STOP_SELECTOR || '',
  quietMs: Number(process.env.QUIET_MS || 1500),     // silence that means "done streaming"
  answerTimeoutMs: Number(process.env.ANSWER_TIMEOUT_MS || 120000),
};

// Local-only settings. Deliberately not part of CONFIG: CONFIG is serialized
// into the page, and the tab has no business knowing our working directory.
const LOCAL = {
  cwd: process.cwd(),
  maxFileBytes: Number(process.env.MAX_FILE_BYTES || 256 * 1024),
  maxPromptChars: Number(process.env.MAX_PROMPT_CHARS || 100000),
  stdinLabel: process.env.STDIN_LABEL || 'stdin',
};

let lastDebug = null;

// ------------------------------------------------------------------ CLI side

// Status and diagnostics go to stderr so that `chat.mjs "q" > answer.md` and
// `chat.mjs "q" | less` carry the answer and nothing else.
function out(s = '') { process.stdout.write(s + '\n'); }
function note(s = '') { process.stderr.write(s + '\n'); }

const HELP = `copilot-cli — talk to a chat web UI you are signed into, from the terminal.

  node chat.mjs                        interactive
  node chat.mjs "review @src/app.js"   one shot, answer on stdout
  git diff | node chat.mjs "review this"

Attach files by writing @path in the prompt. The file is read here and pasted
into the page for you:

  @src/app.js          the whole file
  @src/app.js:40-80    just those lines
  @"my notes.md"       a path with spaces
  @src/                a directory listing

Commands:  /probe  re-inventory the page   |  /debug   last turn's diagnostics
           /config show settings           |  /replay re-extract the last turn
           /agent  <task> — let it work on your files (see below)
           /help   this text               |  /quit

Agent mode gives the chat three verbs it does not natively have — read, write
and list files (plus edit for a targeted change) — by asking it to emit tagged
blocks that this CLI executes. Ported from the clichat harness.

  node chat.mjs --agent "add a --version flag to cli.js"
  node chat.mjs --agent "..." --root ../myproject --yes

Everything is confined to the workspace root (the current directory unless
--root says otherwise); paths outside it are refused, symlinks are not
followed, and nothing is ever executed. Writes and edits ask first, unless
--yes. Reads and listings do not ask.

With mail.env set up, the agent also gets a read-only view of your mail:

  node chat.mjs --mail-check          check the setup, one run, changes nothing
  node chat.mjs --agent "summarise anything from the last 10 days that needs a reply"

Mail is opened with EXAMINE and fetched with BODY.PEEK, so nothing is marked
as read and nothing on the server changes. Copy mail.env.example to mail.env
to configure it, or point --mail-env at another file.

Every turn writes copilot-cli-lastturn.txt (small, pasteable) and
copilot-cli-capture.json (the conversation region). If an answer comes out
wrong, the capture can be re-run offline — no browser, no Copilot, no second
manual attempt:

  node chat.mjs --replay copilot-cli-capture.json

Env: CDP_PORT CDP_HOST TAB_MATCH INPUT_SELECTOR SEND_SELECTOR ANSWER_SELECTOR
     STOP_SELECTOR QUIET_MS ANSWER_TIMEOUT_MS MAX_FILE_BYTES MAX_PROMPT_CHARS`;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}

/**
 * One round trip through the page: send exactly this text, return the answer.
 *
 * Nothing here expands @references. The agent loop sends file contents and
 * result tags through this, and an "@" inside a file is not an attachment.
 * Returns null when the turn produced no usable answer.
 */
async function askPage(cdp, full) {
  let res;
  try {
    res = await cdp.evalFn(askInPage, { ...CONFIG, prompt: full }, { timeoutMs: CONFIG.answerTimeoutMs + 8000 });
  } catch (e) {
    note('[bridge] turn failed: ' + e.message);
    return null;
  }
  lastDebug = res.debug;
  // Two files: a small one that is pasteable, and the DOM capture that makes
  // a wrong answer fixable without asking for another run.
  const capture = res.debug && res.debug.capture;
  if (res.debug) delete res.debug.capture;
  try {
    fs.writeFileSync('copilot-cli-lastturn.txt', JSON.stringify({
      version: VERSION, when: new Date().toISOString(),
      method: res.method, chars: (res.text || '').length, debug: res.debug,
    }, null, 2) + '\n');
    if (capture) fs.writeFileSync('copilot-cli-capture.json', JSON.stringify(capture, null, 1) + '\n');
  } catch { /* diagnostics are a nicety, never a reason to fail a turn */ }

  // Say so when the pick looks doubtful, rather than printing it as if sound.
  const best = res.debug && res.debug.candidates && res.debug.candidates[0];
  const doubtful = !res.text || (best && (best.mostlyButtons || best.containsPrompt))
    || (res.method || '').startsWith('body-suffix');
  if (doubtful) {
    note('[bridge] this answer may be wrong — the best candidate looked like page furniture.');
    note('[bridge] re-run it offline, as many times as you like: node chat.mjs --replay copilot-cli-capture.json');
    note('[bridge] if it is still wrong, that one file is the whole bug report — no second attempt needed.');
  }
  if (!res.ok) { note('[bridge] could not locate the input box. Run node probe.mjs and share the report.'); return null; }
  if (!res.text) {
    note('[bridge] sent, but extracted no answer text.');
    note('[bridge] node chat.mjs --replay copilot-cli-capture.json shows what was on the page and why each candidate lost.');
    return null;
  }
  return res.text;
}

/**
 * One prompt: expand @references, send it, print the answer.
 * Returns false when nothing was sent or nothing came back.
 */
async function runTurn(cdp, raw, stdinText) {
  const { prompt, attachments, warnings, error } = expandPrompt(raw, {
    cwd: LOCAL.cwd, maxFileBytes: LOCAL.maxFileBytes, maxPromptChars: LOCAL.maxPromptChars,
  });
  for (const w of warnings) note(`[attach] ${w}`);
  if (error) { note(`[attach] ${error}`); return false; }

  const full = stdinText ? withStdin(prompt, stdinText, LOCAL.stdinLabel) : prompt;
  for (const a of attachments) note(`[attach] ${a}`);
  if (stdinText) note('[attach] stdin');
  if (full.length !== raw.length) note(`[attach] sending ${full.length} chars`);

  const text = await askPage(cdp, full);
  if (text === null) return false;
  out(text);
  return true;
}

/**
 * Re-run extraction against a saved capture. No CDP, no page: the whole
 * point is that diagnosing a bad answer costs no further manual run.
 */
async function runReplay(file, args) {
  if (!file) { note('usage: node chat.mjs --replay copilot-cli-capture.json [--prompt ...]'); return false; }
  let capture;
  try {
    capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { note('could not read ' + file + ': ' + e.message); return false; }
  // Accept either the capture itself or a whole lastturn-style wrapper.
  if (!capture.tree && capture.debug && capture.debug.capture) capture = capture.debug.capture;
  const pi = args.indexOf('--prompt');
  const opts = pi !== -1 ? { prompt: args[pi + 1] } : {};
  const { replay, report } = await import('./lib-replay.mjs');
  let res;
  try {
    res = await replay(capture, opts);
  } catch (e) { note('replay failed: ' + e.message); return false; }
  note('copilot-cli ' + VERSION + ' — replay of ' + file);
  out(report(res));
  return true;
}

// ------------------------------------------------------------------ agent

// One line per event. The file contents the agent reads and writes are not
// echoed: they went past once already as the thing being worked on, and a
// terminal full of them hides the two lines that say what changed.
function agentUI() {
  return {
    step: (n, max) => note(`\n[agent] step ${n}/${max}`),
    prose: (t) => out(t),
    toolOk: (label, output) => {
      const lines = String(output || '').split('\n');
      const brief = lines.length <= 8 && String(output).length <= 400;
      note(`[agent] ${label}`);
      if (brief && output) note(lines.map((l) => '        ' + l).join('\n'));
      else note(`        → ${lines.length} lines`);
    },
    toolError: (label, msg) => note(`[agent] ${label} — FAILED: ${msg}`),
    skipped: (label) => note(`[agent] ${label} — skipped`),
    ignored: (n) => note(`[agent] ignored ${n} tag-like mention${n === 1 ? '' : 's'} that were not at the start of a line`),
  };
}

/**
 * Ask before anything is written.
 *
 * The model is imitating a protocol it was never trained on, so a wrong path
 * or a mangled body is an ordinary occurrence rather than an alarming one.
 * `question` is supplied by the caller because the REPL already owns stdin and
 * a second reader on it would fight the first.
 */
function approver({ yes, question }) {
  if (yes) return async () => true;
  if (!question) {
    return async (label) => { note(`[agent] would ${label} — refused: no terminal to confirm at (pass --yes)`); return false; };
  }
  return async (label) => {
    const a = (await question(`[agent] ${label} — allow? [y/N] `)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };
}

/**
 * The tools this run offers. Mail joins the set only when it is configured:
 * advertising a tool that cannot work teaches the model to keep trying it,
 * and its failures would fill the conversation.
 */
function toolsetFor(root, mailEnv) {
  const cfg = loadMailConfig({ root, envPath: mailEnv });
  if (!cfg.configured) return { tools: defaultTools, mail: cfg };
  return { tools: { ...defaultTools, ...mailTools(cfg) }, mail: cfg };
}

/** Run one agent task to completion over an already-attached page. */
async function runAgentTask(cdp, task, { root, yes, question, session, mailEnv }) {
  let sess = session;
  if (!sess) {
    try {
      sess = createAgentSession(resolveRoot(root || LOCAL.cwd));
    } catch (e) {
      note('[agent] ' + (e instanceof ToolError ? e.message : e.message));
      return false;
    }
  }
  note(`[agent] workspace: ${sess.root}`);

  const { tools, mail } = toolsetFor(sess.root, mailEnv);
  if (mail.configured) note(`[agent] mail: ${mail.user} at ${mail.host} (read-only)`);

  const res = await runAgent({
    ask: (prompt) => askPage(cdp, prompt),
    task,
    session: sess,
    approve: approver({ yes, question }),
    ui: agentUI(),
    tools,
  });
  if (res.done) note(`[agent] done in ${res.steps} step${res.steps === 1 ? '' : 's'}.`);
  else note(`[agent] stopped after ${res.steps} steps — ${res.stalled}.`);
  return !!res.done;
}

// ------------------------------------------------------------------- mail

/**
 * Everything about the mail setup, in one run.
 *
 * It exists so that setting this up costs one round trip rather than a series
 * of them: it settles reachability, authentication, folder naming, the
 * read-only open, the search window and the decoding of a real message in a
 * single command, and writes the lot to a file that can be pasted back. It
 * touches a live mailbox, so it reads exactly one message and prints every
 * IMAP command it sent, which is the evidence that nothing was mutated.
 */
async function runMailCheck(args) {
  const mailEnv = takeFlag(args, '--mail-env');
  const rootArg = takeFlag(args, '--root');
  const days = Number(takeFlag(args, '--days') || 3);
  const root = rootArg || LOCAL.cwd;
  const cfg = loadMailConfig({ root, envPath: mailEnv });

  const lines = [];
  const say = (t = '') => { lines.push(t); note(t); };

  say(`copilot-cli ${VERSION} — mail check`);
  say(`settings from: ${cfg.source || '(no mail.env found; using the environment)'}`);
  say(`host: ${cfg.host || '(unset)'}:${cfg.port} tls=${cfg.useTls ? 'on' : 'off'}`);
  say(`user: ${cfg.user || '(unset)'}  auth: ${cfg.oauthToken ? 'OAuth token' : cfg.pass ? 'password' : '(none)'}`);
  say(`redaction: ${cfg.redact ? 'on' : 'OFF'}`);
  say('');

  const complaint = configComplaint(cfg);
  if (complaint) {
    say(complaint);
    say('');
    say('mail.env takes lines like:');
    say('  MAIL_HOST=imap.example.com');
    say('  MAIL_USER=you@example.com');
    say('  MAIL_PASS=an-app-password');
    return false;
  }

  let ok = true;
  let commands = [];
  try {
    say(`folders on the server:`);
    const names = await listFolders(cfg);
    for (const n of names.split('\n')) say(`  ${n}`);
    say('');

    say(`reading the last ${days} day(s) of ${cfg.folder}, one message only...`);
    const res = await readMail({ ...cfg, limit: 1, totalChars: 4000, perMessageChars: 1200 }, { days, limit: 1 });
    commands = res.commands;
    say('');
    say('--- what the model would be given ---');
    say(res.text);
    say('--- end ---');
  } catch (e) {
    ok = false;
    say(`FAILED: ${e.message}`);
  }

  say('');
  say('every IMAP command this run sent:');
  for (const c of commands) say(`  ${c.replace(/^(LOGIN\s+\S+\s+).*$/i, '$1"[redacted]"')}`);
  const mutating = commands.filter((c) => /^(SELECT|STORE|APPEND|COPY|MOVE|EXPUNGE|CREATE|DELETE|RENAME|UID (STORE|COPY|MOVE))\b/i.test(c));
  say(mutating.length
    ? `WARNING: ${mutating.length} command(s) could have changed the server — this is a bug, please report it`
    : 'none of them can change anything on the server: no SELECT, no STORE, no flags, no deletes.');

  try {
    fs.writeFileSync('copilot-cli-mailcheck.txt', lines.join('\n') + '\n');
    note('');
    note('[mail] written to copilot-cli-mailcheck.txt — that file is the whole report.');
    note('[mail] it contains one real message; redact it before sharing if you need to.');
  } catch { /* the report on screen is the important one */ }
  return ok;
}

async function attach({ fatal = true } = {}) {
  let target;
  try {
    target = await findTab(CONFIG);
  } catch (e) {
    note(`\nCould not attach to Chrome at ${CONFIG.host}:${CONFIG.port}.`);
    note(e.message);
    note('\nLaunch Chrome with remote debugging first (README > "Launch Chrome"), open the chat, and retry.');
    if (!fatal) return null;
    process.exit(1);
  }
  note(`copilot-cli ${VERSION} — attached to: ${target.url}`);
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    await cdp.send('Runtime.enable');
  } catch (e) {
    note('[bridge] found the tab but could not open a DevTools session: ' + e.message);
    if (!fatal) return null;
    process.exit(1);
  }
  return cdp;
}

/**
 * A Copilot conversation is a single-page app: starting a new chat, or the tab
 * being closed and reopened, destroys the DevTools target underneath us. That
 * used to make every later turn fail with "CDP closed" until the CLI was
 * restarted. Reconnect instead, once, before each turn.
 */
async function ensureAttached(cdp) {
  if (cdp && cdp.live) return cdp;
  note('[bridge] the page connection went away (navigation, or the tab closed) — reattaching…');
  try { if (cdp) cdp.close(); } catch { /* already gone */ }
  const next = await attach({ fatal: false });
  if (!next) note('[bridge] still not attached; fix the tab and send again.');
  return next;
}

/** Removes `--name value` from args and returns the value, or undefined. */
function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [value] = args.splice(i, 2).slice(1);
  return value === undefined ? '' : value;
}

/** Removes a bare flag from args and says whether it was there. */
function takeBool(args, ...names) {
  let found = false;
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1) { args.splice(i, 1); found = true; }
  }
  return found;
}

/** A one-off readline question, for a one-shot run that has no REPL. */
function askOnce() {
  if (!process.stdin.isTTY) return null;
  return (text) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(text, (a) => { rl.close(); resolve(a); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) { out(VERSION); return; }
  if (args.includes('--help') || args.includes('-h')) { out(HELP); return; }

  // Offline: re-run extraction against a capture from an earlier turn.
  const replayFile = takeFlag(args, '--replay');
  if (replayFile !== undefined) { process.exit((await runReplay(replayFile, args)) ? 0 : 2); }

  // Mail setup needs no page at all, so it runs before attaching.
  if (args.includes('--mail-check')) {
    takeBool(args, '--mail-check');
    process.exit((await runMailCheck(args)) ? 0 : 1);
  }

  const mailEnv = takeFlag(args, '--mail-env');
  const rootArg = takeFlag(args, '--root');
  const yes = takeBool(args, '--yes', '-y');
  const task = takeFlag(args, '--agent');

  const argvPrompt = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  const piped = !process.stdin.isTTY;
  const stdinText = piped && task === undefined ? await readStdin() : '';

  let cdp = await attach();

  // One shot: an agent task.
  if (task !== undefined) {
    if (!task.trim()) { note('usage: node chat.mjs --agent "the task" [--root dir] [--yes]'); process.exit(2); }
    const okay = await runAgentTask(cdp, task, { root: rootArg, yes, question: askOnce(), mailEnv });
    cdp.close();
    process.exit(okay ? 0 : 1);
  }

  // One shot: a prompt on the command line, or anything piped in.
  if (argvPrompt || stdinText.trim()) {
    const okay = await runTurn(cdp, argvPrompt, stdinText);
    cdp.close();
    process.exit(okay ? 0 : 1);
  }

  note('Connected. Type a prompt, or /help. Attach files with @path.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '> ' });
  const ask = (text) => new Promise((resolve) => rl.question(text, resolve));
  // One agent session for the life of the REPL, so "now do the same to the
  // other handler" lands in a conversation that still remembers the files.
  let agentSession = null;
  rl.prompt();

  rl.on('line', async (line) => {
    const q = line.trim();
    if (!q) { rl.prompt(); return; }

    if (q === '/quit' || q === '/exit') { rl.close(); return; }
    if (q === '/help') { note(HELP); rl.prompt(); return; }
    if (q === '/config') { note(JSON.stringify({ ...CONFIG, ...LOCAL }, null, 2)); rl.prompt(); return; }
    if (q === '/agent' || q.startsWith('/agent ')) {
      const task = q.slice('/agent'.length).trim();
      if (!task) { note('usage: /agent <what you want done>'); rl.prompt(); return; }
      cdp = await ensureAttached(cdp);
      if (!cdp) { rl.prompt(); return; }
      if (!agentSession) {
        try {
          agentSession = createAgentSession(resolveRoot(rootArg || LOCAL.cwd));
        } catch (e) { note('[agent] ' + e.message); rl.prompt(); return; }
      }
      await runAgentTask(cdp, task, { yes, question: ask, session: agentSession, mailEnv });
      rl.prompt(); return;
    }
    if (q === '/replay' || q.startsWith('/replay ')) {
      await runReplay((q.split(/\s+/)[1] || 'copilot-cli-capture.json'), []);
      rl.prompt(); return;
    }
    if (q === '/debug') { note(lastDebug ? JSON.stringify(lastDebug, null, 2) : '(no turn yet)'); rl.prompt(); return; }
    if (q === '/probe') {
      cdp = await ensureAttached(cdp);
      if (!cdp) { rl.prompt(); return; }
      try {
        const { pageInventory } = await import('./probe-fn.mjs');
        const rep = await cdp.evalFn(pageInventory);
        note(JSON.stringify(rep.counts, null, 2));
      } catch (e) { note('probe unavailable inline; run: node probe.mjs  (' + e.message + ')'); }
      rl.prompt(); return;
    }

    out('');
    cdp = await ensureAttached(cdp);
    if (cdp) await runTurn(cdp, q, '');
    out('');
    rl.prompt();
  });

  rl.on('close', () => { if (cdp) cdp.close(); note('\nbye'); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });

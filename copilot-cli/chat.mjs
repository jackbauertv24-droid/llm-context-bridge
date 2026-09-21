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
const VERSION = '2026-09-21.3';
import { CDP, findTab } from './lib-cdp.mjs';
import { expandPrompt, withStdin } from './lib-files.mjs';

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

// ------------------------------------------------------------------ page side

// Serialized and run inside the tab. Self-contained: no outer references.
async function askInPage(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // A short, readable path for an element, so a bad pick can be turned into a
  // pinned selector without a separate probe run.
  const pathOf = (el) => {
    const bits = [];
    for (let e = el; e && e.nodeType === 1 && bits.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += '#' + e.id;
      const role = e.getAttribute('data-author-role') || e.getAttribute('data-testid') || e.getAttribute('role');
      if (role) s += `[${role}]`;
      const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      bits.unshift(s);
    }
    return bits.join(' > ');
  };
  const debug = { steps: [], candidates: [] };
  const log = (s) => debug.steps.push(s);

  // 1. locate the input box
  let input = cfg.inputSelector ? document.querySelector(cfg.inputSelector) : null;
  if (!input) {
    const cands = [...document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], input[type="text"]')]
      .filter(vis)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''}`.toLowerCase();
        let score = r.y;                                  // lower on screen is better
        if (/ask|message|copilot|chat|prompt|type/.test(label)) score += 100000;
        if (r.width > 300) score += 5000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    input = cands[0]?.el || null;
  }
  if (!input) { log('no input element found'); return { ok: false, debug }; }
  log(`input: <${input.tagName.toLowerCase()}> editable=${input.isContentEditable} aria="${input.getAttribute('aria-label') || ''}" at ${pathOf(input)}`);

  // 2. Baseline BEFORE the prompt is typed. Measuring it after meant that
  // clearing the composer on send shifted every later offset, which is what
  // chopped the first characters off the answer.
  const bodyBaseLen = document.body.innerText.length;
  const composer = input.closest('form') || input.parentElement;

  // 3. set text
  input.focus();
  if (input.isContentEditable) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, cfg.prompt);   // fires beforeinput/input for React/Lexical/ProseMirror
    if (!input.innerText.trim()) { input.textContent = cfg.prompt; input.dispatchEvent(new InputEvent('input', { bubbles: true })); }
  } else {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, cfg.prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(60);
  log(`text set, input now holds ${(input.value || input.innerText || '').length} chars`);

  const answerBlocks = () => {
    if (cfg.answerSelector) {
      const pinned = [...document.querySelectorAll(cfg.answerSelector)].filter(vis);
      if (pinned.length) return pinned;
    }
    const sel = '[data-author-role="assistant"], [data-testid*="assistant" i], [class*="assistant" i], [class*="response" i], [role="listitem"]';
    return [...document.querySelectorAll(sel)].filter(vis);
  };
  const baseBlocks = answerBlocks();
  const baseSet = new Set(baseBlocks);
  const baseCount = baseBlocks.length;

  // 4. Watch what the page adds. Tracking the actual added nodes is what makes
  // extraction independent of the page's class names: the answer is the
  // largest new block that is not our own echoed prompt.
  const added = new Set();
  let lastMutation = Date.now();
  const obs = new MutationObserver((muts) => {
    lastMutation = Date.now();
    for (const m of muts) {
      if (m.type === 'childList') { for (const n of m.addedNodes) if (n.nodeType === 1) added.add(n); }
      else if (m.target) { const p = m.target.parentElement; if (p) added.add(p); }
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true });

  // 5. send: Enter first, click a send button as fallback
  const fireEnter = (el) => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  };
  fireEnter(input);
  await sleep(400);
  const stillHasText = (input.value || input.innerText || '').includes(cfg.prompt.slice(0, 20));
  if (stillHasText) {
    let btn = cfg.sendSelector ? document.querySelector(cfg.sendSelector) : null;
    if (!btn) {
      btn = [...document.querySelectorAll('button, [role="button"]')].filter(vis).find((el) => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.toLowerCase();
        return /send|submit/.test(label) && !(el.disabled || el.getAttribute('aria-disabled') === 'true');
      });
    }
    if (btn) { btn.click(); log(`Enter left text in place; clicked send button aria="${btn.getAttribute('aria-label') || ''}"`); }
    else log('Enter left text in place and no send button found — send may have failed');
  } else {
    log('sent via Enter');
  }

  // 6. wait for streaming to settle
  await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const stop = document.querySelector('button[aria-label*="stop" i], button[title*="stop" i], [data-testid*="stop" i]');
      // 'The page got 5 characters longer' was satisfied the moment our own
      // prompt was echoed, so a quiet second while Copilot was still thinking
      // counted as a finished answer. Require either a genuinely new answer
      // block, or growth beyond the prompt we just added.
      const newBlock = answerBlocks().some((el) => !baseSet.has(el));
      const grew = newBlock || document.body.innerText.length > bodyBaseLen + cfg.prompt.length + 20;
      const quiet = Date.now() - lastMutation > cfg.quietMs;
      if ((quiet && !stop && grew) || Date.now() - t0 > cfg.answerTimeoutMs) {
        clearInterval(iv); resolve();
      }
    }, 250);
  });
  obs.disconnect();

  // 7. extract. Page furniture that rides along with the answer region.
  const JUNK = [
    /^AI-generated content may be incorrect\.?$/i,
    /^Message Copilot\.?$/i,
    /^(Copilot|You said|Copilot said)$/i,
    /^(Copy|Edit|Like|Dislike|Retry|Regenerate|Share|Export|Stop responding)$/i,
  ];
  const clean = (t) => t.split('\n').filter((ln) => !JUNK.some((re) => re.test(ln.trim()))).join('\n').trim();

  const promptHead = norm(cfg.prompt).slice(0, 60);
  let text = '';
  let method = '';

  // 7a. An element matching the answer selector that was not there before we
  // sent. This is the reliable path: the selector is a fact from the probe,
  // everything below it is inference.
  const afterBlocks = answerBlocks();
  const freshBlocks = afterBlocks.filter((el) => !baseSet.has(el));
  if (freshBlocks.length) {
    text = clean(freshBlocks[freshBlocks.length - 1].innerText || '');
    method = `answer-selector new block (${freshBlocks.length} new, ${pathOf(freshBlocks[freshBlocks.length - 1])})`;
  } else if (cfg.answerSelector && afterBlocks.length > baseCount) {
    text = clean(afterBlocks[afterBlocks.length - 1].innerText || '');
    method = `answer-selector last block (count ${baseCount}->${afterBlocks.length})`;
  }

  // 7b. Otherwise, the largest block the page added. A MutationObserver reports
  // only the outermost node of an insertion, so when the page appends a whole
  // turn — your message and the reply together — the one candidate it hands us
  // contains our own prompt. Discarding it outright left nothing but the
  // suggestion chips, which is exactly what got printed as an "answer". So
  // descend into such a container instead of dropping it.
  if (!text) {
    const answerParts = (el, depth = 0) => {
      const t = norm(el.innerText || '');
      if (!t) return [];
      if (depth < 6 && promptHead && t.includes(promptHead)) {
        return [...el.children].flatMap((c) => answerParts(c, depth + 1));
      }
      return [el];
    };
    const fresh = [...added].filter((el) => el.isConnected && el.nodeType === 1
      && !(composer && composer.contains(el)) && !el.contains(input));
    const useful = fresh.flatMap((el) => answerParts(el));
    const tops = useful.filter((el) => !useful.some((o) => o !== el && o.contains(el)));
    tops.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
    debug.candidates = tops.slice(0, 5).map((el) => ({ path: pathOf(el), chars: (el.innerText || '').length }));
    if (tops.length) {
      text = clean(tops[0].innerText || '');
      method = `added-node[largest] of ${tops.length} (${pathOf(tops[0])})`;
    }
  }

  // 7c. Last resort: whatever text the page gained. Baselined before typing,
  // so the prompt echo is inside the slice and gets stripped rather than
  // eating the start of the answer.
  if (!text) {
    const suffix = document.body.innerText.slice(bodyBaseLen);
    const idx = suffix.indexOf(cfg.prompt.slice(0, 20));
    const cut = idx !== -1 ? suffix.slice(idx + cfg.prompt.length) : suffix;
    text = clean(cut);
    method = 'body-innerText suffix (heuristic; pin ANSWER_SELECTOR from debug.candidates)';
  }

  // A turn that added no answer block at all almost always means the send did
  // not take, which is a different problem from a bad selector — say which.
  if (afterBlocks.length === baseCount && !freshBlocks.length) {
    log(`WARNING: no new answer block appeared (still ${baseCount}); the send may not have registered`);
  }

  log(`extracted via ${method}, ${text.length} chars`);
  return { ok: true, text, method, debug };
}

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

Commands:  /probe  re-inventory the page   |  /debug  last turn's diagnostics
           /config  show settings          |  /help   this text   |  /quit

Env: CDP_PORT CDP_HOST TAB_MATCH INPUT_SELECTOR SEND_SELECTOR ANSWER_SELECTOR
     QUIET_MS ANSWER_TIMEOUT_MS MAX_FILE_BYTES MAX_PROMPT_CHARS`;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
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

  let res;
  try {
    res = await cdp.evalFn(askInPage, { ...CONFIG, prompt: full }, { timeoutMs: CONFIG.answerTimeoutMs + 8000 });
  } catch (e) {
    note('[bridge] turn failed: ' + e.message);
    return false;
  }
  lastDebug = res.debug;
  try {
    fs.writeFileSync('copilot-cli-lastturn.txt', JSON.stringify({ version: VERSION, when: new Date().toISOString(), method: res.method, chars: (res.text || '').length, debug: res.debug }, null, 2) + '\n');
  } catch { /* diagnostics are a nicety, never a reason to fail a turn */ }
  if (res.method && res.method.startsWith('body-innerText')) {
    note('[bridge] fell back to whole-page text; paste copilot-cli-lastturn.txt to get the answer selector pinned.');
  }
  if (!res.ok) { note('[bridge] could not locate the input box. Run node probe.mjs and share the report.'); return false; }
  if (!res.text) { note('[bridge] sent, but extracted no answer text. Run /debug — likely an ANSWER_SELECTOR tweak.'); return false; }
  out(res.text);
  return true;
}

async function attach() {
  let target;
  try {
    target = await findTab(CONFIG);
  } catch (e) {
    note(`\nCould not attach to Chrome at ${CONFIG.host}:${CONFIG.port}.`);
    note(e.message);
    note('\nLaunch Chrome with remote debugging first (README > "Launch Chrome"), open the chat, and retry.');
    process.exit(1);
  }
  note(`copilot-cli ${VERSION} — attached to: ${target.url}`);
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  return cdp;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) { out(VERSION); return; }
  if (args.includes('--help') || args.includes('-h')) { out(HELP); return; }

  const argvPrompt = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  const piped = !process.stdin.isTTY;
  const stdinText = piped ? await readStdin() : '';

  const cdp = await attach();

  // One shot: a prompt on the command line, or anything piped in.
  if (argvPrompt || stdinText.trim()) {
    const okay = await runTurn(cdp, argvPrompt, stdinText);
    cdp.close();
    process.exit(okay ? 0 : 1);
  }

  note('Connected. Type a prompt, or /help. Attach files with @path.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: '> ' });
  rl.prompt();

  rl.on('line', async (line) => {
    const q = line.trim();
    if (!q) { rl.prompt(); return; }

    if (q === '/quit' || q === '/exit') { rl.close(); return; }
    if (q === '/help') { note(HELP); rl.prompt(); return; }
    if (q === '/config') { note(JSON.stringify({ ...CONFIG, ...LOCAL }, null, 2)); rl.prompt(); return; }
    if (q === '/debug') { note(lastDebug ? JSON.stringify(lastDebug, null, 2) : '(no turn yet)'); rl.prompt(); return; }
    if (q === '/probe') {
      try {
        const { pageInventory } = await import('./probe-fn.mjs');
        const rep = await cdp.evalFn(pageInventory);
        note(JSON.stringify(rep.counts, null, 2));
      } catch (e) { note('probe unavailable inline; run: node probe.mjs  (' + e.message + ')'); }
      rl.prompt(); return;
    }

    out('');
    await runTurn(cdp, q, '');
    out('');
    rl.prompt();
  });

  rl.on('close', () => { cdp.close(); note('\nbye'); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });

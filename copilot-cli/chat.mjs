#!/usr/bin/env node
/**
 * Interactive CLI over a chat web UI you are already signed into.
 *
 * It attaches to a Chrome you launched with remote debugging, types your prompt
 * into the page's chat box, waits for the rendered answer to finish streaming,
 * and prints it. Auth stays entirely in your browser session; this reads and
 * writes only visible DOM, never network traffic, headers, cookies or tokens.
 *
 *   node chat.mjs
 *   > your question
 *   ...answer...
 *   > /quit
 *
 * Commands:  /probe  re-inventory the page   |   /debug  last turn's diagnostics
 *            /config  show selectors/timings |   /quit
 *
 * Selectors auto-detect by default. Once probe.mjs shows the real DOM, pin them
 * with env vars (INPUT_SELECTOR, SEND_SELECTOR, ANSWER_SELECTOR) for reliability.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import { CDP, findTab } from './lib-cdp.mjs';

const CONFIG = {
  host: process.env.CDP_HOST || '127.0.0.1',
  port: Number(process.env.CDP_PORT || 9222),
  match: process.env.TAB_MATCH || 'copilot.cloud.microsoft',
  inputSelector: process.env.INPUT_SELECTOR || '',   // '' = auto-detect
  sendSelector: process.env.SEND_SELECTOR || '',
  answerSelector: process.env.ANSWER_SELECTOR || '',
  quietMs: Number(process.env.QUIET_MS || 1500),     // silence that means "done streaming"
  answerTimeoutMs: Number(process.env.ANSWER_TIMEOUT_MS || 120000),
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
  const debug = { steps: [] };
  const log = (s) => debug.steps.push(s);

  // 1. locate input
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
  log(`input: <${input.tagName.toLowerCase()}> editable=${input.isContentEditable} aria="${input.getAttribute('aria-label') || ''}"`);

  // 2. set text
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

  // 3. baseline of answer region before sending
  const answerBlocks = () => {
    if (cfg.answerSelector) return [...document.querySelectorAll(cfg.answerSelector)].filter(vis);
    // heuristic: elements whose role/class hint at an assistant turn
    const sel = '[data-author-role="assistant"], [data-testid*="assistant" i], [class*="assistant" i], [class*="response" i], [role="listitem"]';
    return [...document.querySelectorAll(sel)].filter(vis);
  };
  const baseCount = answerBlocks().length;
  const bodyBaseLen = document.body.innerText.length;
  log(`baseline answer-blocks=${baseCount}`);

  // 4. send: Enter first, click a send button as fallback
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

  // 5. wait for streaming to settle
  await new Promise((resolve) => {
    let last = Date.now();
    const obs = new MutationObserver(() => { last = Date.now(); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    const t0 = Date.now();
    const iv = setInterval(() => {
      const stop = document.querySelector('button[aria-label*="stop" i], button[title*="stop" i], [data-testid*="stop" i]');
      const grew = answerBlocks().length > baseCount || document.body.innerText.length > bodyBaseLen + 5;
      const quiet = Date.now() - last > cfg.quietMs;
      if ((quiet && !stop && grew) || Date.now() - t0 > cfg.answerTimeoutMs) {
        clearInterval(iv); obs.disconnect(); resolve();
      }
    }, 250);
  });

  // 6. extract newest answer
  let text = '';
  let method = '';
  const blocks = answerBlocks();
  if (blocks.length > baseCount || (blocks.length && cfg.answerSelector)) {
    text = (blocks[blocks.length - 1].innerText || '').trim();
    method = `answer-block[last] (count ${baseCount}->${blocks.length})`;
  } else {
    // fallback: the text appended to the page after we sent
    const full = document.body.innerText;
    text = full.slice(bodyBaseLen).trim();
    method = 'body-innerText suffix (heuristic; set ANSWER_SELECTOR once probe shows the right node)';
  }
  log(`extracted via ${method}, ${text.length} chars`);
  return { ok: true, text, method, debug };
}

// ------------------------------------------------------------------ CLI side

function line(s = '') { process.stdout.write(s + '\n'); }

async function main() {
  let target;
  try {
    target = await findTab(CONFIG);
  } catch (e) {
    line(`\nCould not attach to Chrome at ${CONFIG.host}:${CONFIG.port}.`);
    line(e.message);
    line('\nLaunch Chrome with remote debugging first (README > "Launch Chrome"), open the chat, and retry.');
    process.exit(1);
  }
  line(`Attached to: ${target.url}`);

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  line('Connected. Type a prompt, or /quit. First answer confirms the bridge works.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  rl.on('line', async (raw) => {
    const q = raw.trim();
    if (!q) { rl.prompt(); return; }

    if (q === '/quit' || q === '/exit') { rl.close(); return; }
    if (q === '/config') { line(JSON.stringify(CONFIG, null, 2)); rl.prompt(); return; }
    if (q === '/debug') { line(lastDebug ? JSON.stringify(lastDebug, null, 2) : '(no turn yet)'); rl.prompt(); return; }
    if (q === '/probe') {
      try {
        const { pageInventory } = await import('./probe-fn.mjs');
        const rep = await cdp.evalFn(pageInventory);
        line(JSON.stringify(rep.counts, null, 2));
      } catch (e) { line('probe unavailable inline; run: node probe.mjs  (' + e.message + ')'); }
      rl.prompt(); return;
    }

    try {
      const res = await cdp.evalFn(askInPage, { ...CONFIG, prompt: q }, { timeoutMs: CONFIG.answerTimeoutMs + 8000 });
      lastDebug = res.debug;
      if (!res.ok) { line('[bridge] could not locate the input box. Run /debug, then node probe.mjs and share the report.'); }
      else if (!res.text) { line('[bridge] sent, but extracted no answer text. Run /debug — likely an ANSWER_SELECTOR tweak.'); }
      else { line('\n' + res.text + '\n'); }
    } catch (e) {
      line('[bridge] turn failed: ' + e.message);
    }
    rl.prompt();
  });

  rl.on('close', () => { cdp.close(); line('\nbye'); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });

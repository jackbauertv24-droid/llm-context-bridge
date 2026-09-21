/**
 * The function that runs inside the page.
 *
 * It lives in its own module so it can be exercised against a DOM stub in
 * test/extract.test.mjs — the extraction rules are the part that has cost
 * real debugging rounds, and they should not need a browser to check.
 *
 * It is serialized with Function.prototype.toString and evaluated in the tab,
 * so it must stay entirely self-contained: no imports, no outer references.
 */

// Serialized and run inside the tab. Self-contained: no outer references.
export async function askInPage(cfg) {
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

  // 7. Extract. Every strategy runs on every turn and all of them are
  // recorded; the best-scoring one wins. Running them one per round was
  // costing a manual re-run to learn each DOM fact, so a single turn now
  // carries the answer and the comparison that would have been the next round.
  const results = [];
  const record = (name, el, raw) => {
    const t = clean(raw || '');
    if (!t) { results.push({ name, path: el ? pathOf(el) : '', chars: 0, skipped: 'empty' }); return; }
    results.push({ name, el, text: t, path: el ? pathOf(el) : '', chars: t.length, sample: t.slice(0, 160) });
  };

  // A: an element matching the answer selector that was not there before.
  const afterBlocks = answerBlocks();
  const freshBlocks = afterBlocks.filter((el) => !baseSet.has(el));
  if (freshBlocks.length) record('answer-selector/new', freshBlocks[freshBlocks.length - 1], freshBlocks[freshBlocks.length - 1].innerText);
  // B: the last one matching it, new or not — covers a reply streamed into an
  // element that already existed when we sent.
  if (afterBlocks.length) record('answer-selector/last', afterBlocks[afterBlocks.length - 1], afterBlocks[afterBlocks.length - 1].innerText);

  // C: the largest block the page added. A MutationObserver reports only the
  // outermost node of an insertion, so when the page appends a whole turn the
  // one candidate it yields contains our own prompt; descend rather than drop.
  const answerParts = (el, depth = 0) => {
    const t = norm(el.innerText || '');
    if (!t) return [];
    if (depth < 6 && promptHead && t.includes(promptHead)) return [...el.children].flatMap((c) => answerParts(c, depth + 1));
    return [el];
  };
  const fresh = [...added].filter((el) => el.isConnected && el.nodeType === 1
    && !(composer && composer.contains(el)) && !el.contains(input));
  const useful = fresh.flatMap((el) => answerParts(el));
  const tops = useful.filter((el) => !useful.some((o) => o !== el && o.contains(el)));
  tops.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
  for (const el of tops.slice(0, 3)) record('added-node', el, el.innerText);

  // D: whatever text the page gained, prompt echo stripped.
  const suffix = document.body.innerText.slice(bodyBaseLen);
  const cutAt = suffix.indexOf(cfg.prompt.slice(0, 20));
  record('body-suffix', null, cutAt !== -1 ? suffix.slice(cutAt + cfg.prompt.length) : suffix);

  // Scoring. Longer is better, but structure beats length: text that lives
  // inside buttons is interface — the suggestion chips that once got printed
  // as an answer — and text containing our own prompt is the echo.
  const scoreOf = (r) => {
    if (!r.text) return -1e9;
    let s = Math.min(r.chars, 4000);
    if (r.el) {
      try {
        if (cfg.answerSelector && (r.el.matches(cfg.answerSelector) || r.el.closest(cfg.answerSelector))) s += 5000;
      } catch { /* a malformed selector must not break the turn */ }
      const btnChars = [...r.el.querySelectorAll('button, [role="button"]')]
        .reduce((n, b) => n + norm(b.innerText || '').length, 0);
      const total = norm(r.el.innerText || '').length || 1;
      if (btnChars / total > 0.6) { s -= 20000; r.mostlyButtons = true; }
    }
    if (promptHead && norm(r.text).includes(promptHead)) { s -= 8000; r.containsPrompt = true; }
    return s;
  };
  for (const r of results) r.score = scoreOf(r);
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const winner = ranked.find((r) => r.text);

  text = winner ? winner.text : '';
  method = winner ? `${winner.name} (score ${winner.score}, ${winner.path || 'page text'})` : 'nothing extracted';
  debug.candidates = ranked.map(({ el, text: _t, ...rest }) => rest);

  if (afterBlocks.length === baseCount && !freshBlocks.length) {
    log(`WARNING: no new answer block appeared (still ${baseCount}); the send may not have registered`);
  }

  // A structured dump of the conversation region, rich enough that
  // lib-replay.mjs can rebuild it offline and re-run this very function
  // against it. A wrong answer is therefore diagnosed, fixed and regression
  // tested from this file alone, with no further manual run.
  const LIMITS = { depth: 9, kids: 40, text: 4000 };
  const snapshot = (el, depth = 0) => {
    const all = [...el.children];
    const kids = depth < LIMITS.depth ? all.slice(0, LIMITS.kids) : [];
    const own = el.innerText || '';
    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.getAttribute('class') || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      role: el.getAttribute('role') || undefined,
      label: el.getAttribute('aria-label') || undefined,
      chars: own.length,
    };
    if (kids.length) {
      node.children = kids.map((c) => snapshot(c, depth + 1));
      if (all.length > kids.length) node.clipped = all.length - kids.length;
    } else {
      node.text = own.slice(0, LIMITS.text);
      if (own.length > LIMITS.text) node.clipped = own.length - LIMITS.text;
      if (all.length) node.clippedDepth = all.length;
    }
    return node;
  };
  const describe = (el) => (el ? {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: el.getAttribute('class') || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    role: el.getAttribute('role') || undefined,
    label: el.getAttribute('aria-label') || undefined,
    contenteditable: el.getAttribute('contenteditable') || undefined,
  } : undefined);
  try {
    const region = document.querySelector('[data-testid="MessageListContainer"], [role="feed"]')
      || (winner && winner.el && winner.el.closest('[id*="message" i], [class*="message" i]'))
      || document.body;
    // The turns usually sit one or two wrappers below the region; index the
    // level that actually holds them, so a replay can rebuild the page as it
    // stood before this exchange rather than as an empty feed.
    let list = region;
    const listPath = [];
    while (list.children.length === 1 && list.children[0].children.length) { listPath.push(0); list = list.children[0]; }
    debug.capture = {
      region: pathOf(region),
      listPath,
      prompt: cfg.prompt,
      selectors: { input: cfg.inputSelector, send: cfg.sendSelector, answer: cfg.answerSelector },
      input: describe(input),
      winnerPath: winner ? winner.path : null,
      // Which of the region's top-level turns the page added for this
      // exchange, so a replay appends exactly those and nothing else.
      addedTops: [...list.children]
        .map((c, i) => (fresh.some((f) => c === f || c.contains(f) || f.contains(c)) ? i : -1))
        .filter((i) => i >= 0),
      tree: snapshot(region),
    };
  } catch (e) { debug.capture = { error: String(e && e.message) }; }

  log(`extracted via ${method}, ${text.length} chars`);
  return { ok: true, text, method, debug };
}


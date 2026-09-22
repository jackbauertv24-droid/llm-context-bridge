/**
 * The function that runs inside the page.
 *
 * It lives in its own module so lib-replay.mjs can run it against a saved
 * capture with no browser — the extraction rules are the part that has cost
 * real debugging rounds, and re-checking them should not need another one.
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
    if (!input.innerText.trim()) { input.textContent = cfg.prompt; }
    // Ensure React/Lexical/ProseMirror registers the text insertion and updates character count / send button state
    try {
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: cfg.prompt }));
    } catch { /* ignore if unsupported */ }
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, cfg.prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(100);
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
  const fireEnter = (el, ctrl = false) => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
        ctrlKey: ctrl, metaKey: ctrl,
      }));
    }
  };
  // The page says when it is done: it shows a stop control while generating
  // and removes it when it finishes. Watching for that is exact, where
  // waiting for the page to fall silent is a guess -- and an expensive one,
  // because the page keeps moving after the last word of the answer
  // (suggestion chips, the copy and feedback toolbar, the "AI-generated
  // content may be incorrect" footer) and each of those resets the silence.
  //
  // Visibility is checked, not just presence: a stop control left in the DOM
  // but hidden would otherwise read as "still generating" until the timeout.
  const stopSelector = cfg.stopSelector
    || 'button[aria-label*="stop" i], button[title*="stop" i], [data-testid*="stop" i]';
  const stopNow = () => {
    try {
      for (const el of document.querySelectorAll(stopSelector)) if (vis(el)) return el;
    } catch { /* a malformed override must not break the turn */ }
    return null;
  };

  const TICK = 100;
  const wait = { via: 'timeout', sawStop: false, ms: 0, selector: stopSelector };
  let goneFor = 0;

  // Send attempt 1: Enter
  fireEnter(input);
  if (cfg.prompt.includes('\n')) {
    // In rich text editors (Lexical, ProseMirror), multiline text often requires Ctrl+Enter to submit
    fireEnter(input, true);
  }

  const sentAt = Date.now();
  // Started here, not after the send check below: a short answer can be over
  // within that 400ms, and a signal we were not yet watching for is no signal.
  const watchStop = setInterval(() => {
    if (stopNow()) { wait.sawStop = true; goneFor = 0; } else { goneFor += TICK; }
  }, TICK);

  const inputRect = typeof input.getBoundingClientRect === 'function' ? input.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
  const composer = (typeof input.closest === 'function' && (input.closest('form, [role="region"], [class*="composer" i], [class*="chat-input" i], [data-testid*="composer" i]')
    || input.parentElement?.parentElement?.parentElement
    || input.parentElement?.parentElement))
    || input.parentElement;

  const describeBtn = (btn) => {
    const aria = btn.getAttribute('aria-label') || '';
    const title = btn.getAttribute('title') || '';
    const testid = btn.getAttribute('data-testid') || btn.getAttribute('data-test-id') || '';
    const id = btn.id || '';
    const text = btn.innerText || btn.textContent || '';
    let innerAria = '';
    let innerTitle = '';
    try {
      innerAria = btn.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
      innerTitle = btn.querySelector('title')?.textContent || '';
    } catch { /* ignore */ }
    const full = `${aria} ${title} ${testid} ${id} ${text} ${innerAria} ${innerTitle}`.toLowerCase();
    const isNeg = /feedback|report|help|attach|file|upload|voice|mic|audio|cancel|dismiss|close|clear|delete|history|menu|settings|expand|collapse/i.test(full);
    const isPos = /send|submit|ask|arrow/i.test(full) || btn.type === 'submit' || btn.getAttribute('type') === 'submit';
    const r = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const near = r.y >= (inputRect.y - 120) && r.y <= (inputRect.y + inputRect.height + 350);
    return { btn, full, isNeg, isPos, near, r };
  };

  const findSendButton = () => {
    // Priority 1: Explicit pinned selector
    if (cfg.sendSelector) {
      try {
        const el = document.querySelector(cfg.sendSelector);
        if (el && vis(el)) return el;
      } catch { /* malformed override fallback */ }
    }

    // Priority 2: Look inside composer first (closest to input, ignores header buttons like "Send feedback")
    if (composer && typeof composer.querySelectorAll === 'function') {
      const composerButtons = [...composer.querySelectorAll('button, [role="button"]')].filter(vis).map(describeBtn);
      const pos = composerButtons.find((d) => d.isPos && !d.isNeg);
      if (pos) return pos.btn;

      const sub = composerButtons.find((d) => (d.btn.type === 'submit' || d.btn.getAttribute('type') === 'submit') && !d.isNeg);
      if (sub) return sub.btn;

      const nonNeg = composerButtons.filter((d) => !d.isNeg && d.btn !== input);
      if (nonNeg.length === 1) return nonNeg[0].btn;
      if (nonNeg.length > 1) {
        // Submit button is usually rightmost / bottommost in the composer
        nonNeg.sort((a, b) => (b.r.x + b.r.y) - (a.r.x + a.r.y));
        return nonNeg[0].btn;
      }
    }

    // Priority 3: Document-wide search: MUST be near the input box and NOT negative
    const allButtons = [...document.querySelectorAll('button, [role="button"]')].filter(vis).map(describeBtn);
    const nearPos = allButtons.find((d) => d.near && d.isPos && !d.isNeg);
    if (nearPos) return nearPos.btn;

    // Priority 4: Any button in the lower half of viewport matching positive
    const lowerPos = allButtons.find((d) => d.isPos && !d.isNeg && d.r.y > (window.innerHeight * 0.35));
    if (lowerPos) return lowerPos.btn;

    return null;
  };

  const isEnabled = (el) => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';

  const clickButton = (btn) => {
    if (!btn) return;
    try { btn.focus(); } catch { /* ignore */ }
    const rect = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const cx = rect.x + (rect.width || 0) / 2;
    const cy = rect.y + (rect.height || 0) / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: typeof window !== 'undefined' ? window : null,
      clientX: cx,
      clientY: cy,
      button: 0,
      buttons: 1,
    };
    try {
      if (typeof PointerEvent !== 'undefined') {
        btn.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        btn.dispatchEvent(new MouseEvent('mousedown', eventInit));
        btn.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, buttons: 0 }));
        btn.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
      }
    } catch { /* fallback */ }
    try {
      btn.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 }));
    } catch { /* fallback */ }
    if (typeof btn.click === 'function') {
      try { btn.click(); } catch { /* ignore */ }
    }
    const kid = btn.children && btn.children[0];
    if (kid && typeof kid.dispatchEvent === 'function') {
      try { kid.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 })); } catch { /* ignore */ }
    }
    const form = (typeof btn.closest === 'function' && btn.closest('form')) || (typeof input.closest === 'function' && input.closest('form'));
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(btn); } catch { /* ignore */ }
    }
  };

  const hasText = () => {
    const val = (input.value || input.innerText || '').trim();
    const promptLead = norm(cfg.prompt).slice(0, 20);
    return val.length > 0 && val.includes(promptLead);
  };

  // Initial pause to see if Enter cleared the input or generation started
  await sleep(300);

  const SEND_WAIT_MS = 3500;
  const pollStart = Date.now();
  let clickedBtn = null;

  while (hasText() && !wait.sawStop && !stopNow() && (Date.now() - pollStart < SEND_WAIT_MS)) {
    const btn = findSendButton();
    if (btn && isEnabled(btn)) {
      clickButton(btn);
      clickedBtn = btn;
      await sleep(300);
      if (!hasText() || wait.sawStop || stopNow()) break;
    }
    await sleep(150);
  }

  if (!hasText() || wait.sawStop || stopNow()) {
    log(`sent successfully (via ${clickedBtn ? `button aria="${clickedBtn.getAttribute('aria-label') || ''}"` : 'Enter'})`);
  } else {
    // If text remains and generation hasn't started, make one last forced click if button exists
    const btn = findSendButton();
    if (btn) {
      log(`waited ${Date.now() - pollStart}ms for send button; forced click aria="${btn.getAttribute('aria-label') || ''}" text="${(btn.textContent || '').trim().slice(0, 30)}"`);
      clickButton(btn);
    } else {
      log('Enter and button click both failed: text remains in input and no send button found');
    }
  }

  // 6. wait for the answer to be finished
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      // 'The page got 5 characters longer' was satisfied the moment our own
      // prompt was echoed, so a quiet second while Copilot was still thinking
      // counted as a finished answer. Require either a genuinely new answer
      // block, or growth beyond the prompt we just added.
      const newBlock = answerBlocks().some((el) => !baseSet.has(el));
      const grew = newBlock || document.body.innerText.length > bodyBaseLen + cfg.prompt.length + 20;

      // The exact signal: we watched it generate, and it has stopped. Two
      // consecutive absences, so a re-render that briefly drops the control
      // does not end the turn early.
      const finished = wait.sawStop && goneFor >= TICK * 2;
      // The fallback, for a page that never showed a stop control at all.
      const quiet = !wait.sawStop && Date.now() - lastMutation > cfg.quietMs;
      // And a safety net: a stop control that is still there long after the
      // page stopped changing is stale, not generating. Without this the turn
      // would sit until the answer timeout -- two minutes for a page that
      // finished seconds ago.
      const stale = wait.sawStop && Date.now() - lastMutation > cfg.quietMs * 3;

      if (grew && (finished || quiet || stale)) {
        wait.via = finished ? 'stop-control-gone' : stale ? 'stale-stop-control' : 'quiet';
        wait.ms = Date.now() - sentAt;
        clearInterval(iv); resolve();
        return;
      }

      // Short-circuit: If after 8 seconds no generation ever started and prompt text remains in input,
      // the send failed to trigger. Do not freeze the terminal for 120 seconds!
      if (!wait.sawStop && !grew && hasText() && (Date.now() - sentAt > 8000)) {
        wait.via = 'send-not-triggered';
        wait.ms = Date.now() - sentAt;
        clearInterval(iv); resolve();
        return;
      }

      if (Date.now() - sentAt > cfg.answerTimeoutMs) {
        wait.ms = Date.now() - sentAt;
        clearInterval(iv); resolve();
      }
    }, TICK);
  });
  clearInterval(watchStop);
  debug.wait = wait;
  log(`waited ${wait.ms}ms, ended via ${wait.via}${wait.sawStop ? '' : ' (no stop control was ever visible)'}`);
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
  // against it, so a wrong answer is diagnosed and the fix checked from this
  // file alone, with no further manual run.
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


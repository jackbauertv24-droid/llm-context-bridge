// Record the real page, once, so the replica can stop being a guess.
//
// Every failure in this bridge has had the same cause: a belief about the
// page that was never checked against the page. The composer clears on send
// (it does not always). A visible stop control means a response is in flight
// (on this page one is always there). The DOM goes quiet when an answer
// finishes (it never goes quiet at all). Each was reasoned out, written into
// a hand-made replica, confirmed against that replica, and shipped broken.
//
// This runs inside the tab and writes down what is actually there and what
// actually happens during one turn. The result is meant to be read by
// whoever is fixing this, and to become a fixture the tests run against, so
// that the replica is answerable to the page rather than to an idea of it.
//
// NOTHING OF THE CONVERSATION IS RECORDED. Element shapes, selectors,
// attributes, geometry, counts and timings — all of which are needed — and
// text only ever as a length. The single string in the output is the probe
// word this code types itself. The bridge behaves identically whichever
// skill is in use, so nothing about mail or Confluence is needed here, and a
// file the user is asked to send on must not carry their correspondence.
//
// It sends exactly one short message, because half of what matters can only
// be seen during a turn: whether the composer empties, whether a stop
// control appears, how the answer arrives, how fast the page churns when
// nothing is happening.

/**
 * The page-side recorder. Serialised into the tab, like every other page
 * function here, so it must stay self-contained.
 */
export async function recordPage(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : { visibility: 'visible', display: 'block' };
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    } catch { return false; }
  };
  const pathOf = (el) => {
    const bits = [];
    for (let e = el; e && e.tagName && bits.length < 6; e = e.parentElement) {
      let b = e.tagName.toLowerCase();
      if (e.id) b += `#${e.id}`;
      const t = e.getAttribute && e.getAttribute('data-testid');
      if (t) b += `[${t}]`;
      bits.unshift(b);
    }
    return bits.join(' > ');
  };
  const describe = (el) => (el ? {
    path: pathOf(el),
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: (el.getAttribute('class') || '').slice(0, 200) || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    title: el.getAttribute('title') || undefined,
    type: el.getAttribute('type') || undefined,
    contenteditable: el.getAttribute('contenteditable') || undefined,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    visible: vis(el),
    rect: (() => { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })(),
    // The LENGTH of the text, never the text. What is being diagnosed is
    // the shape and timing of the page, and those are numbers. The content
    // of the conversation belongs to the user — and if a mail or Confluence
    // turn happened earlier in the same thread, it is their mail and their
    // documents sitting in a file they are about to send on.
    textLength: norm(el.innerText || '').length || undefined,
  } : null);

  // Every read of the environment is guarded. A recorder that throws on a
  // missing global records nothing, and the one run it costs is the run it
  // was supposed to save.
  const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } };

  const out = {
    when: new Date().toISOString(),
    url: safe(() => location.href),
    title: safe(() => document.title),
    viewport: safe(() => ({ w: innerWidth, h: innerHeight })),
  };

  // ---------------------------------------------------------------- input
  const editable = [...document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]')].filter(vis);
  out.inputCandidates = editable.map(describe);
  const input = (cfg.inputSelector && document.querySelector(cfg.inputSelector))
    || editable.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]
    || null;
  out.chosenInput = describe(input);
  if (input) {
    // The composer's ancestry, because the send button is found by walking it.
    const chain = [];
    for (let e = input.parentElement, i = 0; e && i < 5; e = e.parentElement, i++) {
      chain.push({ ...describe(e), buttons: [...e.querySelectorAll('button, [role="button"]')].filter(vis).length });
    }
    out.composerAncestry = chain;
  }

  // ------------------------------------------------------------- controls
  // Everything the stop-selector could match, and everything that looks like
  // a send control, whether or not it is currently visible.
  // Re-queried every time it is needed. A list captured once misses the
  // control that appears when generation starts, which is the single event
  // this recording exists to time.
  const buttons = () => [...document.querySelectorAll('button, [role="button"]')];
  const allButtons = buttons();
  out.buttonCount = allButtons.length;
  const looksStop = (el) => {
    const s = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''} ${norm(el.innerText || '')}`.toLowerCase();
    return s.includes('stop');
  };
  const looksSend = (el) => {
    const s = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''} ${norm(el.innerText || '')}`.toLowerCase();
    return /send|submit|ask|arrow/.test(s);
  };
  out.stopLike = allButtons.filter(looksStop).map(describe);
  out.sendLike = allButtons.filter(looksSend).map(describe);
  // The selector the bridge actually uses, and what it matches right now.
  const stopSelector = cfg.stopSelector
    || 'button[aria-label*="stop" i], button[title*="stop" i], [data-testid*="stop" i]';
  out.stopSelectorInUse = {
    selector: stopSelector,
    matches: safe(() => [...document.querySelectorAll(stopSelector)].map(describe), []),
  };

  // --------------------------------------------------------- answer region
  const answerNodes = cfg.answerSelector ? [...document.querySelectorAll(cfg.answerSelector)] : [];
  out.answerSelector = { selector: cfg.answerSelector || null, matches: answerNodes.length, last: describe(answerNodes[answerNodes.length - 1]) };
  const region = document.querySelector('[data-testid="MessageListContainer"], [role="feed"]');
  out.conversationRegion = describe(region);

  // ------------------------------------------------------------ idle churn
  // How much does this page move when nothing is happening? This is the
  // measurement whose absence caused the last three failures.
  const bodyChars = () => { try { return (document.body.innerText || '').length; } catch { return 0; } };
  let mutations = 0;
  let obs = null;
  try {
    obs = new MutationObserver((m) => { mutations += m.length; });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  } catch { /* recorded as null below */ }
  const idleStartChars = bodyChars();
  const idleSamples = [];
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    idleSamples.push({ atMs: (i + 1) * 500, chars: bodyChars(), mutations });
  }
  out.idle = {
    seconds: 3,
    startChars: idleStartChars,
    endChars: bodyChars(),
    charGrowth: bodyChars() - idleStartChars,
    mutations,
    samples: idleSamples,
    stopLikeVisibleWhileIdle: buttons().filter((b) => looksStop(b) && vis(b)).map(describe),
  };

  if (!input) { try { if (obs) obs.disconnect(); } catch { /* ignore */ } out.turn = { skipped: 'no input element found' }; return out; }

  // ----------------------------------------------------------- a real turn
  // One short message, and a timeline of what the page does about it.
  const timeline = [];
  const t0 = Date.now();
  const mark = (what, extra) => timeline.push({ atMs: Date.now() - t0, what, ...(extra || {}) });

  const before = {
    chars: bodyChars(),
    answerNodes: (cfg.answerSelector ? document.querySelectorAll(cfg.answerSelector).length : 0),
    stopVisible: buttons().filter((b) => looksStop(b) && vis(b)).length,
  };

  const probePrompt = cfg.probePrompt || 'ping';
  input.focus();
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.addRange(range);
    document.execCommand('delete', false);
  } catch { /* best effort */ }
  try { document.execCommand('insertText', false, probePrompt); } catch { /* recorded below */ }
  await sleep(150);

  // The single most useful fact: did one insert produce one copy of the text?
  // The only string in this file, and it is ours: the probe word typed by
  // this code a moment ago. Comparing it back is how a doubled insert is
  // detected. Anything unexpected is reported as a length, not quoted.
  const held = norm(input.value || input.innerText || '');
  // What the editor did to the text, measured rather than inferred.
  //
  // Recording a single short word proved nothing about a long one: "ping"
  // has no list markers, headings or code fences for a markdown-formatting
  // composer to eat, so a recording of it could not predict that forty
  // characters would vanish from a two-thousand-six-hundred character agent
  // prompt. The structure of what was sent is counted here so the
  // difference can be attributed instead of guessed at.
  const askedLines = String(probePrompt).split('\n');
  const structure = {
    chars: norm(probePrompt).length,
    lines: askedLines.length,
    bulletLines: askedLines.filter((l) => /^\s*[-*+]\s+/.test(l)).length,
    headingLines: askedLines.filter((l) => /^\s*#{1,6}\s+/.test(l)).length,
    fenceLines: askedLines.filter((l) => /^\s*`{3,}/.test(l)).length,
    blankLines: askedLines.filter((l) => !l.trim()).length,
    angleTags: (String(probePrompt).match(/<[a-z][^>]*>/gi) || []).length,
  };
  const delta = held.length - structure.chars;
  out.insert = {
    asked: structure.chars <= 40 ? probePrompt : '(long prompt; see structure)',
    askedChars: structure.chars,
    gotLength: held.length,
    delta,
    doubled: held.length >= structure.chars * 1.8,
    structure,
    // The arithmetic that would explain a shortfall, so the rule the editor
    // follows can be read off rather than assumed.
    explains: {
      bulletMarkers: structure.bulletLines * 2,
      headingMarkers: structure.headingLines * 2,
      fenceBackticks: structure.fenceLines * 3,
      total: structure.bulletLines * 2 + structure.headingLines * 2 + structure.fenceLines * 3,
    },
  };
  mark('text inserted', { chars: held.length, expected: structure.chars, delta });

  const keydownTaken = safe(() => !input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  })), null);
  mark('keydown dispatched', { defaultPrevented: keydownTaken });
  out.enter = { keydownDefaultPrevented: keydownTaken };

  // Watch for 25 seconds, or until the answer settles.
  let lastChars = bodyChars();
  let composerClearedAt = null;
  let stopAppearedAt = null;
  let stopGoneAt = null;
  let answerAppearedAt = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    const chars = bodyChars();
    const stopVisible = buttons().filter((b) => looksStop(b) && vis(b)).length;
    const answers = cfg.answerSelector ? document.querySelectorAll(cfg.answerSelector).length : 0;
    const holds = norm(input.value || input.innerText || '');

    if (composerClearedAt === null && !holds) { composerClearedAt = Date.now() - t0; mark('composer cleared'); }
    if (stopAppearedAt === null && stopVisible > before.stopVisible) { stopAppearedAt = Date.now() - t0; mark('a stop control appeared', { count: stopVisible }); }
    if (stopAppearedAt !== null && stopGoneAt === null && stopVisible <= before.stopVisible) { stopGoneAt = Date.now() - t0; mark('the stop control went away'); }
    if (answerAppearedAt === null && answers > before.answerNodes) { answerAppearedAt = Date.now() - t0; mark('a new answer node appeared', { count: answers }); }
    if (chars - lastChars >= 20) mark('text grew', { by: chars - lastChars, total: chars });
    lastChars = chars;

    // Settled: an answer exists and the text has not grown for two samples.
    if (answerAppearedAt !== null && timeline.length && (Date.now() - t0) - (timeline[timeline.length - 1].atMs) > 1500) break;
  }

  try { if (obs) obs.disconnect(); } catch { /* ignore */ }

  out.turn = {
    prompt: probePrompt,
    composerClearedAt,
    stopAppearedAt,
    stopGoneAt,
    answerAppearedAt,
    totalMs: Date.now() - t0,
    charsBefore: before.chars,
    charsAfter: bodyChars(),
    stopVisibleBefore: before.stopVisible,
    stopVisibleAfter: buttons().filter((b) => looksStop(b) && vis(b)).length,
    timeline,
  };

  // The answer text, so extraction can be checked too.
  const finalAnswers = cfg.answerSelector ? [...document.querySelectorAll(cfg.answerSelector)] : [];
  out.turn.lastAnswer = describe(finalAnswers[finalAnswers.length - 1]);
  // How much came back, not what.
  out.turn.lastAnswerChars = norm((finalAnswers[finalAnswers.length - 1] || {}).innerText || '').length;

  return out;
}

// ======================================================================
// recordConversation — the comprehensive recording, taken once.
//
// The first recording used a four-letter word and a single turn, and so it
// said nothing about the three things that went on to break: what the
// composer does to a long, structured agent prompt; how a reply containing a
// code block comes back out of the page; and whether a second turn in the
// same chat is read as the new answer rather than the old one. This records
// a real two-turn agent exchange — the actual agent prompt, then the actual
// shape of a tool result — and keeps everything needed to answer those
// questions without asking again.
//
// What it keeps verbatim, and why that is safe:
//   - what was typed and what the composer then held. The composer is
//     cleared and confirmed empty first, so both are this code's own text.
//     If it cannot be cleared, the turn is abandoned and nothing is sent,
//     because typing on top of a leftover draft would send that draft too.
//   - the page's echo of the sent message, found by a random marker carried
//     in the prompt and bounded so that it cannot grow to take in anything
//     around it.
//   - the reply, but only answer elements that did not exist before this
//     turn was sent — the reply to our own probe, never earlier replies.
// Nothing else on the page is read as text: prior conversation contributes
// counts and element shapes only.
//
// What it will not do: send more than one message per turn, send anything
// into a page that is still generating, click a send button, or retry. A
// turn whose send does not register ends the recording.
// ======================================================================
export async function recordConversation(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const safe = (fn, fallback = null) => { try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; } };
  const vis = (el) => safe(() => {
    const r = el.getBoundingClientRect();
    const st = typeof getComputedStyle === 'function' ? getComputedStyle(el) : { visibility: 'visible', display: 'block' };
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }, false);
  const pathOf = (el) => {
    const bits = [];
    for (let e = el; e && e.tagName && bits.length < 6; e = e.parentElement) {
      let b = e.tagName.toLowerCase();
      if (e.id) b += `#${e.id}`;
      const t = safe(() => e.getAttribute('data-testid'));
      if (t) b += `[${t}]`;
      bits.unshift(b);
    }
    return bits.join(' > ');
  };
  // Shape only. Never text: text is taken deliberately, in the few places
  // above where it is known to be ours.
  const describe = (el) => (el ? {
    path: pathOf(el),
    tag: safe(() => el.tagName.toLowerCase(), '?'),
    id: el.id || undefined,
    cls: (safe(() => el.getAttribute('class'), '') || '').slice(0, 160) || undefined,
    testid: safe(() => el.getAttribute('data-testid')) || undefined,
    role: safe(() => el.getAttribute('role')) || undefined,
    ariaLabel: safe(() => el.getAttribute('aria-label')) || undefined,
    title: safe(() => el.getAttribute('title')) || undefined,
    type: safe(() => el.getAttribute('type')) || undefined,
    disabled: !!el.disabled || safe(() => el.getAttribute('aria-disabled')) === 'true',
    visible: vis(el),
    rect: safe(() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }),
    textLength: safe(() => norm(el.innerText || '').length, 0),
  } : null);
  const bound = (s, n) => { const t = String(s || ''); return t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : t; };

  const buttons = () => safe(() => [...document.querySelectorAll('button, [role="button"]')], []);
  const labelOf = (el) => `${safe(() => el.getAttribute('aria-label'), '') || ''} ${safe(() => el.getAttribute('title'), '') || ''} ${safe(() => el.getAttribute('data-testid'), '') || ''}`.toLowerCase();
  const looksStop = (el) => /stop/.test(labelOf(el));
  const visibleStops = () => buttons().filter((b) => looksStop(b) && vis(b));
  const bodyChars = () => safe(() => (document.body.innerText || '').length, 0);
  const answerSel = cfg.answerSelector || '[data-testid="markdown-reply"]';
  const answers = () => safe(() => [...document.querySelectorAll(answerSel)], []);

  const out = {
    kind: 'conversation-recording',
    when: new Date().toISOString(),
    // Origin and path only: the query string carries a session code.
    url: safe(() => location.origin + location.pathname),
    title: safe(() => document.title),
    viewport: safe(() => ({ w: innerWidth, h: innerHeight })),
    turns: [],
  };
  // Kept on the page as it grows, so a recording interrupted half way can
  // still be collected rather than lost with the call that timed out.
  const publish = () => { try { window.__copilotRecord = out; } catch { /* no window */ } };
  publish();

  // ---------------------------------------------------------------- input
  const editable = safe(() => [...document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"]')].filter(vis), []);
  const input = safe(() => (cfg.inputSelector && document.querySelector(cfg.inputSelector)), null)
    || editable.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0]
    || null;
  out.input = describe(input);
  if (!input) { out.aborted = 'no input element found; nothing was sent'; publish(); return out; }

  // The composer: the nearest ancestor that holds controls, which is where
  // a send button would be.
  let composer = input.parentElement;
  for (let i = 0; composer && i < 5; i++, composer = composer.parentElement) {
    if (safe(() => composer.querySelectorAll('button, [role="button"]').length, 0) > 0) break;
  }
  out.composer = describe(composer);
  out.composerButtonsIdle = composer ? safe(() => [...composer.querySelectorAll('button, [role="button"]')].map(describe), []) : [];

  // ---------------------------------------------- the page before we start
  out.before = {
    answerNodes: answers().length,
    bodyChars: bodyChars(),
    buttons: buttons().length,
    stopLikeAll: buttons().filter(looksStop).map(describe),
    stopLikeVisible: visibleStops().map(describe),
  };

  let mutations = 0;
  let lastMutation = Date.now();
  let obs = null;
  try {
    obs = new MutationObserver((m) => { mutations += m.length; lastMutation = Date.now(); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
  } catch { /* counts stay at zero */ }

  const idleStart = bodyChars();
  const m0 = mutations;
  await sleep(3000);
  out.idle = { seconds: 3, mutations: mutations - m0, charGrowth: bodyChars() - idleStart };
  publish();

  /**
   * Wait until the page is doing nothing: no visible stop control for a
   * while, and no text arriving. Returns false rather than proceeding if it
   * never gets there — sending into a working page is the one thing this
   * must not do.
   */
  const waitIdle = async (maxMs) => {
    const started = Date.now();
    let lastChars = bodyChars();
    let lastGrowth = Date.now();
    let stopGoneSince = visibleStops().length ? null : Date.now();
    while (Date.now() - started < maxMs) {
      await sleep(250);
      const c = bodyChars();
      if (c - lastChars >= 20) lastGrowth = Date.now();
      lastChars = c;
      if (visibleStops().length) stopGoneSince = null;
      else if (stopGoneSince === null) stopGoneSince = Date.now();
      const quietFor = Date.now() - lastGrowth;
      if (stopGoneSince !== null && Date.now() - stopGoneSince >= 1500 && quietFor >= 2000) {
        return { idle: true, waitedMs: Date.now() - started };
      }
    }
    return { idle: false, waitedMs: Date.now() - started };
  };

  const clearComposer = () => {
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(input);
      sel.addRange(range);
      document.execCommand('delete', false);
    } catch { /* the direct removal below is the fallback */ }
    if (safe(() => (input.innerText || '').length, 0) > 0 && input.isContentEditable) {
      try { input.textContent = ''; } catch { /* nothing else to try */ }
    }
  };
  const composerHolds = () => safe(() => String(input.value !== undefined && input.value !== null ? input.value : (input.innerText || '')), '');
  // Zero-width characters are not whitespace, so they survive trimming.
  const visibleLength = (s) => String(s || '').replace(/[​-‍⁠﻿\s]/g, '').length;

  /**
   * The page's echo of our message: the deepest element carrying the marker,
   * outside the composer, widened only while the widening adds almost
   * nothing — so it cannot swallow neighbouring messages.
   */
  const insideAnswer = (el) => answers().some((a) => a === el || safe(() => a.contains(el), false));
  const findEcho = (nonce, typedLength) => {
    // Walked by hand rather than selected with 'body *'. The selector is
    // fine in a browser, but it left this search unexercised by the checks
    // that run before the recording is used, and this is used once.
    const all = [];
    const walk = (el, depth) => {
      if (!el || depth > 40) return;
      for (const c of (el.children || [])) { all.push(c); walk(c, depth + 1); }
    };
    safe(() => walk(document.body, 0));
    let best = null;
    for (const el of all) {
      if (composer && composer.contains(el)) continue;
      // A reply may repeat the marker back; that is not the echo.
      if (insideAnswer(el)) continue;
      const t = safe(() => el.innerText || '', '');
      if (!t.includes(nonce)) continue;
      if (!best || (best.contains(el) && el !== best)) best = el;
    }
    if (!best) return null;
    // Widen only across wrappers that add almost nothing. The first version
    // widened while the parent stayed under a size limit — and a short
    // earlier conversation fits under any such limit, so it climbed into
    // the container holding the user's previous messages and recorded them.
    // A wrapper around one message adds a few characters at most; a
    // container of messages adds whole messages.
    void typedLength;
    for (let up = best.parentElement, i = 0; up && i < 4; up = up.parentElement, i++) {
      if (composer && up.contains(composer)) break;
      const grows = safe(() => (up.innerText || '').length, Infinity) - safe(() => (best.innerText || '').length, 0);
      if (grows > 40) break;
      best = up;
    }
    return best;
  };

  // ------------------------------------------------------------ clearing
  // A fresh chat's box is already empty, so a recording that only sends
  // would never show whether clearing works — and the bridge clears before
  // every message. Type our own words, clear, and measure each method.
  if (cfg.clearTest !== false) {
    const idle = await waitIdle(Number(cfg.idleMaxMs || 90000));
    const test = { idle: idle.idle };
    if (idle.idle && visibleLength(composerHolds()) === 0) {
      const words = `clear-test ${cfg.clearNonce || 'probe'}`;
      input.focus();
      try { document.execCommand('insertText', false, words); } catch (e) { test.insertError = String(e && e.message); }
      await sleep(200);
      test.afterInsert = visibleLength(composerHolds());
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.addRange(range);
        document.execCommand('delete', false);
      } catch (e) { test.deleteError = String(e && e.message); }
      await sleep(200);
      test.afterExecCommandDelete = visibleLength(composerHolds());
      if (test.afterExecCommandDelete > 0) {
        try { input.textContent = ''; } catch { /* recorded below */ }
        await sleep(200);
        test.afterTextContentFallback = visibleLength(composerHolds());
      }
      test.clearedBy = test.afterExecCommandDelete === 0 ? 'execCommand delete'
        : test.afterTextContentFallback === 0 ? 'textContent fallback' : 'neither';
    } else {
      test.skipped = idle.idle ? 'the box was not empty to begin with, so it was left alone' : 'the page was not idle';
    }
    out.clearTest = test;
    publish();
  }

  // ---------------------------------------------------------------- turns
  const perTurnMs = Number(cfg.perTurnMs || 90000);
  const idleMaxMs = Number(cfg.idleMaxMs || 90000);

  for (let n = 0; n < (cfg.turns || []).length; n++) {
    const { prompt, nonce, label, method = 'enter', tolerant = false } = cfg.turns[n];
    const turn = { index: n + 1, label: label || null, method, tolerant, nonce, typed: prompt, typedLength: prompt.length, timeline: [] };
    out.turns.push(turn);
    const t0 = Date.now();
    const mark = (what, extra) => turn.timeline.push({ atMs: Date.now() - t0, what, ...(extra || {}) });

    const idle = await waitIdle(idleMaxMs);
    turn.idleBefore = idle;
    if (!idle.idle) {
      turn.skipped = 'the page never went idle, so nothing was sent';
      publish();
      break;
    }

    input.focus();
    clearComposer();
    await sleep(150);
    const leftover = composerHolds();
    turn.composerAfterClear = { length: leftover.length, visibleLength: visibleLength(leftover) };
    if (visibleLength(leftover) > 0) {
      // Something of the user's may be in the box. Do not read it, and do
      // not type on top of it: that would send it.
      turn.skipped = 'the composer could not be emptied, so nothing was typed or sent';
      publish();
      break;
    }

    const insertStarted = Date.now();
    try { document.execCommand('insertText', false, prompt); } catch (e) { turn.insertError = String(e && e.message); }
    turn.insertMs = Date.now() - insertStarted;
    await sleep(250);
    const held = composerHolds();
    turn.composerHeld = {
      text: bound(held, 60000),
      length: held.length,
      textContent: bound(safe(() => input.textContent, ''), 60000),
      html: bound(safe(() => input.innerHTML, ''), 60000),
    };
    turn.composerButtonsTyped = composer ? safe(() => [...composer.querySelectorAll('button, [role="button"]')].map(describe), []) : [];
    // A size limit, if the page states one: an attribute on the input, or a
    // counter such as "15000/16000" in the composer. Only text that is
    // nothing but digits and a slash is read, so nothing else is taken.
    turn.composerLimit = {
      maxlength: safe(() => input.getAttribute('maxlength')) || null,
      counters: composer ? safe(() => {
        const found = [];
        const walk = (el) => {
          for (const c of (el.children || [])) {
            const t = norm(safe(() => c.innerText, '') || '');
            if (!c.children.length && /^\d[\d,.\s]*\/\s*\d[\d,.\s]*$/.test(t)) found.push(t);
            walk(c);
          }
        };
        walk(composer);
        return found;
      }, []) : [],
    };
    mark('typed', { held: held.length });

    const baseline = new Set(answers());
    const baseChars = bodyChars();
    const stopsBefore = visibleStops().length;
    // Alerts and live regions present before the send, so any that appear
    // after it — "message too long", a rate limit — can be told apart.
    const noticeSel = '[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]';
    const noticesBefore = new Set(safe(() => [...document.querySelectorAll(noticeSel)], []));

    // One submission, by the method this turn is testing. Never a second.
    const key = (type, ctrl) => new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      ctrlKey: !!ctrl, metaKey: !!ctrl,
    });
    if (method === 'button') {
      // Only a control that says it sends. Clicking an unlabelled button
      // could attach a file or open a menu.
      const candidates = composer ? safe(() => [...composer.querySelectorAll('button, [role="button"]')]
        .filter((b) => vis(b) && !b.disabled && safe(() => b.getAttribute('aria-disabled'), null) !== 'true'), []) : [];
      const send = candidates.find((b) => /\b(send|submit)\b/i.test(labelOf(b)));
      turn.sendButton = describe(send || null);
      turn.sendCandidates = candidates.map(describe);
      if (!send) {
        turn.buttonNotFound = true;
        mark('no labelled send button; not clicking anything');
      } else {
        safe(() => send.click());
        mark('send button clicked');
      }
    } else {
      const ctrl = method === 'ctrl-enter';
      const taken = safe(() => !input.dispatchEvent(key('keydown', ctrl)), null);
      if (taken === false) safe(() => input.dispatchEvent(key('keypress', ctrl)));
      safe(() => input.dispatchEvent(key('keyup', ctrl)));
      turn.enterConsumed = taken;
      mark(ctrl ? 'ctrl+enter' : 'enter');
    }

    let clearedAt = null; let stopAt = null; let stopGoneAt = null; let answerAt = null; let echoAt = null;
    let lastChars = baseChars; let lastGrowthAt = Date.now();
    let stopSeen = null;
    let lastFreshCount = 0;
    let firstAnswerNode = null;
    let answerReplaced = false;
    // gap 9: the longest silence while an answer is being written, which is
    // what the quiet timer has to outlast.
    let firstGrowthAt = null;
    let maxGrowthGapMs = 0;
    while (Date.now() - t0 < perTurnMs) {
      await sleep(250);
      const now = Date.now() - t0;
      if (clearedAt === null && visibleLength(composerHolds()) === 0) { clearedAt = now; mark('composer cleared'); }
      const stops = visibleStops();
      if (stopAt === null && stops.length > stopsBefore) {
        stopAt = now;
        stopSeen = stops.map(describe);
        mark('stop control appeared', { count: stops.length });
      }
      if (stopAt !== null && stopGoneAt === null && stops.length <= stopsBefore) { stopGoneAt = now; mark('stop control gone'); }
      const fresh = answers().filter((a) => !baseline.has(a));
      if (answerAt === null && fresh.length) { answerAt = now; mark('answer node appeared'); }
      if (fresh.length !== lastFreshCount) {
        if (lastFreshCount > 0) mark('answer node count changed', { from: lastFreshCount, to: fresh.length });
        lastFreshCount = fresh.length;
      }
      if (fresh.length && firstAnswerNode === null) firstAnswerNode = fresh[0];
      if (firstAnswerNode && !safe(() => firstAnswerNode.isConnected, true) && !answerReplaced) {
        answerReplaced = true;
        mark('the first answer node was removed from the page');
      }
      if (echoAt === null && findEcho(nonce, prompt.length)) { echoAt = now; mark('echo found'); }
      const c = bodyChars();
      if (c - lastChars >= 20) {
        if (firstGrowthAt !== null) maxGrowthGapMs = Math.max(maxGrowthGapMs, Date.now() - lastGrowthAt);
        else firstGrowthAt = Date.now();
        mark('text grew', { by: c - lastChars });
        lastGrowthAt = Date.now();
      }
      lastChars = c;

      // Never registered: no clearing, no stop control, no echo, no answer.
      if ((turn.buttonNotFound || now > Number(cfg.registerMs || 15000))
        && clearedAt === null && stopAt === null && echoAt === null && answerAt === null) {
        turn.sendNotRegistered = true;
        mark('send did not register');
        break;
      }
      // Settled: an answer exists, any stop control has gone, nothing new.
      if (answerAt !== null && (stopAt === null || stopGoneAt !== null) && Date.now() - lastGrowthAt >= 3000) {
        mark('settled');
        break;
      }
    }

    // Page notices that appeared during this turn. These are the page's own
    // interface text, bounded, and read only if they are new.
    turn.notices = safe(() => [...document.querySelectorAll(noticeSel)]
      .filter((el) => !noticesBefore.has(el) && !insideAnswer(el) && vis(el))
      .map((el) => ({ describe: describe(el), text: bound(norm(safe(() => el.innerText, '') || ''), 300) }))
      .filter((x) => x.text), []);

    turn.answerReplacedMidStream = answerReplaced;
    turn.maxGrowthGapMs = maxGrowthGapMs;
    turn.stopLikeVisibleAfter = visibleStops().map(describe);

    Object.assign(turn, {
      composerClearedAt: clearedAt, stopAppearedAt: stopAt, stopGoneAt, answerAppearedAt: answerAt, echoFoundAt: echoAt,
      stopControl: stopSeen,
      totalMs: Date.now() - t0,
      charsGained: bodyChars() - baseChars,
    });

    const echo = findEcho(nonce, prompt.length);
    turn.echo = echo ? {
      describe: describe(echo),
      text: bound(safe(() => echo.innerText, ''), 60000),
      textContent: bound(safe(() => echo.textContent, ''), 60000),
      html: bound(safe(() => echo.innerHTML, ''), 60000),
    } : null;

    const fresh = answers().filter((a) => !baseline.has(a));
    const ans = fresh[fresh.length - 1] || null;
    if (ans) {
      // The reply's own container, for its chrome — but only if it holds
      // this reply and nothing else. Falling back to the parent element could
      // land on a list of every message in the chat.
      let container = safe(() => ans.closest('[data-testid="lastChatMessage"], [id^="response-id"]'), null) || ans.parentElement;
      const extra = safe(() => (container.innerText || '').length, Infinity) - safe(() => (ans.innerText || '').length, 0);
      if (!container || extra > 200 || [...baseline].some((b) => safe(() => container.contains(b), false))) container = ans;
      turn.answer = {
        newAnswerNodes: fresh.length,
        describe: describe(ans),
        text: bound(safe(() => ans.innerText, ''), 60000),
        textContent: bound(safe(() => ans.textContent, ''), 60000),
        html: bound(safe(() => ans.innerHTML, ''), 60000),
        container: describe(container),
        containerHtml: bound(safe(() => container.innerHTML, ''), 80000),
      };
    } else {
      turn.answer = null;
    }
    publish();
    if (turn.sendNotRegistered) {
      if (!tolerant) break;
      // A fallback that did not send tells us something, and nothing was
      // sent, so the box is cleared of our own words and the next turn goes
      // ahead.
      clearComposer();
      await sleep(500);
      turn.clearedAfterNoSend = visibleLength(composerHolds()) === 0;
      if (!turn.clearedAfterNoSend) { turn.stoppedHere = 'our own text could not be cleared, so nothing further was typed'; publish(); break; }
    }
  }

  try { if (obs) obs.disconnect(); } catch { /* ignore */ }
  out.finished = new Date().toISOString();
  publish();
  return out;
}

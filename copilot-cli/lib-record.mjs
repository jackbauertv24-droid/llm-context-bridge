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
    text: norm(el.innerText || '').slice(0, 80) || undefined,
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
  out.insert = {
    asked: probePrompt,
    got: norm(input.value || input.innerText || ''),
    doubled: norm(input.value || input.innerText || '') === probePrompt + probePrompt,
  };
  mark('text inserted', { holds: out.insert.got });

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
  out.turn.lastAnswerText = norm((finalAnswers[finalAnswers.length - 1] || {}).innerText || '').slice(0, 400);

  return out;
}

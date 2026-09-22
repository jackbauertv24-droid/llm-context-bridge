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
  /**
   * The text a person would say is in the box.
   *
   * A recording of the real page settled this: typing the four letters
   * "ping" leaves six characters behind. Rich editors anchor their
   * selection with zero-width characters, and those are not whitespace, so
   * norm() keeps them and every comparison against the prompt failed. The
   * turn was then refused for holding the wrong text — on every message,
   * including a two-letter "hi".
   */
  const visibleText = (s) => norm(String(s || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\u00A0/g, ' '));
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
  const composer = (typeof input.closest === 'function' && (input.closest('form, [role="region"], [class*="composer" i], [class*="chat-input" i], [data-testid*="composer" i]')
    || input.parentElement?.parentElement?.parentElement
    || input.parentElement?.parentElement))
    || input.parentElement;

  // Pre-flight check: ensure Copilot is not currently streaming a previous answer
  const stopSelector = cfg.stopSelector
    || 'button[aria-label*="stop" i], button[title*="stop" i], [data-testid*="stop" i]';
  const stopNow = () => {
    try {
      for (const el of document.querySelectorAll(stopSelector)) if (vis(el)) return el;
    } catch { /* a malformed override must not break the turn */ }
    return null;
  };

  // Wait for the page to be idle, and if it will not become idle, do not
  // send. Falling through after a timeout and sending anyway is the single
  // worst thing this tool can do: it is a message delivered into a backend
  // that is visibly still working, which is the definition of piling on.
  // A turn that never happens costs nothing; one sent into a busy service
  // may cost the account.
  const preflightLimit = Number(cfg.preflightMs || 60000);
  // How long the page must be completely still before "a stop control is
  // visible" stops meaning "it is generating". A page that is genuinely
  // producing an answer changes constantly; one that is finished does not,
  // whatever is left on screen.
  const busyQuietMs = Number(cfg.busyQuietMs || 3000);

  // The element that matched, so a false positive can be identified and
  // pinned with STOP_SELECTOR instead of guessed at.
  const describeStop = (el) => {
    if (!el) return '(none)';
    try {
      const bits = [
        pathOf(el),
        el.getAttribute('aria-label') ? `aria="${el.getAttribute('aria-label')}"` : '',
        el.getAttribute('title') ? `title="${el.getAttribute('title')}"` : '',
        el.getAttribute('data-testid') ? `testid="${el.getAttribute('data-testid')}"` : '',
        el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '',
      ].filter(Boolean);
      return bits.join(' ');
    } catch { return '(could not describe it)'; }
  };

  // Is the page *generating*, as opposed to merely alive?
  //
  // The first attempt at this watched for any DOM mutation, which was
  // useless: every real web app mutates constantly — a clock, a presence
  // dot, a re-render — so the page always looked busy, nothing was ever
  // sent, and a plain "hi" could not get out. The replica used to check it
  // sat perfectly still, which is why the fault survived being "fixed".
  //
  // Generation has one signature that ambient churn does not: the page
  // gains text, and keeps gaining it. A ticking clock rewrites a few
  // characters without growing; an answer being written adds hundreds.
  const bodyChars = () => {
    try { return (document.body.innerText || '').length; } catch { return 0; }
  };
  const growthChars = Number(cfg.growthChars || 20);
  let lastChars = bodyChars();
  let lastGrowth = Date.now();

  const preflightStart = Date.now();
  let preflightLogged = false;
  const firstStop = stopNow();

  if (preflightLimit > 0) {
    for (;;) {
      if (!stopNow()) break;                       // no busy control at all
      if (Date.now() - preflightStart >= preflightLimit) break;

      const now = bodyChars();
      if (now - lastChars >= growthChars) lastGrowth = Date.now();
      lastChars = now;

      // Still there, but the page has stopped growing: it is not writing an
      // answer, whatever the control looks like.
      if (Date.now() - lastGrowth >= busyQuietMs) break;

      if (!preflightLogged) {
        log(`text is still growing and a stop control is visible; waiting. ${describeStop(stopNow())}`);
        preflightLogged = true;
      }
      await sleep(400);
    }
  }

  const preflightMs = Date.now() - preflightStart;
  const stopStillThere = !!stopNow();
  const stillGrowing = Date.now() - lastGrowth < busyQuietMs;
  const preflightTimedOut = preflightLimit > 0 && preflightMs >= preflightLimit;

  if (firstStop && stopStillThere && !stillGrowing) {
    log(`a control matches the stop selector but the page has not gained text `
      + `for ${Date.now() - lastGrowth}ms, so it is not generating: ${describeStop(stopNow())}`);
    log('if that is the real stop control, pin it with STOP_SELECTOR');
  }
  debug.stopControl = { matched: !!firstStop, description: describeStop(firstStop), stillThere: stopStillThere };

  if (preflightMs > 200) log(`waited ${preflightMs}ms for the page to go idle`);
  if (preflightTimedOut && stopStillThere && stillGrowing) {
    // Still working after the full wait. Refuse, and say so: the caller can
    // stop, and nothing was added to the conversation.
    log(`the page was still generating after ${preflightMs}ms; refusing to send`);
    debug.wait = { via: 'not-sent-page-busy', sawStop: true, ms: preflightMs, submissions: 0, preflightMs, preflightTimedOut: true };
    return {
      ok: true,
      busy: true,
      notSent: true,
      text: '',
      method: 'not sent: the page was still generating a previous response'
        + ' (set PREFLIGHT_MS=0 to send without this check)',
      debug,
    };
  }
  const inputReadyStart = Date.now();
  while ((input.disabled || input.getAttribute('aria-disabled') === 'true') && (Date.now() - inputReadyStart < 10000)) {
    await sleep(300);
  }
  const inputWaitMs = Date.now() - inputReadyStart;
  if (inputWaitMs > 200) log(`input was disabled for ${inputWaitMs}ms before it accepted text`);

  // 3. set text
  input.focus();
  let composerCorrected = false;
  // Leftovers from a previous turn would be sent along with this prompt.
  const clearComposer = () => {
    if (!input.isContentEditable) {
      try {
        const proto0 = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto0, 'value').set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch { /* nothing else to try */ }
      return;
    }
    {
      try {
        const sel = window.getSelection();
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.addRange(range);
        document.execCommand('delete', false);
      } catch { /* the direct removal below is the fallback */ }
      if ((input.innerText || '').length > 0) {
        input.textContent = '';
        while (input.firstChild) input.removeChild(input.firstChild);
      }
    }
  };

  if (input.isContentEditable) {
    clearComposer();
    // Insert the prompt exactly once.
    //
    // A synthetic beforeinput carrying the text used to be dispatched here
    // and then execCommand('insertText') called as well. A modern editor —
    // Lexical, ProseMirror — handles beforeinput by inserting the data
    // itself, and execCommand then inserted it a second time, so typing
    // "Blast" put "BlastBlast" in the box. execCommand already fires a real
    // beforeinput and input pair of its own; the manual one was pure
    // duplication.
    try { document.execCommand('insertText', false, cfg.prompt); } catch { /* checked below */ }

    // Verify rather than assume. Too much text is as wrong as too little,
    // and the doubling above went unnoticed because the old check used
    // !== on trimmed text and then *appended* a correction.
    if (visibleText(input.innerText) !== visibleText(cfg.prompt)) {
      // Repairing this is a safety net, not a success. Recorded, because a
      // silent repair hides the fault that made it necessary: the doubled
      // insert was corrected here and so looked fine from the outside.
      composerCorrected = true;
      log(`the first insert produced ${norm(input.innerText || '').length} characters `
        + `where ${norm(cfg.prompt).length} were expected; setting the text directly`);
      clearComposer();
      input.textContent = cfg.prompt;
      try {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      } catch {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  } else {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, cfg.prompt);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(100);

  // What is actually in the box, compared with what was meant to be there.
  // A prompt that arrived doubled — "BlastBlast" for "Blast" — was sent as
  // though nothing were wrong, because the length was never compared with
  // the length expected. A wrong message costs the same as a right one and
  // teaches the model something untrue, so it is not sent.
  const inBox = visibleText(input.value || input.innerText || '');
  const wanted = visibleText(cfg.prompt);
  debug.composer = { expected: wanted.length, actual: inBox.length, matched: inBox === wanted, corrected: composerCorrected };
  if (inBox !== wanted) {
    const doubled = inBox.length >= wanted.length * 2 && inBox.startsWith(wanted);
    log(`the composer holds ${inBox.length} characters where ${wanted.length} were expected`
      + `${doubled ? ' — the text was inserted more than once' : ''}`);
    clearComposer();
    debug.wait = { via: 'not-sent-bad-composer', sawStop: false, ms: 0, submissions: 0 };
    return {
      ok: true,
      notSent: true,
      badComposer: true,
      text: '',
      method: `not sent: the composer held ${inBox.length} characters instead of ${wanted.length}`,
      debug,
    };
  }
  log(`text set, input holds exactly the ${inBox.length} characters expected`);

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
  let submissions = 0;
  const fireEnter = (el, ctrl = false) => {
    submissions++;
    const key = (type) => new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
      ctrlKey: ctrl, metaKey: ctrl,
    });
    // keydown, then keypress only if the page did not take the keydown.
    //
    // All three were fired unconditionally, so a page carrying a handler on
    // keydown and a legacy one on keypress submitted twice from one
    // keystroke — the same fault as inserting the text twice, wearing a
    // different hat. It is not faithful either: in a browser, a keydown
    // whose default is prevented does not produce a keypress at all.
    const notTaken = el.dispatchEvent(key('keydown'));
    if (notTaken) el.dispatchEvent(key('keypress'));
    el.dispatchEvent(key('keyup'));
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
  const TICK = 100;
  // Recorded before the send, so the wait below knows whether the control it
  // sees belongs to this turn or was there all along.
  const strayStop = !!firstStop;
  const wait = {
    via: 'timeout', sawStop: false, ms: 0, selector: stopSelector,
    preflightMs, preflightTimedOut, inputWaitMs, strayStop,
  };
  let goneFor = 0;

  // Attempt one, and only one. Ctrl+Enter used to be fired immediately
  // afterwards whenever the prompt contained a newline — which every agent
  // prompt does — so two submissions went out back to back with nothing
  // checked in between. It is now attempt two, and only if attempt one is
  // seen to have failed.
  fireEnter(input);

  const sentAt = Date.now();
  // Started here, not after the send check below: a short answer can be over
  // within that 400ms, and a signal we were not yet watching for is no signal.
  const watchStop = setInterval(() => {
    if (stopNow()) { wait.sawStop = true; goneFor = 0; } else { goneFor += TICK; }
  }, TICK);

  const inputRect = typeof input.getBoundingClientRect === 'function' ? input.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };

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
    // Whole words. Unanchored, "ask" matched the "Task" in "Task Hub" — a
    // recording of the real page listed that header button as a candidate
    // to send with, and only its position kept it from being clicked.
    const isPos = /\b(send|submit|ask|arrow)\b/i.test(full)
      || btn.type === 'submit' || btn.getAttribute('type') === 'submit';
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

  /**
   * Activate a control exactly once.
   *
   * The previous version dispatched a MouseEvent click, then called
   * btn.click(), then clicked the first child, then called
   * form.requestSubmit() — four submissions from one call, in a loop that
   * ran every 450ms for three and a half seconds. Against a real chat
   * backend that is around thirty copies of the same message. A send that
   * does not register is cheap and visible; a send that registers thirty
   * times is neither.
   */
  const activate = (btn) => {
    if (!btn) return false;
    submissions++;
    try { btn.focus(); } catch { /* not focusable, still clickable */ }
    if (typeof btn.click === 'function') {
      try { btn.click(); return true; } catch { /* fall through to an event */ }
    }
    try {
      const r = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      btn.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.x + (r.width || 0) / 2, clientY: r.y + (r.height || 0) / 2,
      }));
      return true;
    } catch { return false; }
  };

  const hasText = () => {
    // Both sides normalised. Comparing a whitespace-collapsed prompt lead
    // against raw innerText meant that for any prompt containing a newline
    // — which every agent prompt does — the comparison never matched, so
    // the composer always looked empty and every send looked successful,
    // including the ones that never left.
    const val = visibleText(input.value || input.innerText || '');
    const promptLead = visibleText(cfg.prompt).slice(0, 20);
    return val.length > 0 && promptLead.length > 0 && val.includes(promptLead);
  };

  /**
   * Did the send register?
   *
   * Three independent signs, any of which is enough: the composer emptied,
   * the page put up a stop control, or a new answer block appeared. Relying
   * on the composer alone was the mistake — a slow editor still holding the
   * text reads as "not sent" and invites another attempt.
   */
  /**
   * The strongest evidence that the message was accepted: it is now in the
   * conversation. The page echoes what you sent as a turn of its own, so
   * finding our text somewhere other than the composer proves delivery
   * outright, where an empty composer only suggests it.
   *
   * This matters most when the far end is slow. "The composer still has
   * text" was the first thing checked, and a backend taking its time is
   * exactly when that stays true for a message that did in fact arrive —
   * so latency alone would provoke a second copy of it.
   */
  const promptTail = visibleText(cfg.prompt).slice(-60);
  const countIn = (el) => {
    if (!el || !promptTail) return 0;
    try { return visibleText(el.innerText).split(promptTail).length - 1; } catch { return 0; }
  };
  const promptEchoed = () => {
    if (!promptTail) return false;
    return countIn(document.body) > countIn(composer);
  };

  const sendRegistered = () => promptEchoed()
    || wait.sawStop || !!stopNow()
    || answerBlocks().some((el) => !baseSet.has(el))
    || !hasText();

  const waitForRegistration = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (sendRegistered()) return true;
      await sleep(100);
    }
    return sendRegistered();
  };

  // How long to allow before concluding a send did not land. Two and a half
  // seconds was a guess made against a responsive page; a throttled or busy
  // backend can take far longer to acknowledge, and concluding too early is
  // precisely how a slow accept becomes a duplicate message.
  const verifyMs = Number(cfg.sendVerifyMs || 10000);
  let sent = await waitForRegistration(verifyMs);

  // Attempt two: Ctrl+Enter, which some rich editors want when the text
  // spans several lines.
  if (!sent && cfg.prompt.includes('\n')) {
    log(`Enter did not register after ${verifyMs}ms; trying Ctrl+Enter once`);
    fireEnter(input, true);
    sent = await waitForRegistration(verifyMs);
  }

  // Attempt three, and the last: a single activation of the send control.
  if (!sent) {
    const btn = findSendButton();
    if (btn && isEnabled(btn)) {
      log(`still not registered; clicking send once, aria="${btn.getAttribute('aria-label') || ''}"`);
      activate(btn);
      sent = await waitForRegistration(verifyMs);
    } else {
      log('no enabled send control was found to try');
    }
  }

  // There is no attempt four. Retrying past this point is how the same
  // prompt ends up in the conversation several times over, and a send that
  // silently fails is far cheaper to recover from than one that succeeds
  // thirty times.
  wait.submissions = submissions;
  if (sent) {
    log(`send registered after ${submissions} submission${submissions === 1 ? '' : 's'}`);
  } else {
    log(`send did NOT register after ${submissions} submission${submissions === 1 ? '' : 's'}; giving up rather than sending again`);
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

      // Finished is "the text stopped growing", not "the DOM stopped
      // changing". A page with a clock in the corner never stops changing,
      // so the quiet rule below never fired and every turn ran to the full
      // answer timeout — two minutes, on a page that had answered in three
      // seconds. Growth is what an answer being written produces and what
      // ambient churn does not.
      const chars = bodyChars();
      if (chars - lastChars >= growthChars) lastGrowth = Date.now();
      lastChars = Math.max(lastChars, chars);
      const sinceGrowth = Date.now() - lastGrowth;

      // A control that was already on screen before we sent anything cannot
      // be telling us about the answer we just asked for. Trusting it meant
      // that on a page carrying a permanent one — "Stop sharing", say — the
      // turn could never end by the exact signal, the quiet fallback was
      // suppressed because a control had been seen, and every turn ran to
      // the full answer timeout. Two minutes, every time.
      const trustStop = !strayStop;

      // The exact signal: we watched it generate, and it has stopped. Two
      // consecutive absences, so a re-render that briefly drops the control
      // does not end the turn early.
      // The stop control going away is not the end of the answer. On the
      // real page it vanished at 4.2 seconds while the text went on growing
      // until 5.2 — so treating its disappearance as the finish truncated
      // the last second of every reply. It must also have stopped growing.
      const finished = trustStop && wait.sawStop && goneFor >= TICK * 2
        && sinceGrowth > Math.min(cfg.quietMs, 1200);
      // The fallback, used whenever there is no trustworthy busy signal —
      // either none was ever seen, or the one on screen was already there.
      const quiet = (strayStop || !wait.sawStop) && sinceGrowth > cfg.quietMs;
      // And a safety net: a stop control that is still there long after the
      // page stopped changing is stale, not generating. Without this the turn
      // would sit until the answer timeout -- two minutes for a page that
      // finished seconds ago.
      // The stale net exists so a stop control stuck visible cannot hold a
      // turn open for the full answer timeout. It must not fire while the
      // page is merely thinking: three times the quiet period is under five
      // seconds by default, and a slow backend pausing that long mid-answer
      // was cut off and its half-written reply taken as final. Thirty
      // seconds of complete silence is stuck; five is slow.
      const staleAfter = Math.max(cfg.quietMs * 3, 30000);
      const stale = trustStop && wait.sawStop && sinceGrowth > staleAfter;

      if (grew && (finished || quiet || stale)) {
        wait.via = finished ? 'stop-control-gone' : stale ? 'stale-stop-control' : 'quiet';
        wait.ms = Date.now() - sentAt;
        clearInterval(iv); resolve();
        return;
      }

      // Short-circuit: If after 8 seconds no generation ever started and prompt text remains in input,
      // the send failed to trigger. Do not freeze the terminal for 120 seconds!
      if (!grew && hasText() && (Date.now() - sentAt > 8000)) {
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
  // Did this turn end knowing the page had stopped, or did it give up? On
  // timeout, or on the stale net, the page may well still be generating,
  // and sending the next turn into that is exactly what must not happen.
  wait.pageIdleAtEnd = wait.via === 'stop-control-gone' || (wait.via === 'quiet' && !stopNow());
  // With no stop control ever seen, there is no busy signal on this page at
  // all, so the wait before sending is blind. Worth knowing, once.
  // No usable busy signal: either nothing matched, or what matched was
  // already there and so says nothing about this turn.
  wait.noBusySignal = !wait.sawStop || strayStop;
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

  // An echo of what we just sent is not an answer. It was returned as one
  // when the page was slow enough that nothing else had appeared, and for
  // the agent that is actively dangerous: our prompts contain example
  // tags, so handing the prompt back as a reply would have the bridge
  // execute its own instructions.
  if (winner && winner.containsPrompt) {
    log('best candidate was an echo of our own prompt, not an answer; returning nothing');
    debug.echoOnly = true;
    text = '';
  } else {
    text = winner ? winner.text : '';
  }
  method = debug.echoOnly
    ? `refused: only our own prompt was on the page (${winner.name})`
    : winner ? `${winner.name} (score ${winner.score}, ${winner.path || 'page text'})` : 'nothing extracted';
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
    // The real page has neither MessageListContainer nor role=feed. Its
    // replies sit in [data-testid="lastChatMessage"] containers, so the
    // region is found by walking up from one of those.
    const region = document.querySelector('[data-testid="MessageListContainer"], [role="feed"]')
      || (() => {
        const msgs = [...document.querySelectorAll('[data-testid="lastChatMessage"], [id^="response-id"]')];
        const last = msgs[msgs.length - 1];
        return last ? (last.parentElement || last) : null;
      })()
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

  const isBusy = /please wait (for|until) the (current|previous) response/i.test(text);
  if (isBusy) {
    log('Copilot was busy ("Please wait for current response"); flagging busy state');
  }

  log(`extracted via ${method}, ${text.length} chars${isBusy ? ' (busy warning)' : ''}`);
  return { ok: !isBusy, busy: isBusy, text, method, debug };
}


/**
 * Build the test page out of a recording of the real one.
 *
 * Every replica before this was written from reasoning: the composer must
 * clear on send, a visible stop control must mean a response is in flight,
 * the DOM must fall quiet when an answer ends. Each was plausible, each was
 * wrong, and each was confirmed against a replica built from the same
 * mistaken belief — so the checks agreed with the bug.
 *
 * Nothing here is chosen. The element ids, classes, roles and geometry come
 * from the recording; so does the fact that inserting four characters leaves
 * six behind, that Enter is consumed, that the page produces no mutations at
 * all while idle, and the millisecond at which the composer clears, the stop
 * control appears and disappears, the answer node arrives and each burst of
 * text lands. If the real page changes, re-record and these change with it.
 */
import { El, document as doc, resetDom } from '../lib-dom.mjs';

/** The events of the recorded turn, in the order and at the times recorded. */
function scheduleTimeline(record, actors) {
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const t = record.turn;
  const base = t.timeline.find((e) => e.what === 'keydown dispatched');
  const offset = base ? base.atMs : 0;
  const rel = (ms) => Math.max(0, ms - offset);

  if (t.composerClearedAt !== null) at(rel(t.composerClearedAt), actors.clearComposer);
  if (t.stopAppearedAt !== null) at(rel(t.stopAppearedAt), actors.showStop);
  if (t.stopGoneAt !== null) at(rel(t.stopGoneAt), actors.hideStop);
  if (t.answerAppearedAt !== null) at(rel(t.answerAppearedAt), actors.addAnswerNode);

  for (const ev of t.timeline) {
    if (ev.what === 'text grew') at(rel(ev.atMs), () => actors.growText(ev.by));
  }
  return () => timers.forEach(clearTimeout);
}

/**
 * @param record a page recording, as written by `chat.mjs --record`
 * @returns {{ state, cancel }} state.submits counts what reached the chat
 */
export function pageFromRecord(record) {
  resetDom();
  const state = { submits: 0, receivedChars: null, cancel: () => {} };

  // The composer, rebuilt from the recorded ancestry, outermost first.
  let parent = doc.body;
  for (const level of [...(record.composerAncestry || [])].reverse()) {
    const el = new El(level.tag || 'div', {
      ...(level.id ? { id: level.id } : {}),
      ...(level.cls ? { class: level.cls } : {}),
      ...(level.testid ? { 'data-testid': level.testid } : {}),
    });
    if (level.rect) el.rect = { x: level.rect.x, y: level.rect.y, width: level.rect.w, height: level.rect.h };
    parent.append(el);
    parent = el;
  }

  const ci = record.chosenInput;
  const input = new El(ci.tag || 'span', {
    ...(ci.id ? { id: ci.id } : {}),
    ...(ci.cls ? { class: ci.cls } : {}),
    ...(ci.role ? { role: ci.role } : {}),
    ...(ci.ariaLabel ? { 'aria-label': ci.ariaLabel } : {}),
    ...(ci.contenteditable ? { contenteditable: ci.contenteditable } : {}),
  });
  input.rect = { x: ci.rect.x, y: ci.rect.y, width: ci.rect.w, height: ci.rect.h };
  parent.append(input);
  doc._editor = input;

  // The editor pads what is typed with invisible anchors. The recording says
  // four characters in gives six characters out; two zero-width anchors is
  // what produces exactly that.
  const padding = Math.max(0, (record.insert.gotLength || 0) - String(record.insert.asked || '').length);
  if (padding > 0) {
    const anchor = '​'.repeat(Math.ceil(padding / 2));
    Object.defineProperty(input, 'innerText', {
      get() {
        const raw = this.children.length
          ? this.children.map((c) => c.innerText).filter((x) => x !== '').join('\n')
          : this._text;
        return raw ? `${anchor}${raw}${anchor}` : raw;
      },
      set(v) { this.children = []; this._text = v; },
      configurable: true,
    });
  }

  // Buttons elsewhere on the page, including the ones the recording shows a
  // naive send-finder mistaking for a send control.
  for (const b of record.sendLike || []) {
    const el = new El(b.tag === 'a' ? 'a' : 'button', {
      ...(b.id ? { id: b.id } : {}),
      ...(b.testid ? { 'data-testid': b.testid } : {}),
      ...(b.role ? { role: b.role } : {}),
      ...(b.ariaLabel ? { 'aria-label': b.ariaLabel } : {}),
    });
    if (b.rect) el.rect = { x: b.rect.x, y: b.rect.y, width: b.rect.w, height: b.rect.h };
    doc.body.append(el);
  }

  // Filler so the page has roughly the character count it was recorded with,
  // which is what the growth measurements are relative to.
  const filler = new El('div');
  filler.setText('x'.repeat(Math.max(0, (record.idle.startChars || 0) - 200)));
  doc.body.append(filler);

  // The reply area. The recording says this page has neither a
  // MessageListContainer nor a role=feed; replies live in lastChatMessage.
  const thread = new El('div');
  doc.body.append(thread);

  let answerInner = null;
  let stopButton = null;

  const actors = {
    clearComposer: () => { input.textContent = ''; },
    showStop: () => {
      stopButton = new El('button', { 'aria-label': 'Stop responding' });
      doc.body.append(stopButton);
    },
    hideStop: () => { if (stopButton) stopButton.rect = { x: 0, y: 0, width: 0, height: 0 }; },
    addAnswerNode: () => {
      const msg = new El('div', { 'data-testid': 'lastChatMessage', id: 'response-id_r_lt_' });
      const md = new El('div', { 'data-testid': 'markdown-reply' });
      answerInner = new El('div');
      md.append(answerInner);
      msg.append(md);
      thread.append(msg);
    },
    growText: (by) => {
      if (!answerInner) return;
      answerInner.append(new El('p', {}, 'y'.repeat(Math.max(1, by))));
    },
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    // The recording says the page consumes the keydown.
    if (record.enter && record.enter.keydownDefaultPrevented) ev.preventDefault();
    state.submits++;
    if (state.submits > 1) return;
    state.receivedChars = (input.innerText || '').length;
    state.cancel = scheduleTimeline(record, actors);
  });

  return state;
}

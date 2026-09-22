/**
 * The page recorder must not carry the conversation out with it.
 *
 * The file it writes is meant to be sent to whoever is fixing the bridge, and
 * the tab it reads is the user's own chat. If a mail or Confluence turn
 * happened earlier in that thread, the conversation contains their mail and
 * their internal documents. Recording element shapes, selectors, geometry,
 * counts and timings answers every question the bridge has ever got wrong;
 * recording the text answers none of them.
 *
 * So this is a property, checked rather than promised: put distinctive
 * strings everywhere a page keeps text, record, and require that not one of
 * them survives into the output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { El, document as doc, installGlobals, resetDom } from '../lib-dom.mjs';
import { recordPage } from '../lib-record.mjs';

const SECRETS = {
  mailSubject: 'SECRETSUBJECT-quarterly-numbers',
  mailBody: 'SECRETBODY-the-figures-are-attached',
  answer: 'SECRETANSWER-here-is-what-i-found',
  composerLeftover: 'SECRETDRAFT-unsent-message',
  heading: 'SECRETHEADING-project-atlas',
};

function pageHoldingSecrets() {
  resetDom();
  const region = new El('div', { 'data-testid': 'MessageListContainer' });
  const feed = new El('div', { role: 'feed' });
  region.append(feed);
  doc.body.append(region);

  // An earlier mail-agent turn, still in the conversation.
  const older = new El('div', { 'data-testid': 'copilot-message-div' });
  older.append(new El('p', {}, SECRETS.mailSubject));
  older.append(new El('p', {}, SECRETS.mailBody));
  feed.append(older);

  const answered = new El('div', { 'data-testid': 'copilot-message-div' });
  const md = new El('div', { 'data-testid': 'markdown-reply' });
  md.append(new El('p', {}, SECRETS.answer));
  answered.append(md);
  feed.append(answered);

  doc.body.append(new El('h1', {}, SECRETS.heading));

  const composer = new El('div', { class: 'composer' });
  const input = new El('span', { id: 'ed', role: 'textbox', contenteditable: 'true' }, SECRETS.composerLeftover);
  input.rect = { x: 0, y: 800, width: 700, height: 27 };
  composer.append(input);
  composer.append(new El('button', { 'aria-label': 'Send' }));
  doc.body.append(composer);
  doc._editor = input;

  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    input.textContent = '';
    const reply = new El('div', { 'data-testid': 'copilot-message-div' });
    const rmd = new El('div', { 'data-testid': 'markdown-reply' });
    rmd.append(new El('p', {}, SECRETS.answer));
    reply.append(rmd);
    feed.append(reply);
  });
}

test('the recording carries no text from the conversation', async () => {
  const restore = installGlobals();
  let rec;
  try {
    pageHoldingSecrets();
    rec = await recordPage({
      inputSelector: '#ed',
      answerSelector: '[data-testid="markdown-reply"]',
      probePrompt: 'ping',
    });
  } finally { restore(); }

  const serialised = JSON.stringify(rec);
  for (const [where, secret] of Object.entries(SECRETS)) {
    assert.ok(!serialised.includes(secret), `the recording leaked the ${where}`);
  }
});

test('the recording still answers the questions it exists for', async () => {
  // Stripping the text must not strip the diagnosis with it.
  const restore = installGlobals();
  let rec;
  try {
    pageHoldingSecrets();
    rec = await recordPage({
      inputSelector: '#ed',
      answerSelector: '[data-testid="markdown-reply"]',
      probePrompt: 'ping',
    });
  } finally { restore(); }

  assert.ok(rec.chosenInput && rec.chosenInput.path, 'it must say which input it chose');
  assert.equal(rec.insert.doubled, false, 'it must say whether one insert gave one copy');
  assert.equal(rec.insert.asked, 'ping');
  assert.ok(typeof rec.idle.mutations === 'number', 'it must measure idle churn');
  assert.ok(typeof rec.idle.charGrowth === 'number', 'it must measure idle text growth');
  assert.ok(Array.isArray(rec.stopLike), 'it must list stop-like controls');
  assert.ok(typeof rec.turn.lastAnswerChars === 'number', 'the answer is a size, not a quotation');
  assert.ok(rec.conversationRegion && typeof rec.conversationRegion.textLength === 'number');
});

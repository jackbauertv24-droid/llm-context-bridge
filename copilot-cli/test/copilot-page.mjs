/**
 * A replica of the live Copilot page, shared by the extraction tests and the
 * replay tests.
 *
 * The structure is not invented: it is what the live probe and the turn
 * diagnostics showed — a feed of div[data-testid="copilot-message-div"] turn
 * containers, the reply inside div[data-testid="markdown-reply"] as streamed
 * <p> elements, suggestion chips as buttons, and a contenteditable
 * span#m365-chat-editor-target-element as the composer.
 */
import { El, document as doc, resetDom } from '../lib-dom.mjs';

export const CFG = {
  inputSelector: '#m365-chat-editor-target-element',
  sendSelector: '',
  answerSelector: '[data-testid="markdown-reply"]',
  quietMs: 60,
  answerTimeoutMs: 3000,
};

export const PARAS = [
  "I'm responding normally and the conversation context is intact.",
  'Everything looks fine on my side.',
  'Feel free to throw a more interesting test at me.',
];
export const CHIPS = ['Can you tell me a fun fact?', 'What’s the meaning of life?', 'Show me a random joke'];

/**
 * @param {object} opts
 *   replyIntoExisting - stream into a markdown-reply that was already present
 *                       when the prompt was sent, rather than a new one.
 *   chipsAsOwnTurn    - the chips arrive as their own turn container beside
 *                       the reply, which is how the live page did it.
 *   dead              - the page does nothing at all (send did not register).
 */
export function buildCopilotPage({ replyIntoExisting = false, dead = false, chipsAsOwnTurn = false } = {}) {
  resetDom();
  const body = doc.body;

  const listContainer = new El('div', { 'data-testid': 'MessageListContainer' });
  const feed = new El('div', { role: 'feed', 'aria-label': 'Chat conversation' });
  listContainer.append(feed);
  body.append(listContainer);

  // An earlier exchange, so the page is not empty when we send.
  const oldTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-old' });
  const oldReply = new El('div', { 'data-testid': 'markdown-reply' });
  const oldInner = new El('div');
  oldInner.append(new El('p', {}, 'Hi! How can I help? 👋'));
  oldReply.append(oldInner);
  oldTurn.append(oldReply);
  feed.append(oldTurn);

  // The composer, as the probe found it.
  const wrap = new El('div', { class: 'fai-BebopLiteChatInput' });
  const input = new El('span', {
    id: 'm365-chat-editor-target-element',
    role: 'textbox',
    contenteditable: 'true',
    'aria-label': 'Message Copilot',
  });
  input.rect = { x: 140, y: 833, width: 704, height: 27 };
  wrap.append(input);
  body.append(wrap);
  doc._editor = input;

  let existingReply = null;
  if (replyIntoExisting) {
    const turn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-pending' });
    existingReply = new El('div', { 'data-testid': 'markdown-reply' });
    turn.append(existingReply);
    feed.append(turn);
  }

  let sent = false;
  input.onKey = (ev) => {
    if (ev.key !== 'Enter' || sent || dead) return;
    sent = true;
    const prompt = input.innerText;
    input.textContent = '';                      // the real page clears the composer

    const userTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageUser-1' });
    userTurn.append(new El('div', {}, prompt));  // one outermost insertion carrying our echo
    feed.append(userTurn);

    setTimeout(() => {
      let inner;
      let container;
      if (existingReply) { container = existingReply.parentElement; inner = new El('div'); existingReply.append(inner); }
      else {
        container = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-new' });
        feed.append(container);
        const md = new El('div', { 'data-testid': 'markdown-reply' });
        inner = new El('div');
        md.append(inner);
        container.append(md);
      }
      let i = 0;
      const stream = () => {
        if (i < PARAS.length) { inner.append(new El('p', {}, PARAS[i++])); setTimeout(stream, 8); return; }
        const chips = new El('div');
        for (const c of CHIPS) chips.append(new El('button', { 'data-testid': 'chat-suggestion' }, c));
        if (chipsAsOwnTurn) {
          const chipTurn = new El('div', { 'data-testid': 'copilot-message-div', id: 'chatMessageResponse-suggestions' });
          chipTurn.append(chips);
          feed.append(chipTurn);
        } else {
          container.append(chips);
        }
      };
      setTimeout(stream, 8);
    }, 8);
  };

  return { input, feed };
}

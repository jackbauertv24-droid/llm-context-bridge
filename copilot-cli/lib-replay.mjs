/**
 * Replay a captured turn.
 *
 * copilot-cli-capture.json holds the conversation region as it stood the
 * moment an answer was extracted, plus which of its top-level turns the page
 * had just added. That is enough to rebuild the page in the hand-written DOM
 * (lib-dom.mjs), replay the same insertion sequence, and run the real page
 * function against it — offline, with no browser and no Copilot.
 *
 * The point is that a wrong answer costs one run, not a series of them: the
 * capture from that run is the whole diagnosis, and the fix can be verified
 * against it here rather than by going back to the page.
 */
import { El, document as doc, installGlobals, resetDom } from './lib-dom.mjs';
import { askInPage } from './page-fn.mjs';

/** Rebuild one captured node, and everything under it. */
function build(spec) {
  const attrs = {};
  if (spec.id) attrs.id = spec.id;
  if (spec.cls) attrs.class = spec.cls;
  if (spec.testid) attrs['data-testid'] = spec.testid;
  if (spec.role) attrs.role = spec.role;
  if (spec.label) attrs['aria-label'] = spec.label;
  if (spec.contenteditable) attrs.contenteditable = spec.contenteditable;
  const el = new El(spec.tag || 'div', attrs, spec.text || '');
  for (const kid of spec.children || []) el.append(build(kid));
  return el;
}

/** Everything the capture had to leave out, so a replay never lies by omission. */
export function clippings(spec, path = spec.tag || 'root', found = []) {
  if (spec.clipped) found.push(`${path}: ${spec.clipped} ${spec.children ? 'children' : 'chars'} clipped`);
  if (spec.clippedDepth) found.push(`${path}: ${spec.clippedDepth} children below the capture depth`);
  (spec.children || []).forEach((k, i) => clippings(k, `${path}>${k.tag || '?'}[${i}]`, found));
  return found;
}

/**
 * Which top-level turns to treat as this exchange's insertions. The capture
 * records them; older captures and hand-written fixtures fall back to the
 * trailing run that starts at the last turn echoing the prompt.
 */
/** The captured node that holds the turns, and how to reach it. */
export function turnList(capture) {
  let node = capture.tree;
  const path = [];
  if (Array.isArray(capture.listPath)) {
    for (const i of capture.listPath) {
      const next = node.children && node.children[i];
      if (!next) break;
      node = next; path.push(i);
    }
  } else {
    // Older captures did not record it; descend the same way page-fn does.
    while (node.children && node.children.length === 1 && (node.children[0].children || []).length) {
      node = node.children[0]; path.push(0);
    }
  }
  return { node, path };
}

function addedIndexes(capture) {
  const tops = (turnList(capture).node.children) || [];
  // addedTops is indexed against the turn list, which only captures carrying
  // listPath identify; in an older capture it counted a different level, so
  // it is ignored rather than trusted wrongly.
  if (Array.isArray(capture.listPath) && Array.isArray(capture.addedTops) && capture.addedTops.length) {
    return capture.addedTops;
  }
  const head = String(capture.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const textOf = (n) => (n.text || '') + (n.children || []).map(textOf).join('\n');
  if (head) {
    for (let i = tops.length - 1; i >= 0; i--) {
      if (textOf(tops[i]).replace(/\s+/g, ' ').includes(head)) {
        return tops.map((_, j) => j).filter((j) => j >= i);
      }
    }
  }
  return tops.length ? [tops.length - 1] : [];
}

/**
 * Rebuild the captured page and run the page function against it.
 * Returns the page function's own result, plus what the replay had to assume.
 */
export async function replay(capture, opts = {}) {
  if (!capture || !capture.tree) throw new Error('capture has no DOM tree (was it written by an older build?)');
  const prompt = opts.prompt || capture.prompt || '';
  if (!prompt) throw new Error('capture has no prompt; pass one with --prompt');

  const sel = capture.selectors || {};
  const cfg = {
    inputSelector: opts.inputSelector || sel.input || '#m365-chat-editor-target-element',
    sendSelector: opts.sendSelector !== undefined ? opts.sendSelector : (sel.send || ''),
    answerSelector: opts.answerSelector || sel.answer || '[data-testid="markdown-reply"]',
    // A replay has no live page, so there is never a stop control to watch;
    // the quiet fallback is what ends the wait.
    stopSelector: 'nothing-matches-this',
    quietMs: opts.quietMs || 60,
    answerTimeoutMs: opts.answerTimeoutMs || 4000,
    prompt,
  };

  const restore = installGlobals();
  try {
    resetDom();

    // Split the captured turns: what was on screen before we sent, and what
    // the page added afterwards. The latter is appended on Enter, in order,
    // which is the sequence the MutationObserver actually saw — so the
    // added-node strategy is exercised exactly as it was live.
    const { path: listPath } = turnList(capture);
    const added = new Set(addedIndexes(capture));
    const pending = [];
    const buildSplit = (spec, depth) => {
      const atList = depth === listPath.length;
      const el = build({ ...spec, children: [] });
      (spec.children || []).forEach((kid, i) => {
        if (atList && added.has(i)) { pending.push(build(kid)); return; }
        el.append(depth < listPath.length && i === listPath[depth] ? buildSplit(kid, depth + 1) : build(kid));
      });
      return el;
    };
    const region = buildSplit(capture.tree, 0);
    doc.body.append(region);
    const list = listPath.reduce((n, i) => n.children[i], region);
    const tops = [...list.children, ...pending];

    // The composer. Captured from the live page when available; otherwise
    // synthesised from the input selector so a replay still has somewhere
    // to type.
    const desc = capture.input || {};
    const idFromSel = (cfg.inputSelector.match(/#([\w-]+)/) || [])[1];
    const input = build({
      tag: desc.tag || 'span',
      id: desc.id || idFromSel,
      cls: desc.cls,
      testid: desc.testid,
      role: desc.role || 'textbox',
      label: desc.label,
      contenteditable: desc.contenteditable || 'true',
    });
    input.rect = { x: 140, y: 833, width: 704, height: 27 };
    const wrap = new El('div', { class: 'composer' });
    wrap.append(input);
    doc.body.append(wrap);
    doc._editor = input;

    let sent = false;
    input.onKey = (ev) => {
      if (ev.key !== 'Enter' || sent) return;
      sent = true;
      input.textContent = '';
      let i = 0;
      const next = () => {
        if (i >= pending.length) return;
        list.append(pending[i++]);
        setTimeout(next, 8);
      };
      setTimeout(next, 8);
    };

    const res = await askInPage(cfg);
    return {
      ...res,
      replay: {
        prompt,
        selectors: { input: cfg.inputSelector, send: cfg.sendSelector, answer: cfg.answerSelector },
        turnsBefore: tops.length - pending.length,
        turnsAdded: pending.length,
        addedTops: [...added],
        capturedMethod: capture.method || null,
        capturedWinner: capture.winnerPath || null,
        clipped: clippings(capture.tree),
      },
    };
  } finally { restore(); }
}

/** A short human report of a replay, for --replay and /replay. */
export function report(res) {
  const lines = [];
  const r = res.replay;
  lines.push(`prompt        ${JSON.stringify(r.prompt.slice(0, 80))}`);
  lines.push(`selectors     input=${r.selectors.input}  answer=${r.selectors.answer}`);
  lines.push(`turns         ${r.turnsBefore} already present, ${r.turnsAdded} appended on send [${r.addedTops.join(', ')}]`);
  if (r.capturedWinner) lines.push(`live picked   ${r.capturedMethod || '?'} @ ${r.capturedWinner}`);
  lines.push(`replay picked ${res.method}`);
  lines.push('');
  lines.push('candidates (best first):');
  for (const c of (res.debug && res.debug.candidates) || []) {
    const flags = [c.mostlyButtons && 'mostlyButtons', c.containsPrompt && 'containsPrompt', c.skipped]
      .filter(Boolean).join(' ');
    lines.push(`  ${String(c.score).padStart(7)}  ${String(c.chars).padStart(5)}ch  ${c.name}${flags ? '  [' + flags + ']' : ''}`);
    if (c.sample) lines.push(`           ${JSON.stringify(c.sample.slice(0, 90))}`);
  }
  if (r.clipped.length) {
    lines.push('');
    lines.push('the capture was clipped here, so the replay is not exact:');
    for (const c of r.clipped.slice(0, 10)) lines.push(`  ${c}`);
  }
  lines.push('');
  lines.push(`answer (${(res.text || '').length} chars):`);
  lines.push(res.text || '(nothing extracted)');
  return lines.join('\n');
}

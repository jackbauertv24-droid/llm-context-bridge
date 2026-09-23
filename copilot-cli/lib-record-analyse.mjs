// Turn a conversation recording into answers.
//
// The recording keeps raw material; this reads it and says, for each
// question that has actually mattered, what the page did. It runs on the
// machine that took the recording, so the answers are printed at once, and
// it runs in tests against the same file, so the bridge can be checked
// against what the page really returns rather than what it was assumed to.

import { parseToolTags } from './lib-agent.mjs';

const ZW = /[\u200B-\u200D\u2060\uFEFF]/g;
const squash = (s) => String(s || '').replace(ZW, '').replace(/\s+/g, '');

const markerCounts = (text) => {
  const lines = String(text || '').split(/\r?\n/);
  return {
    lines: lines.length,
    bullets: lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length,
    headings: lines.filter((l) => /^\s*#{1,6}\s+/.test(l)).length,
    fences: lines.filter((l) => /^\s*`{3,}/.test(l)).length,
  };
};

/** Where two strings of our own text first part company, with context. */
function firstDifferences(a, b, max = 3) {
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length && out.length < max) {
    if (a[i] === b[j]) { i++; j++; continue; }
    out.push({
      atTyped: i,
      typed: JSON.stringify(a.slice(Math.max(0, i - 20), i + 20)),
      held: JSON.stringify(b.slice(Math.max(0, j - 20), j + 20)),
    });
    // Resynchronise on the next 12 characters of the typed text.
    const probe = a.slice(i, i + 12);
    const k = b.indexOf(probe, j);
    if (k === -1) break;
    j = k;
  }
  return out;
}

function analyseComposer(turn) {
  if (!turn.composerHeld) return null;
  const typed = turn.typed || '';
  const held = turn.composerHeld.text || '';
  const zeroWidth = (held.match(ZW) || []).length;
  const typedM = markerCounts(typed);
  const heldM = markerCounts(held);
  const sameContent = squash(typed) === squash(held);
  let verdict;
  if (typed === held) verdict = 'identical';
  else if (sameContent) verdict = 'same content, whitespace or invisible characters differ';
  else if (squash(held).length === squash(typed).length * 2) verdict = 'DOUBLED';
  else verdict = 'content differs';
  return {
    verdict,
    typedLength: typed.length,
    heldLength: held.length,
    typedNewlines: (typed.match(/\n/g) || []).length,
    heldNewlines: (held.match(/\n/g) || []).length,
    zeroWidth,
    markersTyped: typedM,
    markersHeld: heldM,
    differences: sameContent ? [] : firstDifferences(typed.replace(/\s+/g, ' '), held.replace(ZW, '').replace(/\s+/g, ' ')),
  };
}

function analyseEcho(turn) {
  if (!turn.echo) return { found: false };
  const text = turn.echo.text || '';
  return {
    found: true,
    length: text.length,
    newlinesInEcho: (text.match(/\n/g) || []).length,
    newlinesTyped: ((turn.typed || '').match(/\n/g) || []).length,
    containsTypedContent: squash(text).includes(squash(turn.typed).slice(0, 200)),
    // Would a space-normalised comparison find the prompt in the echo?
    matchesWithSpaces: String(text).replace(/\s+/g, ' ').includes(String(turn.typed).replace(/\s+/g, ' ').slice(-60)),
    matchesSquashed: squash(text).includes(squash(turn.typed).slice(-60)),
  };
}

function analyseAnswer(turn, tools) {
  if (!turn.answer) return { found: false };
  const text = turn.answer.text || '';
  const lines = text.split(/\r?\n/);
  const calls = parseToolTags(text, tools);
  return {
    found: true,
    length: text.length,
    newAnswerNodes: turn.answer.newAnswerNodes,
    containsTag: /<copilot:/.test(text),
    plainTextCaption: lines.some((l) => /^\s*plain ?text\s*$/i.test(l)),
    gutterLines: lines.filter((l) => /^\s*\d+\s*$/.test(l)).length,
    fenceLinesInText: lines.filter((l) => /^\s*`{3,}/.test(l)).length,
    // The question the agent lives or dies on.
    bridgeParses: calls.map((c) => c.name),
    unknownTagNames: calls.unknown || [],
    htmlHasCodeElement: /<(pre|code)\b/i.test(turn.answer.html || ''),
  };
}

const leading = (l) => (String(l).match(/^[ \t]*/) || [''])[0];

/**
 * Did a multi-line body survive the page? This is what write and edit live
 * on: if the page drops indentation, eats a blank line, turns a tab into
 * spaces, or leaves its line-number gutter inside the code, every file the
 * agent writes comes out wrong.
 */
function analyseCodeBody(turn, tools, expected) {
  const text = (turn.answer && turn.answer.text) || '';
  const calls = parseToolTags(text, tools);
  const w = calls.find((c) => c.name === 'write');
  if (!w) {
    return { parsed: false, reason: calls.length ? `got ${calls.map((c) => c.name).join(', ')} instead` : 'no write tag found in the reply' };
  }
  const got = w.body;
  const exp = String(expected || '');
  const expLines = exp.split('\n');
  const gotLines = got.split('\n');
  // Match lines by their content, so a missing or extra line does not throw
  // every later comparison off.
  const byContent = new Map(gotLines.map((l) => [l.trim(), l]));
  const indentLost = expLines.filter((l) => l.trim() && byContent.has(l.trim()) && leading(byContent.get(l.trim())) !== leading(l));
  return {
    parsed: true,
    exact: got === exp,
    expectedLines: expLines.length,
    gotLines: gotLines.length,
    indentationPreserved: indentLost.length === 0,
    indentationLostOn: indentLost.slice(0, 4),
    tabPreserved: exp.includes('\t') ? got.includes('\t') : null,
    blankLinePreserved: exp.split('\n').includes('') ? gotLines.includes('') : null,
    nonAsciiPreserved: /[\u4e00-\u9fff]/.test(exp) ? /[\u4e00-\u9fff]/.test(got) && got.includes('\u2014') : null,
    backslashesPreserved: exp.includes('\\') ? got.includes('\\') : null,
    // A gutter that ends up inside the body shows as lines of bare digits.
    digitOnlyLinesInBody: gotLines.filter((l) => /^\s*\d+\s*$/.test(l)).length,
    differences: got === exp ? [] : firstDifferences(exp, got),
  };
}

/** Whether the box takes a long message whole, and if not, where it stops. */
function analyseLong(turn) {
  const held = turn.composerHeld ? turn.composerHeld.text || '' : '';
  const heldVisible = held.replace(ZW, '').length;
  return {
    typed: turn.typedLength,
    held: heldVisible,
    truncated: heldVisible < turn.typedLength * 0.98,
    maxlength: turn.composerLimit ? turn.composerLimit.maxlength : null,
    counters: turn.composerLimit ? turn.composerLimit.counters : [],
    sendRegistered: !turn.sendNotRegistered,
    notices: (turn.notices || []).map((n) => n.text),
  };
}

export function analyseConversation(rec, tools, { expect = {} } = {}) {
  const turns = (rec.turns || []).map((t) => ({
    index: t.index,
    label: t.label || null,
    codeBody: t.label === 'code-body' && t.answer ? analyseCodeBody(t, tools, expect['code-body']) : undefined,
    long: t.label === 'long' ? analyseLong(t) : undefined,
    notices: (t.notices || []).map((n) => n.text),
    method: t.method || 'enter',
    skipped: t.skipped || null,
    sendNotRegistered: !!t.sendNotRegistered,
    enterConsumed: t.enterConsumed,
    sendButton: t.sendButton ? { ariaLabel: t.sendButton.ariaLabel, testid: t.sendButton.testid, path: t.sendButton.path } : null,
    buttonNotFound: !!t.buttonNotFound,
    clearedAfterNoSend: t.clearedAfterNoSend,
    clearing: t.clearing || null,
    reusedPreviousText: t.reusedPreviousText || null,
    insertMs: t.insertMs,
    maxGrowthGapMs: t.maxGrowthGapMs,
    answerReplacedMidStream: t.answerReplacedMidStream,
    stopLikeVisibleAfter: (t.stopLikeVisibleAfter || []).length,
    timing: {
      composerClearedAt: t.composerClearedAt, stopAppearedAt: t.stopAppearedAt,
      stopGoneAt: t.stopGoneAt, answerAppearedAt: t.answerAppearedAt, echoFoundAt: t.echoFoundAt,
      totalMs: t.totalMs,
    },
    stopControl: (t.stopControl || []).map((s) => ({ ariaLabel: s.ariaLabel, title: s.title, testid: s.testid, path: s.path })),
    sendButtonsWhileTyped: (t.composerButtonsTyped || []).map((b) => ({ ariaLabel: b.ariaLabel, testid: b.testid, disabled: b.disabled, visible: b.visible })),
    composer: analyseComposer(t),
    echo: analyseEcho(t),
    answer: analyseAnswer(t, tools),
  }));
  const a1 = rec.turns && rec.turns[0] && rec.turns[0].answer;
  const a2 = rec.turns && rec.turns[1] && rec.turns[1].answer;
  return {
    idle: rec.idle,
    clearTest: rec.clearTest || null,
    bridge: rec.bridge || null,
    keyClears: rec.keyClears || [],
    leftInBox: rec.leftInBox || null,
    before: rec.before ? { answerNodes: rec.before.answerNodes, stopLikeVisible: (rec.before.stopLikeVisible || []).length } : null,
    turns,
    secondTurnReadsNewAnswer: a1 && a2 ? a1.text !== a2.text : null,
  };
}

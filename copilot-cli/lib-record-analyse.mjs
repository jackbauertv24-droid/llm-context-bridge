// Turn a conversation recording into answers.
//
// The recording keeps raw material; this reads it and says, for each
// question that has actually mattered, what the page did. It runs on the
// machine that took the recording, so the answers are printed at once, and
// it runs in tests against the same file, so the bridge can be checked
// against what the page really returns rather than what it was assumed to.

import { parseToolTags } from './lib-agent.mjs';

const ZW = /[​-‍⁠﻿]/g;
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

export function analyseConversation(rec, tools) {
  const turns = (rec.turns || []).map((t) => ({
    index: t.index,
    skipped: t.skipped || null,
    sendNotRegistered: !!t.sendNotRegistered,
    enterConsumed: t.enterConsumed,
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
    before: rec.before ? { answerNodes: rec.before.answerNodes, stopLikeVisible: (rec.before.stopLikeVisible || []).length } : null,
    turns,
    secondTurnReadsNewAnswer: a1 && a2 ? a1.text !== a2.text : null,
  };
}

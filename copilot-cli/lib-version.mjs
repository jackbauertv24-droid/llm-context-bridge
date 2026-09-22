// One build identifier, imported wherever a diagnostic is written.
//
// It lived only in chat.mjs, so the confluence report carried no version at
// all and ten commits once shipped under the previous one. A single export
// is harder to forget than a string in one file among several.
export const VERSION = '2026-09-22.9';

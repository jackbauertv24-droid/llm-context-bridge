// MV3 service worker. Ephemeral by design: Chrome stops it after ~30s idle and
// restarts it on the next event. The start counter below makes that visible —
// reopen the popup after a minute and watch the number climb.

const started = Date.now();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installedAt: new Date().toISOString() });
});

// Count each cold start of the worker.
chrome.storage.local.get({ swStarts: 0 }).then(({ swStarts }) => {
  chrome.storage.local.set({ swStarts: swStarts + 1, lastSwStart: new Date().toISOString() });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, pong: Date.now(), workerAliveMs: Date.now() - started });
  }
  return true;
});

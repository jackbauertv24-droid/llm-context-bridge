// Every check is read-only. The only network traffic is to 127.0.0.1:8787,
// which is the echo server in this folder, started by you.

const BRIDGE_HTTP = 'http://127.0.0.1:8787/health';
const BRIDGE_WS = 'ws://127.0.0.1:8787';
const COPILOT = 'https://copilot.cloud.microsoft/*';

const list = document.getElementById('results');

function row(label) {
  const li = document.createElement('li');
  li.className = 'pending';
  li.innerHTML = '<span class="mark">…</span><span class="label"></span>';
  li.querySelector('.label').textContent = label;
  list.appendChild(li);
  return {
    set(state, detail) {
      li.className = state;
      li.querySelector('.mark').textContent = { ok: '✓', bad: '✗', warn: '!' }[state] ?? '…';
      if (detail) {
        const d = document.createElement('span');
        d.className = 'detail';
        d.textContent = detail;
        li.querySelector('.label').appendChild(d);
      }
    },
  };
}

async function check(label, fn) {
  const r = row(label);
  try {
    const { state, detail } = await fn();
    r.set(state, detail);
  } catch (err) {
    r.set('bad', String(err && err.message ? err.message : err));
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// 1. The extension is running at all.
await check('Extension loaded', async () => {
  const m = chrome.runtime.getManifest();
  return { state: 'ok', detail: `${m.name} ${m.version}, manifest_version ${m.manifest_version}` };
});

// 2. Browser build. Edge and Chrome differ on sideloading policy.
await check('Browser', async () => {
  const ua = navigator.userAgent;
  const edge = /Edg\/([\d.]+)/.exec(ua);
  const chrome_ = /Chrome\/([\d.]+)/.exec(ua);
  const name = edge ? `Edge ${edge[1]}` : chrome_ ? `Chrome ${chrome_[1]}` : ua.slice(0, 80);
  return { state: 'ok', detail: name };
});

// 3. How the browser classifies this install. "development" means unpacked
//    loading worked, which is the whole question. getSelf needs no permission.
await check('Install type', async () => {
  const self_ = await chrome.management.getSelf();
  const detail = `installType="${self_.installType}", enabled=${self_.enabled}`;
  if (self_.installType === 'development') return { state: 'ok', detail: `${detail} — unpacked sideloading works` };
  if (self_.installType === 'admin') return { state: 'warn', detail: `${detail} — force-installed by policy` };
  return { state: 'warn', detail };
});

// 4. Service worker round trip. Proves the MV3 background context can start.
await check('Service worker responds', async () => {
  const res = await withTimeout(chrome.runtime.sendMessage({ type: 'ping' }), 3000, 'service worker ping');
  return { state: 'ok', detail: `alive ${res.workerAliveMs}ms — MV3 workers stop when idle, this is normal` };
});

// 5. Service worker restart count, to make the lifecycle visible.
await check('Service worker restarts', async () => {
  const { swStarts = 0, lastSwStart } = await chrome.storage.local.get(['swStarts', 'lastSwStart']);
  return { state: 'ok', detail: `${swStarts} cold start(s); last ${lastSwStart || 'n/a'}. Reopen in a minute and watch it climb.` };
});

// 6. Storage works (some policies restrict it).
await check('Extension storage', async () => {
  const token = `probe-${Date.now()}`;
  await chrome.storage.local.set({ probe: token });
  const { probe } = await chrome.storage.local.get('probe');
  return probe === token
    ? { state: 'ok', detail: 'read/write ok' }
    : { state: 'bad', detail: 'value did not round trip' };
});

// 7. Can it reach a local server over HTTP? This is the bridge question.
await check('Localhost HTTP (127.0.0.1:8787)', async () => {
  const res = await withTimeout(fetch(BRIDGE_HTTP, { cache: 'no-store' }), 4000, 'localhost fetch');
  const body = await res.json();
  return { state: 'ok', detail: `HTTP ${res.status}, server says "${body.service}"` };
});

// 8. Same over WebSocket. An MV3 worker cannot hold this open indefinitely,
//    but the handshake succeeding is what tells you the transport is allowed.
await check('Localhost WebSocket', async () => {
  const detail = await withTimeout(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_WS);
      ws.onopen = () => ws.send('probe-hello');
      ws.onmessage = (ev) => { resolve(`handshake ok, echo: "${String(ev.data).slice(0, 40)}"`); ws.close(); };
      ws.onerror = () => reject(new Error('connection failed — is echo-server.mjs running?'));
    }),
    5000,
    'websocket',
  );
  return { state: 'ok', detail };
});

// 9. Is host access to the target domain already granted or policy-blocked?
await check('Copilot host permission', async () => {
  const granted = await chrome.permissions.contains({ origins: [COPILOT] });
  return granted
    ? { state: 'ok', detail: 'already granted' }
    : { state: 'warn', detail: 'not granted yet — use the button below' };
});

// ---- optional, user-initiated: the runtime_blocked_hosts test ----

document.getElementById('host-test').addEventListener('click', async () => {
  const r = row('Copilot access test');
  try {
    const granted = await chrome.permissions.request({ origins: [COPILOT] });
    if (!granted) {
      r.set('bad', 'permission request refused. If no prompt appeared at all, an admin policy blocked it.');
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/copilot\.cloud\.microsoft/.test(tab.url || '')) {
      r.set('warn', 'permission granted, but the active tab is not copilot.cloud.microsoft — open one and retry.');
      return;
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, href: location.href }),
    });
    r.set('ok', `injected successfully. Page title: "${result.title}". Extension-based bridging is viable.`);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const blocked = /blocked|policy|cannot access|extension manifest/i.test(msg);
    r.set('bad', blocked ? `blocked: ${msg} — this is what runtime_blocked_hosts looks like.` : msg);
  }
});

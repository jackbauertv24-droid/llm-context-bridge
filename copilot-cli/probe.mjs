#!/usr/bin/env node
/**
 * DOM recon over the Chrome DevTools Protocol, for driving a chat web UI from a
 * CLI. It attaches to a Chrome you launched yourself with remote debugging on,
 * finds the open tab, and inventories the elements an automation would need:
 * the text input, the send control, and where answers are rendered.
 *
 * It is read-only: it reads element metadata and a little visible text. It does
 * not read network traffic, headers, cookies or tokens, and changes nothing on
 * the page.
 *
 *   1. Launch Chrome with a debugging port (see README), signed in, tab open.
 *   2. node probe.mjs
 *   3. Paste the single report block it prints back for selector tuning.
 *
 * Zero npm dependencies: the CDP client is a small JSON-over-WebSocket wrapper
 * built on node's builtin WebSocket, so it runs where installs are blocked.
 */
import http from 'node:http';
import { pageInventory } from './probe-fn.mjs';

const PORT = Number(process.env.CDP_PORT || 9222);
const HOST = process.env.CDP_HOST || '127.0.0.1';
const MATCH = process.env.TAB_MATCH || 'copilot.cloud.microsoft';

// ---- find the target tab via the CDP HTTP endpoint ----

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

// ---- minimal CDP session over the page's WebSocket ----

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP websocket failed'));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15000);
    });
  }
  async eval(fnSource) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(${fnSource})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval threw');
    return r.result.value;
  }
}

// The page-side inventory lives in probe-fn.mjs (shared with chat.mjs /probe).

// ---- run ----

async function main() {
  let tabs;
  try {
    tabs = await getJson('/json');
  } catch (e) {
    console.error(`\nCannot reach Chrome debugging endpoint at http://${HOST}:${PORT}.`);
    console.error(`Reason: ${e.message}`);
    console.error('Launch Chrome with remote debugging first — see README.md, section "Launch Chrome".');
    process.exit(1);
  }

  // Probe every real page, not just one. Falling back to "the first tab"
  // silently probed Chrome's own /json listing once and produced an empty
  // report, which cost a whole round trip — so now nothing is guessed: if the
  // match misses, every page is inventoried and the right one is in there.
  const pages = tabs.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
  if (!pages.length) {
    console.error(`No page tab found. Open ${MATCH} in the debugged Chrome and retry.`);
    process.exit(1);
  }
  const matched = pages.filter((t) => (t.url || '').includes(MATCH));
  const targets = matched.length ? matched : pages;
  if (!matched.length) {
    console.error(`No tab matched "${MATCH}" — inventorying all ${pages.length} page tab(s) instead.`);
  }

  const out = [];
  out.push('===== COPILOT-CLI DOM PROBE =====');
  out.push(`when: ${new Date().toISOString()}`);
  out.push(`tabs probed: ${targets.length} of ${pages.length} (match "${MATCH}"${matched.length ? '' : ' — no match, so all'})`);

  for (const target of targets) {
    let report;
    const cdp = new CDP(target.webSocketDebuggerUrl);
    try {
      await cdp.connect();
      await cdp.send('Runtime.enable');
      report = await cdp.eval(pageInventory.toString());
    } catch (e) {
      out.push(`\n########## TAB ${target.url}\n(could not probe: ${e.message})`);
      continue;
    } finally { try { cdp.ws?.close(); } catch { /* already gone */ } }

    out.push(`\n########## TAB ${report.url}`);
    out.push(`title: ${report.title}`);
    out.push(`viewport: ${report.viewport.w}x${report.viewport.h}`);
    out.push(`counts: ${JSON.stringify(report.counts)}`);
    const block = (name, arr) => {
      out.push(`\n--- ${name} (${arr.length}) ---`);
      arr.forEach((o, i) => out.push(`[${i}] ${JSON.stringify(o)}`));
    };
    block('INPUT CANDIDATES (lowest on screen first)', report.inputs);
    block('SEND-BUTTON CANDIDATES', report.buttons);
    block('LIVE / LIST REGIONS (answer streams here)', report.liveRegions);
    block('REPEATED CONTAINERS (message lists)', report.containers);
    block('LAST TEXT BLOCKS (recent turns)', report.lastBlocks);
  }
  out.push('\n===== END PROBE =====');

  const text = out.join('\n');
  console.log(text);

  try {
    const fs = await import('node:fs');
    fs.writeFileSync('copilot-cli-probe.txt', text + '\n');
    console.log('\n(Report also saved to copilot-cli-probe.txt — cat it and paste the whole thing back.)');
  } catch { /* stdout is enough */ }

  process.exit(0);

}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

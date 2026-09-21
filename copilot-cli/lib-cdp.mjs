// Shared minimal Chrome DevTools Protocol client — JSON over the page's
// WebSocket, zero npm dependencies. Attaches to a Chrome the user launched with
// remote debugging on, and evaluates functions in the page. Reads/writes only
// page DOM; never touches network, headers, cookies or tokens.
import http from 'node:http';

export function getJson(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}

export async function findTab({ host = '127.0.0.1', port = 9222, match = 'copilot.cloud.microsoft' } = {}) {
  const tabs = await getJson(host, port, '/json');
  const pages = tabs.filter((t) => t.type === 'page');
  const target = pages.find((t) => (t.url || '').includes(match));
  if (!target) {
    const seen = pages.map((p) => p.url).join('\n  ') || '(none)';
    throw new Error(`No tab matching "${match}". Open tabs:\n  ${seen}`);
  }
  return target;
}

export class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = []; }

  connect() {
    // Node gained a global WebSocket in 22. On an older runtime the failure is
    // otherwise a bare "WebSocket is not defined" from inside a promise, which
    // reads like a bug in the bridge rather than a runtime to upgrade.
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error(
        `this Node (${process.version}) has no global WebSocket. Use Node 22 or newer, `
        + 'or on 20/21 run: node --experimental-websocket chat.mjs'));
    }
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('CDP websocket failed to open'));
      this.ws.onclose = () => {
        this.closed = true;
        for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
        this.pending.clear();
      };
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      };
    });
  }

  on(fn) { this.listeners.push(fn); }

  /** Whether this session can still carry a request. */
  get live() { return !this.closed && !!this.ws && this.ws.readyState === 1; }

  send(method, params = {}, timeoutMs = 20000) {
    if (!this.live) return Promise.reject(new Error('CDP closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeoutMs);
    });
  }

  // Evaluate a serialized function in the page and return its value.
  async evalFn(fn, argJson = null, { awaitPromise = true, timeoutMs = 20000 } = {}) {
    const expr = argJson === null
      ? `(${fn.toString()})()`
      : `(${fn.toString()})(${JSON.stringify(argJson)})`;
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise,
    }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval threw');
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

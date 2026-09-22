/**
 * A DOM small enough to hand-write and real enough to run the page function
 * against — elements, attributes, innerText, the handful of selector forms the
 * code actually uses, and a MutationObserver that fires like the real one
 * (reporting only the outermost node of an insertion, which is the detail that
 * caused the suggestion chips to be printed as an answer).
 *
 * Zero dependencies, like the rest of the project, and deliberately not a
 * general DOM: it supports exactly what page-fn.mjs asks for.
 */

const observers = [];

function notify(records) {
  for (const o of observers) {
    const mine = records.filter((r) => o.target === r.target || o.target.contains(r.target));
    if (mine.length) queueMicrotask(() => o.cb(mine));
  }
}

// Selector support: comma-separated compounds of tag, #id and [attr],
// [attr="v"], [attr*="v" i]. No combinators, because none are used.
function matchOne(el, compound) {
  const parts = compound.trim().match(/^([a-zA-Z]+)?((?:#[\w-]+|\[[^\]]*\])*)$/);
  if (!parts) return false;
  if (parts[1] && el.tagName !== parts[1].toUpperCase()) return false;
  for (const bit of parts[2].match(/#[\w-]+|\[[^\]]*\]/g) || []) {
    if (bit[0] === '#') { if (el.id !== bit.slice(1)) return false; continue; }
    const m = bit.slice(1, -1).match(/^([\w-]+)(?:(\*?)=("([^"]*)"|[^\s\]]+))?(\s+i)?$/);
    if (!m) return false;
    const name = m[1];
    const want = m[4] !== undefined ? m[4] : m[3];
    const have = el.getAttribute(name);
    if (have === null) return false;
    if (want === undefined) continue;
    const ci = !!m[5];
    const a = ci ? have.toLowerCase() : have;
    const b = ci ? want.toLowerCase() : want;
    if (m[2] === '*' ? !a.includes(b) : a !== b) return false;
  }
  return true;
}

export class El {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this._text = text;
    this.nodeType = 1;
    this.rect = { x: 0, y: 0, width: 200, height: 20 };
  }

  get id() { return this.attrs.id || ''; }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  get isContentEditable() { return this.attrs.contenteditable === 'true' || this.attrs.contenteditable === ''; }

  get innerText() {
    if (!this.children.length) return this._text;
    return this.children.map((c) => c.innerText).filter((t) => t !== '').join('\n');
  }
  set textContent(v) { this.children = []; this._text = v; }
  get value() { return undefined; }

  get isConnected() { let e = this; while (e.parentElement) e = e.parentElement; return e === document.body; }

  get firstChild() { return this.children[0] || null; }
  removeChild(kid) {
    const i = this.children.indexOf(kid);
    if (i >= 0) { this.children.splice(i, 1); kid.parentElement = null; }
    return kid;
  }
  append(...kids) {
    for (const k of kids) { k.parentElement = this; this.children.push(k); }
    notify(kids.map((k) => ({ type: 'childList', addedNodes: [k], target: this })));
    return kids[kids.length - 1];
  }
  /** Change a leaf's text, the way streaming does. */
  setText(t) { this._text = t; notify([{ type: 'characterData', target: this }]); }

  contains(o) { for (let e = o; e; e = e.parentElement) if (e === this) return true; return false; }
  matches(sel) { return String(sel).split(',').some((c) => matchOne(this, c)); }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches(sel)) return e; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { ...this.rect }; }
  focus() { this.focused = true; }
  addEventListener(t, f) { (this._on ||= {})[t] = [...((this._on || {})[t] || []), f]; }
  click() {
    this.dispatchEvent(new (globalThis.Event || Object)('click', { bubbles: true, cancelable: true }));
  }
  dispatchEvent(ev) {
    for (const f of (this._on && this._on[ev.type]) || []) f(ev);
    if (this.onKey && ev.type === 'keydown') this.onKey(ev);
    return true;
  }
}

export const document = {
  body: new El('body'),
  querySelector(sel) { return document.body.querySelector(sel); },
  querySelectorAll(sel) { return document.body.querySelectorAll(sel); },
  createRange: () => ({ selectNodeContents() {} }),
  execCommand(cmd, _ui, arg) {
    const el = document._editor;
    if (!el) return false;
    if (cmd === 'delete') el.textContent = '';
    if (cmd === 'insertText') el.textContent = arg;
    return true;
  },
};

/** Install the globals page-fn.mjs expects. Returns a restore function. */
export function installGlobals() {
  const saved = {};
  const set = (k, v) => { saved[k] = globalThis[k]; globalThis[k] = v; };
  set('document', document);
  set('getComputedStyle', () => ({ visibility: 'visible', display: 'block' }));
  set('window', { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) });
  set('MutationObserver', class {
    constructor(cb) { this.cb = cb; }
    observe(target) { this.entry = { cb: this.cb, target }; observers.push(this.entry); }
    disconnect() { const i = observers.indexOf(this.entry); if (i >= 0) observers.splice(i, 1); }
  });
  set('KeyboardEvent', class { constructor(type, init) { Object.assign(this, init); this.type = type; } });
  set('InputEvent', class { constructor(type, init) { Object.assign(this, init); this.type = type; } });
  set('Event', class { constructor(type, init) { Object.assign(this, init); this.type = type; } });
  set('HTMLTextAreaElement', class {});
  set('HTMLInputElement', class {});
  return () => { for (const k of Object.keys(saved)) globalThis[k] = saved[k]; observers.length = 0; };
}

export function resetDom() {
  document.body = new El('body');
  document._editor = null;
  observers.length = 0;
}

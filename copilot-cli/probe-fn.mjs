// The page-side DOM inventory, shared by probe.mjs (standalone report) and the
// chat.mjs /probe command. Serialized and evaluated inside the tab. Reads only
// element shape and short visible text; changes nothing, touches no network.
export function pageInventory() {
  const short = (s, n = 80) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim().slice(0, n));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { seg += `#${node.id}`; parts.unshift(seg); break; }
      const testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
      if (testid) { seg += `[data-testid="${testid}"]`; parts.unshift(seg); break; }
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || '',
    ariaLabel: short(el.getAttribute('aria-label')),
    placeholder: short(el.getAttribute('placeholder') || el.getAttribute('data-placeholder')),
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
    editable: el.isContentEditable,
    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    text: short(el.innerText || el.textContent, 60),
    rect: rect(el),
    visible: visible(el),
    path: cssPath(el),
  });

  const vh = window.innerHeight;

  const inputs = [...document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], input[type="text"]')]
    .filter(visible).map(describe).sort((a, b) => b.rect.y - a.rect.y);

  const buttons = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.toLowerCase();
      return r.y > vh * 0.6 || /send|submit|ask|arrow/.test(label);
    })
    .map(describe).slice(0, 25);

  const liveRegions = [...document.querySelectorAll('[aria-live], [role="log"], [role="feed"], [role="list"]')]
    .filter(visible)
    .map((el) => ({ ...describe(el), ariaLive: el.getAttribute('aria-live') || '', childCount: el.children.length }))
    .slice(0, 15);

  const containers = [...document.querySelectorAll('div, main, section, ul, ol')]
    .filter(visible)
    .map((el) => {
      const byTag = {};
      for (const k of el.children) byTag[k.tagName] = (byTag[k.tagName] || 0) + 1;
      return { el, repeat: Math.max(0, ...Object.values(byTag)), kids: el.children.length };
    })
    .filter((c) => c.repeat >= 2 && c.kids >= 2)
    .sort((a, b) => b.repeat - a.repeat).slice(0, 8)
    .map((c) => ({ ...describe(c.el), childRepeat: c.repeat, childCount: c.kids }));

  const lastBlocks = [...document.querySelectorAll('body *')]
    .filter((el) => visible(el) && el.children.length === 0 && (el.innerText || '').trim().length > 40)
    .slice(-6)
    .map((el) => ({ path: cssPath(el), text: short(el.innerText, 120) }));

  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    counts: { inputs: inputs.length, buttons: buttons.length, liveRegions: liveRegions.length, containers: containers.length },
    inputs: inputs.slice(0, 8), buttons, liveRegions, containers, lastBlocks,
  };
}

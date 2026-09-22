// lib-confluence.mjs — Corporate Confluence Knowledge Base Bridge over CDP.
//
// Attaches to an existing, already-authenticated Confluence tab in Chrome (port 9222).
// Bypasses corporate SSO, Okta, SAML, and intranet firewalls by running queries
// inside the browser's own session via Chrome DevTools Protocol.
//
// ZERO credentials stored on disk.
// ZERO npm dependencies.
// STRICTLY READ-ONLY: Only GET requests to search and read endpoints are permitted.
// Mutating requests (create, update, delete) are prohibited at the protocol level.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CDP, getJson } from './lib-cdp.mjs';
import { parseEnvFile } from './lib-mailtool.mjs';

/** Error thrown for Confluence configuration or access problems */
export class ConfluenceError extends Error {
  constructor(msg, detail = null) {
    super(msg);
    this.name = 'ConfluenceError';
    this.detail = detail;
  }
}

/**
 * Turns Confluence HTML into structured, readable Markdown.
 * Preserves headings, tables, preformatted code, lists, and spacing while
 * stripping scripts, styles, macros, and navigation chrome.
 */
export function confluenceHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n')
    // Tables
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1\n')
    .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '| $1 ')
    // Code blocks and preformatted text
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Paragraphs, blocks, and line breaks
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // HTML entity decoding
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+- /g, '\n- ')
    .replace(/(\n- [^\n]+)\n{2,}- /g, '$1\n- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Load optional Confluence configuration from confluence.env or process.env.
 * No credentials are required — only optional selectors or tab matching rules.
 */
export function loadConfluenceConfig({ root, envPath, env = process.env } = {}) {
  const candidates = [
    envPath || env.CONFLUENCE_ENV,
    root && path.join(root, 'confluence.env'),
    path.join(path.dirname(new URL(import.meta.url).pathname), 'confluence.env'),
  ].filter(Boolean);

  let fromFile = {};
  let source = null;
  for (const file of candidates) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fromFile = parseEnvFile(fs.readFileSync(file, 'utf8'));
        source = file;
        break;
      }
    } catch { /* proceed without file */ }
  }

  const get = (k, def = '') => env[k] ?? fromFile[k] ?? def;

  return {
    source,
    host: get('CDP_HOST', '127.0.0.1'),
    port: Number(get('CDP_PORT', 9222)),
    tabMatch: get('CONFLUENCE_TAB_MATCH', 'confluence'),
    maxChars: Number(get('CONFLUENCE_MAX_CHARS', 25000)),
    timeoutMs: Number(get('CONFLUENCE_TIMEOUT_MS', 20000)),
  };
}

/**
 * Locates the open Confluence tab among Chrome targets.
 * Matches on URL containing 'confluence', 'wiki', 'atlassian.net', or custom pattern.
 */
export async function findConfluenceTab({ host = '127.0.0.1', port = 9222, match = 'confluence' } = {}) {
  let tabs;
  try {
    tabs = await getJson(host, port, '/json');
  } catch (err) {
    throw new ConfluenceError(`Cannot connect to Chrome DevTools port at ${host}:${port}: ${err.message}. Ensure Chrome is launched with --remote-debugging-port=${port}.`);
  }

  const pages = tabs.filter((t) => t.type === 'page');
  const term = match.toLowerCase();

  // Primary: matches configured match string against URL or title
  let target = pages.find((t) => (t.url || '').toLowerCase().includes(term) || (t.title || '').toLowerCase().includes(term));

  // Fallback: auto-detect common Confluence URL patterns
  if (!target && term === 'confluence') {
    target = pages.find((t) => {
      const u = (t.url || '').toLowerCase();
      const title = (t.title || '').toLowerCase();
      return u.includes('/wiki') || u.includes('atlassian.net/wiki') || u.includes('/confluence') || title.includes('confluence');
    });
  }

  return { target, pages };
}

// ---------------------------------------------------------------- in-tab probe

/**
 * Executed INSIDE the Confluence tab via CDP evalFn.
 * Probes environment, context path, and all available search and content endpoints.
 * Everything executed is strictly GET.
 */
export async function inTabProbeConfluence() {
  const log = [];
  const origin = window.location.origin;

  // Detect context path
  let contextPath = '';
  try {
    if (window.AJS && typeof window.AJS.contextPath === 'function') {
      contextPath = window.AJS.contextPath() || '';
    } else {
      const meta = document.querySelector('meta[name="confluence-context-path"]');
      if (meta && meta.content) contextPath = meta.content;
    }
  } catch { /* fallback to empty */ }

  const baseUrl = origin + contextPath;

  // Metadata discovery
  const meta = {
    title: document.title,
    href: window.location.href,
    origin,
    contextPath,
    baseUrl,
    versionNumber: (window.AJS && window.AJS.params && window.AJS.params.versionNumber)
      || document.querySelector('meta[name="confluence-version"]')?.content
      || 'unknown',
    remoteUser: (window.AJS && window.AJS.params && window.AJS.params.remoteUser)
      || document.querySelector('meta[name="ajs-remote-user"]')?.content
      || '(authenticated session)',
    serverType: window.location.hostname.endsWith('atlassian.net') ? 'cloud' : 'server_or_dc',
  };

  // Helper to execute in-tab GET with timing and safe parsing
  const probeGet = async (relUrl, label) => {
    const fullUrl = relUrl.startsWith('http') ? relUrl : `${origin}${relUrl}`;
    const started = Date.now();
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json, text/plain, */*' },
        credentials: 'include',
      });
      const ms = Date.now() - started;
      const ct = res.headers.get('content-type') || '';
      const status = res.status;
      const statusText = res.statusText;

      let body = null;
      let textSample = '';
      if (ct.includes('json')) {
        try { body = await res.json(); } catch (e) { textSample = `JSON parse failed: ${e.message}`; }
      } else {
        const text = await res.text();
        textSample = text.slice(0, 300);
      }

      return {
        label,
        url: relUrl,
        fullUrl,
        status,
        statusText,
        contentType: ct,
        ms,
        ok: res.ok,
        body,
        textSample,
      };
    } catch (err) {
      return {
        label,
        url: relUrl,
        fullUrl,
        ok: false,
        error: String(err && err.message),
        ms: Date.now() - started,
      };
    }
  };

  const attempts = [];

  // Probe 1: Standard REST API v1 CQL search (siteSearch & text)
  const p1 = await probeGet(
    `${contextPath}/rest/api/content/search?cql=${encodeURIComponent('siteSearch ~ "test" or text ~ "test"')}&limit=3`,
    'REST v1 search (siteSearch CQL)',
  );
  attempts.push(p1);

  // Probe 2: Standard REST API v1 CQL search with text only
  const p2 = await probeGet(
    `${contextPath}/rest/api/content/search?cql=${encodeURIComponent('text ~ "test"')}&limit=3`,
    'REST v1 search (text CQL)',
  );
  attempts.push(p2);

  // Probe 3: Older Prototype Search API (Confluence Server / DC fallback)
  const p3 = await probeGet(
    `${contextPath}/rest/prototype/1/search?query=test&max-results=3`,
    'Prototype REST search',
  );
  attempts.push(p3);

  // Probe 4: Quicksearch autocomplete API
  const p4 = await probeGet(
    `${contextPath}/rest/quicksearch/1.0/productsearch?query=test`,
    'Quicksearch productsearch API',
  );
  attempts.push(p4);

  // Probe 5: Spaces API
  const p5 = await probeGet(
    `${contextPath}/rest/api/space?limit=5`,
    'REST v1 Spaces API',
  );
  attempts.push(p5);

  // Probe 6: Content retrieval
  // Identify first discovered content ID from any successful search
  let sampleContentId = null;
  let sampleTitle = null;

  if (p1.ok && p1.body && Array.isArray(p1.body.results) && p1.body.results.length) {
    sampleContentId = p1.body.results[0].id;
    sampleTitle = p1.body.results[0].title;
  } else if (p2.ok && p2.body && Array.isArray(p2.body.results) && p2.body.results.length) {
    sampleContentId = p2.body.results[0].id;
    sampleTitle = p2.body.results[0].title;
  } else if (p3.ok && p3.body && Array.isArray(p3.body.result) && p3.body.result.length) {
    sampleContentId = p3.body.result[0].id;
    sampleTitle = p3.body.result[0].title;
  }

  let contentProbe = null;
  if (sampleContentId) {
    contentProbe = await probeGet(
      `${contextPath}/rest/api/content/${sampleContentId}?expand=body.view,version,space`,
      `REST v1 Content Fetch (id=${sampleContentId})`,
    );
    attempts.push(contentProbe);
  }

  // Deduce strategy
  let searchStrategy = null;
  if (p1.ok && p1.body && Array.isArray(p1.body.results)) searchStrategy = 'rest_v1_cql_siteSearch';
  else if (p2.ok && p2.body && Array.isArray(p2.body.results)) searchStrategy = 'rest_v1_cql_text';
  else if (p3.ok && p3.body && Array.isArray(p3.body.result)) searchStrategy = 'rest_prototype';
  else if (p4.ok) searchStrategy = 'quicksearch';

  const contentStrategy = contentProbe && contentProbe.ok ? 'rest_v1_content' : 'html_dom';
  const spacesStrategy = p5.ok ? 'rest_v1_spaces' : null;

  return {
    meta,
    attempts,
    strategies: {
      searchStrategy,
      contentStrategy,
      spacesStrategy,
      sampleContentId,
      sampleTitle,
    },
  };
}

// ---------------------------------------------------------------- in-tab execution

/**
 * Searches Confluence inside the authenticated tab.
 * Handles space filtering, executes search, and normalizes output into a clean structure.
 */
export async function inTabSearchConfluence({ query, space, limit = 5, strategy = null }) {
  const origin = window.location.origin;
  let contextPath = '';
  try {
    if (window.AJS && typeof window.AJS.contextPath === 'function') contextPath = window.AJS.contextPath() || '';
    else contextPath = document.querySelector('meta[name="confluence-context-path"]')?.content || '';
  } catch { /* ignore */ }

  const q = String(query || '').trim();
  const lim = Math.max(1, Math.min(Number(limit) || 5, 20));

  // Build CQL: space filter if specified
  const spaceClause = space ? `space = "${space.replace(/["\\]/g, '')}" and ` : '';

  // Try Strategy 1: REST v1 with siteSearch
  const cql1 = `${spaceClause}(siteSearch ~ "${q.replace(/["\\]/g, '')}" or text ~ "${q.replace(/["\\]/g, '')}")`;
  const url1 = `${origin}${contextPath}/rest/api/content/search?cql=${encodeURIComponent(cql1)}&limit=${lim}`;

  try {
    const res1 = await fetch(url1, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
    if (res1.ok) {
      const data = await res1.json();
      if (Array.isArray(data.results)) {
        return {
          ok: true,
          strategy: 'rest_v1_cql_siteSearch',
          total: data.totalSize !== undefined ? data.totalSize : data.results.length,
          results: data.results.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            spaceKey: r.space?.key || '',
            spaceName: r.space?.name || '',
            url: r._links?.webui ? `${origin}${contextPath}${r._links.webui}` : '',
            excerpt: r.excerpt || (r.body?.view?.value ? r.body.view.value.slice(0, 200) : ''),
            lastModified: r.version?.when || '',
          })),
        };
      }
    }
  } catch { /* fallback to text CQL */ }

  // Strategy 2: REST v1 with simple text ~
  const cql2 = `${spaceClause}(text ~ "${q.replace(/["\\]/g, '')}")`;
  const url2 = `${origin}${contextPath}/rest/api/content/search?cql=${encodeURIComponent(cql2)}&limit=${lim}`;
  try {
    const res2 = await fetch(url2, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
    if (res2.ok) {
      const data = await res2.json();
      if (Array.isArray(data.results)) {
        return {
          ok: true,
          strategy: 'rest_v1_cql_text',
          total: data.totalSize !== undefined ? data.totalSize : data.results.length,
          results: data.results.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            spaceKey: r.space?.key || '',
            spaceName: r.space?.name || '',
            url: r._links?.webui ? `${origin}${contextPath}${r._links.webui}` : '',
            excerpt: r.excerpt || '',
            lastModified: r.version?.when || '',
          })),
        };
      }
    }
  } catch { /* fallback to prototype search */ }

  // Strategy 3: Prototype search
  const url3 = `${origin}${contextPath}/rest/prototype/1/search?query=${encodeURIComponent(q)}&max-results=${lim}`;
  try {
    const res3 = await fetch(url3, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
    if (res3.ok) {
      const data = await res3.json();
      const list = Array.isArray(data.result) ? data.result : [];
      return {
        ok: true,
        strategy: 'rest_prototype',
        total: list.length,
        results: list.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          spaceKey: r.space?.key || '',
          spaceName: r.space?.name || '',
          url: r.link ? (r.link.startsWith('http') ? r.link : `${origin}${r.link}`) : '',
          excerpt: r.excerpt || '',
          lastModified: r.lastModifiedDate || '',
        })),
      };
    }
  } catch { /* failure */ }

  return { ok: false, error: 'Confluence search endpoints did not return results. Verify query and tab state.' };
}

/**
 * Fetches page content inside the authenticated tab.
 * Strictly GET.
 */
export async function inTabReadConfluencePage({ id, title, spaceKey }) {
  const origin = window.location.origin;
  let contextPath = '';
  try {
    if (window.AJS && typeof window.AJS.contextPath === 'function') contextPath = window.AJS.contextPath() || '';
    else contextPath = document.querySelector('meta[name="confluence-context-path"]')?.content || '';
  } catch { /* ignore */ }

  let pageId = id ? String(id).trim() : null;

  // Resolve ID from title if only title was provided
  if (!pageId && title) {
    const spaceFilter = spaceKey ? `&spaceKey=${encodeURIComponent(spaceKey)}` : '';
    const lookupUrl = `${origin}${contextPath}/rest/api/content?title=${encodeURIComponent(title)}${spaceFilter}&limit=1`;
    try {
      const lookupRes = await fetch(lookupUrl, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
      if (lookupRes.ok) {
        const lookupData = await lookupRes.json();
        if (Array.isArray(lookupData.results) && lookupData.results[0]) {
          pageId = lookupData.results[0].id;
        }
      }
    } catch { /* fallback */ }
  }

  if (!pageId) {
    return { ok: false, error: `Could not resolve Confluence page ID for "${title || id}".` };
  }

  const url = `${origin}${contextPath}/rest/api/content/${pageId}?expand=body.view,body.storage,version,space`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
    if (!res.ok) {
      return { ok: false, error: `Confluence content endpoint returned HTTP ${res.status} ${res.statusText}` };
    }
    const data = await res.json();
    const htmlBody = data.body?.view?.value || data.body?.storage?.value || '';

    return {
      ok: true,
      id: data.id,
      title: data.title,
      spaceKey: data.space?.key || '',
      spaceName: data.space?.name || '',
      version: data.version?.number || 1,
      lastModified: data.version?.when || '',
      author: data.version?.by?.displayName || data.version?.by?.username || '',
      url: data._links?.webui ? `${origin}${contextPath}${data._links.webui}` : '',
      htmlBody,
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

/**
 * Lists spaces inside the authenticated tab.
 */
export async function inTabListSpaces({ limit = 20 } = {}) {
  const origin = window.location.origin;
  let contextPath = '';
  try {
    if (window.AJS && typeof window.AJS.contextPath === 'function') contextPath = window.AJS.contextPath() || '';
    else contextPath = document.querySelector('meta[name="confluence-context-path"]')?.content || '';
  } catch { /* ignore */ }

  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
  const url = `${origin}${contextPath}/rest/api/space?limit=${lim}`;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Spaces endpoint returned HTTP ${res.status}` };
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      ok: true,
      spaces: results.map((s) => ({
        key: s.key,
        name: s.name,
        type: s.type,
        url: s._links?.webui ? `${origin}${contextPath}${s._links.webui}` : '',
      })),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}

// ---------------------------------------------------------------- host-side client

/**
 * Manages CDP communication with the Confluence tab from Node.
 */
export class ConfluenceClient {
  constructor(cfg) {
    this.cfg = cfg || loadConfluenceConfig();
    this.cdp = null;
    this.target = null;
  }

  async attach() {
    if (this.cdp && this.cdp.live) return this.cdp;
    const { target, pages } = await findConfluenceTab({
      host: this.cfg.host,
      port: this.cfg.port,
      match: this.cfg.tabMatch,
    });
    if (!target) {
      const openUrls = pages.map((p) => p.url).join('\n  ') || '(none)';
      throw new ConfluenceError(
        `No tab matching "${this.cfg.tabMatch}" found on Chrome port ${this.cfg.port}.\n`
        + `Open your corporate Confluence site in Chrome and ensure you are logged in.\n`
        + `Open page tabs:\n  ${openUrls}`
      );
    }
    this.target = target;
    this.cdp = new CDP(target.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Runtime.enable');
    return this.cdp;
  }

  async search({ query, space, limit = 5 }) {
    const cdp = await this.attach();
    const res = await cdp.evalFn(inTabSearchConfluence, { query, space, limit }, { timeoutMs: this.cfg.timeoutMs });
    if (!res || !res.ok) throw new ConfluenceError(res?.error || 'Search returned no response');
    return res;
  }

  async readPage({ id, title, spaceKey }) {
    const cdp = await this.attach();
    const res = await cdp.evalFn(inTabReadConfluencePage, { id, title, spaceKey }, { timeoutMs: this.cfg.timeoutMs });
    if (!res || !res.ok) throw new ConfluenceError(res?.error || 'Failed to read page content');

    // Convert HTML to clean markdown on host
    let markdown = confluenceHtmlToText(res.htmlBody);
    const maxChars = this.cfg.maxChars || 25000;
    let truncated = false;
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars) + `\n\n[... Truncated at ${maxChars} characters ...]`;
      truncated = true;
    }

    return {
      ...res,
      markdown,
      truncated,
      chars: markdown.length,
    };
  }

  async listSpaces({ limit = 20 } = {}) {
    const cdp = await this.attach();
    const res = await cdp.evalFn(inTabListSpaces, { limit }, { timeoutMs: this.cfg.timeoutMs });
    if (!res || !res.ok) throw new ConfluenceError(res?.error || 'Failed to list spaces');
    return res.spaces;
  }

  close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
  }
}

// ---------------------------------------------------------------- tool definitions

/**
 * Returns the tool dictionary for the Confluence skill.
 * Conforms to the copilot-cli tool protocol ({ summary, usage, describe, run, mutates: false }).
 */
export function confluenceTools(client = new ConfluenceClient()) {
  return {
    confluence_search: {
      summary: 'Search corporate Confluence articles and knowledge base',
      usage: '<copilot:confluence_search query="keyword" [space="KEY"] [limit="5"]/>',
      body: false,
      mutates: false,
      describe: (args) => `search Confluence for "${args.query || ''}"${args.space ? ` in space ${args.space}` : ''}`,
      run: async (_ctx, args) => {
        if (!args.query) throw new ConfluenceError('missing query parameter');
        const data = await client.search({ query: args.query, space: args.space, limit: args.limit });
        if (!data.results.length) return `No Confluence pages matched "${args.query}".`;

        const lines = [`Found ${data.total} page(s) matching "${args.query}" (strategy: ${data.strategy}):`];
        for (const [idx, item] of data.results.entries()) {
          lines.push(`\n[${idx + 1}] ${item.title}`);
          lines.push(`    id: ${item.id} | space: ${item.spaceKey || 'none'}${item.lastModified ? ` | updated: ${item.lastModified.slice(0, 10)}` : ''}`);
          if (item.url) lines.push(`    url: ${item.url}`);
          if (item.excerpt) {
            const cleanExcerpt = confluenceHtmlToText(item.excerpt).replace(/\n+/g, ' ').slice(0, 160);
            lines.push(`    excerpt: ${cleanExcerpt}`);
          }
        }
        lines.push('\nTo view complete contents of a page, call: <copilot:confluence_read id="<id>"/>');
        return lines.join('\n');
      },
    },

    confluence_read: {
      summary: 'Read a Confluence page by ID or title (strictly read-only)',
      usage: '<copilot:confluence_read id="123456" [title="Page Title"]/>',
      body: false,
      mutates: false,
      describe: (args) => `read Confluence page ${args.id || args.title || '(unspecified)'}`,
      run: async (_ctx, args) => {
        if (!args.id && !args.title) throw new ConfluenceError('specify id="<pageId>" or title="<pageTitle>"');
        const page = await client.readPage({ id: args.id, title: args.title, spaceKey: args.spaceKey });

        const header = [
          `# ${page.title}`,
          `Space: ${page.spaceName} (${page.spaceKey}) | Page ID: ${page.id} | Version: ${page.version}`,
          page.lastModified ? `Last Modified: ${page.lastModified} by ${page.author}` : '',
          page.url ? `URL: ${page.url}` : '',
          '---',
        ].filter(Boolean).join('\n');

        return `${header}\n\n${page.markdown}`;
      },
    },

    confluence_spaces: {
      summary: 'List available Confluence spaces to filter searches',
      usage: '<copilot:confluence_spaces [limit="20"]/>',
      body: false,
      mutates: false,
      describe: () => 'list Confluence spaces',
      run: async (_ctx, args) => {
        const spaces = await client.listSpaces({ limit: args.limit });
        if (!spaces.length) return 'No Confluence spaces returned.';
        const lines = ['Available Confluence spaces:'];
        for (const s of spaces) {
          lines.push(`- [${s.key}] ${s.name} (${s.type || 'global'})${s.url ? ` — ${s.url}` : ''}`);
        }
        return lines.join('\n');
      },
    },
  };
}

// ---------------------------------------------------------------- diagnostic check

/**
 * Diagnostic runner invoked by `node chat.mjs --confluence-check`.
 * Performs an exhaustive, defensive probe of the Confluence tab, its APIs,
 * response headers, and search endpoints, and saves the complete report to
 * copilot-cli-confluence-check.txt.
 */
export async function runConfluenceCheck(args = []) {
  const cfg = loadConfluenceConfig();
  const outLines = [];
  const log = (msg = '') => { console.error(msg); outLines.push(msg); };

  log(`copilot-cli — confluence check`);
  log(`connecting to Chrome CDP on ${cfg.host}:${cfg.port}...`);

  let target, pages;
  try {
    const res = await findConfluenceTab({ host: cfg.host, port: cfg.port, match: cfg.tabMatch });
    target = res.target;
    pages = res.pages;
  } catch (err) {
    log(`\nFAILED: ${err.message}`);
    saveReport(outLines);
    return false;
  }

  log(`\nopen page tabs in Chrome (${pages.length}):`);
  for (const p of pages) {
    const isMatched = target && p.id === target.id;
    log(`  ${isMatched ? '-> [ACTIVE] ' : '   '}${p.title}  (${p.url})`);
  }

  if (!target) {
    log(`\nFAILED: No Confluence tab found matching "${cfg.tabMatch}".`);
    log(`Action: Open your corporate Confluence site in Chrome (port ${cfg.port}) and log in via SSO.`);
    saveReport(outLines);
    return false;
  }

  log(`\nattached to Confluence tab:`);
  log(`  title: ${target.title}`);
  log(`  url:   ${target.url}`);

  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.connect();
    await cdp.send('Runtime.enable');
  } catch (err) {
    log(`\nFAILED: Could not open DevTools session on Confluence tab: ${err.message}`);
    saveReport(outLines);
    return false;
  }

  log('\nprobing in-page metadata and API endpoints...');
  let probe;
  try {
    probe = await cdp.evalFn(inTabProbeConfluence);
  } catch (err) {
    log(`\nFAILED: Error evaluating in-tab probe: ${err.message}`);
    cdp.close();
    saveReport(outLines);
    return false;
  }

  const { meta, attempts, strategies } = probe;
  log(`\nConfluence In-Page Context:`);
  log(`  origin:       ${meta.origin}`);
  log(`  context path: ${meta.contextPath || '(root /)'}`);
  log(`  base url:     ${meta.baseUrl}`);
  log(`  version:      ${meta.versionNumber}`);
  log(`  remote user:  ${meta.remoteUser}`);
  log(`  server type:  ${meta.serverType}`);

  log(`\nEndpoint Probes (${attempts.length} tested):`);
  for (const a of attempts) {
    const statusLabel = a.ok ? `HTTP ${a.status}` : (a.status ? `FAILED HTTP ${a.status} ${a.statusText || ''}` : `ERROR: ${a.error}`);
    log(`  * ${a.label} (${a.ms}ms) -> ${statusLabel}`);
    log(`    URL: ${a.url}`);
    if (a.contentType) log(`    Content-Type: ${a.contentType}`);

    if (a.body) {
      if (Array.isArray(a.body.results)) {
        log(`    Results Count: ${a.body.results.length} (totalSize: ${a.body.totalSize ?? 'n/a'})`);
        if (a.body.results[0]) {
          const first = a.body.results[0];
          const desc = first.title ? `title="${first.title}"` : (first.name ? `name="${first.name}" (key=${first.key})` : `id=${first.id}`);
          log(`    Sample: id=${first.id} ${desc}`);
        }
      } else if (Array.isArray(a.body.result)) {
        log(`    Results Count: ${a.body.result.length}`);
        if (a.body.result[0]) log(`    Sample: id=${a.body.result[0].id} title="${a.body.result[0].title}"`);
      } else if (a.body.id) {
        log(`    Content Page: id=${a.body.id} title="${a.body.title}"`);
        const hasBodyView = Boolean(a.body.body?.view?.value);
        log(`    body.view present: ${hasBodyView} (${hasBodyView ? a.body.body.view.value.length : 0} chars)`);
      }
    } else if (a.textSample) {
      log(`    Raw Text Sample: ${a.textSample.slice(0, 120).replace(/\s+/g, ' ')}...`);
    }
  }

  log(`\nSelected Operational Strategy:`);
  log(`  Search strategy:   ${strategies.searchStrategy || 'NONE (all search endpoints failed)'}`);
  log(`  Content strategy:  ${strategies.contentStrategy}`);
  log(`  Spaces strategy:   ${strategies.spacesStrategy || 'none'}`);

  let success = Boolean(strategies.searchStrategy);
  if (success) {
    log(`\nVerdict: Confluence integration is WORKING and ready to use!`);
    log(`Try running:`);
    log(`  node chat.mjs --agent:confluence "find architecture overview documents"`);
  } else {
    log(`\nVerdict: Confluence tab was found, but search endpoints failed.`);
    log(`Inspect the raw report below to verify endpoint URLs and permissions.`);
  }

  cdp.close();
  saveReport(outLines);
  return success;
}

function saveReport(lines) {
  const file = 'copilot-cli-confluence-check.txt';
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n');
    console.error(`\n[confluence] Full diagnostic report written to ${file}`);
  } catch { /* ignore */ }
}

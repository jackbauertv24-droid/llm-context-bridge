// lib-skills.mjs — Domain-scoped skill bundles and registry for copilot-cli.
//
// Manages and isolates agent capabilities (coding/files, mail, logs, chat)
// into focused bundles. This prevents tool-schema bloat, avoids confusing
// the model with irrelevant operations, and enforces security boundaries
// (e.g. keeping untrusted mail/chat content separate from file-mutating tools).

import { tools as fileTools } from './lib-fstools.mjs';
import { mailTools, loadMailConfig } from './lib-mailtool.mjs';
import { confluenceTools, ConfluenceClient, loadConfluenceConfig } from './lib-confluence.mjs';

/**
 * Skill definition schema:
 * - id: unique identifier string (e.g. 'files', 'mail', 'logs')
 * - name: human-friendly label
 * - domain: category ('code' | 'agenda' | 'ops' | 'collab' | 'knowledge')
 * - summary: short one-line description
 * - mutates: whether any tool in this bundle modifies local files or server state
 * - sampleTag: example XML tag for system prompt formatting
 * - isAvailable(ctx): { available, detail?, reason?, blocking? }
 *     blocking defaults to true: the skill cannot work and naming it is an
 *     error. Set it false when unavailability is only an inference — the
 *     confluence check reads a config file, but what the tools really need
 *     is an open tab, which cannot be seen from here. Asking for a skill by
 *     name is a statement of intent, so a non-blocking doubt becomes a
 *     warning rather than a refusal.
 * - getTools(ctx): returns map of { [toolName]: toolDefinition }
 * - promptRules: array of specific guidance strings rendered under RULES
 */

export const filesSkill = {
  id: 'files',
  name: 'Local Files (Code)',
  domain: 'code',
  summary: 'Read, list, write, and edit files in the workspace root.',
  mutates: true,
  sampleTag: '<copilot:read path="src/index.js"/>',
  isAvailable: () => ({ available: true, detail: 'workspace root' }),
  getTools: () => fileTools,
  promptRules: [
    '- Paths are relative to the workspace root. Never use absolute paths or "..".',
    '- Use edit to change a file that already exists, and write only to create a',
    '  new one or to replace a file wholesale.',
    '- Read a file before you edit it, and quote the SEARCH lines exactly as they',
    '  appear, including indentation. SEARCH must match one place in the file; if',
    '  it could match more, include more surrounding lines.',
    '- write replaces the whole file. Emit the complete new contents, never a diff',
    '  and never a fragment with "... rest unchanged".',
    '- The body of a write tag is literal file content. Do not escape it.',
  ],
};

export const mailSkill = {
  id: 'mail',
  name: 'Corporate Mail (Read-Only)',
  domain: 'agenda',
  summary: 'Read recent messages and list mailboxes via Exchange Web Services or IMAP.',
  mutates: false,
  sampleTag: '<copilot:mail days="7"/>',
  isAvailable: (ctx = {}) => {
    const cfg = ctx.mailConfig || loadMailConfig({ root: ctx.root, envPath: ctx.mailEnv });
    if (cfg && cfg.configured) {
      const proto = (cfg.protocol || 'ews').toUpperCase();
      // EWS has no cfg.host — it is configured by URL — so reading host here
      // printed "user at undefined (EWS)" on the line that confirms setup.
      const where = cfg.protocol === 'ews' ? cfg.ewsUrl : cfg.host;
      return { available: true, detail: `${cfg.user} at ${where} (${proto})` };
    }
    return {
      available: false,
      reason: 'mail is not configured (copy mail.env.example to mail.env and fill in credentials)',
    };
  },
  getTools: (ctx = {}) => {
    const cfg = ctx.mailConfig || loadMailConfig({ root: ctx.root, envPath: ctx.mailEnv });
    // ctx.onMailRead lets the CLI record every read to disk without this
    // module doing file I/O of its own.
    return mailTools(cfg, { onRead: ctx.onMailRead || null });
  },
  promptRules: [],
};

// Planned / staged connectors for future extension:
export const logsSkill = {
  id: 'logs',
  name: 'Production Logs (Read-Only)',
  domain: 'ops',
  summary: 'Read-only tailing and grepping of server logs over SSH.',
  mutates: false,
  sampleTag: '<copilot:log host="prod-01" service="api" lines="100" filter="ERROR"/>',
  isAvailable: () => ({
    available: false,
    reason: 'connector in development; see documentation for planned operations',
  }),
  getTools: () => ({}),
  promptRules: [],
};

export const teamsSkill = {
  id: 'teams',
  name: 'Teams Messenger (Read-Only)',
  domain: 'collab',
  summary: 'Read-only channel message search and chat summaries.',
  mutates: false,
  sampleTag: '<copilot:teams_search query="deployment"/>',
  isAvailable: () => ({
    available: false,
    reason: 'connector in development; see documentation for planned operations',
  }),
  getTools: () => ({}),
  promptRules: [],
};

export const confluenceSkill = {
  id: 'confluence',
  name: 'Corporate Confluence (Read-Only)',
  domain: 'knowledge',
  summary: 'Search and read corporate Confluence articles and knowledge base via authenticated Chrome tab.',
  mutates: false,
  sampleTag: '<copilot:confluence_search query="architecture overview"/>',
  // Availability has to mean something. Returning true unconditionally put
  // three tools in front of the model on every --skills all run, configured
  // or not, which is exactly what this module exists to avoid: a tool that
  // always fails teaches the model to keep trying it. Configuration can be
  // checked here; whether the tab is actually open and signed in can only be
  // found out at call time, so that stays as a caveat rather than a claim.
  isAvailable: (ctx = {}) => {
    const cfg = loadConfluenceConfig({ root: ctx.root });
    if (!cfg.configured) {
      return {
        available: false,
        // Not blocking: the tools need an authenticated tab, not this file.
        // A missing confluence.env means "do not offer this automatically",
        // not "this cannot work".
        blocking: false,
        reason: 'no confluence.env, so it is not offered automatically; '
          + `asking for it by name still works if a tab matching "${cfg.tabMatch}" is open`,
      };
    }
    return {
      available: true,
      detail: `tab matching "${cfg.tabMatch}" — needs that tab open and signed in`,
    };
  },
  getTools: (ctx = {}) => {
    const client = ctx.confluenceClient || new ConfluenceClient(loadConfluenceConfig({ root: ctx.root }));
    if (ctx && !ctx.confluenceClient) ctx.confluenceClient = client;
    return confluenceTools(client);
  },
  promptRules: [],
};

/**
 * SkillRegistry manages skill lookup, availability verification,
 * and dynamic toolset assembly.
 */
export class SkillRegistry {
  constructor() {
    this.skills = new Map();
    this.aliases = new Map([
      ['code', 'files'],
      ['file', 'files'],
      ['fs', 'files'],
      ['email', 'mail'],
      ['wiki', 'confluence'],
      ['doc', 'confluence'],
      ['docs', 'confluence'],
    ]);
  }

  register(skill) {
    this.skills.set(skill.id, skill);
    return this;
  }

  get(id) {
    const canonical = this.aliases.get(id) || id;
    return this.skills.get(canonical);
  }

  getAll() {
    return Array.from(this.skills.values());
  }

  /**
   * Resolves requested skill identifier(s) into active skills and tools.
   *
   * @param {string|string[]} requested - e.g. 'default', 'mail', 'files,mail', 'all'
   * @param {object} ctx - { root, mailEnv, mailConfig }
   * @returns {{ activeSkills: object[], tools: object, summary: string }}
   */
  resolve(requested = 'default', ctx = {}) {
    let ids = [];

    if (!requested || requested === 'default') {
      ids = ['files'];
    } else if (requested === 'all') {
      ids = this.getAll()
        .filter((s) => s.isAvailable(ctx).available)
        .map((s) => s.id);
      if (!ids.length) ids = ['files'];
    } else if (Array.isArray(requested)) {
      ids = requested;
    } else if (typeof requested === 'string') {
      ids = requested.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const activeSkills = [];
    const tools = {};
    const warnings = [];

    for (const rawId of ids) {
      const canonical = this.aliases.get(rawId) || rawId;
      const skill = this.skills.get(canonical);
      if (!skill) {
        const known = Array.from(this.skills.keys()).join(', ');
        throw new Error(`Unknown skill "${rawId}". Registered skills: ${known}`);
      }

      const status = skill.isAvailable(ctx);
      if (!status.available) {
        // 'all' and 'default' already filtered on availability, so reaching
        // here means this skill was asked for by name.
        if (status.blocking === false) {
          warnings.push(`${skill.id}: ${status.reason || 'prerequisites unconfirmed'}`);
        } else {
          throw new Error(`Skill "${skill.id}" cannot be activated: ${status.reason || 'prerequisites not met'}`);
        }
      }

      activeSkills.push(skill);
      const skillTools = skill.getTools(ctx) || {};
      for (const [toolName, toolDef] of Object.entries(skillTools)) {
        tools[toolName] = toolDef;
      }
    }

    return {
      activeSkills,
      tools,
      warnings,
      summary: activeSkills.map((s) => s.id).join(', '),
    };
  }
}

/** Pre-populated default registry with standard skills */
export function createDefaultRegistry() {
  const reg = new SkillRegistry();
  reg.register(filesSkill);
  reg.register(mailSkill);
  reg.register(logsSkill);
  reg.register(teamsSkill);
  reg.register(confluenceSkill);
  return reg;
}

/**
 * Parses user input for `/agent` or `--agent` command strings.
 * Supports:
 *   /agent <task>                     => { skillName: 'default', task }
 *   /agent:mail <task>                => { skillName: 'mail', task }
 *   /agent:code <task>                => { skillName: 'files', task }
 *   /agent:all <task>                 => { skillName: 'all', task }
 *   /agent +mail <task>               => { skillName: 'files,mail', task }
 *   /agent --skill mail <task>        => { skillName: 'mail', task }
 *   /agent --skills=files,mail <task> => { skillName: 'files,mail', task }
 */
export function parseAgentCommand(input = '') {
  let text = String(input).trim();
  if (text.startsWith('/agent')) {
    text = text.slice('/agent'.length).trim();
  }

  let skillName = 'default';

  // Subcommand style: /agent:mail or /agent:code or :mail ...
  if (text.startsWith(':')) {
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx < 0) {
      skillName = text.slice(1);
      return { skillName, task: '' };
    }
    skillName = text.slice(1, spaceIdx).trim();
    text = text.slice(spaceIdx + 1).trim();
  }

  // Plus-modifier style: /agent +mail <task> (combine files + mail)
  if (text.startsWith('+')) {
    const spaceIdx = text.indexOf(' ');
    const addSkill = (spaceIdx < 0 ? text.slice(1) : text.slice(1, spaceIdx)).trim();
    skillName = `files,${addSkill}`;
    text = spaceIdx < 0 ? '' : text.slice(spaceIdx + 1).trim();
  }

  // Flag style: --skills=mail or --skill mail
  if (text.startsWith('--skills=') || text.startsWith('--skill=')) {
    const eqIdx = text.indexOf('=');
    const spaceIdx = text.indexOf(' ');
    skillName = (spaceIdx < 0 ? text.slice(eqIdx + 1) : text.slice(eqIdx + 1, spaceIdx)).trim();
    text = spaceIdx < 0 ? '' : text.slice(spaceIdx + 1).trim();
  } else if (text.startsWith('--skills ') || text.startsWith('--skill ')) {
    const parts = text.split(/\s+/);
    skillName = parts[1] || 'default';
    text = parts.slice(2).join(' ').trim();
  }

  return { skillName, task: text };
}

/** Formats a human-readable list of registered skills and status */
export function formatSkillsList(registry, ctx = {}) {
  const lines = ['Skills available for /agent:'];
  for (const s of registry.getAll()) {
    const st = s.isAvailable(ctx);
    const badge = st.available
      ? (s.id === 'files' ? '[available, default]' : `[available: ${st.detail || 'ready'}]`)
      : `[inactive: ${st.reason || 'not configured'}]`;
    lines.push(`  * ${s.id.padEnd(10)} ${badge}`);
    lines.push(`    ${s.name} — ${s.summary}`);
  }
  lines.push('');
  lines.push('Usage:');
  lines.push('  /agent <task>              coding agent (files only, default)');
  lines.push('  /agent:mail <task>         read-only mail agent');
  lines.push('  /agent +mail <task>        coding agent + mail reading combined');
  lines.push('  /agent:all <task>          all active configured skills');
  lines.push('  /agent --skills=a,b <task> specify exact skills');
  lines.push('  /new or /reset             reset agent session & prompt context');
  return lines.join('\n');
}

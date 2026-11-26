// Config lives on disk (0600) and is only ever read by the server. The browser
// gets a redacted view: it can learn that a token is set, never what it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_JIRA = Object.freeze({
  deployment: 'server',            // 'server' = Data Center/Server (PAT, Bearer) | 'cloud' = email + API token (Basic)
  baseUrl: '',
  email: '',
  token: '',
  projectKeys: [],
  boardId: '',                     // when set, the active sprint on this board drives the ticket list
  jql: '',                         // optional override; beats boardId
  epicLinkField: 'customfield_10014',
  storyPointsField: 'customfield_10016',
  sprintField: 'customfield_10020',
  keyPattern: '[A-Z][A-Z0-9]+-\\d+',
  pollSeconds: 60,
  timeoutMs: 15000,
});

export const DEFAULTS = Object.freeze({
  jira: DEFAULT_JIRA,
  identity: { prAuthors: ['you'] },  // PR author handles that count as "mine"
  display: { spireScale: 'sqrt', fog: true },
});

export function defaultConfigPath() {
  if (process.env.BATTLEMAP_CONFIG) return process.env.BATTLEMAP_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'battlemap', 'config.json');
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function merge(base, over) {
  const out = clone(base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], over[k]);
    else out[k] = clone(over[k]);
  }
  return out;
}

export function validateKeyPattern(p) {
  try { new RegExp(p); return true; } catch { return false; }
}

/** Validate + normalise a user-supplied jira patch. Never throws; returns {value, errors}. */
export function normaliseJiraPatch(current, patch = {}) {
  const errors = [];
  const j = { ...current };
  if ('deployment' in patch) {
    if (patch.deployment === 'server' || patch.deployment === 'cloud') j.deployment = patch.deployment;
    else errors.push('deployment must be "server" or "cloud"');
  }
  if ('baseUrl' in patch) {
    const u = String(patch.baseUrl || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) errors.push('Base URL must start with http:// or https://');
    else j.baseUrl = u;
  }
  if ('email' in patch) j.email = String(patch.email || '').trim();
  // Token is write-only: undefined/null/'' keeps the stored one. Use clearToken to remove it.
  if (patch.clearToken) j.token = '';
  else if (typeof patch.token === 'string' && patch.token.trim()) j.token = patch.token.trim();
  if ('projectKeys' in patch) {
    const arr = Array.isArray(patch.projectKeys) ? patch.projectKeys : String(patch.projectKeys || '').split(/[\s,]+/);
    j.projectKeys = arr.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    if (j.projectKeys.some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k))) errors.push('Project keys look like ENG or PLAT2');
  }
  if ('boardId' in patch) {
    const b = String(patch.boardId ?? '').trim();
    if (b && !/^\d+$/.test(b)) errors.push('Board id must be a number');
    else j.boardId = b;
  }
  for (const f of ['jql', 'epicLinkField', 'storyPointsField', 'sprintField']) if (f in patch) j[f] = String(patch[f] ?? '').trim();
  for (const f of ['epicLinkField', 'storyPointsField', 'sprintField']) if (j[f] && !/^(customfield_\d+|[a-z]+)$/i.test(j[f])) errors.push(`${f} should look like customfield_10014`);
  if ('keyPattern' in patch) {
    if (validateKeyPattern(patch.keyPattern) && String(patch.keyPattern).trim()) j.keyPattern = String(patch.keyPattern).trim();
    else errors.push('Ticket key pattern is not a valid regular expression');
  }
  if ('pollSeconds' in patch) {
    const n = Number(patch.pollSeconds);
    if (!Number.isFinite(n)) errors.push('Poll interval must be a number of seconds');
    else j.pollSeconds = Math.min(3600, Math.max(15, Math.round(n)));
  }
  return { value: j, errors };
}

export class ConfigStore {
  constructor({ file = defaultConfigPath(), env = process.env, persist = true } = {}) {
    this.file = file; this.env = env; this.persist = persist;
    this.fileCfg = clone(DEFAULTS);
    this.runtimeOverride = null;   // used by --mock-jira; never written to disk
    this.load();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.fileCfg = merge(DEFAULTS, raw);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`battlemap: could not read ${this.file}: ${e.message}`);
      this.fileCfg = clone(DEFAULTS);
    }
  }
  /** Effective config: defaults < file < env < runtime override. */
  get() {
    const cfg = clone(this.fileCfg);
    const e = this.env;
    if (e.BATTLEMAP_JIRA_URL) cfg.jira.baseUrl = e.BATTLEMAP_JIRA_URL.replace(/\/+$/, '');
    if (e.BATTLEMAP_JIRA_TOKEN) cfg.jira.token = e.BATTLEMAP_JIRA_TOKEN;
    if (e.BATTLEMAP_JIRA_EMAIL) cfg.jira.email = e.BATTLEMAP_JIRA_EMAIL;
    if (e.BATTLEMAP_JIRA_DEPLOYMENT) cfg.jira.deployment = e.BATTLEMAP_JIRA_DEPLOYMENT;
    return this.runtimeOverride ? merge(cfg, this.runtimeOverride) : cfg;
  }
  envLocked() {
    const e = this.env;
    return { baseUrl: !!e.BATTLEMAP_JIRA_URL, token: !!e.BATTLEMAP_JIRA_TOKEN, email: !!e.BATTLEMAP_JIRA_EMAIL, deployment: !!e.BATTLEMAP_JIRA_DEPLOYMENT };
  }
  /** Apply a patch coming from the settings UI. */
  updateJira(patch) {
    const base = this.runtimeOverride ? this.get().jira : this.fileCfg.jira;
    const { value, errors } = normaliseJiraPatch(base, patch);
    if (errors.length) return { ok: false, errors };
    if (this.runtimeOverride) this.runtimeOverride = merge(this.runtimeOverride, { jira: value });
    else this.fileCfg.jira = value;
    return { ok: true, persisted: this.save() };
  }
  update(section, patch) {
    if (!['identity', 'display'].includes(section)) return { ok: false, errors: ['unknown section'] };
    this.fileCfg[section] = { ...this.fileCfg[section], ...patch };
    return { ok: true, persisted: this.save() };
  }
  save() {
    if (!this.persist || this.runtimeOverride) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.fileCfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
    return true;
  }
}

/** What the browser is allowed to see. */
export function redact(cfg, store) {
  const out = clone(cfg);
  out.jira.tokenSet = !!out.jira.token;
  delete out.jira.token;
  out.envLocked = store ? store.envLocked() : {};
  out.configFile = store ? store.file : undefined;
  out.mock = !!(store && store.runtimeOverride);
  return out;
}

/**
 * Automation engine — pure functions (unit tested). The runner applies the actions.
 *
 * Automations: { id, type: 'keyword'|'welcome'|'out_of_hours'|'flow', is_active, priority, trigger, response, flow_start_node }
 * Flow nodes:  { node_key, type, config, next }
 *   message   config {text}                                    next {default}
 *   buttons   config {text, buttons:[{id,title}], header?, footer?}  next {<buttonId>: key, default}
 *   list      config {text, button, sections:[{title, rows:[{id,title,description}]}]} next {<rowId>: key, default}
 *   condition config {field, operator, value}                 next {true, false}
 *   assign    config {strategy:'round_robin'|'user', user_id}  next {default}
 *   tag       config {add:[], remove:[]}                        next {default}
 *   webhook   config {url}                                      next {default}
 *   handoff   config {to:'human'|'ai', message?}                (ends the flow)
 */

const MAX_STEPS = 25;

export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** trigger: { keywords: string[], match: 'exact'|'contains'|'starts_with'|'regex' } */
export function matchesKeyword(trigger, text) {
  const t = normalizeText(text);
  if (!t || !trigger?.keywords?.length) return false;
  const match = trigger.match || 'contains';
  return trigger.keywords.some((kw) => {
    if (match === 'regex') {
      if (String(kw).length > 200) return false;
      try {
        return new RegExp(kw, 'iu').test(String(text || '').slice(0, 1000));
      } catch {
        return false;
      }
    }
    const k = normalizeText(kw);
    if (!k) return false;
    if (match === 'exact') return t === k;
    if (match === 'starts_with') return t === k || t.startsWith(`${k} `);
    return ` ${t} `.includes(` ${k} `); // whole-word contains
  });
}

/** Pick the first active keyword/flow automation (lowest priority number wins) whose keywords match. */
export function findKeywordAutomation(automations, text) {
  return [...automations]
    .filter((a) => a.is_active && (a.type === 'keyword' || a.type === 'flow') && a.trigger?.keywords?.length)
    .sort((a, b) => a.priority - b.priority)
    .find((a) => matchesKeyword(a.trigger, text));
}

function readField(contact, field) {
  if (!field) return undefined;
  if (field === 'tags') return contact.tags || [];
  if (field.startsWith('custom.')) return contact.custom?.[field.slice(7)];
  return contact[field];
}

export function evaluateCondition(cfg, contact, input) {
  const raw = cfg.field === 'last_message' ? input?.text : readField(contact, cfg.field);
  const v = Array.isArray(raw) ? raw.map((x) => String(x).toLowerCase()) : raw === null || raw === undefined ? undefined : String(raw).toLowerCase();
  const target = String(cfg.value ?? '').toLowerCase();
  switch (cfg.operator) {
    case 'exists':
      return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '';
    case 'not_exists':
      return Array.isArray(v) ? v.length === 0 : v === undefined || v === '';
    case 'equals':
      return Array.isArray(v) ? v.includes(target) : v === target;
    case 'not_equals':
      return Array.isArray(v) ? !v.includes(target) : v !== target;
    case 'contains':
      return Array.isArray(v) ? v.some((x) => x.includes(target)) : (v || '').includes(target);
    case 'in':
      return target.split(',').map((x) => x.trim()).filter(Boolean).some((x) => (Array.isArray(v) ? v.includes(x) : v === x));
    case 'gt':
      return Number(raw) > Number(cfg.value);
    case 'lt':
      return Number(raw) < Number(cfg.value);
    default:
      return false;
  }
}

/** Resolve which node follows an interactive node given the customer's reply. */
export function nextAfterReply(node, input) {
  const next = node.next || {};
  const id = input?.interactiveId;
  if (id && next[id]) return { key: next[id], matched: true };
  const text = normalizeText(input?.text);
  const options = node.type === 'buttons' ? node.config.buttons || [] : (node.config.sections || []).flatMap((s) => s.rows || []);
  const byTitle = options.find((o) => normalizeText(o.title) === text || normalizeText(o.id) === text);
  if (byTitle && next[byTitle.id]) return { key: next[byTitle.id], matched: true };
  // Numbered replies: "1", "2" …
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= options.length && next[options[n - 1].id]) return { key: next[options[n - 1].id], matched: true };
  if (next.default) return { key: next.default, matched: false };
  return { key: null, matched: false };
}

/**
 * Run a flow from a node until it needs input or ends.
 * @param {Array} nodes
 * @param {string} startKey
 * @param {object} contact  full contact (conditions may use internal fields; text rendering is done by the runner with safe data)
 * @param {object} input    { text, interactiveId }
 * @returns {{ actions: Array, state: null | { node: string, waiting: true } }}
 */
export function runFlow(nodes, startKey, contact, input) {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const actions = [];
  let key = startKey;
  const tags = new Set(contact.tags || []);
  for (let step = 0; key && step < MAX_STEPS; step++) {
    const node = byKey.get(key);
    if (!node) {
      actions.push({ type: 'error', message: `Flow node "${key}" not found` });
      return { actions, state: null };
    }
    const cfg = node.config || {};
    const next = node.next || {};
    switch (node.type) {
      case 'message':
        actions.push({ type: 'send_text', text: cfg.text });
        key = next.default;
        break;
      case 'buttons':
        actions.push({ type: 'send_buttons', text: cfg.text, buttons: cfg.buttons || [], header: cfg.header, footer: cfg.footer });
        return { actions, state: { node: node.node_key, waiting: true } };
      case 'list':
        actions.push({ type: 'send_list', text: cfg.text, button: cfg.button, sections: cfg.sections || [] });
        return { actions, state: { node: node.node_key, waiting: true } };
      case 'condition':
        key = evaluateCondition(cfg, { ...contact, tags: [...tags] }, input) ? next.true : next.false;
        break;
      case 'assign':
        actions.push({ type: 'assign', strategy: cfg.strategy || 'round_robin', userId: cfg.user_id });
        key = next.default;
        break;
      case 'tag':
        for (const t of cfg.add || []) tags.add(String(t).toLowerCase());
        for (const t of cfg.remove || []) tags.delete(String(t).toLowerCase());
        actions.push({ type: 'tag', add: cfg.add || [], remove: cfg.remove || [] });
        key = next.default;
        break;
      case 'webhook':
        actions.push({ type: 'webhook', url: cfg.url });
        key = next.default;
        break;
      case 'handoff':
        if (cfg.message) actions.push({ type: 'send_text', text: cfg.message });
        actions.push({ type: 'handoff', to: cfg.to === 'ai' ? 'ai' : 'human' });
        return { actions, state: null };
      default:
        actions.push({ type: 'error', message: `Unknown node type ${node.type}` });
        return { actions, state: null };
    }
  }
  if (key) actions.push({ type: 'error', message: 'Flow stopped: too many steps (loop?)' });
  return { actions, state: null };
}

/** Continue a waiting flow with the customer's reply. */
export function continueFlow(nodes, state, contact, input) {
  const node = nodes.find((n) => n.node_key === state.node);
  if (!node) return { actions: [{ type: 'error', message: 'Flow node missing' }], state: null };
  const { key, matched } = nextAfterReply(node, input);
  if (!key) {
    // Unrecognised answer and no default path: ask again (once), then give up.
    if ((state.retries || 0) >= 1) return { actions: [], state: null, exit: true };
    const again = runFlow(nodes, node.node_key, contact, input);
    return { actions: [{ type: 'send_text', text: 'Please choose one of the options below 👇' }, ...again.actions], state: { ...again.state, retries: (state.retries || 0) + 1 } };
  }
  const res = runFlow(nodes, key, contact, input);
  return { ...res, matched };
}

/** Validate a flow definition before saving. Returns a list of problems. */
export function validateFlow(nodes, startKey) {
  const problems = [];
  const keys = new Set();
  for (const n of nodes) {
    if (keys.has(n.node_key)) problems.push(`Duplicate step id "${n.node_key}"`);
    keys.add(n.node_key);
  }
  if (!keys.has(startKey)) problems.push(`Start step "${startKey}" does not exist`);
  for (const n of nodes) {
    for (const [k, target] of Object.entries(n.next || {})) {
      if (target && !keys.has(target)) problems.push(`Step "${n.node_key}" → "${k}" points to missing step "${target}"`);
    }
    if (n.type === 'buttons') {
      const b = n.config?.buttons || [];
      if (!b.length || b.length > 3) problems.push(`Step "${n.node_key}": buttons need 1–3 options`);
      if (b.some((x) => !x.title || x.title.length > 20)) problems.push(`Step "${n.node_key}": button titles must be 1–20 characters`);
    }
    if ((n.type === 'message' || n.type === 'buttons' || n.type === 'list') && !n.config?.text?.trim()) problems.push(`Step "${n.node_key}" needs text`);
    if (n.type === 'condition' && !n.config?.field) problems.push(`Step "${n.node_key}": choose a field to check`);
    if (n.type === 'webhook' && !/^https?:\/\//.test(n.config?.url || '')) problems.push(`Step "${n.node_key}": webhook URL must start with http(s)://`);
  }
  return problems;
}

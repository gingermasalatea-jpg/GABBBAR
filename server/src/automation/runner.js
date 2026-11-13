import { one, many, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { customerSafeContact, renderContactPlaceholders } from '../lib/templateVars.js';
import { isWithinWorkingHours } from '../lib/workingHours.js';
import { getSection } from '../services/settings.js';
import { listCustomFields, cleanTags } from '../services/contacts.js';
import { queueOutbound } from '../services/messages.js';
import { updateConversation, pickAgentRoundRobin, takeover } from '../services/conversations.js';
import { assertSafeUrl } from '../services/webhooksOut.js';
import { publish } from '../services/realtime.js';
import { emit } from '../lib/hooks.js';
import { enqueue } from '../queue/index.js';
import { findKeywordAutomation, runFlow, continueFlow } from './engine.js';

const FLOW_TTL_MS = 24 * 3600 * 1000;
const OOH_COOLDOWN_MS = 12 * 3600 * 1000;

async function loadAutomations() {
  return many(`SELECT * FROM automations WHERE is_active ORDER BY priority, created_at`);
}

async function loadNodes(automationId) {
  return many('SELECT * FROM flow_nodes WHERE automation_id = $1 ORDER BY position', [automationId]);
}

/** Apply engine actions to the real world. Returns { handoffAi, handoffHuman }. */
async function applyActions(actions, { conv, contact, safe, message }) {
  const out = { handoffAi: false, handoffHuman: false };
  for (const a of actions) {
    try {
      if (a.type === 'send_text' && a.text) {
        await queueOutbound({ conversationId: conv.id, kind: 'text', text: renderContactPlaceholders(a.text, safe), senderType: 'automation' });
      } else if (a.type === 'send_buttons') {
        await queueOutbound({
          conversationId: conv.id,
          kind: 'interactive',
          senderType: 'automation',
          interactive: {
            type: 'button',
            body: { text: renderContactPlaceholders(a.text, safe).slice(0, 1024) },
            ...(a.header ? { header: { type: 'text', text: String(a.header).slice(0, 60) } } : {}),
            ...(a.footer ? { footer: { text: String(a.footer).slice(0, 60) } } : {}),
            action: { buttons: a.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) },
          },
        });
      } else if (a.type === 'send_list') {
        await queueOutbound({
          conversationId: conv.id,
          kind: 'interactive',
          senderType: 'automation',
          interactive: {
            type: 'list',
            body: { text: renderContactPlaceholders(a.text, safe).slice(0, 4096) },
            action: {
              button: String(a.button || 'Choose').slice(0, 20),
              sections: a.sections.map((s) => ({ ...(s.title ? { title: String(s.title).slice(0, 24) } : {}), rows: (s.rows || []).slice(0, 10).map((r) => ({ id: String(r.id).slice(0, 200), title: String(r.title).slice(0, 24), ...(r.description ? { description: String(r.description).slice(0, 72) } : {}) })) })),
            },
          },
        });
      } else if (a.type === 'tag') {
        const current = (await one('SELECT tags FROM contacts WHERE id = $1', [contact.id])).tags;
        const remove = new Set((a.remove || []).map((t) => String(t).toLowerCase()));
        const tags = cleanTags([...current.filter((t) => !remove.has(t)), ...(a.add || [])]);
        const updated = await one('UPDATE contacts SET tags = $2, updated_at = now() WHERE id = $1 RETURNING *', [contact.id, tags]);
        emit('contact.updated', { contact: updated });
        publish('contact.updated', { id: contact.id });
      } else if (a.type === 'assign') {
        const userId = a.strategy === 'user' && a.userId ? a.userId : await pickAgentRoundRobin();
        if (userId) await updateConversation(conv.id, { assigned_to: userId }, null);
      } else if (a.type === 'webhook') {
        await assertSafeUrl(a.url);
        const res = await fetch(a.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Gabbbar-Flow/1.0' },
          body: JSON.stringify({ event: 'flow.webhook', conversation_id: conv.id, contact: { id: contact.id, ...safe }, message: { id: message.id, text: message.body } }),
          signal: AbortSignal.timeout(8000),
        });
        logger.info('Flow webhook called', { url: a.url, status: res.status });
      } else if (a.type === 'handoff') {
        if (a.to === 'ai') out.handoffAi = true;
        else {
          out.handoffHuman = true;
          const userId = conv.assigned_to || (await pickAgentRoundRobin());
          if (userId) await takeover(conv.id, userId);
          else await query('UPDATE conversations SET human_takeover = true WHERE id = $1', [conv.id]);
        }
      } else if (a.type === 'error') {
        logger.warn('Flow error', { conversation: conv.id, message: a.message });
      }
    } catch (err) {
      logger.error('Automation action failed', { err, action: a.type });
    }
  }
  return out;
}

/**
 * Decide what happens to an inbound customer message:
 *   1. human takeover → nothing automatic
 *   2. a waiting flow → continue it
 *   3. keyword automation / flow trigger → run it (AI is not called)
 *   4. welcome (first message ever) and out-of-hours replies (do not block the AI)
 *   5. otherwise → the AI assistant (which applies its own mode rules)
 */
export async function handleInbound({ message, contact, conversation, isNewContact }) {
  const conv = await one('SELECT * FROM conversations WHERE id = $1', [conversation.id]);
  if (!conv || conv.human_takeover) return { route: 'human' };
  const defs = await listCustomFields();
  const safe = customerSafeContact(contact, defs);
  const input = { text: message.body || '', interactiveId: message.payload?.interactive?.id || null };
  const ctx = { conv, contact, safe, message };

  // 2. Waiting flow
  const st = conv.flow_state;
  if (st?.automation_id && st.waiting) {
    const fresh = st.updated_at && Date.now() - new Date(st.updated_at).getTime() < FLOW_TTL_MS;
    const automation = fresh ? await one('SELECT * FROM automations WHERE id = $1 AND is_active', [st.automation_id]) : null;
    if (automation) {
      const nodes = await loadNodes(automation.id);
      const res = continueFlow(nodes, st, contact, input);
      if (!res.exit) {
        await query('UPDATE conversations SET flow_state = $2, last_handler = $3 WHERE id = $1', [
          conv.id,
          res.state ? { automation_id: automation.id, ...res.state, updated_at: new Date().toISOString() } : null,
          'automation',
        ]);
        const h = await applyActions(res.actions, ctx);
        if (h.handoffAi) await enqueueAi(conv.id, message.id);
        return { route: 'flow', automation: automation.name };
      }
    }
    await query('UPDATE conversations SET flow_state = NULL WHERE id = $1', [conv.id]);
  }

  const automations = await loadAutomations();

  // 3. Keyword / flow trigger
  const hit = message.body ? findKeywordAutomation(automations, message.body) : null;
  if (hit) {
    if (hit.type === 'keyword') {
      await applyActions([{ type: 'send_text', text: hit.response?.text }], ctx);
      await query(`UPDATE conversations SET last_handler = 'automation' WHERE id = $1`, [conv.id]);
      return { route: 'keyword', automation: hit.name };
    }
    const nodes = await loadNodes(hit.id);
    const res = runFlow(nodes, hit.flow_start_node, contact, input);
    await query(`UPDATE conversations SET flow_state = $2, last_handler = 'automation' WHERE id = $1`, [
      conv.id,
      res.state ? { automation_id: hit.id, ...res.state, updated_at: new Date().toISOString() } : null,
    ]);
    const h = await applyActions(res.actions, ctx);
    if (h.handoffAi) await enqueueAi(conv.id, message.id);
    return { route: 'flow', automation: hit.name };
  }

  // 4. Welcome + out of hours
  let greeted = false;
  const welcome = automations.find((a) => a.type === 'welcome');
  if (welcome && isNewContact && welcome.response?.text) {
    await applyActions([{ type: 'send_text', text: welcome.response.text }], ctx);
    greeted = true;
  }
  const ai = await getSection('ai');
  const aiMode = conv.ai_mode_override || ai.mode;
  const hours = await getSection('working_hours');
  const oohAuto = automations.find((a) => a.type === 'out_of_hours');
  const cooledDown = !conv.last_auto_reply_at || Date.now() - new Date(conv.last_auto_reply_at).getTime() > OOH_COOLDOWN_MS;
  if (oohAuto && hours.out_of_hours?.enabled && aiMode !== 'auto' && cooledDown && !isWithinWorkingHours(hours)) {
    const text = oohAuto.response?.text || hours.out_of_hours.message;
    if (text) {
      await applyActions([{ type: 'send_text', text }], ctx);
      await query('UPDATE conversations SET last_auto_reply_at = now() WHERE id = $1', [conv.id]);
    }
  }

  // 5. AI
  await enqueueAi(conv.id, message.id);
  return { route: 'ai', greeted };
}

async function enqueueAi(conversationId, messageId) {
  await enqueue('ai', 'reply', { conversationId, messageId }, { jobId: `ai:${messageId}`, delayMs: 2500 });
}

/** Dry-run for the automation tester in the UI: which automation would handle this text? */
export async function dryRun(text, { isNewContact = false } = {}) {
  const automations = await loadAutomations();
  const hit = findKeywordAutomation(automations, text);
  if (hit) {
    if (hit.type === 'keyword') return { route: 'keyword', automation: hit.name, reply: hit.response?.text };
    const nodes = await loadNodes(hit.id);
    const res = runFlow(nodes, hit.flow_start_node, { tags: [], custom: {} }, { text });
    return { route: 'flow', automation: hit.name, actions: res.actions, waiting: Boolean(res.state) };
  }
  const hours = await getSection('working_hours');
  return {
    route: 'ai',
    welcome: isNewContact && automations.some((a) => a.type === 'welcome'),
    outOfHours: !isWithinWorkingHours(hours) && hours.out_of_hours?.enabled && automations.some((a) => a.type === 'out_of_hours'),
  };
}

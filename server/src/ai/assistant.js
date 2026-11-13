import { one, many } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { customerSafeContact } from '../lib/templateVars.js';
import { isWindowOpen } from '../lib/window.js';
import { getSection } from '../services/settings.js';
import { listCustomFields } from '../services/contacts.js';
import { queueOutbound } from '../services/messages.js';
import { publish } from '../services/realtime.js';
import { createTicket, recentFallbackTicket } from '../services/tickets.js';
import { rankKnowledge, tokenize } from './knowledge.js';
import { buildPrompt, parseModelOutput } from './prompt.js';
import { checkReply } from './guardrails.js';
import { resolveProvider } from './providers/index.js';

/**
 * Grounded AI assistant.
 * Mode precedence: human takeover (always pauses) > per-conversation override > global mode.
 * Every run is written to ai_logs with its input, the knowledge used, the output and the decision.
 */

export async function effectiveMode(conv) {
  const ai = await getSection('ai');
  if (conv.human_takeover) return { mode: 'off', reason: 'human_takeover', ai };
  return { mode: conv.ai_mode_override || ai.mode || 'off', reason: conv.ai_mode_override ? 'conversation_override' : 'global', ai };
}

async function logRun(entry) {
  try {
    return await one(
      `INSERT INTO ai_logs (conversation_id, message_id, reply_message_id, mode, provider, model, input, prompt, output, raw_output,
                            knowledge_ids, knowledge_titles, decision, guardrail_flags, latency_ms, tokens_in, tokens_out, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
      [
        entry.conversationId || null,
        entry.messageId || null,
        entry.replyMessageId || null,
        entry.mode,
        entry.provider || 'none',
        entry.model || null,
        entry.input || {},
        entry.prompt || null,
        entry.output || null,
        entry.rawOutput || null,
        entry.knowledgeIds || [],
        entry.knowledgeTitles || [],
        entry.decision,
        entry.flags || [],
        entry.latencyMs ?? null,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.error || null,
      ],
    );
  } catch (err) {
    logger.error('Failed to write ai_log', { err });
    return null;
  }
}

/**
 * Generate a grounded answer for a customer message. Does not send anything.
 * Returns { ok, reply, flags, knowledge, ... } plus the data needed for logging.
 */
export async function generateAnswer({ message, contact, history = [] }) {
  const [ai, business, defs, items] = await Promise.all([
    getSection('ai'),
    getSection('business'),
    listCustomFields(),
    many(`SELECT id, type, title, content FROM knowledge_items WHERE is_active ORDER BY updated_at DESC LIMIT 2000`),
  ]);
  const safe = customerSafeContact(contact, defs);
  const internalKeys = defs.filter((d) => d.internal).map((d) => d.key);
  const internalValues = internalKeys.map((k) => contact?.custom?.[k]).filter((v) => v !== null && v !== undefined && v !== '');

  // Business-info items are always included; FAQs/documents by relevance.
  const always = items.filter((i) => i.type === 'business_info').slice(0, 4);
  const searchable = items.filter((i) => i.type !== 'business_info');
  const contextText = [history.slice(-2).map((h) => h.text).join(' '), message].join(' ');
  const ranked = rankKnowledge(message, searchable, { limit: 4 });
  const rankedCtx = ranked.length ? ranked : rankKnowledge(contextText, searchable, { limit: 3 });
  const relevant = rankedCtx.filter((r) => r.score >= (ai.min_relevance ?? 0.12));
  const chosen = [...always.map((item) => ({ item, score: 1 })), ...relevant];
  const knowledge = chosen.map((c, i) => ({ ref: `K${i + 1}`, id: c.item.id, title: c.item.title, content: String(c.item.content).slice(0, 4000), score: c.score }));

  const { system, user, language } = buildPrompt({ business, ai, knowledge, customer: safe, history, message });
  const base = {
    input: { customer_message: message, language, history_count: history.length, knowledge_scores: knowledge.map((k) => ({ ref: k.ref, title: k.title, score: k.score })) },
    prompt: `${system}\n\n---\n${user}`,
  };

  let provider;
  try {
    provider = await resolveProvider(ai);
  } catch (err) {
    return { ok: false, decision: 'error', error: err.message, flags: ['provider_config'], ...base, provider: ai.provider, model: ai.model, knowledge: [] };
  }

  const started = Date.now();
  let gen;
  try {
    gen = await provider.provider.generate({
      system,
      user,
      model: provider.model,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      temperature: Number(ai.temperature ?? 0.3),
      maxTokens: 600,
      meta: {
        // The demo (mock) model only trusts matches on the customer's own words.
        ranked: ranked.filter((r) => r.score >= (ai.min_relevance ?? 0.12)).map((r) => ({ ...r, ref: knowledge.find((k) => k.id === r.item.id)?.ref })),
        neverSay: ai.never_say,
        minRelevance: ai.min_relevance,
        message,
        customer: safe,
        language,
      },
    });
  } catch (err) {
    return { ok: false, decision: 'error', error: err.message, flags: ['provider_error'], ...base, provider: provider.provider.name, model: provider.model, latencyMs: Date.now() - started, knowledge: [] };
  }
  const latencyMs = Date.now() - started;
  const parsed = parseModelOutput(gen.text);
  const used = knowledge.filter((k) => parsed.usedKnowledge.includes(k.ref));
  const result = {
    ...base,
    provider: provider.provider.name,
    model: provider.model,
    latencyMs,
    tokensIn: gen.tokensIn,
    tokensOut: gen.tokensOut,
    rawOutput: gen.text,
    knowledge: used.length ? used : [],
  };

  if (!parsed.answerable || !parsed.reply) {
    return { ...result, ok: false, decision: 'fallback', flags: [parsed.parsed ? 'not_answerable' : 'invalid_output'], reason: parsed.reason || 'Not covered by the knowledge base', reply: '' };
  }
  if (!relevant.length && !used.length) {
    // The model claims an answer but nothing in the knowledge base was relevant: treat as ungrounded.
    return { ...result, ok: false, decision: 'fallback', flags: ['no_knowledge_match'], reason: 'No matching knowledge', reply: parsed.reply };
  }
  const grounding = [knowledge.map((k) => `${k.title} ${k.content}`).join('\n'), JSON.stringify(business), JSON.stringify(safe)].join('\n');
  const check = checkReply(parsed.reply, { neverSay: ai.never_say, internalValues, groundingText: grounding });
  if (!check.ok) return { ...result, ok: false, decision: 'blocked', flags: check.flags, reason: `Guardrails blocked the reply (${check.flags.join(', ')})`, reply: parsed.reply };
  return { ...result, ok: true, decision: 'ok', flags: [], reply: parsed.reply };
}

async function historyFor(conversationId, before, max) {
  if (!max) return [];
  const rows = await many(
    `SELECT direction, body, type, template_name FROM messages WHERE conversation_id = $1 AND created_at < $2 AND (body IS NOT NULL OR template_name IS NOT NULL)
      ORDER BY created_at DESC LIMIT $3`,
    [conversationId, before, max],
  );
  return rows.reverse().map((r) => ({ role: r.direction === 'in' ? 'customer' : 'business', text: (r.body || `[template ${r.template_name}]`).slice(0, 600) }));
}

async function handleFallback({ conv, message, mode, ai, gen }) {
  const existing = await recentFallbackTicket(conv.id);
  let ticket = existing;
  if (!existing) {
    ticket = await createTicket({
      conversationId: conv.id,
      contactId: conv.contact_id,
      subject: `AI could not answer: ${String(message.body || '').slice(0, 80) || '[non-text message]'}`,
      description: `Customer asked: "${String(message.body || '').slice(0, 1000)}"\nReason: ${gen.reason || gen.error || gen.flags?.join(', ')}`,
      priority: 'normal',
      source: 'ai_fallback',
    });
  }
  // Tell the customer the team will follow up — once per ticket, only in auto mode.
  let replyMessageId = null;
  if (mode === 'auto' && !existing && ai.fallback_message && isWindowOpen(conv.last_inbound_at)) {
    const msg = await queueOutbound({ conversationId: conv.id, kind: 'text', text: ai.fallback_message, senderType: 'ai' });
    replyMessageId = msg.id;
  }
  return { ticket, replyMessageId };
}

/**
 * Run the assistant for an inbound message (queue job). `force` = agent-requested suggestion.
 * @returns {Promise<{decision:string, reply?:string, reason?:string, knowledge?:string[], logId?:string}>}
 */
export async function runForMessage({ conversationId, messageId, force = false }) {
  const conv = await one('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  if (!conv) return { decision: 'skipped', reason: 'conversation missing' };
  const { mode: rawMode, reason, ai } = await effectiveMode(conv);
  const mode = force ? 'suggest' : rawMode;

  const message = messageId
    ? await one('SELECT * FROM messages WHERE id = $1', [messageId])
    : await one(`SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
  if (!message) return { decision: 'skipped', reason: 'No customer message to answer' };

  if (!force) {
    if (mode === 'off') return { decision: 'skipped', reason };
    // Only answer the newest message (customers often send several in a row).
    const latest = await one(`SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
    if (latest && latest.id !== message.id) return { decision: 'skipped', reason: 'newer message pending' };
    // Team already handling this conversation.
    if (await recentFallbackTicket(conversationId, 6)) {
      await logRun({ conversationId, messageId: message.id, mode, provider: 'none', decision: 'skipped', flags: ['awaiting_team'], input: { customer_message: message.body } });
      return { decision: 'skipped', reason: 'awaiting team (open AI ticket)' };
    }
  }

  if (!message.body && !force) {
    const t = await handleFallback({ conv, message, mode, ai, gen: { reason: `Customer sent a ${message.type}` } });
    await logRun({ conversationId, messageId: message.id, mode, provider: 'none', decision: 'fallback', flags: ['non_text'], input: { type: message.type }, replyMessageId: t.replyMessageId });
    return { decision: 'fallback', reason: 'non-text message' };
  }

  // Customers often split one question over several messages: answer everything since our last reply.
  const burst = await many(
    `SELECT body, created_at FROM messages WHERE conversation_id = $1 AND direction = 'in' AND body IS NOT NULL
        AND created_at > COALESCE((SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'out'), '-infinity'::timestamptz)
        AND created_at <= $2
      ORDER BY created_at DESC LIMIT 5`,
    [conversationId, message.created_at],
  );
  const question = burst.length ? burst.reverse().map((b) => b.body).join('\n') : message.body || '';
  const burstStart = burst.length ? burst[0].created_at : message.created_at;

  // Pure greetings / emoji: nothing to answer (welcome automation covers greetings) — no ticket.
  if (!force && !tokenize(question).length) {
    await logRun({ conversationId, messageId: message.id, mode, provider: 'none', decision: 'skipped', flags: ['no_question'], input: { customer_message: question } });
    return { decision: 'skipped', reason: 'no question to answer' };
  }

  const contact = await one('SELECT * FROM contacts WHERE id = $1', [conv.contact_id]);
  const history = await historyFor(conversationId, burstStart, Number(ai.max_history ?? 8));
  const gen = await generateAnswer({ message: question, contact, history });
  const logBase = {
    conversationId,
    messageId: message.id,
    mode: force ? 'suggest(manual)' : mode,
    provider: gen.provider,
    model: gen.model,
    input: gen.input,
    prompt: gen.prompt,
    output: gen.reply || null,
    rawOutput: gen.rawOutput,
    knowledgeIds: gen.knowledge.map((k) => k.id),
    knowledgeTitles: gen.knowledge.map((k) => k.title),
    flags: gen.flags,
    latencyMs: gen.latencyMs,
    tokensIn: gen.tokensIn,
    tokensOut: gen.tokensOut,
    error: gen.error,
  };

  if (!gen.ok) {
    if (force) {
      const log = await logRun({ ...logBase, decision: gen.decision === 'error' ? 'error' : gen.decision === 'blocked' ? 'blocked' : 'fallback' });
      return { decision: gen.decision, reason: gen.reason || gen.error, logId: log?.id };
    }
    const fb = await handleFallback({ conv, message, mode, ai, gen });
    const log = await logRun({ ...logBase, decision: gen.decision === 'error' ? 'error' : gen.decision === 'blocked' ? 'blocked' : 'fallback', replyMessageId: fb.replyMessageId });
    return { decision: 'fallback', reason: gen.reason || gen.error, logId: log?.id };
  }

  // Auto mode steps back to "suggest" if a human agent replied in the last 30 minutes.
  let finalMode = mode;
  if (mode === 'auto' && !force) {
    const recentAgent = await one(
      `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender_type = 'agent' AND created_at > now() - interval '30 minutes' LIMIT 1`,
      [conversationId],
    );
    if (recentAgent) finalMode = 'suggest';
  }

  if (finalMode === 'auto') {
    // Re-check takeover right before sending — an agent may have taken over while the model was thinking.
    const fresh = await one('SELECT human_takeover, ai_mode_override FROM conversations WHERE id = $1', [conversationId]);
    if (fresh.human_takeover || fresh.ai_mode_override === 'off') {
      await logRun({ ...logBase, decision: 'held', flags: [...(gen.flags || []), 'takeover_during_generation'] });
      return { decision: 'held', reason: 'human took over' };
    }
    const msg = await queueOutbound({ conversationId, kind: 'text', text: gen.reply, senderType: 'ai' });
    const log = await logRun({ ...logBase, decision: 'sent', replyMessageId: msg.id });
    return { decision: 'sent', reply: gen.reply, knowledge: gen.knowledge.map((k) => k.title), logId: log?.id };
  }

  const log = await logRun({ ...logBase, decision: 'suggested' });
  const payload = { conversation_id: conversationId, assigned_to: conv.assigned_to, text: gen.reply, knowledge: gen.knowledge.map((k) => k.title), log_id: log?.id };
  publish('ai.suggestion', payload);
  return { decision: 'suggested', reply: gen.reply, knowledge: payload.knowledge, logId: log?.id };
}

/** Playground: answer a question without a conversation (nothing is sent). */
export async function testAnswer({ question, contactId }) {
  const contact = contactId ? await one('SELECT * FROM contacts WHERE id = $1', [contactId]) : { name: 'Test Customer', custom: {}, tags: [] };
  const gen = await generateAnswer({ message: question, contact, history: [] });
  await logRun({
    mode: 'test',
    provider: gen.provider,
    model: gen.model,
    input: gen.input,
    prompt: gen.prompt,
    output: gen.reply || null,
    rawOutput: gen.rawOutput,
    knowledgeIds: gen.knowledge.map((k) => k.id),
    knowledgeTitles: gen.knowledge.map((k) => k.title),
    decision: gen.ok ? 'skipped' : gen.decision === 'error' ? 'error' : gen.decision === 'blocked' ? 'blocked' : 'fallback',
    flags: gen.ok ? ['playground'] : gen.flags,
    latencyMs: gen.latencyMs,
    error: gen.error,
  });
  return { ok: gen.ok, reply: gen.reply, decision: gen.ok ? 'would_send' : gen.decision, reason: gen.reason || gen.error, flags: gen.flags, knowledge: gen.knowledge.map((k) => k.title), provider: gen.provider, model: gen.model, language: gen.input?.language };
}

import { config } from '../../config.js';
import { getSecret } from '../../services/settings.js';
import { tokenize } from '../knowledge.js';
import { violatesPolicy } from '../guardrails.js';

/**
 * Provider-agnostic text generation. Every provider receives the same
 * { system, user } pair and returns { text, tokensIn, tokensOut }.
 */

class ProviderError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function postJson(url, headers, body, timeoutMs = 45_000) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ProviderError(`AI provider unreachable: ${err.message}`, { retryable: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.status || data?.message || `HTTP ${res.status}`;
    throw new ProviderError(`AI provider error (${res.status}): ${msg}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  }
  return data;
}

const anthropic = {
  name: 'anthropic',
  async generate({ system, user, model, temperature, maxTokens, apiKey }) {
    const d = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] },
    );
    const text = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text, tokensIn: d.usage?.input_tokens, tokensOut: d.usage?.output_tokens };
  },
};

function openaiLike(name) {
  return {
    name,
    async generate({ system, user, model, temperature, maxTokens, apiKey, baseUrl }) {
      const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const body = { model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      if (name === 'openai') body.response_format = { type: 'json_object' };
      const d = await postJson(`${base}/chat/completions`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, body);
      return { text: d.choices?.[0]?.message?.content || '', tokensIn: d.usage?.prompt_tokens, tokensOut: d.usage?.completion_tokens };
    },
  };
}

const gemini = {
  name: 'gemini',
  async generate({ system, user, model, temperature, maxTokens, apiKey }) {
    const d = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      },
    );
    const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    return { text, tokensIn: d.usageMetadata?.promptTokenCount, tokensOut: d.usageMetadata?.candidatesTokenCount };
  },
};

/**
 * Mock provider for demo mode: extracts an answer from the best-matching knowledge item.
 * It follows the same JSON contract, so guardrails and logging behave exactly as with a real model.
 */
const mock = {
  name: 'mock',
  async generate({ meta }) {
    const top = meta?.ranked?.[0];
    const minScore = meta?.minRelevance ?? 0.12;
    // Demo model is conservative: at least half of the question's key terms must match one item.
    if (!top || top.score < Math.max(minScore, 0.2) || (top.coverage ?? 1) < 0.5) {
      return { text: JSON.stringify({ answerable: false, reply: '', used_knowledge: [], reason: 'No knowledge item matches the question' }), tokensIn: 0, tokensOut: 0 };
    }
    const qTerms = new Set(tokenize(meta.message));
    const sentences = String(top.item.content).split(/(?<=[.!?])\s+/).filter((x) => x && !violatesPolicy(x, meta.neverSay));
    if (!sentences.length) return { text: JSON.stringify({ answerable: false, reply: '', used_knowledge: [], reason: 'Knowledge text conflicts with reply rules' }), tokensIn: 0, tokensOut: 0 };
    const scored = sentences.map((s, i) => ({ s, i, n: tokenize(s).filter((t) => qTerms.has(t)).length }));
    const best = scored.sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 2).sort((a, b) => a.i - b.i).map((x) => x.s).join(' ');
    const name = meta.customer?.first_name;
    const lang = meta.language;
    const greet = lang === 'hinglish' ? `Ji${name ? ` ${name}` : ''}, ` : lang === 'hindi' ? `जी${name ? ` ${name}` : ''}, ` : name ? `Hi ${name}, ` : '';
    return { text: JSON.stringify({ answerable: true, reply: `${greet}${best}`, used_knowledge: [top.ref] }), tokensIn: 0, tokensOut: 0 };
  },
};

const PROVIDERS = { anthropic, openai: openaiLike('openai'), compatible: openaiLike('compatible'), gemini, mock };
const KEY_NAME = { anthropic: 'ai.anthropic_key', openai: 'ai.openai_key', gemini: 'ai.gemini_key', compatible: 'ai.compatible_key' };

/** Resolve the configured provider (mock when AI_MOCK=true). */
export async function resolveProvider(aiSettings) {
  const name = aiSettings.provider || 'anthropic';
  if (config.mock.ai) return { provider: mock, model: 'mock-retrieval', apiKey: '', mock: true };
  const apiKey = await getSecret(KEY_NAME[name]);
  if (!apiKey && name !== 'compatible') throw new ProviderError(`No API key configured for ${name} — add it in Settings → AI assistant`, { retryable: false });
  return { provider: PROVIDERS[name], model: aiSettings.model, apiKey, baseUrl: aiSettings.base_url, mock: false };
}

export { ProviderError };

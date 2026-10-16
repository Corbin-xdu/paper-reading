import { LlmCfg } from './llm';
import { grokComplete } from './grokEngine';
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
/** Streaming chat completions (SSE). Calls onDelta for each token chunk; returns full text. */
export async function chatStream(cfg: LlmCfg, messages: Msg[], onDelta: (t: string) => void, signal?: AbortSignal): Promise<string> {
  if (cfg.provider === 'grok') {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const user = messages.filter(m => m.role !== 'system').map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
    return grokComplete(cfg, system, user, onDelta, signal);
  }
  const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const reader = (r.body as any).getReader(); const dec = new TextDecoder(); let buf = ''; let full = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim(); if (d === '[DONE]') return full;
      try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) { full += t; onDelta(t); } } catch { /* partial */ }
    }
  }
  return full;
}

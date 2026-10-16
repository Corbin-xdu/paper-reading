import { grokComplete } from './grokEngine';

export interface LlmCfg {
  baseUrl: string; model: string; apiKey: string;
  provider?: 'grok' | 'openai'; grokPath?: string; grokHome?: string;
  reasoningEffort?: string; subagents?: boolean; webSearch?: boolean; modelNote?: string;
}
export async function chat(cfg: LlmCfg, system: string, user: string, signal?: AbortSignal): Promise<string> {
  if (cfg.provider === 'grok') return grokComplete(cfg, system, user, undefined, signal);
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    if (r.ok) { const j: any = await r.json(); return j.choices?.[0]?.message?.content ?? ''; }
    const t = await r.text();
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); continue; }
    throw new Error(`LLM 请求失败 ${r.status}: ${t.slice(0, 300)}`);
  }
  throw new Error('LLM 请求多次重试失败');
}

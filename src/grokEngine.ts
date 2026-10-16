import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LlmCfg } from './llm';

// 聊天走 grokComplete：临时目录、一轮、不给工具。
// 分析走 grokAgent：在论文目录或仓库里读文件，可以派子代理，不能改文件。
// 提示词走文件，是因为 Windows 命令行装不下长任务。
const DENY_TOOLS = [
  'Agent', 'run_terminal_command', 'read_file', 'grep', 'list_dir', 'search_replace', 'write',
  'web_search', 'web_fetch', 'open_page', 'open_page_with_find',
].join(',');
// 三个分析会话要自己读文件、派子代理，只禁止改文件和跑命令。
const AGENT_DENY = 'search_replace,write,run_terminal_command';

const STUB = '你是论文与代码分析助手。提示文件里的 SYSTEM 是必须遵守的分析规则，USER 是对话。只根据这些材料作答。不要调用工具，不要改文件，不要搜索。答案要具体到文件行号和张量形状；材料里没有的数字就写未给出。直接输出答案正文。';
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 留空表示 %USERPROFILE%\\.grok。填了 config.toml 就用它所在的目录。 */
export function resolveGrokHome(explicit?: string): string {
  let given = (explicit || '').trim().replace(/^"(.*)"$/, '$1');
  if (!given) return path.join(os.homedir(), '.grok');
  if (given === '~') given = path.join(os.homedir(), '.grok');
  else if (given.startsWith('~/') || given.startsWith('~\\')) given = path.join(os.homedir(), given.slice(2));
  given = given.replace(/%USERPROFILE%/gi, os.homedir()).replace(/%HOME%/gi, os.homedir());
  const resolved = path.resolve(given);
  return path.basename(resolved).toLowerCase() === 'config.toml' ? path.dirname(resolved) : resolved;
}

/** `config`、空串或当前 CLI 不认识的值都不传 --reasoning-effort，交给 config.toml。 */
export function normalizeReasoningEffort(value?: string): string | undefined {
  const effort = (value || '').trim().toLowerCase();
  if (!effort || effort === 'config') return undefined;
  return EFFORTS.has(effort) ? effort : undefined;
}

function agentStub(cfg: LlmCfg): string {
  const sub = cfg.subagents === false ? '不要派子代理。' : '可以派子代理分工阅读。';
  const web = cfg.webSearch ? '需要核对外可以联网检索公开信息。' : '不要联网搜索。';
  return `你在无界面模式里阅读本地文件。${sub}${web}禁止修改文件，禁止执行命令。把最终答案完整写在最后一条消息里。`;
}

function grokEnv(home?: string): NodeJS.ProcessEnv {
  return { ...process.env, GROK_HOME: resolveGrokHome(home), GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0' };
}

/** Grok 模式只接受 grok-*。旧默认值 gpt-4.1 之类直接丢掉，改读配置目录里的 config.toml。 */
export function pickGrokModel(configured?: string, grokHome?: string): { model: string; note?: string } {
  const c = (configured || '').trim();
  if (/^grok[-.]/i.test(c)) return { model: c };
  let fromFile = '';
  try {
    const text = fs.readFileSync(path.join(resolveGrokHome(grokHome), 'config.toml'), 'utf8');
    const sec = text.match(/\[models\][\s\S]*?(?:\n\[|$)/);
    const m = sec?.[0].match(/(?:^|\n)\s*default\s*=\s*"([^"]+)"/);
    if (m && /^grok[-.]/i.test(m[1].trim())) fromFile = m[1].trim();
  } catch { /* 没有本机配置就用下面的固定名 */ }
  const model = fromFile || 'grok-4.7-build-fast';
  return { model, note: c ? `设置里的模型「${c}」不是 Grok 模型，已改用 ${model}` : undefined };
}

export function resolveGrokBin(explicit?: string, grokHome?: string): string {
  const given = explicit?.trim();
  if (given) return given;
  const exe = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const homes = [resolveGrokHome(grokHome)];
  const fallback = path.join(os.homedir(), '.grok');
  if (homes[0] !== fallback) homes.push(fallback);
  for (const dir of homes) {
    const bin = path.join(dir, 'bin', exe);
    if (fs.existsSync(bin)) return bin;
  }
  return exe;
}

export function extractGrokText(stdout: string): string {
  const a = stdout.indexOf('{');
  const b = stdout.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Grok 返回无法解析: ' + stdout.slice(0, 400));
  const j = JSON.parse(stdout.slice(a, b + 1));
  if (j?.type === 'error') throw new Error(String(j.message || 'Grok 错误'));
  return String(j.text ?? '');
}

function workDir(): string {
  const dir = path.join(os.tmpdir(), 'paper-code-analyzer-grok');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

function promptFile(body: string): string {
  const file = path.join(workDir(), `prompt-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** 把 streaming-json 里的工具调用收成一行，给输出面板看进度。 */
export function summarizeGrokEvent(ev: any): string | undefined {
  if (!ev || ev.type === 'text' || ev.type === 'end' || ev.type === 'usage') return undefined;
  if (ev.type === 'error') return String(ev.message || ev.data || 'error').slice(0, 200);
  if (ev.type !== 'tool_call' && ev.type !== 'tool_call_update') return undefined;
  const d = ev.data && typeof ev.data === 'object' ? ev.data : ev;
  const name = d.name || d.toolName || d.tool || d.title || ev.type;
  const input = d.input || d.arguments || d.rawInput || {};
  const hint = typeof input === 'string' ? input : (input.path || input.file_path || input.file || input.pattern || input.query || input.description || input.prompt || '');
  return `${name} ${String(hint).replace(/\s+/g, ' ').slice(0, 140)}`.trim();
}

interface Launch {
  args: string[]; cwd: string; file: string; signal?: AbortSignal; retried?: boolean; grokHome?: string;
  stream: boolean; onText?: (t: string) => void; onEvent?: (ev: any) => void;
}

function launch(bin: string, o: Launch): Promise<string> {
  return launchOnce(bin, o).catch(err => {
    const msg = String((err as Error)?.message || err);
    if (o.retried || !/unknown model id|isn't in the model catalog/i.test(msg)) throw err;
    o.onEvent?.({ type: 'error', message: '指定模型不在本次模型列表里，改为让 Grok 自己选默认模型并重试' });
    return launchOnce(bin, { ...o, args: stripModelArgs(o.args), retried: true });
  }).finally(() => fs.rmSync(o.file, { force: true }));
}

function launchOnce(bin: string, o: Launch): Promise<string> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) { reject(Object.assign(new Error('已取消'), { name: 'AbortError' })); return; }
    const child = spawn(bin, o.args, {
      cwd: o.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: grokEnv(o.grokHome),
    });
    let stdout = ''; let stderr = ''; let full = ''; let lineBuf = ''; let settled = false;
    const cleanup = () => { o.signal?.removeEventListener('abort', onAbort); };
    const fail = (e: Error) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const ok = (t: string) => { if (settled) return; settled = true; cleanup(); resolve(t); };
    const onAbort = () => { killTree(child); fail(Object.assign(new Error('已取消'), { name: 'AbortError' })); };
    o.signal?.addEventListener('abort', onAbort);
    child.on('error', e => fail((e as NodeJS.ErrnoException).code === 'ENOENT'
      ? new Error('找不到本机 Grok。请先安装并 grok login，或在设置 paperCode.grokPath 填写 grok.exe 路径。') : e));
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      if (!o.stream) { stdout += s; return; }
      lineBuf += s;
      let i: number;
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, i).trim(); lineBuf = lineBuf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          o.onEvent?.(ev);
          if (ev.type === 'text' && ev.data) { full += ev.data; o.onText?.(String(ev.data)); }
          else if (ev.type === 'error' && ev.message) stderr += String(ev.message) + '\n';
        } catch { /* 半行或非 JSON */ }
      }
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
    child.on('close', code => {
      if (settled) return;
      try {
        if (o.stream) {
          const tail = lineBuf.trim();
          if (tail.startsWith('{')) {
            try {
              const ev = JSON.parse(tail);
              o.onEvent?.(ev);
              if (ev.type === 'text' && ev.data) { full += ev.data; o.onText?.(String(ev.data)); }
            } catch { /* 忽略残行 */ }
          }
          if (code && !full) throw new Error(`Grok 退出 ${code}: ${(stderr || stdout).slice(-500)}`);
          ok(full); return;
        }
        if (code) throw new Error(`Grok 退出 ${code}: ${(stderr || stdout).slice(-500)}`);
        ok(extractGrokText(stdout));
      } catch (e) { fail(e as Error); }
    });
  });
}

/** 从 `grok models` 的文本里取出可选 id。星号或 “(default)” 的那条是默认模型。 */
export function parseGrokModels(text: string): { ids: string[]; defaultId?: string } {
  const ids: string[] = [];
  let defaultId = text.match(/Default model:\s*(\S+)/)?.[1];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[*+-]\s+(\S+)/);
    if (!m) continue;
    ids.push(m[1]);
    if (line.includes('(default)') || /^\s*\*/.test(line)) defaultId = m[1];
  }
  return { ids, defaultId };
}

export function chooseGrokModel(configured: string | undefined, listed: { ids: string[]; defaultId?: string }): { model?: string; note?: string } {
  const c = (configured || '').trim();
  if (c && listed.ids.includes(c)) return { model: c };
  const fallback = listed.defaultId && (!listed.ids.length || listed.ids.includes(listed.defaultId)) ? listed.defaultId : listed.ids[0];
  if (!fallback) return { note: '没有从 grok models 读到可用模型，这次不指定模型，让本机 Grok 自己选' };
  if (fallback === c) return { model: fallback };
  return { model: fallback, note: c ? `本机模型列表里没有「${c}」，已改用 ${fallback}` : undefined };
}

function modelArgs(cfg: LlmCfg): string[] {
  const args: string[] = [];
  if (cfg.model && /^grok[-.]/i.test(cfg.model)) args.push('-m', cfg.model);
  const effort = normalizeReasoningEffort(cfg.reasoningEffort);
  if (effort && args.length) args.push('--reasoning-effort', effort);
  return args;
}

function stripModelArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' || args[i] === '--reasoning-effort') { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

/** 先问一次本机 Grok 现在真正有哪些模型，避免两个会话同时用一个列表里没有的 id。 */
export function grokModels(cfg: LlmCfg): Promise<string> {
  const cwd = workDir();
  return new Promise((resolve, reject) => {
    const child = spawn(resolveGrokBin(cfg.grokPath, cfg.grokHome), ['models'], {
      cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: grokEnv(cfg.grokHome),
    });
    let out = ''; let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', e => reject(e));
    child.on('close', code => code === 0 ? resolve(out + '\n' + err) : reject(new Error((err || out).slice(-400))));
  });
}

/** 聊天：一轮、不给工具。 */
export function grokComplete(cfg: LlmCfg, system: string, user: string, onDelta?: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const dir = workDir();
  const file = promptFile(`SYSTEM:\n${system}\n\nUSER:\n${user}\n`);
  const args = [
    '--prompt-file', file, ...modelArgs(cfg),
    '--output-format', onDelta ? 'streaming-json' : 'json',
    '--max-turns', '1', '--no-subagents', '--no-plan', '--disable-web-search', '--verbatim',
    '--cwd', dir, '--disallowed-tools', DENY_TOOLS, '--system-prompt-override', STUB,
  ];
  return launch(resolveGrokBin(cfg.grokPath, cfg.grokHome), { args, cwd: dir, file, signal, grokHome: cfg.grokHome, stream: !!onDelta, onText: onDelta });
}

/** 分析会话：可读文件、可派子代理，不可改仓库。streaming-json 用来报进度。 */
export function grokAgent(cfg: LlmCfg, cwd: string, task: string, maxTurns: number, signal?: AbortSignal, onEvent?: (ev: any) => void): Promise<string> {
  const file = promptFile(task);
  const args = [
    '--prompt-file', file, ...modelArgs(cfg),
    '--output-format', 'streaming-json',
    '--max-turns', String(Math.max(4, maxTurns)),
    '--no-plan', '--verbatim', '--always-approve',
  ];
  if (cfg.webSearch !== true) args.push('--disable-web-search');
  if (cfg.subagents === false) args.push('--no-subagents');
  args.push('--cwd', cwd, '--disallowed-tools', AGENT_DENY, '--system-prompt-override', agentStub(cfg));
  return launch(resolveGrokBin(cfg.grokPath, cfg.grokHome), { args, cwd, file, signal, grokHome: cfg.grokHome, stream: true, onEvent });
}

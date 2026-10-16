import * as vscode from 'vscode';
import { Entry } from './store';
import { chatStream, Msg } from './llmStream';
import { retrieveChunks } from './retrieve';
import { LlmCfg } from './llm';

const VENDOR = ['marked.min.js', 'mermaid.min.js', 'katex.min.js', 'auto-render.min.js'];
export function html(wv: vscode.Webview, ext: vscode.Uri, body: string, scripts: string[], extraVendor: string[] = []) {
  const u = (p: string) => wv.asWebviewUri(vscode.Uri.joinPath(ext, 'media', p)).toString();
  const csp = `default-src 'none'; img-src ${wv.cspSource} data: https:; font-src ${wv.cspSource}; style-src ${wv.cspSource} 'unsafe-inline'; script-src ${wv.cspSource};`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${u('vendor/katex.min.css')}"><link rel="stylesheet" href="${u('style.css')}"></head><body>${body}
${[...VENDOR, ...extraVendor].map(s => `<script src="${u('vendor/' + s)}"></script>`).join('')}<script src="${u('common.js')}"></script>${scripts.map(s => `<script src="${u(s)}"></script>`).join('')}</body></html>`;
}
const jsonTag = (o: unknown) => `<script type="application/json" id="data">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

function chatSystem(e: Entry, lang: string, chunks: string[]): string {
  const zh = lang !== 'en';
  const flow = (e.graph?.shapeFlow || []).slice(0, 40).map(s =>
    `${s.step}. ${s.name} | ${s.file || '-'}:${s.line ?? ''} | ${s.op} | ${s.input} -> ${s.output}${s.note ? ' | ' + s.note : ''}`).join('\n');
  const mods = (e.modules || []).slice(0, 40).map(m => `${m.name} ${m.file}#L${m.line}`).join('\n');
  const rules = zh
    ? `你是论文《${e.title}》和它的代码仓库的对照分析员，领域是 AI / 具身智能。只根据下面的材料回答。

回答规则：
1. 先用两三句给结论，再写依据。不要把整篇报告复述一遍。
2. 问到数据流、前向或维度时，用表格：步骤 | 代码位置 | 操作 | 输入形状 | 输出形状。形状写成 $B \\times T \\times d$。未知维度用符号，并说明它来自哪个超参或哪条公式。
3. 公式只用 $行内$ 或独立成行的 $$公式$$。
4. 引用代码必须写成 [文件#L行号](相对路径.py#L行号)。行号只能来自材料，不能编。
5. 分开写「论文怎么说」「代码怎么做」「二者差异」。论文或代码没写的分辨率、通道数、层数、hidden size、损失权重，写「材料未给出」，不要补一个看起来合理的数。
6. 需要结构图时用 mermaid 的 flowchart TD，节点文字加双引号。
7. 用简体中文，类名和张量名保留英文。`
    : `You analyze the paper "${e.title}" against its code. Use only the materials below. Lead with the conclusion. For tensor flow, use a table: step | location | op | input | output, with math in $...$. Cite code as [file#Lline](rel.py#Lline) and never invent line numbers or hyperparameters missing from the materials. Separate what the paper says, what the code does, and where they differ.`;
  return `${rules}

=== 模块索引 ===
${mods || '（无）'}
=== 张量形状流 ===
${flow || '（这次没有形状流）'}
=== 论文解析 ===
${e.report.paper.slice(0, 10000)}
=== 代码解析 ===
${e.report.code.slice(0, 10000)}
=== 对照 ===
${e.report.mapping.slice(0, 6000)}
=== 静态大纲 ===
${e.report.staticOutline.slice(0, 5000)}
=== 检索到的源码（带行号）===
${chunks.join('\n\n') || '（没有检索到源码。依据上面的解析回答，并标明哪些结论缺少源码行号。）'}`;
}

export class ReportPanels {
  private panels = new Map<string, vscode.WebviewPanel>();
  constructor(private ext: vscode.Uri, private openSource: (e: Entry, f: string, l: number) => void, private onFocus: (e: Entry) => void) {}
  show(e: Entry, tab = 'mapping', h?: number) {
    let p = this.panels.get(e.id);
    if (p) { p.reveal(); p.webview.postMessage({ type: 'show', tab, h }); this.onFocus(e); return; }
    p = vscode.window.createWebviewPanel('paperCode.report', '解析: ' + e.title.slice(0, 40), vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.ext, 'media')] });
    this.panels.set(e.id, p);
    p.onDidDispose(() => this.panels.delete(e.id));
    p.onDidChangeViewState(v => v.webviewPanel.active && this.onFocus(e));
    p.webview.onDidReceiveMessage(m => m.type === 'open' && this.openSource(e, m.file, m.line));
    const tabs = [['paper', '论文解析'], ['code', '代码解析'], ['mapping', '论文↔代码对照'], ['side', '并排视图'], ['graph', '模型架构图'], ['shape', '张量形状流'], ['outline', '静态大纲']];
    const body = `<nav>${tabs.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('')}</nav><div id="c"></div>` + jsonTag({ report: e.report, graph: e.graph, initialTab: tab, initialH: h });
    p.webview.html = html(p.webview, this.ext, body, ['report.js'], ['cytoscape.min.js', 'dagre.min.js', 'cytoscape-dagre.js']);
    this.onFocus(e);
  }
}

export class ChatView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView; private entry?: Entry; private history: Msg[] = []; private ac?: AbortController;
  constructor(private ext: vscode.Uri, private cfg: () => Promise<LlmCfg | undefined>, private lang: () => string, private openSource: (e: Entry, f: string, l: number) => void) {}
  setEntry(e: Entry) { if (this.entry?.id === e.id) return; this.entry = e; this.history = []; this.view?.webview.postMessage({ type: 'paper', title: e.title }); }
  resolveWebviewView(v: vscode.WebviewView) {
    this.view = v;
    v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ext, 'media')] };
    const css = `<style>#log{display:flex;flex-direction:column;gap:8px;padding-bottom:168px}.msg{padding:6px 8px;border-radius:6px;overflow-x:auto}.user{background:var(--vscode-input-background);align-self:flex-end;max-width:90%;white-space:pre-wrap}.assistant{border:1px solid var(--vscode-panel-border)}
#bar{position:fixed;bottom:0;left:0;right:0;padding:6px;background:var(--vscode-sideBar-background)}#presets{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}#presets button{font-size:12px;padding:2px 8px}#in{width:100%;box-sizing:border-box;height:60px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#8885);resize:vertical;font-family:inherit}body{padding:0 6px}#title{font-size:.85em;opacity:.8;padding:4px 0}</style>`;
    v.webview.html = html(v.webview, this.ext, css + `<div id="title"></div><div id="log"></div><div id="bar"><div id="presets"></div><textarea id="in" placeholder="就当前论文和代码提问，或点上面的预设。Enter 发送，Shift+Enter 换行"></textarea><div class="toolbar"><button id="send" class="primary">发送</button><button id="stop">停止</button><button id="clear">清空</button></div></div>`, ['chat.js']);
    v.webview.onDidReceiveMessage(m => this.onMsg(m));
  }
  private async onMsg(m: any) {
    const w = this.view!.webview;
    if (m.type === 'ready') { w.postMessage({ type: 'paper', title: this.entry?.title }); return; }
    if (m.type === 'stop') { this.ac?.abort(); return; }
    if (m.type === 'clear') { this.history = []; return; }
    if (m.type === 'open' && this.entry) { this.openSource(this.entry, m.file, m.line); return; }
    if (m.type !== 'ask') return;
    const e = this.entry; if (!e) { w.postMessage({ type: 'error', text: '请先在侧边栏打开一篇已解析的论文报告' }); return; }
    const cfg = await this.cfg(); if (!cfg) { w.postMessage({ type: 'error', text: '当前是 OpenAI 兼容模式，但还没有 API Key' }); return; }
    const chunks = e.repoRoot ? retrieveChunks(e.repoRoot, e.pyFiles, m.text + ' ' + this.history.slice(-2).map(h => h.content).join(' '), 4) : [];
    const sys = chatSystem(e, this.lang(), chunks);
    this.history.push({ role: 'user', content: m.text });
    this.ac = new AbortController();
    try {
      const full = await chatStream(cfg, [{ role: 'system', content: sys }, ...this.history.slice(-12)], t => w.postMessage({ type: 'delta', text: t }), this.ac.signal);
      this.history.push({ role: 'assistant', content: full }); w.postMessage({ type: 'done', text: full });
    } catch (err: any) { this.history.pop(); w.postMessage({ type: err?.name === 'AbortError' ? 'done' : 'error', text: String(err?.message || err) }); }
  }
}

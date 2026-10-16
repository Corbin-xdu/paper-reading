import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { downloadPaper } from './paper';
import { findRepo, cloneRepo, normalizeRepoUrl } from './repo';
import { analyzeRepo, RepoAnalysis } from './staticAnalysis';
import { runAnalysis } from './pipeline';
import { runGrokTrio } from './trio';
import { buildLlmGraph, buildStaticGraph } from './graph';
import { Store, Entry } from './store';
import { PaperTree } from './tree';
import { ReportPanels, ChatView } from './webviews';
import { LlmCfg } from './llm';
import { pickGrokModel, resolveGrokHome } from './grokEngine';

const KEY = 'paperCode.apiKey';
let ctxRef: vscode.ExtensionContext;

function conf() { return vscode.workspace.getConfiguration('paperCode'); }
function baseDir(): string | undefined { const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; return ws ? path.join(ws, conf().get<string>('outputDir', 'paper-analysis')) : undefined; }
async function llmCfg(ask = false, kind: 'analysis' | 'chat' = 'analysis'): Promise<LlmCfg | undefined> {
  const provider = conf().get<'grok' | 'openai'>('provider', 'grok');
  const configured = conf().get('model', 'grok-4.7-build-fast');
  if (provider === 'grok') {
    const grokHome = resolveGrokHome(conf().get('grokHome', ''));
    const picked = pickGrokModel(configured, grokHome);
    const reasoningEffort = conf().get(kind === 'chat' ? 'chatReasoningEffort' : 'reasoningEffort', 'low');
    return {
      provider: 'grok', baseUrl: '', model: picked.model, modelNote: picked.note, apiKey: '',
      grokPath: conf().get('grokPath', ''), grokHome, reasoningEffort,
      subagents: conf().get('subagents', true), webSearch: conf().get('webSearch', false),
    };
  }
  const model = configured;
  let apiKey = await ctxRef.secrets.get(KEY);
  if (!apiKey && ask) { await vscode.commands.executeCommand('paperCode.setApiKey'); apiKey = await ctxRef.secrets.get(KEY); }
  return apiKey ? { provider: 'openai', baseUrl: conf().get('baseUrl', 'https://api.openai.com/v1'), model, apiKey } : undefined;
}

async function openSource(e: Entry, file: string, line: number) {
  const cands = [path.isAbsolute(file) ? file : '', e.repoRoot ? path.join(e.repoRoot, file.replace(/^\.?\//, '')) : '', path.join(path.dirname(e.mdPath), file)].filter(Boolean);
  let f = cands.find(c => fs.existsSync(c));
  if (!f && e.repoRoot) { const base = path.basename(file); const hit = e.pyFiles.find(p => p.endsWith('/' + file) || path.basename(p) === base); if (hit) f = path.join(e.repoRoot, hit); }
  if (!f) { vscode.window.showWarningMessage('找不到文件: ' + file); return; }
  const doc = await vscode.workspace.openTextDocument(f);
  const l = Math.max(0, Math.min((line || 1) - 1, doc.lineCount - 1));
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(l, 0, l, 0), preserveFocus: false });
}

export function activate(ctx: vscode.ExtensionContext) {
  ctxRef = ctx;
  const out = vscode.window.createOutputChannel('Paper Code Analyzer');
  const store = () => new Store(baseDir() ?? path.join(ctx.globalStorageUri.fsPath, 'paper-analysis'));
  const tree = new PaperTree(store);
  const chat = new ChatView(ctx.extensionUri, () => llmCfg(true, 'chat'), () => conf().get('language', 'zh'), openSource);
  const panels = new ReportPanels(ctx.extensionUri, openSource, e => chat.setEntry(e));
  const run = (f: () => Promise<unknown>) => () => f().catch(e => { out.appendLine(String(e?.stack || e)); vscode.window.showErrorMessage('Paper Code Analyzer: ' + e.message); });
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('paperCode.papers', tree),
    vscode.window.registerWebviewViewProvider('paperCode.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('paperCode.setApiKey', async () => {
      const k = await vscode.window.showInputBox({ prompt: '输入 OpenAI API Key（保存在 VS Code SecretStorage）', password: true, ignoreFocusOut: true });
      if (k) { await ctx.secrets.store(KEY, k.trim()); vscode.window.showInformationMessage('API Key 已保存'); }
    }),
    vscode.commands.registerCommand('paperCode.analyze', run(async () => { const e = await analyze(out, store()); if (e) { tree.refresh(); panels.show(e); } })),
    vscode.commands.registerCommand('paperCode.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('paperCode.openReport', (id: string, tab?: string, h?: number) => { const e = store().get(id); if (e) panels.show(e, tab, h); }),
    vscode.commands.registerCommand('paperCode.openGraph', (n: any) => { const id = n?.e?.id; const e = id && store().get(id); if (e) panels.show(e, 'graph'); }),
    vscode.commands.registerCommand('paperCode.openSource', (id: string, f: string, l: number) => { const e = store().get(id); if (e) openSource(e, f, l); }),
    vscode.commands.registerCommand('paperCode.deleteEntry', (n: any) => { if (n?.e?.id) { store().remove(n.e.id); tree.refresh(); } }),
  );
}

async function analyze(out: vscode.OutputChannel, store: Store): Promise<Entry | undefined> {
  const cfg = conf(); const base = baseDir();
  if (!base) { vscode.window.showErrorMessage('请先打开一个工作区文件夹'); return; }
  const paperIn = await vscode.window.showInputBox({ prompt: '论文：arXiv ID / arXiv 链接 / PDF 链接 / 本地 PDF 路径', placeHolder: '2304.13705', ignoreFocusOut: true });
  if (!paperIn) return;
  const repoIn = await vscode.window.showInputBox({ prompt: '代码仓库 GitHub 链接（可留空自动查找）', ignoreFocusOut: true }) ?? '';
  const llm = await llmCfg(true); if (!llm) return;
  const lang = cfg.get<string>('language', 'zh'); const maxChars = cfg.get('maxChunkChars', 24000);
  out.show(true);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '论文代码解析', cancellable: true }, async (prog, tok) => {
    const ac = new AbortController(); tok.onCancellationRequested(() => ac.abort());
    const log = (m: string) => { out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`); prog.report({ message: m }); };
    if (llm.modelNote) log(llm.modelNote);
    if (llm.provider === 'grok') {
      const effort = !llm.reasoningEffort || llm.reasoningEffort === 'config' ? '配置文件默认' : llm.reasoningEffort;
      log(`使用本机 Grok（${llm.model}，思考 ${effort}，子代理 ${llm.subagents === false ? '关' : '开'}，联网 ${llm.webSearch ? '开' : '关'}）`);
      log('Grok 配置目录: ' + (llm.grokHome || ''));
    } else log(`使用 ${llm.model} @ ${llm.baseUrl}`);
    log('下载论文…');
    const paper = await downloadPaper(paperIn.trim(), path.join(base, 'papers'));
    log(`论文: ${paper.title}`);
    let repoUrl = repoIn.trim() ? normalizeRepoUrl(repoIn.trim()) : undefined;
    if (!repoUrl) {
      log('查找代码仓库…');
      const cands = await findRepo(paper.text, paper.arxivId, paper.title);
      if (cands.length) {
        const pick = await vscode.window.showQuickPick(cands.map(c => ({ label: c.url, description: c.source })).concat([{ label: '不分析代码', description: '' }]), { placeHolder: '选择代码仓库', ignoreFocusOut: true });
        if (pick && pick.label !== '不分析代码') repoUrl = pick.label;
      } else log('未找到代码仓库，仅分析论文');
    }
    let repo: RepoAnalysis | undefined;
    if (repoUrl) { log('克隆 ' + repoUrl); const dir = await cloneRepo(repoUrl, path.join(base, 'repos')); log('静态分析 Python 代码…'); repo = analyzeRepo(dir); log(`找到 ${repo.files.length} 个 Python 文件`); }
    const id = (paper.arxivId || path.basename(paper.pdfPath, '.pdf')).replace(/[^\w.]/g, '_');
    let rep; let graph;
    if (llm.provider === 'grok') {
      const trio = await runGrokTrio(llm, lang, cfg.get('agentTurns', 30), cfg.get('maxCodeFiles', 25), paper, repo, path.join(base, 'sessions', id), log, ac.signal);
      rep = trio.report; graph = trio.graph;
    } else {
      rep = await runAnalysis(llm, lang, maxChars, cfg.get('maxCodeFiles', 25), paper, repo, log, ac.signal);
      if (repo) { log('生成结构化架构图与张量形状流…'); graph = await buildLlmGraph(llm, repo, rep.staticOutline, rep.code, lang, maxChars, ac.signal).catch(() => buildStaticGraph(repo)); }
    }
    if (graph) log(`架构图: ${graph.nodes.length} 节点 / ${graph.edges.length} 边 / ${graph.shapeFlow.length} 步 (${graph.source})`);
    const mdPath = path.join(base, `${id}_report.md`);
    const repoRel = repo ? path.relative(base, repo.root).split(path.sep).join('/') : '';
    const fixLinks = (s: string) => repo ? s.replace(/\]\((?!https?:|#)([^)#\s]+\.py)(#L\d+)?\)/g, (_m, f, l) => `](${repoRel}/${f}${l || ''})`) : s;
    const shapeMd = graph?.shapeFlow.length ? '# 张量形状流\n\n| # | 步骤 | 代码 | 操作 | 输入 | 输出 |\n|---|---|---|---|---|---|\n' + graph.shapeFlow.map(s => `| ${s.step} | ${s.name} | ${s.file ? `[${s.file}:${s.line ?? ''}](${repoRel}/${s.file}${s.line ? '#L' + s.line : ''})` : ''} | \`${s.op.replace(/\|/g, '\\|')}\` | \`${s.input}\` | \`${s.output}\` |`).join('\n') : '';
    fs.writeFileSync(mdPath, `# ${paper.title}\n\n- arXiv: ${paper.arxivId ?? '-'}\n- PDF: ${paper.pdfPath}\n- Code: ${repoUrl ?? '-'}\n- Model: ${llm.model}\n\n${fixLinks(rep.paper)}\n\n${fixLinks(rep.code)}\n\n${fixLinks(rep.mapping)}\n\n${shapeMd}\n\n# 附录：静态分析大纲\n\n\`\`\`\n${rep.staticOutline}\n\`\`\`\n`);
    const e: Entry = { id, title: paper.title, arxivId: paper.arxivId, pdfPath: paper.pdfPath, repoUrl, repoRoot: repo?.root, mdPath, createdAt: new Date().toISOString(), model: llm.model, report: rep, graph,
      modules: repo ? repo.files.flatMap(f => f.classes.filter(c => c.isModule).map(c => ({ name: c.name, file: f.rel, line: c.line }))) : [], pyFiles: repo ? repo.files.map(f => f.rel) : [] };
    store.save(e);
    log('报告已保存: ' + mdPath);
    return e;
  });
}
export function deactivate() {}

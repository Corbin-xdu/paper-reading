import * as fs from 'fs';
import * as path from 'path';
import { LlmCfg } from './llm';
import { PaperInfo } from './paper';
import { RepoAnalysis, outline } from './staticAnalysis';
import { chooseGrokModel, grokAgent, grokModels, parseGrokModels, summarizeGrokEvent } from './grokEngine';
import { ArchGraph, buildStaticGraph, extractJson, validateGraph, SCHEMA } from './graph';
import type { Report } from './pipeline';

const PAPER_OUTLINE = `# 论文解析
## 1. 研究问题与动机
## 2. 核心贡献
## 3. 方法总览（含 mermaid 架构图）
## 4. 模型架构逐模块详解（每个模块的输入/输出维度）
## 5. 关键公式与损失函数（LaTeX，逐项解释）
## 6. 训练与推理流程
## 7. 实验设置与关键结论
## 8. 局限与思考`;

const CODE_OUTLINE = `# 代码解析
## 1. 仓库结构与各目录职责
## 2. 入口与运行方式（训练/评估脚本、关键命令行参数与默认值）
## 3. 整体架构（mermaid 图：类之间的组成与调用）
## 4. 模块设计逐个详解（类、子模块、参数）
## 5. 数据流水线：从原始输入到损失，逐步列出张量形状（步骤|代码位置|操作|输入形状|输出形状），并配 mermaid 数据流图
## 6. 损失计算与训练循环
## 7. 推理/部署流程`;

export async function runGrokTrio(cfg: LlmCfg, lang: string, maxTurns: number, maxFiles: number, paper: PaperInfo, repo: RepoAnalysis | undefined, work: string, log: (m: string) => void, signal?: AbortSignal): Promise<{ report: Report; graph?: ArchGraph }> {
  fs.mkdirSync(work, { recursive: true });
  let live = cfg;
  try {
    const picked = chooseGrokModel(cfg.model, parseGrokModels(await grokModels(cfg)));
    if (picked.note) log(picked.note);
    if (picked.model && picked.model !== cfg.model) live = { ...cfg, model: picked.model };
    if (!picked.model) live = { ...cfg, model: '' };
  } catch (e: any) { log('读取 grok models 失败，让 Grok 自己选模型: ' + (e?.message || e)); live = { ...cfg, model: '' }; }
  const langLine = lang === 'zh'
    ? '全部用简体中文，术语可保留英文。引用代码写成 [文件#L行号](相对路径.py#L行号)。公式写成 $行内$ 或独立一行的 $$公式$$，不要用 \\( \\)。'
    : 'Answer in English. Cite code as [file#Lline](rel.py#Lline). Write math as $inline$ or a paragraph of $$...$$, not \\( \\).';
  const paperTxt = paper.pdfPath.replace(/\.pdf$/i, '') + '.txt';
  if (!fs.existsSync(paperTxt)) fs.writeFileSync(paperTxt, paper.text);
  const paperDir = path.dirname(paperTxt);
  const top = repo ? repo.files.filter(f => f.score > 0).slice(0, maxFiles) : [];
  const staticOutline = top.map(outline).join('\n\n');
  const outlinePath = path.join(work, 'outline.txt');
  if (staticOutline) fs.writeFileSync(outlinePath, staticOutline);

  const hands = live.subagents === false ? '不要派子代理。' : '可以派子代理。';
  const run = async (label: string, cwd: string, task: string) => {
    log(`${label}会话已启动${live.subagents === false ? '' : '（可自行派子代理）'}`);
    const t0 = Date.now(); let n = 0;
    const text = await grokAgent(live, cwd, task, maxTurns, signal, ev => {
      const line = summarizeGrokEvent(ev);
      if (!line) return;
      n++;
      if (n <= 50) log(`${label} ${line}`);
    });
    log(`${label}会话完成，${Math.round((Date.now() - t0) / 1000)} 秒`);
    if (!text.trim()) throw new Error(`${label}会话没有返回正文`);
    const body = text.trim();
    const h = body.search(/^# /m);
    return h > 0 ? body.slice(h) : body;
  };

  log('同时打开论文会话和代码会话');
  const paperTask = `你负责读这篇论文。${hands}不要改文件。\n${langLine}\n\n标题: ${paper.title}\n文本文件: ${paperTxt}\n\n读完后只输出下面结构的 Markdown：\n${PAPER_OUTLINE}`;
  const codeTask = repo ? `你负责读当前目录这个代码仓库，看模型、张量形状、数据和训练。${hands}不要改文件，不要跑训练。\n${langLine}\n\n先读静态大纲 ${outlinePath}，再深入源码。优先这些文件：\n${top.map(f => f.rel).join('\n')}\n\n读完后只输出下面结构的 Markdown：\n${CODE_OUTLINE}` : '';

  const [paperMd, codeMd] = await Promise.all([
    run('论文', paperDir, paperTask),
    repo ? run('代码', repo.root, codeTask) : Promise.resolve('_未提供/未找到代码仓库_'),
  ]);
  fs.writeFileSync(path.join(work, 'paper.md'), paperMd);
  fs.writeFileSync(path.join(work, 'code.md'), codeMd);
  if (!repo) return { report: { paper: paperMd, code: codeMd, mapping: '', staticOutline } };

  const both = `论文解析文件: ${path.join(work, 'paper.md')}\n代码解析文件: ${path.join(work, 'code.md')}\n静态大纲: ${outlinePath}`;
  const synth = await run('综合', repo.root, `你负责把论文和代码对照起来，并给出可绘制的模型架构。可以再打开源码核对。${hands}不要改文件。\n${langLine}\n\n${both}\n\n输出顺序固定：\n1. Markdown，从「# 论文 ↔ 代码对照」开始，包含：对照总表（论文章节/公式/模块 | 代码位置 | 实现说明 | 差异）、逐条解释、论文没写但代码里有的细节、复现建议。\n2. 最后单独一个 \`\`\`json 代码块，不要在块外再写别的 JSON。格式：\n${SCHEMA}\n要求：edges 是前向数据流并带张量形状；shapeFlow 10 到 40 步，file/line 必须是仓库里真实存在的位置。`);
  const fence = synth.match(/```json\s*([\s\S]*?)```/);
  const mapping = (fence && fence.index != null ? synth.slice(0, fence.index) + synth.slice(fence.index + fence[0].length) : synth).trim();
  let graph: ArchGraph | undefined;
  const fallback = buildStaticGraph(repo);
  if (fence) {
    try { graph = validateGraph(extractJson(synth), fallback); }
    catch (e: any) { log('架构 JSON 解析失败，改用静态组成图: ' + (e?.message || e)); graph = fallback; }
  } else { log('综合会话没有给出架构 JSON，改用静态组成图'); graph = fallback; }
  return { report: { paper: paperMd, code: codeMd, mapping, staticOutline }, graph };
}

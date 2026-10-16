import * as fs from 'fs';
import * as path from 'path';
import { chat, LlmCfg } from './llm';
import { PaperInfo } from './paper';
import { RepoAnalysis, outline, chunkFile } from './staticAnalysis';

export interface Report { paper: string; code: string; mapping: string; staticOutline: string; }
type Log = (m: string) => void;

const L = (lang: string) => lang === 'zh' ? '请全部用简体中文回答（术语可保留英文）。' : 'Answer in English.';
const SYS = (lang: string) => `你是AI与具身智能(机器人学习、VLA、模仿学习、强化学习、扩散策略、Transformer)领域的资深研究员和工程师，擅长逐行阅读PyTorch代码并追踪张量维度。输出Markdown。公式写成 $行内$ 或独立一行的 $$公式$$。需要画图时使用 \`\`\`mermaid 代码块（flowchart TD，节点文本用双引号包裹，避免特殊字符）。引用代码时必须写成 [文件路径#L行号](文件路径#L行号) 形式。${L(lang)}`;

function splitText(t: string, max: number): string[] { const o: string[] = []; for (let i = 0; i < t.length; i += max) o.push(t.slice(i, i + max)); return o; }

export async function runAnalysis(cfg: LlmCfg, lang: string, maxChars: number, maxFiles: number, paper: PaperInfo, repo: RepoAnalysis | undefined, log: Log, signal?: AbortSignal): Promise<Report> {
  const sys = SYS(lang);
  // 1. paper: map-reduce over chunks
  const body = paper.text.split(/\n\s*References\s*\n/i)[0];
  const pchunks = splitText(body, maxChars);
  const notes: string[] = [];
  for (let i = 0; i < pchunks.length; i++) {
    log(`论文分块阅读 ${i + 1}/${pchunks.length}`);
    notes.push(await chat(cfg, sys, `论文《${paper.title}》第${i + 1}/${pchunks.length}部分原文。提取：方法细节、模块、公式(用LaTeX，标注公式编号)、损失、输入输出及维度、超参数、训练与推理流程。只做详细笔记。\n\n${pchunks[i]}`, signal));
  }
  log('生成论文分析');
  const paperMd = await chat(cfg, sys, `基于以下论文笔记，写出结构化论文解析：\n# 论文解析\n## 1. 研究问题与动机\n## 2. 核心贡献\n## 3. 方法总览（含 mermaid 架构图）\n## 4. 模型架构逐模块详解（每个模块输入/输出维度）\n## 5. 关键公式与损失函数（LaTeX，逐项解释）\n## 6. 训练与推理流程\n## 7. 实验设置与关键结论\n## 8. 局限与思考\n\n标题: ${paper.title}\n摘要: ${paper.abstract}\n\n笔记:\n${notes.join('\n\n---\n\n')}`, signal);
  if (!repo) return { paper: paperMd, code: '_未提供/未找到代码仓库_', mapping: '', staticOutline: '' };

  // 2. code
  const top = repo.files.filter(f => f.score > 0).slice(0, maxFiles);
  const staticOutline = top.map(outline).join('\n\n');
  const fileNotes: string[] = [];
  for (const f of top) {
    const src = fs.readFileSync(path.join(repo.root, f.rel), 'utf8');
    const chunks = chunkFile(f.rel, src, maxChars);
    for (let i = 0; i < chunks.length; i++) {
      log(`代码阅读 ${f.rel} (${i + 1}/${chunks.length})`);
      fileNotes.push(await chat(cfg, sys, `论文方法摘要（供对照）:\n${paperMd.slice(0, 4000)}\n\n静态分析大纲:\n${outline(f)}\n\n下面是带行号的源码。请分析：每个类/函数的职责、构造了哪些子模块、forward 中每一步的张量形状变化（如 [B, T, D] -> [B, T, H, D/H]，未知维度用符号并说明来源/默认超参数）、与其他文件的调用关系、对应论文中的哪个部分。引用写 [${f.rel}#L行号](${f.rel}#L行号)。\n\n${chunks[i]}`, signal));
    }
  }
  log('汇总代码架构');
  const notesJoined = fileNotes.join('\n\n---\n\n').slice(0, maxChars * 3);
  const codeMd = await chat(cfg, sys, `基于以下逐文件笔记、仓库结构、README与配置，写出代码解析：\n# 代码解析\n## 1. 仓库结构与各目录职责\n## 2. 入口与运行方式（训练/评估脚本、关键命令行参数与默认值）\n## 3. 整体架构（mermaid 图：类之间的组成/调用关系）\n## 4. 模块设计逐个详解（类、子模块、参数）\n## 5. 数据流水线：从原始数据加载 -> 预处理 -> 模型各层 -> 输出/损失，逐步列出张量形状变化表格（步骤|代码位置|操作|输入形状|输出形状），并配 mermaid 数据流图\n## 6. 损失计算与训练循环\n## 7. 推理/部署流程\n\n仓库结构:\n${repo.tree.slice(0, 6000)}\n\nREADME:\n${repo.readme.slice(0, 3000)}\n\n配置:\n${repo.configs.map(c => `### ${c.rel}\n${c.content.slice(0, 800)}`).join('\n').slice(0, 4000)}\n\n逐文件笔记:\n${notesJoined}`, signal);
  log('生成论文-代码对照');
  const mapping = await chat(cfg, sys, `将论文与代码逐项对照，输出：\n# 论文 ↔ 代码对照\n## 1. 对照总表（Markdown 表格：论文章节/公式/模块 | 代码文件与函数(带行号链接) | 实现说明 | 论文与代码差异/隐藏细节）\n## 2. 逐条深入解释（每个公式/模块：论文怎么说 → 代码怎么做 → 维度如何变化）\n## 3. 论文没写但代码里有的实现细节（trick、超参数、归一化、数据增强等）\n## 4. 复现与修改建议\n\n论文解析:\n${paperMd}\n\n代码解析:\n${codeMd}\n\n静态大纲:\n${staticOutline.slice(0, maxChars)}`, signal);
  return { paper: paperMd, code: codeMd, mapping, staticOutline };
}

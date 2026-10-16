import { RepoAnalysis, PyClass } from './staticAnalysis';
import { chat, LlmCfg } from './llm';

export interface GNode { id: string; label: string; kind: 'module' | 'layer' | 'tensor' | 'op' | 'io'; parent?: string; file?: string; line?: number; desc?: string; }
export interface GEdge { source: string; target: string; shape?: string; label?: string; }
export interface ShapeStep { step: number; name: string; op: string; file?: string; line?: number; input: string; output: string; note?: string; }
export interface ArchGraph { nodes: GNode[]; edges: GEdge[]; shapeFlow: ShapeStep[]; source: 'static' | 'llm'; }

/** Static graph: nn.Module classes as compound nodes, their self.xxx = Y(...) as children; edges = composition. */
export function buildStaticGraph(repo: RepoAnalysis, maxClasses = 40): ArchGraph {
  const mods: { c: PyClass; file: string }[] = [];
  for (const f of repo.files) for (const c of f.classes) if (c.isModule) mods.push({ c, file: f.rel });
  const sel = mods.slice(0, maxClasses);
  const byName = new Map(sel.map(m => [m.c.name, m]));
  const nodes: GNode[] = []; const edges: GEdge[] = [];
  for (const { c, file } of sel) {
    nodes.push({ id: c.name, label: c.name, kind: 'module', file, line: c.line, desc: `class ${c.name}(${c.bases})` });
    const fwd = c.methods.find(m => m.name === 'forward');
    for (const s of c.submodules) {
      let t = s.type.replace(/^(torch\.)?nn\./, '');
      if (t.startsWith('@')) { // injected via constructor arg, e.g. self.transformer = transformer
        const key = t.slice(1).toLowerCase().replace(/s$/, '').replace(/_/g, '');
        const hit = sel.find(m => m.c.name.toLowerCase() === key);
        if (hit) edges.push({ source: c.name, target: hit.c.name, label: 'self.' + s.name });
        continue;
      }
      if (byName.has(t)) edges.push({ source: c.name, target: t, label: 'self.' + s.name });
      else if (!nodes.some(n => n.id === `${c.name}.${s.name}`)) nodes.push({ id: `${c.name}.${s.name}`, label: `${s.name}: ${t}`, kind: 'layer', parent: c.name, file, line: s.line });
    }
    if (fwd) nodes.push({ id: `${c.name}.forward`, label: 'forward()', kind: 'op', parent: c.name, file, line: fwd.line });
  }
  // calls: build(...)/ClassName( in functions referencing modules
  return { nodes, edges, shapeFlow: [], source: 'static' };
}

export const SCHEMA = `{
 "nodes":[{"id":"唯一ID","label":"显示名","kind":"module|layer|op|tensor|io","parent":"父模块id(可选,用于折叠)","file":"相对路径.py","line":行号,"desc":"一句话职责"}],
 "edges":[{"source":"id","target":"id","shape":"如 [B, T, 512]","label":"数据含义"}],
 "shapeFlow":[{"step":1,"name":"步骤名","op":"操作/代码表达式","file":"相对路径.py","line":行号,"input":"[B, 3, 480, 640]","output":"[B, 512, 15, 20]","note":"说明"}]
}`;

export function extractJson(s: string): any {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  let t = fence ? fence[1] : s;
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON');
  t = t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(t);
}

export function validateGraph(j: any, fallback: ArchGraph): ArchGraph {
  const nodes: GNode[] = (Array.isArray(j?.nodes) ? j.nodes : []).filter((n: any) => n && n.id).map((n: any) => ({
    id: String(n.id), label: String(n.label ?? n.id), kind: ['module', 'layer', 'op', 'tensor', 'io'].includes(n.kind) ? n.kind : 'layer',
    parent: n.parent ? String(n.parent) : undefined, file: n.file ? String(n.file) : undefined, line: Number(n.line) || undefined, desc: n.desc ? String(n.desc) : undefined }));
  const ids = new Set(nodes.map(n => n.id));
  for (const n of nodes) if (n.parent && (!ids.has(n.parent) || n.parent === n.id)) n.parent = undefined;
  const edges: GEdge[] = (Array.isArray(j?.edges) ? j.edges : []).filter((e: any) => ids.has(String(e?.source)) && ids.has(String(e?.target)))
    .map((e: any) => ({ source: String(e.source), target: String(e.target), shape: e.shape ? String(e.shape) : undefined, label: e.label ? String(e.label) : undefined }));
  const shapeFlow: ShapeStep[] = (Array.isArray(j?.shapeFlow) ? j.shapeFlow : []).map((s: any, i: number) => ({
    step: Number(s.step) || i + 1, name: String(s.name ?? ''), op: String(s.op ?? ''), file: s.file ? String(s.file) : undefined, line: Number(s.line) || undefined,
    input: String(s.input ?? ''), output: String(s.output ?? ''), note: s.note ? String(s.note) : undefined }));
  if (nodes.length < 2) return { ...fallback, shapeFlow: shapeFlow.length ? shapeFlow : fallback.shapeFlow };
  return { nodes, edges, shapeFlow, source: 'llm' };
}

/** Ask LLM for structured graph, grounded on static outline + code analysis. Falls back to static graph. */
export async function buildLlmGraph(cfg: LlmCfg, repo: RepoAnalysis, staticOutline: string, codeMd: string, lang: string, maxChars: number, signal?: AbortSignal): Promise<ArchGraph> {
  const st = buildStaticGraph(repo);
  const prompt = `根据下面的静态分析大纲和代码解析，输出模型的**结构化架构图**与**张量形状流**。只输出一个严格 JSON 对象（不要注释、不要多余文字），格式：\n${SCHEMA}\n要求：\n- nodes 覆盖从原始输入(kind=io)、各 nn.Module(kind=module)、关键子层(kind=layer, parent=所属module)、到输出/损失(kind=io)。\n- edges 表示前向数据流（不是继承），每条边写明该处张量形状，用符号维度（B批大小, T时间, C通道, H, W, D隐藏维, N token数等），已知默认超参数可代入数值。\n- shapeFlow 按前向执行顺序列出 10~40 步，每步给出 file/line（必须来自大纲中的真实行号）、输入与输出形状。\n- label/desc/note 用${lang === 'zh' ? '简体中文' : 'English'}。\n\n静态大纲:\n${staticOutline.slice(0, maxChars)}\n\n代码解析:\n${codeMd.slice(0, maxChars)}`;
  try {
    const out = await chat(cfg, '你是严谨的 PyTorch 架构分析器，只输出合法 JSON。', prompt, signal);
    return validateGraph(extractJson(out), st);
  } catch { return st; }
}

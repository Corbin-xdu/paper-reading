import * as fs from 'fs';
import * as path from 'path';

export interface PyFunc { name: string; line: number; endLine: number; args: string; shapeOps: { line: number; code: string }[]; }
export interface PyClass { name: string; bases: string; line: number; endLine: number; isModule: boolean; methods: PyFunc[]; submodules: { name: string; type: string; line: number }[]; }
export interface PyFile { rel: string; lines: number; classes: PyClass[]; functions: PyFunc[]; imports: string[]; score: number; hasMain: boolean; cliArgs: string[]; }
export interface RepoAnalysis { root: string; tree: string; files: PyFile[]; configs: { rel: string; content: string }[]; readme: string; }

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'build', 'dist', '.eggs', 'wandb', 'outputs', 'logs']);
const SHAPE_RE = /\.(view|reshape|permute|transpose|flatten|unsqueeze|squeeze|expand|repeat|chunk|split)\(|torch\.(cat|stack|einsum|bmm|matmul)\(|einops|rearrange\(|\.shape|\.size\(|#.*\b(B|N|T|C|H|W|bs|batch)\b.*[x×,]/;
const MODULE_BASES = /(nn\.Module|Module|LightningModule|PreTrainedModel|nn\.Sequential|Transformer|Backbone|Policy)/;

function walk(dir: string, root: string, acc: string[], depth = 0) {
  if (depth > 8) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, acc, depth + 1); else acc.push(path.relative(root, p));
  }
}

export function buildTree(files: string[], max = 300): string {
  const shown = files.filter(f => /\.(py|ya?ml|json|md|sh|cfg|toml|txt)$/.test(f)).slice(0, max);
  return shown.join('\n') + (files.length > max ? `\n... (${files.length} files total)` : '');
}

function blockEnd(lines: string[], start: number, indent: number): number {
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]; if (!l.trim() || l.trim().startsWith('#')) continue;
    if (l.search(/\S/) <= indent) break;
  }
  return i; // exclusive, 0-based => 1-based inclusive end
}

export function parsePython(src: string, rel: string): PyFile {
  const lines = src.split(/\r?\n/);
  const classes: PyClass[] = []; const functions: PyFunc[] = []; const imports: string[] = []; const cliArgs: string[] = [];
  let cur: PyClass | undefined; let curIndent = -1;
  const parseFunc = (i: number, m: RegExpMatchArray, indent: number): PyFunc => {
    const end = blockEnd(lines, i, indent); const shapeOps = [];
    for (let j = i + 1; j < end; j++) if (SHAPE_RE.test(lines[j])) shapeOps.push({ line: j + 1, code: lines[j].trim().slice(0, 160) });
    return { name: m[1], line: i + 1, endLine: end, args: m[2].replace(/\s+/g, ' ').slice(0, 200), shapeOps };
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const indent = l.search(/\S/);
    if (indent < 0) continue;
    if (cur && indent <= curIndent && l.trim() && !l.trim().startsWith('#')) cur = undefined;
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/))) imports.push(m[1] || m[2]);
    if ((m = l.match(/add_argument\(\s*['"](-{1,2}[\w\-]+)/))) cliArgs.push(m[1]);
    if ((m = l.match(/^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/))) {
      const end = blockEnd(lines, i, indent);
      cur = { name: m[2], bases: m[3] || '', line: i + 1, endLine: end, isModule: MODULE_BASES.test(m[3] || ''), methods: [], submodules: [] };
      curIndent = indent; classes.push(cur); continue;
    }
    if ((m = l.match(/^\s*def\s+(\w+)\s*\(([^)]*)\)?/))) {
      const f = parseFunc(i, m, indent);
      if (cur && indent > curIndent) cur.methods.push(f); else if (indent === 0) functions.push(f);
      continue;
    }
    if (cur && (m = l.match(/self\.(\w+)\s*=\s*((?:nn|torch\.nn)\.\w+|[A-Z]\w+)\(/))) cur.submodules.push({ name: m[1], type: m[2], line: i + 1 });
    else if (cur && (m = l.match(/self\.(\w+)\s*=\s*(?:nn\.ModuleList\()?([a-z_]\w*)\)?\s*(#.*)?$/)) && !/^(None|True|False|args|kwargs)$/.test(m[2])) cur.submodules.push({ name: m[1], type: '@' + m[2], line: i + 1 });
  }
  const mods = classes.filter(c => c.isModule);
  let score = mods.length * 5 + mods.filter(c => c.methods.some(f => f.name === 'forward')).length * 5;
  score += classes.reduce((s, c) => s + c.methods.reduce((a, f) => a + f.shapeOps.length, 0), 0);
  if (/model|policy|net|transformer|detr|backbone|encoder|decoder|vae|diffusion|act|train|dataset|data|utils/i.test(rel)) score += 6;
  if (/test|setup\.py|__init__|docs?\//i.test(rel)) score -= 8;
  return { rel, lines: lines.length, classes, functions, imports: [...new Set(imports)], score, hasMain: /__name__\s*==\s*['"]__main__/.test(src), cliArgs };
}

export function analyzeRepo(root: string): RepoAnalysis {
  const all: string[] = []; walk(root, root, all);
  const files = all.filter(f => f.endsWith('.py')).map(rel => {
    try { return parsePython(fs.readFileSync(path.join(root, rel), 'utf8'), rel); } catch { return undefined; }
  }).filter((x): x is PyFile => !!x).sort((a, b) => b.score - a.score);
  const configs = all.filter(f => /\.(ya?ml|json|toml|cfg)$/.test(f) && !/package|lock/.test(f)).slice(0, 15)
    .map(rel => ({ rel, content: fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 3000) }));
  const rm = all.find(f => /^readme/i.test(f));
  return { root, tree: buildTree(all), files, configs, readme: rm ? fs.readFileSync(path.join(root, rm), 'utf8').slice(0, 8000) : '' };
}

/** Compact outline of a file for the LLM (and for the report). */
export function outline(f: PyFile): string {
  const o: string[] = [`## ${f.rel} (${f.lines} lines)`];
  for (const c of f.classes) {
    o.push(`class ${c.name}(${c.bases}) L${c.line}-${c.endLine}${c.isModule ? ' [nn.Module]' : ''}`);
    for (const s of c.submodules) o.push(`  self.${s.name} = ${s.type}  L${s.line}`);
    for (const m of c.methods) { o.push(`  def ${m.name}(${m.args}) L${m.line}`); for (const s of m.shapeOps.slice(0, 12)) o.push(`    L${s.line}: ${s.code}`); }
  }
  for (const fn of f.functions) o.push(`def ${fn.name}(${fn.args}) L${fn.line}`);
  if (f.cliArgs.length) o.push(`CLI args: ${f.cliArgs.join(' ')}`);
  return o.join('\n');
}

/** Split content into chunks <= maxChars, prefixing line numbers so LLM can cite L<n>. */
export function chunkFile(rel: string, src: string, maxChars: number): string[] {
  const lines = src.split(/\r?\n/).map((l, i) => `${i + 1}: ${l}`);
  const chunks: string[] = []; let buf: string[] = []; let size = 0;
  for (const l of lines) {
    if (size + l.length > maxChars && buf.length) { chunks.push(`# FILE ${rel}\n` + buf.join('\n')); buf = []; size = 0; }
    buf.push(l); size += l.length + 1;
  }
  if (buf.length) chunks.push(`# FILE ${rel}\n` + buf.join('\n'));
  return chunks;
}

import * as vscode from 'vscode';
import { Store, Entry, headings } from './store';
type Node = { kind: 'paper'; e: Entry } | { kind: 'group'; e: Entry; g: 'paper' | 'code' | 'mapping' } | { kind: 'leaf'; e: Entry; label: string; cmd: vscode.Command; icon: string; desc?: string };
export class PaperTree implements vscode.TreeDataProvider<Node> {
  private ev = new vscode.EventEmitter<void>(); onDidChangeTreeData = this.ev.event;
  constructor(private store: () => Store) {}
  refresh() { this.ev.fire(); }
  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'paper') { const t = new vscode.TreeItem(n.e.title, vscode.TreeItemCollapsibleState.Collapsed); t.description = n.e.arxivId; t.contextValue = 'paper'; t.iconPath = new vscode.ThemeIcon('book'); t.tooltip = `${n.e.title}\n${n.e.repoUrl ?? ''}\n${n.e.createdAt}`; t.id = n.e.id; return t; }
    if (n.kind === 'group') { const L = { paper: ['论文解析', 'file-text'], code: ['代码模块', 'symbol-class'], mapping: ['论文 ↔ 代码对照', 'arrow-swap'] }[n.g]; const t = new vscode.TreeItem(L[0], vscode.TreeItemCollapsibleState.Collapsed); t.iconPath = new vscode.ThemeIcon(L[1]); t.id = n.e.id + '/' + n.g; return t; }
    const t = new vscode.TreeItem(n.label); t.command = n.cmd; t.iconPath = new vscode.ThemeIcon(n.icon); t.description = n.desc; return t;
  }
  getChildren(n?: Node): Node[] {
    if (!n) return this.store().list().map(e => ({ kind: 'paper', e }));
    const open = (e: Entry, tab: string, h?: number): vscode.Command => ({ command: 'paperCode.openReport', title: '', arguments: [e.id, tab, h] });
    if (n.kind === 'paper') {
      const e = n.e; const out: Node[] = [{ kind: 'group', e, g: 'paper' }];
      if (e.repoRoot) out.push({ kind: 'group', e, g: 'code' });
      out.push({ kind: 'group', e, g: 'mapping' });
      if (e.graph) { out.push({ kind: 'leaf', e, label: '模型架构图', cmd: open(e, 'graph'), icon: 'type-hierarchy' }, { kind: 'leaf', e, label: '张量形状流', cmd: open(e, 'shape'), icon: 'debug-step-over', desc: `${e.graph.shapeFlow.length} 步` }); }
      out.push({ kind: 'leaf', e, label: 'Markdown 报告', cmd: { command: 'vscode.open', title: '', arguments: [vscode.Uri.file(e.mdPath)] }, icon: 'markdown' });
      return out;
    }
    if (n.kind === 'group') {
      const e = n.e;
      if (n.g === 'code') return [{ kind: 'leaf', e, label: '代码解析总览', cmd: open(e, 'code'), icon: 'preview' } as Node].concat(e.modules.map(m => ({ kind: 'leaf', e, label: m.name, desc: `${m.file}:${m.line}`, icon: 'symbol-class', cmd: { command: 'paperCode.openSource', title: '', arguments: [e.id, m.file, m.line] } })));
      const md = n.g === 'paper' ? e.report.paper : e.report.mapping;
      return headings(md).map(h => ({ kind: 'leaf', e, label: h.title, icon: 'symbol-string', cmd: open(e, n.g, h.idx) }));
    }
    return [];
  }
}

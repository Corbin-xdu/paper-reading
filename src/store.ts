import * as fs from 'fs';
import * as path from 'path';
import { ArchGraph } from './graph';
export interface Entry {
  id: string; title: string; arxivId?: string; pdfPath: string; repoUrl?: string; repoRoot?: string; mdPath: string; createdAt: string; model: string;
  report: { paper: string; code: string; mapping: string; staticOutline: string };
  graph?: ArchGraph; modules: { name: string; file: string; line: number }[]; pyFiles: string[];
}
export class Store {
  constructor(public dir: string) {}
  private f(id: string) { return path.join(this.dir, `${id}_analysis.json`); }
  save(e: Entry) { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.f(e.id), JSON.stringify(e, null, 1)); }
  list(): Entry[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter(n => n.endsWith('_analysis.json')).map(n => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8')) as Entry; } catch { return undefined; } })
      .filter((x): x is Entry => !!x).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string) { return this.list().find(e => e.id === id); }
  remove(id: string) { try { fs.unlinkSync(this.f(id)); } catch { /* */ } }
}
export function headings(md: string, level = 2): { title: string; idx: number }[] {
  const re = new RegExp(`^#{${level}}\\s+(.+)$`, 'gm'); return [...md.matchAll(re)].map((m, idx) => ({ title: m[1].trim(), idx }));
}

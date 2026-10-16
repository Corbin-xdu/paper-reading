import * as fs from 'fs';
import * as path from 'path';
import { chunkFile } from './staticAnalysis';
/** Keyword retrieval over repo .py files: score chunks by query term hits (identifiers + CJK-agnostic). */
export function retrieveChunks(repoRoot: string, files: string[], query: string, k = 4, chunkChars = 4000): string[] {
  const terms = [...new Set((query.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []))];
  if (!terms.length) {
    const prefer = files.filter(f => /model|policy|network|transformer|encoder|decoder|loss|train|dataset|afford|diffusion/i.test(f));
    const pick = (prefer.length ? prefer : files).slice(0, k);
    const out: string[] = [];
    for (const rel of pick) {
      try {
        const first = chunkFile(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf8'), chunkChars)[0];
        if (first) out.push(first);
      } catch { /* 文件缺失就跳过 */ }
    }
    return out;
  }
  const scored: { s: number; c: string }[] = [];
  for (const rel of files) {
    let src: string; try { src = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
    for (const c of chunkFile(rel, src, chunkChars)) {
      const low = c.toLowerCase(); let s = 0;
      for (const t of terms) { const n = low.split(t).length - 1; if (n) s += 1 + Math.log(n) + (rel.toLowerCase().includes(t) ? 2 : 0); }
      if (s > 0) scored.push({ s, c });
    }
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, k).map(x => x.c);
}

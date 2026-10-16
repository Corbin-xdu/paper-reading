import * as path from 'path';
import { downloadPaper } from '../paper';
import { findRepo, cloneRepo } from '../repo';
import { analyzeRepo, outline, chunkFile } from '../staticAnalysis';
import * as fs from 'fs';
(async () => {
  const out = process.argv[2] || '/tmp/pca-test';
  const p = await downloadPaper('https://arxiv.org/abs/2304.13705', path.join(out, 'papers'));
  console.log('TITLE:', p.title, '| authors:', p.authors.length, '| text chars:', p.text.length);
  const c = await findRepo(p.text, p.arxivId, p.title);
  console.log('REPO CANDIDATES:', c);
  const url = c.find(x => /tonyzhaozh\/act$/i.test(x.url))?.url || 'https://github.com/tonyzhaozh/act';
  const dir = await cloneRepo(url, path.join(out, 'repos'));
  const r = analyzeRepo(dir);
  console.log('PY FILES:', r.files.length, 'MODULES:', r.files.reduce((s, f) => s + f.classes.filter(k => k.isModule).length, 0));
  console.log('TOP FILES:', r.files.slice(0, 6).map(f => `${f.rel}(${f.score})`).join(', '));
  console.log(outline(r.files.find(f => /detr_vae/.test(f.rel)) || r.files[0]).slice(0, 2500));
  const big = r.files[0]; console.log('CHUNKS for', big.rel, chunkFile(big.rel, fs.readFileSync(path.join(dir, big.rel), 'utf8'), 8000).length);
})().catch(e => { console.error(e); process.exit(1); });

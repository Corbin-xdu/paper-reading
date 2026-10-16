import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface PaperInfo { arxivId?: string; title: string; abstract: string; authors: string[]; pdfPath: string; text: string; }

export function parseArxivId(input: string): string | undefined {
  const m = input.trim().match(/(\d{4}\.\d{4,5})(v\d+)?/) || input.match(/arxiv\.org\/(?:abs|pdf)\/([a-z\-]+\/\d{7})/i);
  return m ? m[1] : undefined;
}

async function fetchBuf(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'User-Agent': 'paper-code-analyzer/0.1' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function fetchArxivMeta(id: string) {
  const xml = (await fetchBuf(`https://export.arxiv.org/api/query?id_list=${id}`)).toString('utf8');
  const entry = xml.split('<entry>')[1] || '';
  const tag = (t: string) => (entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim());
  return { title: tag('title'), abstract: tag('summary'), authors };
}

export async function extractPdfText(pdfPath: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(fs.readFileSync(pdfPath));
    if (data.text && data.text.length > 500) return data.text;
  } catch { /* fall through */ }
  try { return execFileSync('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 64 << 20 }).toString('utf8'); }
  catch { throw new Error('PDF 文本提取失败（pdf-parse 与 pdftotext 均不可用）'); }
}

/** input: arXiv id/URL, direct PDF URL, or local PDF path */
export async function downloadPaper(input: string, outDir: string): Promise<PaperInfo> {
  fs.mkdirSync(outDir, { recursive: true });
  const id = fs.existsSync(input) ? undefined : parseArxivId(input);
  let pdfPath: string; let meta = { title: '', abstract: '', authors: [] as string[] };
  if (fs.existsSync(input)) pdfPath = input;
  else if (id) {
    pdfPath = path.join(outDir, `${id.replace('/', '_')}.pdf`);
    if (!fs.existsSync(pdfPath)) fs.writeFileSync(pdfPath, await fetchBuf(`https://arxiv.org/pdf/${id}`));
    try { meta = await fetchArxivMeta(id); } catch { /* optional */ }
  } else if (/^https?:/.test(input)) {
    pdfPath = path.join(outDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, await fetchBuf(input));
  } else throw new Error('无法识别的论文输入：' + input);
  const text = await extractPdfText(pdfPath);
  fs.writeFileSync(pdfPath.replace(/\.pdf$/i, '') + '.txt', text);
  return { arxivId: id, title: meta.title || text.split('\n').find(l => l.trim().length > 10)?.trim() || 'Untitled', abstract: meta.abstract, authors: meta.authors, pdfPath, text };
}

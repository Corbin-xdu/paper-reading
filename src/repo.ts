import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

const GH = /github\.com\/([A-Za-z0-9_.\-]+)\/([A-Za-z0-9_.\-]+)/g;
const IGNORE_OWNERS = new Set(['features', 'about', 'sponsors', 'topics', 'orgs']);

export function normalizeRepoUrl(u: string): string | undefined {
  const m = [...u.matchAll(GH)][0];
  if (!m || IGNORE_OWNERS.has(m[1].toLowerCase())) return undefined;
  return `https://github.com/${m[1]}/${m[2].replace(/\.git$|[.,;)]+$/g, '')}`;
}

async function getJson(url: string): Promise<any> {
  try { const r = await fetch(url, { headers: { 'User-Agent': 'paper-code-analyzer', Accept: 'application/json' } }); return r.ok ? await r.json() : undefined; } catch { return undefined; }
}

/** Returns candidate repo URLs, best first, with source labels. */
export async function findRepo(paperText: string, arxivId?: string, title?: string): Promise<{ url: string; source: string }[]> {
  const out: { url: string; source: string }[] = [];
  const add = (u: string | undefined, s: string) => { if (u && !out.some(o => o.url.toLowerCase() === u.toLowerCase())) out.push({ url: u, source: s }); };
  // 0) project pages (*.github.io etc.) mentioned in paper -> scrape their GitHub links
  const pages = [...new Set([...paperText.matchAll(/(https?:\/\/)?([a-z0-9\-]+\.github\.io(?:\/[\w\-.\/]*)?)/gi)].map(m => 'https://' + m[2].replace(/[.\/]+$/, '')))].slice(0, 3);
  for (const pg of pages) {
    try {
      const r = await fetch(pg, { headers: { 'User-Agent': 'paper-code-analyzer' } });
      if (r.ok) for (const m of (await r.text()).matchAll(GH)) { const u = normalizeRepoUrl(m[0]); if (u && !/\.github\.io$/i.test(u)) add(u, 'project page ' + pg); }
    } catch { /* ignore */ }
  }
  // 1) links in paper text (handle line-broken URLs)
  const joined = paperText.replace(/github\.\s*com/g, 'github.com').replace(/github\.com\/\s*/g, 'github.com/');
  for (const m of joined.matchAll(GH)) add(normalizeRepoUrl(m[0]), 'paper text');
  if (arxivId) {
    const hf = await getJson(`https://huggingface.co/api/papers/${arxivId}`);
    if (hf?.githubRepo) add(normalizeRepoUrl(hf.githubRepo), 'Hugging Face Papers');
    const pwc = await getJson(`https://paperswithcode.com/api/v1/papers/?arxiv_id=${arxivId}`);
    const pid = pwc?.results?.[0]?.id;
    if (pid) { const repos = await getJson(`https://paperswithcode.com/api/v1/papers/${pid}/repositories/`); for (const r of repos?.results || []) add(normalizeRepoUrl(r.url), 'Papers with Code'); }
  }
  if (out.length < 3 && (title || arxivId)) {
    const q = encodeURIComponent(arxivId ? `${arxivId} in:readme` : `${title} in:readme,description`);
    const gh = await getJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&per_page=3`);
    for (const it of gh?.items || []) add(it.html_url, 'GitHub search');
  }
  return out;
}

export function cloneRepo(url: string, outDir: string): Promise<string> {
  const name = url.replace(/\/$/, '').split('/').slice(-2).join('__');
  const dest = path.join(outDir, name);
  if (fs.existsSync(path.join(dest, '.git'))) return Promise.resolve(dest);
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((res, rej) => execFile('git', ['clone', '--depth', '1', url, dest], { maxBuffer: 16 << 20 }, e => e ? rej(new Error('git clone 失败: ' + e.message)) : res(dest)));
}

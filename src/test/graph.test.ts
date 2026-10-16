import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeRepo, outline } from '../staticAnalysis';
import { buildStaticGraph, buildLlmGraph } from '../graph';
import { chatStream } from '../llmStream';
import { retrieveChunks } from '../retrieve';

const root = process.argv[2] || '/tmp/pca-test/repos/tonyzhaozh__act';
const FAKE_JSON = '```json\n' + JSON.stringify({
  nodes: [
    { id: 'img', label: '多相机图像', kind: 'io' }, { id: 'qpos', label: '关节位置 qpos', kind: 'io' },
    { id: 'DETRVAE', label: 'DETRVAE', kind: 'module', file: 'detr/models/detr_vae.py', line: 34 },
    { id: 'Backbone', label: 'ResNet18 Backbone', kind: 'module', parent: 'DETRVAE', file: 'detr/models/backbone.py', line: 80 },
    { id: 'enc', label: 'CVAE Encoder', kind: 'layer', parent: 'DETRVAE', file: 'detr/models/detr_vae.py', line: 90 },
    { id: 'Transformer', label: 'Transformer', kind: 'module', parent: 'DETRVAE', file: 'detr/models/transformer.py', line: 20 },
    { id: 'head', label: 'action_head', kind: 'layer', parent: 'DETRVAE', file: 'detr/models/detr_vae.py', line: 52 },
    { id: 'out', label: '动作序列', kind: 'io' }, { id: 'bad', label: 'x', kind: 'weird', parent: 'nonexistent' }],
  edges: [{ source: 'img', target: 'Backbone', shape: '[B, N_cam, 3, 480, 640]' }, { source: 'Backbone', target: 'Transformer', shape: '[B, 512, 15, 20N]' },
    { source: 'qpos', target: 'enc', shape: '[B, 14]' }, { source: 'enc', target: 'Transformer', shape: 'z [B, 32]' }, { source: 'Transformer', target: 'head', shape: '[B, k, 512]' },
    { source: 'head', target: 'out', shape: '[B, k, 14]' }, { source: 'head', target: 'ghost' }],
  shapeFlow: [{ step: 1, name: '动作编码', op: 'self.encoder_action_proj(actions)', file: 'detr/models/detr_vae.py', line: 90, input: '[B, k, 14]', output: '[B, k, 512]' },
    { step: 2, name: '拼接CLS', op: 'torch.cat([cls, qpos, action])', file: 'detr/models/detr_vae.py', line: 95, input: '[B,1,512]+[B,1,512]+[B,k,512]', output: '[B, k+2, 512]' }],
}) + '\n```';

const srv = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => {
  const body = JSON.parse(b);
  if (body.stream) { r.setHeader('content-type', 'text/event-stream'); for (const t of ['DETRVAE', ' 的', ' 输出 ', '[B, k, 14]']) r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`); r.end('data: [DONE]\n\n'); return; }
  r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ choices: [{ message: { content: FAKE_JSON } }] }));
}); }).listen(8788, async () => {
  const cfg = { baseUrl: 'http://localhost:8788/v1', model: 'fake', apiKey: 'x' };
  const repo = analyzeRepo(root);
  const st = buildStaticGraph(repo);
  console.log('STATIC graph:', st.nodes.length, 'nodes', st.edges.length, 'edges; composition edges:', st.edges.map(e => `${e.source}->${e.target}`).join(', '));
  const ol = repo.files.slice(0, 10).map(outline).join('\n\n');
  const g = await buildLlmGraph(cfg, repo, ol, 'code md', 'zh', 24000);
  console.log('LLM graph source=', g.source, 'nodes', g.nodes.length, 'edges', g.edges.length, '(ghost edge dropped:', !g.edges.some(e => e.target === 'ghost'), ') bad parent cleared:', g.nodes.find(n => n.id === 'bad')?.parent === undefined, 'shapeFlow', g.shapeFlow.length);
  let streamed = ''; const full = await chatStream(cfg, [{ role: 'user', content: 'hi' }], t => streamed += t);
  console.log('STREAM ok:', full === streamed, JSON.stringify(full));
  const rc = retrieveChunks(root, repo.files.map(f => f.rel), 'encoder_action_proj latent_proj 维度', 2);
  console.log('RETRIEVE top chunk file:', rc[0]?.split('\n')[0]);
  fs.mkdirSync('/tmp/pca-test', { recursive: true });
  fs.writeFileSync('/tmp/pca-test/graph_llm.json', JSON.stringify(g, null, 1));
  fs.writeFileSync('/tmp/pca-test/graph_static.json', JSON.stringify(st, null, 1));
  srv.close();
});

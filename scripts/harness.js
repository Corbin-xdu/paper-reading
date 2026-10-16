// Builds a standalone HTML using the bundled media (no CDN) to smoke-test the report webview in headless Chrome.
const fs=require('fs');const tab=process.argv[2]||'graph';const g=JSON.parse(fs.readFileSync(process.argv[3]||'/tmp/pca-test/graph_llm.json','utf8'));
const report={paper:'## 方法\n公式 $$L = L_{rec} + \\beta D_{KL}$$ 以及 $z\\in R^{32}$\n```mermaid\nflowchart TD\n A["图像"] --> B["ResNet"]\n B --> C["Transformer"]\n```',code:'## 代码\n[detr_vae.py#L78](detr/models/detr_vae.py#L78)',mapping:'## 对照\n|论文|代码|\n|-|-|\n|CVAE|[x](detr/models/detr_vae.py#L90)|',staticOutline:'outline'};
const m='file://'+process.cwd()+'/media/';
const v=['marked.min.js','mermaid.min.js','katex.min.js','auto-render.min.js','cytoscape.min.js','dagre.min.js','cytoscape-dagre.js'];
fs.writeFileSync('/tmp/pca-test/harness_'+tab+'.html',`<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${m}vendor/katex.min.css"><link rel="stylesheet" href="${m}style.css"></head><body class="vscode-light" style="background:#fff">
<nav>${['paper','code','mapping','graph','shape'].map(x=>`<button data-v="${x}">${x}</button>`).join('')}</nav><div id="c"></div>
<script type="application/json" id="data">${JSON.stringify({report,graph:g,initialTab:tab}).replace(/</g,'\\u003c')}</script>
<script>window.onerror=(e)=>document.title='ERR '+e;window.acquireVsCodeApi=()=>({postMessage:m=>console.log('POST',JSON.stringify(m)),setState(){},getState(){}});</script>
${v.map(s=>`<script src="${m}vendor/${s}"></script>`).join('')}<script src="${m}common.js"></script><script src="${m}report.js"></script>
<script>setTimeout(()=>{document.body.setAttribute('data-ok',document.title.startsWith('ERR')?document.title:'OK nodes='+document.querySelectorAll('canvas').length+' svg='+document.querySelectorAll('svg').length+' katex='+document.querySelectorAll('.katex').length+' steps='+document.querySelectorAll('.step').length)},2500)</script></body></html>`);

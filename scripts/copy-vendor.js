const fs=require('fs'),path=require('path');const d='media/vendor';fs.mkdirSync(d+'/fonts',{recursive:true});
const files={'cytoscape/dist/cytoscape.min.js':'cytoscape.min.js','dagre/dist/dagre.min.js':'dagre.min.js','cytoscape-dagre/cytoscape-dagre.js':'cytoscape-dagre.js','marked/marked.min.js':'marked.min.js','mermaid/dist/mermaid.min.js':'mermaid.min.js','katex/dist/katex.min.js':'katex.min.js','katex/dist/katex.min.css':'katex.min.css','katex/dist/contrib/auto-render.min.js':'auto-render.min.js'};
for(const[s,t]of Object.entries(files))fs.copyFileSync(path.join('node_modules',s),path.join(d,t));
for(const f of fs.readdirSync('node_modules/katex/dist/fonts'))if(f.endsWith('.woff2'))fs.copyFileSync('node_modules/katex/dist/fonts/'+f,d+'/fonts/'+f);
console.log('vendor copied');

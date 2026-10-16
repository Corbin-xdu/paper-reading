(function () {
  const D = JSON.parse(document.getElementById('data').textContent);
  const { md, post, openCode, vscode, dark } = PCA;
  const c = document.getElementById('c');
  let cy;
  async function show(v, h) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    vscode.setState({ v });
    if (v === 'graph') return graph();
    if (v === 'shape') return shapeFlow();
    if (v === 'side') c.innerHTML = '<div class="cols"><div>' + md(D.report.paper) + '</div><div>' + md(D.report.code) + '</div></div>';
    else if (v === 'outline') c.innerHTML = '<pre>' + (D.report.staticOutline || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
    else c.innerHTML = md(D.report[v]);
    await post(c);
    if (h != null) { const hs = c.querySelectorAll('h2'); if (hs[h]) hs[h].scrollIntoView(); } else window.scrollTo(0, 0);
  }
  function graph() {
    const G = D.graph;
    if (!G || !G.nodes.length) { c.innerHTML = '<p>没有架构图数据（未分析代码）。</p>'; return; }
    c.innerHTML = `<div class="toolbar"><button id="fit">适应窗口</button><button id="exp">全部展开</button><button id="col">全部折叠</button><button id="dir">方向 ↕/↔</button><input id="q" placeholder="搜索节点…"><span class="loc">来源: ${G.source === 'llm' ? 'LLM+静态分析' : '静态分析'} · 单击跳转代码 · 双击模块展开/折叠 · 滚轮缩放 · 拖拽平移</span></div><div id="cy"></div><div id="tip"></div>`;
    const fg = dark ? '#ddd' : '#222';
    const colors = { module: '#4e79a7', layer: '#59a14f', op: '#f28e2b', tensor: '#b07aa1', io: '#e15759' };
    const els = G.nodes.map(n => ({ data: { ...n, parent: n.parent, bg: colors[n.kind] || '#888' } }))
      .concat(G.edges.map((e, i) => ({ data: { id: 'e' + i, source: e.source, target: e.target, lbl: [e.shape, e.label].filter(Boolean).join('\n') } })));
    let rankDir = 'TB';
    cy = cytoscape({ container: document.getElementById('cy'), elements: els, wheelSensitivity: 0.25,
      style: [
        { selector: 'node', style: { label: 'data(label)', 'background-color': 'data(bg)', color: fg, 'font-size': 11, 'text-valign': 'center', 'text-halign': 'center', shape: 'round-rectangle', width: 'label', height: 26, padding: 8, 'text-wrap': 'wrap', 'text-max-width': 220, 'background-opacity': .35, 'border-width': 1, 'border-color': 'data(bg)' } },
        { selector: ':parent', style: { 'text-valign': 'top', 'font-weight': 'bold', 'background-opacity': .07, padding: 14 } },
        { selector: 'node.collapsed', style: { 'border-style': 'double', 'border-width': 4 } },
        { selector: 'node[kind="io"]', style: { shape: 'ellipse' } },
        { selector: 'edge', style: { 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', width: 1.5, 'line-color': '#999', 'target-arrow-color': '#999', label: 'data(lbl)', 'font-size': 9, color: fg, 'text-wrap': 'wrap', 'text-background-color': dark ? '#1e1e1e' : '#fff', 'text-background-opacity': .85, 'text-background-padding': 2 } },
        { selector: '.hl', style: { 'border-width': 3, 'border-color': '#ff0', 'line-color': '#fc0', 'target-arrow-color': '#fc0' } },
        { selector: '.hidden', style: { display: 'none' } }]
    });
    const layout = () => cy.layout({ name: 'dagre', rankDir, nodeSep: 30, rankSep: 50, animate: false }).run();
    layout();
    const collapsed = new Set();
    function toggle(n, force) {
      const kids = n.descendants(); if (!kids.length) return false;
      const col = force ?? !collapsed.has(n.id());
      if (col) { collapsed.add(n.id()); kids.addClass('hidden'); n.addClass('collapsed'); } else { collapsed.delete(n.id()); kids.removeClass('hidden'); n.removeClass('collapsed'); }
      return true;
    }
    let lastTap = 0;
    cy.on('tap', 'node', ev => {
      const n = ev.target; const now = Date.now();
      if (now - lastTap < 300) { if (toggle(n)) layout(); lastTap = 0; return; }
      lastTap = now; const d = n.data();
      setTimeout(() => { if (lastTap === now && d.file) openCode(d.file, d.line); }, 310);
    });
    const tip = document.getElementById('tip');
    cy.on('mouseover', 'node', ev => { const d = ev.target.data(); tip.innerHTML = `<b>${d.label}</b><br>${d.desc || ''}<br><span class="loc">${d.file ? d.file + ':' + (d.line || '') : ''}</span>`; tip.style.display = 'block'; });
    cy.on('mousemove', ev => { const e = ev.originalEvent; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; });
    cy.on('mouseout', 'node', () => tip.style.display = 'none');
    document.getElementById('fit').onclick = () => cy.fit(undefined, 20);
    document.getElementById('exp').onclick = () => { cy.nodes(':parent').forEach(n => toggle(n, false)); layout(); };
    document.getElementById('col').onclick = () => { cy.nodes(':parent').forEach(n => toggle(n, true)); layout(); };
    document.getElementById('dir').onclick = () => { rankDir = rankDir === 'TB' ? 'LR' : 'TB'; layout(); };
    document.getElementById('q').oninput = e => { const q = e.target.value.toLowerCase(); cy.elements().removeClass('hl'); if (q) cy.nodes().filter(n => (n.data('label') + '').toLowerCase().includes(q)).addClass('hl'); };
  }
  function shapeFlow() {
    const S = (D.graph && D.graph.shapeFlow) || [];
    if (!S.length) { c.innerHTML = '<p>没有张量形状流数据。</p>'; return; }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    c.innerHTML = '<div class="flow">' + S.map((s, i) => `${i ? '<div class="arrow">⬇</div>' : ''}<div class="step" data-f="${esc(s.file)}" data-l="${s.line || ''}"><div class="num">${s.step}</div><div><b>${esc(s.name)}</b> <span class="loc">${s.file ? esc(s.file) + ':' + (s.line || '') : ''}</span><div class="shapes"><span class="shape">${esc(s.input)}</span> → <span class="shape">${esc(s.output)}</span></div><div class="op">${esc(s.op)}</div>${s.note ? '<div class="note">' + esc(s.note) + '</div>' : ''}</div></div>`).join('') + '</div>';
    c.querySelectorAll('.step').forEach(el => el.onclick = () => el.dataset.f && openCode(el.dataset.f, el.dataset.l));
  }
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.v));
  window.addEventListener('message', e => { if (e.data.type === 'show') show(e.data.tab, e.data.h); });
  show(D.initialTab || (vscode.getState() || {}).v || 'mapping', D.initialH);
})();

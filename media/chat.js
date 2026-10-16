(function () {
  const { md, post, vscode } = PCA;
  const log = document.getElementById('log'), inp = document.getElementById('in'), title = document.getElementById('title');
  const PRESETS = [
    ['形状流', '从原始输入一直到损失，按前向顺序列出张量形状。用表格：步骤 | 代码位置 | 操作 | 输入形状 | 输出形状。每行都要有文件#L行号。维度不知道就写符号，并说明它来自哪个超参或论文公式。论文和代码都没写的数，标成材料未给出。'],
    ['公式对照', '把论文里的关键公式和代码逐条对照。每条分开写：公式（用 $...$）、论文在说什么、对应的类和函数（文件#L行号）、代码和论文哪里不一致。不要编行号。'],
    ['模块职责', '列出主干里每个模块的职责、子模块、构造参数的默认值，以及它对应论文的哪一节或哪条公式。每一项都给文件#L行号。材料里没有默认值就写未给出。'],
    ['损失训练', '损失由哪些项组成、权重是多少、在哪个函数里加总？训练入口、优化器、学习率和关键默认超参是什么？每项给代码位置。论文没写或代码对不上的地方单独列出来。'],
    ['实现差异', '哪些实现细节论文没写，但代码里实际在做？例如归一化位置、mask、padding、数据增强、形状重排、损失权重。按对结果的影响从大到小，每条给文件#L行号。'],
  ];
  const presets = document.getElementById('presets');
  let cur = null, buf = '';
  function add(role, text) { const d = document.createElement('div'); d.className = 'msg ' + role; d.innerHTML = role === 'user' ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;') : md(text); log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
  function send(text) {
    const t = (text == null ? inp.value : text).trim();
    if (!t || cur) return;
    add('user', t); inp.value = ''; buf = ''; cur = add('assistant', '…');
    vscode.postMessage({ type: 'ask', text: t });
  }
  PRESETS.forEach(([label, text]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = text;
    b.onclick = () => send(text);
    presets.appendChild(b);
  });
  document.getElementById('send').onclick = () => send();
  document.getElementById('stop').onclick = () => vscode.postMessage({ type: 'stop' });
  document.getElementById('clear').onclick = () => { log.innerHTML = ''; vscode.postMessage({ type: 'clear' }); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  let pending = false;
  window.addEventListener('message', async e => {
    const m = e.data;
    if (m.type === 'paper') { title.textContent = m.title ? '当前: ' + m.title : '未选择论文（先在上方列表中打开一篇）'; log.innerHTML = ''; }
    if (m.type === 'delta' && cur) { buf += m.text; if (!pending) { pending = true; requestAnimationFrame(() => { cur.innerHTML = md(buf); log.scrollTop = log.scrollHeight; pending = false; }); } }
    if (m.type === 'done' && cur) { cur.innerHTML = md(buf || m.text || ''); await post(cur); cur = null; }
    if (m.type === 'error') { if (cur) { cur.innerHTML = '<span style="color:var(--vscode-errorForeground)">' + m.text + '</span>'; cur = null; } }
  });
  vscode.postMessage({ type: 'ready' });
})();

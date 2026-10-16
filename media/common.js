/* shared: markdown + mermaid + katex rendering, code-link handling */
window.PCA = (function () {
  const vscode = acquireVsCodeApi();
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
  const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  // marked 会把 \( \[ 当成转义，公式必须在解析前挪走，否则 KaTeX 只剩裸的 \mathbb。
  const LATEX_CMD = /\\(?:mathbb|mathrm|mathbf|mathcal|mathsf|text|textrm|frac|dfrac|sqrt|sum|prod|tilde|hat|bar|vec|overline|underline|operatorname|left|right|alpha|beta|gamma|delta|epsilon|varepsilon|sigma|mu|lambda|theta|phi|psi|omega|partial|nabla|infty|times|cdot|ldots|cdots|dots|in|mapsto|quad|qquad)(?![a-zA-Z])/g;
  function park(list, m) { list.push(m); return '@@M' + (list.length - 1) + '@@'; }
  function consumeLatex(s, i) {
    let j = i, depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' || c === '|' || c === '`') break;
      if (c === '{') { depth++; j++; continue; }
      if (c === '}') { if (!depth) break; depth--; j++; continue; }
      if (c === '\\') { j++; if (j < s.length && s[j] !== '\n') j++; continue; }
      if (c === ' ') {
        if (depth > 0) { j++; continue; }
        const n = s[j + 1];
        if (n === '\\' || n === '{' || n === '^' || n === '_' || n === '(') { j++; continue; }
        break;
      }
      if (/[A-Za-z0-9_^=+\-*/().]/.test(c)) { j++; continue; }
      break;
    }
    const raw = s.slice(i, j).replace(/\s+$/, '');
    if (raw.length < 4 || !/[_^{]/.test(raw)) return null;
    return { raw, end: i + raw.length };
  }
  function shieldMath(src) {
    const math = [];
    const code = [];
    let s = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, m => { code.push(m); return '@@C' + (code.length - 1) + '@@'; });
    const keep = m => park(math, m);
    s = s.replace(/\$\$[\s\S]+?\$\$/g, keep);
    s = s.replace(/\\\[[\s\S]+?\\\]/g, keep);
    s = s.replace(/\\\([\s\S]+?\\\)/g, keep);
    s = s.replace(/(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$/g, keep);
    let out = '', from = 0, m;
    LATEX_CMD.lastIndex = 0;
    while ((m = LATEX_CMD.exec(s))) {
      const hit = consumeLatex(s, m.index);
      if (!hit) continue;
      out += s.slice(from, m.index) + keep('\\(' + hit.raw + '\\)');
      from = hit.end;
      LATEX_CMD.lastIndex = hit.end;
    }
    s = out + s.slice(from);
    s = s.replace(/@@C(\d+)@@/g, (_, i) => code[+i]);
    return { s, math };
  }
  function md(s) {
    const shielded = shieldMath(s || '');
    let h = marked.parse(shielded.s);
    h = h.replace(/@@M(\d+)@@/g, (_, i) => shielded.math[+i].replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    return h.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (m, c) => '<pre class="mermaid">' + c + '</pre>');
  }
  async function post(el) {
    try { renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false }); } catch (e) { }
    const ms = el.querySelectorAll('pre.mermaid:not([data-processed])');
    for (const m of ms) { try { await mermaid.run({ nodes: [m] }); } catch (e) { m.classList.add('mermaid-err'); m.title = String(e); } }
  }
  function openCode(file, line) { vscode.postMessage({ type: 'open', file, line: +(line || 1) }); }
  document.addEventListener('click', e => {
    const a = e.target.closest('a'); if (!a) return; const h = a.getAttribute('href') || '';
    if (/^https?:/.test(h)) return; e.preventDefault();
    const m = h.match(/^([^#]+?\.\w+)(?:#L(\d+))?$/); if (m) openCode(decodeURIComponent(m[1]), m[2]);
  });
  return { vscode, md, post, openCode, dark };
})();

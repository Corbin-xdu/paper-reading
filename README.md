# Paper Code Analyzer（论文 ↔ 代码对照解析）

面向 AI / 具身智能研究的 VS Code 插件：输入论文（arXiv ID/链接/PDF），自动下载论文与代码，调用 LLM 深度解析论文与代码，并生成**论文-代码对照报告**（架构图、数据流、逐步张量维度变化、可点击跳转源码行）。

## 安装
```bash
code --install-extension paper-code-analyzer-0.2.7.vsix
```
或在 VS Code 扩展面板 `...` → “从 VSIX 安装…”。需要本机安装 `git`。

## 配置
默认直接调用本机已经登录的 Grok（`grok` 命令，凭证在配置目录里），不用再填 API Key。请先在终端确认 `grok login` 已完成，并且 `grok models` 能列出模型。改完下面的设置后执行 **Developer: Reload Window**。

设置中搜索 `paperCode`：
   - `paperCode.provider`：`grok`（默认）或 `openai`
   - `paperCode.grokHome`：Grok 配置目录（`GROK_HOME`）。留空是 `%USERPROFILE%\.grok`。也可以填 `config.toml` 的完整路径
   - `paperCode.grokPath`：`grok.exe` 路径。留空先找配置目录下的 `bin`，再找用户目录里的 `~/.grok/bin/grok`
   - `paperCode.model`：默认 `grok-4.7-build-fast`。openai 模式下改成该接口的模型名
   - `paperCode.reasoningEffort`：三个分析会话的思考深度。`config` 沿用 `config.toml` 的 `models.default_reasoning_effort`；其余为 `none` / `minimal` / `low`（默认）/ `medium` / `high` / `xhigh` / `max`
   - `paperCode.chatReasoningEffort`：侧边栏问答的思考深度，默认 `low`，和分析分开
   - `paperCode.subagents`：分析会话能否派子代理，默认开。问答始终不开
   - `paperCode.webSearch`：分析会话能否联网，默认关。问答始终不联网
   - `paperCode.agentTurns`：每个分析会话最多多少轮，默认 30
   - `paperCode.baseUrl`：仅 openai 模式，默认 `https://api.openai.com/v1`
   - openai 模式才需要命令面板里的 **Set API Key**（保存在 VS Code SecretStorage，不写入文件）
   - `paperCode.language`：`zh`（默认）/ `en`
   - `paperCode.maxChunkChars`：openai 模式单次发送字符数（默认 24000）
   - `paperCode.maxCodeFiles`：优先深入阅读的 Python 文件数（默认 25，子代理仍可再打开别的文件）
   - `paperCode.outputDir`：输出目录（默认工作区下 `paper-analysis/`）

## 使用
1. 打开一个文件夹作为工作区。
2. 运行 **Analyze Paper + Code (解析论文+代码)**。
3. 输入论文，如 `2304.13705` 或 `https://arxiv.org/abs/2304.13705`；代码仓库可留空。
4. 留空时插件会自动查找仓库（论文中的项目主页 → 论文正文 GitHub 链接 → Hugging Face Papers / Papers with Code → GitHub 搜索），弹出候选供选择，然后 `git clone --depth 1`。
5. 等待分析。本机 Grok 会同时开论文会话和代码会话，输出面板能看到它们在读哪些文件、有没有派子代理；两边结束后再开综合会话写对照和架构图。可取消。

## 输出
- `paper-analysis/papers/`：PDF 与提取文本
- `paper-analysis/repos/`：克隆的代码
- `paper-analysis/<arxivId>_report.md`：Markdown 报告
- Webview 报告，标签页：论文解析 / 代码解析 / 论文↔代码对照 / 并排视图 / 静态大纲；Mermaid 架构图、LaTeX 公式；点击 `file.py#L行号` 链接在右侧打开对应源码行。

## 侧边栏（v0.2）
左侧活动栏出现 **论文代码解析** 图标（类似 labuladong 刷题插件的独立侧边栏）：
- **已解析论文**（树视图）：每篇论文下有
  - 论文解析：按章节列出，点击跳到报告对应章节
  - 代码模块：所有 `nn.Module` 类，点击直接打开源码对应行
  - 论文 ↔ 代码对照：按章节跳转
  - 模型架构图 / 张量形状流 / Markdown 报告
  - 标题栏 `+` 新建解析、刷新；右键：打开架构图、从列表移除
- **问答 Chat**（侧边栏 Webview）：先打开一篇报告再问。输入框上方有预设（形状流、公式对照、模块职责、损失训练、实现差异）。回答要求先给结论，形状用表格，代码带行号；材料里没有的数会标成未给出。中文问题没有英文标识符时，仍会附上排名靠前的模型源码。Enter 发送，Shift+Enter 换行，可停止/清空。

## 模型架构图与张量形状流（v0.2）
- 插件先用静态分析生成模块组成图，再让 LLM 输出**严格 JSON**（nodes / edges / shapeFlow），校验后渲染；LLM 失败时退回静态图。
- **模型架构图**：Cytoscape + dagre 交互式图，滚轮缩放、拖拽平移、**双击模块展开/折叠子模块**、**单击节点跳转源码**、搜索高亮、切换横/纵方向；每条边上标注张量形状。
- **张量形状流**：按前向执行顺序列出每一步「输入形状 → 输出形状」、操作表达式和代码位置，点击跳转；同时写入 Markdown 报告表格。
- marked / mermaid / KaTeX / cytoscape / dagre 全部打包在插件内，**离线可用**，不再依赖 CDN。

## 分析内容
- **论文**：分块阅读 → 问题与动机、贡献、架构（含图）、逐模块输入输出维度、公式与损失、训练/推理、实验、局限。
- **代码**：静态分析 Python（`nn.Module` 类、子模块、`forward`、`view/reshape/permute/cat/einsum` 等维度操作及形状注释、argparse 参数、配置文件），按重要性排序文件、分块带行号送入 LLM；输出仓库结构、入口、架构图、模块设计、**数据从输入到输出的逐步形状变化表**、损失与训练循环、推理流程。
- **对照**：论文章节/公式/模块 ↔ 代码文件函数（带行号）对照表、逐条解释、论文未写的实现细节、复现建议。

## 已知限制
- 静态分析基于正则，非完整 Python AST；张量形状由 LLM 根据代码与注释推断，未实际运行代码，请对照源码核验。
- 仅深度分析 Python；超大仓库只读排名前 N 个文件。
- 架构图节点/边/形状来自 LLM，已做结构校验（丢弃不存在的节点引用），但数值正确性需对照代码核验。
- 问答检索仅按英文标识符关键词匹配（中文问题请带上类名/函数名效果更好）。
- Papers with Code API 已基本停服，自动找仓库主要依赖项目主页与论文文本；找不到时请手动填写 GitHub 链接。
- 本机 Grok 一次解析开三个会话：论文、代码同时读（默认可以派子代理，可在设置里关掉），然后综合会话写对照和架构图。聊天框仍是单次问答，不改仓库、不联网。
- 三个分析会话可以读文件，不能改文件、不能跑命令。

## 开发
```bash
npm install
npm run compile        # 复制前端依赖到 media/vendor 并编译
npm run test:core      # 下载 arXiv 论文+克隆仓库+静态分析（需联网）
npm run test:graph     # 假 LLM 测试结构化图/流式/检索
npx vsce package --allow-missing-repository
```

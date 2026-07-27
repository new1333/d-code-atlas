# Source 对所有 Agent 只读，靠 --allowedTools 强制

取源策略：Git 仓库 → `git clone --depth 1` 到 `work/source/`；本地路径 → 原地直读，不复制（省空间）。但无论哪种，所有分析类 Agent（Surveyor / Architect / Critic / Reader）一律以只读模式调起：`claude -p --allowedTools Read,Glob,Grep`，且只把产出写到 `work/` 或 `site/`。这样"不污染源仓库"从意图变成强制不变量——Agent 想写也写不进 Source。Producer（Writer/Assembler）需要写时，写的是 `work/chapters/{slug}/` 或 `site/`，从不写 Source。不靠"它应该不会写"的假设。

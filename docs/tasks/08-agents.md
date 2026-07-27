# M08 · agents

> 6 类 Agent 的 `claude -p` 封装：拼 user prompt → 调 run-claude → 返回结果 + cmd。
> 对应 design §3（agents/）、§5（角色清单）、§2（执行模型）。

## 依赖
- M02 lib-run-claude
- M07 prompts
- M01 lib-io（产物路径）

## 子任务（每个文件 `src/agents/{role}.ts`）

- [ ] `surveyor.ts`：`surveyor({key, sourceKind, sourcePath})` → 读 Source → 产 `work/repo-map.json`。tools=readonly。
- [ ] `architect.ts`：`architect({key})` → 读 repo-map + Source → 产 `work/outline.json`（**不含 topoOrder**，由 stage 调 topoSort 注入）。tools=readonly。
- [ ] `critic.ts`：`critic({key, mode: "outline"|"chapter", slug?})` → 读对应草稿 → 返回结构化 `{verdict, fixes?}`（供 stage 编排评审循环）。tools=readonly。
- [ ] `reader.ts`：`reader({key, slug})` → 读 outline[ch].sourceFiles + Source → 产 `work/chapters/{slug}/research.md`。tools=readonly。
- [ ] `writer.ts`：`writer({key, slug})` → 读 research.md + outline → 产 `draft.md` + `replica/*.ts|js`。tools=write，cwd=`work/chapters/{slug}/`。
- [ ] `assembler.ts`：`assembler({key})` → 读 outline + 各 draft → 产 `site/`。tools=write，cwd=`site/`。
- [ ] 每个 agent 的 user prompt 拼接：明确告知「读哪些文件、写到哪、验收标准」；system prompt 指向对应 `prompts/{role}.md`。
- [ ] 每个 agent 返回 `{result: ClaudeResult, cmd: string}` 供 manifest 记录。

## Done 标准
- 6 类 agent 可被独立调用（用一个小样本 run 目录手动触发）。
- 只读 agent 的 cmd 必含 `--allowedTools Read,Glob,Grep`；写入类 agent 的 cwd 被限定在 `work/chapters/{slug}/` 或 `site/`，物理上无法写 Source（AC-7）。
- Critic 输出可被结构化解析（verdict ∈ approve/reject）。

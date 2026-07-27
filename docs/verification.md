# 验收手册 · Code Atlas v1

> 对应 [`requirements.md`](./requirements.md) §7 的 AC-1 ~ AC-7。每条给出**核验命令**与**期望结果**，可逐条对照。

约定：以下示例假设用本地仓库 `/path/to/repo` 跑了一次 Run，key 为 `repo`。URL 路径把 `/path/to/repo` 换成 `https://github.com/o/r` 即可。

---

## AC-1（端到端 · URL）

> 给定公开 GitHub URL，`atlas run <url>` 完成后 `atlas/{repo}/site/` 存在，且 `cd atlas/{repo}/site && bun install && bun run docs:build` 成功产出 `dist/`。

```bash
bun run src/bin/atlas.ts run https://github.com/owner/repo
# 期望：最后输出 "[atlas] run repo complete."

cd atlas/repo/site
bun install
bun run docs:build
# 期望：成功，产出 atlas/repo/site/.vitepress/dist/
ls .vitepress/dist/index.html   # 期望：文件存在
```

---

## AC-2（端到端 · 本地）

> 给定本地路径，生成同样结构；分析前后对该目录**逐字节不变**。

```bash
# 记录分析前的目录树与内容哈希
find /path/to/repo -type f | sort > /tmp/before.txt
( cd /path/to/repo && git status ) > /tmp/git-before.txt 2>&1 || true

bun run src/bin/atlas.ts run /path/to/repo

# 分析后再次记录，比对
find /path/to/repo -type f | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt                          # 期望：无差异
( cd /path/to/repo && git status ) > /tmp/git-after.txt 2>&1 || true
diff /tmp/git-before.txt /tmp/git-after.txt                  # 期望：无差异（含 git index 不变）
```

> 引擎对本地源采用**复制到 `work/source/`**（不原地写）。源目录内容应完全不变。

---

## AC-3（续跑）

> 在 Research 阶段中断后 `atlas resume <key>`，Survey/Outline 不重跑，从中断处继续。

```bash
# 1. 跑一次，等 Research 开始后 Ctrl-C 中断（或 kill 进程）
bun run src/bin/atlas.ts run /path/to/repo
# 观察：survey done、outline done、research 跑到一半被中断

# 2. 查看状态：survey/outline 仍是 done
bun run src/bin/atlas.ts show repo
# 期望：survey=done, outline=done, research=running/failed（部分章节 done）

# 3. 续跑
bun run src/bin/atlas.ts resume repo
# 期望日志：不重新执行 survey/outline；research 从未 done 的章节继续
```

---

## AC-4（自底向上）

> 生成的 `guide/` 章节顺序满足 `outline.json` 的 `dependsOn` 拓扑序（无环、依赖闭包在前）。

```bash
# 用引擎自带的 topo 单测核验算法正确性
bun test test/topo.test.ts

# 核验本次 Run 的 outline 无环、闭包满足：
bun -e '
  const o = await Bun.file("atlas/repo/work/outline.json").json();
  const { topoSort, verifyClosure } = await import("./src/lib/topo.ts");
  const r = topoSort(o.chapters.map(c => ({ slug: c.slug, dependsOn: c.dependsOn })));
  console.log("hasCycle:", r.hasCycle, "(expect false)");
  console.log("danglingRefs:", r.danglingRefs, "(expect [])");
  console.log("recomputed topo === outline.topoOrder:", JSON.stringify(r.order) === JSON.stringify(o.topoOrder));
  console.log("closure ok:", verifyClosure(o.topoOrder, o.chapters.map(c => ({ slug: c.slug, dependsOn: c.dependsOn }))).ok, "(expect true)");
'

# 核验 site/guide/ 文件名编号 == topo 序号
ls atlas/repo/site/guide/   # 期望：01-xxx.md, 02-yyy.md, ... 按 topo 顺序
```

---

## AC-5（复刻代码）

> 每章 `draft.md` 含至少一段 ts/js 代码块；`work/chapters/{slug}/replica/` 有对应可运行文件。

```bash
for slug in $(bun -e 'const o=await Bun.file("atlas/repo/work/outline.json").json();console.log(o.chapters.map(c=>c.slug).join(" "))'); do
  draft="atlas/repo/work/chapters/$slug/draft.md"
  replica="atlas/repo/work/chapters/$slug/replica"
  codeblocks=$(grep -c '```' "$draft" 2>/dev/null || echo 0)
  replicas=$(ls "$replica" 2>/dev/null | wc -l)
  echo "$slug: code-fence-markers=$codeblocks, replica-files=$replicas"
  # 期望：code-fence-markers ≥ 2（至少一个完整代码块），replica-files ≥ 1
done
```

---

## AC-6（对抗评审）

> manifest 中 Outline 与每章 Write 的评审记录可查；存在 reject 时 draft 有对应修订。

```bash
bun run src/bin/atlas.ts show repo
# 期望：outline 行带 [review: approve|accepted-with-warning, Nr]
#       每章 write 行带 [review: ...]

# 直接看 manifest 里的评审 trace
bun -e '
  const m = await Bun.file("atlas/repo/manifest.json").json();
  console.log("outline review:", JSON.stringify(m.stages.outline.review, null, 2));
  for (const [slug, c] of Object.entries(m.chapters)) {
    console.log(slug, "write review:", JSON.stringify(c.write.review));
  }
'
# 期望：每条 review 有 rounds、final、trace（含每轮 verdict + fixes）
```

---

## AC-7（只读）

> 所有分析 Agent 的 `claude -p` 命令均带 `--allowedTools Read,Glob,Grep`（manifest 可核验）。

```bash
bun -e '
  const m = await Bun.file("atlas/repo/manifest.json").json();
  const checks = [];
  // analysis stages: survey, outline (architect + critic)
  for (const stage of ["survey", "outline"]) {
    const cmd = m.stages[stage]?.cmd || "";
    checks.push([stage, cmd.includes("--allowedTools Read,Glob,Grep")]);
  }
  // chapter research (read-only reader)
  for (const [slug, c] of Object.entries(m.chapters)) {
    const cmd = c.research?.cmd || "";
    checks.push([slug+"/research", cmd.includes("--allowedTools Read,Glob,Grep")]);
  }
  for (const [name, ok] of checks) console.log(ok ? "PASS" : "FAIL", name);
  console.log("all read-only:", checks.every(([_, ok]) => ok));
'
# 期望：全部 PASS（分析类 agent 命令均带只读工具集）
```

> 说明：写入类 Agent（Writer/Assembler）的工具集是 `Read,Glob,Grep,Write,Edit`，但其 cwd 被限制在 `work/chapters/{slug}/` 或 `site/`，物理上无法写 Source（ADR-0005）。

---

## 全量一键自检（可选）

把上述打包成一个脚本，逐条输出 PASS/FAIL 汇总——可作为发布前的回归门。

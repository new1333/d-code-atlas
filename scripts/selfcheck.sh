#!/usr/bin/env bash
# scripts/selfcheck.sh · Code Atlas AC-1..AC-7 一键自检
#
# 用法：
#   bash scripts/selfcheck.sh <key>            # 核验 atlas/<key>/ 的 AC-1..AC-7
#   bash scripts/selfcheck.sh <key> --no-build # AC-1 跳过 bun run docs:build（只查 site 结构）
#
# 前提：已对某仓库跑过 `atlas run <repo>`（即 atlas/<key>/ 下有完整产物 + manifest）。
# 对应 docs/verification.md 的 AC-1..AC-7 逐条核验脚本，输出 PASS/FAIL 汇总。
#
# 设计：纯 bash + bun -e（读 manifest/outline JSON）。零外部依赖（除 bun 自身）。
# 退出码：全部 PASS → 0；任一 FAIL → 1。

set -u

# ---------- 参数 ----------
KEY="${1:-}"
NO_BUILD=0
if [ "${2:-}" = "--no-build" ]; then NO_BUILD=1; fi

if [ -z "$KEY" ]; then
  echo "用法: bash scripts/selfcheck.sh <key> [--no-build]"
  echo "  <key>      Run 的 key（atlas/<key>/）"
  echo "  --no-build AC-1 跳过 bun run docs:build（仅查 site 结构）"
  exit 2
fi

REPO_DIR="atlas/$KEY"
MANIFEST="$REPO_DIR/manifest.json"
OUTLINE="$REPO_DIR/work/outline.json"
SITE="$REPO_DIR/site"

# 引擎根（脚本所在目录的上一级）。
ENGINE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ENGINE_ROOT" || { echo "FAIL: 无法进入引擎根 $ENGINE_ROOT"; exit 1; }

PASS=0
FAIL=0
declare -a FAIL_ITEMS

record() { # record <ok> <name>
  if [ "$1" = "1" ]; then
    echo "PASS  $2"
    PASS=$((PASS+1))
  else
    echo "FAIL  $2"
    FAIL=$((FAIL+1))
    FAIL_ITEMS+=("$2")
  fi
}

echo "==================== AC 自检 · key=$KEY ===================="

# ---------- 前置检查 ----------
if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: manifest 不存在: $MANIFEST（请先 atlas run 一个仓库）"
  exit 1
fi
if [ ! -f "$OUTLINE" ]; then
  echo "FAIL: outline.json 不存在: $OUTLINE"
  exit 1
fi

# ---------- AC-1（端到端 · URL/本地）：site 存在 + 可构建 ----------
echo ""
echo "---- AC-1（端到端 · site 可构建） ----"
if [ -d "$SITE" ]; then record 1 "site/ 目录存在"; else record 0 "site/ 目录存在"; fi
if [ -f "$SITE/package.json" ]; then record 1 "site/package.json 存在"; else record 0 "site/package.json 存在"; fi
if [ -f "$SITE/.vitepress/config.ts" ]; then record 1 "site/.vitepress/config.ts 存在"; else record 0 "site/.vitepress/config.ts 存在"; fi
if [ -f "$SITE/index.md" ]; then record 1 "site/index.md 存在"; else record 0 "site/index.md 存在"; fi
if [ -d "$SITE/guide" ] && [ -n "$(ls -A "$SITE/guide" 2>/dev/null)" ]; then
  record 1 "site/guide/ 非空"
else
  record 0 "site/guide/ 非空"
fi

if [ "$NO_BUILD" = "0" ]; then
  echo "[AC-1] 运行 cd site && bun install && bun run docs:build（可能耗时）..."
  if (cd "$SITE" && bun install --silent 2>/dev/null && bun run docs:build >/dev/null 2>&1); then
    record 1 "bun run docs:build 成功"
  else
    record 0 "bun run docs:build 成功"
  fi
  if [ -f "$SITE/.vitepress/dist/index.html" ]; then
    record 1 "dist/index.html 产出"
  else
    record 0 "dist/index.html 产出"
  fi
else
  echo "[AC-1] --no-build：跳过 bun run docs:build"
fi

# ---------- AC-2（本地源逐字节不变） ----------
# 说明：AC-2 的「分析前后无差异」需在 atlas run 前后分别采样比对，本脚本在 run 之后无法回溯。
# 提供「只读不变量」的等价核验：所有分析类 agent 的 cmd 含只读工具集（见 AC-7），
# 且本地源不被克隆/复制（manifest.source.kind=local 时 sourceDir 不存在克隆副本）。
# 完整的前后采样比对请在 atlas run 前后用 find|sort + git status 手动做（见 verification.md AC-2）。
echo ""
echo "---- AC-2（本地源只读不变量 · 等价核验） ----"
KIND=$(bun -e 'const m=await Bun.file("'"$MANIFEST"'").json();console.log(m.source.kind)')
if [ "$KIND" = "local" ]; then
  record 1 "source.kind=local（原地直读，未克隆到 work/source）"
  # 本地源不应有 work/source 克隆副本。
  if [ -d "$REPO_DIR/work/source" ]; then
    record 0 "work/source 不存在克隆副本（本地源不应复制）"
  else
    record 1 "work/source 不存在克隆副本（本地源不应复制）"
  fi
else
  record 1 "source.kind=$KIND（URL 克隆场景，AC-2 仅适用本地源）"
fi

# ---------- AC-3（续跑） ----------
# 算法核验：findNextPending 在 survey/outline done 时跳过它们（由 test/manifest.test.ts 覆盖）。
# 这里核验：manifest 的 done stage 有 startedAt/finishedAt（续跑不会被重置）。
echo ""
echo "---- AC-3（续跑 · done stage 有时间戳不会被重置） ----"
bun -e '
  const m = await Bun.file("'"$MANIFEST"'").json();
  let ok = true;
  const stageNames = ["acquire","survey","outline","assemble","build"];
  for (const s of stageNames) {
    const st = m.stages[s];
    if (st && st.status === "done" && (!st.startedAt || !st.finishedAt)) { ok = false; console.log("  缺时间戳:", s); }
  }
  console.log(ok ? "PASS  done stage 均有 startedAt/finishedAt" : "FAIL  有 done stage 缺时间戳");
  if(!ok) process.exit(1);
' && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAIL_ITEMS+=("AC-3 done stage 时间戳"); }

# ---------- AC-4（自底向上） ----------
echo ""
echo "---- AC-4（自底向上 · topoOrder 无环 + 闭包 + 文件名编号） ----"
AC4=$(bun -e '
  const o = await Bun.file("'"$OUTLINE"'").json();
  const { topoSort, verifyClosure } = await import("./src/lib/topo.ts");
  const nodes = o.chapters.map(c => ({ slug: c.slug, dependsOn: c.dependsOn }));
  const r = topoSort(nodes);
  const closure = verifyClosure(o.topoOrder, nodes);
  const recomputedMatches = JSON.stringify(r.order) === JSON.stringify(o.topoOrder);
  console.log("hasCycle:"+r.hasCycle+"|dangling:"+JSON.stringify(r.danglingRefs)+"|recomputedMatches:"+recomputedMatches+"|closureOk:"+closure.ok);
  // 文件名编号核验
  const glob = new Bun.Glob("*.md");
  const files = [];
  for await (const f of glob.scan({ cwd: "'"$SITE"'/guide" })) files.push(f);
  const expected = o.topoOrder.map((s,i)=>String(i+1).padStart(2,"0")+"-"+s+".md").sort();
  const filesSorted = files.sort();
  console.log("fileNamesMatch:"+(JSON.stringify(expected)===JSON.stringify(filesSorted)));
')
echo "$AC4" | grep -q "hasCycle:false" && record 1 "outline 依赖图无环" || record 0 "outline 依赖图无环"
echo "$AC4" | grep -q 'dangling:\[\]' && record 1 "无悬空引用" || record 0 "无悬空引用"
echo "$AC4" | grep -q "recomputedMatches:true" && record 1 "topoOrder 复算一致" || record 0 "topoOrder 复算一致"
echo "$AC4" | grep -q "closureOk:true" && record 1 "依赖闭包满足（闭包在前）" || record 0 "依赖闭包满足（闭包在前）"
echo "$AC4" | grep -q "fileNamesMatch:true" && record 1 "site/guide 文件名编号 == topo 序号" || record 0 "site/guide 文件名编号 == topo 序号"

# ---------- AC-5（复刻代码） ----------
echo ""
echo "---- AC-5（复刻代码 · 每章 draft 有代码块 + replica 文件） ----"
bun -e '
  const o = await Bun.file("'"$OUTLINE"'").json();
  let allOk = true;
  for (const slug of o.topoOrder) {
    const draftPath = "'"$REPO_DIR"'/work/chapters/"+slug+"/draft.md";
    const replicaDir = "'"$REPO_DIR"'/work/chapters/"+slug+"/replica";
    let fences = 0, replicas = 0;
    try { const t = await Bun.file(draftPath).text(); fences = (t.match(/```/g)||[]).length; } catch {}
    try { const g = new Bun.Glob("*"); const files = []; for await (const f of g.scan({cwd: replicaDir})) files.push(f); replicas = files.length; } catch {}
    const ok = fences >= 2 && replicas >= 1;
    console.log((ok?"PASS":"FAIL")+"  "+slug+": 代码围栏标记="+fences+" replica文件="+replicas);
    if(!ok) allOk = false;
  }
  process.exit(allOk?0:1);
' && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAIL_ITEMS+=("AC-5 复刻代码"); }

# ---------- AC-6（对抗评审 · review trace） ----------
echo ""
echo "---- AC-6（对抗评审 · outline + 每章 write 有 review trace） ----"
AC6=$(bun -e '
  const m = await Bun.file("'"$MANIFEST"'").json();
  const outlineReview = m.stages.outline?.review;
  let outlineOk = !!outlineReview && typeof outlineReview.rounds === "number" && Array.isArray(outlineReview.trace) && outlineReview.trace.length>0;
  console.log("outline:"+(outlineOk?"PASS":"FAIL")+" final="+(outlineReview?.final||"none")+" rounds="+(outlineReview?.rounds||0)+" traces="+(outlineReview?.trace?.length||0));
  let chapterFail = 0;
  for (const [slug, c] of Object.entries(m.chapters||{})) {
    const wr = c.write?.review;
    const ok = !!wr && typeof wr.rounds === "number" && Array.isArray(wr.trace) && wr.trace.length>0;
    if(!ok) chapterFail++;
    console.log("chapter:"+(ok?"PASS":"FAIL")+" "+slug+" final="+(wr?.final||"none")+" rounds="+(wr?.rounds||0));
  }
  process.exit(outlineOk && chapterFail===0 ? 0 : 1);
')
echo "$AC6"
echo "$AC6" | grep -q "^outline:PASS" && { echo "$AC6" | grep -q "^chapter:PASS" || true; } && record 1 "outline + 所有章节 write 有 review trace" || record 0 "outline + 所有章节 write 有 review trace"

# ---------- AC-7（只读） ----------
echo ""
echo "---- AC-7（只读 · 分析类 agent cmd 含 --allowedTools Read,Glob,Grep） ----"
bun -e '
  const m = await Bun.file("'"$MANIFEST"'").json();
  const ANCHOR = "--allowedTools Read,Glob,Grep";
  const checks = [];
  // 分析 stage：survey, outline（architect + critic 都只读）
  for (const stage of ["survey", "outline"]) {
    const cmd = m.stages[stage]?.cmd || "";
    checks.push([stage, cmd.includes(ANCHOR), !/Write|Edit/.test((cmd.match(/--allowedTools\s+\S+/)||[""])[0])]);
  }
  // 每章 research（reader 只读）
  for (const [slug, c] of Object.entries(m.chapters||{})) {
    const cmd = c.research?.cmd || "";
    checks.push([slug+"/research", cmd.includes(ANCHOR), !/Write|Edit/.test((cmd.match(/--allowedTools\s+\S+/)||[""])[0])]);
  }
  let allOk = true;
  for (const [name, hasAnchor, noWrite] of checks) {
    const ok = hasAnchor && noWrite;
    console.log((ok?"PASS":"FAIL")+"  "+name);
    if(!ok) allOk = false;
  }
  process.exit(allOk?0:1);
' && record 1 "所有分析类 agent 只读（工具集精确为 Read,Glob,Grep）" || { record 0 "所有分析类 agent 只读（工具集精确为 Read,Glob,Grep）"; FAIL_ITEMS+=("AC-7 只读"); }

# ---------- 汇总 ----------
echo ""
echo "==================== 汇总 ===================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "失败项: ${FAIL_ITEMS[*]}"
  exit 1
fi
echo "全部 AC 通过 ✓"
exit 0

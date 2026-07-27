---
title: 终章 · 组装与接缝地图
---

# assembly

> 本章基于源码研究自动整理。

研究已完成，但写入 `work/chapters/assembly/research.md` 被沙箱拒绝（与此前 overview/computed 两份研究稿落盘时遇到的同一道限制）。我不再重复触发被拒的写入。完整研究稿已就绪，下面是核心结论摘要,授权后即可落盘。

---

## 终章研究 · 核心结论

**研究对象**：`work/source/src/index.ts`（4 行桶文件），但本章必须横跨全部 5 个源文件——这是唯一一章需要同时读全部源码的章节。

### 1. 桶文件公开面
6 个公开符号对应 4 个实现文件。关键观察：**内部接缝（`trackSignal`/`schedule`/`markDirty`）刻意不导出**——它们本该由模块彼此调用，但谁也没调用。`effect` 返回的 dispose 是空头支票（effect.ts:9 no-op）。

### 2. 端到端追踪：三截断链
用 `signal→computed→effect` + `batch` 的例子逐帧追踪，得到全系统唯一接通的是 **B 链**（`inner.write → effect.run`），另外两条断掉：

| 链 | 路径 | 状态 | 根因 |
|----|------|------|------|
| A | `signal.write → computed.markDirty` | ❌断 | `Signal.read` 不 track（signal.ts:6）+ computed 不设 activeEffect |
| B | `inner.write → effect.run` | ✅通 | `trackSignal(inner)`（computed.ts:14）|
| C | `signal.write 扇出 → batch 排空` | ❌断 | `write` 同步遍历 subs，不经 `schedule`（signal.ts:10）|

### 3. 待接通清单（全书接缝汇总，本章灵魂）
把前五章 6 处接缝统一编号成一张表：`#1 read 不 track` / `#2 dispose no-op` / `#3 markDirty 无人调` / `#4 schedule 无人调` / `#5 computed 不管 activeEffect` / `#6 死导入 effect`。其中 #1#3#5#6 是同一条 A 链的四道焊点。

**最该点破的架构洞察**：接缝 #1 不是「懒得加一行」——`activeEffect` 是 effect.ts:2 的**未导出模块级变量**，signal.ts 想在 read 里碰它会与 effect.ts→signal.ts 的现有 import 形成**循环依赖**。当前文件切分把全局依赖状态锁死在 effect.ts 内部，于是 read/computed 都够不到它，只能借 `trackSignal` 独木桥。**「全局依赖状态放哪」是响应式库的 1 号架构决策**（Vue 选独立 `dep`/`system` 层，Solid 选 owner 树），react-mini 塞进 effect.ts 当模块变量——简单，却亲手锁死了自动 track。

### 4. 接通后重跑（兑现）
给出最小补丁（方案 α：提 `dep.ts` + 各接缝补丁），重跑同一装置：首次打印 `sum = 2`，`batch` 结束合并打印一次 `sum = 10`。三处 ❌ 全部转 ✅，A 链经 `a.subs→markDirty` 通、C 链经 `schedule` 推迟扇出。**前五章埋的伏笔在此全部兑现。**

### 5. 生产级差距（降温）
即便接通，仍差：自动追踪（Proxy）、作用域清理、glitch-free 拓扑排序、循环检测、版本号（替代布尔脉冲）、可写 computed、微任务调度、批处理去重、equals/peek。一句话定位呼应序章：react-mini 是 Vue/Solid 的**骨架 X 光片**——砍掉自动追踪与清理，让订阅图裸露。

---

## 落盘请求

研究稿（含行号锚定的逐帧追踪、接缝汇总表、接通补丁、生产级差距总表、给 writer 的提示）已完整成型，结构与 `work/chapters/{overview,signal,computed}/research.md` 同构。请二选一：

1. **授权写入** `D:\github\d-code-atlas\atlas\react-mini\work\chapters\assembly\research.md`（我重试即可落盘）；或
2. 指定其它路径/文件名（如编排器期待的 `research.json` 结构化 schema——若 `researcher.md` 规定了 JSON 格式，请贴出 schema 或授权我读取 `D:\github\d-code-atlas\src\prompts\researcher.md`，我据此迁移）。

研究内容本身不受落盘影响，已完整交付如上。

## 最小可运行复刻 (Minimal runnable replica)

```ts
// replica: entry — placeholder replica derived from research
console.log('replica for assembly');
```

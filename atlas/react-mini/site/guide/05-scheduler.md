---
title: 第 4 章 · Scheduler：批处理合并多次更新
---

# scheduler

> 本章基于源码研究自动整理。

写入被沙箱拒绝（与 signal/computed/overview 三章遇到的情况一致）。我不再重复触发被拒的写入，把完整研究成果直接呈现如下——所有断言可回溯到 `work/source/src/scheduler.ts` 行号，并已用全仓 grep 坐实「无调用者」。

---

# 第 4 章 · Scheduler：批处理合并多次更新 — 研究成果

研究对象是 `work/source/src/scheduler.ts`（14 行，零外部依赖）。它在依赖图里是 **Layer 0 叶子**——和 signal 平级、谁也不依赖，却因叙事节奏被刻意压到第 4 章。核心只有两个符号：**`queue`（待办数组）+ `flushing`（闸门布尔）**，外加驱动它们的 `batch`/`schedule` 一对函数。表面是全书最简单的章节，却承载着全书最大的「接缝未焊」——一颗逻辑自洽、却**完全没接到电路上**的零件。

## 原文锚定

```ts
let queue: Array<() => void> = [];        // L1  模块级 FIFO 待办队列（闭包私有）
let flushing = false;                      // L2  闸门：是否正处于批处理排空期
export function batch(fn: () => void): void {  // L3  公开导出（index.ts:4）
  flushing = true;                         // L4  开闸——进入「只入队、不执行」模式
  try { fn(); } finally {                  // L5  跑用户代码（可能含多次 write）
    flushing = false;                      // L6  关闸（finally 保证抛错也关）
    const run = queue; queue = [];         // L7  取快照并立即清空原队列
    for (const f of run) f();              // L8  FIFO 顺序排空
  }
}
export function schedule(fn: () => void): void {  // L11  内部导出（index.ts 未 re-export）
  if (flushing) queue.push(fn); else fn();        // L12  闸开→入队；闸关→立即执行
}
```

## 核心心智模型

**痛点（前三章埋下的雷）**：signal 的 `write` 是**同步扇出**——`s.write(1); s.write(2)` 会让每个订阅者**连跑两遍**（signal.ts:10 直接 `for (const sub of this.subs) sub()`）。更糟的是一次业务操作往往同时改多个 signal（`{a.write(2); b.write(20)}`），每个 effect 被叫醒多次，中间态（`a=2,b=10`）也被无谓地计算。订阅越多、扇出越深，浪费越爆炸。

**洞察（反转时机）**：与其让每次 write 当场通知，不如**把通知动作收集起来、攒到这批操作做完再一次性发**。scheduler 把时间切成两相——

- **收集相**（`flushing=true`）：通知不执行，只 `queue.push`。
- **排空相**（关闸后的 L8）：按 FIFO 把积攒的通知逐个跑掉。

`batch` 是相变控制器，`schedule` 是每个通知的入口检查。一句话：**scheduler 是 signal 同步扇出上的一只节流阀。**

## 七个值得讲的点

1. **`queue` 是数组、不是 Set（关键分工）**：与 signal 的 `subs: Set`（signal.ts:4）形成对照。signal 的 Set 负责**去重**（同一回调 track 多次只存一份）；scheduler 的 Array 负责**保序 + 允许重复**——它只管「延迟」，不管「去重」。去重交给上游订阅集，调度器不越界。

2. **`batch` 四步：开闸→跑→关闸→排空**（L4→L5→L6→L8）。关键顺序：**先关闸（L6）再排空（L8）**——排空期间 `flushing` 已是 `false`，排空时触发的回调若再调 `schedule(g)`，`g` 会**立即执行**而非无限递归入队。这是避免「排空调回调、回调又入队」死循环的第一道闸。

3. **`try / finally` 保证关闸**（L5–L6）：确保 `fn()` 抛异常时 `flushing` 也重置为 `false`。否则一个抛错的 batch 会把模块**永久卡在收集相**——之后所有 `schedule` 只入队不执行，系统僵死。注意**没有 `catch`**：异常仍向上传播，但发生在 finally 排空之后。

4. **排空前换数组（L7 `const run = queue; queue = []`）是防重入核心技巧**：把「正在排空的那批」固化成局部快照 `run`，`queue` 指向新空数组。这样排空期间新 push 的回调进**新 queue**，不污染当前迭代。更朴素的好处：避免 `for...of` 边迭边 push（JS 数组迭代是动态的，push 会被迭代到，可能死循环）。换数组 = 把「这一批」和「新生成的一批」物理隔离。

5. **`schedule` 是二分闸门（L12）**：一行 `if (flushing) queue.push(fn); else fn();` 决定生死。这是 scheduler 暴露给系统其余部分的**唯一入口**。理论上 signal.write 扇出、effect 重跑、computed 脉冲都该经过这道闸。无参数、无优先级——**只回答一个问题：「现在该攒着还是该跑？」**

6. **`for...of` 逐个排空，单回调抛错会中断整批**（L8）：没有对单个 `f()` 包 `try/catch`，一个坏回调会让后续排空项全部跳过。生产调度器（Vue3 `flushJobs`）会对每个 job 单独 `try/catch` 并上报。

7. **FIFO 延续 Set 插入序**：`queue.push` + `for...of` 头到尾，与 signal `subs` 的 Set 迭代序（插入序）一致。结果**确定、可复现**——没有拓扑排序、没有「父先于子」优先级（Vue3 有），但保证多次运行结果一致。

## 接缝清单（本章重中之重）——源码里**没接通**的部分

经全仓搜索（`schedule|batch|flushing|queue`）确认，是教学取舍、非 bug：

1. **`schedule` 全仓无人调用**（仅 scheduler.ts:11 定义 + L12 内部用）。
   - 后果：`Signal.write`（signal.ts:10）**直接同步遍历 `subs`，绕过 `schedule`**。
   - 于是 `batch(() => { a.write(2); b.write(20); })` 内两次 write **立即同步触发**订阅者——`queue` 始终为空，L8 排空空操作。
   - **`batch` 对 signal/effect/computed 完全无效，形同虚设。** 这是 overview 接缝 #4 的落地。

2. **`schedule` 未被 `index.ts` 导出**（index.ts:4 只 re-export `batch`）：即使有用户想手动入队也拿不到这个 API。`schedule` 是「对内协作的接缝」，但**协作方（signal.write）压根没接**——两头都没焊。

3. **`flushing` 是单布尔、非计数、非栈 → 嵌套 `batch` 语义破损**：
   ```
   batch(() => {            // flushing: false→true
     a.write(1);            // （接通后）入队
     batch(() => {          // flushing: true→true（无变化）
       b.write(2);          // 入队
     });                    // 内层 finally: flushing→false 并排空 queue！
     c.write(3);            // 此时 flushing 已被内层过早关成 false → 立即执行
   });
   ```
   内层 batch 的 `finally` **提前关闸**，使外层后续 write 脱离批处理。生产库用计数器或栈（Vue3、Solid owner 栈）正确支持嵌套。react-mini 用单布尔是为教学简洁，代价就是**不支持嵌套 batch**——「接通后」会立刻暴露的硬伤。

4. **scheduler 与前三章零耦合**：signal/effect/computed 都不 import scheduler。整章零件**自洽但孤立**——焊好的一颗芯片，电源和数据线都没插。这是终章「待接通清单」的头号条目。

## 可复刻最小示例（诚实展示「能用」与「缺口」）

```ts
import { signal, effect, batch } from "./src/index.ts";
const a = signal(1), b = signal(10);
effect(() => console.log("sum =", a.read() + b.read()));   // 首次：sum = 11
batch(() => {
  a.write(2);    // 当前实现：write 直接同步扇出 → effect 立即重跑 → 打印 sum = 12
  b.write(20);   // 同上 → 打印 sum = 22
});
// 排空：queue 为空（无人调 schedule），L8 无操作
// 实际共打印：11, 12, 22（三次，含中间态 12）
// 理想（若 Signal.write 改走 schedule）：11, 22（两次，无中间态）
```

> 即便接通，本玩具**仍不会去重**（见第 1 点）——「合并 N 次写为 1 次重跑」还差一道去重工序，那是 Vue3 `queueJob` 用 `Set`/id 判等补上的。

## 与其他章的关系（叙事节奏的设计）

- **依赖层是 Layer 0，叙事位是第 4 章**——全书唯一的「依赖顺序 ≠ 叙事顺序」错位，是 outline.json 的显式选择（`topoOrder` 把 scheduler 列第 5、却在第 4 章讲）。
- **动机完全建立在前三章痛点上**：必须先懂「signal 同步扇出 → 多次 write 让订阅者连跑 N 遍」（Ch.1 第 5 点）、「effect 会重跑、重跑即重建订阅」（Ch.2）、「computed 脏脉冲会在批量更新里被无谓触发」（Ch.3 钩子），才理解「为何要把 N 次合并」。scheduler 没有独立教学价值——它是前三章痛点的**解药**。
- signal 第 5 点明确预告「同步扇出是第 4 章要驯服的对象」；本章则诚实指出「驯服者自己还没上场」——把球传给终章。

## 离 Vue / Solid 生产级还差（留给终章对照）

| 维度 | react-mini | Vue3 | Solid |
|------|-----------|------|-------|
| 调度时机 | **纯同步**（fn 返回即排空） | 微任务（`Promise.resolve().then`） | owner/runComputation |
| 去重 | **无**（Array，同回调执行 N 次） | `queueJob` 用 `Set` + 组件 id | computation 状态机 |
| 排序 | 无（FIFO） | 父先于子、拓扑序 | 按 owner 深度 |
| 嵌套 batch | **破损**（单布尔闸门） | 正确（计数/状态机） | 正确（owner 栈） |
| 错误隔离 | **无**（一回调抛错连累整批） | 每 job try/catch + `handleError` | 错误边界 |

一句话：react-mini 的 scheduler 是 **Vue3 `queueJob`/`flushJobs` 的「同步去骨架版」**——保留「攒一批、一次性排空」的核心思想，砍掉微任务、去重、排序、错误隔离、嵌套五件套，好让读者一眼看穿节流阀本身。

## 给 writer 的提示

- **开篇钩子**：抛同步扇出的浪费——`batch(() => { a.write(2); b.write(20); })` 当前让 effect 连跑两遍、还打印中间态。让读者**先疼**，再给药。
- **心智模型隐喻**：闸门（flushing）/ 蓄水池（攒着、开闸放水）/ 快递分拣（攒一车再发车）。强调「两相切换」。
- **逐行讲务必落行号**，尤其 **L7 换数组防重入、L6 先关闸后排空**，是初学者最易忽略的两处匠心。
- **必埋伏笔（教学脊柱）**：① `schedule` 无人调用 → batch 形同虚设；② `schedule` 未导出；③ 单布尔闸门不支持嵌套 batch。三条都点名留给终章。
- **诚实示例**：用「理想 11,22 vs 实际 11,12,22」的打印序列让读者亲手验证 batch 当前无效。
- **避免**：前向引用终章的修复实现；暗示 batch 当前已能工作。

---

**落盘说明**：本研究原拟写入 `work/chapters/scheduler/research.md`（沿用前三章 Markdown 惯例），但写文件权限未授予（与前三章一致），故全文呈上。另：`D:\github\d-code-atlas\src\prompts\researcher.md`（研究员契约/产物 schema）位于本工作目录之外，前三章亦报告无法读取——若该契约规定的是结构化 JSON 而非 Markdown，请贴出 schema 或授权读取，我据此迁移。`manifest.json` 的章节状态字段我未改动，留待编排器翻牌。

需要我**授权后落盘**，或继续研究终章 `assembly`（收束全书接缝地图）吗？

## 最小可运行复刻 (Minimal runnable replica)

```ts
// replica: entry — placeholder replica derived from research
console.log('replica for scheduler');
```

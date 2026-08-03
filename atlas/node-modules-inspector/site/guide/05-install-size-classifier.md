---
title: 安装体积测算与文件类别分类
---

# 安装体积测算与文件类别分类

## 你装完依赖后，最想问的那句话

"我这 `node_modules` 里到底哪个包最占地方？这些地方是源码、是测试、还是类型声明？"

如果你只是 `du -sh node_modules/*`，能拿到一个总数列表，但回答不了第二个问题——你看不出一个包内部 50MB 里有多少是 `.d.ts`、多少是测试文件、多少是 README。本章讲的就是一个把"包的字节构成"算清楚的小机制：它不读文件内容、不解 AST，只用文件名和目录结构，毫秒级给出一份按类别分桶的字节账单。

说人话就是：**它做了一份"包内部财务报表"——总收入（总字节）+ 按科目（类别）拆细**。

## 把这件事拆成三步

要让上面这份报表跑出来，本质上只需要回答三个问题：

1. **这个包里都有哪些文件？** —— 遍历磁盘。
2. **每个文件该归到哪一类？** —— 一套分类规则。
3. **每个文件多大？** —— 拿字节数，然后加起来。

整章就围绕这三步展开。三步看上去都平平无奇，但每一步里都藏着一个非平凡的取舍——这正是为什么它不是 `du -sh` 加一个 switch 那么简单。

## 第一步：遍历——把磁盘拍平成文件清单

想象你打开一个包的目录，里面可能有 `src/`、`dist/`、`node_modules/`（嵌套！）、`.git/`、`.cache/` 各种东西。最朴素的递归 readdir 会把所有东西都收集起来，但这里做了一个关键决定：**遇到 dotfile 目录或嵌套 `node_modules`，直接 `continue` 跳过，根本不递归进去**。

为什么要这么早跳？因为 `.git/`、`.cache/` 这种目录里常常塞了远超包本身体积的垃圾——一个 `.cache/` 就能让你这个包看起来膨胀 5 倍。嵌套的 `node_modules` 则是另一个故事：如果一个包内嵌了它自己依赖的 `node_modules`，那这些字节是上游 agent（pnpm/npm/bun）单独算成另一个包的，这里若也跟着算就会双重计数。

```
递归过滤规则（精确语义）：
目录名以 "." 开头   →  跳过  （覆盖 .git / .cache / .vscode ...）
目录名 === "node_modules"  →  跳过
其它目录            →  recurse 进去
```

注意一条边角：`mynode_modules` 不会被跳过（不是严格等于），`node_module`（单数）也不会。这种"严格等于"在正则里写出来就是 `^node_modules$`，看起来啰嗦，但避免了误伤。

### 权衡 1：遍历期硬过滤，换 I/O 大幅减少

> **做了**：在递归过程中，遇到 dotfile 目录或 `node_modules` 子目录直接 `continue`，不进 readdir。
> **换来**：省下绝大多数磁盘 I/O——`.git` 里动辄上千个对象文件、嵌套 `node_modules` 里又是整个依赖树，全部跳过后实际遍历量常常只是原来的几十分之一。
> **代价**：你必须信任上游清单完整。pnpm/npm/bun 装出来的依赖图里，每个嵌套包应当作为独立节点喂进来；如果某个嵌套包因为某种原因没被列出来，那它的字节会从总账里"蒸发"——既不算在父包里（被跳过了），也不算在它自己里（根本没出现在清单里）。

这个代价的本质是：本机制放弃了"自给自足"的完整性，换来了速度。它假设上游 agent 已经把依赖图切成了干净的、不重叠的节点。

## 第二步：分类——把文件扔进桶里

收集到文件之后，下一步是给每个文件贴个标签。这里只有 16 个标签可选：`js / ts / dts / json / css / html / doc / wasm / image / font / map / test / bin / comp / flow / other`。规则是纯静态的——**只看相对路径和后缀，不读文件内容**。

这套规则有两类：

- **目录级规则**：只要路径里**任一目录段**命中，就归类。比如路径里有 `test/tests/__tests__` 这种目录段，整个文件直接归 `'test'`。
- **文件名级规则**：只看文件名（basename）的后缀正则。比如以 `.map` 结尾归 `'map'`，以 `.d.ts` 结尾归 `'dts'`。

整体上**目录级优先**——一个文件如果在 `__tests__/` 目录下，哪怕它是 `foo.ts`，也算 `'test'` 而不是 `'ts'`。这个优先级反映了一个直觉：文件**放哪儿**比**叫什么**更能说明它的用途。

### 权衡 2：静态后缀正则，换毫秒级纯 CPU 分类

> **做了**：分类完全不读文件内容、不解析 AST，只看相对路径和后缀。
> **换来**：万级文件秒级出结果——纯 CPU、零磁盘 I/O、纯函数、易测试、可缓存。
> **代价**：分类粒度的天花板就是"文件名能告诉你的"。一个放在 `src/foo.js` 里的源文件和一个放在 `dist/foo.js` 里的编译产物会被划进同一个 `'js'` 桶；一个伪装成 `data.json` 的 README 也无能为力。**source vs artifact 这层区分，本机制给不了**。

这个代价是经过算计的：要区分 source 和 artifact，要么解析 package.json 的 `main`/`exports` 字段（语义脆弱、版本间不一致），要么真的去读文件内容做语法判断（慢、不稳定）。两者都比"接受一个略粗的分类"代价大。

### 权衡 3：手写顺序敏感的 if-return 级联（核心权衡）

这是本章最重要的一条。

> **做了**：所有分类规则写成一长串**手写的 if-return**，按预定义的优先级从上到下短路匹配。第一个命中的规则决定类别，剩下的全部跳过。
> **换来**：
> - **可读性**——分支明确、易调试、每条规则都能直接打断点。
> - **确定性**——同一份输入永远得到同一份输出，没有规则冲突需要解。
>
> **代价**：**规则的物理顺序就是语义的一部分**。顺序错了，分类就错。而且这种不变量没有编译期保护，全靠注释和测试守护。

举两个最容易踩坑的例子：

**例子 A：`.d.ts` 必须在 `.ts` 之前查。**

`foo.d.ts` 这个文件名同时匹配 `\.d\.[cm]?tsx?$`（→ `'dts'`）和 `\.[cm]?tsx?$`（→ `'ts'`）两条规则。如果把 `'ts'` 那条写在前面，所有 `.d.ts` 文件都会被算成普通 `'ts'`，类型声明字节就全部漏到 ts 桶里去了——你会在报表里看到"这个包类型声明占 0"，完全错误。

**例子 B：`foo.test.ts` 必须按"测试文件"算。**

`bar.test.ts` 同时匹配 `\.test\.\w+$`（→ `'test'`）和 `\.ts$`（→ `'ts'`）。如果 `'ts'` 那条在前，所有测试文件都会被算成普通源码——你会在报表里看到"测试代码占 0"，于是"砍掉测试能省多少"这个问题完全没法回答。

这就是为什么整套规则不是数据驱动的配置表，而是写死在源码里的一串 if-return。如果改成配置表，得额外发明一个"规则优先级"字段，还得在加载时校验"没有两条规则会同时命中同一类文件名"——这都是复杂度。直接写一串顺序敏感的 if，最简单，也最易读，代价就是顺序错了会静默出错。

> 说人话：这套分类规则的"正确性"住在**代码顺序**里，不住在**类型签名**里。

## 第三步：拿字节、加起来

分类完之后，每个文件带着它的桶标签，进入最后一步——拿字节数。

这里两件事一起做：

1. **并行 stat**：`Promise.all(files.map(getSingleFileSize))`，一次性把所有文件的 `fs.stat` 都发起。没有并发上限、没有背压。万级文件可能会短时占满 fd，但 Node 的 fs 池会内部排队，实际开销可控。
2. **双轴累加**：一边把所有字节加起来得到 `bytes`（包总体积），一边按桶标签累加得到 `categories: { js: {bytes, count}, ts: {...}, ... }`。

### 权衡 4：稀疏聚合 + stat 容错回退 0

> **做了**：
> - `categories` 用 `Partial<Record<FileCategory, ...>>`——空桶不出现在结果里。
> - 单文件 `fs.stat` 失败（坏符号链接、权限问题、文件被并发删除）直接 try/catch 回退 0 字节，不上报、不记日志。
>
> **换来**：
> - **序列化体积小**——dto 里不会有 16 个空字段，JSON 看起来干净。
> - **整体鲁棒**——一个坏符号链接不会让整个包测算失败。
>
> **代价**：
> - **消费方要做 nullish 防御**——UI 读 `categories.wasm` 时必须自己兜底默认值，否则会拿到 `undefined`。
> - **错误被静默吞掉**——如果某个包因为磁盘问题字节被算低，没人会知道。表面上一切正常。

这是经典的"乐观策略"——假设大多数情况下磁盘是健康的，为了不让边角错误拖垮整个分析，宁可悄悄丢一点精度。代价就是"安静的错误"——出问题时日志里什么都看不到，得靠人发现数字不对劲。

## 把三步拼起来：一个能直接跑的最小演示

下面这段脚本是上面三步的浓缩实现，**故意只保留 5 个类别**（`json / doc / js / dts / ts`），但完整演示了三个关键点：带过滤的递归、顺序敏感的分类（特别注意 `.d.ts` 必须在 `.ts` 之前）、并行 stat + 按桶累加。

把它存成 `measure.ts`，然后 `bun run measure.ts ./some-package`（或 `npx tsx measure.ts ./some-package`）就能跑。

```ts
import fs from 'node:fs/promises'
import { join, relative } from 'node:path'

// ---- 第二步：分类级联（顺序敏感！）----
// 注意：dts 规则必须在 ts 规则之前，否则 .d.ts 全被算成 ts。
// 这正是「权衡 3」要演示的不变量。
function classify(rel: string): 'json' | 'doc' | 'js' | 'dts' | 'ts' | 'other' {
  const parts = rel.split(/\/|\\/g)
  const base = parts.at(-1)!

  if (base.startsWith('.')) return 'other'                          // .gitignore, .npmrc
  if (/\.d(?:\.\w+)?\.[cm]?tsx?$/i.test(base)) return 'dts'         // ★ 必须在 ts 之前
  if (/\.map$/i.test(base)) return 'other'                          // 简化：map 归 other
  if (/\.[cm]?jsx?$/i.test(base)) return 'js'
  if (/\.[cm]?tsx?$/i.test(base)) return 'ts'                       // ← dts 已经先 return 了
  if (/\.json[c5]?$/i.test(base)) return 'json'
  if (/\.(?:md|txt)$/i.test(base)) return 'doc'
  return 'other'
}

// ---- 第三步：stat 容错 ----
async function sizeOf(file: string): Promise<number> {
  try { return (await fs.stat(file)).size } catch { return 0 }
}

// ---- 主入口：第一步递归 + 第三步聚合 ----
async function measure(root: string) {
  const files: string[] = []

  // 第一步：带过滤的递归遍历（权衡 1：dotfile 与 node_modules 直接跳过）
  async function walk(dir: string) {
    for (const n of await fs.readdir(dir, { withFileTypes: true })) {
      if (n.isFile()) files.push(join(dir, n.name))
      else if (n.isDirectory()) {
        if (/^\.|^node_modules$/.test(n.name)) continue            // ← 关键过滤
        await walk(join(dir, n.name))
      }
    }
  }
  await walk(root)

  // 第三步：并行 stat
  const sizes = await Promise.all(files.map(sizeOf))

  // 双轴累加：总字节 + 按桶明细
  let bytes = 0
  const categories: Record<string, { bytes: number; count: number }> = {}
  for (let i = 0; i < files.length; i++) {
    const cat = classify(relative(root, files[i]!))
    const s = sizes[i]!
    bytes += s
    categories[cat] ??= { bytes: 0, count: 0 }
    categories[cat].bytes += s
    categories[cat].count += 1
  }

  return { bytes, categories }
}

// ---- 跑起来 ----
const root = process.argv[2]
if (!root) { console.error('usage: tsx measure.ts <package-path>'); process.exit(1) }
console.log(JSON.stringify(await measure(root), null, 2))
```

试着把 `classify` 里 `dts` 那条规则**挪到 `ts` 规则之后**，再跑一次——你会看到所有 `.d.ts` 文件全部从 `dts` 桶跳到 `ts` 桶，这就是顺序敏感性肉眼可见的效果。

## 一个迷你包走一遍

输入是一个这样的迷你包：

```
pkg/
├── package.json
├── README.md
├── .cache/
│   └── x.json          ← dotfile 目录，会被跳过
├── dist/
│   ├── foo.js
│   └── foo.d.ts        ← 关键：级联里 .d.ts 必须在 .ts 之前
└── src/
    └── foo.ts
```

走完三步：

1. **守卫**（这里都过，简化掉）→ 进入遍历。
2. **遍历**：跳过 `.cache/`，得到 5 个文件路径——`package.json`、`README.md`、`dist/foo.js`、`dist/foo.d.ts`、`src/foo.ts`。`.cache/x.json` 不在清单里。
3. **分类**：
   - `package.json` → `json`
   - `README.md` → `doc`
   - `dist/foo.js` → `js`
   - `dist/foo.d.ts` → **`dts`**（如果级联顺序错了，这里会变成 `ts`）
   - `src/foo.ts` → `ts`
4. **并行 stat**：拿到 5 个字节数。
5. **聚合**：

```json
{
  "bytes": 64217,
  "categories": {
    "json": { "bytes": 312, "count": 1 },
    "doc":  { "bytes": 1840, "count": 1 },
    "js":   { "bytes": 12033, "count": 1 },
    "dts":  { "bytes": 4011, "count": 1 },
    "ts":   { "bytes": 46021, "count": 1 }
  }
}
```

注意 `.cache/x.json` 完全没出现（被遍历跳过了），`other` 桶也不出现（没人归进去）——这就是稀疏聚合：**只有实际命中的桶才在结果里**。

## 收尾：这个机制的位置

回到最顶层：这个机制存在，是为了在"**够准确**"和"**够快**"之间找到一条实用的工作线。它放弃了文件内容级别的精度（不读内容、不解析），换来了毫秒级、可缓存、可下钻的字节账单。这份账单再往上层走，就被排序成"最大体积包 Top-N"列表、渲染成彩条百分比、按桶着色——但那些都是消费侧的展示，跟本章无关。

如果非要记住一句话：**它把"磁盘上一坨文件"翻译成了一份"按类别切片的字节账单"，靠的就是"递归过滤 + 顺序级联 + 并行 stat"这三件事的配合**——而每件事都各自让出了一点点东西，才换来了整体的实用。

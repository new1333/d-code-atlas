# 安装体积测算与文件类别分类

> 本章属于 primitive 层。前置：无（与「静态推断模块类型」并列为针对单个包的两个静态分析维度）。
> 学完你能：用一句话讲清「为什么体积测算走纯静态启发式 + 顺序级联分类」这件事的动机与代价。

## 1. 为什么需要它

上一章用静态启发式回答了「这个包是 cjs 还是 esm」，靠看 package.json 的 exports 字段，不真正加载包。本章继续走这条路，只是把镜头从「类型」拉到「体积」：装完一个 node_modules，想知道谁最胖、胖在哪。

这种问题在大型项目里很常见。一个 monorepo 装完，光 node_modules 就几个 GB；想瘦身，先得知道砍哪。最朴素的工具是 `du -sh node_modules/*`，但它给你的是一坨总数：横向比较只能看顶层包，没法下钻到包内部；想看一个包的字节构成（多少花在源码、多少花在测试、多少花在类型声明），du 完全帮不上你。

更糟的是，npm 包的内部结构五花八门。有的把所有产物堆在 dist/、源码留在 src/；有的把 .d.ts 单独发布到 dist/@types/；有的甚至会把测试代码也打进去。这些差异要靠人一个个翻目录，根本不现实。

体积分析要在「够准确」和「够快」之间找平衡。装一个大型 monorepo 可能有上千个包、每个包几千个文件；走「读文件内容判断类型」会慢到不可用，走「只看顶层 package.json」又丢失了真实字节分布。本章要讲的机制，就是在「纯静态启发式」这条约束下，给出一份可比较、可下钻、毫秒级完成的字节账单。

## 2. 核心思想

把磁盘上散落的文件，靠「先过滤、再归类、最后称重」三步压成一份稀疏的字节账单：第一道过滤决定「哪些字节算进来」，第二道级联决定「字节落到哪个桶」，第三道并行 stat 决定「字节数本身」。

这里要上升一层看到的本质是：**当「准确」必须为「速度」让路时，分类的颗粒度就被锁死在「文件名能告诉你的」这一层**——你不再有「这个 .js 是源码还是产物」这种信息，因为要回答它就得读内容。这是本章所有权衡的共同源头。

## 3. 心智模型

整个机制可以拆成三步流水线 + 一个守卫层。

**守卫层**。拿到一个包，先做 5 条早退检查：是 workspace 包？缺 name 或 version？名字以 `#` 开头？版本是 `file:/link:/workspace:` 协议？缺磁盘路径？任一命中直接返回 `undefined`，不算体积。这些是「不该进入流水线」的包。

**第一道：带过滤的递归遍历**。从包根目录开始，用 `fs.readdir` 递归；每碰到一个目录项，是普通文件就 push 进扁平数组，是子目录就 recurse 进去——但子目录名以 `.` 开头或严格等于 `node_modules` 时直接跳过。最后拿到一份扁平的绝对路径清单。

**第二道：路径相对化 + 顺序级联分类**。对每个绝对路径，先转成「相对包根」的路径（这样分类规则只关心包内结构，不关心包在磁盘哪里），再喂给一个分类函数。函数把路径拆成「目录段 + 文件名」，按一套预定义的优先级顺序依次匹配——目录级规则（test/tests/__tests__ → 'test'，bin/binary → 'bin'，dotfile 目录 → 'other'）整体优先于后缀级规则（.d.ts → 'dts'，.ts → 'ts'，.js → 'js'…），最后兜底 'other'。第一个命中的规则决定类别，剩下规则全部跳过。

**第三道：并行 stat + 双轴聚合**。用 `Promise.all` 一次性发起所有文件的 `fs.stat`（单个失败回退 0 字节）；拿到字节数组后，一边累加得到包总 bytes，一边按类别累加得到稀疏映射 categories。

输出形态是 `{ bytes, categories }` 两个字段：`bytes` 是包总字节数；`categories` 是一个稀疏映射，只列实际出现过的桶（空桶不出现），每个桶同时记字节和文件数。

## 4. 关键权衡

下面四条是这套机制的全部「为什么」。

### 在递归里直接跳过 dotfile 和嵌套 node_modules，而不是先收集再过滤

递归遍历每碰到一个目录项，立刻用 `/^\.|^node_modules$/` 检查它，命中就 `continue`，整个子树都不进去。换来的是省下绝大多数 I/O：一个典型的 npm 包可能一半字节在 `.git`/`.cache`/`.circleci` 这类 dotfile 目录里，嵌套 node_modules 又可能把整个依赖树再走一遍。代价是这套机制隐式依赖了上游清单的完整性——上游 agent（pnpm/npm/bun）必须把每个嵌套包作为独立节点喂进来，否则它的字节会从总数里蒸发，且你看不见。

这条权衡化解的本质矛盾是「**遍历性能 vs. 字节归属完整性**」——你想算得快就得早过滤，但早过滤就丢了「这个文件本来该归给哪个包」的信息。这套机制选择了「我只算根包的字节，嵌套包的字节让上游清单自己负责」，把字节归属问题外推到了上一层。任何「在遍历期过滤」的工具（ripgrep、fast-glob）都在用同样的化解方式。

### 不读文件内容，只用后缀和路径正则分类

分类的全部依据是相对路径：目录段命中 test/tests/__tests__ 就归 'test'，文件名后缀是 `.d.ts` 就归 'dts'，依此类推。换来的是万级文件秒级出结果，纯 CPU 的正则匹配，没有磁盘读。代价是分类粒度的天花板被锁死在「文件名能告诉你的」这一层：`dist/foo.js`（编译产物）和 `src/foo.js`（源码）会被划进同一个 'js' 桶，你没法靠这套机制区分 source vs artifact。

这条化解的本质矛盾是「**分类颗粒度 vs. 分类成本**」——你要更细的分类（source/artifact、minified/unminified）就得读内容、甚至解析 AST，而读内容就意味着放弃毫秒级。这套机制明确选择了「颗粒度上限 = 文件名」，让所有使用者意识到：本机制的输出只能下钻到「文件名暗示的类别」这一层，再细就不是它能给的。

### 用一长串手写 if-return，而不是配置表

分类函数把所有规则写成顺序敏感的一长串 if-return，没有用「数据驱动的规则表 + for 循环」。换来的是分支明确、断点好下、易调试——每条规则就一行，规则之间的优先级就是代码顺序本身。代价是规则顺序即语义，且没有编译期保护：「`.d.ts` 必须在 `.ts` 之前」「test 目录必须在 dotfile 目录之前」这类不变量全靠注释和测试守护；顺序写错了，所有 `.d.ts` 会被吃成 'ts'，且不会有任何报错。

这是经典的「**声明式 vs. 命令式**」权衡在分类器场景里的具体化身。本质矛盾是「规则的可读性/确定性 vs. 规则的可演化性」——配置表方便增删规则，但每条规则的优先级要靠排序字段或权重表达，调试时得多想一层间接；手写 if-return 一眼到底，但加规则要小心插入位置。这套机制选择了后者，因为分类规则一旦稳定就几乎不动，而「顺序即语义」靠一两个单元测试就能锁死。

### categories 用稀疏映射 + stat 失败回退 0

`categories` 的类型是 `Partial<Record<FileCategory, { bytes, count }>>`——空桶不出现，而不是把 16 个桶全部初始化成 `{ bytes: 0, count: 0 }`。单文件 stat 用 try/catch 包住，任何异常（broken symlink、权限、文件被并发删除）都回退为 0。换来的是 dto 没有满屏的空字段、序列化体积小、且一个坏符号链接不会让整个包测算失败。代价分两面：(a) UI 读 `categories.wasm` 时要自己兜底默认值，不能假设字段一定在；(b) 真实的磁盘问题被静默吞掉，体积可能偏低且无人知晓。

这条化解的本质矛盾是「**单点鲁棒 vs. 故障可见**」——你要让单文件失败不影响整体，就得把错误吞掉，但吞掉就意味着没人知道出过错。这是所有「批量采集 + 聚合」系统都要做的选择：fail-fast 让故障可见但脆弱，fail-safe 让整体鲁棒但藏污纳垢。本机制选择了后者，因为「算出一个偏低但能用的数字」远比「整个包算不出来」对前端体验更友好——只是要意识到，这个数字不一定准。

## 5. 最小原理演示

下面这段 TS 把上面四条权衡各演一行，可直接 `node measure.ts <pkg-path>` 跑：

```ts
import fs from 'node:fs/promises'
import { join, relative } from 'node:path'

// 顺序敏感的分类级联：目录级优先，后缀级紧随，'other' 兜底
function guess(file: string): string {
  const parts = file.split(/[/\\]/)
  const dirs = parts.slice(0, -1)
  const base = parts.at(-1)!

  // 目录级规则：进 test 目录就是 test，命中即返回
  if (dirs.some(d => /^(test|tests|__tests__)$/.test(d))) return 'test'

  // .d.ts 必须在 .ts 之前——顺序错了所有 .d.ts 都会被吃成 ts
  if (/\.d\.[cm]?tsx?$/i.test(base)) return 'dts'
  if (/\.[cm]?tsx?$/i.test(base)) return 'ts'
  if (/\.[cm]?js$/i.test(base)) return 'js'
  if (/\.json$/i.test(base)) return 'json'
  if (/\.md$/i.test(base)) return 'doc'
  return 'other'
}

async function measure(root: string) {
  const files: string[] = []

  // 带过滤的递归：dotfile 目录与嵌套 node_modules 直接 continue，整棵子树都不进
  async function walk(dir: string) {
    for (const n of await fs.readdir(dir, { withFileTypes: true })) {
      if (n.isFile()) files.push(join(dir, n.name))
      else if (n.isDirectory()) {
        if (/^\.|^node_modules$/.test(n.name)) continue
        await walk(join(dir, n.name))
      }
    }
  }
  await walk(root)

  // 并行 stat，单文件失败回退 0——稀疏聚合只记实际出现过的桶
  const sizes = await Promise.all(
    files.map(async f => {
      try { return (await fs.stat(f)).size } catch { return 0 }
    }),
  )

  let bytes = 0
  const categories: Record<string, { bytes: number; count: number }> = {}
  for (let i = 0; i < files.length; i++) {
    bytes += sizes[i]
    const t = guess(relative(root, files[i]))
    if (!categories[t]) categories[t] = { bytes: 0, count: 0 }
    categories[t].bytes += sizes[i]
    categories[t].count += 1
  }
  return { bytes, categories }
}

// 用法：node measure.ts ./node_modules/lodash
const [, , pkgPath] = process.argv
measure(pkgPath).then(r => console.log(JSON.stringify(r, null, 2)))
```

这段刻意保留了「`.d.ts` 必须在 `.ts` 之前」这条不变量作为顺演示：把这两行调换顺序跑一遍，所有 `*.d.ts` 的字节会瞬间从 dts 桶跳到 ts 桶，没有任何报错。这就是「顺序即语义、且无编译期保护」这条权衡的具象化。

## 6. 执行轨迹

拿一个具体的迷你包走一遍。磁盘上是这样的：

```
pkg/
├── package.json
├── README.md
├── dist/
│   ├── foo.js
│   └── foo.d.ts
├── src/
│   └── foo.ts
└── .cache/
    └── x.json
```

**进入守卫层**。这个包有 name、有 version、不是 workspace、版本不是 `file:/link:` 协议、有 filepath——5 条检查全过，进入流水线。

**第一道遍历**。从 pkg/ 开始递归：`package.json`、`README.md` 进数组；进 dist/，`foo.js`、`foo.d.ts` 进数组；进 src/，`foo.ts` 进数组；碰到 `.cache` 目录，名字以 `.` 开头，`continue`，整棵子树跳过。最终 files 数组里是 5 个绝对路径，`.cache/x.json` 蒸发。

**第二道分类**。对每个文件先转相对路径，再喂给 guess。
- `package.json` → 目录段为空，base 是 `package.json`，命中 `.json$` → 'json'
- `README.md` → 命中 `.md$` → 'doc'
- `dist/foo.js` → 目录段 `['dist']` 不命中 test 规则，base 是 `foo.js`，命中 `.[cm]?js$` → 'js'
- `dist/foo.d.ts` → 目录段不命中，base 是 `foo.d.ts`，**`.d.[cm]?tsx?$` 这条在 `.[cm]?tsx?$` 之前**，命中 → 'dts'。如果级联顺序写反了，这里就会落到 'ts'，且不会有任何报错。
- `src/foo.ts` → 目录段 `['src']` 不命中 test，base 是 `foo.ts`，先试 `.d.ts`（不匹配），再试 `.ts` → 'ts'

**第三道 stat + 聚合**。`Promise.all` 并行发起 5 个 stat，假设字节数依次是 [200, 1800, 8400, 400, 1900]（package.json / README / foo.js / foo.d.ts / foo.ts）。bytes 累加得 12700。categories 各桶：json=200、doc=1800、js=8400、dts=400、ts=1900。

**输出**：`{ bytes: 12700, categories: { json: {bytes:200,count:1}, doc: {…}, js: {…}, dts: {…}, ts: {…} } }`。`.cache/x.json` 因为被遍历跳过所以不出现；`other` 桶也空，因为没人归进去——稀疏映射的真实形态。

## 7. 教学简化说明

本章演示故意省略了这些：(a) 16 个 FileCategory 里的 11 个（comp/css/html/image/wasm/flow/font/bin/map 等），只保留 5 类足以演透级联；(b) 5 条早退守卫（演示直接传 pkgPath，绕过了 PackageNodeRaw 形态）；(c) 完整的 TypeScript 类型导出（用 string 字面量代替 FileCategory 联合类型）。这些省略都是为了让级联本身成为演示的主角。

## 8. 小结

这一章把磁盘拍平成字节账单，靠「过滤、归类、称重」三步走完，每一步都对应一条静态启发式做出的取舍。镜头先停在「磁盘文件长什么样」，下一章会回到 package.json 自身：那几个被 30 年的 npm 生态写成字符串、对象、数组、GitHub handle 等无数种形态的 author/repo/license/funding 字段，要怎么统一成一份可展示的形态。
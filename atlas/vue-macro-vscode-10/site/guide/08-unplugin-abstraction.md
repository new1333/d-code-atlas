# unplugin：一份变换逻辑，长出 N 个工具的原生插件

> 本章属于 composite 层。前置：SFC 编译管线与宏的注入时机、Vue Macros 的宏变换流水线。
> 学完你能用一句话讲清：为什么 Vue Macros 能"写一份代码、跑遍 Vite/webpack/esbuild"，以及这套统一抽象在 esbuild 上"只支持有限特性"的代价到底从哪来。

## 1. 为什么需要它：一个插件要插进形状各不相同的插座

上一章我们盘点了一批宏的设计原型，结论是：手上的宏越来越多，能前移到编译期、能省掉的运行期样板也越来越多。但这套乐观背后藏着一个现实问题——我们前几章搭起来的那条宏变换流水线（注册宏、遍历 AST、命中调用节点、用 magic-string 就地改写），目前只在 Vite 一种构建工具里跑得通。

而 Vue 生态的构建工具是分裂的。新项目默认 Vite，但海量的存量项目还跑在 webpack / vue-cli 上；写库的人打包用 Rollup；追求极致冷启动速度的人用 esbuild；后面还有 Rspack、Rsbuild、Rolldown 一群新玩家。每个打包器的插件 API 互不兼容。

如果 Vue Macros 想让所有这些用户都用上宏，最朴素的办法是给每个工具手写一套插件。这意味着每加一个宏特性，就要改 N 份代码，维护 N 套签名完全不同的 hook，修 N 倍的 bug。作者被逼到一个二选一面前：要么只支持 Vite、放弃大半用户；要么支持所有工具、但维护成本爆炸。

unplugin 就是来消解这个二选一的。它要回答的问题是：**能不能让一份变换逻辑，同时长出 Vite、webpack、esbuild 各自的原生插件？**

## 2. 核心思想：统一接口 + 每个工具一个翻译适配器

一句话：用工厂函数把同一份"源码 → 源码"的 transform 逻辑，适配到各打包器互不兼容的 hook 约定上。

打个比方，这就像一个国际旅行转换插头。你的笔记本充电器内部逻辑是固定的（一份 transform），但各国墙上插座的形状不一样（各打包器的 hook 各不相同）。你不会为每个国家重新造一个充电器，而是用一个转接头，把同一根充电线接到不同形状的插座上。unplugin 做的就是这个转接头：它先约定一个最简单的"插头那一端"的形状作为统一接口，再为每种"墙上的插座"配一个翻译适配器。

关键在于"插头那一端"选什么形状。unplugin 选了这几个打包器里最简单的一种：Rollup 风格的扁平 hook（一个普通对象，挂着 `transform`、`load`、`resolveId` 这类函数式钩子，没有事件总线，没有 loader 分层）。这就是后面反复要呼应的那个**公约数接口**。

## 3. 心智模型：工厂分发与跨工具翻译

把上面两节合起来，一次完整的跨工具分发长这样：

1. **写工厂**：作者调用 `createUnplugin(factory)`，传进去一个工厂函数。这个工厂返回一个带统一 hook（`transform` 等）的插件对象，也就是公约数接口。
2. **按宿主取入口**：用户在配置里按自己用的工具导入对应子路径——`dev-flip/vite`、`dev-flip/webpack`、`dev-flip/esbuild`。`createUnplugin` 返回的那个对象身上，本来就挂着 `.vite` / `.webpack` / `.esbuild` 这些导出属性，导入哪个就取哪个。
3. **告知宿主身份**：宿主加载插件、准备调用工厂时，unplugin 会往工厂里注入一个 `meta.framework`，告诉插件"你现在跑在哪个工具里"。插件据此可以做条件分支（比如某特性只在 Vite 下开）。
4. **宿主触发原生点**：构建过程中，宿主按它**自己原生**的机制在某个点触发——Vite 是插件级 `transform` 钩子，webpack 是去执行一条 loader，esbuild 是 `onLoad` 回调。
5. **适配器翻译进来**：适配器把这个原生事件**翻译**成对统一 `transform(code, id)` 的一次调用。
6. **跑同一段逻辑**：统一 `transform` 内部跑的，就是前置章那条宏变换流水线（这里当黑盒用，本章不重演它内部）。它返回改写后的 `code`（外加 sourcemap）。
7. **适配器翻译出去**：适配器把结果**翻译回**宿主期望的形态——webpack loader 的 `callback(null, code)`、esbuild `onLoad` 的 `{ contents }`。宿主拿着改写后的代码继续后面的阶段（比如交给 SFC 编译器）。

说穿了，整个流程就是"翻译进来 → 跑同一份逻辑 → 翻译出去"。第 5、7 步是适配器存在的全部意义，第 6 步是"一份逻辑"真正落地的地方。

## 4. 关键权衡

这一节是本章的重头戏。unplugin 看似优雅，但它每一个设计选择背后都有一笔实打实的代价。

### 4.1 公约数取的是交集，不是并集

**选择**：拿 Rollup 的扁平 hook 当统一接口。
**换来**：插件作者只学一套 API，一份核心逻辑就能分发到所有工具。
**代价**：这个公约数取的是各工具能力的**交集**，不是并集。任何工具独有的能力，要么被抹掉，要么得另想办法。

举个例子，webpack 有一套基于 Tapable 的细粒度钩子（`SyncHook`、`AsyncSeriesHook`……），Vite 有 `configureServer` 这种专门改 dev server 的入口。这些都不在 Rollup 风格里，公约数接口装不下它们。

unplugin 的解法是给插件对象开一个"逃生舱"：你可以额外挂 `vite: {...}`、`webpack(compiler) {}`、`esbuild: {...}` 这类子字段，把某个工具独有的配置单独再写一份。这就像开会时选一门"所有人都会说的语言"当工作语言，结果某些母语里才有的精妙表达就传达不了，只能会后单独再发一份补充材料。

要化解的本质矛盾是**通用性对上工具独有能力**：你想一份代码跑遍所有工具，就注定用不了任何单个工具的独门绝技。抽象层不是免费的。

### 4.2 适配器是会"翻译走样"的黑盒

**选择**：在底层用适配器，把公约数 hook 翻译回各打包器的原生机制。webpack 那边要凭空合成一个虚拟 loader 塞进 `module.rules`，esbuild 那边要把 `transform` 包进 `onLoad`。
**换来**：一份插件能跑在架构根本不同的工具上（webpack 的双层架构和 Rollup 的扁平模型，差别不能再大了）。
**代价**：适配器对你是个黑盒，同一份插件在 webpack 和 Rollup 下可能出现微妙的行为差异。

差异来自翻译过程中的失真。比如 hook 的触发时序、模块 id 的格式（带不带后缀、是不是绝对路径），各工具原本就不一样，适配器只能尽力抹平，抹不平的地方就会暴露成"我在 Vite 下好好的，到 webpack 下就时序不对"。调试这类问题时，你必须意识到自己是在跟适配层打交道，而不是在调一个原生插件。

本质矛盾是**抽象一致性对上各工具原生语义**：统一接口要翻译，翻译就必然有损。

### 4.3 esbuild 为了快，把插件 API 砍到了最小（最痛的一处）

这一条是 Vue Macros 在 esbuild 下"只支持有限特性"的直接根因，值得单独说透。

**选择**：esbuild 官方把它的插件 API 故意做到最小，只有 `onResolve` 和 `onLoad` 两个回调，没有 `enforce`，没有 `addWatchFile`，连多阶段的 transform pipeline 都没有。
**换来**：unplugin 的 esbuild 适配器实现极简，esbuild 本身的构建速度极快。
**代价**：在 esbuild 下，Vue Macros 只能支持有限特性。

代价具体落在哪？还记得前置章那条铁律吗：宏变换必须挂在 SFC 编译**之前**，否则它改写的不是最终的源码。Vite 用 `enforce: 'pre'` 来保证这个先后；可 esbuild 压根没有 `enforce` 这个东西，插件顺序只能靠注册顺序维护，没法强保证"宏变换一定先于 SFC 编译跑"。再加上 esbuild 缺多阶段 pipeline，"先宏变换、再 SFC 编译"这种强依赖顺序的管线在它上面很难可靠地串起来。

这不是 unplugin 的锅，是 esbuild 把能力砍了，unplugin 在它之上再怎么适配也变不出来。Vue Macros 官方文档因此把 Vite / Rollup 标为完全支持，把 esbuild / webpack / Rspack 标为有限支持，分界线正画在这里。

本质矛盾是**极简与极速对上管线能力的完整性**：esbuild 为了快把插件 API 砍到最小，复杂管线在它上面注定跑不全。

### 4.4 过滤闸门省了性能，却把"不生效"藏了起来

**选择**：引入 `transformInclude`（新写法是 `transform.filter`）这样一个过滤钩子，作为 `transform` 的前置闸门。
**换来**：在 webpack 和 Rolldown 下，不会对所有模块无差别地跑 transform。这两个工具的模块 id 过滤逻辑在 loader 之外，没有这道闸门就会每个文件都进去转一遍，性能损耗很可观。
**代价**：插件作者必须额外维护一份 include 规则，而且这份规则和 transform 主体逻辑是割裂的。

代价麻烦在症状。一旦你漏配或配错了 include，表现不是报错，而是**变换静默不生效**——文件被闸门挡在外面，transform 根本没机会跑，你盯着构建产物百思不得其解，不知道是宏没写对，还是闸门把它挡了。这种"静默失败"是出了名的难排查。

本质矛盾是**性能对上配置正确性**：要快就得提前过滤，而过滤规则错了，失败会被悄悄吞掉。

## 5. 最小原理演示：一份 transform 长出三个工具的插件

下面这段演示只演透"工厂 → 公约数 → meta → 翻译 → 分发"这条主线。它故意用了一个跟宏无关的最简单变换（把 `__DEV__` 标记翻成字面量 `false`），因为本章要演的是"如何跨工具分发"，不是宏变换本身（那是前置章的演示内容）。

```ts
// === ① 公约数接口：一份 transform 逻辑 ===
import { createUnplugin } from 'unplugin'

const devFlip = createUnplugin((options, meta) => {
  // 原理点：meta.framework 告诉你现在跑在哪个工具里
  console.log('[dev-flip] running inside', meta.framework)

  // 原理点：统一的"源码 → 源码" transform，三个工具最终都调到这里
  const transform = (code: string, id: string) => {
    if (!code.includes('__DEV__')) return null        // 没命中就跳过
    return { code: code.replaceAll('__DEV__', 'false') }
  }

  // 原理点：返回 Rollup 风格的扁平 hook 对象 —— 这就是公约数
  return {
    name: 'dev-flip',
    transformInclude: (id) => id.endsWith('.ts'),     // 原理点：4.4 说的性能闸门
    transform,
  }
})

// 原理点：一个工厂，长出 N 个工具的原生插件
export default devFlip
// 用户按宿主工具取对应子路径：
//   import devFlip from 'dev-flip/vite'     → devFlip.vite
//   import devFlip from 'dev-flip/webpack'  → devFlip.webpack
//   import devFlip from 'dev-flip/esbuild'  → devFlip.esbuild
```

光是工厂这一半，还看不出"翻译"在哪。翻译藏在适配器里。下面是两个伪适配器骨架，演示"把同一个 transform，分别包成 esbuild 和 webpack 期望的形态"：

```ts
// === ② 适配器：把统一 transform 翻译回各工具的原生机制（伪骨架）===

// (a) esbuild 适配器：transform 包进 onLoad
function toEsbuild(p: ReturnType<typeof createUnplugin>['vite']) {
  return {
    name: p.name,
    setup(build: any) {
      build.onLoad({ filter: /\.ts$/ }, async (args: { path: string }) => {
        const code = await readFile(args.path)        // 读文件内容（省略 fs 细节）
        const out = (p as any).transform(code, args.path)
        // 原理点：翻译回 esbuild 期望的返回形态
        return out ? { contents: out.code, loader: 'ts' as const } : undefined
      })
    },
  }
}

// (b) webpack 适配器：webpack 没有插件级 transform，得造一个虚拟 loader 塞进 rules
function toWebpack(p: ReturnType<typeof createUnplugin>['vite']) {
  return (compiler: any) => {
    compiler.options.module.rules.push({
      test: /\.ts$/,
      enforce: 'pre',                                 // 原理点：尽量早跑（但 esbuild 连这个都没有，见 4.3）
      use: [{ loader: virtualLoader, options: { transform: (p as any).transform } }],
    })
  }
}

// (c) Rollup/Vite 适配器：公约数本来就是 Rollup 风格，几乎直通
function toRollup(p: ReturnType<typeof createUnplugin>['vite']) {
  return { name: p.name, transform: (p as any).transform }
}
```

把这两段合起来看：工厂那一半定义了"做什么"（公约数接口），适配器那一半定义了"怎么接进不同的墙"（翻译）。无论用户用哪个工具，最终被调到的都是同一个 `transform` 函数，这就是"一份逻辑分发到 N 个工具"的落点。

## 6. 执行轨迹：一份 `__DEV__` 翻转，三种打包器一致的结果

拿一个具体输入走一遍。源文件 `debug.ts`：

```ts
if (__DEV__) {
  console.log('debug info')
}
export const x = 1
```

开发者写了上面那个 `devFlip` 插件，然后**用三种工具分别构建同一个项目**。中间发生了什么：

| 宿主工具 | 宿主的原生机制 | 适配器怎么翻译 | transform 被调到时 `meta.framework` |
|---|---|---|---|
| Vite | 插件级 `transform` 钩子 | 几乎直通（公约数本就是 Rollup 风格） | `'vite'` |
| webpack | 执行一条 loader | 合成虚拟 loader 注入 `module.rules`，loader 内部调 `transform` | `'webpack'` |
| esbuild | `onLoad` 回调 | 把 `transform` 包进 `onLoad` 的 setup | `'esbuild'` |

三种路径，最终都汇到同一个 `transform(code, id)`。它把源码改写成：

```ts
if (false) {
  console.log('debug info')
}
export const x = 1
```

接下来三个工具各自的压缩器（esbuild 自带、webpack 用 Terser、Vite 用 esbuild/rollup 的 minify）都做同一件事：死代码消除。`if (false) {...}` 整段被判定为不可达，`console.log` 跟着消失，最终产物都只剩下：

```ts
const x = 1
```

这就是核心思想的完整闭环：**一份 transform 逻辑，三种互不兼容的打包器，一致的结果**。这条轨迹演透的是"分发与翻译"，不是宏变换本身。唯一要注意的差异在 4.3 提过的那点：esbuild 下因为缺 `enforce`，没法像 Vite 那样用 `enforce: 'pre'` 严格保证翻转一定先于后续 transform 跑，复杂管线上这种先后就不再铁定可靠了。

## 7. 教学简化说明

为了把"跨工具分发"这条主线讲透，本章演示故意省略了不少东西：真实的宏变换逻辑（前置章已演示，这里当黑盒借来用）；webpack 虚拟 loader 真正注入 `module.rules` 的完整实现；真实的 sourcemap 生成；`enforce` 在各工具下的具体生效差异；HMR 细节；以及 Rolldown / Rspack / Farm / Bun 这些长尾适配器各自的差别。这些都不影响你理解"一份逻辑如何长出 N 个原生插件"。

## 8. 小结

回到开头那个二选一：unplugin 让 Vue Macros 不必在"只支持 Vite"和"N 倍维护成本"之间做选择。办法是用一个工厂函数约定一份 Rollup 风格的公约数接口，再给每种工具配一个翻译适配器，让同一份 transform 逻辑长出 Vite、webpack、esbuild 各自的原生插件。代价也很清楚：公约数只取了各工具能力的交集，独有能力得靠逃生舱单独补；适配器是会翻译走样的黑盒；而 esbuild 因为把插件 API 砍到最小，复杂管线在它上面跑不全，这是"有限支持"的根因。

到这一步，宏在构建期真的改写代码这件事，已经能在任何主流打包器里落地了。但开发者大部分时间并不在构建，而是在编辑器里写代码。编辑器里的 TypeScript 服务面对的是未经变换的原始 `.vue`，它看不懂那些宏调用，会满屏报错。怎么让语言服务也能"理解"被宏改写过的代码？这就是下一章 Volar 的虚拟代码生成要解决的问题。
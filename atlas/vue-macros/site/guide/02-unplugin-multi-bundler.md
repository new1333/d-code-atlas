---
title: "一次编写、六套构建器适配的 unplugin 模式"
---

# 一次编写、六套构建器适配的 unplugin 模式

## 先说一个让人头疼的局面

假设你写了一个 Vue 宏 `defineModels`，它的本事是：把组件里 `defineModels<{ foo: string }>()` 这种写法，在编译期改写成等价的 `defineProps` 加 `defineEmits`。改写这件事本身，你想清楚了——拿到源码，找出那几个调用，重新拼字符串。

但麻烦不在改写，在「改写之后，这段代码往哪儿塞」。

前端构建器不是只有一个，而是有 **六个**：vite、rollup、webpack、esbuild、rspack、rolldown。它们的插件长得根本不是一回事：vite 的插件是带 `enforce: 'pre'` 和 `transform(code, id)` 的对象，rollup 也是对象但没有 `transformInclude` 这种东西，webpack 的 loader 又是另一套回调形态……你手上明明只有一份改写逻辑，却好像要被迫把它抄六遍，每抄一遍还要适配一种构建器的脾气。更要命的是，你每多写一个宏，这个「乘以六」就要再来一次。

这一章要讲的就是 vue-macros 怎么把这件「乘法爆炸」的事压成「加法」：**把「改源码」写成一段跟构建器毫无关系的纯函数，再用一层薄薄的适配壳，把它分发成六套构建器各自认识的插件。**

> 承前说明：上一章我们已经把「纯函数内部怎么改 AST」讲透了（用 magic-string-ast 做偏移增量编辑、每个宏自己处理 setupOffset）。**这一章完全不碰纯函数的内部**，只盯着它「怎么被包成一个跟构建器无关的壳、再分发到六个构建器」这件事。

## 第一块：转换是一个「不认识构建器」的纯函数

一切从一个老老实实的函数开始。它的签名极简：

```ts
function transformDefineModels(code: string, id: string): CodeTransform | undefined
```

给它一段源码、给它文件的 id，它吐回改写后的源码（如果发现没有 `defineModels`，就返回 `undefined` 表示「这文件我不管」）。**它不知道、也不需要知道自己在哪个构建器里跑。** 它眼里只有字符串进、字符串出。

这一点很关键。它意味着「怎么改」这件事被彻底从「在哪改」里剥离了出来。改写的逻辑可以被单独测试、单独复用，不必为了换个构建器就重写一遍。说人话就是：**改写逻辑只此一份，它是后面所有花样的同一个内核。**

但光有一个纯函数，构建器是不认的——构建器要的是「插件对象」。于是我们需要第二块。

## 第二块：用工厂把纯函数包成「能换插头」的插件

打个比方：一台电器（纯函数）本身只认「标准电」，它的核心电路不关心你是在中国还是欧洲用。真正让它能在各国插座上工作的，是一个**插头适配器**。这一章的「适配壳」就是这个插头适配器。

这个壳是一个叫 `createUnplugin` 的工厂，它的核心是一个回调函数，签名长这样：

```ts
createUnplugin((userOptions = {}, { framework }) => {
  // framework 是运行时才拿到的：'vite' | 'rollup' | 'webpack' | ...
  const filter = createFilter(options)
  return {
    name,
    transformInclude: filter,
    transform(code, id) {
      return transformDefineModels(code, id)   // 把活全委托回那个纯函数
    },
  }
})
```

注意第二行那个 `{ framework }`——这是整个设计的命门。**工厂不是在写代码时就把六套分支写死，而是在运行时才拿到「当前到底是哪个构建器」，就地决定该怎么配。** 最能说明问题的就是过滤规则：

```ts
function getFilterPattern(types, framework) {
  const isWebpackLike = framework === 'webpack' || framework === 'rspack'
  if (types.includes(VUE_SFC_WITH_SETUP)) {
    filter.push(isWebpackLike ? REGEX_VUE_SUB_SETUP : REGEX_VUE_SFC)
  }
  // ...
}
```

同样是「挑出带 `<script setup>` 的 `.vue` 文件」，webpack/rspack 和别的构建器用的是**不同的正则**——因为 webpack 会把一个 `.vue` 文件拆成一串带 `?vue&type=script&setup=true` 的虚拟子模块，文件 id 的长相跟 vite/rollup 完全不一样。工厂在运行时根据 `framework` 挑正则，就把这个怪癖就地处理掉了，**不需要为 webpack 单独写一份插件**。

`createUnplugin` 收下这个回调后，会自动给它挂上六套方法：`.vite()`、`.rollup()`、`.webpack()`、`.esbuild()`、`.rspack()`、`.rolldown()`。每调一个，就把同一个内核「物化」成那个构建器认识的原生插件。一件电器，六种插头，自动配齐。

## 第三块：六个一行式入口文件

消费者（也就是最终用这个宏的开发者）是按构建器来 import 的。所以每个宏包都准备了六个入口文件，每个都短到只有一行：

```ts
// vite.ts
import unplugin from '.'
export default unplugin.vite as typeof unplugin.vite
```

```ts
// rollup.ts
import unplugin from '.'
export default unplugin.rollup as typeof unplugin.rollup
```

webpack、esbuild、rspack、rolldown 各一个，长得几乎一模一样，区别只是 `.vite` 换成 `.webpack` 之类。用 vite 的人 `import DefineModels from '@vue-macros/define-models/vite'`，用 webpack 的人 import `/webpack`。入口文件本身就是「指路牌」：告诉打包器「我要这套构建器的那个插件」。

## 第四块：聚合层——一张「宏 × 开关」的扁平清单

vue-macros 主插件底下挂着二三十个宏。它要做的，是给每个宏按需「点亮」或「关掉」，并把亮着的那些物化成当前构建器的插件，排成一个有序列表。这件事全压在一个叫 `resolvePlugin` 的分发函数里：

```ts
function resolvePlugin(unplugin, framework, options) {
  if (!options) return           // 开关门控：options 为 false，不产出插件
  return unplugin[framework](options)   // 物化：按当前构建器挑外壳
}
```

就这三行，但信息量很大。`options` 就是特性开关——用户在配置里把某个宏设成 `false`（或默认关），这里直接 `return undefined`，**连插件都不物化**；只有开着的时候，才拿 `framework` 去挑对应的 `.vite()` / `.webpack()`。

主插件把这些调用结果一张张拼成一个数组，最后 `filter(Boolean)` 把关掉的（返回 `undefined` 的）抹掉：

```ts
const plugins = [
  resolvePlugin(VueSetupSFC, framework, options.setupSFC),
  resolvePlugin(VueDefineModels, framework, options.defineModels),
  resolvePlugin(VueBetterDefine, framework, options.betterDefine),
  // ... 二三十行，每行一个宏
].filter(Boolean)
```

**这个扁平清单就是整个宏系统的真实形态。** 新增一个宏 = 往这张表里加一行；禁用一个宏 = 把那行的开关设成 `false`。聚合层本身不关心改写逻辑，它只管「谁该亮、按什么顺序亮」。

## 一张图把七步串起来

把上面四块拼起来，整个机制其实是一条单向流水线，可以拆成七步：

```
① 宏作者写纯函数 transformXxx(code, id)
        │  （不知道构建器，字符串进字符串出）
        ▼
② createUnplugin 工厂收下它：运行时拿 framework，
   就地算好过滤规则，声明 name / transformInclude / transform
        │
        ▼
③ 适配库自动挂六套方法 .vite()/.rollup()/.webpack()/...
        │
        ▼
④ 每个宏包写六个一行式入口文件，re-export 对应构建器的方法
        │
        ▼
⑤ 聚合层 resolvePlugin：开关关→undefined；开关开→unplugin[framework](opts)
        │
        ▼
⑥ 物化出的原生插件：transformInclude 决定改哪些文件，
   transform 把活全委托回第①步的纯函数
        │
        ▼
⑦ 过滤、拿 vue 编译器 api、HMR 读改写等通用职责，
   集中放在 common 公共层，宏按需取用
```

走一遍**执行轨迹**，把这条流水线坐实。假设现在 `framework = 'vite'`，用户没开 `defineModels`：

```
framework = 'vite'
resolvePlugin(VueDefineModels, 'vite', false)
  → options 为 false，门控命中
  → return undefined
resolvePlugin(VueShortEmits, 'vite', { /* 开着 */ })
  → return VueShortEmits.vite({ ... })
  → 物化出 { name: 'vue-macros-short-emits', transform: <委托回纯函数>, ... }

聚合层数组 = [ undefined, { short-emits 插件 }, ... ]
  → .filter(Boolean)
  → [ { short-emits 插件 }, ... ]   ← defineModels 那个 undefined 被抹掉
```

`defineModels` 因为没开，从头到尾连插件对象都没被创建，更不会去碰任何源码。这就是「门控 + 物化」叠加起来的效果：**关掉的宏零成本，开着的宏自动长成当前构建器的样子。**

## 演示：从零写一个最小的多构建器适配

下面这段脚本不依赖任何构建器，也不 import 原仓库，`node` 直接能跑。它把上面三条原理演透：**① 转换是纯函数；② 一个工厂同时给出多套构建器适配形态；③ 分发 = 门控 + 按构建器物化。** 真实库里挂的是六套适配器，这里手写三套（vite/rollup/webpack）演示「同一份内核、不同外壳、怪癖就地处理」。

```js
// ===== 原理点①：转换是纯函数，与构建器无关 =====
// 输入：源码字符串；输出：改写后的源码，或 undefined（表示「这文件我不动」）
// 它根本不知道自己在 vite 还是 webpack 里跑
function transformFoo(code) {
  if (!code.includes('defineFoo(')) return undefined   // 没命中，这文件不管
  return code.replaceAll('defineFoo(', 'defineBar(')
}

// ===== 原理点②：一个工厂同时给出多套构建器适配形态 =====
// 真实库里 createUnplugin 自动挂 6 个方法，这里手写 3 个，
// 演示「同一份逻辑、不同外壳、构建器怪癖就地分支」
function makeFooFactory() {
  return {
    // vite 认识这个插件对象：有 enforce（执行顺序）和 transformInclude
    vite(opts) {
      return {
        name: 'foo-macro',
        enforce: 'pre',
        transformInclude(id) { return id.endsWith('.vue') },
        transform(code) { return transformFoo(code) },
      }
    },
    // rollup 不需要 transformInclude，自己在 transform 里判断 id
    rollup(opts) {
      return {
        name: 'foo-macro',
        transform(code, id) {
          if (!id.endsWith('.vue')) return null
          return transformFoo(code)
        },
      }
    },
    // webpack 会把单文件拆成 ?vue&type=script 这种虚拟子模块，id 长得不一样
    // 这个「差异」就地内联处理，不用单独写一份 webpack 插件
    webpack(opts) {
      return {
        name: 'foo-macro',
        transform(code, id) {
          if (!/\.vue(\?.*)?$/.test(id)) return undefined
          return transformFoo(code)
        },
      }
    },
  }
}

// ===== 原理点③：分发函数 = 特性门控 + 按构建器物化 =====
// 开关关（options === false）→ 返回 undefined；否则按 framework 物化出原生插件
function resolve(factory, framework, options) {
  if (options === false) return undefined       // 门控：关掉就什么都不产出
  return factory[framework](options)            // 物化：挑当前构建器的外壳
}

// ===== 聚合层：把每个宏的 resolve 结果拼成一张扁平清单 =====
const framework = 'vite'
const macros = [
  { factory: makeFooFactory(), feature: true },    // 开关开
  { factory: makeFooFactory(), feature: false },   // 开关关 → resolve 返回 undefined
]
const plugins = macros
  .map(m => resolve(m.factory, framework, m.feature))
  .filter(Boolean)                                 // 抹掉 undefined

// ===== 执行轨迹 =====
console.log('当前构建器 =', framework)
console.log('聚合后的插件数 =', plugins.length)              // → 1
console.log('插件名 =', plugins[0].name)                    // → foo-macro
console.log('纯函数改写 =', transformFoo('const x = defineFoo(1)'))  // → const x = defineBar(1)
```

跑一下你会看到：开了的那个宏物化成了 `{ name: 'foo-macro', ... }`，关掉的那个化成了 `undefined` 被 `filter(Boolean)` 抹掉，最后只剩一个插件。注意 `webpack` 那一支里的 `/\.vue(\?.*)?$/` 正则——它就是前文说的「构建器怪癖就地分支」的影子：同一份逻辑，遇到 webpack 就自动换一套匹配规则，**全靠工厂运行时拿到 `framework` 这一个信息**。

## 关键权衡

这套设计不是白捡的，每个选择都换来了一样、也丢掉了一样。下面挑最关键的三条讲透。

**权衡一：统一走 unplugin 抽象，换来六套入口自动生成，代价是被锁死在它暴露的 API 面里。**
作者选择「所有构建器一律通过 `createUnplugin` 这个抽象来适配，宏只写一份转换」。换来的是极其划算的结果：你写完那个纯函数、写完工厂回调，`.vite()` 到 `.rolldown()` 六套原生入口**自动就有了**，宏的数量 × 构建器的数量本来是乘法爆炸，现在压回了加法（写一份转换、零成本拿六套入口）。
代价有二。一是你能用的，只能是这个抽象愿意暴露的钩子——某个构建器有个它没暴露的私有特性，你就用不上。二是上面第三块那六个一行式入口文件得每个宏包都维护一份，纯重复劳动，只能靠「约定」收敛（它们确实长得几乎一模一样，照着抄就行）。

**权衡二：同一份工厂在运行时按 `framework` 就地分支，换来怪癖内联处理、不用复制插件，代价是构建器差异会「漏」进过滤逻辑。**
作者没有选择「在工厂里写六份互不相干的 if-else 代码」，而是让同一个工厂运行时拿到 `framework`，就地算过滤规则（前面 `isWebpackLike ? 这套正则 : 那套正则` 就是活生生的例子）。换来的是 webpack 拆虚拟子模块这种怪癖能内联在同一份逻辑里被处理掉，**无需为它单独维护一份插件**。
代价是：抽象因此并不「完全透明」。你本以为「换构建器对宏是透明的」，结果发现文件过滤这一层悄悄出现了 `framework === 'webpack'` 的分支——构建器的差异漏了进来。好处（不复制）和坏处（不透明）是同一枚硬币的两面。

**权衡三：用统一的「门控 + 分发」函数作为聚合层与每个宏的唯一接口，换来扁平清单、增删宏只改一行，代价是要求每个宏都长得一样。**
作者选择让 `resolvePlugin(unplugin, framework, options)` 成为「聚合层 ↔ 单个宏」之间**唯一的接口形状**。换来的是聚合层那张表干净得惊人——每个宏就是一行 `resolvePlugin(某宏, framework, 某开关)`，新增一个宏加一行、禁用一个改个开关，特性开关和分发还复用同一套机制。
代价是：**这套接口要求每个宏都长成「`unplugin[framework](options)`」这一个形状。** 少数不符合形状的宏就尴尬了——主插件里能看到它们被 `as any` 强转塞进去，而且只能在部分构建器上跑。统一的代价，就是容不下异类。

（还有一条更隐蔽的：过滤、拿 vue 编译器 api、HMR 读改写这些**跨宏通用职责**集中放在 common 公共层，换来每个宏自身只剩语义改写、清爽可独立维护；代价是这一套公共设施要同时伺候两种异形宏——「改 script 的纯转换宏」和「要往 vue 编译器里塞节点 transform、改 template 的宏」，后者甚至绕开了适配抽象，造成约定上的一个破口。这条与权衡三其实是同一类困境的不同表现：统一接口总是要把异形往里塞。）

## 小结

这一章的核心可以浓缩成一句话：**把改写写成纯函数，让构建器适配变成一层可以自动生成六套外壳的薄壳，再用「门控 + 物化」把它们聚成一张扁平清单。** 改写逻辑只此一份（内核），构建器适配一次性解决（外壳），聚合层只管「谁该亮、按什么顺序亮」（清单）。宏的数量再怎么涨，也不再乘以六。

值得留意的是，那个工厂回调里其实还藏着两个钩子——`resolveId` 和 `load`——本章演示里我们故意把它们删掉了。因为它们干的不是「改源码」，而是「凭空变出一个磁盘上根本不存在的模块」。这恰好是下一章「编译期注入虚拟 helper 模块」要讲的事：宏往源码里插入的 `import`，目标文件其实不存在于磁盘，全靠这两个钩子拦下 id、就地返回代码。下一章我们接着拆。

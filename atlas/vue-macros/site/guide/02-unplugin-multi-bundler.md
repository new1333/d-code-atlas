# 一次编写、六套构建器适配的 unplugin 模式

> 本章属于 primitive 层。前置：SFC 解析与增量 AST 编辑。
> 学完你能：用一句话讲清为什么一个 Vue 宏只需写一份转换、就能在六套构建器里跑，以及这个便利付出了什么代价。

## 1. 为什么需要它

上一章把 SFC 解析和 magic-string-ast 的增量编辑讲透了，到这一步我们已经能写出一个「拿到源码、吐改写后源码」的纯函数——比如 `defineModels` 内部把类型里的字段抽出来、注入到 `defineProps` 和 `defineEmits` 里。但这个纯函数只解决了一半问题：它要在 vite、rollup、webpack、esbuild、rspack、rolldown 六套构建器里都能跑起来，而它们的插件 API 形态各不一样。

想象一下没有抽象层的日子。今天写一个宏，得为 vite 写一份 `transform` 钩子、为 webpack 写一份 `loader`、为 esbuild 又写一份 `onLoad`，逻辑是同一段，但包壳的形状变了六次。再写一个宏，再乘以六。宏作者很快就被入口文件的复制粘贴淹没，使用者则可能因为自己用的构建器没在支持列表里而用不上这个宏。

这层抽象就是为了化解这种乘法爆炸：把转换逻辑（与构建器无关）和构建器适配（与具体宏无关）拆成两个正交维度，让「宏数量 × 构建器数量」从乘法变加法。

## 2. 核心思想

把「做什么改写」和「在哪套构建器里跑」拆成正交的两层，中间用一层适配壳把它们重新粘合——改写逻辑只表达一次，构建器差异也只在适配壳里出现一次。

## 3. 心智模型

整个机制是一条流水线：

1. 宏作者写一个纯函数 `transformXxx(code, id)`，它不知道自己在哪个构建器里跑。
2. 用 `createUnplugin` 把纯函数包成工厂：工厂声明 `name`、`transformInclude`（过滤哪些文件）、`transform`（把活全委托回纯函数）。
3. 工厂返回的对象上自动挂着六个方法 `.vite()` `.rollup()` `.webpack()` `.esbuild()` `.rspack()` `.rolldown()`，每个方法把同一份声明物化成对应构建器认得的原生插件。
4. 每个宏包再写六个一行式入口文件，分别 re-export 对应方法，供消费者按构建器 import。
5. 聚合插件拿到当前构建器名，对每个宏调一次分发函数：开关关就不产出插件，开关开就按构建器物化。
6. 物化出的原生插件，其 `transformInclude` 决定改哪些文件，`transform` 把活委托回第 1 步的纯函数。
7. 跨宏通用职责（文件过滤、找 vue 插件拿编译器 api、HMR 读改写）从 common 取用，宏只挑自己需要的。

不变量是：第 1 步那个纯函数对构建器一无所知。任何构建器差异都不应该漏进它，要么收进 common、要么收进工厂的分支逻辑。

## 4. 关键权衡

### 适配抽象换一次编写六套入口

**选择**：所有构建器统一走 unplugin 库的适配抽象，宏只写一份转换。
**换来**：一次编写、六套构建器原生入口自动生成，聚合层只关心当前构建器名。
**代价**：宏被锁死在 unplugin 暴露的 API 面里，用不到未暴露的构建器私有特性；每个宏包要维护六个一行式入口文件，新增宏时这六份文件靠约定复制。
**本质矛盾**：通用性（一份代码处处可跑）与私有特性的访问权（个别构建器才有的钩子）之争——这是所有跨平台抽象都会撞上的硬约束。

### 工厂内运行时分支换怪癖内联处理

**选择**：不在工厂内部按构建器 if-else 写六份独立代码，而是让同一个工厂在运行时拿到「当前是哪个构建器」、就地分支。
**换来**：构建器相关的怪癖（比如某构建器把单文件拆成多个虚拟子模块、文件 id 长得不一样）能在同一份逻辑里被内联处理，不需要复制整份插件。
**代价**：构建器差异会「漏」进文件过滤逻辑，`transformInclude` 里偶尔会出现 `if (framework === 'webpack') ...` 这种判断，抽象并不完全透明。
**本质矛盾**：抽象的透明性（调用方看不见底层差异）与现实差异的处理（差异总要有人接住）——抽象能藏起大部分差异，但藏不光的那些只能内联处理。

### 特性门控加按构建器分发换扁平聚合

**选择**：用一个统一的「特性门控 + 按构建器分发」函数，作为聚合层与每个宏之间的唯一接口。
**换来**：聚合插件的主入口是一张扁平的「宏 × 开关」清单，新增或禁用一个宏只改一行；特性开关与按构建器分发共用同一机制。
**代价**：要求每个宏都长得一样（同一个适配器形状）。少数不符合形状的宏只能被强转塞进去，甚至只能跑在部分构建器上。
**本质矛盾**：异构插件的多样性（每个宏的转换语义都不同）与统一调度的简洁（聚合层只想要一个标准接口）——标准化的代价永远是边缘案例被挤压。

### 通用职责收 common 换宏自身的简洁

**选择**：把跨宏通用职责（文件过滤、找 vue 插件拿编译器 api、HMR 读改写）集中收在 common 公共层。
**换来**：宏自身只剩语义改写，可读性高、可独立维护，加新宏时心智负担小。
**代价**：同一套公共设施要同时伺候两种异形宏——「改 script 的纯转换宏」和「改 template、需往 vue 编译器里塞节点 transform 的宏」。后者甚至不走适配抽象，造成约定上的破口。
**本质矛盾**：复用收益（一处实现处处可用）与抽象破口（少数异类无法套进同一抽象）——共用基础设施永远会向最复杂的那个使用者倾斜。

## 5. 最小原理演示

下面这段脚本演透三条原理：转换是纯函数、一个工厂给出多套构建器适配形态、分发函数等于特性门控加按构建器选适配器。真实库自动挂六个方法，这里手写两个足够说明。

```ts
// 转换是纯函数：拿到源码吐改写后的源码，对构建器一无所知
function transformFoo(code: string): string {
  return code.replaceAll('defineFoo(', 'defineBar(')
}

// 工厂：声明插件名和转换，对外给出多套构建器认得的形态
function makeFooFactory() {
  // 每个分支把同一份声明物化成对应构建器的原生插件形状
  return {
    vite: () => ({
      name: 'foo',
      enforce: 'pre' as const,
      transform(code: string) {
        return { code: transformFoo(code), map: null }
      },
    }),
    rollup: () => ({
      name: 'foo',
      transform(code: string) {
        return { code: transformFoo(code), map: null }
      },
    }),
  }
}

// 分发函数：开关关就直接返回空，开关开则按构建器选对应的物化方法
function resolve(
  factory: ReturnType<typeof makeFooFactory>,
  framework: 'vite' | 'rollup',
  enabled: boolean,
) {
  if (!enabled) return undefined
  return factory[framework]()
}

// 聚合层：拿到当前构建器名和一张「宏 × 开关」清单，分发成扁平插件列表
const framework = 'vite' as const
const plugins = [
  resolve(makeFooFactory(), framework, true),
  resolve(makeFooFactory(), 'rollup', false),     // 开关关 → undefined
].filter(Boolean)                                 // 抹掉 undefined，聚合层是 flat list

console.log(plugins.length, (plugins[0] as { name: string }).name)
// → 1 'foo'
```

脚本里每个原理点都对应着一处代码：`transformFoo` 对应「转换与构建器无关」、`makeFooFactory` 返回对象上的 vite/rollup 两个分支对应「一个工厂给多套形态」、`resolve` 里的 `if (!enabled) return undefined` 加上 `factory[framework]()` 对应「特性门控加按构建器分发」。

## 6. 执行轨迹

拿一个具体场景走一遍：用户在 vite 项目里启用了 `defineModels`、关掉了 `chainCall`。

聚合插件启动时拿到 `framework = 'vite'` 和一张表 `{ defineModels: true, chainCall: false }`。它对表里每一项调 `resolve(factory, 'vite', enabled)`：

- `defineModels` 这一项：`enabled` 为 `true`，进入 `factory.vite()`，物化出一个原生插件 `{ name: 'vite:vue-macros-define-models', enforce: 'pre', transform(code, id) { ... } }`。
- `chainCall` 这一项：`enabled` 为 `false`，直接返回 `undefined`。

`filter(Boolean)` 把 `undefined` 抹掉，最终 vite 拿到一份只有一个插件的列表。用户写的 `.vue` 文件被 vite 喂给这个插件的 `transform`，内部委托回纯函数 `transformDefineModels(code, id)`，改写后的代码继续走 vite 的下游管道。整条链路里，`transformDefineModels` 始终不知道自己在 vite 里跑——它只看见了源码字符串和文件 id。

## 7. 教学简化说明

本章演示故意省略了这些：

- 真实 unplugin 库的完整 API（`resolveId`、`load`、`buildStart`、`buildEnd` 等钩子），只演示了 `transform` 这一条主路径。
- HMR 的 hack：构建器之间 HMR API 差异更大，unplugin 靠 `getCombinedHooks` 抹平，本章不展开。
- 构建期宏生成插件名的规则（如 `vite:vue-macros-define-models` 这种带构建器前缀的命名）。
- webpack 把单文件拆成多个虚拟子模块时、文件 id 的正则细节。
- TypeScript 的选项泛型（`Plugin<T>` 的选项类型推导）。
- 虚拟模块（`resolveId` / `load`）——这是下一章的主题。

## 8. 小结

三层各管一段：作者那层写纯函数，工厂那层把它包成构建器认得的形状，聚合层那层决定开哪些宏、当前在哪个构建器里跑。加新宏时不需要懂另外两层，代价是抽象的天花板和异形宏的破口。

可宏改写源码时往往会往里插入 `import` 语句，目标模块在磁盘上根本不存在——这就是下一章「编译期注入虚拟 helper 模块」要接的口子。
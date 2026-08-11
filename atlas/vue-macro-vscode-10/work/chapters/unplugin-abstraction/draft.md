# unplugin：跨构建工具的统一插件抽象

> 本章属于 composite 层。前置：SFC 编译管线与宏的注入时机、Vue Macros 的宏变换流水线。
> 学完你能：用一句话讲清「为什么同一份宏变换逻辑能跑在 Vite、webpack、esbuild 这些互不兼容的打包器上」，以及这个统一抽象在哪几个点上不得不让步。

## 1. 为什么需要它

上一章给了判断「该不该做成宏」的判据。但宏写出来只是源代码层面的事，要让它真的在用户项目里生效，得让宏变换挂在用户的构建管线上跑一遍。问题就出在这里：Vue 用户的构建工具是分裂的。

新项目默认 Vite；存量项目里还有大批跑在 webpack / vue-cli 上；做库的人用 Rollup；追求冷启动速度的人试 esbuild；新玩家 Rspack、Rolldown 也在涌入。这些打包器的插件 API 互不兼容到什么程度？举几个维度：Rollup 是一个扁平的 hook 对象，webpack 是 `apply(compiler)` 加上一套 Tapable 事件总线，esbuild 干脆只给你 `onResolve` 和 `onLoad` 两个回调。文件变换发生的位置也不一样——Rollup/Vite 在插件级 `transform` hook 里直接改，webpack 却把文件变换扔给独立的 loader 层，插件根本碰不到。

宏变换必须挂在 SFC 编译之前——这条阶段顺序前置章已经讲过。但那个结论是在 Vite 的管线里成立的。问题是 webpack、esbuild 这些工具连「插件级 transform hook」都不一定有，凭什么也能复现这条顺序？这正是本章要解的题。

Vue Macros 想让所有这些用户都用上同一组宏，最朴素的办法是给每个工具手写一套插件。这意味着每加一个宏特性要改 N 份代码、维护 N 套互不相同的 hook 签名、修 N 倍的 bug。作者被卡在一个二选一里：要么只支持 Vite、放弃大半存量用户；要么支持所有工具、维护成本爆炸。unplugin 就是来消解这个二选一的。

## 2. 核心思想

把同一份「源码→源码」的 transform 逻辑写一次，再用一个工厂函数，把它适配到各家打包器互不兼容的 hook 约定上——一份变换逻辑，长出 N 个工具的原生插件。

这背后是一招「公约数加翻译」：先从所有打包器里挑一个最简单的插件形态当公约数（unplugin 选了 Rollup 那套扁平 hook），让插件作者只学这一套；再为每个工具写一层适配器，把公约数 hook 翻译回各自的原生机制。

## 3. 心智模型

插件作者只写一份代码，最后这份代码却能跑在三个互不兼容的工具里。中间夹了什么？七个动作把这件事讲清楚：

1. **写工厂**：作者调 `createUnplugin(factory)`，`factory` 接收 `(options, meta)`，返回一个带统一 hook（`transform`、`load`、`buildStart`…）的插件对象。这个对象就是「公约数」。
2. **选入口**：用户在配置里按宿主工具导入对应子路径（`unplugin-vue-macros/vite`、`/webpack`、`/esbuild`…）。每个子路径背后是不同的适配器。
3. **注入 meta**：unplugin 调工厂时塞进 `meta.framework`（如 `'vite'`、`'webpack'`、`'esbuild'`），让插件运行时知道「我现在跑在哪个工具里」，可据此做条件分支。
4. **触发原生 hook**：宿主打包器在构建过程中触发它**原生**的某个点——Vite 的 `transform`、webpack 的 loader 执行、esbuild 的 `onLoad`。
5. **翻译进来**：适配器把这个原生事件翻译成对统一 `transform(code, id)` 的一次调用。
6. **跑变换**：统一 `transform` 内部跑的就是前置章建立的那条宏变换流水线（注册宏→遍历 AST→magic-string 注入），返回新 code 加 sourcemap。本章把这条流水线当黑盒。
7. **翻译出去**：适配器把结果翻译回宿主期望的形态（webpack loader 的 `callback(null, code)`、esbuild `onLoad` 的 `contents`），宿主拿改写后的代码继续后续阶段（比如交给 SFC 编译器）。

一句话：插件作者面对的永远是「公约数 hook + meta」，宿主工具面对的永远是「原生 hook」，适配器夹在中间做双向翻译。

## 4. 关键权衡

unplugin 看起来是「一次编写到处跑」，但这块布下面盖着四条很实在的取舍。前三条讲抽象层怎么挑边界，第四条讲性能闸门带来的副作用。

### 4.1 选 Rollup 扁平 hook 当公约数：要一份 API，还是要工具独有能力

unplugin 选了 Rollup 风格的扁平 hook 对象作为统一接口，没选 webpack 的 Tapable 事件总线，也没选 esbuild 的双回调模型。原因很朴素——Rollup 那套最简单：插件就是个对象，hook 是函数，没有事件总线、没有 loader 分层，作者学起来成本最低。

这个选择换来的是「插件作者只学一套 API、核心逻辑只写一份，分发到所有工具」。代价藏在「公约数取的是各工具能力的**交集**而非并集」上。webpack 的 Tapable 那套细粒度钩子、Vite 的 `configureServer` 这种 dev server 钩子，都不在 Rollup 的扁平模型里——这些独有能力要么被抹掉，要么得走 `vite: {...}`、`webpack(compiler){}` 这种「逃生舱」字段单独再写一份。抽象层不是免费的：享用了统一接口的简洁，就得接受独有能力要绕路。

这里打架的两个需求是**接口的统一**对上**工具的独有能力**。unplugin 站在前者一边，把后者分流到逃生舱。

### 4.2 用适配器翻译回原生机制：要一份逻辑跨架构，还是要行为完全一致

webpack 把「构建生命周期」和「文件变换」分成两层：插件用 `apply(compiler)` 挂 Tapable 钩子，文件变换却交给独立的 loader——webpack 压根没有插件级 `transform` hook。esbuild 更极端，整个插件 API 只有 `onResolve` 和 `onLoad`。

unplugin 的解法是给每个工具写一层适配器：webpack 适配器合成一个虚拟 loader 注入 `module.rules`，把统一 `transform` 包成 loader 的执行；esbuild 适配器把统一 `transform` 包进 `onLoad` 的 setup。换来的是「一份插件能跑在架构根本不同的工具上」，这是 unplugin 最大的存在理由。

代价是适配器是个黑盒。同一份插件在 webpack 与 Rollup 下可能出现微妙的行为差异：hook 触发的时序不同、模块 id 的格式不同、对 sourcemap 的处理路径不同。调试时如果意识不到自己在跟适配层打交道、而不是原生插件，就会陷入「为什么 Rollup 下好好的，webpack 下就报错」的泥潭。webpack 适配器最复杂、行为差异也最大，这正是它成为「有限支持」之首的原因。

两个对立需求是**一份逻辑跨架构跑**对上**行为在不同工具下完全一致**。unplugin 选了前者，把一致性损失留给作者自己注意。

### 4.3 esbuild 插件 API 故意最小化：要适配器简洁速度极快，还是要钩子覆盖完整

esbuild 官方明说它的插件 API 不打算覆盖所有用例：只有 `onResolve`/`onLoad`，没有 `enforce`（无法声明插件先后），没有 `addWatchFile`，没有多阶段 transform pipeline。

unplugin 的 esbuild 适配器因此写得极简——把统一 `transform` 包进 `onLoad` 就完事。换来的是 esbuild 下适配器实现简单、构建速度极快，几乎不被插件层拖累。

代价直接砸在 Vue Macros 头上：因为缺 `enforce`，无法保证宏变换一定在 SFC 编译之前跑；缺多阶段 pipeline，意味着「先宏变换、再 SFC 编译」这种强依赖顺序的管线在 esbuild 下难以可靠串联。Vue Macros 官方文档明确把 esbuild 和 webpack 标为「有限支持」，根因就在这里——不是写法没顾上，是 esbuild 那套 API 真的兜不住宏变换需要的阶段顺序。

这是抽象抹平能力差异最痛的一处代价。两个对立需求是**适配器的简洁与速度**对上**钩子模型的完整覆盖**。esbuild 选了前者，unplugin 适配器跟着选了前者，Vue Macros 在 esbuild 下就只能交付有限特性。

### 4.4 用 transformInclude/filter 当闸门：要不被无差别跑，还是要配置不割裂

webpack 和 Rolldown 的模块 id 过滤发生在 loader 逻辑之外。如果不在 transform 之前加一道过滤，webpack 下每个模块（包括 `node_modules` 里成千上万的文件）都会进一次 transform 函数，构建慢到无法接受。unplugin 的解法是 `transformInclude`（旧 API）和新的 `transform.filter`（带 `id.include`/`id.exclude`/`code` 子规则）——一道前置闸门，只放匹配的文件进 transform。

换来的是 webpack/Rolldown 下不会对所有模块无差别跑 transform，性能可控。代价是插件作者必须额外维护一份 include 规则，且这份规则和 transform 主体逻辑**割裂**——主体里写的逻辑根本不知道哪些文件能进来。漏配或配错的症状非常难排查：不是报错，是「变换静默不生效」，文件压根没进 transform，主体逻辑一行都没跑，作者盯着 transform 代码看半天也看不出毛病。

两个对立需求是**性能**对上**配置的局部性**。unplugin 选了性能，把 include 规则从 transform 主体里抽出来变成独立字段。

## 5. 最小原理演示

下面这份演示只演透「工厂 → 公约数 → meta → 翻译 → 分发」这条主线，不演宏变换内部（那是前置章的内容）。我们写一个最朴素的 transform：把源码里的 `__DEV__` 标记替换成字面量 `false`，构建期干掉调试代码。

```ts
// 一份 transform 逻辑，将被分发到三种工具
type TransformResult = { code: string; map: null | unknown } | null | undefined;

// 公约数接口：插件作者面对的就是这一份
type UnpluginObject = {
  name: string;
  enforce?: "pre" | "post"; // 公约数里有 enforce，esbuild 适配器兜不住
  transformInclude?: (id: string) => boolean; // 性能闸门，避免对所有模块无差别跑
  transform?: (code: string, id: string) => TransformResult;
  // bundler-specific 逃生舱：公约数取交集，独有能力走这条路
  vite?: { configureServer?: () => void };
  webpack?: (compiler: unknown) => void;
};

// 工厂：接收 options 与 meta，meta.framework 告诉插件当前宿主是谁
function defineDevReplace(
  options: { mode: "development" | "production" },
  meta: { framework: string }
): UnpluginObject {
  const plugin: UnpluginObject = {
    name: "dev-flag-replace",
    enforce: "pre",
    transformInclude: (id) => /\.(ts|js)$/.test(id),
    transform(code) {
      if (!code.includes("__DEV__")) return null;
      const replaced = options.mode === "development" ? "true" : "false";
      return { code: code.replace(/\b__DEV__\b/g, replaced), map: null };
    },
  };

  // 用 meta.framework 做条件分支，只在 vite 下挂逃生舱
  if (meta.framework === "vite") {
    plugin.vite = {
      configureServer() {
        console.log("[dev-flag-replace] vite dev server attached");
      },
    };
  }
  return plugin;
}

// 三个工具入口，每个对应一层适配器
type UnpluginInstance = { vite: unknown; webpack: unknown; esbuild: unknown };

function createUnplugin(
  factory: (opts: any, meta: { framework: string }) => UnpluginObject,
  options: any = {}
): UnpluginInstance {
  // 同一个工厂被调三次，meta.framework 各不同——这就是「分发」
  return {
    vite: makeViteAdapter(factory, options),
    webpack: makeWebpackAdapter(factory, options),
    esbuild: makeEsbuildAdapter(factory, options),
  };
}

// Vite 适配器：公约数 hook 与 Vite/Rollup 原生 hook 几乎一对一，最薄的翻译
function makeViteAdapter(factory: any, options: any) {
  const p = factory(options, { framework: "vite" });
  return {
    name: p.name,
    enforce: p.enforce,
    transformInclude: p.transformInclude,
    transform: p.transform,
    configureServer: p.vite?.configureServer,
  };
}

// esbuild 适配器：把统一 transform 包进 onLoad 的 setup
function makeEsbuildAdapter(factory: any, options: any) {
  const p = factory(options, { framework: "esbuild" });
  return {
    name: p.name,
    setup(build: any) {
      // esbuild 没有 enforce、没有 transformInclude——能力差异在这里显形
      build.onLoad({ filter: /\.(ts|js)$/ }, async (args: { path: string }) => {
        const src = await readFile(args.path);
        const out = await p.transform?.(src, args.path);
        return { contents: out?.code ?? src, loader: "ts" };
      });
    },
  };
}

// webpack 适配器：合成一个虚拟 loader 注入 module.rules
function makeWebpackAdapter(factory: any, options: any) {
  const p = factory(options, { framework: "webpack" });
  return {
    apply(compiler: any) {
      // webpack 没有插件级 transform hook——必须把它包成 loader
      const virtualLoader = {
        loader: function (this: any, source: string) {
          const id = this.resourcePath;
          if (p.transformInclude && !p.transformInclude(id)) return source;
          const out = p.transform?.(source, id);
          this.callback(null, out?.code ?? source);
        },
      };
      compiler.options.module.rules.push({ test: /\.(ts|js)$/, use: [virtualLoader] });
    },
  };
}

declare function readFile(path: string): Promise<string>;

// 用户面：一份工厂 + 一份 options，三个原生形态的插件
const devReplace = createUnplugin(defineDevReplace, { mode: "production" });
export const vitePlugin = devReplace.vite;
export const webpackPlugin = devReplace.webpack;
export const esbuildPlugin = devReplace.esbuild;
```

整段演示里值得读的几行：`createUnplugin` 返回对象的三个属性是同一份工厂的三个翻译出口；`meta.framework` 在工厂里被读出来决定要不要挂逃生舱；esbuild 适配器用 `onLoad` 包了 transform，webpack 适配器用虚拟 loader 包了 transform——这就是「翻译」最具体的形状。

## 6. 执行轨迹

拿一个具体输入走一遍：源文件 `app.ts` 里写了 `if (__DEV__) { console.log('debug') }`，开发者用 `defineDevReplace({ mode: 'production' })` 写好了 unplugin，分别用 Vite、webpack、esbuild 三个工具构建同一个项目。

**起点**：三个工具的入口分别是 `devReplace.vite` / `.webpack` / `.esbuild`，三个适配器内部都被 `createUnplugin` 触发，**同一个工厂 `defineDevReplace` 被调用了三次**，三次的 `meta.framework` 分别是 `'vite'`、`'webpack'`、`'esbuild'`。只有 vite 这次，工厂内部的条件分支生效，给插件挂上了 `vite.configureServer` 逃生舱；另外两次插件对象上没有逃生舱字段。

**触发**：三个打包器各自构建 `app.ts`。
- Vite 在 transform 阶段调插件的 `transform(code, 'app.ts')`，`transformInclude('app.ts')` 返回 true 放行。
- webpack 编译时，适配器已经把虚拟 loader 挂进了 `module.rules`；webpack 走到 `app.ts`，触发虚拟 loader 的执行，loader 内部先调 `transformInclude` 过滤、再调统一 `transform`，最后用 `this.callback(null, newCode)` 把改写后的代码交还 webpack。
- esbuild 的 `onLoad` setup 被触发，filter `/\.(ts|js)$/` 匹配上 `app.ts`，适配器读出文件内容、调统一 `transform`，把返回的 `code` 包成 `{ contents, loader: 'ts' }` 交回 esbuild。

**变换内部**：三次调用都进到同一段 transform 主体——`code.replace(/\b__DEV__\b/g, 'false')`，得到 `if (false) { console.log('debug') }`。

**出口**：三个打包器拿到改写后的代码继续后续阶段。因为 `__DEV__` 已经变成字面量 `false`，三个打包器的 dead code elimination 都会把 `console.log('debug')` 整段消除，最终 bundle 里这段调试代码消失。

**落点**：三个工具的产物里，`__DEV__` 都变成了 `false`、调试代码都被消除。**一份 transform 逻辑，三种互不兼容的打包器，一致的结果**——这条轨迹演的不是宏变换本身（那是前置章的演示），而是「翻译」这件事真的把同一份逻辑送到了三个工具的同一次构建里。

## 7. 教学简化说明

本章演示故意省略了：真实的宏变换逻辑（前置章已演示，本章把 transform 主体当黑盒）；webpack 虚拟 loader 的真实 `module.rules` 注入实现（真实实现要用 inline loader 字符串编码 loader 路径）；esbuild 适配器如何把 `transformInclude` 函数编译成 onLoad 必需的 regex filter；sourcemap 的生成与传递；`enforce` 在各工具的具体生效差异；HMR 细节；Rolldown/Rspack/Rsbuild/Farm/Bun 等长尾适配。本章只演透「公约数 + 翻译」这一条主线。

## 8. 小结

unplugin 把 Vue Macros 那条宏变换流水线，从一个 Vite 专属能力，变成了能挂进 Vite/Rollup/webpack/esbuild 任一家的通用预处理。一份代码、N 个原生插件，这件事成立的前提是抽象层愿意为每个工具让出一点——这些让步就是前文那几条权衡。

构建期能跑通了，宏才落了地一半。另一半在编辑器里：宏在 `.vue` 里写出来，TypeScript 得认得出来，否则写代码的时候满屏红线。下一章就接着这道关讲 Volar 怎么用虚拟代码生成与位置回映把这件事办成。
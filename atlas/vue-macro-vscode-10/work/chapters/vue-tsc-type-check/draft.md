# vue-tsc：在 CLI 复用 Volar 插件做类型检查

> 本章属于 system 层。前置：Vue Language Plugin 接口与 SFC 解析扩展点、双轨制：编译变换与 IDE 类型支持为何必须并存。
> 学完你能：用一句话讲清 vue-tsc 凭什么把 IDE 的类型能力搬进 CI，以及这套搬法为什么注定脆弱。

## 1. 为什么需要它

上一章把双轨制讲透了，留下一个钩子：构建轨和智能轨的对齐是个**契约**，但「契约在编辑器里看不到执行者」。CI 没有人坐在 VS Code 前看红线，它只能跑命令。所以契约得有人替它在命令行里执行——vue-tsc 就是来当这个执行者的。

它要解决的问题先于它自己。设想一个常见场景：开发者装了 Volar 扩展，`.vue` 里的类型错随写随现，红线罩住、悬停出类型、补全能弹，一切都很顺。开发者放心提交，CI 跑 `tsc --noEmit`，绿灯通过，合入主干。两周后某次真实构建才爆出一个类型错，距离写错代码那一刻已经过去十四天。

问题不在开发者粗心，而在 `tsc` **根本不认识 `.vue`**。它把整个 SFC 当未知模块跳过。CI 跑出的「绿灯」不是「没找到错」，而是「根本没查」。IDE 的类型能力和 CI 的门禁能力中间断了一截。

vue-tsc 干的就是补这一截：让 CI 跑出来的结果，和 IDE 里看到的诊断，是同一份。

## 2. 核心思想

vue-tsc 不重写类型检查器，而是**劫持** tsc 的编译入口。在 tsc 试图读取 `.vue` 文件的那一瞬间，把虚拟 TS 代码喂进去，让 tsc 误以为自己在检查 `.ts`。同一套虚拟代码生成逻辑同时喂养 IDE 与命令行，没有第二份实现。

## 3. 心智模型

tsc 像一个一本正经验货的质检员：你给它什么文件，它就老老实实查什么文件。vue-tsc 做的事是在质检员眼皮底下，把每件 `.vue` 货物在拆封前换成 `.ts` 的精美包装——质检员验得很认真，但验的不是原货。

它一次类型检查的链路是这样走的：

1. CI 执行 `vue-tsc --noEmit`，flag 与 `tsc` 完全一致。
2. vue-tsc 入口转交给 Volar 提供的 `runTsc`，在 Node 加载 tsc **之前**，monkey-patch 掉 `fs.readFileSync`。
3. Node 接下来 `require` tsc，tsc 源码本身是个 JS 字符串，在它被解析执行前先过 `readFileSync`——vue-tsc 在这一步把源码里的 `ts.createProgram` 调用改写成代理版本。
4. 改写后的 tsc 跑起来，每次构造编译单元都会调 `createProgram`，但调到的是代理版。
5. 代理版识别出 `.vue`，调 Vue 语言插件（含 `@vue-macros/volar`）生成虚拟 TS 代码，把虚拟内容喂给真实的 `createProgram`。
6. 真实的类型检查发生在虚拟代码上。
7. 诊断经 source map 反向映射回 `.vue` 的真实行号；有错则退出码非 0，CI 门禁据此拦截。

关键点是「tsc 本身没动一行」——它仍然是官方那份 TypeScript，CLI flag、tsconfig 解析、增量编译逻辑全是原生。变的只是它读到的「文件」在 `readFileSync` 那一层被掉包了。这也意味着双轨制章留下的契约**第一次有了命令行里的执行者**：CI 不再是裸 `tsc`（它啥也没查），而是 vue-tsc，查的内容和 IDE 是同一套虚拟代码。

## 4. 关键权衡

### 运行时劫持 tsc 源码，而不是 fork TypeScript

vue-tsc 想「让 tsc 理解 `.vue`」，最朴素的两条路：把 TypeScript 源码 fork 出来自己改，或者写一个独立的小型类型检查器。前者要长期维护一整套 TypeScript 的副本、追每一个上游版本；后者等于自己实现 Vue 的类型语义，工程量不可想象。

实际选的是第三条最骚的路：在运行时**改写 tsc 源码字符串**。Node 加载 tsc.js 时，先 monkey-patch `fs.readFileSync`，把读到的那份字符串里的 `ts.createProgram` 替换成代理版，再让 Node 执行这份被改写过的源码。tsc 本身一字未改，运行时却跑了不同的逻辑。

- **换来**：不用 fork TypeScript，与 tsc 全部 CLI flag（`--noEmit`、`-p`、`--declaration`、`--build`）100% 兼容，因为执行的就是官方 tsc 本体。
- **代价**：极度脆弱。改源码字符串依赖 TypeScript 内部的具体实现细节，TS 一旦重构就崩——已知案例：TypeScript 5.7.2 发布后 vue-tsc 立刻出现兼容性破坏。更长远地看，TypeScript 正在用 Go 重写（tsgo），编译产物将不再是可改写的 JS 源码，整套方案从根本上失效。
- **化解的本质矛盾**：想给 tsc 注入 `.vue` 支持，又坚决不肯背 fork TypeScript 的长期维护成本——只能选最低侵入的运行时介入方式，代价是介入点绑死 tsc 内部实现。这类「不打架只挂钩子」的方案在工程上反复出现，骨架都是同一个：用一个外部入口接管目标工具的加载链，把改动藏在加载过程里，换取目标工具本身的零改动。

### 与 IDE 扩展共享同一份 @vue/language-core

vue-tsc 完全可以自己实现一份「`.vue` → 虚拟代码」的生成逻辑，按 CLI 的需求量身定做。但它没这么干。它和 Volar 编辑器扩展**共用** `@vue/language-core` 这个核心包——同一个函数，IDE 调一次、CLI 调一次。

- **换来**：天然一致。两端生成的虚拟代码物理上出自同一份实现，不存在「写两份再努力对齐」的工程负担。双轨制章担心的「智能轨 vs 构建轨」语义漂移，在「智能轨 vs CLI 检查轨」这一侧被根除。
- **代价**：一致性**强依赖版本对齐**。Volar 扩展在 VS Code 里走自动更新，而 vue-tsc 的版本锁在项目 `package.json` 里——开发者很少记得同步升级 vue-tsc。一旦两端版本不一致，生成的虚拟代码略有差异，立刻出现「IDE 绿但 CI 红」或反之。这种漂移是 vue-tsc issue 区的头号常客。
- **化解的本质矛盾**：想要一致性，就得让两端从同一份代码出发；但两端处在完全不同的发布节奏里（一个自动更新、一个锁版本），共享同一份代码等于把版本管理责任下放给每个项目。共享底座换一致性、版本管理换独立性，两头只能取一头。

### 不带任何独立的类型推断兜底

vue-tsc 完全可以借机做点「CLI 端额外校验」——比如对某些宏做更严格的检查、加一些 IDE 不方便做的批量校验。但它没这么做。它生成的虚拟代码就是 Volar 给 IDE 看的那份，一字不差，自己不加任何额外的类型推断。

- **换来**：零重复实现。宏的类型漏洞在 IDE 与 CI **同步暴露**——一致性在这里反而是优点。用户不会撞到「CI 通过但 IDE 报错」这种自相矛盾的信号；宏支持如果有 bug，两端一起错，至少错的口径一致、可定位。
- **代价**：vue-tsc 没有独立纠错能力。当某个宏的类型支持有 bug 时（比如某个版本的 `defineModels` 类型推断有缺陷），CI 与 IDE 会**一起误报**。无法指望 CLI 端做独立防线——它和 IDE 用的是同一双眼睛。
- **化解的本质矛盾**：vue-tsc 想成为 CI 的「独立门禁」，但它「门禁用的眼睛和 IDE 是同一双」。独立性只能体现在「它能跑在无头环境、能挂 CI」这一层；类型推断本身没有独立性。这是「想让某物成为独立防线、但它的判据来源和被防御对象同源」这类问题的通解骨架：独立性只能落在执行环境上，落不到判据本身。

## 5. 最小原理演示

把上面那套思想缩成一个最小原型：一张 `.vue → 虚拟TS` 的映射、一个 `proxyCreateProgram` 包裹原始 `createProgram`、在 tsc 读取时把 `.vue` 掉包成虚拟 `.ts`。每一行都对应上面某个原理点。

```ts
// 用户源码（.vue 文件，磁盘上的原貌）
const userSource = `
defineProps<{ msg: string }>();
const bar = undefinedValue; // 故意写一个未定义标识符
`;

// 「.vue → 虚拟 TS」的映射（真实由 @vue/language-core 调语言插件生成，这里只 mock）
function generateVirtualCode(fileName: string): { vFile: string; content: string } | null {
  if (!fileName.endsWith('.vue')) return null; // 非 .vue 不接管，让 tsc 走原路径
  return {
    vFile: fileName + '.ts', // 虚拟文件名：原名加 .ts 后缀
    content: `
      declare function defineProps<T>(): T; // 宏去糖成全局类型声明
      const props = defineProps<{ msg: string }>();
      const bar = undefinedValue;           // 用户源码原样保留，等 tsc 报错
    `,
  };
}

// 假装这是 tsc 内部的编译入口（真实叫 ts.createProgram）：扫一遍找未定义符号
function realCreateProgram(roots: string[], read: (f: string) => string | undefined) {
  const diags: string[] = [];
  for (const f of roots) {
    const code = read(f);
    if (code && /\bundefinedValue\b/.test(code)) {
      diags.push(`${f}: Cannot find name 'undefinedValue'`);
    }
  }
  return { diags };
}

// vue-tsc 的核心动作：代理 createProgram，在 tsc 读 .vue 时把内容掉包成虚拟代码
function proxyCreateProgram(roots: string[], read: (f: string) => string | undefined) {
  // 虚拟文件名 → 真实 .vue 的回映表，供 source map 反向定位真实行号
  const vToReal = new Map<string, string>();
  const patchedRead = (f: string): string | undefined => {
    if (f.endsWith('.vue')) { // tsc 想读 .vue：掉包成虚拟代码
      const v = generateVirtualCode(f);
      if (v) { vToReal.set(v.vFile, f); return v.content; }
    }
    if (vToReal.has(f)) { // tsc 想读虚拟 .vue.ts：复用同一份虚拟代码
      return generateVirtualCode(vToReal.get(f)!)!.content;
    }
    return read(f); // 其它文件原样读，tsc 的常规文件不受影响
  };
  // rootName 也要改写，让 tsc 把 .vue 当 .vue.ts 来查（否则它根本不会发起读取）
  const patchedRoots = roots.map(f => (f.endsWith('.vue') ? f + '.ts' : f));
  return realCreateProgram(patchedRoots, patchedRead);
}

// 模拟一次 CI 跑 vue-tsc：磁盘只有 Button.vue，tsc 一字未改
const diskRead = (f: string) => (f === 'Button.vue' ? userSource : undefined);
const { diags } = proxyCreateProgram(['Button.vue'], diskRead);
console.log(diags);
// → [ "Button.vue.ts: Cannot find name 'undefinedValue'" ]
// 经 vToReal 表把 Button.vue.ts 反向定位回 Button.vue，红线落在原文件的真实行号
```

读这段演示时盯住一件事：`realCreateProgram` 函数本体没有任何修改，但它收到的 `roots` 已经被改写过、它调到的 `read` 也已经被掉包。tsc 跑得很认真，可它读到的「Button.vue.ts」内容是 vue-tsc 临时生成的虚拟代码。整个机制的核心思想就是这一句话——**不动 tsc，只动它读到的文件**。

## 6. 执行轨迹

拿一个具体的 `Button.vue` 走一遍，看 vue-tsc 怎么把 IDE 的类型能力搬进 CI。

**输入**：

```vue
<script setup lang="ts">
defineProps<{ msg: string }>();
const bar = undefinedValue;
</script>
<template>
  <button>{{ msg }}</button>
</template>
```

**走链路**：

1. CI 跑 `vue-tsc --noEmit -p tsconfig.json`，flag 与 tsc 完全一致。
2. vue-tsc 入口先 monkey-patch `fs.readFileSync`，再 `require` 真实的 tsc。
3. tsc 源码字符串在加载过程中被改写：内部的 `ts.createProgram` 被替换为 `proxyCreateProgram`。
4. 改写后的 tsc 跑起来，按 tsconfig 找到 root 文件 `Button.vue`，调 `createProgram(['Button.vue'], ...)`——但调到的是代理版。
5. 代理版识别 `Button.vue` 结尾，调 `@vue/language-core`（内部含 `@vue-macros/volar` 子插件）生成虚拟 TS 代码：宏 `defineProps<{ msg: string }>()` 去糖为 `declare function defineProps<T>(): T` 加 `const props = defineProps<{ msg: string }>()`；模板编译成带类型的 render 函数；`bar` 这一行**原样保留**（因为它本来就是错的）。
6. 代理把虚拟代码作为 `Button.vue.ts` 的内容喂给真实的 `createProgram`，tsc 在虚拟代码上做类型检查。
7. tsc 发现 `undefinedValue` 未定义，产出一条诊断：`Button.vue.ts:5:11 - Cannot find name 'undefinedValue'`。
8. 诊断经 source map 反向映射：`Button.vue.ts:5:11` → `Button.vue:3:11`（虚拟代码的 offset 与原文件的 offset 由 `@vue/language-core` 维护的双向映射对齐）。
9. vue-tsc 输出 `Button.vue:3:11 - Cannot find name 'undefinedValue'`，退出码非 0。
10. CI 据非 0 退出码拦截本次提交。

**对照**：如果 CI 跑的是裸 `tsc --noEmit`，第 5 步就不会发生——tsc 不认 `.vue`，会把 `Button.vue` 跳过，第 7 步根本不存在，退出码 0，CI 通过，错代码合入主干。这就是「IDE 绿、CI 也绿、但其实没查」的真相。

## 7. 教学简化说明

为了把「劫持加掉包」这一核心思想演透，本章演示故意省略：真实的 SFC 解析（template/script/style 分块）、完整的虚拟代码生成与 render 函数、增量编译的 patch 机制、watch 模式、tsconfig 解析、`@vue-macros` 各宏的具体展开规则、`--build` 模式下额外的 root-file 扩展名 patch、source map 段的具体映射实现。这些都是工程完整性的一部分，不是「vue-tsc 凭什么能复用 Volar 插件」这个核心思想。

## 8. 小结

vue-tsc 在 tsc 加载自己源码的瞬间改写源码、把它读到的 `.vue` 掉包成虚拟代码，让 tsc 在不知情下检查了 Vue 的语义。它第一次给双轨制留下的契约配了一个能在 CI 里执行的执行者——代价是整套机制绑死 tsc 的内部实现，TS 一改、tsgo 一来就要推倒重来。

可一致性还有最后一道口子没堵：vue-tsc 跑出来的诊断和构建轨 `vite build` 跑出来的产物，凭什么保证用的是同一份配置？下一章就把这件事搬上台面。
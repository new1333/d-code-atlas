# vue-tsc：在 CLI 复用 Volar 插件做类型检查

> 本章属于 system 层。前置：Vue Language Plugin 接口与 SFC 解析扩展点、双轨制：编译变换与 IDE 类型支持为何必须并存。
> 学完你能：一句话讲清 vue-tsc 为什么不重写类型检查器、而是靠运行时劫持 tsc 把虚拟代码喂进去——以及这套「零分叉」换来了什么、代价是什么。

## 1. 为什么需要它

上一章讲了双轨制：编辑器里的类型提示靠虚拟代码，构建产物靠编译变换，两条管线各管一摊。但这留下一个口子——**CI 流水线上没有编辑器**，只有一个跑在命令行的 `tsc`，而 `tsc` 压根不认识 `.vue`。

想象一个 Vue 项目的真实场景：开发者写完一个组件，Volar 在编辑器里把类型红线标得清清楚楚，确认没错了，放心提交。可 CI 跑的是 `tsc --noEmit`，`tsc` 看到 `.vue` 文件只会当未知模块直接跳过。结果是「IDE 里一片绿灯，合入主干后某次真实构建里才突然爆出类型错」。问题不在代码，在于**编辑器的类型能力被关在了编辑器里，出不去**。

CI 需要的是一个「无头的、能跑在命令行里的 Volar」——把编辑器里那套 `.vue` 类型检查能力，原样搬进 CI 门禁。vue-tsc 就是干这件事的。

## 2. 核心思想

vue-tsc **不重写类型检查器**，而是劫持 tsc 的编译入口。在 tsc 准备读取 `.vue` 文件的瞬间，把对应的「虚拟 TS 代码」喂到它手里，让 tsc 误以为自己从头到尾都在检查 `.ts`。

一句话：**tsc 本身一行没改，只是它读到的文件被掉包了**。于是同一套「虚拟代码生成」逻辑，既喂养编辑器，也喂养命令行。

## 3. 心智模型

理解 vue-tsc 的关键，是先看清真实 tsc 的骨架。tsc 在命令行跑一次类型检查，内部大致是这样一条链：

```
CLI 入口 → 构造 CompilerHost → ts.createProgram(rootNames, options, host) → 逐文件读源码 → 检查 → 产出诊断
```

这条链里有个关键角色 `host`，它是 tsc 读取文件的唯一通道：tsc 想看哪个文件，就调 `host.readFile(name)`。vue-tsc 的全部魔法都落在这一点上。

vue-tsc 一次类型检查的链路是这样的：

1. 用户在 CI 跑 `vue-tsc --noEmit`，命令行参数和 `tsc` 完全一样。
2. vue-tsc 入口转交 Volar 提供的 `runTsc`，在 Node 加载 tsc **之前**，先劫持 `fs.readFileSync`。
3. 当 Node 去读 tsc 的源码文件时，被劫持的读取会把 tsc 源码字符串里的 `createProgram` 调用改写成代理版本，然后把改写后的 tsc 交出去执行。
4. tsc 像往常一样跑起来，每编译一组文件就调一次 `createProgram`——只不过这次调到的是代理版。
5. 代理版 `createProgram` 一眼认出 `.vue`，调 Vue 语言插件（含 `@vue-macros/volar`）生成虚拟 TS 代码，再把它喂给真正的 `createProgram`。
6. 真实的类型检查发生在虚拟代码上。
7. 诊断经 source map 反向映射回 `.vue` 的真实行号；有错则退出码非 0，CI 门禁据此拦截。

这里有个不变量值得记住：**tsc 自己从头到尾不知道 `.vue` 的存在**。它以为自己在编译一堆 `.ts`，因为文件名被改写了、内容被掉包了。vue-tsc 没有重新实现任何类型检查逻辑，它只做了一件事——在 tsc 和磁盘之间，塞了一层会把 `.vue` 翻译成 `.ts` 的中间人。

## 4. 关键权衡

这套设计里有三个绕不开的取舍。

### 权衡一：运行时劫持，而非 fork TypeScript

vue-tsc 选择的是运行时劫持——改写 `fs.readFileSync`、改 tsc 源码字符串、代理 `createProgram`，三招组合。

- **换来**：无需 fork TypeScript，且与 tsc 的全部 CLI flag 100% 兼容。因为跑的归根到底还是那个原汁原味的 tsc，`--noEmit`、`-p`、`--declaration`、`--build` 全都照常工作，vue-tsc 不必操心去复刻这些开关。
- **代价**：极度脆弱。这套方案把命脉悬在了 TypeScript 的内部实现上——TS 内部一旦重构（比如某次小版本改了 `createProgram` 的调用形态），patch 立刻失效。现实里这种事已经发生过：TypeScript 5.7.2 发布后 vue-tsc 随即出现兼容性破坏。更棘手的是，当 TypeScript 被 Go 重写（tsgo）后，编译产物不再是可改写的 JS 源码，「改写源码字符串」这条路从根上就断了，几乎无解。

这条权衡化解的本质矛盾，是**「想白用 TypeScript 的全部能力」和「不想永久背负一个 TS 分叉」**之间的拉锯。fork TS 能拿到完整控制权，但代价是永远要跟上游同步、维护一份私有分支；劫持换来了零分叉的清爽，代价是把稳定性押在了别人的内部实现上。越深的集成，就越依赖被集成方「内部别乱动」——而内部怎么动，从来是被集成方自己的自由。

### 权衡二：与 IDE 扩展共享同一套虚拟代码生成

vue-tsc 选择和 Volar 编辑器扩展**共用** `@vue/language-core` 这个包——同一个「`.vue` → 虚拟 TS 代码」的生成器，两端一起用。

- **换来**：IDE 提示与 CI 检查天然一致。虚拟代码只生成一份，编辑器和命令行吃的是同一碗饭，行为当然对齐。
- **代价**：一致性**强依赖版本对齐**。Volar 扩展在 VS Code 里会自动更新，而 vue-tsc 的版本锁在项目的 `package.json` 里——这两只手不受同一个人控制。一旦版本漂移，两端生成的虚拟代码就会有细微差别，表现为「Volar 和 vue-tsc 报不同的错」，甚至「IDE 绿但 CI 红（或反过来）」。

这条权衡化解的本质矛盾，是**「想让两端永远一致」和「两端的更新节奏不由同一只手控制」**之间的冲突。一致性的前提是同源，可同源又把「不一致」的诱因，从「实现写岔了」转嫁成了「版本没对齐」——问题没有消失，只是换了个更容易偷偷发生的形态。

### 权衡三：完全复用虚拟代码保真度，自己不带独立兜底

vue-tsc 选择完全相信 Volar 的虚拟代码保真度，**自己不做任何独立的类型推断兜底**。

- **换来**：零重复实现。更重要的是，某个宏的类型支持如果有漏洞，这个漏洞会在 IDE 和 CI 两端**同步暴露**——一致性在这里反而成了优点，至少你不会遇到「IDE 说对、CI 说错」的灵异场面。
- **代价**：vue-tsc 没有独立纠错能力。当某个宏（比如某个 `@vue-macros/volar` 注入的特性）的类型支持本身有 bug 时，CLI 和编辑器会**一起误报**，你没法指望命令行这一端给出第二个视角来兜底。

这条权衡化解的本质矛盾，是**「想要一条能纠错的独立防线」和「不想付两套实现的成本」**之间的取舍。冗余通常带来鲁棒——两套独立实现本可以在一头出错时由另一头兜住。但 vue-tsc 放弃了「另一双眼睛」的价值，换来了实现的零冗余。这里的特殊之处在于：因为两端同源，冗余本来也纠不了同源的错，所以放弃冗余几乎无损——除非未来某天有人真想给 CLI 端写一套独立的、更宽松的推断来「网开一面」，那时这个代价才会真正显现。

## 5. 最小原理演示

下面这段代码只演透一件事：**tsc 没动，只是它读到的文件被掉包了**。它分三个角色——被劫持的 tsc、vue-tsc 的代理函数、劫持入口。

```js
/* ========== 角色一：迷你 tsc（整个演示里它一行不改）==========
 * 真实 tsc 的骨架：构造 CompilerHost → createProgram → 逐文件读源码 → 检查。
 * host.readFile 是 tsc 获取源码的唯一通道，也是 vue-tsc 掉包的注入点。
 */
const tsc = {
  createProgram(rootNames, host) {
    const diagnostics = [];
    for (const name of rootNames) {
      const src = host.readFile(name);            // tsc 通过 host 读文件
      if (src && /\bbar\b/.test(src))             // 极简“类型检查”（真实 tsc 远比这复杂）
        diagnostics.push(`${name}: 找不到名称 "bar"`);
    }
    return { diagnostics };
  },
};

/* ========== 角色二：vue-tsc 的全部魔法——代理 createProgram ========== */

// 「.vue → 虚拟 TS 代码」的映射规则。
// 真实情况由 @vue/language-core 生成（@vue-macros/volar 也挂在这一层，
// 把 defineProps 等宏展开成带类型的等价代码），这里用字面量演示同一思想。
function generateVirtualCode(vueFile) {
  return `
    declare function defineProps<T>(x: T): T;
    defineProps<{ msg: string }>();
    bar;                  // 用户在 <script setup> 里写的、未定义的标识符
  `;
}

function proxyCreateProgram(originalCreateProgram) {
  return (rootNames, host) => {
    // ① 把 .vue 改名成虚拟 .ts，骗过 tsc「只认 .ts」的扩展名检查
    const virtualNames = rootNames.map(n => n.replace(/\.vue$/, '.vue.ts'));
    // ② 掉包 host.readFile：tsc 以为在读磁盘，实际拿到的是虚拟代码
    const patchedHost = {
      readFile: (name) =>
        name.endsWith('.vue.ts')
          ? generateVirtualCode(name.replace(/\.ts$/, ''))
          : host.readFile(name),
    };
    // ③ 照常调原始 createProgram——tsc 一行没改，只是读到的内容被掉了包
    return originalCreateProgram(virtualNames, patchedHost);
  };
}

/* ========== 角色三：劫持入口（对应真实 vue-tsc 转交的 runTsc）==========
 * 真实做法：patch fs.readFileSync，在 Node 读取 tsc.js 时改写其源码字符串，
 * 把里面的 createProgram 换成代理版，再 require 执行。这里直白演示同一思想。
 */
function runVueTsc(rootNames) {
  const original = tsc.createProgram;
  tsc.createProgram = proxyCreateProgram(original);   // ← 劫持发生在这里
  const program = tsc.createProgram(rootNames, { readFile: () => null });
  tsc.createProgram = original;                        // 还原
  return program.diagnostics;
}

console.log(runVueTsc(['Button.vue']));
// → [ 'Button.vue.ts: 找不到名称 "bar"' ]
// （真实 vue-tsc 会再经 source map 把这个位置回映到 Button.vue 的真实行号）
```

对照原理点看：`host.readFile` 是 tsc 的读取通道（掉包的注入点）；`virtualNames` 改名对应「骗过扩展名检查」；`patchedHost.readFile` 喂虚拟代码对应「tsc 读到的内容被掉包」；`proxyCreateProgram` 内部照常调 `originalCreateProgram`，对应核心思想那句「tsc 一行没改」。

## 6. 执行轨迹

拿一个 `Button.vue` 走一遍，它的 `<script setup lang="ts">` 里写了 `defineProps<{ msg: string }>()`，还混进了一个未定义的标识符 `bar`。

- **调用**：CI 执行 `vue-tsc --noEmit`，参数原样进 tsc。
- **劫持**：vue-tsc 在加载 tsc 前改写源码，tsc 启动后调到的 `createProgram` 已经是代理版。
- **掉包**：代理版把 `Button.vue` 映射为虚拟的 `Button.vue.ts`——在这段虚拟代码里，`defineProps` 宏已被展开成带类型的等价声明，模板也已编译成有类型的 render 函数，`bar` 还是那个未定义的 `bar`。
- **检查**：tsc 在虚拟代码上发现 `bar` 未定义，产出一条诊断。
- **回映**：诊断经 source map，把虚拟代码里的位置反向映射回 `Button.vue` 的真实行号。
- **输出**：vue-tsc 以非 0 退出码结束，CI 门禁据此拦截本次提交。

整个过程里，tsc 以为自己从头到尾在检查一个普通的 `.ts` 文件。

## 7. 教学简化说明

上面的演示故意省略了很多东西，这里一并点明：真实的 SFC 分块解析（template / script / style 拆分）、完整的虚拟代码与 render 函数生成、source map 的反向映射实现、增量编译与 watch 模式、tsconfig 解析、`--build` 模式下额外的 root-file 扩展名 patch，以及 `@vue-macros` 各个宏的具体展开规则，都没有出现在演示里。它们都不影响「tsc 读到的文件被掉包」这个核心思想，留下来只会分散注意力。

## 8. 小结

回到那句话：vue-tsc 不重写类型检查器，它劫持 tsc 的编译入口，在 tsc 读 `.vue` 的瞬间把虚拟 TS 代码喂进去。这套运行时劫持换来了零分叉和 CLI flag 的全兼容，代价是把命脉悬在 TypeScript 的内部实现上；和 IDE 共享同一套虚拟代码生成换来了两端天然一致，代价是强依赖版本对齐。读者现在应该能一句话复述 vue-tsc「为什么这么设计」了。

vue-tsc 之所以能这么顺地复用 `@vue-macros/volar` 的虚拟代码，有个前提没明说：CLI 端和 IDE 端用的是**同一份宏配置**。可这份配置到底怎么做到同时喂给编译变换和类型这两条管线？这就是下一章「配置系统：一份配置驱动两条管线」要讲的事。
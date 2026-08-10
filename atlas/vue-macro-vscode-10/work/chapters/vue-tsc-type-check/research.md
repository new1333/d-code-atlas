# vue-tsc：在 CLI 复用 Volar 插件做类型检查 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：开发者装了 Volar，编辑器里 `.vue` 的类型错误能即时看到红线，于是放心提交。但 CI 只认命令行的 `tsc`——而 `tsc` 根本不认识 `.vue` 文件，会把整个 SFC 当作未知模块跳过。结果是「IDE 里一片绿灯，合入主干后才在某次真实构建里爆出类型错」。缺一个**无头的、能跑在命令行里的 Volar**，把编辑器的类型能力搬进 CI 门禁。

- **一句话核心思想**：vue-tsc 不重写类型检查器，而是**劫持** tsc 的编译入口（`createProgram`），在 tsc 读取 `.vue` 文件的瞬间把「虚拟 TS 代码」喂进去，让 tsc 误以为自己在检查 `.ts`——于是同一套「虚拟代码生成」逻辑同时喂养 IDE 与命令行。

- **设计动机（为什么需要它，含与前置章的复用关系）**：它的存在是为了回答「IDE 能查的类型，怎么进 CI」。这套复用承接自前置章建立的「@vue-macros/volar 靠虚拟代码给 IDE 类型提示」那条管线——（已在第 11 章『双轨制：编译变换与 IDE 类型支持为何必须并存』讲透"IDE 靠虚拟代码、构建靠编译变换"的双轨分立，本章只看它的新侧面：如何把这条**虚拟代码管线再复用到无头 CLI 环境**做类型门禁）。本章同时引入一个前置章没讲的独有原理：vue-tsc 到底**用什么手段把虚拟代码塞进 tsc**——即对 `createProgram` 的运行时代理。

- **关键权衡（本 Atlas 的核心；机制丰富章，3 条）**：
  1. **选择**运行时劫持 `fs.readFileSync` + 改写 `tsc.js` 源码字符串 + 代理 `createProgram`，**换来**「无需 fork TypeScript、与 tsc 的全部 CLI flag 100% 兼容」，**代价是**极度脆弱——TS 内部实现一改就崩，且对即将到来的 Go 重写（编译产物不再是可改写的 JS 源码）几乎无解。
  2. **选择**让 vue-tsc 与 Volar 编辑器扩展**共享同一套** `@vue/language-core` 虚拟代码生成逻辑，**换来**「IDE 提示与 CI 检查天然一致」，**代价是**这种一致**强依赖版本对齐**——扩展自动更新、vue-tsc 锁在 `package.json`，版本一漂移就出现「IDE 绿但 CI 红（或反之）」。
  3. **选择** vue-tsc 完全复用 Volar 的虚拟代码保真度、自己**不带任何独立的类型推断兜底**，**换来**「零重复实现、宏的类型漏洞在 IDE 与 CI 同步暴露（一致性反而是优点）」，**代价是** vue-tsc 没有独立纠错能力——当某个宏的类型支持有 bug 时，CI 与 IDE 会**一起误报**，无法指望 CLI 端兜底。

- **最小心智模型（3～7 步）**：
  1. 用户在 CI 跑 `vue-tsc --noEmit`（flag 与 `tsc` 完全一致）。
  2. vue-tsc 入口转交 Volar 提供的 `runTsc`，在 Node 加载 tsc **之前**劫持文件读取。
  3. 读到 tsc 的源码时，把其中调用 `createProgram` 的地方改写成代理版本。
  4. 执行被改写后的 tsc；tsc 仍按原本逻辑去编译每一个文件，每次都会调 `createProgram`。
  5. 代理版 `createProgram` 识别出 `.vue`，调 Vue 语言插件（含 `@vue-macros/volar`）生成虚拟 TS 代码。
  6. 真实的类型检查发生在虚拟代码上。
  7. 诊断经 source map 反向映射回 `.vue` 真实行号；有错则退出码非 0，CI 门禁拦截。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简的「劫持入口 + 注入虚拟代码」原型——几十行 JS 即可：定义一张 `.vue→虚拟TS` 的映射表，写一个 `proxyCreateProgram` 包裹原始 `createProgram`，把 `.vue` 文件名改写成虚拟 `.ts` 并在 tsc 读取时喂入虚拟内容。重点演透「tsc 本身没动，只是它读到的文件被掉包了」这个核心思想。
  - **应故意省略**：真实的 SFC 解析（template/script/style 分块）、完整的虚拟代码与 render 函数生成、增量编译 patch、watch 模式、tsconfig 解析、`@vue-macros` 的具体宏展开。
  - **演示载体建议**：首选 **TS/JS**（本 Atlas 产物是 JS 生态 VitePress 站点，对读者最友好；且 vue-tsc 本身就是 JS 运行时劫持，JS 最贴合）。用 mock 的「迷你 tsc」+ `runTsc` 风格的 patch 即可演透，无需依赖真实 TypeScript 包。

- **正文不宜展开的细节**：`ts-patch` 等第三方 createProgram hook 替代方案；tsgo（Go 重写）时代的具体迁移路线与时间表；Deno/Bun 等非 Node 运行时下文件读取劫持失效的兼容性细节；vue-tsc 1.x→2.x 的历史演进（早期基于 `ts-morph`，后统一切到 `@vue/language-core`）；`--build` 增量编译模式下额外的 root-file 扩展名 patch；`vite-plugin-checker` 等把 vue-tsc 接进 Vite dev 的外围集成。

- **推荐的一个执行轨迹例子**：
  - **输入**：一个 `Button.vue`，`<script setup lang="ts">` 里写了未定义的标识符 `bar`，并用宏 `defineProps<{ msg: string }>()` 声明 props。
  - **关键中间态**：代理 `createProgram` 把 `Button.vue` 映射为虚拟 `Button.vue.ts`——其中宏已展开为带类型的等价代码、模板编译成有类型的 render 函数；tsc 在这段虚拟代码上发现 `bar` 未定义。
  - **输出**：tsc 产出诊断，经 source map 把报错位置回映到 `Button.vue` 的真实行号；vue-tsc 以非 0 退出码结束，CI 门禁据此拦截本次提交。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **vue-tsc 的定位**：它是官方维护的「命令行类型检查工具」，本质是 tsc 的 wrapper（包装器）。它接受全部标准 tsc CLI 参数（`--noEmit`、`-p`、`--declaration`、`--build` 等），区别只在于额外理解 `.vue` SFC。依据: Vue.js 官方文档「Using Vue with TypeScript」；vue-tsc 的 NPM 包描述（"a tsc wrapper, enabling the TypeScript compiler to understand .vue files"）。

- **它解决了什么**：纯 `tsc` 不认识 `.vue`，会把 SFC 当未知模块跳过，导致 CI 无法对 Vue 项目做类型门禁；vue-tsc 让「IDE 里的类型能力」可复刻到无头命令行，用于 CI / pre-commit。依据: Vue.js 官方文档「Using Vue with TypeScript」（"use the vue-tsc utility for command line type checking and type declaration generation"）。

- **核心机制：运行时劫持而非 fork**。vue-tsc 入口转交 `@volar/typescript` 提供的 `runTsc()`，工作链路为：① monkey-patch `fs.readFileSync`，拦截对 tsc 源码文件的读取；② 读到 tsc 源码时改写其字符串，把内部的 `ts.createProgram` 调用替换为代理版 `proxyCreateProgram`；③ `require` 执行被改写的 tsc；④ tsc 每次调 `createProgram` 时走代理，代理识别 `.vue` 并用 Vue 语言插件生成虚拟 TS 代码喂给真实 `createProgram`。依据: vue-tsc 源码解析（soonwang.me《vue-tsc 源码解析》）；volar.js Issue #297（关于 monkey-patch `fs` 的讨论）；Deno 兼容性分析 gist（bartlomieju，解释 `runTsc` 如何 monkey-patch `fs.readFileSync` 与代理 `createProgram`）。

- **为什么选 monkey-patch 而非 fork**：Volar 作者 Johnson Chu 的说法是，proxy `readFileSync` 改写 FS 结果并接管 `createProgram`，是「不分叉 TypeScript」前提下注入 Vue 支持的最干净方式——执行 `require('tsc.js')` 时 Node 跑的是改写后的代码，虚拟文件叠加对外透明。依据: elecmonkey.com《vue-tsc and Volar.js Enter the tsgo Era》（引述 Johnson Chu 在 X/Twitter 的说明）。

- **与 `@vue/language-core` 的共享关系**：`@vue/language-core` 是负责「解析 `.vue` + 生成虚拟 TS 代码」的核心包，vue-tsc 与 Volar 编辑器扩展**共用**它。这就是「一套语言插件同时服务 IDE 与 CLI」的物理基础——虚拟代码只生成一次、两端共享。依据: vuejs/language-tools 官方仓库说明（`@vue/language-core` 负责 parsing 与 virtual code generation，同时被 vue-tsc 与 VS Code 扩展使用）。

- **与 `@vue-macros/volar` 的集成**：`@vue-macros/volar` 作为 Vue 语言插件的子插件，把宏变换注入虚拟代码；它**必须同时配置给 IDE 与 vue-tsc 两端**，才能让两端生成相同的虚拟代码、保证一致。部分宏特性（如 `templateRef`）自 Volar/vue-tsc v2.1.0 起被官方原生支持，Vue Macros 便不再单独为其提供插件——这恰好印证了「宏的类型支持最终向官方收敛」这一生态演进方向。依据: Vue Macros 官方文档 `templateRef` 页（"officially supported since Volar (vue-tsc) v2.1.0"）；Vue Mastery《Supercharge your code with Vue Macros》（说明 `@vue-macros/volar` 把宏转成 IDE 与 vue-tsc 共同消费的虚拟代码）。

- **一致性的头号敌人是版本漂移**：Volar 扩展在 VS Code 里自动更新，而 vue-tsc 版本锁在项目 `package.json` 里；二者一旦版本不齐，就会生成略有不同的虚拟代码，表现为「Volar 和 vue-tsc 报不同的错」。依据: Stack Overflow「Volar and vue-tsc are showing different TS errors」（主因是版本漂移，建议保持 vue-tsc 最新）。

- **脆弱性：源码 patch 对 TS 内部改动零容忍**。因为 `@volar/typescript` 依赖改写 tsc 的源码字符串，TS 一旦重构内部，patch 就会失效。已知案例：TypeScript 5.7.2 发布后 vue-tsc 立即出现兼容性破坏（language-tools Issue #5018）。依据: elecmonkey.com《vue-tsc and Volar.js Enter the tsgo Era》；vuejs/language-tools Issue #5018。

- **tsgo（TypeScript 的 Go 重写）威胁**：当 TS 编译器由解释执行的 JS 变为编译产物为原生 Go 二进制时，「改写 tsc 源码字符串」的整套方案从根本上失效；社区讨论的出路是争取 tsgo 提供官方扩展点（虚拟文件叠加、自定义模块解析、Program 构造钩子）。依据: elecmonkey.com 同文。

## 关键流程

vue-tsc 一次类型检查的执行链路（命令行侧）：
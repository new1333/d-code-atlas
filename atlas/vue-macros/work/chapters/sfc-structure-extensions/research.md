# 突破单 script setup 的 SFC 结构扩展 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：Vue 把「一个组件 = 一个 `.vue` 文件 = 一个 `<script setup>`」钉死成铁律。这带来两个不便：一是想在父组件里**内联**定义一个一次性子组件（带自己的 props/emits/生命周期、且想直接用父作用域里的变量），就得新建文件、用 props 把状态搬过去，组合粒度被文件边界卡死；二是有些脚本天然就只是一段 setup（比如纯渲染脚本），却被 `<template>`/`<script>` 双块结构绑架，得写一堆样板标签。

- **一句话核心思想**：把「函数体」就地升级成「一个虚拟 SFC 文件」再 import 回来，并用一枚**延迟求值的闭包**当子弹，把外层作用域变量射穿 import 边界、注入进这个虚拟文件里。

- **设计动机（为什么需要它）**：组件内联组合的最大障碍是 ES module 的 import 边界天然**切断闭包**——子文件拿不到父文件的局部变量。本章用「虚拟文件 + 闭包子弹」绕开这条铁律，让内联子组件既能享受完整 SFC 编译流程（props/emits/JSX/HMR/类型工具全可用），又能直接复用父作用域变量。三个宏按**侵入度递增**构成一条谱系：最轻的只做标签改名（给 `.vue` 加 `<setup>` 块），中等的把整份 `.setup` 脚本用一个 `<script setup>` 包起来，最重的才跨文件抽虚拟子模块。承前提示——
  - 「虚拟模块桥接编译期与运行时」机制**（已在第 3 章『编译期注入虚拟 helper 模块』讲透，本章只看它的新侧面：拦截虚拟 id 后 `load` 返回的不再是单个 helper 函数模块，而是一段【合成的完整 SFC】，且这段 SFC 还会流回 Vue 编译器被二次编译）**；
  - 「magic-string 增量编辑 + 懒 babelParse」机制**（已在第 1 章『SFC 解析与增量 AST 编辑』讲透，本章只看它的新侧面：用来做 SFC 结构的【文本级拼装与标签改名】，而非 setup 内部表达式的偏移改写）**。

- **关键权衡（选择 → 换来 → 代价）**：
  1. 选择「把内联组件函数体抽成一个虚拟 `.vue` 子模块再 import 回来」→ 换来子组件走完整 Vue 编译流水线、被工具链识别为正经组件 → 代价是要用 **scan / transform / load / postTransform 四阶段**跨 **pre 与 post 两个 enforce 钩子**协调，每个组件还得伪造唯一虚拟路径。
  2. 选择「用延迟求值闭包 `() => ({ a, b, c })` 当作用域载体，而非直接拷值」→ 换来能捕获**尚未初始化**的变量（`var` 提升、自引用的导出名）并保留引用活性 → 代价是注入的是「现读现取」的快照函数，外层重赋值会渗透进来，语义不透明。
  3. 选择「在调用点自动收集全部可见作用域声明，load 时再扣掉子组件自身声明的变量」→ 换来用户无须手写依赖列表 → 代价是会把**用不上的变量也打进闭包**，且依赖作用域分析正确识别块作用域。
  4. 选择「虚拟 SFC 必须经 Vue 编译器二次编译，故把作用域参数注入拆进 Post 插件」→ 换来注入能精确发生在「Vue 把 setup 编成组件工厂之后」→ 代价是一个宏占据 pre/post 两个槽位，且 Post 要同时处理「主入口」与「脚本子块」两种产物 id。

- **最小心智模型（以最复杂的内联组件为例，6 步）**：
  1. **扫描**：在源文件里找出所有内联组件函数体（按宏调用名或 `: SetupFC` 类型注解识别），同时记下每个调用点此刻**沿作用域链可见的全部变量名**。
  2. **改写调用点**：把函数体擦除，换成「导入名( () => ({ 可见变量列表 }) )」——一枚返回变量快照的闭包；文件顶部加一行 import，指向一个不存在的虚拟 `.vue` 路径。
  3. **拦截虚拟模块**：打包器来加载这个虚拟文件时，`load` 钩子**现场合成**内容——把原函数体用 `<script setup>` 包起来，并在最前面插一行解构语句，把闭包子弹解包成本地变量。
  4. **渲染接管**：把函数体里的 `return () => <JSX>` 改写成渲染来源标记，留给下游宏处理。
  5. **Vue 二次编译**：合成的 SFC 流回 Vue 编译器，被正常编成组件工厂。
  6. **编译后穿针**：Post 钩子在 Vue 产物上把 `export default 组件工厂` 改成「接收作用域参数的箭头函数」——于是步骤 3 那行解构调用就接到了步骤 2 传进来的闭包子弹，外层变量穿过 import 边界注入完成。
  - 谱系里另外两个宏是这条链的子集：标签改名宏停在第 1 步的文本替换；整文件包裹宏停在第 3 步的单文件拼装——它们都不跨文件、不需要闭包子弹。

- **最小原理演示**：
  - **应演示**：一段 ~35 行的极简骨架——给一个内联函数，(a) 在调用点生成 `() => ({ 外层变量 })` 闭包并指向虚拟路径；(b) 用一个 mock load 钩子把函数体包成虚拟 SFC 字符串，顶部插 `const {...} = ctx()`；(c) 用一个 mock「Vue 编译后」步骤把 default export 包成 `(ctx) => factory`；(d) 跑一遍，打印子组件读到了外层变量、且对外层 `var` 提升/自引用也能正确读到。这段演示演的是权衡 #1（虚拟文件换完整编译）+ 权衡 #2（闭包子弹穿 import 边界）。
  - **应故意省略**：多组件索引、HMR、作用域链上溯的完整实现、真 props/JSX 编译、Post 的主入口/脚本子块双分支。
  - **演示载体建议**：纯 Node 脚本即可（**不需要真 Vue、不需要真打包器**），用字符串模板模拟 load 合成 + 一个假的「compileSFC」函数模拟二次编译，能 `node` 直接跑并打印「外层变量穿透成功」。理由：本章原理是「文本拼装 + 闭包穿针」，与 Vue 运行时无关，载体越轻越能演透；切勿套 JSX/Vite 工具链喧宾夺主。

- **正文不宜展开的细节**：Post 钩子对「Vite 主入口 id」与「`?vue&type=script` 脚本子块 id」两种产物形态的分支差异（两者参数名都不同）；`resolveId` 里 rollup/vite 专属的「子模块里的相对 import 要回到主模块去 resolve」逻辑；整文件包裹宏里把 esbuild 的 include/exchange 互换以防 esbuild 抢先转译的 config hack；`hotUpdate` 递归收集子模块做失效的细节；路径正则里兼容 vite-pages 之类插件的否定向前看边界。

- **推荐的一个执行轨迹例子**：
  输入片段 `const foo='foo'; var baz; export const App = defineSetupComponent(() => { console.log(foo, baz, App) })`
  → 调用点改写后：`const App = __MACROS_setupComponent_0(() => ({ foo, App, baz }))`（`baz` 是 `var`、`App` 是自引用，靠延迟闭包才读得到真值）
  → load 合成的虚拟 SFC：`<script setup>const { foo, App, baz } = __MACROS_ctx(); console.log(foo, baz, App)</script>`
  → Vue 编译 + Post 穿针后：组件工厂变成 `(__MACROS_ctx) => defineComponent({ setup(){ const {foo,App,baz} = __MACROS_ctx(); ... } })`，而调用点把外层那枚 `() => ({foo,App,baz})` 闭包经工厂调用传入——setup 内读到的就是父作用域真实变量。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- 三个宏构成**侵入度递增**的谱系：`setup-block`（标签改名，纯文本）< `setup-sfc`（整文件文本拼装）< `setup-component`（跨文件虚拟模块 + 作用域注入）。源码位置: packages/setup-block/src/core/index.ts:8-62、packages/setup-sfc/src/core/index.ts:10-29、packages/setup-component/src/core/index.ts:41-202
- **setup-block**：用 `@vue/compiler-dom` 的 `parse` 以 `parseMode:'sfc'` 解析，自定义 `getTextMode` 让顶层非 `<template>` 标签（及带 `lang` 的 `<template>`）按原始文本处理，再对 `<setup>` 子节点做基于偏移的标签串改写（`<setup` → `script setup`、`setup>` → `script>`）。源码位置: packages/setup-block/src/core/index.ts:15-58
- **setup-sfc**：匹配 `.setup.[cm]?[jt]sx?`（REGEX_SETUP_SFC_SUB）；找到 `export default <expr>`，追加 `defineRender(<expr>);` 并删除原 export，然后把**整个文件剩余内容**用 `<script setup lang="..."> ... </script>` 文本包起来。源码位置: packages/setup-sfc/src/core/index.ts:18-26、常量 packages/common/src/constants.ts:24-25
- **setup-component 的两种识别写法**：(1) `defineSetupComponent(() => {...})` 函数调用；(2) `const comp: SetupFC = () => {...}` 类型注解变量声明。两者都要求 init 是 FunctionExpression/ArrowFunctionExpression，否则抛 SyntaxError。源码位置: packages/setup-component/src/core/index.ts:70-107、类型名常量 packages/setup-component/src/core/constants.ts:5
- **作用域收集**：`getScopeDecls` 从当前 scope 沿 `scope.parent` 一路上溯，把各层 `declarations` 的键并成一个去重集合——这就是「调用点可见的全部变量名」的来源。源码位置: packages/setup-component/src/core/index.ts:288-295、上溯使用处 :62-67/:95-97
- **闭包子弹的生成**：transform 把整个调用节点覆写成 `导入名(() => ({ 变量1, 变量2, ... }))`——注意是 `() => ({...})` 延迟求值，而非直接对象字面量。源码位置: packages/setup-component/src/core/index.ts:145-157
- **虚拟 id 编码**：每个内联组件伪造路径 `<原id>-setup-component-<i>.vue`；常量定义后缀与两条正则（一条精确匹配 `.vue$` 用于 load，一条更宽用于判定子模块）。源码位置: packages/setup-component/src/core/constants.ts:1-3
- **load 合成 SFC 的三步拼接**：(a) `return <expr>` → `defineRender(<expr>);`（渲染来源交给下游 define-render 宏）；(b) 顶部插 `const { 外层变量 } = __MACROS_ctx();`，且**扣掉子组件函数体自身声明的变量**（rootVars，避免覆盖局部变量）；(c) 把原文件的 import 语句再前置、最后用 `<script setup lang>` / `</script>` 包裹。源码位置: packages/setup-component/src/core/index.ts:181-199
- **二次编译后的穿针（Post）**：Vue 把合成 SFC 编成 `export default 组件工厂` 后，Post 钩子在 Vite 主入口 `.vue` 上把 `export default _export_sfc(_sfc_main, [...])` 改成 `(ctx) => _export_sfc(_sfc_main(ctx), [...])`；在 `?vue&type=script` 脚本子块上把 `export default defineComponent({...})` 改成 `(__MACROS_ctx) => defineComponent({...})`。两层参数名不同但传递同一枚闭包。源码位置: packages/setup-component/src/core/index.ts:243-285
- **Pre/Post 拆分的必然性**：调用点改写 + 虚拟合成必须**先于** Vue 编译（pre），而作用域参数注入必须**后于** Vue 编译（post），所以一个宏拆成两个 enforce 钩子。源码位置: packages/setup-component/src/index.ts:49-130
- **跨宏组合**：setup-component 与 setup-sfc 都把渲染来源写成 `defineRender(...)`，依赖下游 define-render 宏（template-and-render-redirect 章）真正落地渲染函数——即本章产出的是「带标记的 SFC」，渲染语义由别的宏消费。常量源码位置: packages/common/src/constants.ts:12

## 关键调用链

**setup-component（最复杂，跨 Pre/Post）**：
```
[Pre·transform] scanSetupComponent(code,id)  →  收集 {函数体, 可见作用域变量} 并存入 ctx[id]
                  └─ getScopeDecls(scope) 沿 scope.parent 上溯汇聚声明
[Pre·transform] transformSetupComponent      →  调用点覆写为 __MACROS_setupComponent_i(() => ({...vars...}))，prepend import '<id>-setup-component-i.vue'
[Pre·resolveId] 命中虚拟 id 直接 return id（占位"已解析"）；子模块内相对 import 回主模块 resolve
[Pre·load]      loadSetupComponent(virtualId, ctx, root)
                  ├─ 从 ctx 取第 i 个组件的 body + scopes
                  ├─ return <expr>  → defineRender(<expr>);
                  ├─ prepend `const { 外层变量 \ rootVars } = __MACROS_ctx();`
                  └─ 用 <script setup lang> ... </script> 包裹 → 返回合成 SFC 字符串
   ↓ 该字符串流回 Vue 编译器，被编成 export default defineComponent({...}) / _export_sfc(_sfc_main,...)
[Post·transform] transformPost(code,id)
                  ├─ 主入口 .vue：export default X  →  (ctx) => X ；_sfc_main  →  _sfc_main(ctx)
                  └─ type=script：export default X  →  (__MACROS_ctx) => X
   ⇒ 调用点的 () => ({...}) 闭包经 _sfc_main(ctx) 传入，setup 内 __MACROS_ctx() 解包出外层变量
```
源码位置: packages/setup-component/src/core/index.ts:132-160（transform）、:162-202（load）、:229-286（post）；unplugin 接线 packages/setup-component/src/index.ts:60-101（pre）、:106-130（post）

**setup-sfc（单文件，无 Post）**：
`transformSetupSFC` → 找 `export default` → 追加 `defineRender(...)` + 删 export → 全文包 `<script setup>` → 流回 Vue 编译。源码位置: packages/setup-sfc/src/core/index.ts:10-29

**setup-block（最轻，标签改名）**：
`transformSetupBlock` → compiler-dom parse(sfc) → 遍历子节点 → 对 `<setup>` 用 magic-string 偏移改写开/闭标签。源码位置: packages/setup-block/src/core/index.ts:41-58

## 源码摘录（带行号，全文累计 ≤ 30 行）

调用点扫描 + 作用域收集（识别两种写法、沿作用域链汇聚可见变量）：
```ts
// packages/setup-component/src/core/index.ts:62-93
let scope = attachScopes(program as any, 'scope')
walkAST(program, {
  enter(node) {
    if (node.scope) scope = node.scope
    const scopes = getScopeDecls(scope)
    if (isCallOf(node, DEFINE_SETUP_COMPONENT)) {
      components.push({ fn: node, decl: node.arguments[0], scopes })
    } else if (/* VariableDeclarator 且 id 带 `: SetupFC` 类型注解 */ node.init) {
      components.push({ decl: node.init, scopes })
    } else if (node.type === 'ImportDeclaration') {
      imports.push(code.slice(node.start!, node.end!))
    }
  },
  leave(node) { if (node.scope) scope = scope.parent! },
})
```

调用点覆写为**延迟闭包子弹** + 注入虚拟 import（核心一句话的实现）：
```ts
// packages/setup-component/src/core/index.ts:145-157
for (const [i, { node, scopes }] of components.entries()) {
  const importName = `${HELPER_PREFIX}setupComponent_${i}`
  s.overwrite(node.start!, node.end!,
    `${importName}(() => ({ ${scopes.join(', ')} }))`)          // ← 延迟求值闭包
  s.prepend(`import ${importName} from '${id}${SETUP_COMPONENT_ID_SUFFIX}${i}.vue'\n`)
}
```

load 合成虚拟 SFC：渲染接管 + 闭包解包（扣掉自身变量）+ SFC 包裹：
```ts
// packages/setup-component/src/core/index.ts:181-199
for (const stmt of program.body) {
  if (stmt.type !== 'ReturnStatement' || !stmt.argument) continue
  s.overwriteNode(stmt, `defineRender(${s.sliceNode(stmt.argument)});`)   // return → defineRender
}
const rootVars = Object.keys(attachScopes(program as any, 'scope').declarations)
s.prepend(`const { ${scopes.filter((n) => !rootVars.includes(n)).join(', ')} } = ${HELPER_PREFIX}ctx();\n`)
for (const i of imports) s.prepend(`${i}\n`)
s.prepend(`<script setup${lang ? ` lang="${lang}"` : ''}>\n`)
s.append(`</script>`)
```

Post 穿针：把 Vue 产物包成接收作用域参数的箭头函数（主入口分支）：
```ts
// packages/setup-component/src/core/index.ts:248-263
if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
  s.prependLeft(exportDefault.leadingComments?.[0].start ?? exportDefault.start!, '(ctx) => ')
} else if (node.name === '_sfc_main' && parent?.callee?.name === '_export_sfc') {
  s.appendLeft(node.end!, '(ctx)')   // _sfc_main  →  _sfc_main(ctx)
}
```

对照——最轻的 setup-sfc 全文（整文件拼装、不跨文件、无闭包）：
```ts
// packages/setup-sfc/src/core/index.ts:18-26
for (const stmt of program.body) {
  if (stmt.type !== 'ExportDefaultDeclaration') continue
  s.append(`defineRender(${s.sliceNode(stmt.declaration)});`)
  s.removeNode(stmt)
}
const attrs = lang ? ` lang="${lang}"` : ''
s.prepend(`<script setup${attrs}>`)
s.append(`</script>`)
```

## 易混淆 / 边界 / 推断

- **事实**：闭包子弹用 `() => ({...})` 而非 `{...}`，是本章最易被忽略却最关键的细节——它使 `var baz`（提升但未初始化）和自引用的导出名 `App` 都能被正确读到（snapshot `context.tsx` 证实：`baz` 声明在调用点之后、`App` 是组件自身导出，二者在调用求值时均不可用，靠 setup 内延迟调用才取到值）。源码位置: packages/setup-component/src/core/index.ts:151、佐证 packages/setup-component/tests/__snapshots__/fixtures.test.ts.snap:171-191
- **事实**：load 注入的外层变量会**扣掉子组件函数体自身声明的变量**（rootVars），避免覆盖局部变量——如 `context.tsx` 组件 #0 内有局部 `const bar='BAR'`，故注入列表不含 `bar`。源码位置: packages/setup-component/src/core/index.ts:187-194
- **推断（标注为推断）**：Post 钩子之所以同时处理 `.vue` 主入口（用 `(ctx)`）和 `?vue&type=script` 子块（用 `(__MACROS_ctx)`）两种 id，是因为 Vite 会把一个 SFC 拆成「主入口 JS」+「脚本子块」两次编译产物，两层都必须接上作用域参数，闭包才能从调用点一路传到 setup 内部；参数名不一致应是历史演进而非设计必要。
- **事实**：setup-component 的 `resolveId` 对 rollup/vite 额外做「子模块内的相对 import 回到主模块 resolve」（`getMainModule` + `skipSelf`），因为虚拟路径并非真实目录，相对 import 默认会解析失败。源码位置: packages/setup-component/src/index.ts:63-72、packages/setup-component/src/core/sub-module.ts:7-9
- **事实**：setup-sfc 在 vite 的 `config` 钩子里把 esbuild 的 include/exclude **互换**，目的是阻止 esbuild 在宏之前抢先转译 `.setup.tsx`（否则 JSX 早被擦除，宏拿不到 `export default` 的原始形态）。源码位置: packages/setup-sfc/src/index.ts:40-48
- **边界**：`scanSetupComponent` 的 `babelParse` 包在 try/catch 里，解析失败直接返回 undefined（跳过该文件），与第 1 章「懒解析容错」一脉相承。源码位置: packages/setup-component/src/core/index.ts:47-51
- **未理解 / 待 Writer 淡化**：`REGEX_SETUP_SFC_SUB` 中 `((?!(?<!definePage&)vue&).)*$` 这段否定向前看的精确边界语义（推测为兼容 vite-pages/unplugin-vue-router 等给 `.setup.ts` 附加 `?vue&` 查询串的场景），建议正文不展开。源码位置: packages/common/src/constants.ts:24-25
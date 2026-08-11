# 编译期注入虚拟 helper 模块

> 本章属于 primitive 层。前置：「一次编写、六套构建器适配的 unplugin 模式」。
> 学完你能：用一句话讲清「宏如何往用户源码里塞一段自己实现的运行时帮手，而又不让那段代码以文件形式真实存在于用户项目里」，以及这么做换取了什么、付出了什么。

## 1. 为什么需要它

上一章把宏的实现拆成了两半：一个纯函数 `transformXxx(code, id)` 做源码改写，外面套 `createUnplugin` 自动长出六套构建器入口。但这套外壳默认只用了 `transform` 这一面——给现有代码改文字、挪 AST 节点。很多宏其实还想干一件更激进的事：**给用户源码塞一段运行时支持代码**。

比如 `defineModels`：它把每个字段编译成一个可写 ref，这个 ref 在运行时要靠一段「把 props 和对应的 `update:` 事件粘起来」的函数才能真正工作。这段函数不是用户写的，也不该让用户去手动安装，它必须由宏自己带。

那这段帮手代码到底该住哪？两条路都不好走：

- **住进用户项目**：要拷一份文件过去，污染源码树；宏升级了帮手的实现，用户的拷贝跟不上；版本同步成了噩梦。
- **完全内联到每一处调用点**：每用一次宏，就把整段帮手源码复制一遍贴进 setup 顶部。产物会膨胀，多组件之间也无法共享同一份实现。

两条路都把「注入点」与「实现」耦合死了。本章要解决的矛盾就是：宏想往源码里塞运行时代码，但那段代码既不能住进用户的磁盘、又不能就地膨胀。

幸运的是 `createUnplugin` 外壳还暴露了 `resolveId`、`load` 这些模块解析钩子——这正是给运行时帮手「凭空」找地方住的关键。

## 2. 核心思想

**编译期只往源码插一行指向虚构路径的 import，运行时由插件冒充这个虚构模块、当场把实现代码交出来。**

关键在于「虚构」二字——这条 import 路径在磁盘上根本不存在，但它被插件用三件套拦住了：解析时认领、加载时交货、必要时声明「我能加载」。从此「注入点」就只是一行字符串，真正的实现集中在宏自己的包里，两边只在加载的瞬间相遇。

## 3. 心智模型

一段虚拟 helper 模块的完整生命周期是这样走的：

1. **编译期注入**：宏在改写用户源码时，在 setup 顶部插一行 `import 本地名 from "<虚构路径>"`，同时把原来对宏的调用改写成对这个本地名的调用。
2. **路径前缀分层**：所有 vue-macros 虚拟模块共享 `/vue-macros` 这个统一前缀，每个特性在自己的命名空间下挂具体帮手，比如 `/vue-macros/define-models/use-v-model`。任何插件用 `startsWith` 一眼就能认出哪些 id 归自己管。
3. **构建器尝试解析**：构建器拿到一行新 import，逐个问已注册的插件「你能认领这个路径吗？」。
4. **插件认领**：本插件看到前缀匹配，返回 id 本身。这一步把虚构路径**固化为模块标识**，相当于告诉构建器「别去磁盘找文件，这就是个真模块」。
5. **构建器要求加载**：构建器随后要从这个标识拿到模块代码。某些构建器在加载前还要再问一次「这个 id 你确实能加载吗？」，于是 `loadInclude` 这个过滤器再用同样的前缀答「能」。
6. **插件交出实现**：`load` 钩子按精确 id 匹配，把预先以字符串形式备好的源码作为模块内容返回。
7. **进入正常打包**：帮手代码此后就和其他用户代码一样被打进产物、一起运行。

其中最值得点出的是第 6 步的一个巧思：插件交出的字符串不是手写硬编码的，而是用 `?raw` 把同目录下那份运行时实现文件**以字符串形式导进来**。于是「帮手的实现」与「load 要交出的内容」是同一份文本，改一处两边同步生效。

## 4. 关键权衡

### 用虚构路径当 import 目标，换注入点与实现彻底解耦

宏的注入器在改写源码时，把 import 的 `from` 写成 `/vue-macros/define-models/use-v-model` 这样的前缀路径——磁盘上**根本没有这个文件**。换来的是：帮手代码集中住在自己的包里，用户源码树一尘不染；多个特性可以共用同一个虚构模块机制（结构扩展、命名模板都通过它注入）；宏升级时帮手实现也跟着自动更新，没有版本同步问题。

代价是：必须实现一整套**模块解析拦截**才能让那行 import 不报错——认领解析、声明可加载、加载三步缺一不可，而且这套拦截要在 vite/rollup/webpack/esbuild/rspack/rolldown 六套构建器下都成立。不同构建器对「插件能拦截到哪一步」的约定有差异，某些构建器需要额外的 `loadInclude` 过滤器才知道哪些 id 该进 load，跨构建器的虚拟 id 还要按 `framework` 后缀分流。

化解的本质矛盾：**「注入点」想尽可能轻（一行字符串），「实现」想尽可能厚（带响应式逻辑的函数）**。把两者用虚构路径切开，让轻的轻到只是一行 import，厚的厚到可以是一个完整模块。

### 帮手源文件即被加载内容，换实现永不漂移

声明虚构 id 的同时，用 `?raw` 把同目录下那份运行时实现文件以字符串形式导入：

```ts
// 等价于 import useVmodelHelperCode from './use-vModel?raw'
import { readFileSync } from 'node:fs'
const useVmodelHelperCode = readFileSync('./use-vModel.ts', 'utf-8')
```

`load` 钩子直接返回这段字符串。换来的是：**实现与被加载内容是同一份文本**——开发者改 `use-vModel.ts` 的实现，下一次构建交出去的就是新版，永远不会出现「声明里说的」与「加载时给的」对不上的漂移。

代价是依赖一个**约定**：构建器必须支持「以原始字符串形式导入文件」这种 `?raw` 用法。这是个被 vite/rollup 广泛支持但并非标准的约定，遇到不支持的构建器就得退化为「构建期把文件读成字符串」。此外，帮手源文件里不能含**仅编译期有效、运行期会塌掉的语法**——它现在要作为运行时模块原封不动地交出去，编译期擦除掉的类型注解或宏调用都不能残留。

化解的本质矛盾：**「声明虚构模块」是一次事，「交付内容」是另一次事**。用 `?raw` 自引用把这两件事焊死成同一份文本，从机制层面消灭了不一致的可能。

### 统一前缀 + WeakMap 去重，换帮手只注入一次且绝不撞名

注入器给所有本地名都加一段 `__MACROS_` 前缀（比如 `__MACROS_useVModel`），并用一个以 magic-string 实例为键的 WeakMap，按「来源文件 @ 导入名 @ 前缀 @ 本地名」做去重。换来的是：同一个帮手在一处源码里被引用十次也只插一行 import；前缀保证了它绝不会和用户自己写的变量撞名。

代价是：用户在最终产物里看到的变量名是被改写过的、对人类不友好；调试时 stack trace 里会冒出 `__MACROS_xxx` 这种名字，需要靠 sourcemap 才能对回源码。前缀的选择也是单向门——一旦发布就不能改，否则用户已有的代码可能与新前缀不期而遇地撞名。

化解的本质矛盾：**「全局唯一性」与「不打扰用户命名空间」**。前缀把名字空间隔离，去重把同次构建的多次引用合并，组合起来既保证正确又控制了产物体积。

## 5. 最小原理演示

下面这段脚本手写一条「转换 → 认领 → 加载 → 字符串拼装 → 求值」的最小流水线，**不依赖真实 vite/rollup**，演透「import 一个不存在的路径却没报错、反而拿到了实现」这件事。

```ts
// 全局前缀：所有虚拟模块共享，认领靠 startsWith 一眼判断
const HELPER_PREFIX = '/vue-macros/helper'

// 帮手实现：以字符串形式预先备好，对应实际仓库里用 ?raw 读同目录文件
const helperSource = `
export default function greet(name) {
  return 'hello ' + name
}
`

// 转换阶段：在用户源码顶部插一行 import，并把宏调用改写为对导入名的调用
function transform(code: string): { code: string; helperLocal: string } {
  const helperLocal = '__MACROS_greet'   // 加内部前缀避免与用户变量撞名
  const importLine = `import ${helperLocal} from "${HELPER_PREFIX}/greet"\n`
  const rewritten = code.replace(/\bgreet\(/g, `${helperLocal}(`)
  return { code: importLine + rewritten, helperLocal }
}

interface Plugin {
  resolveId(id: string): string | null
  load(id: string): string | null
}

// 模拟一个最小构建器：走完「解析 → 加载 → 拼装」三步
function miniBundler(userCode: string, plugin: Plugin): string {
  const { code: transformed } = transform(userCode)
  const importRe = /import\s+(\w+)\s+from\s+"([^"]+)"/g
  let finalCode = transformed

  for (const match of transformed.matchAll(importRe)) {
    const [line, local, specifier] = match

    // 解析钩子：插件认领路径并返回模块标识，从而阻止磁盘查找
    const resolved = plugin.resolveId(specifier)
    if (resolved == null) throw new Error('module not found: ' + specifier)

    // 加载钩子：插件按 id 交出预先备好的源码字符串
    const loaded = plugin.load(resolved)
    if (loaded == null) throw new Error('module empty: ' + resolved)

    // 拼装：把 import 行替换为 inline 实现，将 export default 改写为 const 赋值
    const inlined = loaded.replace('export default ', `const ${local} = `)
    finalCode = finalCode.replace(line, inlined)
  }
  return finalCode
}

const plugin: Plugin = {
  // 认领：前缀匹配即视为本插件管的真实模块标识
  resolveId(id) {
    return id.startsWith(HELPER_PREFIX) ? id : null
  },
  // 加载：按 id 交出预先备好的源码字符串
  load(id) {
    return id.startsWith(HELPER_PREFIX) ? helperSource : null
  },
}

// 用户源码：调用 greet('Vue')
const userCode = `const r = greet('Vue')\nconsole.log(r)`

// 跑流水线
const bundled = miniBundler(userCode, plugin)
console.log(bundled)
// 输出（拼装后）：
//   const __MACROS_greet = function greet(name) {
//     return 'hello ' + name
//   }
//   const r = __MACROS_greet('Vue')
//   console.log(r)

// 求值，验证虚构模块确实命中了实现
new Function(bundled)()   // 打印：hello Vue
```

跑完可以看到：用户写的是 `greet('Vue')`，磁盘上根本不存在 `/vue-macros/helper/greet` 这个文件，但经过三步拦截后，调用真的命中了帮手函数。这就是「用虚拟模块桥接编译期与运行时」的全部魔法——注入点与实现解耦，靠虚构路径在加载瞬间接通。

## 6. 执行轨迹

拿一句具体的宏调用走一遍——

**输入**（用户源码片段，简化示意）：

```ts
// 用户在 <script setup> 里写：
const visible = defineModels<{ visible: boolean }>().visible
```

**编译期转换**（宏的 transform 阶段，往源码注入 import 并改写调用）：

```ts
import __MACROS_useVModel from '/vue-macros/define-models/use-v-model'

const visible = __MACROS_useVModel(['visible', 'visible', 'onUpdate:visible'])
```

注意 import 的路径在磁盘上不存在——这是后面的拦截能成立的关键。

**构建器解析阶段**：构建器拿到这行 import，依次询问每个插件。`resolveId('/vue-macros/define-models/use-v-model')` 在本插件里命中前缀，返回 id 本身。虚构路径被固化为模块标识，构建器不再尝试去 `node_modules` 或磁盘找文件。

**构建器加载阶段**：构建器要拿这个标识的代码。本插件的 `load` 命中前缀，返回通过 `?raw` 预先读好的 `use-vModel.ts` 源码字符串——一段大约二十行的运行时实现，里面用响应式库把 props 和 emit 粘成可写 ref。

**进入打包**：这段帮手代码从此就和用户写的其他代码一样，被构建器当成正常模块处理。参与 tree-shaking、被打进同一个 chunk、最终在浏览器里一起运行。运行时 `__MACROS_useVModel(...)` 调用命中的就是这段被注入的实现。

至于这段实现**内部**怎么把 props 和事件粘成可写 ref，那是 `defineModels` 的内核，本章只关心它如何被装载进产物。

## 7. 教学简化说明

本章演示故意省略了：

- 多构建器适配的细节（vite/rollup/webpack/rspack 在 `resolveId/load/loadInclude` 上的约定差异），上一章已经讲过这套外壳，本章只取拦截语义本身。
- `?raw` 这一约定在不同构建器下的退化实现路径。
- 帮手 `useVModel` 内部如何用响应式库粘合 props 与 emit 的具体语义（属第 5 章）。
- 「赋值即触发事件」模式下赋值表达式如何被 walkAST 改写、并复用同一套虚拟模块机制注入另一个帮手 `emit-helper`（属第 5 章）。
- `__MACROS_` 前缀 + WeakMap 去重的工程实现、与 sourcemap 对齐的细节。

## 8. 小结

虚拟 helper 模块的关键不在「虚拟」二字本身，而在它把整件事拆成了**三个独立的关注点**：前缀分层管认领、`?raw` 自引用管实现与交付同步、前缀加去重管命名安全。三者合起来，宏才有了「凭空注入运行时支持」的能力，而又不让那段代码以文件形式真实存在于用户项目里。

但有一类宏根本不需要这种运行时支持——它们只是在编译期把用户写的某种语法糖改写成 Vue 原生宏的等价形态。下一章「props/emit 宏的编译期重写与类型转换」讲的就是这类纯编译期重写器。
# 编译期注入虚拟 helper 模块

## 一个绕不开的矛盾：帮手代码到底该住哪

假设你写了一个 Vue 宏，它在编译期偷偷往用户的 `setup` 顶部塞了一行调用——比如一个叫 `useVModel` 的函数，作用是把某个 prop 和它对应的 `update:xxx` 事件粘成一个能直接读写的变量。这行代码要能跑，前提是 `useVModel` 这个函数在运行时真实存在。

可这个函数该住哪？你怎么想都觉得别扭：

- **住进用户的项目里？** 那就得让用户在源码树里凭空多出一个文件，版本还要跟着宏一起升级，污染人家的代码。
- **内联到每一处调用点？** 同一个帮手被用十次就复制十份实现，产物膨胀，还完全没法复用。

vue-macros 的解法很巧妙：**根本不让这个函数住在磁盘上**。它在编译期只往源码里插一句 `import`，而这个 `import` 指向的路径是**编出来的**——磁盘上压根没这个文件。真正的实现集中住在宏自己的包里，等到构建器来加载这个"假路径"时，由插件当场把实现代码交出来。

这个插件外壳怎么搭、怎么靠 `createUnplugin` 一次写完六套构建器入口，第 2 章已经讲透了，这里不重复。本章只盯它新露出来的这一面：**当宏插进去的 `import` 指向一个不存在的路径时，插件怎么把这个虚构模块"认领"下来、并把它变成一段真正能跑的代码。**

> 一句话核心思想：**编译期只插一句指向虚构路径的 `import`，运行时由插件自己冒充这个模块、把实现代码当场交出来。**

打个比方：这个虚构路径就像一个地图上不存在的门牌号，普通人（构建器默认的文件查找）投递会失败，但邮局内部（插件）知道这封信该转交给谁。说人话就是——**注入点和实现被彻底拆开了**，编译期只负责贴一张"假地址标签"，运行时再由插件按这张标签把真东西递过去。

## 自底向上：先看三块基本件

### 基本件一：一块所有插件都认得的"公共前缀"

要拦截一个虚构模块，插件首先得能一眼认出"这是我家的"。vue-macros 给所有虚拟模块统一加了一段全局前缀 `/vue-macros`，下面再挂各特性的命名空间，比如 `/vue-macros/define-models`，再往下派生具体的帮手路径：

```
/vue-macros                              ← 全局共享前缀，谁都能 startsWith 认领
  └─ /define-models                      ← define-models 的命名空间
       ├─ /use-vmodel                    ← 帮手一：粘合 prop 与事件
       └─ /emit-helper                   ← 帮手二：赋值即触发事件
```

这种"前缀分层"的好处是：任何插件只需一句 `id.startsWith('/vue-macros')` 就能判断这个 id 归不归自己管。它像一块**谁都能看到的公共留言板**——大家约好用同一个抬头发帖，认领时按抬头过滤即可。

### 基本件二：帮手文件就是被加载的内容（自我引用）

这是整个机制里最漂亮的一笔。插件声明虚构 id 的同时，用 `?raw` 把同目录下那个真正的运行时实现文件**以字符串形式**导入进来：

```ts
// 帮手的真实实现，就住在这个文件里
export { default as useVmodelHelperCode } from './use-vModel?raw'
```

`?raw` 是个约定：它让构建器不要去执行、解析这个文件，而是**把它的源代码文本原样当成一个字符串**返回。于是同一段文本身兼两职：

- 它是**帮手的源码**（开发者改的就是它）；
- 它也是 **`load` 钩子要交出的模块内容**。

改一处实现，被加载的内容立刻同步——两者永不漂移，因为它们压根就是同一份文本。换句话说，插件是**拿自己的源文件当成了要交付的商品**，自己引用自己。

### 基本件三：注入器——给帮手取个不撞名的本地名，且只插一次

宏往用户源码里插 `import` 时不能太随意。要是用户代码里恰好也有个叫 `useVModel` 的变量，就撞车了。所以有一个公共的注入函数 `importHelperFn`，它做两件事：

1. **统一加内部前缀** `__MACROS_`：插进去的本地名一定是 `__MACROS_useVModel` 这种，绝不可能和用户代码重名。
2. **按"来源+名字+前缀+本地名"去重**：它用一个以 magic-string 实例为键的缓存记下"这处源码里已经插过这个帮手了"，于是**同一个帮手在一处源码里被引用十次，也只插一条 `import`**。

注入时还区分默认导入和命名导入两种形态，但思路都一样：拿一个安全的本地名，把 `import` 插到 `setup` 顶部。

## 组合件：模块解析拦截三件套

光有前缀和实现还不够。要让一句 `import "/vue-macros/define-models/use-vmodel"` 不报错地拿到代码，插件必须在 unplugin 实例里同时实现三个钩子。这三个钩子是一条流水线上的三道关：

```
构建器拿到 import "/vue-macros/.../use-vmodel"
        │
        ▼
  ① resolveId   ── 认领：前缀对得上？把虚构路径钉死成模块标识，挡住磁盘查找
        │
        ▼
  ② loadInclude  ── 报名：告诉构建器"这个 id 我能加载"（部分构建器必需）
        │
        ▼
  ③ load         ── 交货：按精确 id 匹配，返回对应的 ?raw 源码字符串
        │
        ▼
  帮手代码进入正常打包流程，和用户代码一起进产物
```

**① `resolveId`：认领，把虚构路径钉死成模块标识。**

构建器每遇到一个 `import`，都会挨个问插件"这个路径归你管吗"。本插件的回答很干脆：只要 id 以 `/vue-macros` 开头，就返回 id 本身——这一步的真正作用是**把一个虚构路径固化成一个确定的模块标识，从而阻止构建器再去磁盘上找文件**。如果不认领（返回空），构建器就会老老实实去文件系统里找 `/vue-macros/...`，结果当然是找不到，直接抛"模块解析失败"。

**② `loadInclude`：先报上名，说"我能加载"。**

有些构建器（典型如 webpack 系）不会无脑把每个 id 都送进 `load`，而是先问一句"哪些 id 你打算加载"。`loadInclude` 就是用来回答这个问题的过滤器——同样以前缀做判断。没有它，在某些构建器下你的 `load` 根本不会被调用，虚构模块就成了断头路。

**③ `load`：按精确 id 交出源码。**

到了这一步，构建器已经认定"这个模块归你加载，请给代码"。插件按精确的 id 匹配：是 `use-vmodel` 就交出 `useVmodelHelperCode`，是 `emit-helper` 就交出 `emitHelperCode`。交出来的，正是基本件二里那段 `?raw` 字符串。

三件套缺一不可：少了 `resolveId`，构建器去磁盘扑空；少了 `loadInclude`，部分构建器压根不进 `load`；少了 `load`，认领了也没东西可交。**三者合起来，才在多构建器下都站得住。**

## 一次完整的心智轨迹

把上面几块串起来，从用户写下一句宏，到帮手跑起来，是这样一条路：

```
A. 用户在 setup 里写了 defineModel('title')
        │  宏在转换阶段：
        ▼
B. setup 顶部被插入 import useVModel from "/vue-macros/define-models/use-vmodel"
   原来的宏调用被改写成 useVModel('title')
        │  构建器尝试解析这行新 import：
        ▼
C. resolveId 认领 → 把虚构路径钉成模块标识，不去磁盘找
        │  构建器要加载这个标识：
        ▼
D. loadInclude 放行 → load 按精确 id 交出 ?raw 源码字符串
        │  帮手代码进入正常打包：
        ▼
E. 帮手与用户代码一起被打进产物 → 运行时 useVModel('title') 真实生效
```

注意：**编译期插的只是一张"假地址标签"，运行时才由插件把真东西递过去。** 这条拆分，就是本章全部设计的落点。

## 最小原理演示

下面这段脚本不依赖任何真实构建器，手写了一条"转换 → 认领 → 加载 → 拼装 → 求值"的最小流水线。你存成 `virtual-helper-demo.js`，用 `node virtual-helper-demo.js` 就能跑。重点不是它多完备，而是让你**亲眼看见**：import 一个磁盘上不存在的路径，没有报错，反而拿到了实现。

```js
// virtual-helper-demo.js —— node virtual-helper-demo.js

// ===== ① 虚构路径的分层前缀 =====
const VIRTUAL_PREFIX = '/vue-macros'                       // 全局共享前缀
const helperPrefix   = `${VIRTUAL_PREFIX}/define-models`   // define-models 命名空间
const vmodelId       = `${helperPrefix}/use-vmodel`        // 具体帮手 id

// ===== ② 帮手实现：load 时要交出的"模块内容" =====
// 真仓库里这串文本来自 use-vModel.ts 的源码（用 ?raw 以字符串导入）；
// 这里手写一份等价骨架：把 props[k] 的读、update:k 事件的发，粘成一个可写引用。
const useVModelCode = `
export default function useVModel(key) {
  return {
    get value() { return state.props[key] },
    set value(v) { state.emit('update:' + key, v) },
  };
}`

// ===== ③ 插件：模块解析拦截三件套 =====
const plugin = {
  // (a) 认领：前缀对得上就把虚构路径钉成模块标识，挡住磁盘查找
  resolveId(id)   { return id.startsWith(VIRTUAL_PREFIX) ? id : null },
  // (b) 报名：告诉构建器"这个 id 我能加载"
  loadInclude(id) { return id.startsWith(VIRTUAL_PREFIX) },
  // (c) 交货：按精确 id 匹配，返回源码字符串
  load(id)        { return id === vmodelId ? useVModelCode : null },
}

// ===== ④ 宏在转换用户源码时做的事 =====
// 转换前：用户写了句声明双向绑定的调用
//   const title = defineModel('title')
// 转换后：顶部多了指向虚构路径的 import，调用被改写成对帮手的调用
const entryAfterTransform = `
import useVModel from "${vmodelId}";
const title = useVModel('title');`

// ===== ⑤ 模拟构建流水线：resolveId → load → 拼装 → 求值 =====
function buildAndRun() {
  // 5.1 把入口里的 import 拆出来：拿到的 fromId 是个磁盘上不存在的虚构路径
  const m = entryAfterTransform.match(/import\s+(\w+)\s+from\s+"([^"]+)";?/)
  const [, localName, fromId] = m

  // 5.2 构建器问插件认不认领；认领了就不会去磁盘扑空
  const resolved = plugin.resolveId(fromId)
  if (resolved == null) throw new Error(`找不到模块 ${fromId}`)

  // 5.3 构建器要加载；插件按精确 id 交出源码字符串
  const code = plugin.load(resolved)

  // 5.4 拼装：把"默认导出"改成具名绑定，替换掉用户代码里的 import 行
  const bundle =
    code.replace(/export default/, `const ${localName} =`) +
    '\n' +
    entryAfterTransform.replace(m[0], '')

  // 5.5 求值：注入一个假的 Vue 运行时（props + emit），看帮手是否生效
  const state = {
    props: { title: 'hello' },
    emitted: [],
    emit(name, val) { this.emitted.push([name, val]) },
  }
  const run = new Function('state', bundle + `
    const before = title.value;        // 读：应拿到 props.title
    title.value = 'changed';           // 写：应触发 update:title 事件
    return { before, emitted: state.emitted };
  `)
  return run(state)
}

console.log(buildAndRun())
// { before: 'hello', emitted: [ [ 'update:title', 'changed' ] ] }
```

执行轨迹一目了然：

```
入口 import 的 fromId  = /vue-macros/define-models/use-vmodel   （磁盘上没有）
resolveId(fromId)      → 该 id 本身                          （认领，挡住磁盘查找）
load(resolved)         → useVModelCode 那段字符串             （交出实现）
拼装后 bundle          → 帮手定义 + 用户代码，import 行已被替换
求值结果               → 读到 'hello'；写之后发出 ['update:title','changed']
```

`fromId` 这个路径在任何文件系统里都查无此物，但流水线一路走下来没报错，最后还真的把 prop 的读、事件的发粘在了一起。**这就是"用虚拟模块桥接编译期与运行时"被演到肉眼可见的样子。**（至于帮手内部到底怎么用响应式库把读写粘起来的，那是第 5 章 `defineModels` 的主题，本章只管"这段实现怎么被装载进产物"。）

## 关键权衡

这套设计之所以这么搭，每一步都是在拿一样东西换另一样东西。下面三条是核心。

**权衡一：用"磁盘上不存在的虚构路径"当 import 目标。**

宏选择让注入的 `import` 指向一个编出来的路径，而不是某个真实文件。**换来的是**：帮手代码集中住在宏自己的包里、统一维护，既不污染用户的源码树，又能被多个特性复用——结构扩展、命名模板等都会用到同一套虚拟模块机制。**代价是**：你必须亲手实现一整套模块解析拦截（认领解析 → 声明可加载 → 交出代码三步），而且这套拦截还要照顾不同构建器的脾气：有些构建器认 `resolveId` 就够，有些非得你再给一个 `loadInclude` 过滤器才肯把 id 送进 `load`。换句话说，你用一个"假地址"省下了源码树污染和复用难题，买来的工程债是要写一份能在六套构建器下都成立的三段式拦截。

**权衡二：把"帮手的源文件"直接当成"被加载的模块内容"自我引用。**

插件没有另外维护一份"要交出的代码"，而是用 `?raw` 把帮手的源文件以字符串导入，让它**同时是源码、也是 `load` 的返回值**。**换来的是**：实现与被加载内容永不漂移——你改了 `use-vModel.ts`，下一次 `load` 交出的就是新内容，不需要记得同步第二个地方。**代价是**：它依赖构建器对"`?raw` 这种以原始字符串导入文件"约定的支持，而且帮手文件里**不能出现那种只在编译期有意义、运行时会塌掉的语法**——因为这段文本是要原样进产物、被真实执行的，任何"编译期魔术"都会在运行时炸掉。这逼着帮手文件必须是干净、自洽、能直接跑的运行时代码。

**权衡三：给注入的标识符统一加内部前缀，并按"来源+名字"缓存去重。**

注入器没有直接用帮手的原名插进用户源码，而是统一加 `__MACROS_` 前缀，并用缓存保证同一帮手在一处源码里只插一条 `import`。**换来的是**：同一帮手被多处引用时产物里只有一条 `import`、绝不与用户代码撞名（哪怕用户也定义了个 `useVModel`）。**代价是**：用户在最终产物里看到的变量名是被改写过的 `__MACROS_useVModel`，对人类不可读——调试时看到这种名字得知道它是宏注入的、对应哪个帮手。这是拿"产物的可读性"换"正确性与体积"。

> 一个贯穿三者的共同取舍：**把"注入点"和"实现"彻底拆开。** 编译期只留一张指向假地址的标签，真正的实现集中维护、运行时交付。这条拆分换来的是复用与不污染，代价是必须搭一套解析拦截、且帮手文件必须老老实实是可运行代码。

## 小结

宏想在编译期给用户源码塞一段运行时帮手，又不想污染源码树、不想让产物膨胀，解法就是**虚拟模块**：插一句指向虚构路径的 `import`，再由插件用 `resolveId` / `loadInclude` / `load` 三件套把这个虚构模块认领下来、当场交出实现。编译期贴标签，运行时递真东西——这就是 vue-macros 桥接编译期与运行时的那块基石。

顺带一提，下一章我们会看到 vue-macros 里**另一类完全相反**的宏：props/emit 宏的编译期重写。它们走的不是"往产物里塞运行时实现"这条路，而是纯粹在编译期把更顺手的写法（比如 `$defineProps`、`ShortEmits`）改写成 Vue 原生的 `defineProps` / `defineEmits`，**运行时一尘不染**。对照着看，你会更清楚"注入运行时"和"只做编译期改写"这两种宏的分界线画在哪。
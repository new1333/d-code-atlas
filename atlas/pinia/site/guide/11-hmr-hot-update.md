# HMR：保留状态的就地热更新

> 本章属于 system 层。前置：Store 装配、状态变更模型。
> 学完你能：用一句话讲清"为什么热更新要造替身+原地搬运，而不是直接换 store 实例"，以及"为什么这套逻辑只在 dev 跑、生产里被摇除"。

## 1. 为什么需要它

上一章把 store 适配到了 Options API，写代码的姿势算齐了。可一旦真开始写，立刻撞上另一件烦心事：改一行 store 代码就要整页刷新，刚才调到一半的状态全没了——登录态、表单输入、调试用的临时变量，全部归零。

热更新（HMR）想解决的就是这件事：源码变了，浏览器里那个 store 不重建，只换逻辑、保状态。

但热更新有个看似简单、实则纠结的核心矛盾：**想换逻辑、又不能换对象**。

想换逻辑是因为源码变了；不能换对象是因为，那个 store 实例早就被一堆东西攥在手里：组件 setup 里 `useUser()` 拿到的引用、`$subscribe` / `$onAction` 注册过的订阅，更别说跨 store 的互相引用。一旦热更新把 store 实例换成一个新对象，所有这些旧引用全部失效，热更之后"看似更新、实则用旧"。

所以 Pinia 没走"换对象"这条路。它把这两个目标拆给两个角色去完成：**新代码负责忠实地把自己装配一遍，但只产出一个临时替身；旧对象负责保持身份不变，只把内部成员逐个换成新版**。

## 2. 核心思想

热更新不换掉正在用的那个对象，而是另起一个替身跑出新代码，再把替身的内容原样搬进旧对象——对象身份不变、运行时状态不丢。

这个套路不止 Pinia 在用。任何被多方长期持有的对象要"换内部实现"，几乎都会落到同一招：**保持外壳、替换内核**。DOM 节点换个 className 它还是那个节点；一个被多方持有的单例换实现，常常是直接 `Object.assign(oldInstance, newMethods)`。Pinia 的热更新也是这个套路。

## 3. 心智模型

整个机制牵涉两个 store 对象、一份新版"清单"、一次搬运：

- **本体**：用户真正在用的那个 store，原 `$id`，从头到尾身份不变。
- **替身**：热更新期间临时造的 store，`$id` 加 `__hot:` 前缀，跑完装配就被销毁。状态收进独立容器 `hotState`，绝不写回真实状态树。
- **清单**：替身装配时自动生成的"新版有什么"——哪些 state 键、哪些 action、哪些 getter，是搬运的依据。

时序分三阶段：

**找本体**。开发者把 `acceptHMRUpdate(useStore, import.meta.hot)` 注册到打包器；源码改动后回调被触发，从新模块找出新版 `useStore`。如果它的 `$id` 跟旧版不一致——身份都变了，没法就地更新，调 `hot.invalidate()` 整页刷新。一致的话，把本体作为参数调 `useStore(pinia, existingStore)`，进入 useStore 的热更新分支。

**造替身**。热更新分支用新代码完整装配一个 `__hot:id` 的临时 store。装配流程前面装配章已讲透，这里复用同一套：ref/reactive 当 state、function 包 action、computed 留 getter。差别只在于替身的状态进独立容器 `hotState`（不写真实状态树），装配结果按分类填进 `_hmrPayload` 这张清单。

**搬运**。调本体的 `_hotUpdate(替身)`，这是热更新的核心动作，下一节展开。搬运完，从状态树和注册表里删掉替身，它用完即弃。

替身的清单为什么不直接拿来用、反而要绕一圈"先装配再搬"？因为新版的 state/action/getter 怎么分类，是 Pinia 装配流程本来就在做的事。热更新白拿一份现成结果，比自己写第二套分类逻辑省事——这是后面关键权衡之一。

## 4. 关键权衡

### 4.1 就地变异既有 store，而非替换它

热更新最根本的选择：**不换对象，只换对象的内部成员**。

换来的是三件硬通货：**运行时状态保留**（用户调到一半的 `count=5` 不丢）、**对象身份不变**（外部引用、跨 store 引用、组件里 `useStore()` 缓存的结果全部继续有效）、**订阅集合不断**（`$subscribe`、`$onAction` 注册过的回调继续工作）。

代价是**搬运逻辑必须精确同步新旧"state / action / getter"三个集合的增、删、改**。新版本多了一个 getter？得加上。旧版本有的 action 被删了？得删掉。state 里某个字段类型变了？得处理。任何一处漏同步，要么留下幽灵成员（旧字段赖着不走），要么残留旧逻辑（旧 action 还能被调到）。

这条权衡化解的本质矛盾，是**「换逻辑 vs 保身份」**——更抽象地说，是"内容必须可变"与"引用必须稳定"这对立的两面。任何被多方长期持有的对象在演进时都会撞上它，而通解骨架就是「外壳不变、内核替换」。你以后看到任何"实例不能换、内部又得变"的需求（单例升级、容器热替换、协议向后兼容），都能在这个套路里找到影子。

### 4.2 用替身完整跑一遍既有装配，而非写一套并行重建

热更新要拿到"新版本里到底有什么"，最直接的做法是手写一套解析逻辑：读 options 对象、读 setup 函数返回值、分类出 state/action/getter。Pinia 没这么做，而是让**新代码完整地装配一遍**——只是产出的 store 用一个特殊 id 注册、状态进独立容器、用完即弃。

换来的是**零分叉复用同一套装配与返回值分类机制**。前面装配章讲透的"ref/reactive 当 state、function 包成 action、computed 留作 getter"那套分类，热更新白拿。替身自动得到正确的分类结果，搬运清单就是这么生成的。

代价有两条：每次热更新都要完整重跑一次 setup（包括重新包装全部 action 和 getter，开销不小）；替身的状态必须隔离进独立容器，否则装配过程会把用户真实状态污染掉。

这条权衡化解的本质矛盾，是**「路径单一 vs 流程分叉」**——一致性与可维护性，对应到代价是单次操作的开销。一个新机制要解析"新版 store 长什么样"，与其写第二套解析器，不如复用现成的装配器。这种"宁可多跑一遍，也不要维护两条装配路径"的取舍，是工程里很常见的一种消除分叉。

### 4.3 状态迁移分两路：选项式按新形状深调和、组合式整值迁移

替身装配出来后，本体的旧 state 要"搬"到新容器里。这一步按 store 语法分两条路：

- **选项式 store**：state 形状在 options 里预先声明，结构可推断。用 `patchObject` 按新形状深调和——遍历旧 state，对双方都有的键递归合并（普通对象继续往下钻，否则整值用旧值覆盖）。
- **组合式 store**：state 是 setup 里命令式创建的（比如 `ref({})`），运行时还能动态加属性，结构不可推断。所以整值迁移——直接拿旧值整体盖到新容器对应键上，不递归。

换来的是各自匹配状态形状：选项式能优雅同步字段增删（嵌套对象只动该动的子树）；组合式不会丢掉那些"声明时不存在、运行时才加进去"的字段（这正是 GitHub issue #2611 修过的 bug）。

代价是两条迁移路径须分别维护，迁移语义略有差异（同样是"调和"，含义因语法不同而不同）。

这条权衡化解的本质矛盾，是**「声明式可推断结构 vs 命令式不可推断结构」**。同一个 API 表面（`_hotUpdate`），底下因状态模型不同而走不同分支——这种"对外统一、对内分叉"是处理异质数据的常见招式。

### 4.4 整套机制仅 dev 可用，prod 入口退化为空函数

`acceptHMRUpdate` 在文件最开头就判断：生产构建下，直接返回一个空函数 `() => {}`。`__DEV__` 常量在构建时被静态替换为 false，整套热更新逻辑被 dead-code elimination 整块摇掉，生产包里一丝不剩。

换来的是**生产包不背任何 HMR 重量**——这套机制本就只服务于打包器的模块热替换接口，生产环境没这个接口，留着是死代码。

这条权衡主要是换来面，代价薄到一句话点过：若将来生产环境也需要"逻辑焕新"能力（远程下发补丁、热修复一类），这套搬运逻辑无法复用，得另起炉灶。

它化解的本质矛盾，是**「开发期想多塞观测与干预 vs 生产期想要小而稳」**——两个需求方向相反。`assert` 断言、debug 日志、devtools 钩子都遵循同一模式：用构建期常量包起来，让生产构建直接摇掉。这是开发期代码的通用宿命。

## 5. 最小原理演示

下面这段几十行的脚本，只演透权衡 4.1 的核心——就地变异而非替换。四件事一次呈现：状态保留、逻辑焕新、身份不变、成员增删。

```js
// 制造一个 store：内部用 _state 当状态容器
function makeStore() {
  const s = {
    _state: { count: 0 },
    inc() { s._state.count++ },
    get double() { return s._state.count * 2 },
  }
  return s
}

const store = makeStore()
for (let i = 0; i < 5; i++) store.inc()    // 用户已经把状态用到 count=5
const externalRef = store                   // 外部早就持有的引用（组件、跨 store 都算）

// 新版代码：inc 改成 +2、新增 triple、删除 double
function makeStoreV2() {
  const s = {
    _state: { count: 0 },
    inc() { s._state.count += 2 },
    get triple() { return s._state.count * 3 },
  }
  return s
}

// 就地搬运：演透"外壳不变、内核替换"
function hotUpdate(oldStore, neo) {
  // 状态值保留：把旧运行时值搬到新容器
  for (const k in neo._state)
    if (k in oldStore._state) neo._state[k] = oldStore._state[k]

  oldStore.inc = neo.inc                    // 动作焕新：换上新函数

  // 新增计算属性：往旧对象上挂一个 getter
  Object.defineProperty(oldStore, 'triple',
    { get: () => neo.triple, configurable: true, enumerable: true })

  delete oldStore.double                    // 删除已移除的成员
  oldStore._state = neo._state              // 状态树整体指向新容器
}

hotUpdate(store, makeStoreV2())

console.log(externalRef._state.count)       // 5      —— 身份不变 + 状态保留
externalRef.inc()
console.log(externalRef._state.count)       // 7      —— 新逻辑（+2）
console.log(externalRef.triple)             // 21     —— 新增成员生效
console.log('double' in externalRef)        // false  —— 旧成员已删
```

`externalRef` 始终是同一个对象（身份不变），但调它的方法已经是新版（+2），新增的 `triple` 也生效，删掉的 `double` 不见。这就是「外壳不变、内核替换」在最小尺度上的样子。

真实 `_hotUpdate` 多做的事——暂停监听、重包 action 的 `$onAction` 追踪、选项式 getter 重绑 computed、`patchObject` 的深调和、用 `markRaw` 防止替身被响应式追踪——都是为了让这套搬运在 Pinia 的响应式系统里不出乱子，原理就这几十行。

## 6. 执行轨迹

拿一个具体场景走一遍。开发者把 `useCounter` 的 `inc` 从 `+1` 改成 `+2`，新增了 `triple` getter，删掉了 `double` getter，保存。

1. 打包器检测到模块改动，把新模块传给 accept 回调。
2. 回调靠 `hot.data.pinia`（或上次记录在 useStore 上的 `_pinia`）找到 pinia 实例，发现 `pinia._s` 里已经有 `counter` 这个本体——有得更新。
3. 新模块导出的 useStore 的 `$id` 仍是 `'counter'`，没变，可以就地更新。
4. 调 `useStore(pinia, existingStore)`——本体的引用作为第二个参数传进去，进入 useStore 的 hot 分支。
5. hot 分支用新代码装配替身 `__hot:counter`：setup 跑一遍，返回值分类后填进 `_hmrPayload`，清单变成这样：
   - `state: ['count']`
   - `actions: { inc: 函数 (+2 版本) }`
   - `getters: { triple: computed }`
   - 替身的 `count` 在 `hotState` 里，初值 0。
6. 调本体的 `_hotUpdate(替身)`，开始搬运：
   - **状态迁移**：`count` 在本体旧 state 里、是个普通数字。选项式且双方都是普通对象才深调和，这里直接整值迁移——把旧值 `5` 覆盖到替身的 `hotState.count`。本体的 `count` ref 重新指向 `hotState.count`。
   - **状态树大切换**：暂停 `$subscribe` 监听（`isListening=false`、`isSyncListening=false`），把 `pinia.state.value['counter']` 改指向 `hotState`，下一个 tick 再恢复监听。这次切换不会被订阅系统误记为一次用户变更（这是第 5 章暂停监听套路在 HMR 上的复用，不重复展开）。
   - **动作焕新**：替身清单里的 `inc` 被重新包一层 `action()`——绑回本体而不是替身，这样热更后调用 `inc` 触发的是本体上的 `$onAction` 订阅——赋给本体。
   - **计算属性焕新**：组合式下直接搬 computed 本体，`triple` 挂到本体上。
   - **删成员**：旧清单里有 `double`、新清单里没有，从本体上 `delete store.double`。
   - **清单替换**：本体的 `_hmrPayload` 和 `_getters` 被替换成替身的，留待下次热更新用。
7. 清理替身：`delete pinia.state.value['__hot:counter']`、`pinia._s.delete('__hot:counter')`——替身从状态树和注册表里彻底消失。

输出：本体还是原来那个对象。外部旧引用（`externalRef`、组件里 `useCounter()` 的返回值、其它 store 里跨引用的句柄）全部自动看到新行为——`inc()` 是 +2、`triple` 能取到、`double` 不见了，而 `count` 还是 5。无需重新 `useStore()`。

## 7. 教学简化说明

本章演示故意省略了一批工程细节，只演透「外壳不变、内核替换」这个核心思想：暂停/恢复监听的具体时机（用 `nextTick` 而非同步恢复）、替身为何要 `markRaw`、选项式 getter 在搬运时为何重包一层 `computed` 并把 this 绑到本体、action 包裹器如何处理 `$onAction` 钩子、id 变化时的整页刷新路径、打包器侧的 `import.meta.hot` 集成。这些是工程边角，原理主线之外的代价。

## 8. 小结

热更新是 Pinia 里少有的"为开发体验单独写一条路径"的机制。它的核心选择（保外壳、换内核）把"换逻辑"和"保身份"这件看似冲突的事拆成了两个角色：替身负责忠实地跑新代码，本体负责维持身份稳定。代价是搬运逻辑必须精确同步三个集合，并且要小心绕开订阅系统的眼睛。

下一章会讲 DevTools——它要观察的就是这种"状态被谁、如何改动"的事件流，HMR 自然也成了它要包抄的一类特殊变更。

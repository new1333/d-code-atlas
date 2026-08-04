# 导航失败的语义化分类 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：路由导航有很多"没走到底"的情况——守卫拦下、用户连点导致后一次挤掉前一次、目标就是当前页、守卫让重定向去别处。如果这些都用"抛异常/reject"表达，控制台会被 `Unhandled promise rejection` 刷屏，用户会以为程序坏了；上层也无法区分"被正常拦下"和"真出 bug 了"。

- **一句话核心思想**：把导航失败建模成**携带种类标记的可恢复值**（走 return 通道），而不是笼统的异常（走 throw 通道）——让"没导航成功"成为一种可分类、可查询、不污染错误通道的正常结果。

- **设计动机（为什么需要它）**：导航失败的种类本身就是上层关心的语义（afterEach 想知道"这次是被取消还是重复了"），所以失败必须**带种类**；而种类又经常需要**组合查询**（"中止或取消都算正常"），所以种类用**位掩码**编码；又因为失败值要在 promise 链里和真异常混着流动，必须有**稳定可靠的自我识别**手段——于是用一个**不可碰撞的隐藏标记**做鸭子判定，而非自定义错误子类的 `instanceof`。
  - 跨章去重信号：本章**只建『失败值的模型』**——这些值在守卫链里如何被产出、在导航主循环里如何被按位分流，**（将在后续『导航守卫管线』『Router 核心与导航主循环』两章展开）**。本章只交代模型本身的形状与原理，不重演消费侧。

- **关键权衡**：
  1. **用"值"（resolve 返回）而非"异常"（reject）传递预期失败** → 换来 `afterEach` 能拿到结构化 failure、且不触发未捕获 rejection 告警 → 代价是整条导航 promise 链必须在每个 `.catch` 里刻意做"已知失败 vs 真异常"的二分分流，心智负担转移到框架内部。
  2. **用位掩码（2 的幂）编码失败种类** → 换来一次按位与即可"问多种失败"（`aborted | cancelled`），判定压成一条 `type & mask` 表达式 → 代价是 `type` 字段对人是"魔数"，可读性全靠枚举别名补；且需维护"内部常量枚举（编译期内联）/ 公开运行时枚举"两套同值映射。
  3. **用"内置 Error + 隐藏标记属性"而非自定义子类** → 换来"这是不是一个失败值"的判定不依赖会被压缩/多副本冲突破坏的子类构造器，靠的是跨 realm 稳定的内置 Error + 私有标记 → 代价是放弃 `instanceof XxxError` 的类型 narrowing，只能靠谓词函数 + TS 重载模拟类型守卫。
  4. **把"重定向"也建模成一种"携带新目标的失败"** → 换来重定向复用整套失败传递通道（产出一个带目标的失败值 → 上游捕获后再发起新导航），无需独立机制 → 代价是失败种类被分成"对用户可见的 3 种"和"仅内部的 2 种（重定向/未匹配）"，API 表面与文档需刻意区分。

- **最小心智模型（3～7 步）**：
  1. 导航开始，先登记"当前待处理目标位置"作为取消基准。
  2. 任何阶段发现"基准已变（被更新的导航取代）"→ 产出"已取消"失败值。
  3. 守卫拒绝（返回 false / 抛一个新位置 / 目标与当前同位）→ 分别产出"已中止 / 重定向 / 重复"失败值。
  4. 失败值经 **return（resolve）** 通道回传给收尾逻辑，而非 reject。
  5. 收尾逻辑按位查种类：决定是否回滚历史栈、是否把 failure 透传给 afterEach。
  6. 仅当错误**无法被识别为已知失败**时，才走 onError 监听 / 控制台 / reject 这条"真异常"通道。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个几十行的 TS 玩具导航器——定义位标志常量（1/2/4/8）、一个隐藏标记（Symbol）、一个 `makeFailure(type, {from,to})` 用 `Object.assign(new Error(msg), {type, [MARK]:true, from,to})` 造失败值、一个 `isFailure(err, mask?)` 谓词（`err instanceof Error && MARK in err && (mask==null || !!(err.type & mask))`）、一个 `navigate()` 在"守卫拒绝/被新导航取代"时 **return** 失败值、在"真异常"时 **throw**。每行都要对应上面某条权衡（位掩码↔权衡2、标记↔权衡3、return-vs-throw↔权衡1）。
  - 应故意省略：完整的守卫管线、history 回滚、redirect 再导航、DEV 文案表、TS 重载签名、router 真实 install——这些是消费侧/工程化，不服务于"演透失败值模型"。
  - 演示载体建议：**首选 TS/JS**。本章核心是"位掩码 + 标记式鸭子判定 + 值/异常二分"这套纯语言级模式，无任何 vue-router 运行时依赖，用 TS 几十行即可忠实演透；配最小 `package.json`（`type: module` + 一条 `bun run`/`node` 脚本）即可跑。**无任何理由退回原仓库语言**——这不是语言特有语义。

- **正文不宜展开的细节**：
  - `const enum` 在编译期内联、及其"成员值必须是字面量、不能写 `1 << 2`"的硬约束（源码注释已点明，一句话带过即可，非主线）。
  - DEV/非 BROWSER 下才拼接错误文案、生产构建抹掉文案的体积优化（工程细节）。
  - 内部诊断码、MatcherError 的 `currentLocation` 字段等边角。
  - 公开枚举刻意只暴露 3 种、把 redirect/matcher-not-found 留 internal 的导出边界（可一句话提及，不展开）。

- **推荐的一个执行轨迹例子**：
  - 输入：用户从 `/a` 点链接去 `/b`，某 `beforeEach` 返回 `false`。
  - 中间态：守卫 hook 产出一个带"已中止"位 + 隐藏标记的 Error 值，`from=/a, to=/b`；它先以 reject 形式在守卫链内短路。
  - 收尾：导航主循环的 `.catch` 判定它是"已知失败且非重定向"→ 调 `markAsReady` 并把它**作为返回值**继续；下一个 `.then` 收到非空 failure → 跳过 `finalizeNavigation`（URL 停在 `/a`）→ 按种类决定不回滚 → `triggerAfterEach(to, from, failure)` 把 `failure.type === aborted` 交给用户的 `afterEach`。
  - 输出：URL 仍为 `/a`，用户在 `afterEach` 第三参拿到分类过的 failure；链尾 `.catch(noop)` 吞掉残留，控制台无未捕获告警。
  - （对照：若守卫里 `throw new Error('boom')` 这种真异常——同一 `.catch` 判定"非已知失败"→ 走 `triggerError` → `onError` 监听或 `console.error` + `Promise.reject`。）

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **失败种类的位标志编码**：内部用 2 的幂（1/2/4/8/16）给五种失败各占一位，使得"种类"既是标签又可按位组合查询。源码位置: packages/router/src/errors.ts:15-23
- **内部常量枚举 vs 公开运行时枚举的双层设计**：内部 `const enum`（编译期内联为字面量、无运行时对象，性能优先）；公开 `enum`（真实运行时对象，用户可 `NavigationFailureType.aborted` 引用，API 友好）。公开枚举只暴露 3 种（aborted/cancelled/duplicated），内部多出的 MATCHER_NOT_FOUND 与 NAVIGATION_GUARD_REDIRECT 不对用户暴露。源码位置: packages/router/src/errors.ts:15-23, 37-53
- **"必须是字面量"的 const enum 约束**：源码注释点明——`const enum` 成员要当值用就必须是字面量，因此不能写成 `1 << 2` 这类位移表达式，只能写 `= 4`。源码位置: packages/router/src/errors.ts:16-17
- **隐藏标记属性做鸭子判定**：用一个模块级 `Symbol` 作为不可碰撞的标记键，造失败时挂上 `[MARK]: true`；判定时检查 `MARK in error`。这取代了"自定义 Error 子类 + instanceof"。源码位置: packages/router/src/errors.ts:25, 134
- **失败值的构造方式**：`Object.assign(new Error(msg), { type, [MARK]: true }, params)`——以普通 Error 为底，再贴上种类、标记与业务字段（from/to）。没有 `class NavigationFailure extends Error`。源码位置: packages/router/src/errors.ts:124-148
- **三段式自我识别谓词**：`instanceof Error`（跨 realm 稳定的内置基类）`&& MARK in error`（确认是本库造的）`&& (type==null || !!(error.type & type))`（按位查种类）。源码位置: packages/router/src/errors.ts:176-193
- **重定向 = 携带新目标的失败**：`NavigationRedirectError` 复用失败值形状，但 `type` 是 redirect 位、`to` 是新目标 `RouteLocationRaw`（而非 normalized 的已解析位置）。守卫返回一个位置 → 产出这种"带目标的失败" → 上游捕获后向该目标再发起导航。源码位置: packages/router/src/errors.ts:81-87
- **类型守卫与位掩码联动**：`isNavigationFailure` 的 TS 重载——当传入 redirect 位时窄化为 `NavigationRedirectError`，否则窄化为 `NavigationFailure`，把"运行时按位判定"和"编译期类型收窄"对齐。源码位置: packages/router/src/errors.ts:176-184
- **公开导出边界**：对外只导出 `isNavigationFailure`、`NavigationFailureType`、`NavigationFailure` 类型；`createRouterError`、`ErrorTypes`、`NavigationRedirectError` 均为 `@internal`。源码位置: packages/router/src/index.ts:134,137

## 关键调用链

守卫拒绝 / 取消 / 重复 的失败值产出 → 主循环 `.catch` 二分分流 → 失败值经 return 传到 `.then` 收尾 → 按位决定回滚与 afterEach → 链尾吞残留

- **产出点（5 处，覆盖全部内部 ErrorTypes）**：
  - 守卫返回 `false` → reject "已中止"；守卫返回一个路由位置 → reject "重定向（带目标）"。源码位置: packages/router/src/navigationGuards.ts:142-161
  - 导航主循环发现 `pendingLocation !== to`（被新导航取代）→ 产出 "已取消"。源码位置: packages/router/src/router.ts:358-365
  - 目标与当前位置同位 → 产出 "重复"。源码位置: packages/router/src/router.ts:456-463
  - matcher 找不到命名/路径匹配 → throw "未匹配"（MatcherError）。源码位置: packages/router/src/matcher/index.ts:257-259, 339-342
- **消费点（值/异常二分分流）**：`pushWithRedirect` 的 `.catch` —— `isNavigationFailure(error)` 为真则按值处理（重定向直接返回、其余经 `markAsReady` 返回），为假则 `triggerError`（走 onError/console + reject）。源码位置: packages/router/src/router.ts:478-486
- **守卫队列内吞"已取消"**：`navigate()` 内部 `.catch` 只放过 NAVIGATION_CANCELLED（已被取代，无需继续），其余原样 reject。源码位置: packages/router/src/router.ts:691-696
- **收尾按位决定副作用**：`.then(failure)` 若非空则跳过 finalizeNavigation；用位组合查询（`aborted|cancelled`、`aborted|duplicated`）决定是否回滚历史 / 手动 `go(-1)`；最后 `triggerAfterEach(to, from, failure)` 把分类过的 failure 交用户。链尾 `.catch(noop)` 明确为"避免控制台未捕获告警"。源码位置: packages/router/src/router.ts:860-889
- **真异常通道**：`triggerError` —— `markAsReady` 后调所有 `onError` 监听；若无监听则 `console.error` + 诊断码；最后 `Promise.reject(error)`。源码位置: packages/router/src/router.ts:907-924

## 源码摘录（带行号，全文累计 ≤ 30 行）

内部位标志（const enum，注释点明"必须字面量"）：

```ts
// packages/router/src/errors.ts:15-23
export const enum ErrorTypes {
  // they must be literals to be used as values, so we can't write
  // 1 << 2
  MATCHER_NOT_FOUND = 1,
  NAVIGATION_GUARD_REDIRECT = 2,
  NAVIGATION_ABORTED = 4,
  NAVIGATION_CANCELLED = 8,
  NAVIGATION_DUPLICATED = 16,
}
```

失败值构造（以普通 Error 为底，贴种类 + 标记 + 业务字段；此处为 DEV 分支，生产分支结构相同仅省略文案）：

```ts
// packages/router/src/errors.ts:130-137
    return assign(
      new Error(ErrorTypeMessages[type](params as any)),
      {
        type,
        [NavigationFailureSymbol]: true,
      } as { type: typeof type },
      params
    ) as E
```

三段式识别谓词（内置 Error + 标记 + 按位查种类）：

```ts
// packages/router/src/errors.ts:188-192
  return (
    error instanceof Error &&
    NavigationFailureSymbol in error &&
    (type == null || !!((error as unknown as NavigationFailure).type & type))
  )
```

导航主循环的"值/异常二分分流"（已知失败走 return、真异常走 triggerError）：

```ts
// packages/router/src/router.ts:478-486
      .catch((error: NavigationFailure | NavigationRedirectError) =>
        isNavigationFailure(error)
          ? isNavigationFailure(error, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
            ? error
            : markAsReady(error)
          : triggerError(error, toLocation, from)
      )
```

## 易混淆 / 边界 / 推断

- **事实**：失败值**不**经 `class extends Error` 产生，而是 `assign(new Error(...), {...})`；公开 `NavigationFailureType` 仅含 aborted/cancelled/duplicated 三种，redirect 与 matcher-not-found 是 internal。源码位置: packages/router/src/errors.ts:124-148, 37-53
- **事实**：失败值优先以 **resolve 返回值**形式在链中流动（`.catch` 把已知失败转成返回值传给下一个 `.then`），只有真异常才 `Promise.reject`。链末 `.catch(noop)` 明确用于消除未捕获告警。源码位置: packages/router/src/router.ts:478-489, 888-889
- **推断（标注为推断）**：选择"内置 Error + 隐藏标记"而非自定义子类，动机应是规避子类 `instanceof` 在**代码压缩/多 bundle/多 vue-router 副本**下失效的脆弱性——内置 `Error` 的 `instanceof` 跨 realm 稳定，承担"是不是个 Error"这一最外层判定。**但需提醒 Writer 不要过度宣称"Symbol 本身可跨 realm"**：源码用的是 `Symbol()`（每次调用唯一、per-copy），而非 `Symbol.for()`，所以"是否本库造的失败"这一层判定在两个独立 vue-router 副本之间**并不**比子类 instanceof 更强。准确的表述是"跨 realm 稳定的内置 Error 判定 + 标记式扩展"，而非"Symbol 跨 realm"。源码位置: packages/router/src/errors.ts:25, 188-192
- **推断**：把重定向也做成"失败值"而非独立控制流，是为了让 pushWithRedirect 的**单一** promise 链既能表达"终止"又能表达"换目标继续"——重定向捕获后递归再调一次 pushWithRedirect 即可，复用同一套收尾/分流逻辑。源码位置: packages/router/src/router.ts:803-823
- **未理解**：`NavigationFailureSymbol` 在 `assign` 后是否可枚举、是否会被任何序列化/拷贝路径意外丢失，未在本章源码范围内验证（不影响原理讲解）。
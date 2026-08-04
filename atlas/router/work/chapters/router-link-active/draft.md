# RouterLink 与激活态判定

你打开任何一个后台管理系统，左侧都会有一排菜单链接：「用户」「订单」「设置」。你此刻停在「用户详情」页，那一排菜单里「用户」这一项就该高亮起来——告诉用户「你现在在用户这片区域里」。

这件事听起来简单，做起来却坑多得离谱。最直觉的做法是：拿当前 URL 跟每个链接的地址比一下，看是不是「开头一样」。但只要你用了带参数的路由、嵌套子页面、或者别名，这套字符串比较就开始胡说八道：

- 当前在 `/users/123`，「用户列表」链接指向 `/users`——前缀对上了，该亮。可如果当前是 `/users/123/posts/456` 呢？「用户列表」按前缀也算对上，但这是用户列表吗？不是，是某篇文章。
- 两个不同路径指向同一个界面（别名），比如 `/me` 和 `/users/me`——它们该一起亮，可字符串前缀根本看不出来它们是「一回事」。
- 参数 `:id` 是 `123` 还是 `['123']`，解码前和解码后字符串长不一样，比较结果也会跟着抖。

说人话就是：**使用者要的不是「URL 字符串长得像」，而是「我此刻确实落在这个链接所代表的那片界面范围内」。** 字符串是给人眼和浏览器看的扁平表象，而路由在内部是个带父子层级、带结构化参数、还可能带别名的立体对象。拿扁平字符串去比立体对象，必然失真。这一章要讲的就是：怎么把这个判定从「比字符串」换成「比结构」，以及由此换来的一切好处和代价。

## 先看清楚：链接手里的「位置」到底是什么形状

要理解激活判定，得先知道一个链接的目标在被用之前，会被路由核心**解析成一个结构化的位置**。这个解析过程（把字符串地址或位置对象变成结构化结果）是上一章「Router 核心与导航主循环」已经做好的事，链接只是个消费者，拿现成结果来用。本章只盯着「消费侧」这个新角度。

解析出来的位置长这样，记住这三件东西，后面全靠它们：

- **一条匹配记录链（matched）**：从根到叶子排好序的记录数组。比如 `/users/123/posts/456` 解析出来是 `[users, user, post]` 三层——「用户区 → 某个用户 → 某篇文章」。这条链就是路由的**父子层级坐标**。
- **一组参数（params）**：解码后的结构化键值对，比如 `{ id: '123', postId: '456' }`。
- **一个 href**：最终渲染进 `<a href>` 的字符串，给人眼看的。

打个比方：URL 字符串像是把地址写成一行 `/users/123/posts/456`，而结构化位置像是把地址拆成「第几街区（users）→ 第几栋（user）→ 第几间（post）」的层级坐标，外加每层的门牌号（params）。要判断「我现在是不是在这片区域」，比坐标层级显然比比字符串前缀靠谱得多。

上一章还讲过一件事：判断两个位置是不是「同一个」，靠的是「匹配记录链上对应记录引用相等 + 参数结构相等」——那章用它来做**重复导航的短路**（你要去的地方就是你现在的位置，就别导航了）。本章正是在这套「相等」判定的基础上，做一个关键的松绑：把「必须全等」放宽成「可以是子集」，从而表达「祖先/包含」关系。这是本章唯一的新原理，下面围绕它展开。

## 两档松紧：active 与 exactActive

有了结构化位置，激活判定就被拆成松紧两档，对应两种常见的 UX 需求：

- **松档（active）**：只要这个链接的末端记录**出现在当前匹配链上**，且链接的参数是当前参数的**子集**，就算激活。这一档让「祖先链接」自动亮——你现在在「某篇文章」里，那「用户列表」「某个用户」这些父级链接全都算激活，整条面包屑路径都能高亮。
- **紧档（exactActive）**：在松档基础上，额外要求链接的末端记录**正好在当前链的最后一格**，且参数**完全相等**。这一档只让真正命中的那个叶子链接亮。

文字流程长这样：

```
链接目标 (to)
   │  路由核心 resolve（上一章已实现）
   ▼
结构化位置：matched 链 + params + href
   │
   │  取链接末端记录，去当前 matched 链里找下标 idx
   ▼
idx < 0 ？──是──▶ 不在链上：active=false, exactActive=false
   │ 否（在链上）
   ▼
paramsCover(当前params, 链接params) ？   ← 子集判定（松档）
   │ 是                       │ 否
   ▼                          ▼
active = true             active = false, exactActive = false
   │
   │  idx 是否正好在链末端 && paramsEqual ？  ← 全等判定（紧档）
   ▼
是 → exactActive=true        否 → exactActive=false
```

光看流程还是抽象，下面用一段从零写的最小演示把它跑给你看。

## 原理演示：结构化子集匹配

这段代码不依赖任何路由库，纯数据结构加比较函数，演透「松紧两档 + 别名回溯 + 子集 vs 全等」这一整组核心思想。保存为 `demo.ts`，用 `bun run demo.ts`（或 `npx tsx demo.ts`）即可运行。配套的最小 `package.json` 只需 `{ "type": "module" }`。

```ts
// === 数据形状 ===
type ParamValue = string | string[]
interface RouteRecord { name: string; aliasOf?: RouteRecord } // aliasOf：别名指向原始记录
interface RouteLocation {
  matched: RouteRecord[]                       // 匹配记录链（根→叶子）
  params: Record<string, ParamValue>           // 解码后的结构化参数
}

// === (b) 两条记录算不算「同一条」：别名要回溯到原始记录再比 ===
function sameRecord(a: RouteRecord, b: RouteRecord): boolean {
  return (a.aliasOf ?? a) === (b.aliasOf ?? b)
}

// === (c) 子集比较（松档 active 用） ===
// 遍历【目标】参数，要求【当前】参数逐键匹配；当前可以多带键（这就是祖先链接成立的根因）。
// 标量直接全等；数组则要求当前也是同长度数组且逐元素相等——刻意不做「单值 ≡ 长度1数组」退化。
function paramsCover(
  current: Record<string, ParamValue>,
  target: Record<string, ParamValue>,
): boolean {
  for (const key of Object.keys(target)) {
    const need = target[key]
    const have = current[key]
    if (typeof need === 'string') {
      if (need !== have) return false            // 标量：直接全等
    } else {
      // need 是数组：have 也必须是同长度数组，且逐元素相等
      if (!Array.isArray(have) || have.length !== need.length) return false
      if (need.some((v, i) => String(v) !== String(have[i]))) return false
    }
  }
  return true
}

// 单值与「长度1数组」视作等价（仅紧档全等比较用，松档上面刻意不这么做）
function sameParamValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  const av = Array.isArray(a) ? a : [a as string]
  const bv = Array.isArray(b) ? b : [b as string]
  return av.length === bv.length && av.every((v, i) => String(v) === String(bv[i]))
}

// 全等比较（紧档 exactActive 用）：先比键数，再逐键比
function paramsEqual(
  current: Record<string, ParamValue>,
  target: Record<string, ParamValue>,
): boolean {
  const ck = Object.keys(current), tk = Object.keys(target)
  if (ck.length !== tk.length) return false
  return tk.every(k => sameParamValue(current[k], target[k]))
}

// === (d) 两档激活判定 ===
function computeActive(current: RouteLocation, link: RouteLocation) {
  const tip = link.matched[link.matched.length - 1]   // 链接匹配链的末端记录
  const idx = current.matched.findIndex(r => sameRecord(r, tip)) // 在当前链里找下标
  const onChain = idx > -1
  return {
    idx,
    isActive: onChain && paramsCover(current.params, link.params),
    isExactActive:
      onChain &&
      idx === current.matched.length - 1 &&          // 必须正好在链末端
      paramsEqual(current.params, link.params),
  }
}

// === 断言场景 ===
// 三条记录（用引用相等保证 matched 链复用同一实例——这是「记录引用相等」判定的前提）
const users: RouteRecord = { name: 'users' }
const user: RouteRecord = { name: 'user' }
const post: RouteRecord = { name: 'post' }

// 当前路由 /users/123/posts/456
const current: RouteLocation = {
  matched: [users, user, post],
  params: { id: '123', postId: '456' },
}

// 链接 1：指向祖先 user
const linkToUser: RouteLocation = { matched: [users, user], params: { id: '123' } }
const r1 = computeActive(current, linkToUser)
console.log(r1) // => { idx: 1, isActive: true, isExactActive: false }
console.assert(r1.isActive === true, '祖先链接应 active')
console.assert(r1.isExactActive === false, '祖先链接不应 exact active')

// 链接 2：指向叶子 post（精确命中）
const linkToPost: RouteLocation = { matched: [users, user, post], params: { id: '123', postId: '456' } }
const r2 = computeActive(current, linkToPost)
console.log(r2) // => { idx: 2, isActive: true, isExactActive: true }
console.assert(r2.isExactActive === true, '叶子且参数全等应 exact active')

// 链接 3：末端是别名，sameRecord 回溯到 user 后仍命中
const linkToAlias: RouteLocation = {
  matched: [users, { name: 'me', aliasOf: user }], // /me 是 /users/:id 的别名
  params: { id: '123' },
}
const r3 = computeActive(current, linkToAlias)
console.log(r3.isActive) // => true（别名不破坏判定）
console.assert(r3.isActive === true, '别名末端回溯到原始记录后应 active')
```

把上面三个断言跑通，就验证了三件事：**祖先链接 active 但非 exact**（`r1`）、**叶子且参数全等才 exact**（`r2`）、**别名自动归到原始记录**（`r3`）。

## 跟着演示走一遍执行轨迹

把链接 1 那个场景掰开看，每一步都对应演示里的一行：

```
当前路由  /users/123/posts/456
   ├─ matched 链：[users, user, post]          （3 层）
   └─ params：   { id: '123', postId: '456' }

链接     { name: 'user', params: { id: '123' } }
   └─ 解析后 matched 链：[users, user]          （2 层）
   └─ params：   { id: '123' }

第 1 步：取链接末端记录 user，在当前链 [users, user, post] 里 findIndex
        → idx = 1（≥ 0，确认「在链上」）

第 2 步：激活（松档）
        paramsCover({id:'123',postId:'456'}, {id:'123'})
        遍历【目标】{id:'123'}：need='123' 标量，have='123' 全等 → 通过
        当前多带的 postId 根本没被遍历到，不影响 → 子集成立
        → isActive = (idx>-1) && true = true

第 3 步：精确激活（紧档）
        idx(1) === matched.length-1(2) ？  → 1 ≠ 2 → false
        → isExactActive = false

结论：该链接 active，但不是 exact active。
      —— 这正是「祖先链接算激活」的预期行为：你在文章页，
         指向「用户」的链接亮着（你在用户这片区域里），
         但它不是你「精确所在」的那一页。
```

## 关键权衡

原理看懂了，真正值得带走的是这几个「为什么这么选」。这一章机制比较集中，下面三条权衡是它全部的设计张力所在。

### 权衡一：用结构化匹配，而不是 URL 字符串前缀

**选择**：判定激活时，不比两个 URL 字符串，而是比「链接的末端记录是否出现在当前 matched 链里 + 链接参数是否是当前参数的子集」。

**换来**：
- **别名天然正确**。`/me` 和 `/users/me` 哪怕字符串毫无相似，只要它们解析出同一条记录（或别名回溯到同一条），判定就一致。字符串前缀对这种「同一界面的多入口」完全束手无策。
- **参数的数组/编码形态不影响判定**。因为比的是解码后的结构化值（`id` 是 `'123'` 还是 `['123']` 是数据形状问题），而不是 URL 里那串被编码过的字符。编码方式的差异在解析层就被抹平了，根本走不到判定这一步。
- **嵌套父子关系精确**。靠的是 matched 链的真实拓扑（谁真的是谁的祖先），而不是「路径字符串碰巧以你开头」这种脆弱近似——`/users` 和 `/users-management` 字符串前缀重合，但根本不是一个祖宗，结构化匹配绝不会误判。

**代价**：
- **不能凭两个字符串就算出来**。必须先把链接 `resolve` 成结构化位置（跑一次匹配、反推出记录链和参数），这比 `startsWith` 贵得多。
- **必须依赖路由上下文**。判定要用到「当前 matched 链」「当前 params」，这些只能从路由核心 `install` 时注入的上下文里拿。脱离了路由体系（比如在路由还没装好的地方），这套判定根本无从谈起——它不是个独立的小工具，而是整个路由状态机的一个视图。

### 权衡二：激活拆成「子集」和「全等+末端」两档松紧

**选择**：不做一个「激活」了事，而是做两档。松档只要「在链上 + 子集」，紧档额外要「在末端 + 全等」。

**换来**：
- **两种 UX 需求用同一套数据自然表达**。「范围高亮」（菜单里「用户」整条栏目在你进用户区时都亮）和「精确命中」（只有你真正停在那个叶子页时才亮）是两个极为常见又互相冲突的需求。一套 matched/params 数据，配上两档判定，两边都照顾到了，使用者不用自己再发明一套比较逻辑。
- **祖先链接自动成立是「子集」的副产品**。子集判定遍历的是目标参数、允许当前多带键，所以「当前在更深的叶子、链接指向更浅的祖先」天然为真——不用为祖先关系写任何特例代码。

**代价**：
- **要维护两套比较函数**，而且它们对同一组参数的行为**有细微差异**，使用者必须分别理解：
  - 松档（`paramsCover`）刻意**不做**「单值 ≡ 长度1数组」的退化——目标是数组时，当前也必须是同长度数组逐元素相等；
  - 紧档（`paramsEqual`）反而**做**这个退化——单值和长度1数组视作等价。
  - 这意味着同一条链接，在「参数恰好是 `['x']` 而当前是 `'x'`」时，松档判 false、紧档判 true 的情况是可能出现的。这是个真实的认知陷阱，文档得专门提醒。
- **两档语义都需要使用者正确选用**。该用 `exact-active-class` 的地方用了 `active-class`，就会出现「整条祖先链都亮」的迷惑效果；反之该亮的范围没亮。松紧是给使用者的一把双刃剑，灵活但容易误用。

### 权衡三：把全部逻辑抽成 headless 组合式函数，而不是塞进组件

**选择**：把「解析、激活判定、点击导航」全部塞进一个对外暴露的组合式函数（`useLink`），组件本体退成一层薄壳——只负责把判定结果渲染成一个原生 `<a>`；再开一个 `custom` 开关，连这层薄壳也扒掉，把判定结果原样交回给使用者的插槽自己画。

**换来**：
- **完全自定义渲染而不必 fork 组件**。想要把链接画成按钮、列表项、带图标的复杂结构，甚至根本不是 `<a>` 标签，都不用改 RouterLink 源码——直接用 `useLink` 拿到 `{ route, href, isActive, isExactActive, navigate }`，自己组装。激活判定的全部复杂度都被封装在函数里，对自定义渲染者是不可见的负担。

**代价**：
- **API 变成「函数 + 组件」双形态**。同一件事有两种入口（用 `<RouterLink>` 还是调 `useLink`），使用者在选型时要理解它们的边界。
- **类型得为「是否渲染原生 `<a>`」单独分叉**。`custom: true` 时，props 就不该再接受 `target`、`rel` 这些锚点属性（因为根本不画 `<a>`）；`custom: false` 时又要透传这些属性（但禁止覆盖 `href`）。这套「是否渲染锚点」反映到类型上的条件分叉，是 headless 设计带来的额外类型复杂度——不过这套类型推导怎么安全地组织起来，是下一章「类型安全路由的编译期推导」的主题了。

## 小结

这一章只讲了一件事：**把「当前是否在这个链接上」从「URL 字符串前缀比较」换成「结构化位置的子集判定」**。它的全部精妙都建立在上一章已经搭好的两块地基上——把链接解析成 matched 链 + params 的结构化位置，以及用「记录引用相等 + 参数结构」判定两个位置的关系。本章在这之上做的唯一新动作，就是把「全等」松绑成「子集」，于是「祖先也算激活」这个行为自然涌现，再加上「末端且全等」的紧档补上「精确命中」，两种高亮需求就齐了。别名靠记录回溯到原始记录自动归队，参数的数组/编码差异在解析层就被抹平——这些都是「比结构而非比字符串」顺带送对的，不用专门写规则。

下一章我们会从「运行时怎么判定」跳到「编译期怎么保证你写的链接目标本身就是合法的」——也就是类型安全路由的编译期推导。
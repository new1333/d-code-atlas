# 条件类型区分可选载荷事件

> 本章属于 composite 层。前置：一张 Events 映射派生全 API 类型。
> 学完你能用一句话讲清：mitt 如何在编译期区分「可无参触发的事件」与「必须带载荷的事件」，以及它为此付出的可读性代价。

## 1. 为什么需要它（设计动机）

上一章讲了「一张事件映射 + keyof 反向推导」如何让整条 API 的类型从一份 `Events` 映射里派生出来。但留了一个口子：派发动作 `emit` 的载荷参数到底该怎么标？

考虑实际场景里两类事件：

- 「登录态变更」「任务结束」这类**信号事件**——触发时根本不带数据；
- 「消息到达」「分页变化」这类**载荷事件**——必须附带具体数据。

对这两类事件，派发 API 该怎么写？三种朴素方案都踩坑：

- **载荷一律必传**：用户被迫写 `emit('logout', undefined)`——纯属空转。
- **载荷一律可选**：手滑漏传 `emit('message')` 时编译器一声不吭，运行时处理器拿到 `undefined` 炸掉。
- **给每个事件加注解或开关**：心智负担重，且和 `Events` 映射本身重复表达。

矛盾在哪？**同一个 `emit` API，要让「无载荷事件」与「必载荷事件」走不同的类型校验通道**——前者允许 `emit('logout')`，后者必须在编译期挡住 `emit('message')`。mitt 的解法是把这个矛盾整个推给类型层——下面看它怎么推。

## 2. 核心思想

**mitt 的答案是：在派发的重载签名里嵌一个条件类型，让编译器自己问『这个事件的载荷类型允不允许 `undefined`』——允许就走无参通道，不允许就让这个键坍缩成 `never`。** 整套机制没在运行时加任何分支，纯粹靠类型系统完成分流。

## 3. 心智模型

派发侧的类型判定链（自顶向下）：

```
事件映射 Events 里某键
　→（TS 索引取值 Events[Key]）得到载荷类型
　→ 若键是可选属性（如 bar?: number），载荷类型 = 值 | undefined
　→ 若键是必填属性（如 foo: string），载荷类型 = 值（不含 undefined）
　→ 把「undefined 是否可赋给载荷类型」作为编译期问题问一遍
　→ 含 undefined 的键放行无参触发 / 不含的键坍缩成 never 被拒
```

两条派发重载就这么分工：

```ts
// 第一条：双参必传通道——所有键都能走，但必须带载荷
emit<Key extends keyof Events>(type: Key, event: Events[Key]): void;

// 第二条：无参触发通道——条件类型筛键，只放行可选载荷的键
emit<Key extends keyof Events>(
  type: undefined extends Events[Key] ? Key : never
): void;
```

第二条是全章核心。它的参数类型不是 `Key`，而是一个**条件类型**：当 `undefined extends Events[Key]` 成立时结果是 `Key`（保留这个键），不成立时结果是 `never`（永不类型，谁都赋不进去）。`never` 在这里充当「筛子」——把不该放行的键全部坍缩掉，联合后自然消失：

```
所有键（keyof Events）：'foo' | 'bar'
　↓ 逐键求值 undefined extends Events[Key] ? Key : never
　　　'foo' → undefined extends string        ? 'foo' : never = never
　　　'bar' → undefined extends (number|undef) ? 'bar' : never = 'bar'
　↓ 联合
筛后：never | 'bar' = 'bar'
```

为什么「可选属性 ⇒ 索引取值含 undefined」这条 TypeScript 语义约定能担起判定锚点？因为 mitt 的 tsconfig 开了 `strict` 但没开 `exactOptionalPropertyTypes`，所以 `bar?: number` 索引取值稳定得到 `number | undefined`，`undefined extends number | undefined` 成立——这条隐含的语义桥梁是整套机制的基础。

## 4. 关键权衡

### 两条重载分流而非一条可选载荷参数

mitt 选择写两条 `emit` 重载签名，把「双参必传」和「无参触发」明明白白拆开，而不是合并成一条 `emit<Key>(type: Key, evt?: Events[Key])`。

换来的是**硬编译期保证**：必带载荷的事件绝对无法无参触发。用户若手滑写 `emit('message')`（`message` 是必载荷事件），编译器立刻挡住——而不是等到运行时处理器拿到 `undefined` 才炸。这一保证在很多没做拆分的 pubsub 库里完全做不出来，因为单条可选载荷签名把所有事件一视同仁地放行了。

代价是第二条签名是一条**晦涩的条件类型表达式**。第一次读 `type: undefined extends Events[Key] ? Key : never` 的人几乎要愣几秒——它把判定逻辑直接写进了签名，没有任何中间变量或注释解释。这是「让编译器懂」和「让人一眼懂」之间的硬取舍，mitt 选择了前者。

本质矛盾：**类型严格性**与**签名可读性**在一条签名里彼此打架——既要表达「该键允许无参触发」的精细语义，又要让读者一眼读懂。mitt 把它拆成两条签名各自承担一半职责，把矛盾拆掉了。

### 用「载荷类型里是否含 undefined」当判定依据

mitt 没给 `emit` 加任何额外配置或注解，而是直接复用「用户在事件映射里把某个键写成可选属性」这个**已有动作**。用户写 `bar?: number` 就同时表达了两件事：「这个事件可能不带数据」+「它能被无参触发」——一次声明，两个语义。

换来的是**零额外配置**——用户不必学新 API、不必加新注解、不必记新开关。可选属性这一 TS 用户最熟悉的语法，就承担了「可无参触发」的语义。

代价是**这条判定链路完全隐式**。读者看到 `bar?: number` 自然会想「它是可选的」，但很难直接想到「因此 `emit('bar')` 合法」——中间隔着「可选属性 ⇒ 索引取值含 `undefined` ⇒ `undefined extends` 成立 ⇒ 条件类型保留该键」这条四步链。新人接手项目时往往会盯着那行 `emit('bar')` 想「为什么这个能编译过」。

本质矛盾：**表达的经济性**（一处声明带多重语义）与**显式可追溯性**（每个判定步骤可见）的对立——mitt 选择了前者，把判定链藏在 TS 既定语义里。

### 对外契约严格与内部实现宽松相分离

mitt 的对外 `emit` 重载严格要求「必载荷事件无参触发」被拒；但实际实现签名是宽松的：

```ts
emit<Key extends keyof Events>(type: Key, evt?: Events[Key]) {
  // ...
  handler(evt!);
}
```

实现里 `evt` 对所有键都标了可选，并用非空断言 `evt!` 兜底——运行时没传载荷就是 `undefined`，直接传下去空跑处理器，不抛错。

换来的是**运行时极简**与**类型精确并存**：编译期挡住不合法调用，运行时不为「没传载荷」专门抛错，因为类型层已经保证合法调用不会漏传。这是 mitt 一贯的工程取向——能编译期处理的，绝不上运行时分支。

代价是**对外契约与内部实现不一致**——读者翻到实现会发现「实现里所有键的载荷都可选，跟重载签名说的不一样啊」。这要求读者理解 TS 重载的常识——「重载签名是给用户的契约，实现签名是另一回事」——但 mitt 把它用在了「严格/宽松分离」的极致场景，初学者多半要绕几圈才搞明白。

本质矛盾：**对外承诺的强度**与**内部实现的简洁性**的对立——mitt 让类型层负责「挡住不合法调用」，运行时只管「不抛错地空跑」，各司其职。

## 5. 最小原理演示

下面这段 TS 演示**只演透「编译期筛键」这一个核心思想**——不涉及运行时存储、通配符、移除、快照。读者存为 `mini.ts`，跑 `tsc --noEmit --strict` 就能验证类型层行为。

```ts
// 一张事件映射：foo 必载荷，bar 可选载荷
type AppEvents = {
  foo: string;       // 必带数据
  bar?: number;      // 可不带数据
};

// 派发的对外契约：两条重载
interface MiniEmit<E extends Record<string, unknown>> {
  // 双参必传——任何键都允许走，但必须带符合键类型的载荷
  emit<Key extends keyof E>(type: Key, event: E[Key]): void;
  // 无参触发——条件类型逐键筛，只放行「载荷类型含 undefined」的键
  emit<Key extends keyof E>(
    type: undefined extends E[Key] ? Key : never
  ): void;
}

declare const api: MiniEmit<AppEvents>;

// 必载荷事件
api.emit('foo', 'hello');   // OK：带载荷触发
// @ts-expect-error         // 必载荷事件无参触发：'foo' 在条件类型里坍缩成 never，字符串赋不进 never
api.emit('foo');

// 可选载荷事件
api.emit('bar');            // OK：无参触发放行
api.emit('bar', 1);         // OK：也可带载荷触发
// @ts-expect-error         // 载荷类型错（应为 number | undefined）
api.emit('bar', 'oops');
```

最后四个调用是全章灵魂的微缩版：

- `'foo'` 无参 → 条件类型把它算成 `never`，字符串赋不进 `never` → 编译失败；
- `'bar'` 无参 → `AppEvents['bar']` 含 `undefined`，条件类型保留 `'bar'` → 放行；
- 载荷类型错 → 走第一条重载，被 `E[Key]` 挡住。

## 6. 执行轨迹

跟着 `api.emit('bar')` 走一遍编译期判定：

1. **入口**：用户调 `api.emit('bar')`，未传第二参。
2. **重载挑选**：TS 先试第一条重载——参数数量不够（缺 `event`），失败；试第二条重载。
3. **条件类型求值**：第二条要求第一参类型为 `undefined extends E[Key] ? Key : never`。把 `Key` 推断为 `'bar'`：
   - 取 `E['bar']` = `number | undefined`（因 `bar` 是可选属性）；
   - 问 `undefined extends (number | undefined)`？是；
   - 条件类型求值为 `'bar'`。
4. **赋值检查**：用户传的 `'bar'` 字面量赋给 `'bar'`，通过。
5. **放行**：调用合法，编译期结束。

对比 `api.emit('foo')` 在第 3 步岔开：

3'. 取 `E['foo']` = `string`；问 `undefined extends string`？否；条件类型求值为 `never`。
4'. 用户传的 `'foo'` 赋给 `never`？失败。
5'. 编译器报「`'foo'` 不能赋值给 `never`」——晦涩但有效。

运行时层面没东西可走：实现签名对所有键都把 `evt` 标可选，处理器直接收到 `undefined` 空跑一遍——这正是「内部实现宽松」那一条权衡的落点。

## 7. 教学简化说明

本章演示故意省略了：

- `mitt` 工厂函数与 `all` 注册表（已在「把 pubsub 退化成一张查找表」讲透）；
- `on`/`off` 的内部存储与 `GenericEventHandler` 联合 + `as` 断言还原（已在上一章讲透）；
- 通配符派发的双参签名（属于「通配符星号的第二条派发路径」）；
- 条件类型对**裸类型参数**的分布式求值细节——本章把 `Key` 当单键看已足够；只提醒一点：因为 `Key extends keyof Events` 是裸类型参数，条件类型会对联合类型逐成员求值再合并，所以「筛出的可无参触发键集合」天然是所有可选载荷键的并集；
- `exactOptionalPropertyTypes` 编译选项对判定的影响——mitt 自身 tsconfig 未开，索引取值稳定含 `undefined`；若你项目开了该选项，行为可能漂移，需自行验证。

## 8. 小结

mitt 把「这个事件能不能不带数据触发」的判定整个推给编译期——一行条件类型问 `undefined extends Events[Key]`，含则放行无参触发，不含则坍缩成 `never` 拒绝。运行时因此可以极简，不抛错也不分支。

下一章会暂时离开 TS 类型层，去看 mitt 的工程发布面：一份 TS 源码怎么同时产出 ESM、CJS、UMD，靠 `package.json` 的条件 exports 通吃所有 JS 运行时。

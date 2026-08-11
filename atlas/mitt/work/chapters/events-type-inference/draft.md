# 一张 Events 映射派生全 API 类型

> 本章属于 composite 层。前置：函数工厂与无 this 的方法 / 惰性初始化的追加式订阅 / 无分支安全移除与重载清空 / 快照式派发抵御中途改表。
> 学完你能：理解 mitt 为何只用一张「事件名 → 载荷类型」的字面量类型，就能让 on/off/emit 每个调用点的参数类型自动按这张表收窄，以及为什么这种类型精确只活在 API 边界、进到实现就退化为联合。

## 1. 为什么需要它（设计动机）

前六章讲透了 mitt 的运行时全貌：一张 `Map<事件类型, 处理器数组>` 作唯一状态（第 1 章）、靠闭包不靠 `this` 的方法（第 2 章）、追加式 `on` 与无分支 `off`（第 3、4 章）、快照式 `emit` 抵御中途改表（第 5 章）、通配符星号的第二条派发路径（第 6 章）。这些机制全部活在运行时。但 mitt 还有一层完全活在编译期的设计：用户只声明一张「事件名 → 载荷类型」的字面量类型，整条 `on/off/emit` 的参数类型就自动按这张表收窄。本章就接着这层「类型外衣」讲。

想象一下没有类型联动的发布订阅：你写 `bus.on('login', e => ...)` 和 `bus.emit('login', 42)`，编译器完全不报错——它只看到宽泛的 `(type: string, handler: Function)`，事件名和载荷的关系只在你的脑子里，错误得拖到运行时才暴露。一种笨办法是给每个事件写一套具名方法（`onLogin(handler: (e: LoginPayload) => void)`、`onLogout(...)`），但事件一多，样板代码线性膨胀，事件名也在两处重复（一处是字符串键、一处是方法名后缀）。

真正想要的是：只在**一处**登记事件名和载荷的对应关系，之后每个监听/触发调用点自动查这张表得出参数类型。

这里有个隐藏的张力：运行时的存储是**异质**的（一张 Map、每个键下挂一个数组，所有事件类型的处理器其实挤在同一个容器里，运行时根本不区分）；但类型层想要的恰好相反，每个调用点都要**精确同质**——监听 `login` 就只接受 `LoginPayload` 的回调。运行时异质 vs 类型层精确，这个张力就是本章所有设计的出发点。

## 2. 核心思想

把那张运行时查找表的「键 → 值」关系，**镜像**到类型层：类型层也是一张键→值映射（`Events extends Record<EventType, unknown>`），然后让每个方法用一个「键」类型参数去反查值类型。

一句话：**一处定义事件清单，所有监听/触发 API 的参数类型自动按这张清单查表得出**。

## 3. 心智模型

类型层的全部分量是三个零件：

**一张映射表**（用户唯一要供给的东西）：

```ts
function mitt<Events extends Record<EventType, unknown>>(...): Emitter<Events>
```

`Events` 是泛型参数，约束是「以事件类型为键、值上界为 `unknown`」的记录类型。`unknown` 上界意味着载荷可以是任何东西（数字、对象、`undefined`），但调用方必须在使用时显式收窄——既保留类型安全，又不限制载荷形态。

**一个键类型参数**（每个方法都有）：

```ts
on<Key extends keyof Events>(type: Key, handler: (event: Events[Key]) => void): void
```

`Key` 被约束为「这张表所有键的子集」。当你调用 `on('login', …)` 时，类型检查器从字面量 `'login'` 反向推断 `Key = 'login'`，再用 `Events['login']` 查表得到载荷类型，套用到 handler 的参数上。

**一套内部联合存储**（实现细节）：

```ts
type GenericEventHandler<Events> =
  | Handler<Events[keyof Events]>    // 单事件处理器：载荷是某事件的精确类型
  | WildcardHandler<Events>          // 通配符处理器：双参，载荷是全联合
```

实现里所有处理器被揉成一个联合，存进同一个数组。这就是运行时异质容器的类型表达。

调用链 A → B → C：

1. **调用点**：`on('login', handler)`，第一个实参是字面量 `'login'`
2. **类型层**：推断 `Key = 'login'`，签名展开为 `handler: (event: Events['login']) => void`
3. **运行时**：handler 被 `as` 断言为 `GenericEventHandler` 联合成员，存入异质 Map

第 1、2 步活在类型层、对外精确；第 3 步越过边界，类型信息被抹平为联合。**类型安全是一种边界属性**——公开 `Emitter` 接口对外精确，实现内部一律走联合 + 断言。

## 4. 关键权衡

### 一张映射表换全 API 类型派生

用户只供给一个类型参数 `Events`（值上界 `unknown`、载荷可任意）→ 换来**一处定义、全 API 派生**：监听回调里的事件参数自动收窄为该键的值类型，声明成本仅一张类型字面量 → 代价是事件清单必须**静态**（编译期已知），无法在运行时动态增删事件类型并保持类型安全。

矛盾点：事件集合该是闭集（声明期已知）还是开集（运行时可扩）。mitt 选了闭集——这是个刻意裁剪，假设你的事件源是有限的；如果你的系统要在运行时新增事件类型（比如插件系统），这套类型联动就直接失效，得退回宽泛的 `string`。

### 键字面量反查换事件名与载荷自动联动

每个方法都声明一个 `Key extends keyof Events` 类型参数，让类型检查器从**调用点的字面量实参**反向推断出 `Key`、再从映射表查出对应载荷 → 换来**事件名与载荷自动联动**：换事件名则载荷类型随之收窄，无需为每个事件手写一套具名方法 → 代价是推断**完全依赖字面量实参**——必须传字符串字面量 `'login'` 而非宽泛的 `string` 变量；如果你把事件名装进一个 `string` 变量再传，`Key` 会退化为全联合 `keyof Events`，载荷也随之退化为全联合。代价的另一面是事件名要同时充当**运行时键**和**类型键**，二者必须同名同形（你不能让运行时用 `'login'`、类型层用 `'signIn'`）。

矛盾点：调用点要精确、还是实参形式要灵活。mitt 选了精确，把「用变量传事件名」这个用法直接划出类型安全的范围——任何想动态决定事件名的代码都得自己承担失去类型联动的后果。

### 联合存储 + 类型断言换运行时单一容器

实现里把所有处理器揉成 `GenericEventHandler` 联合，写入时用 `as` 把「具体回调」塞进联合容器、读出时再用 `as` 转回「具体回调」→ 换来运行时只需**一个异质容器**（和第 1 章「把 pubsub 退化成一张查找表」的极简状态完全一致），公开接口对外呈现精确类型、内部实现却保持异质与极小 → 代价是 `as` 是**不安全的逃生口**：类型系统不再校验这次转换，存时把 Key 与 `Events[Key]` 配对正确、取时断言回正确类型，全靠作者人为保证。

这意味着类型安全**仅存在于公开 API 边界**——你调用 `bus.on(...)` 时被精确校验，但 mitt 自己的实现代码越过边界就退化为联合，类型系统不再保护它。mitt 用类型断言买了「对外精确、对内异质」这条窄路，这条路只在边界上走一次，内部全靠手工自律。

矛盾点：类型层对外要精确、运行时存储要单一异质。mitt 选了「对外精确、对内放手」——这正是「类型安全是一种边界属性」这一观察的来源。

### 通配符独立签名换双参精确

通配符星号 `'*'` 在类型层被单独写一条具体重载，而不是并入泛型签名：

```ts
on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void   // 泛型版
on(type: '*', handler: WildcardHandler<Events>): void                          // 通配符具体版
```

→ 换来通配符处理器有**独立且精确的双参签名**：第一参是事件名联合 `keyof Events`、第二参是全载荷联合 `Events[keyof Events]`；通配符字面量 `'*'` 是字符串字面量类型、与事件名键正交、不冲突 → 代价是每加一个通配符相关 API 签名数翻倍（监听/移除各两条重载），且通配符处理器的载荷是**全联合**、失去逐事件的精确性，用户在处理器内必须自行收窄。

矛盾点：通配符是双参特殊形态（要同时知道事件名和载荷）、单一泛型签名是统一形态。mitt 选了双签名——通配符是 catch-all，它的形态本就和单事件处理器不同构，硬塞进同一个泛型签名会让第二参无处安放。这条类型层权衡和上一章（运行时通配符的第二条派发路径）是一对：**运行时用第二条派发路径**让通配符走自己的调用流程，**类型层用第二条具体重载**让通配符走自己的签名——两章从不同侧面论证了通配符为什么必须从主路径里独立出去。

## 5. 最小原理演示

下面这段 TypeScript 只演透两件事：**键字面量反查联动**（权衡 2）和**联合存储 + 类型断言**（权衡 3）。完整事件总线（通配符、可选载荷）一律不演。

```ts
type EventType = string | symbol

// 用户唯一要供给的东西：一张「事件名 → 载荷类型」的字面量映射
// 值上界用 unknown，载荷可任意（含 undefined）
interface TypedEmitter<Events extends Record<EventType, unknown>> {
  // 键类型参数约束为这张表所有键的子集；handler 的参数由 Events[Key] 反查
  on<Key extends keyof Events>(
    type: Key,
    handler: (event: Events[Key]) => void
  ): void
  emit<Key extends keyof Events>(type: Key, event: Events[Key]): void
}

// 所有事件类型处理器的联合，运行时异质容器的类型表达
type GenericEventHandler<E> = (event: E[keyof E]) => void

function createEmitter<Events extends Record<EventType, unknown>>(): TypedEmitter<Events> {
  // 一张异质表：每个键下挂着该键的处理器的联合数组
  const all = new Map<keyof Events, GenericEventHandler<Events>[]>()

  return {
    on(type, handler) {
      const list = all.get(type)
      if (list) {
        // 边界处精确、内部断言为联合成员后存入
        list.push(handler as GenericEventHandler<Events>)
      } else {
        // 不安全的逃生口：as 把「某键的处理器数组」塞进「全联合数组」
        all.set(type, [handler] as GenericEventHandler<Events>[])
      }
    },
    emit(type, event) {
      const list = all.get(type)
      if (!list) return
      // 读出时断言回具体键的处理器类型，再调用
      list.slice().forEach(h => (h as (e: Events[typeof type]) => void)(event))
    }
  }
}

// 用户视角：声明一张映射，调用点自动收窄
interface AppEvents extends Record<EventType, unknown> {
  login: { userId: string }
  tick: number
}

const bus = createEmitter<AppEvents>()

// handler 的参数 e 自动收窄为 { userId: string }
bus.on('login', e => console.log(e.userId.toUpperCase()))

bus.emit('login', { userId: 'a' })      // ✅ 通过
// bus.emit('login', 42)                // ❌ 编译报错：42 不能赋给 { userId: string }
// bus.on('login', (e: number) => {})   // ❌ 编译报错：number 不能赋给 { userId: string }
```

把这份代码存成 `bus.ts` 跑一次 `tsc --noEmit bus.ts`：后两行注释去掉就会报错，注释着则编译通过。这个 `tsc` 行为本身就是核心思想的证明——类型层在调用点收窄，运行时存储仍然是异质联合。

## 6. 执行轨迹

输入一张映射：

```ts
interface AppEvents extends Record<EventType, unknown> {
  login: { userId: string }
  tick: number
}
const bus = createEmitter<AppEvents>()
```

调用 `bus.on('login', e => console.log(e.userId.toUpperCase()))` 时，类型检查器内部走的链：

1. **解析泛型签名**：`on<Key extends keyof AppEvents>(type: Key, handler: (event: AppEvents[Key]) => void)`
2. **从第一实参反推 Key**：实参是字面量 `'login'`、字面量类型 `'login'` 是 `keyof AppEvents` 的成员 → 推断 `Key = 'login'`
3. **签名展开**：把 `Key` 代入，得到 `on('login', handler: (event: AppEvents['login']) => void)`，等价于 `on('login', handler: (event: { userId: string }) => void)`
4. **校验第二实参**：传入的回调 `e => e.userId.toUpperCase()` 期望 `e: { userId: string }` → 兼容 → 编译期通过
5. **进入实现**：handler 被 `as GenericEventHandler<AppEvents>` 断言为联合成员，存进 `all.get('login')` 这个联合数组，运行时不再区分它是 `login` 的处理器还是 `tick` 的处理器

误用例：`bus.on('login', (e: number) => …)` 在第 3 步展开后，签名要求 `(event: { userId: string }) => void`，而实参是 `(event: number) => void`——`number` 不能赋给 `{ userId: string }`，第 4 步校验失败、编译期报错。这就是「反向索引联动」在类型层的全部工作机制。

## 7. 教学简化说明

- 通配符星号 `'*'` 的具体重载签名已在第 4 节作为权衡点出，但**没有演演示**——通配符在类型层的双参全联合载荷、与运行时第二条派发路径（上一章）的关系，点到即止。
- `emit` 还有一条条件类型重载（`undefined extends Events[Key] ? Key : never`），用于区分「可选载荷事件能否无参触发」——属紧邻下一章的核心，本章完全不展开。
- 演示代码故意省略了 `off`，只保留 `on` 和 `emit` 足以演透核心思想。

## 8. 小结

mitt 的类型层把运行时那张查找表的「键→值」关系在编译期重建一份：一张 `Events` 映射、一个 `Key extends keyof Events` 类型参数、一行 `Events[Key]` 反查，就这三件套，整条 on/off/emit 在每个调用点自动按这张表收窄。代价是事件清单必须静态、且实参必须是字面量；越往内部走，类型精确就越退化，最终落在异质联合 + `as` 断言上——类型安全只活在 API 边界。

到目前为止，`emit` 的签名是 `emit<Key>(type: Key, event: Events[Key])`，强制你触发时必须给载荷。但实际场景里，有些事件（比如 `logout: undefined` 或可选属性的 `bar?: number`）应该允许无参触发——这就要靠条件类型在编译期判定「这个事件能不能不带载荷」。下一章就讲这条条件类型重载。
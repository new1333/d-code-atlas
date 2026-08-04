# 一张 Events 映射派生全 API 类型

想象你在用一个发布订阅库。某处你写下 `on('login', handler)`，另一处 `emit('login', data)`。这俩之间如果没有类型联动，`handler` 收到的 `data` 到底是什么？编译器不知道，它只告诉你 `data: any`。于是你给 `login` 事件顺手传了个数字，编译期一声不吭，等你上线了才发现 handler 里把数字当对象解构，运行时炸了。

想安全的话，老办法是给每个事件手写一套具名方法：`onLogin((user: User) => void)`、`onLogout(() => void)`……事件一多，样板代码跟着线性膨胀。

我们真正想要的是：**只声明一份「事件名 → 数据类型」的清单，之后每个 `on`/`off`/`emit` 调用点的参数类型，自动按这份清单查表得出。** 不写第二遍。

这就是 mitt 在类型层干的事。前面几章我们都在讲运行时——那张「事件名 → 处理器数组」的查找表、闭包捕获的 `all`、首次注册即建表、位运算移除、快照派发——那些运行时机制都已讲透，本章不重复。这一章把镜头切到**类型层**：给那张运行时表套上一层「键 → 值类型」的类型映射，让运行时的 key→value 关系在类型层也成立。

它要解的矛盾一句话能说清：**运行时存储是异质的**（一个数组同时装着所有事件类型的处理器），**但类型层想让每个调用点既同质又精确**（监听 foo 就只接受 foo 的数据类型）。这个张力，就是本章全部设计的出发点。

## 一、起点：一张「事件名 → 数据类型」的清单

整条类型推导的唯一输入，就是函数工厂上那个类型参数——你调 `mitt<...>()` 时尖括号里写的东西：

```ts
function mitt<Events extends Record<EventType, unknown>>(all?): Emitter<Events>
```

`Events` 就是那张清单。`Record<EventType, unknown>` 是它的约束：键必须是事件名（`string | symbol`），值可以是任何类型。这里关键是值用 `unknown` 当上界——意思是「我允许你填任何类型当值，但默认我不假设它是什么」。你只需要传一张字面量对象类型进去：

```ts
const emitter = mitt<{
  foo: string;                 // 必带数据：字符串
  someEvent: { name: string }; // 必带数据：对象
  bar?: number;                // 可选数据：可以不附带
}>();
```

这张清单是后面所有 API 类型推导的**唯一来源**，没有第二个输入。

打个比方：这张清单就像一张对照表，左边是词（事件名），右边是释义（数据类型）。后面每次调用，类型检查器都是拿事件名去**查这张表**，把查到的释义填进回调参数。你不背释义，查表的事它来。

## 二、反向索引：给个事件名，查回数据类型

清单有了，怎么让 `on` 用上它？关键就一行签名：

```ts
on<Key extends keyof Events>(type: Key, handler: (e: Events[Key]) => void): void
```

盯着 `Key extends keyof Events`。`Key` 是个类型参数，被约束成「Events 所有键里的某一个」。`keyof Events` 在上面那张清单里展开就是 `'foo' | 'someEvent' | 'bar'`。

当你写下 `emitter.on('foo', e => …)`，背后发生的事：

```
emitter.on('foo', e => ...)
   │
   ① 第一参是字面量 'foo' ──> 推断 Key = 'foo'
   │
   ② 把 Key 代进签名 ──> handler: (e: Events['foo']) => void
   │
   ③ 查表 Events['foo'] = string
   │
   └─> handler 里的 e 被锁定为 string
```

没人手写这个 `string`——它是从你调用点的事件名字面量**反查**清单得来的。这就是「反向索引」：不是正向地为每个事件具名一个方法，而是反过来，让类型检查器从你传的事件名往回推出 Key、再查表。

换事件名，数据类型自动跟着变：`on('someEvent', e => …)` 里的 `e` 是 `{ name: string }`；`on('bar', e => …)` 里的 `e` 是 `number | undefined`。你只动事件名，类型检查器自己换释义。

反过来也生效——你若给 foo 传一个 `(e: number) => void` 的回调，编译期直接报错，因为 `number` 没法塞进 `string` 的位子。**错在编译期挡下，不会留到运行时。**

> `off` 和 `emit` 用的是同一套反向索引，签名同构（`off<Key>(type, handler?: Handler<Events[Key]>)`、`emit<Key>(type, event: Events[Key])`），原理一模一样，不再演示。

## 三、越过边界：类型安全是一种「边界属性」

读到这里你可能会问：handler 存进那张运行时查找表之后，类型信息还在吗？

**不在了。** 这是最值得想清楚的一点。

运行时存储长什么样，前面几章讲过——一张 `Map<事件名, 处理器数组>`。问题在于，这张 Map 要同时装下**所有事件类型**的处理器：foo 的吃 string、someEvent 的吃对象、通配符的吃双参……它们在运行时被揉进**同一个数组**。

类型层怎么表达「一个数组里装着各种不同签名的处理器」？只能用**联合类型**：

```ts
type GenericEventHandler =
  | Handler<Events[keyof Events]>   // 某个事件的处理器，值类型是「全联合」
  | WildcardHandler<Events>;        // 通配符处理器
```

`Events[keyof Events]` 把清单里所有值类型「或」在一起：`string | { name: string } | number | undefined`。这就是「运行时异质容器」在类型层的直接写法——一个什么处理器都吃得下的盒子。

矛盾就来了：你**存进去**的是具体回调（吃 string 的），**盒子的类型**却说是吃联合的。这俩对不上。怎么办？mitt 的办法是存的时候用 `as` 断言，**强行声明**「这个吃 string 的回调，也算吃联合的，相信我」：

```ts
all.set(type, [handler] as EventHandlerList<Events[keyof Events]>);
//                         ^^^ 类型系统不再校验这次转换
```

`as` 是 TypeScript 的逃生口，它告诉类型检查器「别管了，我说它是什么就是什么」。越过 API 边界、进入实现内部的那一刻，精确的类型信息就丢了，退化成联合。

所以：**类型安全是一种边界属性。** 公开的 `Emitter` 接口，对外呈现的是精确的「事件名 ↔ 数据类型」联动；但一越过边界进入库的实现，就只剩联合 + 断言。库自己实现的代码，类型对不对不靠类型系统保证，而靠作者心里有数——「存的时候 Key 跟 `Events[Key]` 配对、取的时候断言回对的类型」。

说白了，这个「外面包一层精确类型、内部用联合兜底」是给一张运行时异质表套类型的**唯一现实做法**：不这么干，你要么放弃内部统一容器（每个事件条目都独立类型化，几乎写不出来），要么放弃对外精确（所有 API 都退化成 `any`）。

## 四、通配符：单独再开一条签名

通配符 `'*'` 在运行时是另一条派发路径（这运行时行为前面讲过了，不重复）。在类型层，它也有自己的特殊待遇。注意 `on` 有**两条重载**：

```ts
on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void;  // 泛型版
on(type: '*', handler: WildcardHandler<Events>): void;                          // 通配符专用版
```

第二条把事件名固定写死成 `'*'`，handler 固定是 `WildcardHandler<Events>`。为什么通配符不能并进第一条泛型签名？因为它收**所有**事件，回调拿到的是双参——第一参是「事件名联合」，第二参是「所有数据类型的联合」：

```ts
type WildcardHandler<Events> = (
  type: keyof Events,         // 'foo' | 'someEvent' | 'bar'
  event: Events[keyof Events]  // string | { name: string } | number | undefined
) => void;
```

这个双参签名跟单事件的单参签名根本不是一个形状，没法塞进同一个泛型签名里，所以单独开一条。

这里有个有趣的边角：测试里 `on('*', fooHandler)` 居然合法，而 `fooHandler` 是 `(x: string) => void`。为什么？因为通配符第一参 `'foo' | 'someEvent' | 'bar'` 这些字面量都是 string，能赋给 `string`，且回调可以忽略第二参。反过来 `on('*', barHandler)`（要 `number?`）就不行——第一参是字符串联合，塞不进 number。这是函数参数变异性的细节，点到为止，不展开。

## 关键权衡

### 权衡 1：单张映射表作为唯一类型源

- **选择**：让用户只供给一个「事件名 → 数据类型」的类型参数（值上界是 `unknown`，所以数据类型可任意）。
- **换来**：「一处定义、全 API 派生」——监听回调里的事件参数自动收窄成该键的值类型，声明成本仅一张类型字面量。后面加一个事件，只在清单里加一行，所有调用点立刻跟着联动。
- **代价**：事件清单必须**静态**（编译期已知）。你没法在运行时动态地 `delete` 一个事件类型、还指望类型系统跟着更新——类型在编译完就固化了。运行时异质、类型层静态，这两者的错位正是这张表带来的根本约束。

### 权衡 2：用「键」类型参数反向索引，而非正向具名枚举

- **选择**：每个方法都声明一个 `Key extends keyof Events` 的类型参数，从**调用点的事件名字面量**反推出 Key，再查表得数据类型。
- **换来**：事件名和数据类型**自动联动**——换事件名，数据类型随之收窄；你永远不用为某个事件手写一套具名方法（`onFoo`/`onBar`…）。事件再多，API 表面只有 `on`/`off`/`emit` 三个。
- **代价**：推断**死依赖字面量实参**。你必须传字符串字面量 `'foo'`，不能传一个宽泛的 `let type: string = 'foo'`——一旦实参是宽泛的 `string`，类型检查器没法把 Key 收窄成 `'foo'`，它退回成全联合，数据类型也跟着退化成联合，联动就失效了。而且事件名要同时充当运行时键和类型键，二者必须同名同形，不能各起一套。

### 权衡 3：内部存储用联合 + 断言，换类型层与运行时解耦

- **选择**：实现里把所有处理器揉成一个联合，存取时用 `as` 断言在「联合」和「具体」之间来回转换。
- **换来**：运行时只需要**一个异质容器**（跟极简状态那张表完全一致，不因加了类型就变复杂），公开接口对外精确、内部实现却保持异质与极小。类型层是「外衣」，不改变运行时结构。
- **代价**：类型断言是**不安全的逃生口**。类型系统不再校验存取一致性——你完全可以 `as` 断言一个错的类型进去，编译器也不吭声。类型安全只活在公开 API 边界，越过边界进入实现立刻退化为联合。库的实现正确性，是作者用纪律（而非类型系统）保证的。

### 权衡 4：通配符用独立的具体重载，而非并入泛型签名

- **选择**：为 `on`/`off` 各写两个签名——泛型版（任意事件名）+ 通配符具体版（双参）。
- **换来**：通配符处理器有**独立且精确的双参签名**（第一参是事件名联合、第二参是全数据联合），而且通配符字面量 `'*'` 跟事件名键正交、不冲突——`'*'` 永远不会出现在用户的 `Events` 清单里，所以两条重载不会撞车。
- **代价**：每加一个通配符相关的 API，签名数直接翻倍（`on` 两条、`off` 两条、`emit` 内部也得分流）。而且通配符处理器拿到的数据是**全联合**、失去了逐事件的精确性，用户在回调里得自己收窄类型。

## 演透原理：最小类型化发射器

把上面几节揉成一个能跑的最小骨架。这段演示集中演两件事：**权衡 2（反向索引联动）** 和 **权衡 3（联合存储与断言）**。通配符那条省略，移除/触发的完整实现也不重复——监听这一条路径演透了，其余同理。

```ts
// ============ 类型层：一张清单派生全 API ============

// 值上界 unknown：允许任意数据类型，但不假设它是什么
type Handler<T = unknown> = (event: T) => void;

interface Emitter<Events extends Record<string, unknown>> {
  // 反向索引：Key 从调用点的事件名字面量推出来，再查表得 Events[Key]
  on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void;
  emit<Key extends keyof Events>(type: Key, event: Events[Key]): void;
}

// ============ 实现：联合容器 + 断言（越过边界即退化） ============

function createEmitter<Events extends Record<string, unknown>>(): Emitter<Events> {
  // 运行时异质容器：一个数组装着所有事件类型的处理器。
  // 类型层只能把它表达成「什么处理器都吃」的联合。
  type AnyHandler = Handler<Events[keyof Events]>;
  const table = new Map<keyof Events, AnyHandler[]>();

  return {
    on<Key extends keyof Events>(type: Key, handler: AnyHandler) {
      //                                  ^^^^^^^^^^
      //   公开接口说 handler 是 Handler<Events[Key]>（精确），
      //   可一旦进到实现内部，它就已经是 AnyHandler 联合了——精度在这里丢了。
      const list = table.get(type);
      if (list) list.push(handler);
      else table.set(type, [handler]);
    },
    emit<Key extends keyof Events>(type: Key, event: Events[Key]) {
      const list = table.get(type);
      // 拿出来用时，再把精确的 event 断言成联合喂给 handler。
      // 这就是「越过边界后退化、靠断言抹平」的那个点。
      (list ?? []).slice().forEach((h) => h(event as Events[keyof Events]));
    },
  };
}

// ============ 用一下：看联动效果 ============

const bus = createEmitter<{ foo: string; login: { name: string } }>();

// ✅ 联动生效：on('foo') 的回调参数自动收窄为 string
bus.on('foo', (e) => {
  //       ^? e: string —— 没人手写，是反查清单得来的
  console.log(e.toUpperCase());
});

// ❌ 报错：给 string 事件传 number 回调，编译期挡下
// bus.on('foo', (e: number) => {});
//   ~~~ Type 'number' is not assignable to type 'string'.

// ✅ 换事件名，数据类型自动跟着变
bus.on('login', (user) => {
  //           ^? user: { name: string }
  console.log(user.name);
});

// ❌ 报错：emit 的实参类型跟清单对不上
// bus.emit('foo', 123);
//               ~~~ Type 'number' is not assignable to type 'string'.

// ✅ 正确触发
bus.emit('foo', 'hello');
```

把这段存成 `demo.ts`，配一个最小 `package.json`（装上 `typescript`），跑一句 `npx tsc --noEmit demo.ts`：你会看到，注释掉的两行取消注释后**编译失败**，而保留注释时**编译通过、且回调参数 `e`/`user` 的类型被精确推导出来**。一个不跑、光编译的过程，就把「收窄」和「报错」两个效果演透了——这正是用 TS 当演示载体的理由：本章演的就是类型层，离了类型层，这套原理根本不存在。

最小 `package.json`：

```json
{
  "name": "mitt-type-demo",
  "private": true,
  "devDependencies": { "typescript": "^5" },
  "scripts": { "check": "tsc --noEmit demo.ts" }
}
```

盯住演示里那两个 `as`/联合出现的点：`on` 的实现参数已经是 `AnyHandler`（公开接口说它是精确的，进实现就退化）；`emit` 里 `event as Events[keyof Events]`（精确值断言成联合喂回去）。**精度只活在边界上**——这正是权衡 3 说的那条铁律的可视化。

## 小结

mitt 的类型层就做了一件事：用一张「事件名 → 数据类型」的清单当唯一来源，让 `Key extends keyof Events` 从每个调用点的事件名字面量反查清单，把查到的类型套到回调参数上。传错类型，编译期就挡下，不会留到运行时。

代价落在两处：一是清单必须静态，运行时动态增删事件类型没法保持类型安全；二是类型精确只活在公开 API 边界，一进实现就退化为联合 + 断言，存取一致性靠作者人为保证，类型系统不再过问。

还有一类事件我们故意没展开——`bar?: number` 这种**数据可选**的事件。你大概已经注意到了：`on('bar', e => …)` 里的 `e` 是 `number | undefined`，而 `emit('bar')`（啥都不传）居然合法。为什么有的事件能无参触发、有的不能？这个判定 mitt 用了一条条件类型重载，那是紧邻下一章的主角：条件类型如何区分那些「数据可选」的事件。
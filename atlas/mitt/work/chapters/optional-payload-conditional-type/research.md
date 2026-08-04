# 条件类型区分可选载荷事件 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：很多事件其实没有「载荷」——比如「登录态变更」「任务结束」这类信号事件，触发时根本不需要附带数据。可如果一个发布订阅库把派发动作的载荷参数写死成「必传」，用户就被迫写出 `emit('logout', undefined)` 这种空转调用；反过来若写成「一律可选」，又会丢掉对「必带数据的事件」的保护——用户手滑漏传载荷时编译器一声不吭，运行时处理器拿到 undefined 炸掉。痛点是：**同一个 API，如何让「无载荷事件」和「必载荷事件」走不同的类型校验通道**。

- **一句话核心思想**：在编译期问一句「这个事件的载荷类型里到底允不允许出现 undefined」，据此把派发动作劈成两条类型通道——允许缺省的走「无参触发」通道，不允许的直接拒绝。

- **设计动机（为什么需要它）**：用户在声明事件清单时，自然会用「这个键标成可选属性」来表达「它的事件可能不带数据」。库要做的就是把这种「可选」的语义，从运行时一直贯穿到派发的类型签名上，让「无参触发」这件事对编译器而言是可判定的。其中承前关系很明确：（已在第 7 章『一张 Events 映射派生全 API 类型』讲透「一张事件映射 + keyof 反向推导 + 内部用宽泛的处理器联合体并以断言还原」这个总机制，本章只看它的一个新侧面——不再讲『键怎么反推出载荷类型』，而是讲『载荷类型能不能被判定为可缺省，从而给派发单独开一条编译期通道』），Writer 不要重演「键反推载荷」的原理。

- **关键权衡（3 条三段式）**：
  1. **选择「两条重载分流」而非「一条可选载荷参数」** → 换来了「必带载荷的事件绝对无法无参触发」的硬编译期保证（漏传 payload 直接编译失败） → 代价是派发方法必须写两条签名，其中第二条是一条晦涩的条件类型表达式，初读几乎看不懂。
  2. **选择「拿『载荷类型里是否包含 undefined』当判定依据」** → 换来了零额外配置——用户只要在事件映射里把某个键写成可选属性，就同时表达完了「这个事件可无参触发」，无需任何开关或注解 → 代价是这个判定完全隐式，依赖「可选属性 ⇒ 索引取值得到的类型必含 undefined」这条 TypeScript 语义约定，读代码的人看不到这条隐含桥梁。
  3. **选择「对外的类型签名严格、内部实现签名宽松」相分离** → 换来了运行时极简（没传载荷也不抛错，空跑一遍处理器即可）与类型精确并存 → 代价是对外暴露的契约（无参触发只放行可选载荷事件）与内部实现（载荷对所有事件都可选、且用非空断言兜底）不一致，读者需理解「重载签名是给用户的契约，实现是另一回事」。

- **最小心智模型（6 步）**：
  1. 用户在事件清单里把某事件声明为可选属性，自然表达了「它可能不带数据」。
  2. 类型系统把该键的取值解析为「值或 undefined」。
  3. 注册处理器时，处理器的入参因此天然能接收「值或 undefined」。
  4. 派发的第一条通道要求「键 + 载荷」双参必传。
  5. 派发的第二条通道是一个条件类型：它问每个键「你的载荷类型含不含 undefined」，只把「含」的那些键放进来，把「不含」的键坍缩成永不类型。
  6. 于是调用无参派发时：可选载荷事件的键落进第二条通道放行；必载荷事件的键在条件类型里被算成永不类型，键值赋值给永不类型失败 → 编译期拒绝。

- **最小原理演示（演透原理）**：
  - 应演示：一个只表达「编译期筛键」核心思想的最小复刻——定义一个含「可选属性键」和「必填属性键」的事件清单；用同样的条件类型把「可无参触发的键」单独筛成一个类型；为派发写两条签名（双参 vs 仅筛出的键子集）；用一组调用展示「必填载荷键无参触发被拒、可选载荷键无参触发放行」。
  - 应故意省略：通配符派发、移除/清空、运行时存储、快照迭代、完整的工厂函数——这些都不是本章原理点。
  - 演示载体建议：**首选 TypeScript**。本章核心纯粹是类型层面的编译期判定（条件类型 + 索引取值 + 永不类型），TypeScript 类型系统就是机制本身；JavaScript 完全无法表达「编译期筛键」这一步，所以必须用 TS。好在 TS 属于本 Atlas 首选的 TS/JS 生态，配一个最小 `package.json`（仅 `typescript` 依赖 + 一条 `tsc --noEmit` 脚本）即可让读者 `npm run check` 验证类型层的行为。演示里对「放行/拒绝」的断言可用 `@ts-expect-error` 注释表达，与原仓库测试手法一致。**无需退回原仓库语言**——mitt 本身就是 TS，TS 既是首选也恰好与原仓库主语言一致。

- **正文不宜展开的细节**：① 条件类型在「裸类型参数」上的分布式求值细节（属 TS 类型体操常识，点到「它会逐成员判定」即可，不必展开分配律证明）；② `exactOptionalPropertyTypes` 编译选项对判定的影响（默认未开，索引取值稳定含 undefined，可一句话带过）；③ `emit('*')` 为何被禁止（属于通配符章，非本章）；④ 实现里非空断言 `!` 的取舍（运行时兜底，正文可只一句带过）。

- **推荐的一个执行轨迹例子**：
  - 输入 `emit('可选载荷事件')`：取该键类型 = `值 | undefined` → 条件类型问「undefined 能否赋给它」= 是 → 第二通道的参数类型保留为该键 → 放行 → 运行时载荷为 undefined → 处理器收到 undefined（对该事件合法）。
  - 对比 `emit('必载荷事件')`：取该键类型 = `值`（不含 undefined）→ 条件类型求值为「永不类型」→ 该键无法赋值给永不类型 → 编译期报错。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **派发的两条重载签名**：第一条 `emit<Key extends keyof Events>(type: Key, event: Events[Key]): void` 是双参必传通道；第二条 `emit<Key extends keyof Events>(type: undefined extends Events[Key] ? Key : never): void` 是无参触发通道，其参数类型是一个条件类型——只在「undefined 可赋给该键的载荷类型」时把键保留下来，否则坍缩为 `never`。这是全章灵魂。 源码位置: src/index.ts:35-38

- **判定锚点是「可选属性 ⇒ 索引取值含 undefined」**：当用户写 `bar?: number` 时，`Events['bar']` 的索引访问类型为 `number | undefined`，于是 `undefined extends Events['bar']` 成立，`bar` 被保留进无参通道；而 `foo: string` 的 `Events['foo']` 为 `string`，`undefined extends string` 不成立，`foo` 被算成 `never`，无法无参触发。 源码位置: src/index.ts:36-38（判定逻辑）；佐证：测试清单 `bar?: number` 与 `foo: string` 的对比断言 test/test-types-compilation.ts:9-13

- **条件类型对裸类型参数是分布式的（推断）**：`Key extends keyof Events` 是裸类型参数，故 `undefined extends Events[Key] ? Key : never` 会对联合类型的每个成员逐个求值再合并。这使得「筛出的可无参触发键集合」天然是所有可选载荷键的并集。标注为推断：源码无注释说明此意，但从条件类型语法可判定其语义必然如此。 源码位置: src/index.ts:36-38

- **on 的处理器签名承接同一可缺省性**：`on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>)` 中，`Handler<Events['bar']>` 的入参类型为 `number | undefined`，因此可选载荷事件的处理器本就应写成 `(x?: number) => {}`。即「载荷可缺省」在注册侧与派发侧是一以贯之的。 源码位置: src/index.ts:26；佐证处理器写法 test/test-types-compilation.ts:15

- **对外契约严格 vs 内部实现宽松**：对外接口里无参触发仅放行可选载荷事件；但实现签名为 `emit<Key extends keyof Events>(type: Key, evt?: Events[Key])`——实现里 `evt` 对所有键都标了可选，并用 `handler(evt!)` 非空断言兜底（运行时没传就是 undefined 直接传下去）。类型层负责「挡住不合法的无参触发」，运行时只管「不抛错地空跑」。 源码位置: src/index.ts:103,109（以及通配符路径的 `handler(type, evt!)` 同理 src/index.ts:118）

- **测试是「类型层断言测试」，非运行时测试**：该文件无运行时断言，纯靠 `// @ts-expect-error` 标注——被标注行若编译器未报错，则类型测试失败。由独立脚本 `tsc test/test-types-compilation.ts --noEmit --strict` 驱动。 源码位置: test/test-types-compilation.ts:68-69,74（关键正反例）；脚本定义见 package.json 的 `test-types`

- **编译选项佐证判定稳健**：tsconfig 为 `strict: true` 且未开启 `exactOptionalPropertyTypes`，故可选属性的索引取值稳定为「值 | undefined」，判定不受额外选项干扰。 源码位置: tsconfig.json（compilerOptions）

## 关键调用链

（本章为类型层机制，无运行时调用链；核心是「类型求值链」）

事件清单里某键可选属性
　→（TS 索引取值）该键载荷类型 = `值 | undefined`
　→（第一条重载）双参通道：要求传载荷
　→（第二条重载）条件类型逐键求值：`undefined extends 载荷类型 ? 键 : never`
　→ 含 undefined 的键被保留 / 不含的键坍缩为 never
　→ 无参派发调用：键能否赋值给「筛出的键集合」决定编译期放行/拒绝

源码位置: src/index.ts:35-38（两条重载） → src/index.ts:103（实现签名）

## 源码摘录（带行号，全文累计 ≤ 30 行）

派发的两条重载（本章灵魂——双参通道 + 条件类型无参通道）：

```ts
// src/index.ts:35-38
	emit<Key extends keyof Events>(type: Key, event: Events[Key]): void;
	emit<Key extends keyof Events>(
		type: undefined extends Events[Key] ? Key : never
	): void;
```

实现签名宽松（evt 对所有键可选）+ 非空断言兜底：

```ts
// src/index.ts:103,109
	emit<Key extends keyof Events>(type: Key, evt?: Events[Key]) {
		...
							handler(evt!);
```

测试用事件清单（`foo` 必填载荷、`bar` 可选载荷，构成对比组）：

```ts
// test/test-types-compilation.ts:9-13
const emitter = mitt<{
	foo: string;
	someEvent: SomeEventData;
	bar?: number;
}>();
```

无参派发的正反例断言（`foo` 拒、`bar` 放行）：

```ts
// test/test-types-compilation.ts:68-77
	// @ts-expect-error
	emitter.emit('foo');
	emitter.emit('foo', 'string');

	emitter.emit('bar');
	emitter.emit('bar', 1);
	// @ts-expect-error
	emitter.emit('bar', 'string');
```

## 易混淆 / 边界 / 推断

- **事实**：`emit('bar')`（无参）合法、`emit('foo')`（无参）非法，二者唯一差异是清单里 `bar` 为可选属性、`foo` 为必填属性。 源码位置: test/test-types-compilation.ts:69,74
- **事实**：必载荷事件的载荷类型校验同样生效——`emit('foo', 1)` 报错（应为 string）、`emit('bar', 'string')` 报错（应为 number|undefined）。 源码位置: test/test-types-compilation.ts:71,77
- **推断（标注为推断）**：判定稳健的前提是「可选属性 ⇒ 索取值含 undefined」。tsconfig 未开 `exactOptionalPropertyTypes`，该前提成立；若用户项目单独开启该选项，行为是否仍一致未在仓库内验证（mitt 自身 tsconfig 未开，故其测试稳定）。
- **推断（标注为推断）**：第二条重载用「永不类型 never」拒绝而非「报错信息友好的约束」，意味着用户漏写载荷时收到的是「参数不可赋值给 never」这类晦涩报错，而非「该事件必须带载荷」的直白提示——这是换取极简签名的可读性代价，源码无注释说明，据语义推断。
- **未理解**：暂无阻塞性未解项。唯一可在正文略提的边界——`emit('*')` 手动触发通配符被刻意禁止（注释明示），但该机制属于通配符章，本章不展开。 源码位置: src/index.ts:97-98（注释）
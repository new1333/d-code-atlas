# storeToRefs：从 reactive store 定向提取 ref

## 想解构 store 来用，响应性却丢了

你写了个计数 store，然后在某个组合式函数里顺手这样用：

```ts
const { count, double } = useCounterStore()
```

干净、顺手——可你很快发现 `count` 不再响应了：它变成了一个固定的数字，store 里 count 改了，这边纹丝不动。

说人话就是：解构本质上是「把值抠出来，塞进一个新变量」。store 是个响应式代理，你这一抠，响应性就断在抠的那一下——拿到的是当时的快照，不是能跟着变的活值。`double` 同理，也成了一个写死的数字。

那不解构、直接写 `store.count` 行不行？当然行，但有些场景就是不顺手：比如要把状态传给一个只接收 ref 的组合式函数，或者写 `watch(count, ...)` 期望它单独响应。所以大家真正想要的，是一个「解构之后还保持响应」的办法。这就是 `storeToRefs` 要解决的问题。

## 想用 Vue 自带的 toRefs？它会把方法也包坏

你大概会想：Vue 不是原生就有个 `toRefs` 吗，专门把响应式对象拆成一堆 ref？那 `toRefs(store)` 不就完事了？

直觉上对，但这里有个坑。store 里不只有数据，还混着方法（actions）。而 `toRefs` 干的活是「把这个响应式对象的**每一个**属性都变成 ref」——它压根不挑，也不该挑，因为它的职责就是让对象可解构，它不知道、也不关心哪个属性是数据、哪个是方法。

于是 `toRefs(store)` 会把方法 `increment` 也当成普通属性包成一个 ref。结果调用它得写成 `wrong.increment.value()`——先 `.value` 再调用。方法被「包坏」了，没法照常 `increment()` 直接调。换句话说，`toRefs` 答错了问题：它回答的是「让所有东西都可解构」，而我们问的是「只把数据挑出来、保持可解构，方法别碰」。

为什么会这样？因为 store 是个「数据 + 派生值 + 方法」三样混在一起的大杂烩。至于它**为什么**被做成这种形态，第 4 章装配那一节已经讲透了，这里只把它当一个已知前提。本章要解决的是新问题：既然 store 长成这样，从它身上**只把数据定向拆出来**时，该怎么区分这三样。

## 绕到后门看真身

问题出在「隔着代理看」。

store 是个响应式代理对象——打个比方，它像一间装了单向玻璃的展厅：从外面（通过代理）访问，所有展品看起来都一个样，你隔着玻璃摸不出某件东西到底是会变的仪表盘、还是一个按了会动的按钮。要看清每件展品的真身，得绕到后门的仓库——也就是 `toRaw(store)` 拿到的那个原始对象，那里东西没经过代理包装，是啥就是啥。

这个「绕过代理、拿原始存储」就是整个机制的第一步，也是关键一步。直接在代理上遍历，一来会无谓地触发依赖收集，二来拿到的值是被代理转换过的，分不清谁是谁。绕到原始对象，才能按每个值「运行时长什么样」去挑。

## 三分流：按运行时长相挑数据

拿到原始对象后，逐个 key 遍历，按值的样子分流。整个流程是一条单向流水线：

```
toRaw(store)  →  for key in 原始对象  →  逐个值三分流  →  拼成结果对象

三分流：
  ┌─ value 身上带 effect 字段      → 派生值(computed)  → 重包成「读写都代理回 store」的可写 computed
  ├─ isRef(value) 或 isReactive(value) → 状态          → 用 toRef(store, key) 绑回 store
  └─ 其余（方法、纯对象等）        → 跳过（没有 else，直接漏掉）
```

注意最后一类——方法和那些既不是响应式、也没内部标记的属性——是「没有任何分支接住它」才被丢掉的，不是靠一个显式的 `else` 丢的。这恰恰是「跳过 action」的实现方式：不在白名单里的，自然就落空了。

还有个细节值得点一句：判定一个值是不是「派生值（computed）」，Vue 并没有给公开 API。这里靠的是去摸 computed 对象身上的一个内部字段（`effect`）——computed 内部就是用一个 effect 算值的，普通 ref 没有这个字段。摸到了就是派生值，摸不到就不是。这是个能用的土办法，但也埋了个隐患，后面权衡里细说。

## 从零写一个迷你 storeToRefs

把上面的思路拼成一段能跑的代码。先用 Vue 的响应式 API 拼一个迷你 store（一个状态、一个派生值、一个方法），然后先演反例（原生 toRefs 把方法包坏），再演正解（自己写的定向提取器）。

```ts
import { reactive, ref, computed, toRaw, toRef, toRefs, isRef, isReactive } from 'vue'

// ① 拼一个迷你 store：状态 + 派生值 + 方法，全塞进一个 reactive
const state = ref(1)
const store = reactive({
  count: state,
  double: computed(() => state.value * 2),
  increment: () => { state.value++ },
})

// ② 反例：直接用原生 toRefs
const wrong = toRefs(store)
console.log(typeof wrong.increment)   // 'object' —— 方法被包成了 ref！
console.log(wrong.increment.value)    // [Function] —— 调用得先 .value 再 ()
console.log(wrong.double.value)       // 2

// ③ 正解：自己写的定向提取器
function myStoreToRefs(store) {
  const raw = toRaw(store)            // 绕过代理，拿原始对象
  const refs = {}
  for (const key in raw) {
    const value = raw[key]
    if (value?.effect) {
      // 派生值：重包成「读写都代理回 store」的可写 computed
      refs[key] = computed({
        get: () => store[key],
        set: (v) => { store[key] = v },
      })
    } else if (isRef(value) || isReactive(value)) {
      // 状态：用 toRef 把它绑回 store
      refs[key] = toRef(store, key)
    }
    // 方法 / 非响应式属性：没有 else，自然被跳过
  }
  return refs
}

// ④ 验证
const { count, double } = myStoreToRefs(store)
console.log(count.value, double.value)  // 1 2
count.value = 10                        // 改状态
console.log(double.value)               // 20 —— 派生值跟着重算了
// increment 不在结果里，没有被破坏
```

跑下来你能亲眼看到三件事：原生 `toRefs` 把 `increment` 包成了 object（坏了）；自己写的提取器把它干净地跳过了；改了 `count`，`double` 立刻重算——响应性没丢，方法也没碰。这就是「定向提取」的全部要义。

## 关键权衡

这一节是真正「学原理」的部分。这套提取机制看着短，背后藏着几个非显然的取舍。

**权衡一：放弃原生 toRefs，改写一套定向遍历。** 选择是自己遍历原始存储、按值类型分流，换来的是能精确跳过方法、只挑数据和派生值且不破坏响应性；代价是必须亲手维护一套判别逻辑，而这套逻辑还得跟「装配时」的分类**完全对得上**。说白了，store 装配那一刻就在按 `isRef/isReactive`、`typeof function`、`isComputed` 把返回值分进三类桶；现在提取时，又得把同样的判别再来一遍、只是判完去干另一件事。判据两边必须对称——装配端换个口径（比如哪天改了 computed 的识别方式），提取端就得跟着改，否则数据会错位。一份分类逻辑被写了两遍、且彼此不能漂移，这是放弃了 `toRefs` 这个现成轮子要承担的长期成本。

**权衡二：靠一个内部字段 `.effect` 去认 computed。** 选择是不等框架给公开 API、直接伸手去摸 computed 对象身上的 `effect` 字段；换来的是在「框架确实没有公开方法判定一个值是不是 computed」的前提下，仍能把派生值和普通状态 ref 区分开（普通 ref 没有这个字段）；代价是这等于把自己的判别逻辑钉死在了框架的内部实现上。`effect` 字段一旦改名、改结构，或者换了个同样带 `effect` 但不是 computed 的对象混进来，判定就会失准。这是个已知脆弱点——源码注释里直接挂了请求框架补公开判定方法的链接，等于明说「我们现在在用未公开的口子，等框架给正道」。

**权衡三：派生值不直接复用 store 内部那个 computed，而是重包一层代理。** 你可能会问：既然原始对象里那个 `double` 本来就是个 computed，提取时为啥不直接拿来用？这里选择的是对每个 computed「读写都代理回 `store[key]`」重新构造一个，换来的是所有提取出来的项——无论状态还是派生值——都走同一种「代理回 store」的生命周期模型（状态那边是 `toRef(store, key)`，派生值这边是代理 `store[key]`，两边对称），并且不跟 store 内部那个 effect 的惰性求值状态绑在一起；代价是多了一层间接，而且运行时对**每个**派生值都给了可写的 `set` 入口（哪怕源 getter 其实是只读的）——这跟类型层对派生值标注的「只读」并不一致：类型说只读，运行时却照单全收你的 `set` 调用，最后改没改成由底层那个 computed 自己决定。

**权衡四：装配端为提取器提前补一次「写回原始对象」。** 这个权衡最隐蔽，也最能看出两个模块的暗中配合。按理说 `toRaw(store)` 拿到原始对象、遍历它，就该能拿到干净的 ref 和 computed——可实际上，把返回值挂到响应式代理上时，代理会顺手把底层存储形态改写掉，导致后来从原始对象上摸到的值已经不是最初那个响应式源了。于是装配端在「把返回值挂到代理」之后，又特意把同一份返回值原样再挂到原始对象上一次。选择是多做这次全量赋值，换来的是提取器遍历原始对象时拿到的确实是未经代理改写的原始状态 ref 与 computed；代价是装配路径上平白多一次赋值，而且这次赋值之所以必要，完全依赖「响应式代理在写入时会改写底层存储」这个隐式行为——它是一次针对历史 bug 的专门补丁，注释里挂着对应的 issue 编号。换句话说，提取器能这么干净地工作，是因为装配那一头提前替它把路铺平了。

## 小结

`storeToRefs` 解决的是一个很具体、也很常见的矛盾：你拿到一个被故意做成「数据 + 派生值 + 方法」三合一的响应式代理 store，想只把数据解构出来用、还要保持响应。它的做法是绕过代理拿原始对象，按每个值运行时的样子三分流——带内部标记的是派生值、是 ref/reactive 的是状态、其余（方法）直接漏掉。这套判别和装配时的分类是一对镜像，且因为没法用框架公开 API 认 computed、也没法直接用 toRefs，它不得不在「重包代理」「摸内部字段」「装配端额外写回」这几处各付一份代价，才换来「数据可解构、方法不误伤、响应不丢」这个干净的结果。

顺带一提，这套提取纯靠运行时的值类型来分类，不读任何登记表——这意味着凡是能长得像数据的属性都会被当成数据挑走。这个特点会在下一章「插件系统：context 注入的 store 增强」里产生一个有趣的后果：插件往 store 里塞的 ref 也会被 `storeToRefs` 一并提取出来。
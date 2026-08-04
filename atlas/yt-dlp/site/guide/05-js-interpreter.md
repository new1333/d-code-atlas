# 进程内手写 JS 解释器：本地执行对抗性脚本

## 场景：拿到的「下载地址」其实是一段加密脚本

想象你写了个下载器，去抓某个视频站的播放地址。结果抓回来的根本不是一个能直接 `GET` 的 URL，而是一段混淆过的 JavaScript。这段脚本是站点故意下发的对抗性代码——它存在的目的，就是当场算签名、解密 key、把 `n` 参数搅乱。你必须**先把这段 JS 跑出结果**，才能拼出真正能下载的地址。

麻烦来了：用户机器上可能既没装浏览器，也没装 Node。那这段 JS，到底谁来跑？

答案是：**下载器自己在进程里手搓一个「刚好够用」的 JS 求值器，把对手下发的脚本当数据本地跑掉。** 不拉 V8，不依赖任何外部引擎。换来的好处很实在——零外部依赖、跨平台可移植，而且跑出来的结果完全可控、可预测（不会被某个引擎的版本差异带偏，签名永远算得对）。

> 承前一句话：上一章讲了 `info_dict` 这条数据总线——提取器抓回来的各种字段都汇进它。但总线里有些字段（签名、解密后的真 URL）不是抓出来的，而是**必须先执行站点那段 JS 才能算出来**；这个求值器的输出，就是总线某些字段的供给方。总线本身这里不展开了，本章只盯住「求值器」这一个东西。

## 最底层的一块：JS 的算术规则，不是你以为的那样

很多人第一反应是：「跑 JS 不就是把它的 `+` `-` `/` 直接换成我这门语言的运算符吗？」——这一步就踩坑了。

JS 有一堆和绝大多数宿主语言**不一样**的数值边界：位运算强制走 32 位有符号整数（超出 32 位就回绕）；除以 0 不报错而是得到 `Infinity`；`0/0` 得 `NaN`；`0 ** 0` 居然等于 `1`；还有一套自己的「假值」集合。更麻烦的是，JS 的 `undefined` 和 `null` 是两个东西，不能混。

所以求值器的最底层，是一组**逐个运算符手写的语义包装**：

- **32 位回绕**：`2147483648` 做位运算前先截到低 32 位、再把最高位当符号位，变成 `-2147483648`。
- **除零与幂**：除数为 0 直接返回 `Infinity`；只要操作数里出现 `undefined` 就返回 `NaN`；幂运算明确规定 `0 ** 0 === 1`。
- **假值集合**：`false` / `null` / `0` / `''` / `undefined` / `NaN` 这六个判为假，其余全真——`if`、`while`、三元运算全靠它驱动。

说人话就是：你在自家厨房里按对手的菜谱一比一复刻，连「火候」（数值边界）都得照着对方的来，差一点算出来的签名就对不上，对面就拒绝你。每个运算符都得套一层这样的包装，不能偷懒用宿主原生的。

## 控制流的红绿灯，全都做成「紧急信号」

接下来是 `break` / `continue` / `throw`。这三个东西的共同点是：它们都要**从当前嵌套深度里跳出去**——`break` 跳出最近的循环，`throw` 一路跳到最近的 `catch`。

这里有个非常省事的设计：**把这三个控制流动作直接建模成宿主语言的异常**。`break` 就抛一个 `JS_Break` 异常，`throw` 就抛 `JS_Throw`。于是：

- 循环体只要写 `try { 执行循环体 } catch (JS_Break) { 跳出 }`；
- JS 的 `try/catch`，几乎就是白送的——直接复用宿主的 `try/except`；
- 非局部跳转几乎零成本实现，不用自己维护一套跳转表。

打个比方：把红绿灯（`break`）和急刹车（`throw`）都设计成同一种「紧急信号」，循环和 `try` 只要会接信号就行，不用各自发明一套机制。代价后面权衡里讲——正常退出和报错走的是同一条通道，调试时栈轨迹会有点误导。

## 解析的心脏：一个手写的文本切片器

JS 源码进来时是一坨纯文本。求值的第一步，是把它**按分隔符切成片**：按 `;` 切语句、按 `,` 切参数、按运算符切表达式。

但「切」远没有听起来简单。因为分隔符可能在括号里、在字符串里、在正则里，那些都不能切。于是有了一个状态机式的切片器，边扫描边同时盯住四件事：

- **括号配对计数**：`(`/`{`/`[` 进栈，遇到对应的闭括号出栈，计数没归零时遇到的分隔符一律不切；
- **当前引号**：在字符串内部时，分隔符不算数；
- **转义**：刚遇到反斜杠时，下一个字符原样保留；
- **正则字符组**：在 `/.../ ` 里、又在 `[...]` 里时，规则又不同。

其中最棘手的是**斜杠 `/` 的二义性**：它既是除号，又是正则字面量的开头。切片器的判据是「前一个字符是不是运算符」——运算符之后的 `/` 当成正则开头，否则当除号。这一层状态机是整个解析器最脆弱的部分，站点一旦用了罕见的正则写法就可能切错。

## 一条语句怎么求值：前缀分发 + 一个「应返回」标记

切好之后，每条语句交给一个**按开头特征做前缀匹配**的巨型分发函数。它看语句第一个字符或第一个关键字决定走哪条路：

```
以引号开头  → 字符串/正则字面量
以 new 开头 → 构造对象
以 { 开头   → 对象字面量 或 语句块
以 ( 开头   → 括号表达式
try/if/for/switch → 对应控制流
= 赋值 / ++ -- → 赋值与自增自减
裸变量/数字   → 直接取值
name.method() → 成员与方法调用
name(args)    → 函数调用
```

这个分发函数有个贯穿始终的返回签名：`(值, 应返回)`。第二个布尔位是关键——一旦求值碰到 `return`，就把「应返回」置真，让这个信号**逐层往上传播**，直到函数边界把它变成真正的返回值。`break`/`continue`/`throw` 则不走这条路，它们直接抛异常（见上一节）。

还有一个细节值得点一句：表达式语境里不允许出现 `return`。所以求值表达式时会套一层——如果内部居然传出了「应返回」，就报错「不能从表达式里 return」。

## 函数：惰性捞取、编译成闭包、缓存复用

函数是最有意思的一层。注意一个前提：这段 JS 是**当数据**喂进来的，构造解释器时只存下整段文本，**并不立即解析**。

直到外部点名要调用某个函数（比如 `sign`），才发生这些事：

1. 用正则在那坨源码文本里**捞出** `sign` 的形参表和函数体文本（支持 `function sign`、`sign: function`、`var sign = function` 几种写法）；
2. 把函数体**编译成一个宿主语言闭包**——闭包里绑好了形参名，套上了一层作用域栈；
3. 把这个闭包**缓存**起来，下次再调 `sign` 就不用重新捞了。

编译出的闭包大致长这样：调用时把实参按形参名塞进作用域栈顶，进入逐语句解释循环；如果循环带回了「应返回」标记，就把那个值作为返回值交还调用方。

这里还藏着一个**保命机制：显式的递归深度计数器**。因为这种「边走边求值」（tree-walking）的解释器，每一层 JS 函数调用都会吃掉一层宿主语言的调用栈。JS 又允许递归，万一站点脚本写了个死循环递归，宿主栈就炸了。所以每次进入求值都让计数器减一（默认从 100 起），减到负数就主动抛「Recursion limit reached」。等于给你的递归套了根安全绳——往下钻到第 100 层就主动喊停，免得把自家的地基压塌。

## 走一遍完整轨迹：`f(41)` 怎么变成 `42`

把上面几块串起来，看一次最简单的调用 `f(41)`，源码是 `function f(a){return a+1}`：

```
源码文本 "function f(a){return a+1}"
  → ① 正则提出: 形参 [a], 函数体 "return a+1"
  → ② 编译成闭包(绑定形参 a, 套作用域栈)
  → ③ 调用 f(41): 作用域栈顶写入 {a: 41}
  → ④ 语句 "return a+1" 命中 return 前缀
         表达式 "a+1" 按二元运算切: 左 = a, 右 = 1
         查作用域 a = 41 → 求 41 + 1 = 42
  → ⑤ "应返回" 标记逐层上传 → 闭包把 42 作为返回值交还调用方
```

整条链路里，**正则捞函数体**、**前缀分发命中 return**、**二元运算切片求值**、**应返回标记上传**，四件事各司其职。如果在表达式里又撞见一次函数调用，就从第 ② 步递归重来——这就是它能跑任意嵌套调用的原因。

## 最小演示：用 TS 手搓一个「刚好够用」的求值器

下面这段几十行的 TypeScript，把主线四件事演透：**文本切片 + 前缀分发递归求值、用异常做控制流、深度计数器防溢出、逐运算符语义包装**。它故意砍掉了完整运算符表、对象字面量、正则字面量内部状态机、原型方法分派等工程外壳，只留骨架。

```typescript
// mini-js.ts —— 一个「刚好够用」的最小 JS 求值器骨架
// 演透四件事：① 文本切片 + 前缀分发递归求值  ② 用异常做控制流
//            ③ 显式深度计数器防栈溢出        ④ 逐运算符语义包装

// ===== 第 0 层：JS 的 undefined 必须和 null 分开 =====
const UNDEF = Symbol('undefined')

// ===== 第 1 层：逐运算符复刻 JS 语义（在真实非 JS 宿主里这些是硬刚需）=====
function jsDiv(a: any, b: any): any {
  if (a === UNDEF || b === UNDEF || !(a || b)) return NaN
  return b ? (a || 0) / b : Infinity          // 除零 → Infinity
}
function jsExp(a: any, b: any): any {
  if (!b) return 1                             // 0 ** 0 === 1
  if (a === UNDEF || b === UNDEF) return NaN
  return (a || 0) ** b
}
function truthy(v: any): boolean {             // JS 的 falsy 集合一比一复刻
  if (v === false || v === null || v === 0 || v === '' || v === UNDEF) return false
  if (typeof v === 'number' && Number.isNaN(v)) return false
  return true
}

// ===== 第 2 层：控制流 = 异常 =====
class JSBreak extends Error {}
class JSContinue extends Error {}
class JSThrow extends Error { constructor(public value: any) { super('js throw') } }

// ===== 第 3 层：作用域链（写入时向上找同名变量就地改写）=====
class Scope {
  vars: Record<string, any> = {}
  constructor(public parent: Scope | null = null) {}
  get(name: string): any {
    return name in this.vars ? this.vars[name] : this.parent ? this.parent.get(name) : UNDEF
  }
  set(name: string, value: any) {
    let s: Scope | null = this
    while (s) { if (name in s.vars) { s.vars[name] = value; return }; s = s.parent }
    this.vars[name] = value                    // 找不到才落在当前层
  }
}

// ===== 第 4 层：手写切片器（按括号配对，在顶层切）=====
function splitTop(s: string, delim: string): string[] {
  const out: string[] = []; let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && s.startsWith(delim, i)) {
      out.push(s.slice(start, i)); start = i + delim.length; i += delim.length - 1
    }
  }
  out.push(s.slice(start)); return out
}
function popBalanced(s: string, open: string): [string, string] {
  const close: Record<string, string> = { '(': ')', '{': '}', '[': ']' }
  const i0 = s.indexOf(open); let depth = 0
  for (let i = i0; i < s.length; i++) {
    if (s[i] === open) depth++
    else if (s[i] === close[open]) { if (--depth === 0) return [s.slice(i0 + 1, i), s.slice(i + 1)] }
  }
  throw new Error(`未配对的 ${open}`)
}

// ===== 第 5 层：前缀分发递归求值，返回 [值, 应返回] =====
type R = [any, boolean]
function run(expr: string, scope: Scope, depth: number): R {
  if (depth < 0) throw new Error('Recursion limit reached')   // ← 深度计数器
  expr = expr.trim()
  if (!expr) return [undefined, false]

  // 语句先按分号在顶层切开；前面分句先执行，最后一句做前缀分发
  const subs = splitTop(expr, ';')
  if (subs.length > 1) {
    for (let i = 0; i < subs.length - 1; i++) { const r = run(subs[i], scope, depth - 1); if (r[1]) return r }
    expr = subs[subs.length - 1].trim()
  }

  let m: RegExpMatchArray | null
  m = expr.match(/^return\b\s*(.*)$/s);  if (m) return [run(m[1] || 'undefined', scope, depth - 1)[0], true]
  m = expr.match(/^throw\s+(.*)$/s);       if (m) throw new JSThrow(run(m[1], scope, depth - 1)[0])
  if (expr === 'break') throw new JSBreak()
  if (expr === 'continue') throw new JSContinue()

  m = expr.match(/^(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(.*)$/s)   // 声明落在当前层
  if (m) { const v = run(m[2], scope, depth - 1)[0]; scope.vars[m[1]] = v; return [v, false] }

  if (expr.startsWith('while')) {                       // 循环体用 try/catch 接住 break/continue
    const rest = expr.slice(5).trim()
    const [cond, a1] = popBalanced(rest, '(')
    const [body, a2] = popBalanced(a1.trim(), '{')
    let last: R = [undefined, false]
    while (truthy(run(cond, scope, depth - 1)[0])) {
      try { const r = run(body, scope, depth - 1); last = r; if (r[1]) return r }
      catch (e) { if (e instanceof JSBreak) break; if (e instanceof JSContinue) continue; throw e }
    }
    return a2.trim() ? run(a2, scope, depth - 1) : last
  }

  if (expr.startsWith('if')) {
    const rest = expr.slice(2).trim()
    const [cond, a1] = popBalanced(rest, '(')
    const [thenB, a2] = popBalanced(a1.trim(), '{')
    const t = a2.trim()
    const elseB = t.startsWith('else') ? popBalanced(t.slice(4).trim(), '{')[0] : ''
    return truthy(run(cond, scope, depth - 1)[0])
      ? run(thenB, scope, depth - 1)
      : elseB ? run(elseB, scope, depth - 1) : [undefined, false]
  }

  m = expr.match(/^([a-zA-Z_$][\w$]*)\s*=(?!=)\s*(.*)$/s)                  // 赋值（=(?!=) 避开 ==）
  if (m) { const v = run(m[2], scope, depth - 1)[0]; scope.set(m[1], v); return [v, false] }

  const OPS: { s: string; f: (a: any, b: any) => any }[] = [               // 按优先级从低到高试切
    { s: '<', f: (a, b) => (a || 0) < (b || 0) }, { s: '>', f: (a, b) => (a || 0) > (b || 0) },
    { s: '+', f: (a, b) => (a === UNDEF || b === UNDEF) ? NaN : (typeof a === 'string' || typeof b === 'string' ? `${a}${b}` : (a || 0) + (b || 0)) },
    { s: '-', f: (a, b) => (a || 0) - (b || 0) },
    { s: '**', f: jsExp }, { s: '*', f: (a, b) => (a || 0) * (b || 0) }, { s: '/', f: jsDiv },
  ]
  for (const { s, f } of OPS) {
    const p = splitTop(expr, s)
    if (p.length > 1 && p[0].trim() !== '') {            // 空左操作数 = 一元符，跳过
      const right = p.pop()!, left = p.join(s)
      const lv = run(left, scope, depth - 1)[0], rv = run(right, scope, depth - 1)[0]
      return [f(lv, rv), false]
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(expr)) return [Number(expr), false]
  if (/^[a-zA-Z_$][\w$]*$/.test(expr)) return [scope.get(expr), false]
  throw new Error(`不支持的 JS: ${expr}`)
}

// ===== 第 6 层：函数惰性捞取 + 编译成闭包 + 缓存 =====
class MiniJS {
  cache: Record<string, (...a: any[]) => any> = {}
  constructor(public code: string) {}
  call(name: string, args: any[]): any {
    if (!(name in this.cache)) {
      const hm = this.code.match(new RegExp(`function\\s+${name}\\s*(?=\\()`))
      if (!hm) throw new Error(`找不到函数 ${name}`)
      const rest = this.code.slice(hm.index! + hm[0].length)
      const [argsStr, a1] = popBalanced(rest, '(')       // ① 正则捞出形参与函数体
      const [body] = popBalanced(a1.trim(), '{')
      const names = argsStr.split(',').map(s => s.trim()).filter(Boolean)
      this.cache[name] = (...ca: any[]) => {             // ② 编译成闭包并缓存
        const sc = new Scope()
        names.forEach((n, i) => (sc.vars[n] = i < ca.length ? ca[i] : UNDEF))
        const [ret, aborted] = run(body, sc, 99)         // ③ 深度从 99 起算
        return aborted ? ret : undefined
      }
    }
    return this.cache[name](...args)
  }
}

// ===== 试运行 =====
const js = new MiniJS(`
  function sign(x) {
    var doubled = x * 2;
    return doubled + 1;
  }
  function loopSum(n) {
    var sum = 0; var i = 0;
    while (i < n) {
      sum = sum + i; i = i + 1;
      if (i > 3) { break; }      // ← break 被实现成异常，由 while 接住
    }
    return sum;
  }
`)
console.log('sign(21)     =', js.call('sign', [21]))      // 21*2+1 = 43
console.log('loopSum(100) =', js.call('loopSum', [100]))  // 累加到 i>3 触发 break → 6
console.log('1 / 0        =', jsDiv(1, 0))                // Infinity
console.log('0 ** 0       =', jsExp(0, 0))                // 1
```

配一个最小 `package.json` 就能跑：

```json
{
  "name": "mini-js-eval",
  "private": true,
  "type": "module",
  "scripts": { "start": "bun run mini-js.ts" }
}
```

直接 `bun run mini-js.ts`（或 `npx tsx mini-js.ts`）即可看到 `sign(21)=43`、`loopSum(100)=6`。`loopSum` 那个 `6` 最值得品：它正是「`break` 被实现成异常、由 `while` 的 `catch` 接住」的活证据——累加到 `i>3` 时 `break` 抛出，循环戛然而止，返回此时的 `sum`。

> 一个诚实的注脚：演示用 TS 当宿主，而 TS 本身就遵循 JS 语义（`1/0` 本就是 `Infinity`），所以 `jsDiv` 这些包装在这里看似「多此一举」。但它们的意义在「**锁定行为**」——把 JS 的边界规则写死在包装里，求值器的输出就不再依赖宿主碰巧怎么实现。在真实的（非 JS）宿主里，这些包装是硬刚需：比如 Python 的 `1/0` 会直接抛 `ZeroDivisionError`，没有它们签名就算不对。

## 关键权衡

本章机制密集，下面展开四条核心权衡。它们共同回答一个问题：**为什么不拉一个真 JS 引擎，而非要手搓？**

**权衡一：选择「正则文本切片 + 边解析边求值的递归下降」，而不是经典的「词法 → 语法树 → 字节码」流水线。**
换来的是——整套解释器能塞进**单个文件**，刚好覆盖站点实际用到的那个 JS 子集，不需要一整套编译器骨架（词法分析器、AST 节点类、字节码生成、虚拟机）。对于一个「只为算签名」的工具来说，这是极具诱惑的简洁。代价是——**解析与求值死死耦合在一个巨大的分发函数里**。每遇到一种新语法（新的字面量、新的语句形式），就得在那个巨函数里**再加一个前缀分支**；这个函数因此长到几百行，分支越叠越多，越来越难一眼读懂全貌。

**权衡二：选择「把 `break` / `continue` / `throw` 建模为宿主语言的异常」。**
换来的是——非局部跳转**几乎零成本**实现。循环体写一句 `catch (JS_Break)` 就能接住 `break`；JS 的 `try/catch` 天然就是宿主的异常捕获，等于白送。代价是——「**正常控制流**」（`break`、循环跳出）和「**错误传播**」（真正的异常、`throw`）**共用同一条异常通道**。调试时，一个普通的 `break` 会在栈轨迹里留下「异常」痕迹，很容易把人带偏——源码注释里那句「这让未来调试非常痛苦」正是为此而发。

**权衡三：选择「为每个运算符单独写语义包装、强制复刻 JS 的数值与类型规则」，而不是直接复用宿主运算符。**
换来的是——对 JS 边界行为的**精确模拟**：32 位整数回绕、除零得 `Infinity`、零除零得 `NaN`、`0 ** 0 === 1`、特定的假值集合。这意味着无论这个求值器被移植到哪种宿主语言，算出来的签名都和浏览器里一致——**行为可锁定**。代价是——**每个运算符都要手写一层包装**；JS 子集越宽（站点用到的运算符越多），维护成本就线性上涨，任何一个边界复刻错了都是静默的签名错误。

**权衡四：选择「JS 函数惰性提取、首次调用时编译成宿主闭包并缓存」。**
换来的是——调用过的函数**只编译一次**；而且 JS 函数天然成了**一等公民**，可以在作用域里像普通值一样传来传去、互相调用。代价是——函数定义的捞取**完全靠正则在源码文本里匹配**，只有 `function x` / `x: function` / `var x = function` 这几种「典型形态」能被认出。站点一旦换了非典型的定义写法，正则就捞不到，必须**持续打补丁**补上新形态——这把「与对手的猫鼠游戏」固化进了正则表里。

## 小结

这一章讲的东西，本质上是「**在没有 JS 引擎的环境里，凭空造一个能跑对手脚本的迷你引擎**」。它从最底层的运算符语义包装搭起，往上叠出「控制流即异常」「手写切片器」「前缀分发递归求值」，再到「函数惰性编译成闭包 + 深度计数器防溢出」。每一层都在回答同一个问题：**怎么用最少的代码，把那段不可信、会变的 JS 忠实地跑出和浏览器一样的结果**，同时把对外部引擎的依赖降到零。

求值器算出的签名、解出的真 URL，最终都会写回 `info_dict` 的字段里——而这些字段怎么决定「**用哪个下载器、怎么下**」，就是下一章「**协议字段驱动的下载策略分派**」的主题。
# 闭包与 Fn/FnMut/FnOnce：捕获方式即类型 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  你想写一个高阶函数（迭代器的回调、排序比较器、事件处理器），它要接收一个「带着外部状态」的回调。在 JS 里闭包就是闭包，一类搞定：随便传、随便反复调、随时改外面的变量。但到了 Rust，同样是回调，能量等级却天差地别——有的回调只是读一眼外部变量、有的要改外部变量、有的干脆要把一个外部变量「吃掉」（move 走）。如果语言不区分，灾难就会发生：一个把变量吃掉的闭包被你塞进集合里反复调用，第二次调用时那个变量早就不在了——这就是内存不安全。Rust 必须有一种机制，让「这个回调到底能对环境做什么」在类型层面看得见，编译器才拦得住滥用。

- **一句话核心思想**：
  闭包按它如何对待捕获到的变量（只读 / 可改 / 消耗）被编译器自动归入三类 trait 中的某一类——**捕获方式即类型，类型决定可调用性**。

- **设计动机（为什么需要它，含承前）**：
  它是为了让「所有权 + 借用」模型自然延伸到函数式抽象而生的，换来了「回调的能力在签名里精确可表达、且零成本」的能力。
  - 承前 ①（已在第 4 章『借用与引用：编译期的别名分析』讲透）——不可变借用 `&T`、唯一可变借用 `&mut T`、移动 `move` 这三种操作**本章不重讲**；本章只看它们的新侧面：编译器把这三种操作**自动套到闭包捕获**上，并据此把闭包分类成三类可调用 trait。
  - 承前 ②（已在第 7 章『Trait 与泛型：编译期单态化的静态多态』讲透）——trait 作为能力契约 + 单态化**本章不重讲**；本章只看它的新侧面：把闭包当作 trait bound，让高阶函数能精确约束「这个回调只能读 / 可以改 / 只能调一次」，并用单态化保证这种函数式抽象零运行时开销。

- **关键权衡（本 Atlas 的核心，3 条）**：
  1. **把捕获方式编码进三类 trait** → 换来了高阶函数能在签名层精确表达「回调能做什么」，编译器在编译期就能拒绝误用（比如拿消耗型闭包反复调） → 代价是三类 trait 的概念负担：初学者要先建立「为什么不是一类」的直觉，且常误以为「FnMut 会消耗变量」（其实它只是可变借用）。
  2. **闭包脱糖为匿名 struct（而非 JS 那种环境链/隐式堆分配）** → 换来了捕获数据可以放在栈上、每个闭包是独立的具名-但不可名状类型、单态化后被内联、零运行时开销 → 代价是**闭包类型写不出来**（你写不出它的类型名），存进字段或返回时必须用 `impl Fn`（静态、单态化）或 `Box<dyn Fn>`（动态派发）间接表达；返回闭包常常要加 `move` 让它「自洽」、不依赖外层栈帧。
  3. **最小捕获原则（编译器只捕获真正用到的变量，2021 起精确到字段级）** → 换来了捕获粒度更细、更少与借用检查器打架（只读一个字段就不会把整个 struct 的可变借用锁死） → 代价是行为对 edition 敏感：同一段代码从 2018 切到 2021，闭包捕获的范围可能变（历史上是一个 footgun，后被修复）。

- **最小心智模型（7 步）**：
  1. 写一个闭包表达式，编译器识别出它从外层环境里捕获了哪些变量。
  2. 编译器为这个闭包生成一个**唯一且匿名**的 struct，其字段 = 捕获到的变量，按各自需要的借用/移动方式来存。
  3. 编译器分析闭包体如何使用这些捕获变量：只读不写 → 倾向实现 `Fn`；会写入 → 实现 `FnMut`；会 move 出去或整体消耗掉 → 只实现 `FnOnce`。
  4. 三 trait 构成层级 `Fn : FnMut : FnOnce`：能力越「强」（越只读、越可重复调用）越能满足越多的 bound（凡是 `Fn` 也能当 `FnMut` / `FnOnce` 用）。
  5. 闭包被传给带 `Fn`/`FnMut`/`FnOnce` bound 的泛型高阶函数时，编译器对该匿名 struct 做单态化，生成一份具体代码。
  6. 直接调用 `f(...)` 时，编译器把它翻译成对应 trait 的 `call` / `call_mut` / `call_once` 方法（接收者分别是 `&self` / `&mut self` / `self`）。
  7. 想把闭包跨作用域存储或返回时，由于类型不可名状，用 `impl Fn`（静态、零成本）或 `Box<dyn Fn>`（动态派发，承前下一章）来表达。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：三个针对同一环境的闭包，分别只读、改写、消耗捕获变量；编译器自动把它们归到 `Fn` / `FnMut` / `FnOnce`；然后尝试把三者传给签名各为 `Fn` / `FnMut` / `FnOnce` bound 的函数，观察编译器在哪些组合上放行、哪些上拒绝——演透「捕获方式即类型」这一核心。
  - **应故意省略**：闭包作为 struct 字段的工程用法、`Box<dyn Fn>` 的动态派发与 vtable（留给下一章）、返回闭包的生命周期标注、async 闭包、精确捕获的 edition 边界 case、`impl Fn` vs `Box<dyn Fn>` 的汇编级对比。**不追求工程完整，只追求演透原理**。
  - **演示载体建议**：本章核心是 Rust 特有语义——JS/TS 的闭包统一是一类、没有「move/借用」之分，**TS/JS 演不透「捕获方式决定类型」这一点**，故依「仅当核心功能 TS/JS 讲不透（语言特有语义）才退回主题语言」之例外，**首选 Rust 作为演示载体**。建议补一个极简 TS 类比版（约 10 行），只用来给 JS 背景读者做对照直觉：「JS 里同一个闭包既能读又能改又能消耗外部变量，三类合一」，从而反衬 Rust 为什么必须分三类。

- **正文不宜展开的细节**：
  `extern "rust-call"` ABI（nightly 内部细节，稳定版不直接调 `call`）；函数项（function item）类型零大小、`fn` 指针与闭包的差别及 FFI 场景；`impl Fn` vs `Box<dyn Fn>` 的汇编/分配对比（留给第 9 章动态派发）；精确捕获（RFC 2229）下的 drop 顺序与 Copy struct 边界 case；高阶 trait bound（`for<'a>`）与闭包生命周期绑定器（RFC 3216）；async 闭包、闭包作为 trait 方法的返回值。

- **推荐的一个执行轨迹例子**：
  输入：环境里有 `let mut v = vec![1,2,3];` 和 `let n = 10;`，写三个闭包——A=`|| println!("{n}")`（只读 n）、B=`|| v.push(0)`（改 v）、C=`|| takes_vec(v)`（消耗 v）。
  → 关键中间态：编译器给 A 实现 `Fn`（顺带 `FnMut`/`FnOnce`），给 B 实现 `FnMut`（顺带 `FnOnce`），给 C 只实现 `FnOnce`。
  → 输出：把它们传给 `fn run<F: Fn()>(f: F)` 时，**只有 A 通过**；传给 `fn run_mut<F: FnMut()>(mut f: F)` 时，**A、B 通过**；C 只能传给 `FnOnce` bound 的函数或直接调用一次。编译器在每个 bound 上精确放行/拒绝——这就是「捕获方式即类型」的落地行为。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **闭包的本质是匿名类型**：每个闭包表达式都会产生一个「唯一、不可名状的匿名类型」（unique anonymous type），你无法在源码里写出它的类型名。编译器把它实现为一个隐藏的 struct，字段就是它捕获的环境变量。
  依据: Rust Reference「Closure expressions」；Stack Overflow「How are closures implemented in Rust?」对 Rust 规范的引用。

- **三类 trait 及其接收者签名（核心事实）**：
  - `FnOnce<Args>`：方法 `call_once(self, args) -> Output`，接收者 `self`（按值，消耗自己）→ 只能调用一次。所有闭包都至少实现它。
  - `FnMut<Args>: FnOnce<Args>`：方法 `call_mut(&mut self, args) -> Output`，接收者 `&mut self` → 可重复调用、可修改捕获变量。
  - `Fn<Args>: FnMut<Args>`：方法 `call(&self, args) -> Output`，接收者 `&self` → 可重复调用、不可修改、可并发调用。
  依据: `std::ops` 官方文档（`FnOnce` / `FnMut` / `Fn` trait 定义）；The Rust Programming Language 第 13 章 / 第 20 章。

- **捕获方式决定实现哪个 trait（编译器自动推断「最弱」可满足的 trait）**：
  - 闭包默认以**满足其需求的最小方式**捕获：只读 → 不可变借用（对应 `Fn`）；需要修改 → 可变借用（对应 `FnMut`）；需要把变量 move 出来或整体消耗 → 按值拿走（对应 `FnOnce`）。
  - 闭包实现「它能满足的最严格的那一类」（即能力最弱但够用的那类），但由于层级关系，它同时也能被当作更弱的 trait 使用。
  依据: The Rust Programming Language「Closures」章节；Ferrous Systems Rust Training「Closures and the Fn/FnOnce/FnMut traits」；Rustify「What is a Closure in Rust」。

- **`move` 关键字强制按值捕获**：在闭包前加 `move`，会让闭包**取得**所有被引用变量的所有权（而非按需借用），与默认的「最小借用」推断无关。这在把闭包返回到其定义作用域之外（如返回 `Box<dyn Fn>`、传给线程）时尤其关键——它让闭包「自洽」、不再依赖外层栈帧，从而满足 `'static`。
  依据: The Rust Programming Language「Closures: Capturing the Environment with Closures」；The Rust Book 第一版「Closures」（MIT 镜像）关于「无 move 则绑定到栈帧，有 move 则自洽、可赋 `'static`」。

- **层级关系 `Fn : FnMut : FnOnce`**：凡实现 `Fn` 的也实现 `FnMut` 和 `FnOnce`；实现 `FnMut` 的也实现 `FnOnce`。这意味着「越只读、越能重复调用」的闭包越通用——可以把一个 `Fn` 闭包传给任何接收 `Fn`/`FnMut`/`FnOnce` 的地方，反之不行。
  依据: `std::ops` 中 `Fn: FnMut` 与 `FnMut: FnOnce` 的 supertrait 声明；Stack Overflow「When does a closure implement Fn, FnMut and FnOnce?」。

- **最小捕获与精确捕获（disjoint capture）**：闭包只捕获它真正用到的变量；自 Rust 2021 edition 起（RFC 2229），捕获进一步精确到**字段级**——闭包只用到 struct 的某个字段时，只捕获该字段而非整个 struct，从而减少与借用检查器的冲突。
  依据: The Rust Edition Guide「Disjoint capture in closures」（Rust 2021）；RFC 2229「Capture Disjoint Fields」。

- **`fn` 指针 vs 闭包**：函数会强制转换为 `fn` 类型（小写，函数指针），它**不捕获环境**、类型可名状、大小为零或一个地址；闭包可捕获环境但类型不可名状。函数指针常用于与 C 互操作（FFI）等场景。
  依据: The Rust Programming Language 第 20 章「Advanced Functions and Functions」（fn pointers vs closures）。

## 关键流程

闭包从「写出表达式」到「被调用」的编译期处理链：

```
闭包表达式 |...|
   │
   ├─[1] 识别捕获  ──→  从外层环境中找出被引用的变量
   │
   ├─[2] 脱糖      ──→  生成唯一匿名 struct，字段 = 捕获变量
   │                   （按需以 &/&mut/own 方式存储）
   │
   ├─[3] 推断 trait ──→ 分析闭包体：只读→Fn / 可变→FnMut / 消耗→FnOnce
   │                   （满足层级：Fn ⊂ FnMut ⊂ FnOnce）
   │
   ├─[4] 作 bound 用 ──→ 传入泛型高阶函数（如 F: Fn(...)）→ 单态化生成具体代码
   │
   └─[5] 调用 f(...) ──→ 编译器翻译为 call(&self) / call_mut(&mut self) / call_once(self)
```

返回/存储闭包的两种表达方式（因类型不可名状）：

```
fn make() -> impl Fn(i32) -> i32   // 静态：单态化、栈上、零成本，但调用点类型固定
fn make() -> Box<dyn Fn(i32)->i32> // 动态：堆分配、vtable 派发（承前下一章）
```
依据: The Rust Programming Language 第 13 章（闭包捕获与脱糖）；EventHelix「Rust Closures Under the Hood: impl Fn vs Box<dyn Fn>」；Niko Matsakis 博客「Precise closure capture clauses」（脱糖机制）。

## 易混淆 / 边界 / 推断

- **事实（易混淆）**：`FnMut` **不会**「消耗」捕获变量——它只是以 `&mut self` 可变借用，可被多次调用。真正「消耗」的是 `FnOnce`（`self` 按值）。社区里「FnMut consumes variables」的说法是误传。
  依据: Stack Overflow「Why FnMut closures consume captured variables?」中对常见误解的澄清；`std::ops::FnMut` 文档。

- **事实（边界）**：闭包类型不可名状，因此**不能**直接作为函数返回值的具名类型，也不能直接放进 struct 字段的具名类型里；必须用 `impl Fn`（返回位置，单态化）或 `Box<dyn Fn>`（trait object）或泛型参数间接表达。这是「匿名类型」代价的直接体现。
  依据: Rust Reference「Closure expressions」（唯一匿名类型不可写出）；Stack Overflow「Returning a closure from a function」。

- **事实（边界）**：把可变借用型（`FnMut`）或消耗型（`FnOnce`）闭包放进「需要反复调用的容器」（如 `Vec<Box<dyn Fn()>>`）会被编译器拒绝——`Box<dyn Fn>` 容器只接受 `Fn`。这正是「捕获方式即类型」在工程上的落地。
  依据: The Rust Programming Language；EventHelix 文章对 `Box<dyn Fn>` 与可调用性的说明。

- **推断（标注为推断）**：Rust 选择「三类」而非「一类/两类」闭包，应是为了与所有权模型的三种基本操作（不可变借用 / 可变借用 / 移动）一一对应——这样闭包捕获「免费复用」了借用检查器既有的别名分析规则，无需为闭包另造一套安全模型。这是「最小概念复用」的设计取向，属推断，需结合 RFC / lang team 讨论进一步核实。
  依据: 推断；可参考 The Rust Programming Language 第 13 章对三类与三种捕获方式对应关系的阐述。

- **未理解 / 待查证**：`FnOnce` 在 trait object（`Box<dyn FnOnce>`）上的调用语义历史上有特殊处理（曾需要 nightly 的 `FnBox`），其当前稳定版的确切实现细节未完全查证，Writer 正文若涉及应再核对。

- **未理解 / 待查证**：闭包脱糖后字段的**具体存储布局**（是否对 Copy 字段做按位拷贝、捕获顺序对 drop 顺序的影响）与 RFC 2229 的交互，建议正文不展开，留作脚注。
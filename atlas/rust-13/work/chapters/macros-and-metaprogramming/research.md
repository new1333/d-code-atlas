# 宏系统：编译期代码生成 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  你想写一个 `vec![1, 2, 3]`，让它自动展开成「建空容器 → 逐个 push → 返回容器」这几句**数量不固定**的语句；或者你想给一个 struct 加一句 `#[derive(Debug, Clone)]`，就自动「批量生成」这些 trait 的实现。函数和泛型都做不到这两件事——函数不能「往调用点注入 N 条语句」，泛型不能「凭空新增一个 item（如一个 impl 块）」。一旦你只有「函数 + 泛型 + trait」三种抽象工具，遇到「需要生成代码结构本身」的需求就会卡死，于是只能手写大量样板。宏就是为了填这个空洞而存在的第三类工具。

- **一句话核心思想**：
  宏是在**类型检查之前的解析阶段**、对**代码的 token 流**做变换的代码生成器——它生产出 Rust 代码本身，再交给后面的类型检查器去校验。

- **设计动机（为什么需要它）**：
  它解决「类型系统表达不了的抽象」这个矛盾：换来的能力是「**一次书写、编译期展开成多份/多种代码**」，覆盖自定义语法（DSL）、自动派生（`#[derive]`）、消除重复样板三大场景。
  - **承前 / 跨章去重标注**：第 1 章『设计哲学与编译模型总览』已建立「把问题前移到编译期」这个上位心智总图——**但那里讲的是编译期「检查」（借用检查等）**。（已在第 1 章『设计哲学与编译模型总览』讲透「前移到编译期」这个大方向，本章只看它的新侧面：编译期「生成」代码，而非「检查」代码，且宏是 Rust 里**唯一**「宏本身不参与类型检查、只校验展开结果」的机制。）另：第 7 章『Trait 与泛型：编译期单态化的静态多态』讲透了「类型层的编译期多态」，本章只看「**token 层的编译期代码生成**」这个新侧面，Writer 不必重讲单态化。

- **关键权衡（核心；本章机制丰富，列 4 条）**：
  1. **选择「在 token 层操作 + 在解析期（类型检查前）展开」→ 换来能生成任意结构合法的代码、实现类型系统做不到的抽象（`vec!` 注入任意条语句、`#[derive]` 批量生成 impl、`println!` 在编译期解析格式串）→ 代价是宏**本身不参与类型检查**：错误延迟到展开后才暴露、报错往往定位不到宏调用点、调试必须借助 `cargo-expand` 看展开结果**。
  2. **选择「声明宏用模式匹配替换（matcher → transcriber）」定义宏 → 换来无需手写解析器、定义即文档、且对绝大多数常见场景足够强（`vec!`/`println!` 都是声明宏）→ 代价是只能按固定几种「片段分类符」（`expr`/`tt`/`ty`/`ident`…）匹配，写不出任意自定义语法，递归展开时调试痛苦**。
  3. **选择「过程宏用普通 Rust 函数操作 `TokenStream`（输入 token 流 → 输出 token 流）」→ 换来图灵完备的代码生成、可解析任意自定义 DSL、可一次派生多个 item（典型如 Serde 的 `#[derive(Serialize)]`）→ 代价是必须拆成**独立的 proc-macro crate**、强依赖 `syn`/`quote`、显著拖慢编译、且错误诊断需要手写 span**。
  4. **选择「hygiene（卫生性）给宏内的标识符打上『语法上下文』」→ 换来宏不会意外捕获/遮蔽调用点的同名变量（这是与 C 宏致命缺陷的根本区别）→ 代价是引入「调用点 vs 定义点」两套解析语义，当宏确实想向调用点注入一个变量名时反而需要绕路（部分 def-site hygiene 至今未稳定）**。

  > **配套惯例（供 Writer 单列一个小提醒即可）**：『能用 trait/generics 就不用宏，宏留作最后手段』——因为宏牺牲了类型检查、可读性与 IDE 支持来换取表达力，只有当类型系统真的表达不了（自定义语法、批量派生、消除大量同构样板）时才启用。

- **最小心智模型（7 步，以声明宏为主线）**：
  1. 宏调用 `foo!(...)` 进入编译器，括号里的内容被解析成一棵 **token 树**（叶子是单个 token；带 `()`/`[]`/`{}`的子序列是一棵子树）。
  2. 编译器在**解析阶段、类型检查之前**，把宏调用的 token 树交给宏系统处理。
  3. 按规则从上到下逐条尝试：用每条规则的 **matcher**（带 `$x:expr` 这类「洞」的模式）去匹配这棵 token 树。
  4. **第一条匹配成功的规则胜出**，匹配过程中把「洞」绑定的内容（元变量）记下来。
  5. 把绑定的元变量填进 **transcriber**（输出模板，含 `$(...)*` 这类重复），生成**新的 token 流**。
  6. 新 token 流替换掉原宏调用，**递归展开**（生成的代码里还能再含宏调用），直到全无宏。
  7. 此时才得到完整 AST，**进入类型检查**；同时 hygiene 给宏内标识符附加语法上下文，避免与调用点同名标识符串扰。
  （过程宏则是把第 3–5 步替换成「把整个 token 流交给一个普通函数 `fn(TokenStream) -> TokenStream`」，其余时机不变。）

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个几十行的、**表达核心思想**（token 树 + 模式匹配替换 + 先于类型检查）的从零实现。具体做法：定义 token 树（原子字符串 + 嵌套数组）；定义一条「宏规则」=（带 `$name:fragment` 占位符的 matcher 模板，带同名占位符的 transcriber 输出模板）；实现「用 matcher 匹配输入 token 树 → 绑定元变量 → 用 transcriber 渲染出输出 token 树」。最后用一个等价于 `vec![1,2,3]` 的例子跑一遍，展示「一次调用展开成多条 push」。**每一行都要对应上面的某个原理点**（token 树结构 / 顺序匹配 / 元变量绑定 / 替换生成 / 递归位置）。
  - **应故意省略**：真实的片段分类符全集与「follow set」规则、hygiene 的语法上下文实现、过程宏的独立 crate 脚手架、`syn`/`quote` 的真实用法、编译器集成、IDE 与 `cargo-expand` 工程化、属性宏/派生宏的三套注册流程。**不追求工程完整，只追求演透「token 层模式替换先于类型检查」这一个原理**。
  - **演示载体建议**：**首选 TS/JS**。因为本章核心是「对 token 序列做模式匹配替换」这一与语言无关的机制，TS 的 tagged-template 或「字符串/嵌套数组当 token 树」足以演透，且对前端读者最友好。无需退回 Rust（只有讲到「片段分类符的 follow set」这类 Rust 特有语义时才需要 Rust 片段，那属于应省略的细节）。

- **正文不宜展开的细节（供 Writer 裁剪）**：
  - 片段分类符的完整清单与每种对应的「follow set」（如 `expr` 后只允许 `=>` / `,` / `;`）——属语言细节，提一句即可。
  - 过程宏三种入口（derive / attribute / function-like）在 `Cargo.toml` 与 crate 结构上的差异——点到为止。
  - `syn` 解析、`quote!` 准引用、`proc-macro2` 的存在理由——一句话带过，不深入。
  - hygiene 的 mixed-site / def-site / call-site 三档语义及稳定性现状——作为「边界」提及即可，不展开。
  - `macro_export`、`$crate` 路径 hygiene、宏的可见性与跨 crate 导出——属工程化，正文不展开。
  - `macro_rules!` 的「TT muncher」递归技巧——属高阶用法，列进「不宜展开」。

- **推荐的一个执行轨迹例子**：
  - 输入：`vec![1, 2, 3]`
  - 关键中间态 1：解析成 token 树 `[ 1 , 2 , 3 ]`（三个原子被逗号分隔的子树）。
  - 关键中间态 2：规则 `$($x:expr),*` 匹配成功，绑定 `$x = [1, 2, 3]`。
  - 关键中间态 3：transcriber 模板「建空容器；`$(push $x)*`；返回容器」按重复符渲染成「push(1); push(2); push(3);」三条语句。
  - 输出：一段「建容器 + 三条 push + 返回」的 token 流替换掉原调用位置；类型检查随后才看到这段 push 代码。
  （这个轨迹只演「token 模式匹配 → 替换生成 → 进入类型检查」的核心，不演完整标准库实现。）

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **Rust 有两套宏引擎**：
  - **声明宏（declarative macros / macros by example）**：用 `macro_rules!` 定义，由「matcher → transcriber」的模式匹配替换构成，工作在 token 树上。`vec!`、`println!`、`format!`、`assert!` 等标准库常用宏都是声明宏。依据: The Rust Reference「Macros By Example」；The Little Book of Rust Macros「Macros: A Methodical Introduction」。
  - **过程宏（procedural macros）**：用普通 Rust 函数 `fn(TokenStream) -> TokenStream` 定义，对 token 流做任意（图灵完备）变换，必须放在 `Cargo.toml` 中标注 `proc-macro = true` 的独立 crate 里。分三种入口：**derive 宏**（`#[derive(Foo)]`，在 struct/enum 上自动生成 trait 实现）、**attribute 宏**（`#[my_attr]`，注解并可能替换整个 item）、**function-like 宏**（`foo!(...)`，接收任意 token 流）。依据: The Rust Reference「Procedural Macros」。

- **token 树（TokenTree）是宏的统一数据模型**：递归定义——要么是单个叶子 token，要么是一组被匹配的 `()`/`[]`/`{}` 包围的子树。声明宏与过程宏都工作在 token 树/token 流这一层，**而非 AST**。依据: The Rust Reference；TaintedCoders「Rust Macros」（token 树保证括号配对与分组）。

- **宏在类型检查之前展开**：宏展开发生在解析阶段（parsing），产出最终 AST 后，类型检查器才进场。因此「宏本身的变换逻辑」不参与类型检查，只有展开后的**结果代码**会被类型检查。对比：Rust 的泛型在单态化**之前**就会按 trait bound 做类型检查；宏则相反，是「展开后才检查」（更接近 C++ 模板「两阶段」之外的单阶段味道）。依据: Guide to Rustc Development「Macro Expansion」；jstrong.dev《Productive Rust: Implementing Traits with Macros》。

- **声明宏的片段分类符（fragment specifiers）**：matcher 里的「洞」用 `$name:分类符` 声明可匹配的内容类别，常见有 `expr`（表达式）、`tt`（单个 token 树，最灵活）、`ty`（类型）、`ident`（标识符）、`pat`（模式）、`stmt`（语句）、`item`（条目）、`literal`、`meta`（属性元信息）、`block`、`path`、`lifetime`、`vis`、`selfparam` 等。重复用 `$(...)*`（0 次或多次）、`$(...)+`（1 次或多次）、`$(...)?`（可选）。依据: The Rust Reference「Macros By Example」片段分类符表。

- **声明宏的匹配与展开规则**：多条规则**从上到下**尝试，**第一条匹配成功的胜出**（类似 `match`）；匹配成功后，用绑定的元变量把 transcriber 渲染成新 token 流；若展开后仍含宏调用，则**递归展开**，直到没有宏为止。依据: The Little Book of Rust Macros「Macros: A Methodical Introduction」（matcher / transcriber / 顺序匹配）。

- **hygiene（卫生性）**：宏展开产生的标识符带有「语法上下文（syntax context）」，与调用点的同名标识符处于不同命名空间，从而**不会意外捕获或遮蔽**调用点变量——这是 Rust 宏相对 C 宏的关键进步。声明宏默认是 hygienic 的（局部变量、标签卫生）。过程宏里则通过 `Span`（`call_site()` / `mixed_site` / 尚未稳定的 def-site）控制标识符解析到「调用点」还是「定义点」。依据: The Little Book of Rust Macros「Hygiene and Spans」；Sabrina Jewson《Truly Hygienic Let Statements in Rust》。

- **`$crate` 与路径 hygiene**：宏在跨 crate 使用时，内部引用自身 crate 的路径用 `$crate`，避免在调用点的命名空间里找不到对应 item。依据: The Rust Reference「Macros By Example」`$crate` 段。

- **过程宏典型工具链**：`syn` 把 token 流解析成 Rust 语法树供程序处理；`quote`（准引用）用类 Rust 语法把值反向拼成 token 流；`proc-macro2` 提供可在非编译器环境测试的 token 流类型。依据: The Rust Reference「Procedural Macros」；社区普遍实践（developerlife.com 指南、The Little Book of Rust Macros）。

## 关键流程

**声明宏展开流程（一条规则的命中路径）**：
```
foo!(1, 2, 3)
  → [解析] token 树: [ 1 , 2 , 3 ]
  → [匹配] 顺序尝试规则，rule#1 的 matcher `($($x:expr),*)` 命中，绑定 $x = [1,2,3]
  → [替换] 用 $x 渲染 transcriber，产出新 token 流
  → [替换原位] 新 token 流顶替原宏调用；若仍含宏则递归
  → [类型检查] 所有宏展开完毕、得到完整 AST 后，类型检查器进场
```
依据: Guide to Rustc Development「Macro Expansion」；The Little Book of Rust Macros「Macros: A Methodical Introduction」。

**过程宏展开流程**：
```
#[derive(Foo)] struct S {...}
  → [解析] 编译器把 S 的 token 流 + derive 属性交给 Foo 的派生函数
  → [函数体] syn 解析 → 业务逻辑 → quote 生成新 token 流（通常是 impl Foo for S {...}）
  → [拼接] 编译器把生成的 impl 追加到原 S 之后
  → [类型检查] 对展开后的全部代码做类型检查
```
依据: The Rust Reference「Procedural Macros — Derive Macros」。

**宏在编译流水线中的位置**：
```
词法分析 → 解析成带宏节点的 AST → 宏展开（声明宏匹配替换 / 过程宏函数调用）→ 反复重解析重展开 → 完整 AST → 名称解析 → 类型检查 → ...
```
依据: Guide to Rustc Development「Macro Expansion」（宏展开是解析阶段的一部分，发生在类型检查之前）。

## 易混淆 / 边界 / 推断

- **事实**：宏的**展开结果**会被类型检查，但**宏本身**（作为 token 变换）不参与类型检查——这与泛型「单态化前先按 bound 检查」相反。因此宏产生的类型错误往往定位到展开后的代码、而非宏调用点。依据: jstrong.dev《Productive Rust: Implementing Traits with Macros》。

- **事实**：声明宏的「片段分类符」有 **follow set 限制**——某些分类符（如 `expr`/`stmt`）之后，matcher 里只能紧跟特定 token（如 `=>` / `,` / `;`），否则编译器无法判断该片段该在哪结束。这是为避免语法歧义而设的硬约束。依据: The Rust Reference「Macros By Example」Follow Set 规则。

- **事实**：完整 def-site hygiene（解析始终指向宏定义处）**尚未在稳定 Rust 中全部提供**；当前稳定面有 call-site 与 mixed-site 两档。所以「宏想往调用点注入一个由宏自身定义的变量名」这类需求仍受限。依据: The Little Book of Rust Macros「Hygiene and Spans」；Rust Internals 相关讨论。

- **易混淆点**：`macro_rules!` 宏**不是**函数——它不参与类型签名、不能作为 trait 方法、不能被当作值传递；它只在解析期做 token 替换。把它当「编译期跑的函数」是错的（尤其过程宏虽然是真函数，但它在编译器进程里、面对的是 token 流而非运行时值）。

- **易混淆点**：属性宏 `#[foo]` 与 derive 宏 `#[derive(Foo)]` 不同——属性宏**替换/变换**被注解的 item，derive 宏**追加**新的 item（不修改原 item）。依据: The Rust Reference「Procedural Macros」。

- **推断（标注为推断）**：第 1 章已确立「把 JS 由运行时/GC 兜底的问题前移到编译期」的总权衡；宏是这一思路在「代码生成」维度的延伸——但它把代价从「编译期斗争」进一步放大到「类型系统失去对宏本身的可见性」，因此 Rust 社区才有「宏是最后手段」的强惯例。这一推断与官方文档及社区共识一致，但「最后手段」属于惯例而非规范强制。

- **未理解 / 待查证**：proc-macro crate 为何必须与使用方 crate 物理分离（不能在同一 crate 内定义并使用过程宏）的具体实现原因——已知是编译器架构（过程宏需要先单独编译成动态库由编译器加载）所致，但精确的「加载/隔离」边界细节本文未深入核实，Writer 可只讲现象、不展开原因。
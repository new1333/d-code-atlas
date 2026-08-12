# 代数数据类型：枚举与穷尽模式匹配 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 JS/TS 里用「联合类型 + switch」或带 `kind` 字段的对象去描述「一个值可能是几种形态之一」时，初学者会反复撞上两类坑：一是给类型加了新形态，却忘了在某个 switch 里处理，由于往往写了 `default` 兜底，运行时静默走错分支、产出离谱数据；二是用 `null`/`undefined` 表示「没有」，于是任何引用「可能」是空的，忘了判空就在运行时炸成 `TypeError`。本质都是：**「漏处理某一种情况」是一个运行时才暴露的 bug**。

- **一句话核心思想**：用一个带标签的求和类型精确刻画「一个值只可能是这几种形态之一、每种形态各自携带什么数据」，再用编译器强制你在分支时**穷尽所有形态**——把「漏掉一种情况」从运行时崩溃，变成编译期就过不去的错误。

- **设计动机（为什么需要它）**：`enum` 是真正的「和类型」（sum type / tagged union）——变体之间是「或」关系，与 `struct` 的「积类型」（「与」关系）对偶；这让程序员能在一个类型里精确建模领域里的互斥状态（登录中 / 已登录 / 已登出、成功 / 失败、有值 / 无值），而不是用一个松散的对象 + 一堆 `if` 去猜当前是哪种状态。`match` 的穷尽性检查则把「枚举是封闭集合」这件事变成编译期的硬约束：新增一个变体，所有未覆盖它的 `match` 全部编译失败，强迫你逐一更新。
  - **承前标注**：（已在第 1 章『Rust 的设计哲学与编译模型总览』讲透「编译期静态检查」的上位心智——把 JS 里运行时/GC 兜底的问题前移到编译期；本章只看它在一个全新维度——**状态合法性与控制流分支**——的新侧面：把「漏处理某个状态」从运行时 bug 前移为编译期错误，与所有权/借用那套「内存维度的前移」是同一种哲学的不同落点。）

- **关键权衡（选择 → 换来 → 代价）**：
  1. **让 enum 变体携带异构负载** → 换来了用**一个**类型精确建模「多形态值」（如消息事件、AST 节点、Option/Result） → 代价是运行时必须携带一个「判别式」tag 记录当前是哪个变体，且**访问负载前必须先匹配/解构**，不能像 struct 字段那样直接 `obj.field` 点出来。
  2. **match 强制穷尽** → 换来了新增变体时所有调用点**编译报错**（一张重构安全网，绝不漏处理） → 代价是当你只想关心一种情况时，也必须显式把其余情况打发掉（写 `_` 兜底或改用 `if let`），相比 JS 的「只写你关心的 if」更啰嗦。
  3. **放弃 `null`，用 `Option<T>` 表达「可能缺失」** → 换来了「缺失」成为类型签名的一部分、编译器强制你处理 `None` → 代价是所有可能缺失的值都要 `Option` 包装/解包，与 JS「万物随时可能 null」的直觉直接冲突；好消息是 niche 优化让 `Option<&T>` 与裸指针**同大小**，上述安全换来的运行时开销常常是零。
  4. **enum 是「封闭集合」而非「开放子类型」** → 换来了穷尽性检查才有意义（编译器知道全部变体） → 代价是跨 crate 扩展别人的 enum 不可能（要扩展就用自己的 enum 包一层），与面向对象「随时子类化扩展」的思路相反。

- **最小心智模型（3～7 步）**：
  1. **定义**：用 `enum` 列出若干互斥变体，每个变体可带不同类型/数量的负载（或无负载）→ 编译器为它生成一个「判别式 + 负载」的求和类型。
  2. **构造**：只能用某个变体的名字精确构造值 → 该值的判别式随之钉死，标记「它是谁、负载是什么」。
  3. **解构访问**：要读负载，必须用 `match`（或 `if let`/`let` 模式）「拆开」→ 编译器按判别式选分支，在分支内把负载绑定到变量。
  4. **穷尽校验**：编译器要求分支覆盖所有变体（或用 `_` 显式兜底）→ 漏掉任意一个，编译失败。
  5. **演进闭环**：给 enum 加新变体 → 所有未覆盖它的 `match` 立即编译报错 → 编译器逐一指引你补齐调用点，重构不会偷偷漏网。
  6. **无 null 特例**：缺失用 `Option` 的 `None` 表达 → 「可能缺失」在类型签名里可见、且必须显式处理（这是同一套机制的一个标准库应用）。

- **最小原理演示（应演示 / 应省略 / 演示载体建议）**：
  - **应演示**：① 定义一个各变体带不同负载的小 enum（如消息/事件或几何形状）；② 用一个 `match` 处理它，演示**解构出负载**并**返回统一类型的结果**；③ 演示「给 enum 加一个新变体 → 之前编译通过的 `match` 现在报 non-exhaustive」这条**演进闭环**（这是本章最核心、最有说服力的一刻）；④ 把 `Option<T>` 作为「同一个机制的特例」点一下（无 null）。
  - **应故意省略**：判别式的位级表示与内存布局、niche 优化的全部细节、`#[repr(C)]`、嵌套/递归 enum（`Box` 间接）、match ergonomics/binding modes 的完整规则、宏派生、与泛型/trait bound 的结合。
  - **演示载体建议（重要）**：topic 模式本首选 TS/JS，但**本章核心特性 TS 无法真正复刻**——TS 的判别式联合 + `switch` 只能靠 `never` 旁路「近似」穷尽，一旦写了 `default` 兜底就不再强制，且运行时数据可能偏离类型。因此建议**双载体对照**：先用一小段 TS 模拟「带 `kind` 的联合 + switch」**刻意演示它的缺陷**（漏分支不报错、新变体不强制），再立刻用 Rust 原生 `enum` + `match` 重写同一逻辑、由编译器报错证明差异——对照比单写一种更能击穿「原理之别」。若只选一种载体，**必须选 Rust**，否则穷尽性这条灵魂原理根本演不透。

- **正文不宜展开的细节（供 Writer 裁剪）**：判别式位宽与具体布局（unsafe 才关心）；niche 优化的多缺口情形与 `Option<NonNull<T>>`；binding modes / 默认绑定模式的历史与规则；`macro_rules!`/`#[derive]` 如何为 enum 生成代码；enum 与 trait bound/泛型结合（留待下一章『Trait 与泛型』）；递归 enum 为何需要 `Box`（可点到「变体大小需编译期已知」即止）。

- **推荐的一个执行轨迹例子**：
  - **输入**：一个 `enum Message { Quit, Move { x: i32, y: i32 }, Write(String), ChangeColor(i32, i32, i32) }`，外加一个具体的 `Message` 值。
  - **关键中间态**：`match msg` → `Quit` 直接处理 / `Move { x, y }` 解构出坐标 / `Write(text)` 绑定字符串 / `ChangeColor(r, g, b)` 绑定三元 → 每个分支产出**同一类型**的返回值。
  - **演进时刻**：再给 enum 加一个 `Send(String)` 变体 → 上面的 `match` 立即编译报错「non-exhaustive patterns」→ 引导逐处补齐。
  - **演什么**：解构 + 穷尽 + 演进闭环；**不演**：内存布局与 tag 位宽。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **enum 是求和类型（sum type / tagged union / discriminated union）**：变体之间是「或」关系，与 `struct`（积类型 / product type，「与」关系）对偶。这是「代数数据类型」一词的来由——类型的代数：积对应 `struct`/元组，和对应 `enum`。依据: The Rust Programming Language, ch06「Enums and Pattern Matching」；rust-lang/unsafe-code-guidelines 词汇表「niche / tagged union」条目。
- **变体可携带异构负载**：每个变体可有不同类型、不同数量的关联数据（或无数据），如 `Option<T>` 的 `Some(T)` 带 `T`、`None` 不带；变体本质是「值构造子」。依据: The Rust Programming Language, ch06-01「Defining an Enum」。
- **`Option<T>` 取代 `null`**：Rust 语言层面没有 `null`，「可能缺失」由标准库 enum `Option<T>`（`Some(T)` | `None`）表达，使缺失成为类型的一部分。Tony Hoare 把 `null` 引用的发明称为「十亿美元错误」。依据: The Rust Programming Language, ch06-01「The Option Enum」；Tony Hoare,「Null References: The Billion Dollar Mistake」(QCon 演讲)。
- **`match` 是表达式且有穷尽性硬约束**：`match` 求值为「被选中分支的值」，各分支类型须一致；编译器强制覆盖所有可能模式，否则报 non-exhaustive。依据: The Rust Programming Language, ch06-02「The match Control Flow Construct」；rustc-dev-guide「Pattern and Exhaustiveness Checking」。
- **模式可解构与绑定**：模式可绑定变量（`Some(x)`）、用 `_` 忽略单个字段、用 `..` 忽略剩余、用 `@` 既绑定又比较（`n @ 1..=5`）。依据: The Rust Programming Language, ch06-02 与 ch18「Patterns」。
- **模式的 refutability（可反驳性）**：模式分 refutable（可能失败，如 `Some(x)`）与 irrefutable（必匹配，如 `x`、`(a, b)`）。`let` 语句与函数参数只接受 irrefutable；`match` 臂接受 refutable；`if let` / `while let` / `let ... else` 接受两者，但对 irrefutable 模式会告警（因为「判断是否匹配」对这些模式没有意义）。依据: The Rust Programming Language, ch19-02「Refutability」。
- **内存布局：判别式 + niche 优化**：enum 运行时表示为带 tag 的联合体；编译器会复用类型中「非法位模式」（如引用永不为空，故空指针可用作 `None` 的 niche），使 `Option<&T>` 与裸指针**同大小**——这是「无 null 的安全」常为零开销的关键。niche 优化的具体位级行为是实现细节、非语言保证。依据: rust-lang/unsafe-code-guidelines 词汇表「niche」；社区与论坛对 Null Pointer Optimization 的整理。
- **enum 是封闭集合，变体不是子类型**：变体名用 `::` 限定（或 `use` 引入）；不可跨 crate 给别人的 enum 追加变体——这是穷尽性检查成立的前提。依据: The Rust Programming Language, ch06-01。

## 关键流程

定义 enum（列出互斥变体 + 各自负载）→ 用某变体名构造一个值（判别式随之钉死）→ `match` 按判别式选分支 → 分支内解构并把负载绑定到变量 → 编译器校验穷尽性（不穷尽则编译失败）→ 演进时新增变体触发所有未覆盖点编译报错，引导逐处补齐。

依据: The Rust Programming Language, ch06-01 / ch06-02；rustc-dev-guide「Pattern and Exhaustiveness Checking」。

## 易混淆 / 边界 / 推断

- **事实**：TS 的 discriminated union + `switch` 可借 `never` 做「近似穷尽」检查，但 (a) 一旦写 `default`/`_` 兜底就不再强制；(b) 运行时数据（来自 JSON/外部边界）可能偏离类型，仍可能漏分支；(c) 新增联合成员默认不会让所有 `switch` 报错，除非显式开启相关检查且不写兜底。Rust 的 enum 值构造受编译器约束、运行时不可能「凭空变成」未列出的变体，这是「让非法状态不可表达」在运行时也成立的根因。依据: TypeScript Handbook「Narrowing / Discriminated Unions」；The Rust Programming Language, ch06。
- **事实**：`match` 没有「穿透/fallthrough」（不像 C 的 `switch`），每个分支是一个独立的块；`match` 须按顺序求值，第一个匹配的臂胜出。依据: The Rust Programming Language, ch06-02。
- **推断（标注为推断）**：niche 优化是「实现细节」而非语言级保证；目前唯一可相对依赖的是「单 unit 变体 + 内嵌类型有 niche」的 Option-like 模板。依赖具体布局应走 `unsafe` 文档而非想当然。依据: unsafe-code-guidelines 词汇表；users.rust-lang.org 关于 niche 适用范围的讨论。
- **边界**：enum 与 trait bound / 泛型结合（参数化 enum、对 enum impl trait）留待下一章『Trait 与泛型：编译期单态化的静态多态』；递归 enum（变体含自身类型）需用 `Box` 间接，因为变体大小必须编译期已知。依据: The Rust Programming Language, ch15 智能指针相关讨论（递归类型与 Box）。
- **待查证**：多 niche 类型（一个原始类型有多个非法位模式）的 enum 布局优化目前存在已知缺口（rust-lang/rust issue #160054 一类），具体覆盖范围以编译器版本为准，本章不展开。
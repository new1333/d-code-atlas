# 错误即值：Result/Option 与 ? 运算符 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：
  写 JS/Java 时，你调用一个 `readFile(): string`，从签名完全看不出它会不会抛——某天它在生产环境炸了，你才发现第十层调用里藏着一个 `throw`。又或者你访问 `user.address.city`，某个用户的 `address` 是 `null`，于是整个页面白屏。这两类 bug 的共同点是：**失败信号不在类型里、不在签名里，只在运行时跳出来**。你既无法在编译期知道"哪里可能出错"，也无法强迫同事"必须处理错误"。Rust 的回应是：把这两件事都变成编译期的事。

- **一句话核心思想**：
  **失败是一个普通的值（带类型、可传递、可转换），而不是一条隐形的控制流跳转**——因此它必须出现在函数签名里，也必须被调用方当场处理或显式传播。

- **设计动机（为什么需要它）**：
  例外（exception）和 null 各有一个致命缺陷：例外的传播路径**对类型系统不可见**（签名不声明 `throws`，任何一行都可能炸出函数），null 则**把"无"伪装成所有引用类型都有的合法值**（于是每次解引用都是潜在的空指针）。Rust 要同时消灭这两类"隐形的运行时炸弹"，于是用一个枚举值来表示"可能无值"（Option）、用另一个枚举值来表示"可能失败"（Result），让失败回到类型系统与正常返回值的轨道上。
  - **承前关系（供跨章去重）**：Option 和 Result **就是标准库预先写好的两个 enum**，对它们的处理用的还是 `match` 的穷尽性检查——（已在第 6 章『代数数据类型：枚举与穷尽模式匹配』讲透"enum 是和类型 + match 把非法状态在类型层消灭"，本章只看它的新侧面：把这个机器专门用在"失败/缺席"这个语义上，得到两个特化 enum + 配套的 `?` 早返回传播 + `From` 错误转换）。本章也是第 1 章"把运行时兜底前移到编译期"这一总主题在错误领域的具体落地，不必再重述总主题。

- **关键权衡（本章核心，4 条三段式）**：
  1. **把失败编进返回类型签名（`T` → `Result<T, E>`）→ 换来"失败路径在签名上一眼可见、且只能沿返回值这条显式通道流动"→ 代价是每个可能失败的调用都得显式处理或传播，比 JS 一层 `try/catch` 包住更啰嗦**。（正因如此才发明了 `?` 来降低啰嗦度——见权衡 3。）
  2. **用 enum + 穷尽 `match` 强制调用方处理 → 换来"漏掉错误分支会直接编译失败，而不是上线后变成 NPE"→ 代价是没有"先忽略、以后再说"的逃生口；想忽略必须用 `unwrap()`（崩溃式）或 `let _ =`（显式丢弃）主动声明，把偷懒变成一个**可见的、可被 review 的决定**。**
  3. **`?` 运算符 + `From` trait 的自动错误转换 → 换来"错误像异常一样沿调用栈向上顺滑冒泡，但每一跳都类型安全、且在签名上可追踪"→ 代价是不同抽象层之间要为错误类型写 `From` 实现（或借助生态库自动 derive），"错误类型该怎么设计"本身成了一门需要学的学问。**
  4. **`panic!` 与 `Result` 的二元划分 → 换来"把'可恢复的预期失败'和'不可恢复的不变式破坏'在语言层就区分开"→ 代价是初学者要学一套判断准则（数组越界、除零、不变式被破坏 → panic；I/O、解析、用户输入等可预期失败 → Result），且 `panic` 的栈展开/捕获在 FFI 边界是后期才补的洞，默认不该被 catch。**

- **最小心智模型（3～7 步）**：
  1. 一个操作可能失败 → 把它的返回类型从 `T` 改成 `Result<T, E>`（一个"成功值 / 错误值"二选一的普通枚举值）。
  2. 调用方拿到这个值后**必须拆开它**才能拿到里面的 `T`——拆的方式是 `match`（原地处理）或 `?`（向上游透传），编译器靠穷尽性 + `#[must_use]` 保证你不会"忘了它可能失败"。
  3. 选 `?` 时：若值是成功，拆出 `T` 继续往下走；若是错误，立刻退出当前函数，退出前用 `From` 把源错误类型转换成当前函数声明的错误类型。
  4. 于是错误沿调用栈**逐层 `?` 向上冒泡**，像异常的栈展开，但每一跳的类型转换都在编译期被检查，直到某一层决定 `match` 真正处理它。
  5. 只有"真正不可恢复"（不变式被破坏、逻辑上不可能发生）才用 `panic!`——它不是值，是展开栈的控制流，不该被当成可处理错误。
  6. `Option<T>`（Some/None）是 Result 的"退化版"：只表达"有/无"，不带错误细节；两者用 `.ok()` / `.ok_or()` 互转。
  7. 顶层通常用 `fn main() -> Result<(), E>` 收口，让未处理的错误一路 `?` 到进程退出，由运行时打印——整个程序没有任何一处"偷偷抛出"。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个从零构造的 `Result<T,E>` 判别联合类型 → 一个返回它的可能失败函数 → 调用方被迫穷尽处理两个分支（透明啰嗦版）→ 再展示 `?` 不过是"成功拆值 + 失败则带 `From` 转换地早返回"这段逻辑的语法糖。**每一行都要对应上面某个原理点**（值化失败 / 强制处理 / 早返回传播 / 类型转换接缝）。
  - **应故意省略**：`thiserror`/`anyhow` 等生态库、`#[derive(Error)]`、`?` 作用于 `Option` 的细节、所有组合子（`map`/`and_then`/`unwrap_or`）、`Box<dyn Error>` 与 `fn main() -> Result` 收口、panic 的 unwind/abort 机制、`catch_unwind`、backtrace。**不追求工程完整**，只演透"错误即值 + 强制处理 + 带转换的早返回"三件事。
  - **演示载体建议**：topic 模式**首选 TS**（本 Atlas 产物是 JS 生态 VitePress 站点）。用 TS 的 discriminated union（`{ tag: "ok" } | { tag: "err" }`）能极其贴切地还原 Rust 的 enum + 穷尽 `switch`。**强烈建议在演示中点明一个对比教学卖点**：TS 的穷尽性检查（`default: never`）只在**类型层**且可被绕过（你可以不 switch 直接访问 `.value`），而 Rust 是**编译期硬挡**——这一对比恰好讲透了"为什么 Rust 把同样的和类型做得更安全"。

- **正文不宜展开的细节（供 Writer 裁剪）**：
  组合子方法全集（`map_or`/`unwrap_or_else`/`and_then`/`or`…）、`Option` 与 `Result` 互转的所有 API、`thiserror`/`anyhow` 的用法对比与选型、自定义错误枚举的完整设计模式、`?` 在 `Option` 上下文中的重载行为、`fn main() -> Result<(), E>` 的底层机制、`Box<dyn Error>` 作为"随便什么错误"的快速写法、panic 的 unwind vs abort 配置、`catch_unwind` 与 FFI 边界、`#[must_use]` 自定义提示串、`std::error::Error` trait 的 `source()` 错误链。这些是"用的时候查"，不是"学原理"的主线。

- **推荐的一个执行轨迹例子**：
  输入 `"abc"` 喂给 `parse_number` → 内部得到 `Err(ParseError)` → 上层 `parse_config` 里的 `let n = parse_number(part)?;` 检测到 `Err` → 调 `From::from` 把 `ParseError` 转成 `ConfigError` → 立刻 `return Err(ConfigError)`（该行之后的代码全部跳过）→ `main` 中 `match` 到 `Err` 分支 → 打印错误信息、程序**正常继续往下走**，没有 `try/catch`、没有崩溃、没有栈展开。核心要演的是"错误作为一个值，沿返回通道逐层换装、最终被 match 接住"，而不是演全量错误类型 taxonomy。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **Rust 既没有 exception，也没有 null**。它用两个标准库枚举替代：`Option<T>` 表达"可能无值"、`Result<T, E>` 表达"可能失败"。失败和缺席都被表示为**普通的、有类型的值**，而不是控制流跳转或万能空指针。
  依据: The Rust Programming Language（官方 Book）第 9 章「Error Handling」导言；Learning Rust 文档「Option and Result」明确指出 Rust 同时跳过 exception 与 null。

- **`Option<T>` 的定义**：`enum Option<T> { Some(T), None }`。它替代了其他语言里的 null/nil/undefined——"无"不再是一个所有类型都暗中可取的值，而是一个**必须先 match 拆开才能拿到 T** 的枚举变体。
  依据: Rust 官方 Book 第 6 章「The Option Enum and Its Advantages Versus Null Values」；`std::option::Option` 标准库文档。

- **`Result<T, E>` 的定义**：`enum Result<T, E> { Ok(T), Err(E) }`。成功值与错误值都是普通泛型参数，因此**错误类型 E 会出现在函数签名里**——这是"失败对类型系统可见"的直接来源。
  依据: Rust 官方 Book 第 9 章「Recoverable Errors with Result」；`std::result::Result` 标准库文档。

- **`?` 运算符的精确语义**：作用在 `Result<T, E>` 上时，若为 `Ok(v)` 则求值为 `v` 并继续；若为 `Err(e)` 则**立即从当前函数返回** `Err(From::from(e))`——即用 `From` trait 把源错误类型转换成当前函数声明的错误类型后再早返回。它也重载作用于 `Option`（`None` 时早返回 `None`）。
  依据: Rust 官方 Book 第 9 章「A Shortcut for Propagating Errors: the ? Operator」；Rust Reference 的表达式章节中 `?` 的 desugar 定义（GitHub rust-lang issue #123793 等技术讨论亦佐证 `Err(From::from(e))`）。

- **`panic!` 是不可恢复错误，不是值**：触发 panic 会展开栈（默认）或直接 abort，无法被常规 `match` 处理；它表达"不变式被破坏、继续执行已无意义"。官方准则：**可预期的、调用方可能合理处理的失败用 `Result`；逻辑上不该发生的状态破坏才用 `panic!`**。`Result` 是公开 API 的默认选择。
  依据: Rust 官方 Book 第 9 章「Unrecoverable Errors with panic!」与「To panic! or Not to panic!」。

- **编译器靠两个机制"逼"你处理错误**：(1) 要拿到 `Result`/`Option` 里的 `T`，必须 `match`（或用 `?` 传播），而 `match` 受穷尽性检查约束（来自前置章的 enum 机制）；(2) `Result`、`Option`、`Iterator` 自身标注了 `#[must_use]`——**忽略返回值会产生编译警告**（注意：是 warning 不是 hard error，可用 `let _ = ...` 显式丢弃以消音）。
  依据: Rust Reference「Attributes · must_use」；RFC 1940「must_use on functions」；rust.docs.kernel.org must_use 条目（确认 Result/Option/Iterator 默认带 `#[must_use]`，且为 warning 而非 error）。

- **错误的类型转换走 `std::convert::From`**：`?` 自动调用 `From::from`，因此只要"当前函数的错误类型 impl 了 `From<源错误类型>`"，源错误就会被无缝转换。这把"不同层不同错误类型"的阻抗，降成写一个 `From` impl（实战中多用 `thiserror` 自动 derive，或用 `anyhow` 直接装任意错误）。
  依据: Rust 官方 Book 第 9 章「? 与 From 配合」段落；`std::convert::From` 标准库文档（`From` 自动获得 `Into` 的 blanket impl，故也可说"返回类型 impl Into 源错误"）。

- **`Option` 与 `Result` 的语义区分**：`None` 表示"这里就是没有值"，**缺席不是错误**（如 HashMap 查不到 key）；`Err` 表示"我做了一件本该成功的事却失败了"，**失败需要被解释和处理**。两者用 `.ok()`（丢错误细节转 Option）/ `.ok_or()`（Option 转 Result，补一个错误）互转。混用它们会让 API 语义含糊。
  依据: Rust 官方论坛「Option vs Results」、r/learnrust「Why do both Option & Result exist」讨论的官方口径；`std::option::Option::ok` / `std::result::Result::ok` 标准库文档。

## 关键流程

错误从一个底层失败，到被某一层接住，沿调用栈"逐层换装"传播：

```
parse_number(text)            // 产出 Result<Number, ParseError>
        │
        │  在上层函数中：let n = parse_number(text)?;
        ▼
   ? 检查变体
   ├── Ok(v)  → 拆出 v，继续执行本行之后的代码
   └── Err(e) → return Err( From::from(e) )   // 类型转换 + 早返回，立刻退出当前函数
        │
        ▼
parse_config(...) : Result<_, ConfigError>    // 源错误已被 From 换成 ConfigError
        │  （可继续 ? 透传）
        ▼
main : match 接住 Ok / Err 两分支（或 fn main() -> Result 直接 ? 到进程退出）
        │
        ▼
   程序继续运行 / 打印错误并退出（无 try/catch，无栈展开式跳转）
```

要点：错误**始终是一个返回值**，沿"返回通道"逐层向上；每一层的 `?` 在编译期被检查 `From` 转换是否成立。这等价于异常的栈展开，但传播路径**对类型系统完全可见、可追踪**。
依据: Rust 官方 Book 第 9 章「Propagating Errors」与「? Operator」两节的流程叙述。

## 易混淆 / 边界 / 推断

- **事实**：`unwrap()` / `expect()` 也会 `panic!`——它们不是"处理"错误，而是声明"我确信这里不会失败，失败就崩"。它们是开发期的捷径，在生产代码里通常被视为"欠下的技术债"，除非确有不变式保证。
  依据: Rust 官方 Book 第 9 章；`Result::unwrap` 文档注明 panic 行为。

- **事实**：`#[must_use]` 是 warning 不是 error，且对 `trait impl` 的方法当前**不生效**（rust-lang issue #145257）。所以"编译器强制处理"在边界处有缝——Rust 选择"提醒而非强制"，把最终决定权留给程序员。
  依据: GitHub rust-lang/rust #145257；Rust Internals「Why is ignoring must_use a warning rather than an error」讨论。

- **事实**：`?` 不仅能作用于 `Result`，也能作用于 `Option`（`None` 时早返回 `None`），且可作用于任何 impl 了 `Try` 的类型（`Try` trait 曾是不稳定实验性 trait，实战中以 Result/Option 为主）。
  依据: Rust Reference「? operator」；`std::ops::Try`（标注 unstable）。

- **易混淆**：`fn main() -> Result<(), E>` 是一种特殊签名——允许在 `main` 里直接用 `?`，未处理的错误由运行时打印并以非零码退出。这给人一种"错误冒泡到顶层自然变成进程退出"的收口感，是 Rust 程序的标准收口。
  依据: Rust 官方 Book 第 9 章「Where the ? Operator Can Be Used」。

- **推断（标注为推断）**：Rust 不设 exception 的深层动机，应是"例外的隐式控制流与 Rust『所有副作用都对类型系统可见』的整体哲学相冲突"——借用检查器、所有权追踪都假设"函数要么正常返回要么不返回"，跨函数的隐式跳转会破坏这些静态分析的前提。这与 Book/RFC 强调"签名应诚实反映失败"是一致的，但官方未用这种"静态分析前提"措辞，故标注为推断。

- **边界**：panic 默认 unwind（可被 `catch_unwind` 捕获，但不被鼓励，且跨 FFI/与 abort 模式下不可捕获）。所以"panic 不可恢复"是**约定**层面的——语言提供了逃生舱，但社区共识是别用它做正常错误处理。
  依据: Rust 官方 Book 第 9 章「panic! and unwind」；`std::panic::catch_unwind` 文档注明的限制。

- **未理解 / 待查证**：`?` 背后的 `Try` trait 仍在演进（`Try`/`TryV2` 的稳定形态），相关 desugar 的最终标准表述以未来 Rust edition 为准。本章教学不依赖该 trait 的内部细节，按"作用在 Result/Option 上"的行为层语义讲解即可。
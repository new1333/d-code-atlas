# unsafe 与 FFI：安全边界的逃逸舱 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：当你想调用一个现成的 C 库（OpenSSL、libsqlite3、系统 syscall），或想实现一个编译器死活不让你写的数据结构（自引用的双向链表、intrusive 容器），或要手写一个跨线程同步原语时，借用检查器会拦住你——因为它无法在编译期证明这些操作安全。如果没有逃生舱，Rust 就是一座"安全的孤岛"，既无法和几十年的 C 生态互操作，也无法实现最底层的抽象，更无法编译到 WebAssembly（因为 wasm 边界本身也是一种 FFI）。

- **一句话核心思想**：`unsafe` 是一个诚实的边界——它不关闭任何安全检查，而是把编译器无法证明的少数操作隔离出来，由程序员接手证明责任，从而在维持全局安全推理的前提下打开通往底层与 C 生态的入口。

- **设计动机（为什么需要它）**：Rust 的安全保证建立在"编译器能证明"之上，但有三类场景编译器永远证明不了——调用它看不到实现的外部 C 代码、裸指针运算（编译器不做别名/有效性分析）、跨语言/跨线程的底层契约。对这些，Rust 不选择"假装安全"，而是诚实地承认边界、用 `unsafe` 把证明责任转交给人。
  - 承前关系：**（已在第 4 章『生命周期』讲透"编译期证明引用有效性"，本章只看它的新侧面：当编译器根本证明不了时怎么办——把保证从『编译期证明』降级为『人工契约』。这是 Rust 安全保证三档谱系的最后一档：编译期证明 → 运行时检查 → 人工契约。）**
  - 承前关系：**（已在第 12 章『智能指针与内部可变性』讲透"把借用检查延迟到运行期"作为运行时逃生舱，本章只看它的新侧面：还有一类问题连运行时检查也兜不住——与外部世界（C 代码、硬件、跨语言）的契约只能由人 uphold。两个"逃生舱"方向不同：RefCell 是把检查"延迟"到运行期，unsafe 是把检查"放弃"并转为人工契约。）**

- **关键权衡（本章核心，4 条）**：
  1. 选择"只开放 5 种特定超能力、且必须用 `unsafe` 块/`fn`/`impl` 显式标注" → 换来"危险点可定位、可 grep、可审计" → 代价是"程序员要为每处 `unsafe` 写安全论证（SAFETY 注释），心智负担高，且一旦论证错了惩罚不是 panic 而是**未定义行为（UB）**——后者连出错的现场都不可靠"。
  2. 选择"`unsafe` 不关闭借用检查、只增不减" → 换来"safe 代码与 unsafe 代码的组合仍然可推理（soundness 可组合：safe API 内部藏一点 unsafe 不会污染外部调用者）" → 代价是"语义比直觉复杂——大众普遍误以为 `unsafe=关闭安全检查`，学习曲线陡，这是 Rust 最被误解的关键字"。
  3. **FFI 特有**：选择"用 C ABI（`extern "C"` + `#[repr(C)]` + `#[no_mangle]`）作为与外界互操作的通用接口" → 换来"能和几乎所有语言生态互通（C 是最低共同语言）" → 代价是"FFI 边界必须放弃 Rust 的高级类型（`String`/`Vec`/`Result`/生命周期），降级成裸指针 + 手动内存管理，边界处 bug 高发：内部 NUL 字节、panic 跨边界 unwind、双重释放、分配器不匹配"。
  4. 选择"用 safe wrapper 把 unsafe 藏进最小模块、对外只暴露 safe API" → 换来"普通使用者仍享受完整安全保证，整个 crate 里只有少数几行需要审计" → 代价是"封装的正确性极难保证（soundness bug 是 Rust 生态里最隐蔽、最难复现的 bug），需要靠私有性（pub/private）守住不变式 + 严格 review + 测试"。

- **最小心智模型（7 步）**：
  1. 你遇到一个编译器拒绝、但你（凭额外知识）确信安全的操作（如：把一个切片拆成两段不重叠的可变借用）。
  2. 用 `unsafe { ... }` 把它包起来——这一步的本质是"声明：此处编译器不证明，我来证明"。
  3. 编译器在该块内放行 5 种超能力之一（解引用裸指针 / 调 unsafe 函数 / 实现 unsafe trait / 访问 mut static / 访问 union 字段）；**块内其它一切检查（借用、生命周期、类型）照常生效**。
  4. 你紧挨着写一段 `// SAFETY: ...` 注释，讲清楚"此处为什么不违反不变式"——这是给未来 reviewer 和自己的契约。
  5. 把这段 `unsafe` 藏进一个 `fn` 里，用私有性（不导出内部字段）守住它依赖的不变式。
  6. 对外暴露的 `fn` 不带 `unsafe` 关键字——调用者完全感知不到内部有 `unsafe`，享受"零成本的安全感"。
  7. 若是 FFI 场景，额外处理三件事：ABI（`extern "C"`）、内存布局（`repr(C)`）、跨边界的字符串与 panic（`CString`/`CStr` + 禁止 unwind）。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：两个极小例子，共同演透"**编译器证明不了 → 降级为人工契约 → 重新封装成 safe API**"这条主线。
    (a) 复刻标准库 `slice::split_at_mut` 的核心思想：借用检查器无法证明"一个切片切成两段不重叠的可变借用"，所以底层转裸指针手动切分，对外却暴露完全 safe 的签名——这是"safe API 包 unsafe 实现"的最经典教学样本。
    (b) 一个 `extern "C"` 调用 libc `abs` 的最小 FFI 例子，演透"`extern "C" { ... }` 声明 + `unsafe` 块调用"两步。
  - 应故意省略：`bindgen` 工程化与 build.rs、`union` 的细节、可变 static 的细节、Stacked Borrows / Tree Borrows 内存模型、过程宏、各种非 C 的 ABI（system/fastcall/Rust）、SIMD intrinsics、panic unwind 的实现机制。
  - **演示载体建议**：本章是 **Rust 特有语义**——`unsafe`/裸指针/FFI 在 JS/TS 里**没有对应物**，核心功能 TS/JS 讲不透，**这是 topic 模式下载体合理退回 Rust 的典型情形**。建议主用 Rust 极小例子（二三十行即可）。为照顾前端读者，可**辅以一段 TS 类比**：用"类型品牌（branded type）+ 不导出构造器"模拟"用私有性守住不变式"——即 `unsafe` 的契约思想在类型层的精神同构，帮助读者建立直觉，但必须点明这只是类比、Rust 的 `unsafe` 是真实的内存安全机制而非类型层把戏。

- **正文不宜展开的细节**：
  - 5 种超能力每一种的全部边界（尤其 `union` 字段访问的初始化语义、可变 `static` 在多线程下与 `Sync` 的关系）。
  - Drop 检查（`Drop`、`MayDangle`、`PhantomData` 的非侵占性变体）——unsafe 与析构顺序的交互。
  - 指针 provenance、严格别名、内存模型（学术界尚未定论，规范层面仍是 open question）。
  - `bindgen` 的安装、构建脚本、与 `cc` crate 的配合——属工程化，留给读者自学。
  - Rust 1.82 起 `extern` 块里可声明 `safe fn` 的新特性细节（可在正文一句话提及其存在，但不展开动机）。
  - 跨 FFI 的 panic：`catch_unwind` vs `abort` 的机制差异。
  - SIMD intrinsics、链接器细节、`#[link(...)]` 属性的参数。

- **推荐的一个执行轨迹例子**（演核心思想，以 `split_at_mut` 为例）：
  输入：一个 `&mut [T]` 切片 + 一个索引 `mid`
  → 编译器视角：想返回两个 `&mut [T]`，但"它们会不会重叠"借用检查器证不出来 → 拒绝
  → 转裸指针：取切片起始 `*mut T` 与 `len`
  → 在 `unsafe` 块内：手动切分成 `[ptr, ptr+mid)` 与 `[ptr+mid, ptr+len)` 两段（因为 `mid ≤ len`，数学上必不重叠，这是人 uphold 的契约，写进 `// SAFETY:` 注释）
  → 用 `from_raw_parts_mut` 把两段裸指针重新包回可变切片引用
  → 输出：两个普通的 `&mut [T]`，对外签名完全 safe，调用者无需任何 `unsafe`
  （这条轨迹把"编译期证明不了 → 人工契约 → 重新封装为 safe API"三步演透，是全章灵魂）

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`unsafe` 的五大超级能力（官方权威定义）**：在 safe Rust 基础上，`unsafe` 额外放行且仅放行这 5 种操作——(1) 解引用裸指针 `*const T`/`*mut T`；(2) 调用 `unsafe` 函数或方法（含 FFI 外部函数）；(3) 实现 `unsafe` trait；(4) 访问或修改可变 `static` 变量；(5) 访问 `union` 的字段。`依据: The Rust Programming Language 官方书「Unsafe Rust」章节（ch20-01，旧版 ch19-01）`

- **关键澄清：创建裸指针是 safe 的，只有解引用才需要 `unsafe`**。即 `let p: *const i32 = &x;` 在 safe 代码里合法；`unsafe { println!("{}", *p); }` 才需要块。`依据: The Rust Programming Language「Unsafe Rust」；Google Comprehensive Rust「Dereferencing Raw Pointers」`

- **关键澄清：`unsafe` 不关闭借用检查器，语义是"只增不减"**。`unsafe` 块内的普通引用（`&`/`&mut`）仍然被完整借用检查；`unsafe` 只是新增了借用检查器不覆盖的领域（裸指针）的操作权。原文："unsafe doesn't turn off the borrow checker or disable any other of Rust's safety checks: if you use a reference in unsafe code, it will still be checked." `依据: The Rust Programming Language「Unsafe Rust」；Steve Klabnik「You Can't Turn Off the Borrow Checker in Rust」`

- **`unsafe` 关键字的双重用途**：(1) 声明"此处存在编译器无法检查的契约"（声明端：`unsafe fn` / `unsafe trait`）；(2) 声称"我已经 uphold 了该契约"（使用端：`unsafe { }` / `unsafe impl`）。这是理解 `unsafe` 语义的最核心模型。`依据: The Rustonomicon「How Safe and Unsafe Interact」`

- **Soundness（健全性）性质**：官方定义为"No matter what, Safe Rust cannot cause Undefined Behavior"——无论 safe 代码怎么写、怎么组合，都不可能触发未定义行为。这是 Rust 整个安全模型的根基承诺；所有 `unsafe` 代码的最终义务就是不让这个承诺被打破。`依据: The Rustonomicon「How Safe and Unsafe Interact」；arXiv 2504.21312「Annotating and Auditing the Safety Properties of Unsafe Rust」`

- **safe wrapper 模式（封装边界保护不变式）**：把 `unsafe` 藏进模块内部，用 Rust 的私有性（字段不加 `pub`、内部函数不导出）阻止外部代码破坏 `unsafe` 依赖的不变式，对外只暴露 safe API。soundness 不仅取决于 `unsafe` 块内的逻辑，还取决于外部 safe 代码能否违反不变式——而私有性正是阻止后者的大门。`依据: The Rustonomicon「How Safe and Unsafe Interact」；Stanford CS「Unsafe in Rust: The Abstraction Safety Contract and Public Encapsulation」；without.boats「Unsafe Abstractions」`

- **`unsafe trait` 的代表：`Send`/`Sync`**。这两个 marker trait 是 `unsafe` 的——它们是"unsafe 去实现"，而非"unsafe 去调用"。因为编译器无法验证一个类型真的能安全跨线程移动/共享，所以要求实现者用 `unsafe impl` 显式声明"我已验证"。含裸指针、包装 FFI 类型、或含 `UnsafeCell` 的类型常需手动 `unsafe impl`。`依据: The Rustonomicon「Send and Sync」；The Rust Programming Language（Brown edition）「Extensible Concurrency with Send and Sync」`

- **FFI 三件套（互操作的核心）**：
  - `extern "C"`：让函数遵循 C 调用约定（C ABI），这是跨语言互操作的 lingua franca。
  - `#[no_mangle]`：关闭 Rust 的 name mangling（符号重整），让符号名原样暴露给链接器（注意：`extern "C" { ... }` 块里声明的外部函数隐式即为 no_mangle）。
  - `#[repr(C)]`：强制 struct/enum 采用 C 兼容的内存布局（Rust 默认布局是未定义/可重排的，跨语言传递 struct 必须加此属性）。
  `依据: The Rustonomicon「FFI」；Effective Rust「Item 34: Control What Crosses FFI Boundaries」`

- **FFI 的两个方向**：(a) Rust 调 C——用 `extern "C" { fn foo(...); }` 声明外部函数，在 `unsafe` 块内调用；(b) C 调 Rust——用 `#[no_mangle] pub extern "C" fn foo(...) {}` 导出 Rust 函数。`bindgen` 工具可从 C 头文件自动生成前者的声明。`依据: The Rustonomicon「FFI」；Microsoft Rust Training「Unsafe Rust and FFI」`

- **FFI 边界的字符串类型**：`CString`（owned、堆分配、NUL 结尾、可安全传给 C）与 `CStr`（C 字符串的借用视图，用于读 C 返回的字符串）。Rust 的 `String`/`&str` 不是 NUL 结尾、布局也不保证，不能直接跨 FFI。`依据: Rust 标准库 `std::ffi` 模块文档；Rust FFI Omnibus「String Arguments」`

## 关键流程

- **safe wrapper 的封装数据流（本章主流程）**：
  `safe 调用者` → `safe wrapper 函数（用 pub/private 守住不变式）` → `unsafe { ... } 块（人 uphold 契约，写 // SAFETY 注释）` → `五大超能力之一（通常是解引用裸指针 / 调 unsafe fn）`
  返回时反向：底层操作的结果被重新包成 safe 类型回到调用者，调用者全程无感。
  `依据: The Rustonomicon「How Safe and Unsafe Interact」「Safe and Unsafe」抽象模型`

- **Rust 调用 C 的 FFI 流程**：
  `extern "C" { fn abs(x: c_int) -> c_int; }`（声明外部符号）→ 在普通 Rust 代码中 `unsafe { abs(-5) }`（unsafe 块调用）→ 链接器按 C ABI 找到 libc 符号。
  `依据: The Rustonomicon「FFI」`

- **C 调用 Rust 的 FFI 流程**：
  `#[no_mangle] pub extern "C" fn add(a: i32, b: i32) -> i32 { a + b }`（导出 unmangled 的 C ABI 符号）→ 编译为动态/静态库 → C 侧 `extern int add(int, int);` 声明后调用。
  `依据: The Rustonomicon「FFI」；Effective Rust「Item 34」`

- **安全保证的"三档谱系"对照（贯穿全书的定位图）**：
  ```
  编译期证明（借用检查 + 生命周期）   ← 零开销，全在编译期，第 3/4 章主题
        │ 当编译器证不出来时，向下逃生
  运行时检查（RefCell / Mutex）       ← 有运行时开销，失败=panic，第 12 章主题
        │ 当运行时也兜不住（外部世界契约）时，再向下逃生
  人工契约（unsafe）                  ← 无检查，靠人 uphold，失败=UB，本章主题
  ```
  `依据: 由 The Rustonomicon「How Safe and Unsafe Interact」与 The Rust Programming Language 借用检查/内部可变性章节综合归纳`

## 易混淆 / 边界 / 推断

- **误解（高频）**："`unsafe` 关闭了借用检查器" → **事实**：`unsafe` 块内的普通引用仍被完整借用检查；它只是额外放行裸指针等 5 种操作。误以为"关检查"会导致对 soundness 的错误推理。`依据: Steve Klabnik「You Can't Turn Off the Borrow Checker in Rust」；The Rust Programming Language ch20-01`

- **误解（高频）**："`unsafe` 块里的代码一定危险" → **事实**：`unsafe` 只是放行 5 种操作，块内代码可能完全 sound（如标准库 `split_at_mut` 的实现）。`unsafe` 标记的是"需要人工论证"，不是"这里危险"。

- **误解**："safe API 内部用了 `unsafe`，所以这个 API 不安全" → **事实**：若封装 sound，外部 safe 调用者绝不可能触发 UB。这正是 safe wrapper 的价值。判断标准是 soundness，不是"是否含 unsafe 字样"。

- **边界（FFI 高危坑，每个都建议正文用 callout 提醒）**：
  - **内部 NUL 字节**：`CString::new("a\0b")` 会返回 `Err(NulError)`（而非 panic），因为 NUL 是 C 字符串终止符。`依据: Rust 标准库 `std::ffi::CString` 文档`
  - **panic 跨 FFI 边界 unwind = UB**：Rust panic 若越过 `extern "C"` 边界进入 C 栈帧是未定义行为；须用 `catch_unwind` 捕获或 `panic=abort` 编译。`依据: Microsoft Rust Training「Unsafe Rust and FFI」；The Rustonomicon「FFI / Unwinding」`
  - **分配器不匹配 / 双重释放**：`CString::into_raw()` 给 C 的指针必须用 `CString::from_raw()` 回收，绝不能让 C 的 `free` 释放 Rust 分配的内存（反之亦然）——两者分配器不同。`依据: The Rust FFI Omnibus；Microsoft Rust Training「Unsafe Rust and FFI」`
  - **C 字符串未 NUL 结尾** → 用 `CStr::from_ptr` 会读越界。`依据: Rust 标准库 `std::ffi::CStr` 文档`

- **推断**：`#[repr(C)]` 主要为 FFI 而存在（保证可预测布局），但也被用于需要稳定内存布局的非 FFI 场景（如跨进程、文件序列化的 POD 结构）。标注为推断。`依据: 综合社区用法与 Rust Reference「Type Layout」，repr(C) 的设计意图是 C 兼容`

- **边界（与并发章联动）**：手动 `unsafe impl Send/Sync` 是"用 `unsafe` trait 表达跨线程契约"——这与第 13 章『无畏并发』直接衔接：第 13 章讲编译器自动推导 `Send/Sync`，本章讲"编译器推导不了时，用 `unsafe impl` 手动声明并承担证明责任"。Writer 应在此处显式回指第 13 章，避免重讲推导规则。`依据: The Rustonomicon「Send and Sync」`

- **未理解 / 待查证**：Rust 内存模型（别名规则）的最终规范形态尚未定论——Stacked Borrows 与 Tree Borrows 都是学术提案，目前 `unsafe` 代码的某些边界行为在规范层面仍是 open question。Writer 正文应避免就"哪种模型正确"下结论，可一句话提及"内存模型仍在演进"。`依据: The Rustonomicon「Working with Unsafe」明确指出别名规则未完全规范化`

- **承下（给下一章的铺垫信号）**：本章 FFI 的 `extern "C"` / `#[repr(C)]` / 跨边界数据传递，是下一章『Rust 编译到 WebAssembly』的直接前置——`wasm-bindgen` 本质上就是在 wasm-js 边界自动生成"类 FFI 的安全封装"。Writer 在 FFI 小节结尾可埋一句钩子，但不要展开 wasm 细节（留给下一章）。
# 栈与堆：数据布局与 Copy/Clone 语义 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：从 JS 过来的人写 `let b = a` 时，毫无预警地撞上两种截然相反的结果——当 `a` 是数字时 `a` 还能用，当 `a` 是字符串/对象时编译器却报「use of moved value」。同时满屏的 `.clone()` 让人困惑：到底什么时候该 clone、什么时候不用？根因是 JS 把「数据存哪」「复制多贵」全藏在运行时里（对象一律逃逸到堆、赋值一律共享引用），而 Rust 把这两件事变成了**类型的一部分**，由编译器静态决定。读者缺的不是语法，而是一个能预测 `let b = a` 会发生什么的**心智模型**。

- **一句话核心思想**：Rust 让每个值的「存哪（栈/堆）」和「怎么复制（按位 Copy / 显式 Clone）」成为**类型的静态属性**——Copy 是「按位复制即可安全独立」的契约，Clone 是「可能昂贵、必须显式声明」的深拷贝逃生口。

- **设计动机（为什么需要它）**：所有权模型要回答的核心问题是「**这个值能否被廉价、安全地复制成两份独立副本**」。能 → 复制后两边都可用（Copy）；不能（复制会共享资源）→ 只能转移所有权（move）或显式深拷贝（Clone）。而「能否安全按位复制」又**机械地取决于数据布局**：纯栈上定长字节的数据按位复制天然安全；持有堆指针的数据按位复制会变成两个指针指向同一块堆 → double-free。所以**栈/堆布局 + Copy 契约**才是 move 与 copy 之分背后那只在幕后决定一切的手。本章正是把这只手从幕后拉到台前。
  - **承前关系**：（已在第 2 章『所有权与移动语义』讲透「单一所有权 + 默认 move + 离场 drop」这套取代 GC 的机制，本章只看它的新侧面：**为什么有的值 move、有的值 copy**——这由「栈/堆布局 + 类型是否实现 Copy」机械决定，并补齐 `let b = a` 与 `.clone()` 的底层行为。Writer 不要重讲 move=所有权转移、不要重讲 drop，直接用它们做已知前提。）

- **关键权衡（三段式；本章核心原料）**：
  1. **「编译期定长 → 栈分配；运行期变长 → 堆分配」** → 换来栈值的零分配器开销（移动栈指针即可）+ 确定性释放 → 代价是栈值必须**编译期已知大小**，任何动态/可变长数据都得显式装箱上堆（Box/Vec 等），不能再像 JS 那样「万物自动上堆、一切等价」。
  2. **「用 marker trait Copy 声明『按位复制即安全独立』」** → 换来 `let b = a` 对整数/布尔这类纯字节值**零成本自动复制、源仍可用**（无需手写拷贝、无运行时检查）→ 代价是该类型**禁止拥有堆资源、禁止实现 Drop**，因此 String/Vec 永远不能 Copy，只能显式 `.clone()`，逼程序员为每个非 Copy 值主动决策复制时机。
  3. **「Copy 的合法性由编译器验证（所有字段都得 Copy 才能 derive，且与 Drop 互斥）」** → 换来「按位复制 = 内存安全」的**编译期证明**，从源头消灭 double-free → 代价是程序员**不能手动 `impl Copy` 绕过**（只能 `#[derive]`），且未来给结构体加一个非 Copy 字段会悄悄破坏向后兼容。
  4. **（设计细节，可酌情用）「Copy 作为 Clone 的子 trait」** → 换来统一的复制接口（任何 `T: Clone` 都能 `.clone()`，Copy 类型也兼容）→ 代价是新手困惑「Copy 没有方法，凭什么继承有方法的 Clone」——其实 Copy 只是给编译器看的标记，clone() 对 Copy 类型退化为 `*self`。

- **最小心智模型（3～7 步）**：
  1. 编译器看到一个值：编译期大小定长已知？→ 进栈帧；大小运行期才知或可变？→ 必须放堆（用一个定长的「指针」留在栈上，指向堆数据）。
  2. 栈值随函数调用 push、返回 pop，无分配器开销；堆值靠「栈上的所有者指针 + 所有者离场时 drop 释放堆」管理。
  3. 写 `let b = a`（或按值传参）时，编译器**查 `a` 的类型是否实现 Copy**。
  4. 若 **Copy**：按位复制字节，`a`、`b` 都可用（因按位复制即安全独立，无共享资源）。
  5. 若 **非 Copy**：所有权 **move** 给 `b`，`a` 被编译器标记失效（因按位复制会共享堆指针 → double-free，故禁止保留两个名字）。
  6. 若确实需要两份独立副本：显式调 `a.clone()`——它可执行**任意代码**（深拷贝堆 buffer、分配新内存）。
  7. 函数返回同理：返回 Copy 类型按值复制回调用方栈帧；返回非 Copy 类型把堆的**所有权移交**调用方。
  - **贯穿洞察**（Writer 必点）：move 和 copy 在**字节层面其实是同一个操作——都是按位复制**；唯一区别是编译器是否让旧名字失效。所以「move」不是「把字节搬走、源变空」，而是「字节照抄一份、旧名字被吊销」。这一句点透，新手 90% 的困惑就消了。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个约 40 行的 TS 模型，给每个「值」打 `isCopy` 标记 + 一个运行期 `moved` 哨兵，用三个函数分别演 `assign`（`let b = a`）、`clone`（`.clone()`）。每个函数的每个分支都要**对应上面某条原理**：`assign` 里 `isCopy` 分支 = 按位复制源仍可用；非 Copy 分支 = 复制字节 + 置 `moved=true`（演 move 的「字节照抄、旧名吊销」）；`clone` = 显式深拷贝、对字符串假装分配新 buffer。最后用一组 `i32`(Copy) vs `String`(非 Copy) 的对照调用，让两种结果肉眼可分。
  - **应故意省略**：真实栈/堆字节布局（TS 无此概念，用对象模拟即可，别假装真在操作内存地址）；`#[derive(Copy,Clone)]` 宏展开细节；泛型单态化；与 Drop 互斥的**真实编译期检查**（用一句注释点明「真实 Rust 在编译期就拒绝，这里只能在运行期抛错近似」）。
  - **演示载体建议**：**TS**（本 Atlas 产物是 VitePress/JS 生态站点，TS 对前端读者最友好；无原仓库语言约束）。用普通对象 + 一个 `moved` 布尔字段即可演「move 后访问报错」，不需要 Proxy。
  - 载体选择理由：本章核心是「复制策略 + 失效语义」的逻辑，与具体内存地址无关，TS 完全讲得透；只有讲到真实字节布局才需要退回 Rust 原生，而那是「不宜展开的细节」。

- **正文不宜展开的细节**：
  - Drop 与 Copy 互斥的精确编译器实现、`ManuallyDrop`、`MaybeUninit`（留给 unsafe 章）。
  - `#[derive(Copy, Clone)]` 的 token 流展开（留给宏章）。
  - `mem::size_of`、对齐 padding、`#[repr(C)]` 布局（属 FFI/底层细节）。
  - `Box<T>`「栈上定长指针 → 堆数据」的两层结构细节（留给智能指针章）。
  - `Rc`/`Arc` 这种「靠引用计数实现共享」的中间地带——它既非纯 Copy 也非纯 move（留给智能指针章）。
  - `&T` 是 Copy 但 `&mut T` 非 Copy 的深层原因（与借用规则绑定，留给借用章，本章一句话点到即可）。

- **推荐的一个执行轨迹例子**：
  - 输入：`let s1 = String::from("hi"); let s2 = s1;` 配 `let n1 = 5; let n2 = n1;`
  - 关键中间态：`s1` 类型非 Copy（持堆指针）→ `s2` 接管指针、`s1` 被标记 moved；`n1` 类型 `i32` 是 Copy → `n2` 按位复制、`n1` 仍可用。
  - 输出：之后再访问 `s1` → 编译错误「use of moved value」；访问 `n1` → 正常得 `5`。接着 `let s3 = s2.clone();` → 堆上深拷贝出新独立 buffer，`s2`、`s3` 各自可用。这条轨迹一次演透「copy / move / clone」三种结果。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **栈（Stack）**：LIFO 结构，存取只需移动栈指针，**分配/释放近乎零开销**；要求值在**编译期大小已知且定长**。依据: The Rust Programming Language 第 4.1 节「What is Ownership?」的「Stack and Heap」小节。
- **堆（Heap）**：分配器在堆中找一块空位、返回其指针，访问需经指针间接寻址、慢于栈；用于**运行期才知大小或大小可变**的数据。依据: 同上 第 4.1 节。
- **默认栈分配**：Rust 中所有值**默认在栈上**；需要堆数据时，通过 `Box`/`Vec` 等智能指针在栈上保留一个定长的「指针」，真实数据放堆。依据: Rust By Example「Box, Stack and Heap」。
- **为何栈要求编译期定长**：编译器要生成「把栈指针移动一个固定字节偏移」的机器指令来构造函数栈帧，大小未知就无法生成静态帧布局——这正是堆存在的原因。依据: Hacker News 讨论 + 多篇 Rust 内存管理资料共识（编译器栈帧布局机制）。
- **`Copy` trait 的定义**：`std::marker::Copy` 是一个**标记 trait（无方法）**，表示「该类型的值可以**仅靠按位复制字节**就得到一个安全、独立的副本」。依据: `std::marker::Copy` 官方文档（"Types whose values can be duplicated simply by copying bits"）。
- **Copy 的实现规则**：① `Copy` 是 `Clone` 的**子 trait**（`Copy: Clone`），Copy 类型的 `clone()` 实现只需 `*self`；② **不能手动 `impl Copy`**，只能 `#[derive(Copy, Clone)]`；③ 要求**所有字段都是 Copy**；④ **与 `Drop` 互斥**——实现了 `Drop`（或含实现了 `Drop` 的字段）的类型不能 Copy。依据: `std::marker::Copy` 官方文档 + StackOverflow「Why does Rust not allow the copy and drop traits on one type?」。
- **为何 String/Vec/Box 非 Copy**：它们拥有堆 buffer，按位复制会得到两个指向**同一块堆**的指针 → 各自离场时都跑析构 → **double-free**。故编译器禁止它们 Copy，只能 move 或显式 clone。依据: 100 Exercises To Learn Rust「Copy trait」（String 管理额外堆资源）+ 官方 Copy 文档（"Any type implementing Drop can't be Copy"）。
- **哪些类型是 Copy**：所有数值原语（`i32`/`u8`/`f64`/`bool`/`char` 等）；**元素全部为 Copy 的元组与数组**（如 `(i32, bool)` 是 Copy，`(i32, String)` 不是）；**共享引用 `&T`**（复制一个指针天然安全）。可变引用 `&mut T` **不**是 Copy（须 move 以保证唯一性）。依据: StackOverflow「Do all primitive types implement the Copy trait?」+ 官方 Rust Reference。
- **Copy vs Clone 的语义对照**：
  - Copy：**隐式**（赋值/按值传参/返回时自动触发）、机制是 **bitwise memcpy**、总是廉价、源仍可用。
  - Clone：**显式**（必须写 `.clone()`）、`fn clone(&self) -> Self` 可跑**任意代码**（堆分配、深拷贝）、可能昂贵。
  依据: `std::clone::Clone` 官方文档 + StackOverflow「What is the difference between Copy and Clone?」。
- **move 的字节本质**：一次 move 在字节层面就是「**shallow bitwise copy + 编译器把旧绑定标记为失效的静态检查**」。所以 move 与 copy 在内存操作上是**同一种按位复制**，区别仅在编译器是否允许旧名继续使用。依据: users.rust-lang.org「How `move` works in Rust」+ HashRust「Moves, copies and clones in Rust」。

## 关键流程

赋值 / 按值传参 / 返回值 的统一裁决流程：

```
表达式: let b = a  (或按值传参/返回)
   │
   ▼
编译器查 a 的类型是否 impl Copy ?
   │
   ├─ 是 ──▶ bitwise 复制字节 ──▶ a、b 均可用        (Copy)
   │
   └─ 否 ──▶ bitwise 复制字节 + a 标记 moved        (move)
                 ▼
        若程序员写 a.clone() ──▶ 执行 clone() 任意代码 ──▶ 产出独立深拷贝 (Clone)
```

- Copy 路径：零运行时开销，无分配器介入。依据: `std::marker::Copy` 文档 + Rust By Example「Ownership and Moves」。
- move 路径：字节照抄、旧名失效，保证堆资源单一所有者。依据: users.rust-lang.org「move = shallow copy + static check」。
- Clone 路径：可触发堆分配，是「我确实要两份」的显式逃生口。依据: `std::clone::Clone` 文档。
- 函数返回：返回 Copy 类型按值复制回调用方栈帧；返回非 Copy 类型把堆所有权移交调用方（同一裁决流程的「返回」分支）。依据: The Rust Programming Language 第 4.1 节。

## 易混淆 / 边界 / 推断

- **易混淆①（重点）**：「move 会把字节搬走、源变空」是常见误解。事实是 move 在字节层面就是复制，字节还在原地，只是旧**名字**被编译器吊销（再用就编译错误）。这是 move 与 copy 唯一的实质区别。依据: HashRust「Moves, copies and clones」+ users.rust-lang.org 讨论。
- **易混淆②**：「`&T` 是 Copy 但 `&mut T` 不是」。共享引用复制 = 多个只读指针，安全；可变引用必须 move，否则出现两个可变别名，违反借用规则。依据: 官方 Rust Reference + 借用规则（深层原因留给借用章）。**推断**：这条是本章与下一组借用章的天然接缝，本章点到即可。
- **边界（重要反直觉）**：Copy **不等于「便宜」**。例如 `[u8; 1_000_000]` 是 Copy，但每次 `let b = a` 都按位复制 1MB，可能比让大结构 move 还贵。所以「大结构是否 derive Copy」需谨慎，社区共识是**默认不 derive Copy**，除非确实需要到处自动复制。依据: reddit r/rust「When NOT to derive Copy?」社区共识。**推断**：是否 derive Copy 是一个有性能语义的 API 设计决策，不只是便利性问题。
- **边界**：实现了 Copy 的类型仍可被 `.clone()`（因 `Copy: Clone`），其 `clone()` 等价于 `*self`。依据: `std::marker::Copy` 官方文档。
- **推断（标注为推断）**：C++ 的 move（移动构造/赋值）会真正转移资源指针并把源置空，而 Rust 的 move 不执行任何用户代码、只是字节复制 + 旧名失效——两者同名但机制不同。本 Atlas 读者多来自 JS，可能不会踩这个坑，但若提及 C++ 对比需小心。依据: C++ to Rust Phrasebook（Brown）对照说明。
- **未理解 / 待查证**：`T: Copy` 泛型 bound 下编译器是否做额外优化（如消除冗余按位拷贝、直接在目标位置构造）属后端优化层细节，本章不展开，留待 trait/泛型章或专门优化讨论。
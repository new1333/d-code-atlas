# 无畏并发：Send/Sync 与编译期线程安全 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：在 JS 这类单线程事件循环语言里，「数据竞争」几乎不存在——你顶多担心回调间的逻辑时序；但一旦要在多线程下真正并行地读写同一份数据，绝大多数语言要么靠程序员「自觉加锁」（C/C++/Java，错了就 race，甚至诡异崩溃），要么靠运行时大锁（解释器 GIL）换安全换性能。Rust 的使用者想要的是：**既享受多核真并行，又绝不担心数据竞争**，而且不想为这层安全付任何运行时税。

- **一句话核心思想**：用两个**不含任何方法、运行期完全不可见**的 marker trait（`Send`/`Sync`）给类型「盖章」，让编译器在编译期就能证明「这个值跨线程移动/共享不会引发数据竞争」——这是把借用检查器那一套「编译期别名分析」直接推广到「线程」这个维度。

- **设计动机（为什么需要它）**：数据竞争的根因，本质就是「**某线程正在写、另一线程同时在读写同一块内存，且无同步**」。而 Rust 的借用规则（别名 XOR 可变）恰好管的就是「谁能在什么时刻读写一块内存」——只要能把这条规则从「单线程内的引用」延伸到「跨线程的引用」，数据竞争在编译期就自灭了。`Send`/`Sync` 就是这道延伸的「类型层闸门」。
  - **（承前去重）**：『把运行时安全检查前移成编译期证明』这个大模式，**已在第 3 章『借用与引用：编译期的别名分析』和第 4 章『生命周期』讲透**——本章只看它的新侧面：把同一条「别名 XOR 可变」规则**从单线程推广到跨线程维度**，并给出一个可机械判定的类型级判据（marker trait）。Writer 切勿在本章重讲「编译期证明为何比 GC/RC 强」这套上位论述。
  - **（承前去重）**：『把借用检查从编译期推迟到运行期（内部可变性）』，**已在第 12 章『智能指针与内部可变性』讲透**——本章只看它的新侧面：运行期检查**是否带同步**，直接决定了类型是 `!Sync`（`Cell`/`RefCell`，无锁）还是 `Sync`（`Mutex`/`RwLock`，带锁）。也就是说，线程安全属性 = 内部可变性 + 同步策略，本章只补「+ 同步策略」这半边。

- **关键权衡（本 Atlas 的核心，共 4 条）**：
  1. 选择「用 marker trait 在编译期证明线程安全、运行期零相关检查」→ 换来「safe Rust 在类型层就**不可能**写出数据竞争（无畏并发）」→ 代价「`Send`/`Sync` 约束像病毒一样向所有跨线程 API 传播，且与 `'static` 紧耦合；最常见的实战痛是把 `Rc` 误用到多线程后被强制改写成 `Arc`，初学者要重建一整套『这个值能不能跨线程』的类型直觉」。
  2. 选择「`Send`/`Sync` 按**字段结构自动派生**（auto trait，默认 opt-in、可 opt-out）」→ 换来「用户自定义的普通组合类型几乎**零样板**就拿到线程安全属性」→ 代价「该属性是隐式的、不写在源码里、难以肉眼审计；当自动派生结论恰好是错的（如裸指针、FFI 句柄），程序员必须用 `unsafe impl` 接过一个人工证明义务——这正是后续 unsafe 章的入口」。
  3. 选择「把 `Sync` 定义为 `&T: Send` 的对偶（**共享一个引用 == 发送一个引用**）」→ 换来「两个看似独立的概念被归约成同一个『移动』语义，整套线程安全体系**复用所有权章的 move 直觉**」→ 代价「两条轴（move 一份所有权 vs 共享一个只读引用）在初学时极易混淆，尤以『`Cell` 是 `Send` 但 `!Sync`』这种『能搬过去却不能共享看』的反直觉组合为甚」。
  4. 选择「标准库默认**偏向线程安全**：`thread::spawn` 索要 `Send + 'static`、跨线程引用计数默认推 `Arc`」→ 换来「多线程代码天然安全，单线程要享受零同步开销必须**主动 opt-out**（显式选 `Rc`/`RefCell`）」→ 代价「这与大多数语言『默认单线程、想并发再自己加锁』的默认值正好相反，单线程场景下新手常被『为什么 `Rc` 不能跨线程』卡住，误以为是 Rust 在刁难」。

- **最小心智模型（7 步）**：
  1. 一个值要么想**搬到别的线程**（move 所有权），要么想**被多个线程同时持有引用**（share `&T`）。
  2. 编译器据此问两个问题：它 `Send` 吗？它 `Sync` 吗？（`T: Sync` ⟺ `&T: Send`，二者是一枚硬币的两面）。
  3. 这两个 trait 是**结构性**的：编译器自动展开类型的全部字段，**所有字段都满足才满足**（这是 auto trait）。
  4. 某些类型**主动 opt-out**（声明 `!Send` / `!Sync`），如实告诉编译器「我有线程不安全的内部状态」。
  5. `thread::spawn`、`Arc`、channel 的 send 等 API 在签名上挂 `T: Send + 'static`（或 `T: Sync`）这道**类型闸门**。
  6. 不满足 → **编译失败**，根本不会进入运行期；满足 → 生成跨线程移动的机器码。
  7. 运行期**没有任何**「检查这个值是不是 Send」的代码——盖章是纯类型层行为，故称「零成本」。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个**小到只表达「编译期盖章、运行期无感」这一核心思想**的从零实现——用「幽灵标记（phantom brand）+ 泛型约束」模拟 marker trait，展示「盖章只活在类型里」「结构派生」「opt-out 即可拒发签证」三件事。
    - 具体：① 定义一个零运行时占用的 `Send` 标记类型；② 写一个 `spawn<T extends Send>` 泛型闸门函数；③ 展示普通对象/原始值「自动」满足（结构派生）；④ 定义一个故意不盖章的 `Rc` 类型，展示「把它传进 `spawn` 会触发**编译期**报错，但运行期 `Rc` 和普通对象毫无区别」。每一行都要对应上面某个原理点（盖章无运行时开销 / 结构派生 / opt-out）。
  - **应故意省略**：真正的 OS 线程创建、真实的借用检查器内核、`Sync` 的对偶在编译器里如何与借用规则耦合、`Arc`/`Mutex` 的原子操作实现、negative impl 的稳定化语法细节。**不追求工程完整，只追求演透「安全证明住在类型层」这一个原理。**
  - **演示载体建议**：**首选 TypeScript**。理由：marker trait「无方法、无运行时、靠类型约束生效」这一本质，可被 TS 的「branded type（幽灵品牌）+ `T extends Send` 泛型约束 + 条件类型做结构派生」干净映射；读者能在熟悉的语法里直观看到「为什么类型不匹配就根本编不过、而运行期完全不知道这件事」。仅当要展示 `Arc`/`Mutex` 的真实原子语义时，TS 讲不透，才退回 Rust——但那属于「不宜展开细节」，不进演示。

- **正文不宜展开的细节（供 Writer 裁剪）**：
  - negative implementation（`impl !Send`）的精确语法与稳定化历史（目前仍基本是标准库专属）。
  - `UnsafeCell` 作为「所有内部可变性的编译器认知唯一合法入口」的底层角色。
  - 内存序（`Ordering::SeqCst`/`Acquire`/`Release`）与原子操作本身——属于「原子与锁」的专著话题。
  - `MutexGuard` 的 `Deref`/`Drop` 即自动解锁的 RAII 细节。
  - 各 `Arc<T>`/`Mutex<T>` 对内部 `T` 的精确 trait bound 矩阵（放事实库即可，不进正文推导）。
  - 真正的 OS 线程模型、`park`/`unpark`、与 async 的关系（留给下一章）。

- **推荐的一个执行轨迹例子**：
  - **输入**：一段把局部变量 `Rc<RefCell<i32>>` 通过闭包 `move` 进 `thread::spawn` 的代码。
  - **关键中间态**：编译器展开闭包捕获 → 命中 `Rc` 字段 → 查得 `Rc: !Send`（因非原子引用计数）→ 闭包类型自动派生失败 → 整个闭包 `!Send`，不满足 `spawn` 的 `F: Send + 'static` 闸。
  - **输出**：**编译期错误**，指向「闭包捕获了 `Rc`」这一行；程序员把 `Rc`→`Arc`、`RefCell`→`Mutex` 后重编通过，运行期无任何额外检查。这条轨迹演透「错误发生在类型层、且自动派生沿字段传染」的核心思想。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`Send` 的定义**：类型 `T` 满足 `Send`，当且仅当「把 `T` 的所有权移动到另一个线程」是安全的（不会引发数据竞争或内存不安全）。`依据: The Rustonomicon「Send and Sync」章节`。
- **`Sync` 的定义**：类型 `T` 满足 `Sync`，当且仅当「多个线程同时持有 `&T`」是安全的。形式化地对偶：`T: Sync ⟺ &T: Send`。`依据: The Rustonomicon「Send and Sync」；The Rust Book 第 16 章「Extensible Concurrency with and Send and Sync」`。
- **marker trait / auto trait 的本质**：`Send`/`Sync` 是**无方法的标记 trait**，运行期完全不出现；编译器对一个组合类型**自动派生**它们——「当且仅当其全部字段都 `Send`/`Sync` 时，该类型才 `Send`/`Sync`」。`依据: The Rustonomicon「Send and Sync」；auto trait（旧称 OIBIT）机制说明`。
- **opt-out 与 negative impl**：因为 auto trait 默认派生，类型可以用 `impl !Send`/`impl !Sync` **主动声明不实现**，告诉编译器「即使我字段都满足，我也不线程安全」。该机制目前主要供标准库使用。`依据: Rust Reference「Auto and unsafe traits」；Rust RFC 相关条目`。
- **`Rc<T>` 为何 `!Send` 且 `!Sync`**：引用计数是非原子整数；跨线程 `clone`/`drop` 会并发改同一计数器 → 数据竞争（use-after-free / double-free）。即便内部 `T: Send`，问题也在计数本身。`依据: The Rustonomicon；标准库 `Rc` 文档`。
- **`Cell<T>` / `RefCell<T>` 为何 `Send` 但 `!Sync`**：二者提供**无锁的内部可变性**——允许通过 `&T` 改值（`Cell::set`）或改借用计数（`RefCell` 的 `isize` 计数）。多线程共享 `&Cell`/`&RefCell` 即数据竞争；但**独占所有权下搬到另一线程**是安全的（搬过去后无人争用），故 `Send`。`依据: The Rustonomicon；第 12 章对应的内部可变性原理`。
- **`Arc<T>` / `Mutex<T>` 为何是线程安全的对偶解**：`Arc` 用**原子引用计数**换 `Send + Sync`（要求 `T: Send + Sync`）；`Mutex<T>`/`RwLock<T>` 用**带同步的内部可变性**换 `Sync`（`Mutex<T>: Sync` 当 `T: Send`）。这正是第 12 章「运行时逃生舱」在线程维度的正确形态。`依据: 标准库 `Arc`/`Mutex` 文档；The Rust Book 第 16 章`。
- **`thread::spawn` 的签名约束**：`pub fn spawn<F, T>(f: F) -> JoinHandle<T> where F: FnOnce() -> T + Send + 'static, T: Send + 'static`。
  - `Send`：闭包（及其捕获的全部值）要被**移动到另一个 OS 线程**，必须可跨线程移动。
  - `'static`：被 spawn 的线程**可能比父线程/父函数活得久**，故闭包不得借用任何比 `'static` 短的引用。注意 `'static` 在此不是「值要活到程序结束」，而是「**它持有的引用没有比整个程序更短的寿命**」——拥有（`move`）数据即天然满足。`依据: Rust Atomics and Locks 第 1 章「Basics of Rust Concurrency」；users.rust-lang.org 相关讨论；承接第 4 章生命周期`。
- **「无畏并发」的精确含义**：在 **safe Rust** 范围内，**不可能**写出引发数据竞争的代码——这是 marker trait + 自动派生 + negative impl + 跨线程 API 签名约束四方合力给出的编译期保证，而非运行时检查。`依据: The Rust Book 第 16 章开篇「Fearless Concurrency」`。

## 关键流程

**流程 A：编译器审查一次 `thread::spawn` 调用（演示「类型层闸门 + 结构派生」）**
```
用户: spawn(move || { use(rc_clone); })
  ↓
编译器推断闭包类型 F，逐一检查 F 捕获的每个值
  ↓
对每个捕获值查 Send（结构派生：展开其字段）
  ↓
命中 rc_clone: Rc<…> → Rc: !Send（negative impl）→ 派生失败
  ↓
F: !Send → 不满足 spawn 的 F: Send + 'static 闸 → 编译失败，错误指向捕获 Rc 的那一行
```
`依据: The Rustonomicon「Send and Sync」；Rust 编译器错误诊断行为`

**流程 B：跨线程共享可变状态的「正确拼装」（演示 Arc+Mutex 如何同时满足 Send 与 Sync）**
```
要被多线程读写的值 v: T
  ↓
包成 Arc<Mutex<T>>
  - Arc：原子引用计数 → 让「多线程各持一份句柄」安全（Send + Sync，需 T: Send+Sync）
  - Mutex：带锁的内部可变性 → 让「&Mutex 可被多线程共享」安全（Sync，需 T: Send）
  ↓
各线程 .clone() Arc（原子 +1）→ .lock() 拿到 MutexGuard（运行期借用，第 12 章逃生舱的同步版）
  ↓
guard 离开作用域 → 自动 unlock（RAII），无需手动释放
```
`依据: 标准库 Arc/Mutex 文档；承接第 12 章 RefCell 的「无锁版」对照`

**流程 C：两种并发范式的取舍（channel vs Mutex，承接本章核心抉择）**
```
数据是「在线程间流动」（流水线）→ 用 channel：所有权随消息转移，天然无共享可变状态
数据是「被线程持续共享访问」（计数器/缓存）→ 用 Arc<Mutex<T>>：共享可变状态 + 编译期保证加锁纪律
（二者底层都建立在共享内存 + 同步原语之上；channel 通常有更高开销）
```
`依据: Go Blog「Share Memory By Communicating」；UPenn CIS 1905 Lecture 09；users.rust-lang.org「Channels vs shared memory」讨论`

## 易混淆 / 边界 / 推断

- **事实**：`Sync` **不是**「线程安全」的笼统说法，而是特指「`&T` 可被多线程同时持有」。`Mutex<T>: Sync` 但仍要求 `T: Send`——因为加锁保护的目的是让线程能**独占地**取出/修改值，值本身必须能跨线程移动。`依据: 标准库 Mutex 文档的 trait bound`
- **事实**：`Cell<T>` 是 `Send` 但 `!Sync`——「能搬过去，但不能共享看」，这是初学者最反直觉的组合，常被误读为「`!Sync` 就一定 `!Send`」。`依据: 标准库 Cell 文档`
- **事实**：`&T: Send ⟺ T: Sync` 是 `Sync` 的**定义**，不是推论；把这两个概念归约成「移动」一个语义，是 Rust 类型设计的精巧之处。`依据: The Rustonomicon`
- **易误读（承接第 4 章生命周期）**：`thread::spawn` 里的 `'static` **不**表示「这个值要活到程序结束」，而表示「它不借用任何比 `'static` 短的引用」。一个 `move` 进闭包的拥有值天然满足 `'static`，哪怕它几毫秒后就 drop。这是生命周期概念在并发场景下的复用，最容易被字面误解。`依据: Rust Atomics and Locks 第 1 章；users.rust-lang.org`
- **推断（标注为推断，承接后续 unsafe 章）**：因为 auto trait 按字段结构派生，只要一个组合类型里**混入**一个裸指针字段（`*const T` / `*mut T`），整个类型就自动 `!Send`/`!Sync`（裸指针本身非 `Send`/`Sync`）。这正是真实代码里大量需要 `unsafe impl Send/Sync` 的根因——程序员要凭人工证据保证「这个跨线程使用确实安全」。`依据: The Rustonomicon；推断自 auto trait 派生规则`
- **边界（待查证）**：negative implementation（`impl !Send for …`）的稳定化进度——截至目前主要仍限标准库内部使用，第三方手动 opt-out 的能力受限。具体可用语法版本边界建议 Writer 写作时再核对最新 Reference。`依据: Rust Reference「Auto and unsafe traits」（待查证具体稳定版本）`
- **对照 JS（贯穿全书的对照点）**：JS 的单线程事件循环让「数据竞争」几乎天然不存在，代价是真并行必须靠 Worker/进程且数据靠拷贝/`Transferable`；Rust 反过来——允许真共享内存并行，但用类型层证明消灭竞争。这是两种根本不同的并发安全范式，值得在正文做一次显式对照（承接第 1 章设计哲学）。
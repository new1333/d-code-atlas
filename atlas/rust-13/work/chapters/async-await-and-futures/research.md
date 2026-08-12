# 异步模型：Future、poll 与可选运行时 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：前端工程师带着 JS 的 `async/await` 直觉来写 Rust，会接连撞墙——调用一个 `async fn` 后「什么都没发生」（必须 `.await` 或 `spawn` 才跑）；跨 `.await` 持有变量时借用检查器和 `Pin` 开始作怪；标准库里**根本没有**事件循环，必须自己挑一个运行时（Tokio）并给 `main` 套上宏；甚至 Future「没等到结果就被丢弃」就等于被「取消」。这些挫折的根源是同一个：Rust 没有 GC、没有内置运行时，又要做到零成本异步，于是把 JS 里由「运行时 + 事件循环」隐藏的调度细节，全部显式化成了 Future + poll + executor 的契约。

- **一句话核心思想**：`async` 函数**不被「执行」**，而是被编译成一个**可以被反复 `poll` 推进的状态机**（实现 `Future` trait）；它何时跑、在哪里跑、由谁调度，全部交给**外部的、可替换的运行时**决定，语言本身不内置运行时。

- **设计动机（为什么需要它）**：为了同时拿到「零成本抽象」和「不绑定任何运行时」，Rust 不能像 JS 那样把事件循环/调度器烧进语言，只能把异步计算抽象成一个纯 trait（`Future`），让 `async/await` 在**编译期**把它降到状态机，把「谁来驱动它」留给生态。它换来了对堆分配、调度策略、IO 模型的极致控制力（从 `no_std` 嵌入式到高并发服务器通吃同一套抽象）。其中承前关系请 Writer 做跨章去重：
  - `Future` 本身是一个 trait，`async fn foo() -> T` 就是 `fn foo() -> impl Future<Output = T>`——**（已在第 7 章『Trait 与泛型：编译期单态化的静态多态』讲透 trait 契约与 `impl Trait` 机制，本章只看 `Future` 作为异步计算抽象的新侧面：一个表示「尚未完成的计算」的 trait）**。
  - 异步任务要被多线程运行时调度，必须满足 `Future: Send`——**（已在第 14 章『无畏并发：Send/Sync 与编译期线程安全』讲透 Send/Sync 的编译期证明，本章只看「`Future: Send` 如何把线程安全约束接到异步 task 跨线程调度上」这个新侧面）**。

- **关键权衡（机制丰富章，4 条三段式）**：
  1. **「把运行时拆成可选组件」→ 换来了对堆分配/调度/IO 模型的极致控制（嵌入式 `no_std` 到服务器通吃同一套 trait）→ 代价是生态运行时分裂、新人必须自己理解「运行时」概念并选型（Tokio 成为事实标准），`fn main` 还得套运行时宏。**
  2. **「Future 设计成惰性、由 executor 主动 `poll` 拉进（pull 模型）」→ 换来了零成本（无堆分配、无语言运行时开销）+ 取消即 `drop` 的优雅语义 + executor 可批量调度 → 代价是与 JS Promise「创建即跑」的直觉完全相反（不 `await`/`spawn` 就什么都不发生）、必须引入 `Waker` 机制避免忙轮询、生成的状态机是自引用的而必须 `Pin`。**
  3. **「`async fn` 跨 `.await` 借用自身局部变量 → 编译成自引用状态机」→ 换来了零拷贝、零堆分配的状态保存（直接把跨挂起点的值存在状态机字段里）→ 代价是必须用 `Pin` 禁止该状态机被移动（否则内部自引用指针失效导致 UB），`Pin`/`Unpin` 因此成为异步里最难啃的概念之一。**
  4. **「取消 = 直接 `drop` 掉 Future（每个 `.await` 挂起点都可能是被 drop 而非 resume）」→ 换来了零成本取消（无需取消令牌、嵌套 Future 自动传播取消）→ 代价是 cancel-safety 成为开发者的手动负担（Mutex 可能仍持锁、缓冲区可能半写、租约可能未续期），且目前还没有 `AsyncDrop` 来做异步清理。**

- **最小心智模型（7 步）**：
  1. 写 `async fn foo() -> T` —— 编译器不为它生成「可直接执行的函数体」，而是生成一个**匿名状态机类型**，该类型实现 `Future`（每个 `.await` 是一个状态/挂起点）。
  2. 调用 `foo(args)` —— 只是**构造状态机的初始实例**，什么也不执行（惰性）。
  3. 把它交给 executor（`spawn` 或 `block_on`）—— executor 开始**持有**这个 task。
  4. executor 调用 `Future::poll` —— 状态机从初始状态推进，直到撞上一个挂起点（内部某个子 Future 的 `poll` 返回 `Pending`）。
  5. 返回 `Pending` 前，把 `poll` 收到的 `Waker` 注册到「正在等待的资源」上（如 IO 事件源）。
  6. 资源就绪时触发 `waker.wake()` —— 通知 executor 把这个 task **重新入队**。
  7. executor 再次 `poll` —— 状态机从状态判别字段指向的挂起点**恢复执行**；循环直到 `Poll::Ready`，task 完成被移除。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示（两个最小实验，演透原理）**：
    - 实验 A「手写状态机 + 自驱动」：不引入任何运行时，手写一个实现 `Future` 的最小 `enum`（状态0/1/2），用一个裸 `loop { match poll() { Ready => break, _ => {} } }` 自己驱动它——演透「`poll` 就是状态机推进 + `Poll::Pending`/`Poll::Ready`」。再用一个极简 executor（一个 `Vec<Task>` + `while` 循环 + 手动调 `wake`）演透「executor 持有 + 调度 + waker 回调」。
    - 实验 B「脱糖等价物」：把一段 `async fn`（含两个 `.await`）「等价手写」成一个带判别字段的 `enum` + `poll`，让读者亲眼看到「编译器生成的就是这个」，破除 `async` 的魔法感。
  - **应故意省略**：真实 OS IO（epoll/kqueue/mio）、io_uring、多线程工作窃取调度器、Tokio 集成、`pin_project`/pin 投影的 `unsafe` 细节、`Future: Send` 的完整推导、`select!`/`join!` 宏内部。
  - **演示载体建议**：**首选 TS/JS** 演实验 A 的**控制流骨架**——把 Future 抽象成 `{ poll(waker): 'pending' | { ready: T } }` 的对象、executor 是一个轮询数组，能演透「惰性 + poll 驱动 + waker 回调」的核心思想（这是读者最易迁移 JS 直觉的部分）。但「自引用为什么需要 `Pin`」「取消 = `drop`」属于 **Rust 语义特有**（TS 有 GC、对象可随意移动、无 drop 语义），这两点**必须退回 Rust 小片段**讲（最小 `async fn` + 跨 await 借用 + 提前 drop 的例子）。即：**控制流用 TS，内存/取消语义用 Rust 小片段**。

- **正文不宜展开的细节**：epoll/kqueue/io_uring 的 reactor 内部；Tokio 工作窃取调度器、cooperative scheduling 的 `.await` 让出语义；AFIT / RPITIT（异步 trait 方法）；`async-stream`、gen blocks；`Pin` 的完整类型代数（`Pin<Box<T>>` vs `Pin<&mut T>`、所有 `Unpin` impl、pin projection 的 soundness 规则）；`select!`/`join!` 宏实现；`AsyncDrop` 的设计争论。这些供 Critic 抽查、Writer 据此裁剪。

- **推荐的一个执行轨迹例子**：
  - 输入：`async fn fetch_user(id) { let row = query_db(id).await; format(row) }`，其中 `query_db` 先返回 `Pending`（数据库还没返回）再返回 `Ready`。
  - 关键中间态：
    1. 调用 `fetch_user(id)` → 构造状态机实例（State0，惰性，未跑）。
    2. executor 第一次 `poll` → 跑到 `query_db(id).await` → `poll` 内部子 Future → 返回 `Pending` + 把 `waker` 注册到「DB 就绪事件」→ 外层 `poll` 也返回 `Pending`，状态机停在 State1。
    3. DB 就绪 → `wake()` → executor 把该 task 重新入队。
    4. executor 第二次 `poll` → 从 State1 恢复 → `query_db` 返回 `Ready(row)` → 执行 `format(row)` → 外层返回 `Ready`。
  - 输出：`Ready(format(row))`，task 完成、被 executor 移除。该轨迹演的是「核心思想（poll 推进状态机 + waker 驱动恢复）」，不是全量调度。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **`Future` trait 的定义**：标准库里 `Future` 只有一个关联类型 `Output` 和一个方法 `poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>`；`Poll<T>` 是枚举 `Pending | Ready(T)`。这是整个异步模型的契约起点。依据: Rust 标准库 `std::future::Future` 官方文档。
- **`async fn` 的脱糖**：`async fn foo(args) -> T` 在语义上等价于 `fn foo(args) -> impl Future<Output = T>`——调用它返回的是一个**实现了 `Future` 的匿名类型**，而非「开始执行的函数」。依据: 《The Rust Programming Language》官方书第 17 章「Futures and the Async Syntax」；Rust 官方 Async Book「async/.await Primer」。
- **状态机变换**：编译器把 `async fn` 的函数体编译成一个 enum-like 的匿名结构体，每个 `.await` 点对应一个状态/挂起点；`poll` 内部用一个判别字段（discriminant）决定从哪个状态恢复执行，把跨挂起点的局部变量存为结构体字段。依据: Tyler Mandry《How Rust Optimizes async/await I》；EventHelix《Understanding Async Await in Rust: From State Machines…》。
- **惰性是 `Future` 的本质属性**：`Future` 在被 `poll` 之前什么都不做；`async fn` 调用只构造状态机实例，必须 `.await` 或交给 executor（`spawn`/`block_on`）才会执行。这一点**与 JS Promise「创建即执行」根本不同**。依据: Rust 官方 Async Book「The Future Trait」；users.rust-lang.org「Rust vs JS async/await」。
- **`Pin` 的必要性**：`async fn` 生成的状态机常常跨 `.await` 持有对自身字段的借用（例如先借用一个局部 String，跨 await 后还在用），形成**自引用**结构；若该结构被移动，内部自引用指针仍指向旧地址 → 未定义行为。`Pin<P>` 通过类型系统保证「被 pin 后的值不能再被移动」，所以 `poll` 接收的是 `Pin<&mut Self>` 而非 `&mut Self`。`Unpin` 是一个 marker trait，大多数默认可移动类型自动实现 `Unpin`，只有自引用状态机等不是 `Unpin`。依据: without.boats《Pin》（`Pin` 的作者的设计说明）；Cloudflare《Pin & Unpin in Rust》。
- **`Waker` 机制（避免忙轮询）**：`poll` 返回 `Pending` 时必须把传入的 `Context` 里的 `Waker` 存到「等待的资源」上；当资源就绪（如 IO 可读）时调用 `wake()`，通知 executor 重新调度该 task。没有 `Waker`，executor 就只能不断轮询每个 Future（busy polling），浪费 CPU。依据: Rust 官方 Async Book「The Future Trait」「Futures and Tasks」。
- **可选运行时（语言只定义 trait，不内置运行时）**：Rust 语言和 `std` 只提供 `Future` trait、`async/await` 语法、`Context`/`Waker`；**executor（负责调度/轮询 task）和 reactor（负责监听 IO/定时器事件并唤醒 task）都留给外部 crate**。一个「runtime」通常 = reactor + 一个或多个 executor + 工具库。Tokio 是事实标准（内含基于 mio 的 IO reactor + 多线程工作窃取 executor + fs/net/time 模块）；async-std、smol、embassy（嵌入式）等是替代。依据: Rust 官方 Async Book「The Async Ecosystem」；corrode.dev《The State of Async: Runtimes》。
- **零成本性**：`async fn` 编译成状态机后，**没有堆分配、没有 vtable、没有语言内置的运行时**——状态机的状态字段直接存在栈/调用者提供的存储里；只有把 Future 放进 `Box`（如 `dyn Future` 或 `spawn` 需要 `Box<dyn Future + Send>`）时才产生堆分配，且这是使用者显式选择。依据: Swatinem《Rust async can truly be zero-cost》。
- **取消 = `drop`**：在 Rust 里，取消一个 Future 的唯一方式就是**停止 poll 它并把它 drop 掉**；由于每个 `.await` 都是挂起点，Future 可能在任意挂起点被 drop。drop 会递归地丢弃所有嵌套的子 Future（取消自动传播）。目前**没有 `AsyncDrop`**，意味着需要异步清理的资源（如发 TCP FIN）无法在 drop 时完成，cancel-safety 须由开发者保证。依据: Eric Holk《Cancellation and Async State Machines》；Oxide RFD 400《Dealing with cancel safety in async Rust》；Yosh Wuyts《Async Cancellation I》。

## 关键流程

`async fn` 定义 →（编译器编译期脱糖）→ 实现 `Future` 的匿名状态机类型
→（调用 `foo()`）→ 构造状态机初始实例（惰性，未执行）
→（`executor.spawn()` / `block_on()`）→ executor 持有该 task
→（executor 调 `Future::poll`）→ 状态机推进，直到挂起点
→（内部子 Future 返回 `Pending` + 注册 `Waker`）→ 外层 `poll` 返回 `Pending`
→（资源就绪 → `waker.wake()`）→ executor 把 task 重新入队
→（executor 再次 `poll`）→ 状态机从挂起点恢复执行
→ … 循环 … → `Poll::Ready(T)` → task 完成、被 executor 移除
依据: 综合 Rust 官方 Async Book「The Future Trait」「Futures and Tasks」两节 + Tyler Mandry《How Rust Optimizes async/await I》的状态机变换描述。

## 易混淆 / 边界 / 推断

- **事实**：Rust 没有把任何运行时烧进语言；`std` 只提供 `Future` trait + `async/await` 语法 + `Context`/`Waker`。没有任何「自动的事件循环」。依据: Rust 官方 Async Book「The Async Ecosystem」。
- **易混淆 1（最大语义鸿沟）**：JS 的 `async function` 一调用就**开始执行**（返回的是已在运行的 Promise）；Rust 的 `async fn` 调用只构造状态机，**不执行任何用户代码**。直接后果：JS 里写两个 `fetch()` 它们就并发了；Rust 里顺序写两个 `.await` 是**串行**，要并发必须显式用 `futures::join!(a, b)` 或 `tokio::spawn`。依据: Ted Kaminski《Async and Await: concurrent control flow》；users.rust-lang.org。
- **易混淆 2**：`poll` 不会在循环里忙等——只在 `wake()` 被触发后才重新 poll。把「poll」理解成「executor 主动问一句：现在能往前走吗」，回答「不能」就挂起、等被叫醒再问。依据: users.rust-lang.org「Dealing with Futures and Polling in Async Rust」。
- **易混淆 3**：`Pin` 不等于「永远不能动」——值在 **pin 之前**可以自由移动，pin 之后才禁止移动；安全契约从「被 pin 的那一刻」开始。依据: without.boats《Pin》；users.rust-lang.org「What happens when I move an object before pinning it?」。
- **推断（标注为推断）**：`Future: Send` 约束之所以让许多「跨 `.await` 持有非 `Send` 类型（如 `Rc`、`RefCell`）」的代码在多线程运行时下编译失败，本质是第 14 章 Send/Sync 的编译期证明**延伸到状态机字段**——状态机把跨挂起点的值存为字段，于是整个状态机 `Send` 当且仅当所有这些字段 `Send`。推断依据: 由状态机变换语义 + Send 的自动派生规则综合得出，建议 Writer 表述时标注为设计推论。
- **边界 / 待查证（设计争论中）**：`AsyncDrop` 尚未存在，资源需要异步清理（TCP FIN、分布式锁释放）目前无法在 drop 时完成，社区有 RFC 讨论；cancel-safety 的判定标准目前也没有编译期机制（不像 `RefUnwindSafe` 那样有 marker），完全靠人工推理。标注: 待查证/设计争论中，Writer 可点到为止、不要展开为定论。
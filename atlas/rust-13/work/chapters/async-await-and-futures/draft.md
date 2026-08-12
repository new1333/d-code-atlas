# 异步模型：Future、poll 与可选运行时

> 本章属于 composite 层。前置：无畏并发：Send/Sync 与编译期线程安全、Trait 与泛型：编译期单态化的静态多态。
> 学完你能：用一句话讲清 Rust 异步「为什么把运行时整个甩给生态、为什么 Future 是惰性、靠 executor 主动 poll 推进的」这两个关键设计，以及它们各自付出的代价。

## 1. 为什么需要它（设计动机）

上一章讲了 `Send`/`Sync` 怎么在编译期证明「多线程不会数据竞争」，把并发安全这事钉死在类型里。但它回答的是「**多线程怎么不冲突**」，没回答另一个更常见的问题：「**怎么在一个线程里同时等成千上万个 IO，而不为每个等待开一个 OS 线程**」。一个 Web 服务器同时挂着 1 万个连接，绝大多数都在等网络数据，CPU 几乎闲置——为每个连接开一个线程既浪费内存，又让操作系统在上下文切换上疲于奔命。异步并发，就是为这种「等得多、算得少」的场景生的。

带着 JS 的 `async/await` 直觉来写 Rust，会接连撞墙，而且撞得很懵：

- 你调用一个 `async fn`，**什么都没发生**。必须 `.await` 它，或 `spawn` 进运行时，函数体才会开始跑。
- 跨 `.await` 持有变量时，借用检查器开始跟你较劲，一个叫 `Pin` 的东西冒出来挡路。
- 你想找「事件循环」——**标准库里根本没有**。你得自己挑一个运行时（通常是 Tokio），给 `fn main` 套上 `#[tokio::main]` 宏。
- 你「没等到结果就把 Future 扔了」，它就**被取消了**，而且可能是在持有锁、写到一半缓冲区的尴尬时刻被取消。

这些墙不是 Rust 故意刁难人。它们有同一个根：Rust 没有 GC、没有内置运行时，又想把异步做成零成本。JS 里由「运行时 + 事件循环」替你隐藏的调度细节——计算什么时候跑、在哪里跑、等的东西好了怎么知道——Rust 没法藏，只能把它们显式化成 `Future` + `poll` + executor 的一组契约，摊在程序员面前。

这章要讲的就是：这套契约长什么样，以及为什么非得是这套、而不是 JS 那套。

## 2. 核心思想

一句话：**`async fn` 不被「执行」，而是被编译成一个可以被反复 `poll` 推进的状态机；它何时跑、在哪里跑、由谁调度，全部交给外部的、可替换的运行时，语言本身不内置运行时。**

注意这里换了一个抽象层：上一节的矛盾是「JS 直觉在 Rust 撞墙」，这一句点透的是——异步计算在 Rust 里根本不是一个「会自己往前跑的东西」，而是一份**等待被推进的数据**。推进的时机和地点，是数据自己无权决定的。

## 3. 心智模型

### Future 是一个表示「尚未完成的计算」的 trait

整个异步模型的地基，是标准库里一个只有两个成员的 trait（trait 契约本身在第 7 章讲透了，这里只看它的异步新侧面）：

```rust
trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

enum Poll<T> { Pending, Ready(T) }
```

`poll` 的语义就一句话：**executor 主动问一句「你现在能往前走吗」**。答 `Ready(T)` 就是「走完了，结果是 T」；答 `Pending` 就是「走不动了，我先挂着，等会儿你再来问」。`self: Pin<&mut Self>` 里的 `Pin` 先放一边，第 4 节会专门讲它为什么必须在那。

### async fn 脱糖成一个状态机

JS 的 `async function` 一调用就**开始执行**，返回的是一个已经在跑的 Promise。Rust 的 `async fn` 调用只**构造一个状态机实例，什么用户代码都不跑**。这一条差别，是后面所有撞墙的源头。

把一段 `async fn`（含一个 `.await`）「等价手写」出来，就能看清编译器做了什么：

```ts
// 这段 async fn：
async function fetchUser(id) {
  const row = await queryDb(id)   // 挂起点 1：等数据库
  return format(row)
}

// 编译器把它变成（概念上）这样一个带判别字段的对象：
function fetchUser(id) {
  return {                        // 调用 fetchUser(id) 只是构造它，零执行
    state: 0,                     // 判别字段：0 → 1 → done，记住推进到哪了
    _row: undefined,              // 跨挂起点存活的数据 → 变成状态机字段
    _sub: undefined,              // 内部那个子 Future（queryDb 的结果）→ 也变成字段
    poll(waker) {                 /* 根据 state 决定从哪恢复执行 */ },
  }
}
```

每个 `.await` 就是一个**状态/挂起点**。`poll` 内部看 `state` 决定从哪恢复，把跨挂起点还要用的值（`_row`、`_sub`）存成字段。所谓「编译成状态机」，本质就是这件事。

### 惰性 + poll + Waker 的推进循环

把上面三件事拼起来，就是异步计算的完整生命周期：

1. 写 `async fn foo() -> T` → 编译器生成一个实现 `Future` 的匿名状态机类型。
2. 调用 `foo(args)` → **只构造状态机初始实例，什么都不跑**（惰性）。
3. 把它交给 executor（`spawn` 或 `block_on`）→ executor 开始持有这个 task。
4. executor 调一次 `Future::poll` → 状态机从初始状态推进，撞上某个挂起点（内部子 Future 的 `poll` 返回 `Pending`）。
5. 返回 `Pending` 之前，把 `poll` 收到的 `Waker` 注册到「正在等的东西」上（比如某个 IO 事件源）。
6. 资源就绪时，那个东西调 `waker.wake()` → 通知 executor 把这个 task 重新排队。
7. executor 再 `poll` 一次 → 状态机从 `state` 指向的挂起点**恢复**执行。如此循环，直到 `Poll::Ready`，task 完成被移除。

`Waker` 不是多余的装饰：没有它，executor 就只能不停轮询每个 Future「好了吗好了吗」（busy polling），白白烧 CPU。`Waker` 让 executor 可以安心去干别的，等资源真的就绪了，由资源主动来「叫醒」它。

> **跨章去重**：第 7 章已经讲透 trait 契约和 `impl Trait` 机制，这里不重演。本章只看 `Future` 作为「异步计算抽象」的新身份。另外，多线程运行时要在工作线程之间搬运 task，于是要求 `Future: Send`——`Send`/`Sync` 的编译期证明已在第 14 章讲透，本章只用一个推论：编译器把跨挂起点的值存成状态机字段，所以**整个状态机 `Send` 当且仅当这些字段都 `Send`**（这也解释了为什么在 `.await` 跨界持有 `Rc`、`RefCell` 这类非 `Send` 类型时，多线程运行时下会编译失败）。这条标注为设计推论，不是标准里的明文。

## 4. 关键权衡

### 把运行时整个甩给生态，换通吃嵌入式到服务器的同一套 trait

Rust 选择**不把任何运行时烧进语言**：`std` 只给 `Future` trait + `async/await` 语法 + `Context`/`Waker`，executor（调度/轮询 task）和 reactor（监听 IO/定时器并唤醒 task）都甩给外部 crate。一个「runtime」通常是 reactor + 一个或多个 executor + 一堆工具库，Tokio 只是事实标准。

换来的是对堆分配、调度策略、IO 模型的极致控制力：同一套 `Future` 抽象，在 `no_std` 嵌入式上配 Embassy（无堆、基于硬件中断），在高并发服务器上配 Tokio（基于 epoll/kqueue 的多线程工作窃取），都能跑。代价是**生态运行时分裂**——新人必须先理解「运行时」这个概念、再做选型（Tokio / async-std / smol / embassy），而且 `fn main` 还得套个运行时宏，第一个 hello world 就比 JS 啰嗦一截。

这条化解的本质矛盾，是「语言要给所有人提供异步抽象」和「不能替所有部署场景预设同一套运行时」之间的拉扯——既然预设哪套都会得罪另一拨人，就干脆只定 trait，把选择权下放。

### 用 pull（executor 主动 poll）取代 push（创建即跑）

JS 的 Promise 是 **push**：你 `new` 出来的一刻它就在跑了，结果好了主动推给你。Rust 的 Future 是 **pull**：它自己不动，得 executor 凑上来问「好了没」。打个比方点透就停：JS 像你下了单厨房立刻开火、做好了喊你号；Rust 像你拿到一张订单小票，啥也不发生，得你（executor）自己走过去问「好了吗」，没好厨师会让你留个号码（注册 `Waker`），好了按铃叫你（`wake`）。

换来的是零成本：Future 在被 poll 前不产生任何堆分配、不消耗任何调度开销；状态机的字段直接存在调用者给的存储里，不需要语言运行时兜底。它还顺带带来了**取消即 `drop` 的优雅语义**（见下一条），以及 executor 可以批量调度一批 task、自己决定优先级。代价是三重的：和 JS「创建即跑」直觉完全相反（不 `await`/`spawn` 啥都不发生，是新手第一堵墙）；必须引入 `Waker` 机制，否则只能忙轮询；以及生成出来的状态机是**自引用**的，不得不搬出 `Pin`（见下一条）。

本质矛盾是「要把异步计算做成零成本的数据」和「数据不主动跑就没法推进」之间的冲突——解法是把「推进时机」这件事外化给 executor，数据只负责「被问到时答一句」。

### 跨 `.await` 借用自己，直接把值存进状态机，代价是必须 Pin

为了零成本，编译器把 `async fn` 里跨挂起点还要用的局部变量，直接存成状态机结构体的字段，而不是拷一份或堆分配一份。问题在于，`async fn` 经常跨 `.await` **借用自身的局部变量**（比如先 `let buf = String::new()`，再 `read(&buf).await`，挂起期间 `&buf` 还活着）。这下状态机里就出现了一个字段，它存着指向**自己另一个字段**的引用——自引用结构。

自引用一旦被 `move` 到新内存地址，那个内部引用还指着旧地址，访问就是未定义行为。所以 `poll` 收的是 `Pin<&mut Self>` 而不是 `&mut Self`：`Pin` 在类型层保证「被 pin 之后不能再被移动」，自引用指针因此始终有效。再点一个比方就停：自引用像一个把自己的家庭地址写在自己门牌上的信箱——你把信箱整个搬走，门牌上的地址还指向旧址，信就寄丢了。

`Pin`/`Unpin` 因此成为异步里最难啃的概念之一。注意 `Pin` 不等于「永远不能动」：值在 pin 之前可以自由移动，安全契约从「被 pin 的那一刻」才开始。大多数类型（`String`、`Vec` 等）即使 pin 了也能安全移动，所以自动实现 `Unpin`；只有自引用状态机这类才不是 `Unpin`，才需要 `Pin` 真正约束。

本质矛盾是「要零成本保存跨挂起点的值」和「值里带了对自己的引用就不能再移动」之间的冲突——`Pin` 是用类型系统把「不能移动」这个不变式钉死的代价。

### 取消 = 直接 `drop`，每个 `.await` 都是潜在的取消点

在 Rust 里取消一个 Future 的唯一方式，就是**停止 poll 它，把它 drop 掉**。因为每个 `.await` 都是挂起点，Future 可能在任意挂起点被 drop；drop 会递归丢弃所有嵌套的子 Future（取消自动传播）。

换来的是零成本取消：不需要取消令牌、不需要协作式中断协议、嵌套 Future 自动跟着取消。代价是 **cancel-safety 成了开发者的手动负担**。`drop` 会跑正常的析构，但析构是同步的：一个 `Mutex` 锁的 Guard 被 drop 会释放锁（这倒没事），可如果被取消时缓冲区写到一半、分布式租约还没续期、数据库事务没提交——这些「语义半成品」就要你自己保证安全。而且目前**还没有 `AsyncDrop`**，需要异步清理的资源（比如发一个 TCP FIN）没法在 drop 时完成。社区有 RFC 在讨论，目前 cancel-safety 完全靠人工推理，不像 `RefUnwindSafe` 那样有个 marker trait 兜底。

本质矛盾是「要能随时放弃一个异步计算」和「被放弃时资源可能正卡在某个中间态」之间的冲突——零成本取消的代价，就是把「中间态善后」这件事压到了程序员肩上。

## 5. 最小原理演示

这一节用两段最小实现演透原理：**控制流骨架用 TS**（最方便迁移 JS 直觉），**内存/取消语义用 Rust 小片段**（这两点是 Rust 特有，TS 的 GC 和可随意移动对象讲不透）。

### 演示一：Future + executor + Waker 的闭环（TS）

下面是一个能跑通「惰性 + poll 驱动 + waker 回调」的极小运行时。重点看 **waker 怎么把核心循环闭环**：task 被 `wake` 之后，必须真的被再 `poll` 一次。

```ts
// Future 契约：poll 收到一个 waker 函数，答 pending 或 ready
type Poll<T> = { tag: 'pending' } | { tag: 'ready'; value: T }
interface Future<T> {
  poll(waker: () => void): Poll<T>
}

// 一个 task = 一个 future + 它专属的 waker
interface Task {
  future: Future<unknown>
  waker: () => void
  done: boolean
}

class MiniExecutor {
  private queue: Task[] = []
  private scheduled = false

  spawn<T>(future: Future<T>) {
    const task: Task = { future, waker: () => {}, done: false }
    // 为这个 task 造 waker：被调用时把它重新塞回队列，并重新驱动 loop
    task.waker = () => {
      if (task.done) return
      this.queue.push(task)        // 资源就绪 → task 重新入队
      this.schedule()              // ← 闭环的关键：waker 重新驱动 loop
    }
    this.queue.push(task)
    this.schedule()                // 入队即排一轮 loop
  }

  // 排一轮 loop（用 setImmediate 排到事件循环下一轮，避免同步重入）
  private schedule() {
    if (this.scheduled) return     // 已经排过了就不重复排
    this.scheduled = true
    setImmediate(() => this.loop())
  }

  private loop() {
    this.scheduled = false
    while (this.queue.length) {
      const task = this.queue.shift()!
      const poll = task.future.poll(task.waker)
      if (poll.tag === 'ready') {
        task.done = true
        console.log('task 完成:', (poll as any).value)
      }
      // pending 的 task 不在这里重新入队——它靠自己的 waker 被叫醒时才重新入队
    }
    // 队列空了：本轮 loop 自然结束。这是对的，但前提是 waker 会在资源就绪时
    // 重新入队 + 重新 schedule，否则挂起的 task 就再也没人 poll 了（核心循环必须闭环）。
  }
}

// 一个「延时后返回 done」的 Future，模拟等一个异步资源（定时器 / 网络 / DB）
function after(ms: number): Future<string> {
  let started = false              // 用这个标志位演「自引用状态机的状态字段」
  return {
    poll(waker) {
      if (!started) {
        started = true
        setTimeout(waker, ms)      // 把 waker 注册到资源（定时器）上，然后挂起
        return { tag: 'pending' }  // 第一次 poll：没好，注册 waker，返回 pending
      }
      return { tag: 'ready', value: 'done' }  // 第二次 poll：好了
    },
  }
}

const exec = new MiniExecutor()
exec.spawn(after(100))
// （约 100ms 后）打印：task 完成: done
```

这段代码的灵魂是 `task.waker` 里那两行：`push` 之后紧跟 `this.schedule()`。少了 `schedule`，核心循环就断了——这正是上一版草稿踩的坑：task 被 `wake` 后虽然回到了队列，却没有任何逻辑再去跑 `loop`，于是「第二次 poll 拿到 Ready」永远不会发生。闭环后，流程才是 `poll → pending → 注册 waker → (就绪) wake → 重新入队 + schedule → 再 poll → ready`，和第 3 节的七步完全对上。

### 演示二：自引用为什么逼出 Pin（Rust 片段）

TS 讲不透这一段，因为它有 GC、对象可以随便移动、没有 drop 语义。回到 Rust：

```rust
async fn greet() {
    let name = String::from("rust");   // name 会存进状态机字段
    hello(&name).await;                  // 借用 name，跨过挂起点
    println!("{name}");                  // 挂起恢复后 name 还要用
}
```

概念上，编译器生成的状态机长这样（省略无关字段）：

```rust
struct Greet {
    state: u8,
    name: String,      // 持有 name
    name_ref: &str,    // 指向自己 name 字段的引用 → 自引用！
}
```

如果这个 `Greet` 被 `move` 到新地址，`name_ref` 还指着旧地址，访问就 UB。所以 `poll` 收的是 `Pin<&mut Self>`：`Pin` 在类型层保证「被 pin 后不能 move」，自引用指针因此始终有效。这就是上一节「必须 Pin」那条权衡落地的样子。

### 演示三：取消 = drop，且 drop 必须落在「持锁中」状态（Rust 片段）

要演示「持有锁时被取消」，必须先让 Future 推进到持锁的那个挂起点，再 `drop`——在还没 poll 的初始状态 drop，锁根本没拿到，演不出这个场景。下面手写状态机，把 `drop` 的落点看清楚：

```rust
use std::sync::{Mutex, MutexGuard};
static LOCK: Mutex<()> = Mutex::new(());

enum HoldThenWork {
    Start,
    Holding { _g: MutexGuard<'static, ()> },   // Guard 存进字段，跨挂起点存活 = 持锁中
    Done,
}

impl HoldThenWork {
    // 极简 poll：Start 时拿锁推进到 Holding；Holding 时假设 do_work 就绪则 Done
    fn poll(&mut self, work_ready: bool) -> &'static str {
        match self {
            HoldThenWork::Start => {
                let _g = LOCK.lock().unwrap();           // 拿锁
                *self = HoldThenWork::Holding { _g };      // Guard 存进状态字段
                if !work_ready { return "pending" }        // 卡在 do_work().await
            }
            HoldThenWork::Holding { .. } => { *self = HoldThenWork::Done; return "ready" }
            HoldThenWork::Done => return "ready",
        }
        "ready"
    }
}

fn main() {
    let mut f = HoldThenWork::Start;
    f.poll(false);   // Start → Holding：此刻 _g 在字段里，锁已被持有
    // ↑ 这一步相当于 executor 第一次 poll，撞上 do_work().await 返回 Pending
    drop(f);         // ← 取消：f 现在是 Holding（持锁中），析构它 = 析构 _g = 释放锁
    // drop 落在 Holding 而不是 Start，这才真正演示了「在挂起点被取消」。
}
```

关键就在 `f.poll(false)` 这一步：它把状态机从 `Start` 推进到 `Holding`，让 `drop(f)` 析构的真的是一个「持着锁」的状态机。`MutexGuard` 的析构会释放锁，所以这个例子本身是安全的；但同一个机制换成「缓冲区写到一半」「租约还没续期」，drop 就救不了你——那才是上一节「cancel-safety 是手动负担」这条权衡真正咬人的地方。

## 6. 执行轨迹

拿 `after(100)` 这个具体输入，逐步走一遍它在 `MiniExecutor` 里的内部状态变化（演的是核心闭环，不是全量调度）：

1. **`exec.spawn(after(100))`**：构造 `after` 这个 Future，造好它的专属 `task.waker`（waker 内含「push 回队 + schedule」），把 task 推进队列。此刻 `queue = [after]`，`scheduled = true`，排了一轮 `loop`。
2. **`loop()` 第 1 轮**：`queue` 非空，`shift` 出 `after`，调 `after.poll(waker)`。`started` 还是 `false`，于是 `started = true`、`setTimeout(waker, 100)`（把 waker 注册到定时器）、返回 `{ tag: 'pending' }`。task 不标记 `done`，也**不**重新入队。`queue` 现在空了，`while` 结束，`scheduled = false`，这一轮 `loop` 跑完。
3. **（约 100ms 后）定时器触发**：调用 `waker()`。`task.done` 还是 `false`，于是 `this.queue.push(task)`（`queue = [after]`）+ `this.schedule()`（`scheduled = true`，排新一轮 `loop`）。
4. **`loop()` 第 2 轮**：`shift` 出 `after`，调 `after.poll(waker)`。这次 `started === true`，直接返回 `{ tag: 'ready', value: 'done' }`。task 标记 `done = true`，打印 `task 完成: done`。`queue` 空，`loop` 结束。
5. **输出**：`task 完成: done`，task 完成被移出队列，没有任何残留。

重点在第 3 步：**正是 waker 里的 `push + schedule`，让「第二次 poll 拿到 Ready」真的发生了**。没有它，第 2 轮 `loop` 永远不会被排上，`ready` 永远拿不到，`done` 永远不打印——核心循环在「挂起」之后就断了。

## 7. 教学简化说明

本章演示故意省略了一堆工程现实：真实的 IO reactor（epoll/kqueue/mio、io_uring）、多线程工作窃取调度器、Tokio 的集成、`pin_project` 和 pin 投影涉及的 `unsafe` soundness 细节、`Future: Send` 的完整编译期推导、`select!`/`join!` 宏内部、`AsyncDrop` 的设计争论。这些都是真实运行时要处理的，但它们都不改变「Future = 状态机、poll 推进、waker 闭环、取消 = drop」这条原理主线，所以本章只点到为止。

## 8. 小结

Rust 异步的全部灵魂，是拒绝把运行时藏进语言：`async fn` 编译成一份等待被推进的状态机数据，由外部可替换的 executor 通过 `poll` 拉着走、靠 `Waker` 闭环，取消就是 `drop`。这套设计换来零成本和对部署场景的通吃，代价是你必须自己理解运行时、和惰性 Future 的直觉搏斗、为自引用啃下 `Pin`、为随时可能被取消的挂起点操心 cancel-safety。

而「运行时整个甩给生态」这件事，意味着你写第一个异步程序之前，得先会从生态里把 Tokio 这样的 crate 拉进工程——下一章的 Cargo、crate 和模块系统，正是干这件事的标准化工具链。
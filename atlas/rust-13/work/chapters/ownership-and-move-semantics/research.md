# 所有权与移动语义：取代 GC 的核心机制 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：从 JS 来到 Rust，最先撞墙的是「我明明只是把一个对象赋值给另一个变量 / 传进函数，怎么原变量就不能用了？编译器报 `value moved here`、`borrow of moved value`」。在 JS 里，对象赋值是共享同一份引用、谁都能读写、没人引用时 GC 才回收；你从不需要想「这块数据现在归谁」。Rust 强制你回答这个问题——每个数据有且只有一个主人，主人换了，旧主人就作废。初学者常见的本能反应是到处 `.clone()` 把数据复制一份来逃避这个报错，但这既掩盖了「谁该拥有它」的设计判断，又付了真实的深拷贝开销。

- **一句话核心思想**：每个值都有唯一的主人，主人变更即转移所有权、主人离开作用域即自动销毁——所有权的转移与回收都在编译期被静态追踪，从而在无需 GC 的前提下保证内存安全。

- **设计动机（为什么需要它）**：GC 把内存回收推迟到「某个不确定的未来」（带来暂停、不可预测的峰值）；C/C++ 手动管理又会 double-free、use-after-free。Rust 选择了第三条路：把「这块数据归谁、何时回收」钉死在两个确定的事实上——「唯一主人」与「主人离场的那个确定时刻」。这就把回收从运行时不确定事件，变成编译期可证明的静态事实。
  - **承前关系（供跨章去重）**：（已在第 1 章『Rust 的设计哲学与编译模型总览』讲透「把 JS 里由运行时/GC 兜底的问题前移到编译期」这一整体权衡与『提前编译 + 借用检查』的心智总图，本章只看它落地的第一个、也是最基础的机制——所有权具体如何转移、何时被回收。它为下一章『借用与引用』和第 4 章『生命周期』提供地基，但本章不展开那两者。）

- **关键权衡（本 Atlas 的核心，3 条）**：
  1. **默认移动而非隐式拷贝** → 换来「赋值/传参即转移所有权、不会意外深拷贝大对象、每份数据归属清晰」 → 代价是「从 JS『万物引用共享』的直觉彻底转向值语义，初学者频繁与编译器缠斗，且容易被 `.clone()` 诱惑而逃避设计思考」。
  2. **单一所有权 + 离场即析构（确定性回收）** → 换来「回收时机完全可预测、无 GC 暂停、锁/文件/socket 等资源能在确定时刻立即释放」 → 代价是「必须时刻想清楚『现在谁拥有它』，连函数签名都要明确表达所有权意图（是拿走、还是只是借来用）」。
  3. **move 在内存层是『栈表示按位复制 + 旧绑定编译期失效』而非物理搬迁字节** → 换来「move 零成本（不复制堆数据）且安全（析构只跑一次、无 double-free）」 → 代价是「move 是编译期语义概念，运行时看不到『搬迁』动作，调试时需理解『值的表示』这层抽象」。

- **最小心智模型（7 步）**：
  1. 把一个值绑定到变量，这个变量就是它的「主人」。
  2. 用赋值 `let b = a;` 或把值传进函数 `f(a)`，会把主人换人——这叫所有权转移（move）。
  3. move 之后，原主人 `a` 被编译器标记为「已移出」，再读 `a` 就是编译错误。
  4. 例外：若值所属类型实现了 `Copy`（如整数、布尔），赋值时是「按位复制」而非移动，原变量仍可用（`Copy` 的完整规则留给后续栈与堆章节）。
  5. 当值的当前主人走到其作用域终点，编译器自动为它插入析构（drop），按声明逆序执行。
  6. 若值在作用域结束前已被 move 走，那它就不再是主人，作用域结束时不会再被析构一次——析构永远只发生在「当前主人」身上。
  7. 净效果：无需 GC，内存与资源在确定时刻被精确回收恰好一次，double-free 与 use-after-free 在编译期就被排除。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个极简的「带 owner 标记的值」模型，只演透三件事——① 值身上记着「当前主人 + 是否仍存活」；② move 操作 = 把值的表示复制到新名字、同时把旧名字标记为失效（用布尔标志模拟编译期失效）；③ 作用域结束时只对「仍是存活主人」的值触发一次析构。可用 TS 骨架示意：
    ```ts
    // 演示用极简模型（非真实 Rust）；每行对应一个原理点
    let nextId = 0;
    const makeBox = (data: string) => ({ id: nextId++, data, alive: true });

    // 原理①+②：move = 复制表示 + 让旧主人失效
    const move = (src: any, dstName: string) => {
      const dst = { ...src };          // 复制「值的表示」（不复制堆数据）
      src.alive = false;               // 旧主人在编译期失效（这里用标志模拟）
      return dst;
    };
    // 原理③：作用域结束，只有仍 alive 的当前主人才析构，且只一次
    const endScope = (v: any) => {
      if (v.alive) { console.log(`drop #${v.id}`); v.alive = false; }
      // 已 move 走的（alive===false）什么都不做 → 不会 double-free
    };

    let a = makeBox("hi");
    let b = move(a, "b");   // a 失效、b 成新主人；堆数据 "hi" 未复制
    // read(a) → use of moved value（编译期错误，这里用 alive 模拟）
    endScope(a);            // 啥也不做：a 已不是主人
    endScope(b);            // 析构 #0 —— 全程恰好 drop 一次
    ```
  - **应故意省略**：借用检查器（下一章）、生命周期标注（第 4 章）、`Copy`/`Clone` 的完整规则与栈 vs 堆存储全景（第 5 章）、部分移动、`Drop` trait 的自定义语法、`std::mem::drop` 提前析构、析构逆序的边角、多线程下的 `Send`。不追求工程完整。
  - **演示载体建议**：首选 TS/JS——本 Atlas 产物是 JS 生态站点，用 TS 布尔标志模拟「编译期失效」对 JS 读者最直观。无需退回 Rust 原文。

- **正文不宜展开的细节**：`Copy`/`Clone` 为何不能 `Copy`（`String`/`Vec` 管理堆）、按位复制语义——留给「栈与堆：Copy/Clone 语义」章；借用与引用——留给下一章「借用与引用」；生命周期 `'a`——留给第 4 章；部分移动（move 走结构体某字段后整体不可用、字段级追踪）——本章至多提一句作为边界；`Drop` trait 的 `fn drop(&mut self)` 写法、析构的逆序细节、`std::mem::drop` 提前释放——只需点明「离场自动析构」这个机制即可，语法留给 Writer 一笔带过。

- **推荐的一个执行轨迹例子**：输入 `let s = 某堆字符串; let t = s;` → 关键中间态：`s` 被标记为已移出、`t` 成为新主人、堆上字符串数据本身一字节未动 → 输出：再访问 `s` 报「use of moved value」（编译期）；`t` 正常可用；`t` 的作用域结束时析构堆数据恰好一次；`s` 的作用域结束时因为它已不是主人、什么也不做。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点
- **所有权三条规则**：① 每个值都有唯一的所有者（owner）；② 同一时刻只有一个所有者；③ 当所有者离开作用域，值被 drop。这是整套机制的公理。依据: The Rust Programming Language 官方 Book 第 4 章第 1 节「What is Ownership?」。
- **move 的实质 = 栈表示按位复制 + 源变量编译期失效**。move 并非「把字节物理搬走」，而是把值在栈上的表示（例如 `String` 的「指针/长度/容量」三元组）复制到目标，再把源绑定标记为不可用；堆数据不被复制。优化器在实践中常省略那次实际拷贝。依据: HashRust《Moves, copies and clones in Rust》图解；Google《Comprehensive Rust》Move Semantics 章；Rust 论坛 users.rust-lang.org「How `move` works in Rust」讨论。
- **函数传参即 move**：把值传进函数，所有权转入函数形参；函数返回时所有权可转回调用者（move 的反向）。依据: The Rust Programming Language 官方 Book 第 4 章第 1 节（「Ownership and Functions」「Return Values and Scope」）。
- **`Copy` 例外**：实现了 `Copy` 的类型（如 `i32`、`f64`、`bool`、不可变引用 `&T`）在赋值/传参时是「按位复制」而非移动，原变量仍可用。`Copy` 是 `Clone` 的子 trait；`String`、`Vec<T>`、`Box<T>` 等拥有堆数据的类型**不是** `Copy`（否则按位复制会产生两个主人、析构两次）。本章只用到这个结论，`Copy`/`Clone` 的完整对比留给「栈与堆」章。依据: `std::marker::Copy` 官方文档；Stack Overflow「What is the difference between Copy and Clone?」。
- **RAII / 确定性析构**：资源获取即初始化——资源的释放在值（owner）离开作用域时由编译器自动插入的析构完成，时机完全确定，与 GC 的「不确定时刻回收」形成对照。依据: The Rust Reference「Destructors」；Effective Rust「Item 11: Implement the Drop trait for RAII patterns」。
- **析构只作用于当前 owner、且恰好一次**：若值在作用域结束前已被 move 走，则原作用域不会再次析构它（它已不是 owner）。这是「无 double-free」的直接来源。依据: The Rust Reference「Destructors」；Hacker News 关于「Rust 按 owner 追踪、而非按作用域字面」的讨论。
- **部分移动（边界，点到为止）**：把结构体的某个字段 move 出去后，该字段不可再访问，整个结构体也不能作为整体使用，但其余未移动字段仍可单独访问——编译器在字段粒度追踪所有权。依据: Rust By Example「Partial moves」；David J. Pearce《Understanding Partial Moves in Rust》。

## 关键流程
赋值 / 传参时编译器判定 move 还是 copy 的主干流程：

```
对源值 S 做绑定转移（赋值/传参）
   │
   ├─ S 的类型实现了 Copy？ ── 是 ──→ 对 S 的表示做按位复制，目标得到副本，S 保持有效
   │                                    （Copy 细节留「栈与堆」章）
   └─ 否（如 String/Vec/Box） ──→ move：
        ① 把 S 的栈表示复制到目标
        ② 将 S 标记为「已移出」，此后读 S = 编译错误
        ③ 堆数据不复制（指针指向同一份，但只有目标这一位合法主人）
```
依据: `std::marker::Copy` 官方文档（Copy 分支）；HashRust / Google Comprehensive Rust（move 分支）。

作用域结束的析构流程（编译器自动插入）：

```
作用域结束
   │
   └─ 对该作用域内「仍是 owner（未移出）」的值，按声明逆序逐个调用析构（drop）
        └─ 已被 move 走的值不参与 —— 故析构恰好一次、无 double-free
```
依据: The Rust Reference「Destructors」（离场析构 + 逆序）；Effective Rust Item 11（RAII）。

## 易混淆 / 边界 / 推断
- **易混淆**：move 不是「运行时把数据搬走」，而是「复制栈表示 + 让源在编译期失效」。运行时并无搬迁动作，调试器里看不到一次「迁移」。依据: Reddit r/rust「When a move occurs, what happens behind the scenes?」。
- **易混淆**：作用域结束不是「凡是在该作用域声明过的都 drop」，而是「凡是此刻仍是 owner 的才 drop」。先被 move 走的不 drop。依据: The Rust Reference「Destructors」；HN「Rust 按 owner 而非字面作用域 drop」讨论。
- **边界**：函数返回值把所有权「反向」转回调用者，这是 move 在「出参」方向的应用。依据: 官方 Book ch4.1。
- **边界**：闭包前的 `move` 关键字是「强制按值捕获环境」，与本章 move 同源，但细节留给「闭包与 Fn/FnMut/FnOnce」章，本章不展开。依据: 官方 Book ch13（闭包章，跨章引用）。
- **推断（标注为推断）**：单一所有权 + 默认 move 天然排除了「多个主人同时释放」和「释放后被他人引用」这两个经典错误；它也是后续把数据竞争前移到编译期的基础——但线程安全层面（`Send`）属并发章，本章不下结论。
- **未理解 / 待查证**：MIR 借用检查器对 move 的精确静态判定（non-lexical lifetimes 之后如何具体追踪某个绑定的 moved 状态）属编译器内部实现，本章不需要、也未深入查证。
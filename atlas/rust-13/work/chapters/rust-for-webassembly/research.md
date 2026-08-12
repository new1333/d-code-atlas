# Rust 编译到 WebAssembly：前端工程师的落地接口 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：前端工程师在浏览器里跑计算密集任务（图像处理、编解码、大数组运算、复杂状态机）时，JS 即使有 JIT 也常力不从心，且 GC 暂停带来不可预测的卡顿。直接用 C/C++ 又要拖上庞大运行时、面对手动内存管理的地狱。读者要问的是：能不能把那 5% 的 hot path 用一种「无 GC、确定性内存、又能被浏览器原生执行」的语言写，而其余 95% 仍是 JS？这正是 Rust 编译到 WebAssembly 要回答的问题。

- **一句话核心思想**：Rust 因为「无 GC + 确定性析构 + 零成本抽象」，编译出的 wasm 模块不含垃圾回收运行时、产物紧凑，再由 wasm-bindgen 这层「胶水生成器」把 wasm 原始到只能传数字的 ABI，自动抬升成 Rust 与 JS 之间的高级类型互操作。

- **设计动机（为什么需要它）**：WebAssembly 本身只规定了「一块连续字节内存（线性内存）+ 只能传几种标量（整数/浮点）的函数调用 ABI」，它**不认识**字符串、对象、数组，更**没有任何 DOM / 浏览器 API**。所以 Rust 哪怕函数签名只写了一个 `String` 参数，原生 wasm 也表达不出——必须有人**在 JS 和 wasm 之间写胶水**：把 JS 字符串编码成字节、拷贝进线性内存、把「指针+长度」两个数字交给 wasm。手写这套胶水极其痛苦且易错，wasm-bindgen 就是把它自动化的工具。**承前关系**：这本质是一条「跨语言互操作边界」，与 FFI 同构——（已在第 17 章『unsafe 与 FFI：安全边界的逃逸舱』讲透「FFI 把安全保证从编译期证明降级为人工契约」，本章只看它在 wasm→JS 这条具体边界上的**自动化封装形态**：unsafe 被收窄进 wasm-bindgen 内部，对普通使用者不可见，但边界「靠序列化+契约而非类型系统保证」的本质未变）；此外，跨 wasm 边界无法用编译期生命周期证明引用有效性，只能用拷贝规避——（已在第 3 章『生命周期』讲透编译期引用有效性证明，本章只看它跨 wasm 边界时**退化为「拷贝换安全」**的新侧面）。

- **关键权衡（本章核心；机制丰富章，给出 4 条）**：
  1. **「只在 hot path 上 wasm」是核心决策权衡**：把计算密集/性能敏感模块交给 Rust+wasm → 换来对 JS 的 2~6 倍乃至更高加速，且无 GC 暂停、性能可预测 → 代价是 .wasm 体积（含链入的堆分配器、panic 处理等）、模块编译/实例化的冷启动开销、以及每次跨边界的序列化成本。**结论：并非「全场用 wasm」，而是「hot path 值得，I/O 密集或轻量任务 JS 仍更优」**——这是本章最该让读者带走的产品判断。
  2. **「用胶水生成器而非手写原始 FFI」**：选择 wasm-bindgen 自动生成胶水 → 换来在 Rust 里能写自然的函数签名（`String`、`Result`、甚至直接持有 JS 对象），大幅降低心智负担 → 代价是它**隐藏了跨边界拷贝与间接调用的真实成本**，初学者容易把「写得像普通函数」误以为「无开销」，在循环里反复跨边界反而比纯 JS 还慢。
  3. **「线性内存 + 自管分配器」换「无 GC 的确定性」**：wasm 的堆就是一块 JS 侧 `ArrayBuffer`（线性内存），由模块自己分配/释放 → 换来无 GC、确定性、可预测的内存行为，这正是 Rust 的所有权模型能完美映射上去的原因 → 代价是 Rust 必须把一个堆分配器（默认 dlmalloc 之类）链进 .wasm（增大体积），且 JS 与 wasm **不能共享对象**，跨边界只能拷贝或用间接表。
  4. **「整型索引 + JS 侧 slab 表」换「在 Rust 里持有 JS 对象」**：因为线性内存里存不了 JS GC 对象的稳定地址，wasm-bindgen 在 JS 侧维护一张对象表，Rust 侧的 `JsValue` 只是一个 u32 索引 → 换来在 Rust 里像用普通值一样用 window、document、任意 JS 对象 → 代价是每次属性读写/方法调用都要跨一次边界（昂贵），且 Rust 侧忘记 drop 会导致 JS 对象在表里常驻、无法被 GC 回收（内存泄漏）。

- **最小心智模型（一条 JS 字符串进入 wasm 的旅程，6 步）**：
  1. Rust 侧用 `#[wasm_bindgen]` 宏标注一个 `pub fn greet(name: String)`，宏在编译期记下「这个导出函数期望一个字符串参数」的描述信息。
  2. `cargo build` 以 wasm 为目标编译，产出 .wasm，里面带着这些描述信息（作为特殊导出/自定义段），以及 greet 的**真实实现**——它只接受 (指针, 长度) 两个 i32。
  3. wasm-bindgen 工具后处理这个 .wasm：读出描述，**生成对应的 JS 胶水函数** `greet(arg)`，并剥离描述段。
  4. JS 调 `greet("Atlas")`：胶水把 "Atlas" 按 UTF-8 编码，在 wasm 线性内存里分配一块、把字节拷贝进去，记下指针 ptr 与长度 len。
  5. 胶水调用 wasm 里的原始 greet(ptr, len)；Rust 用 (ptr, len) 在线性内存里**重建**出 `String`，执行业务逻辑。
  6. 返回值（若也是字符串）走反向链路：Rust 把结果放进线性内存并返回 (ptr, len) → 胶水读出字节、解码成 JS 字符串 → 调用 wasm 的 dealloc 释放那块内存。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：一个「微缩 wasm-bindgen」——用 TS 模拟出两个最关键的原理机制：(a) **跨边界拷贝**：用一个 `Uint8Array` 当线性内存，写一个「高级签名（接收字符串）→ 自动生成胶水 → 拆成 (ptr,len) + memcpy → 调底层函数」的微型代码生成器；(b) **JsValue 索引表**：用 `unknown[]` 当 JS 侧 slab 表，演示 Rust 侧只持有 u32 句柄、drop 时通知 JS 释放表项让 GC 回收。几十行即可，每一行对应上面某个原理点。
  - **应故意省略**：真实的 .wasm 二进制、wasm-bindgen 完整的代码生成细节、wasm-opt/体积优化、多线程/SIMD、完整的 wasm-pack 打包流程、TypeScript 类型生成、serde 序列化方案对比。
  - **演示载体建议**：**首选 TS/JS**。因为本章的目标读者是前端工程师，且核心机制（线性内存即 ArrayBuffer、跨边界拷贝、句柄表）本就是「JS 侧视角」最清晰，用 TS 模拟一个最小胶水生成器能直接演透「为什么跨边界要拷贝」与「为什么 JS 对象要用索引表」这两个灵魂点。无需真实 Rust 编译。

- **正文不宜展开的细节**：wasm 的完整指令集与值类型扩展（v128/reference types/GC proposal）、wasm-component 模型与接口类型（component model）、serde-wasm-bindgen 与 js-sys/web-sys 的完整 API 清单、wee_alloc 等替代分配器的历史与弃用细节、wasm-opt 的全部优化级别、Threads/SIMD/异常处理提案。这些是工具/规范细节，供 Writer 裁剪到「正文带一句即可」或放进拓展阅读。

- **推荐的一个执行轨迹例子**：输入 `greet("Atlas")` → 关键中间态：胶水 UTF-8 编码得 5 字节 `[65,116,108,97,115]`，写入线性内存偏移 1000 处，调底层 `__greet(1000, 5)` → Rust 用 (1000,5) 重建 `String`，拼接成 `"hello, Atlas"`，把结果 11 字节写入内存偏移 2000，返回 `(2000, 11)` → 胶水读 [2000..2011] 解码成 JS 字符串 `"hello, Atlas"`，再调 `__dealloc(2000, 11)` 释放 → 输出 JS 拿到字符串。这条轨迹演透了「拷贝」「指针+长度」「反向回收」三个核心思想，不演全量调用。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **WebAssembly 的执行模型是两条隔离的内存世界**：wasm 模块拥有自己的「线性内存」（一块连续、可增长的字节缓冲区，JS 侧即一个 `ArrayBuffer`/`WebAssembly.Memory`），与 JS 引擎的 GC 堆物理隔离；wasm 函数调用 ABI 只能传递少数标量值（i32/i64/f32/f64，后续扩展了 v128、引用类型等）。这是「跨边界必须拷贝/间接」的根因。依据: MDN「WebAssembly.Memory」参考；WebAssembly 官方规范；Rust and WebAssembly 官方书「JavaScript Interoperation」章节对「sharp split between wasm linear memory and JS memory」的描述。
- **Rust 是编译到 wasm 的理想源语言**：因为 Rust 无 GC、靠所有权+离开作用域自动析构做确定性内存管理，产物不需要链入庞大 GC 运行时；强类型与零成本抽象又使产物紧凑。这与 JS（强依赖 GC）、Go/C#（需携带 runtime/GC）形成对照。依据: Rust and WebAssembly 官方书；MDN「Compiling from Rust to WebAssembly」教程。
- **wasm-bindgen 的定位是「胶水生成器」**：它不改变 wasm 规范，而是在 Rust 侧用过程宏声明「我要 import 哪些 JS 函数 / export 哪些 Rust 函数」，编译后用一个工具读 .wasm、生成对应的 JS 胶水与（可选）TypeScript 类型，从而把只能传数字的原始 ABI 抬升为高级类型互操作。官方明确：它只为「你实际用到的 JS 导入和 Rust 导出」生成胶水，以保持产物精简。依据: wasm-bindgen GitHub 仓库 README；Rust and WebAssembly 官方书「js-ffi」章节；wasm-bindgen 官方 DESIGN.md。
- **字符串/数组跨边界的本质是「拷贝进/出线性内存」**：JS 字符串进入 wasm 时，胶水先 UTF-8 编码，在线性内存里分配 + memcpy，再以 (ptr, len) 传给底层函数；返回时反向，并最终 dealloc。这就是「JS↔wasm 边界序列化成本」的来源——每次跨边界都要分配、拷贝、释放。依据: wasm-bindgen DESIGN.md；Ryan Levick「Rust and JavaScript Interop」博文；Medium 2025「A Gentle Introduction to WebAssembly in Rust」对 string 拷贝的具体描述。
- **JS 对象引用靠「JS 侧 slab 表 + Rust 侧 u32 索引」**：因为线性内存无法稳定存放 JS GC 对象的地址，wasm-bindgen 在 JS 侧维护一张表（数组）存放真实 JS 对象，Rust 侧的 `JsValue` 内部只是一个 u32 索引。Rust 里 drop 该值会调用 `__wbindgen_object_drop_ref(idx)`，JS 侧据 idx 从表中移除，JS GC 才能回收。依据: wasm-bindgen 官方设计文档「JS Objects in Rust」；wasm-bindgen DESIGN.md（v0.2.1 源码）；GitHub Issue wasm-bindgen#999 对 slab 机制的讨论。
- **wasm 的线性内存没有对象级边界检查**：线性内存是连续字节，wasm 只做「区域级（region）粒度」的越界检查，模块内逻辑可覆盖相邻对象。这是 wasm 模块自身的安全约束，也是为什么 Rust 的所有权/借用检查在「模块内」依然有价值（减少模块内的内存误用）。依据: WebAssembly 官方安全文档「Security」。
- **何时值得用 wasm 的产品判断**：基准测试与社区共识表明，wasm 对 CPU/计算密集任务相对 JS 有约 2~6 倍加速（任务越重差距越大），优势更体现在「性能一致性/无 GC 暂停」而非峰值；但对 I/O 密集或轻量任务，JS 仍具竞争力，且 wasm 的体积与冷启动（下载、编译、实例化）开销可能反噬收益。依据: Better Programming「How Fast is WebAssembly vs JS」；The New Stack「WebAssembly vs JavaScript」；JavaScript Plain English「I Benchmarked WebAssembly vs Node.js」；nickb.dev「The WebAssembly Value Proposition」。此结论标注为「基于公开基准与社区经验」，具体倍数随任务与引擎版本波动。

## 关键流程

构建与互操作的端到端链路（wasm-pack 视角）：

```
#[wasm_bindgen] 宏（编译期）
   └─ 记下「import/export 描述」
cargo build --target=w32-wasm  (编译为 .wasm，含描述段 + 只收数字的底层实现)
   └─ 产物：target/.../*.wasm
wasm-bindgen（后处理 .wasm）
   ├─ 读描述段 → 生成 JS 胶水（字符串拷贝、slab 表、对象 drop 等）
   ├─ 生成 TypeScript 类型定义（.d.ts）
   └─ 剥离描述段，输出干净 .wasm
wasm-opt（可选，来自 Binaryen）
   └─ 对 .wasm 做 wasm 专用优化（-O 等）
wasm-pack 打包
   └─ 输出 pkg/：.wasm + .js 胶水 + .d.ts + package.json
JS 侧 import { greet } from 'pkg' → 调 greet("Atlas") → 胶水拷贝进线性内存 → wasm 跑 → 胶水解码返回
```

依据: MDN「Compiling from Rust to WebAssembly」；wasm-pack 官方教程「Hello wasm-pack」；surma.dev「Rust to WebAssembly the hard way」；nickb.dev「Life after wasm-pack」对「wasm-pack 本质是 cargo build target + wasm-bindgen + 打包」的拆解。

运行期一次「Rust 调用 JS 对象方法」的边界往返：

```
Rust 持有 JsValue{idx:3}
   → 调用胶水 __wbindgen_call(idx=3, method, args...)
      → JS 查 slab 表 [3] → 拿到真对象 → 调用其方法
      → 返回值（若是对象）push 进 slab 表得新 idx=N
   → Rust 收到 JsValue{idx:N}
Rust drop JsValue{idx:N}
   → 调 __wbindgen_object_drop_ref(N) → JS 从表移除 → JS GC 可回收
```

依据: wasm-bindgen DESIGN.md「JS objects in Rust」对 stack/slab 与 drop_ref 的描述。

体积优化的常规链路（供 Writer 「正文带一句、不展开」用）：

```
--release + opt-level="z" + lto=true + panic="abort" + strip=true   （Cargo profile）
   → wasm-opt -Oz（Binaryen 后处理）
   → twiggy top <.wasm>（体积剖析，常发现 panic/fmt/字符串格式化是大头）
```

依据: Rust and WebAssembly 官方书「Shrinking .wasm Code Size」；surma.dev（twiggy 用法）；Medium「WASM Size Diet」。注意：wee_alloc 虽常被引用为小体积分配器，但已不再维护且有已知内存泄漏，标注为「待查证/历史方案」，不推荐在新项目使用。依据: Rust 论坛「Treeshaking wasm」讨论；wee_alloc Issue #66。

## 易混淆 / 边界 / 推断

- **事实**：wasm 模块本身没有 DOM、fetch、console 等任何浏览器 API 的访问权，必须通过 wasm-bindgen 声明、由 JS 侧胶水把浏览器能力「喂」进来（web-sys/js-sys 就是把这些 API 的绑定批量生成好的 crate）。依据: Rust and WebAssembly 官方书「js-ffi」；rust-lang 用户论坛「Where to Do Things Between WASM and JavaScript」。
- **易混淆**：「wasm 比 JS 快」不等于「任何场景都快」。跨边界调用本身有成本，把一个细粒度函数放在循环里反复跨边界调用，可能比等价的纯 JS 实现还慢。正确用法是「在 wasm 侧完成一整块计算，只跨边界传一次大输入、收一次大输出」。依据: Ryan Levick 博文；社区共识（标注为社区经验）。
- **推断（标注为推断）**：wasm-bindgen 选择 slab 表 + 整型索引而非 wasm GC reference types，是因为在它设计之初 wasm GC 提案尚未成熟；随 reference types / GC proposal 落地，未来 JsValue 的底层实现可能演进（Issue #999 已讨论），但对使用者 API 无影响。
- **推断（标注为推断）**：「只在 hot path 值得」这一判断，在「首次加载延迟敏感」的场景（如首屏着陆页）应更保守，因为 .wasm 的下载+编译+实例化是串行冷启动开销；而在「长会话、反复计算」的场景（如在线编辑器、游戏、音视频处理）更值得。此为对基准数据的工程推断。
- **未理解 / 待查证**：component model 与接口类型（interface types）提案在「降低跨边界序列化成本」上的最新进展及生产可用性，本章不展开，留给拓展阅读；wee_alloc 的替代品现状（如新的轻量分配器）需 Writer 写作时再查证，不要沿用可能过时的建议。
---
layout: home

hero:
  name: "Rust 源码解读"
  text: "写给前端工程师"
  tagline: 用编译期证明换运行时零开销——从所有权到 WebAssembly 的全链路设计解读
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 第 1 章：设计哲学与编译模型
      link: /guide/01-rust-paradigm-and-toolchain

features:
  - title: 编译期证明
    details: 把别的语言甩给运行时和 GC 的问题前移到编译期，同时拿到 C 的速度与 GC 语言的安全。
  - title: 零成本抽象
    details: 单态化 + 编译期融合，让迭代器、泛型、trait 这些高层写法编译后与手写底层代码一样快。
  - title: 三档逃生舱
    details: 编译期证明 → 运行时检查（RefCell/Mutex）→ 人工契约（unsafe），每一档代价都写在类型里。
  - title: 落地前端
    details: 全书原理最终收束到 Rust 编译到 WebAssembly，hot path 用 Rust + wasm 换来无 GC 的可预测性能。
---

## 这是什么

一座覆盖 **内存、类型、并发、错误、工程、落地** 全链路的 Rust 设计解读，面向有 JavaScript 背景的工程师。不是语法清单，而是讲一个设计决定——**用编译期证明换运行时零开销**——如何长成一门完整的语言。

全书 18 章按依赖关系排成三层：

- **原子层**：所有权、借用、生命周期、栈堆与 Copy/Clone、枚举与穷尽匹配。
- **复合层**：Trait 与泛型、闭包、动态派发、错误即值、集合与迭代器、智能指针、宏、并发、异步。
- **系统层**：模块/Crate/Cargo、unsafe 与 FFI、Rust 编译到 WebAssembly。

## 快速开始

```bash
# 进入 site 目录
cd site

# 安装依赖（任选其一）
bun install
# 或：npm install / pnpm install

# 启动本地开发服务器
bun run docs:dev
# 或：npm run docs:dev

# 构建生产产物
bun run docs:build
```

构建产物输出到 `site/.vitepress/dist/`，可直接部署到任意静态托管。

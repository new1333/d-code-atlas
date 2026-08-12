import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Rust 源码解读（写给前端工程师）",
  description: "用编译期证明换运行时零开销：写给前端工程师的 Rust 源码解读",
  lang: "zh-CN",
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。缺失则站点不出现搜索框——必须配。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：work/prologue/draft.md 存在，固定为侧边栏首组。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          { text: "Rust 的设计哲学与编译模型总览", link: "/guide/01-rust-paradigm-and-toolchain" },
          { text: "所有权与移动语义：取代 GC 的核心机制", link: "/guide/02-ownership-and-move-semantics" },
          { text: "借用与引用：编译期的别名分析", link: "/guide/03-borrow-and-references" },
          { text: "生命周期：编译期证明引用有效性", link: "/guide/04-lifetimes" },
          { text: "栈与堆：数据布局与 Copy/Clone 语义", link: "/guide/05-stack-heap-and-copy-clone" },
          { text: "代数数据类型：枚举与穷尽模式匹配", link: "/guide/06-enums-pattern-matching" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "Trait 与泛型：编译期单态化的静态多态", link: "/guide/07-traits-and-generics" },
          { text: "闭包与 Fn/FnMut/FnOnce：捕获方式即类型", link: "/guide/08-closures-and-functional-traits" },
          { text: "动态派发：dyn Trait 与 vtable", link: "/guide/09-trait-objects-and-dispatch" },
          { text: "错误即值：Result/Option 与 ? 运算符", link: "/guide/10-error-handling-result-option" },
          { text: "集合与迭代器：零成本抽象的典范", link: "/guide/11-collections-and-iterators" },
          { text: "智能指针与内部可变性：借用规则的运行时逃生舱", link: "/guide/12-smart-pointers-and-interior-mutability" },
          { text: "宏系统：编译期代码生成", link: "/guide/13-macros-and-metaprogramming" },
          { text: "无畏并发：Send/Sync 与编译期线程安全", link: "/guide/14-concurrency-and-send-sync" },
          { text: "异步模型：Future、poll 与可选运行时", link: "/guide/15-async-await-and-futures" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "模块、Crate 与 Cargo：工程组织与标准化工具链", link: "/guide/16-modules-crates-and-cargo" },
          { text: "unsafe 与 FFI：安全边界的逃逸舱", link: "/guide/17-unsafe-and-ffi" },
          { text: "Rust 编译到 WebAssembly：前端工程师的落地接口", link: "/guide/18-rust-for-webassembly" },
        ],
      },
    ],
  },
});

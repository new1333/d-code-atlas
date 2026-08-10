---
layout: home

hero:
  name: "Vue Macros 源码解读"
  text: 编译期宏如何用变换换零运行时
  tagline: 从「运行时不存在的伪函数」出发，一路拆穿 Vue Macros 全部复杂性的源头。
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 直接读第 1 章
      link: /guide/01-compiler-macro-essence

features:
  - title: 原子层（primitive）
    details: 编译期宏的本质、`<script setup>` 与内置宏、SFC 编译管线、AST 识别、magic-string 就地变换。
  - title: 复合层（composite）
    details: 宏变换流水线、宏的设计原型、unplugin 跨构建工具分发、Volar 虚拟代码与语言插件。
  - title: 系统层（system）
    details: 双轨制、vue-tsc、一份配置驱动两条管线、零运行时 vs 可调试性的根本权衡。
---

## 快速开始

```bash
cd site
bun install
bun run docs:dev      # 本地开发预览
bun run docs:build    # 构建静态站点
bun run docs:preview  # 预览构建产物
```

本站是一个自包含的 VitePress 工程，依赖仅 `vitepress` + `vitepress-mermaid-renderer` + `mermaid`。

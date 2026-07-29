---
layout: home

hero:
  name: Pinia
  text: 源码精读 · Code Atlas
  tagline: 按 primitive → composite → system 三层架构逐章拆解 Pinia 运行时
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-core-types
    - theme: alt
      text: Pinia 根实例
      link: /guide/04-pinia-instance

features:
  - icon: 🧱
    title: 原子层
    details: 核心类型契约、发布-订阅原语、运行时诊断——为整库立下骨架的编译期/轻运行时基石。
  - icon: 🧩
    title: 复合层
    details: Pinia 根实例、store 定义与装配、变更/订阅 API、storeToRefs、Options API 映射辅助。
  - icon: ⚙️
    title: 系统层
    details: HMR 无损热替换、Vue Devtools 集成、@pinia/nuxt 的 SSR payload 往返、@pinia/testing 测试夹具。
---

## 这是什么

一份自底向上、面向源码的 Pinia 精读手册。每章都带 `file:line` 标注的源码摘录、设计意图拆解、易混淆点速查，多数章节配有一份可独立 `bun run` 的最小复刻（replica）。

## 快速开始

```bash
cd site
bun install          # 或 npm install / pnpm install
bun run docs:dev     # 本地开发预览：http://localhost:5173

# 构建生产站点：
bun run docs:build
bun run docs:preview
```

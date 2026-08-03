---
layout: home

hero:
  name: "Pinia"
  text: 源码解读
  tagline: 一份逐章拆解 Pinia 内部机制的 Code Atlas
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-pinia-instance-active-context

features:
  - title: 原子层
    details: 根状态容器、注册表、活跃上下文与订阅原语——支撑一切的底层零件。
  - title: 复合层
    details: defineStore、Store 装配、变更模型、订阅系统、插件与 mapHelpers 等核心机制。
  - title: 系统层
    details: HMR、DevTools、SSR 水合、Nuxt 模块与测试——建立在核心之上的系统能力。
---

## 快速开始

```sh
bun install
bun run docs:dev
```

构建生产版本：

```sh
bun run docs:build
```

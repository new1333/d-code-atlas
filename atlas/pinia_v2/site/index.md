---
layout: home

hero:
  name: Pinia 源码图谱
  text: 逐层拆解状态管理内核
  tagline: 从活跃指针、订阅原语到插件、HMR、SSR 的完整源码导读
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-active-pinia
    - theme: alt
      text: 源仓库
      link: https://github.com/vuejs/pinia

features:
  - icon: 🧱
    title: 原子层
    details: 全局活跃指针与订阅原语——支撑整个 Pinia 的最小构建块。
    link: /guide/01-active-pinia
    linkText: 进入原子层
  - icon: ⚙️
    title: 复合层
    details: createPinia、defineStore、store 装配、$patch、订阅、storeToRefs、插件与 HMR。
    link: /guide/03-pinia-instance
    linkText: 进入复合层
  - icon: 🧭
    title: 系统层
    details: mapHelpers、Vue Devtools、测试替身、Nuxt SSR 与诊断目录。
    link: /guide/11-map-helpers
    linkText: 进入系统层
---

## 关于本图谱

本站是对 [Pinia](https://github.com/vuejs/pinia) 源码的逐层架构拆解，按 **原子层 → 复合层 → 系统层** 的拓扑顺序组织，每一章聚焦一个核心机制，讲清「它解决了什么问题、做了哪些关键权衡、代价是什么」。

::: tip 阅读建议
章节之间存在依赖关系，按侧边栏自上而下阅读可顺清脉络；亦可直接跳转感兴趣的机制。
:::

## 快速开始

```bash
cd site
bun install        # 或 npm install / pnpm install
bun run docs:dev   # 本地预览：http://localhost:5173
```

构建生产版本并本地预览：

```bash
bun run docs:build
bun run docs:preview
```

---
layout: home

hero:
  name: "Pinia 源码导读"
  text: 从 effectScope 到 Nuxt 集成的分层拆解
  tagline: 15 章，自底向上看透 Vue 官方状态库的设计与实现
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-effect-scope-pinia
    - theme: alt
      text: 复合层概览
      link: /guide/06-store-definition-registry

features:
  - title: 原子层
    details: effectScope、订阅原语、$patch、Action 包装、storeToRefs —— Pinia 的五块底座，每块独立可运行。
  - title: 复合层
    details: defineStore 注册表、Setup/Options 两套构建器、State 集中化、插件系统 —— 把原子层粘合成完整的 store 工厂。
  - title: 系统层
    details: HMR、DevTools、mapHelpers、@pinia/nuxt、@pinia/testing —— 把 store 工厂挂到 Vue 与 Nuxt 生态上。
---

## 这是什么

这是一份按「原子层 → 复合层 → 系统层」三层架构组织的 [Pinia](https://pinia.vuejs.org/) 源码导读。
每一章都从「问题」出发，拆解 Pinia 在该处做的设计选择，并明确展开「换来什么 / 代价是什么」的权衡，
而不是简单复述 API。

## 快速开始

```bash
# 在 site/ 目录下
bun install
bun run docs:dev      # 本地开发服务器
bun run docs:build    # 产出静态站点到 .vitepress/dist
bun run docs:preview  # 预览构建产物
```

也可以直接挂到任意支持静态站点的平台（GitHub Pages / Vercel / Netlify）。

## 阅读路径

- **想从最底层开始**：从 [01-effect-scope-pinia](/guide/01-effect-scope-pinia) 顺着侧栏往下读。
- **想看一条 store 是怎么造出来的**：跳到 [06-store-definition-registry](/guide/06-store-definition-registry)。
- **想看 SSR / 测试支持**：直接读 [14-nuxt-module](/guide/14-nuxt-module) 与 [15-testing-pinia](/guide/15-testing-pinia)。

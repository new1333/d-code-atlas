---
layout: home

hero:
  name: "Pinia"
  text: 源码解读
  tagline: 一份逐章拆解 Pinia 内部机制的 Code Atlas——从响应式托管、全局活跃上下文，到装配流水线、订阅系统，再到 SSR、HMR、DevTools 与测试。
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/00-prologue
    - theme: alt
      text: 第一章：Pinia 实例
      link: /guide/01-pinia-instance-active-context

features:
  - title: 四个支点
    details: detached effectScope 托管响应式生灭、全局活跃指针换免传参、单一可序列化根状态、统一装配流水线——彼此咬合，撑起整个生态。
  - title: 按拓扑排序
    details: 十五章严格按依赖顺序铺开，每章承接前置、打开后续；另附按主题的精简阅读路线。
  - title: 机制 + 权衡
    details: 每章不只讲怎么实现，更点透「做了什么选择、换来什么、又付了什么代价」。
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

## 这本书在讲什么

打开 Pinia 的源码，最先撞见的“魔法”是 `useUserStore()`——不传参、不分场合，任何地方一调就拿到那个唯一的 store。这本书整本都在拆这个魔法：Pinia 没有重造一套状态库的内脏，而是把状态库要面对的四件难事，逐个借力交给四个支点。

完整导读见 [导读](/guide/00-prologue)。

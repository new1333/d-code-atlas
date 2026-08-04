---
layout: home

hero:
  name: "vue-macros Atlas"
  text: 源码解读
  tagline: 30+ 个宏共用同一套机制、各自的复杂度都花在边界上
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 直接看第一章
      link: /guide/01-sfc-parse-and-ast-edit

features:
  - title: 原子层（primitive）
    details: SFC 解析与增量 AST 编辑、unplugin 多构建器适配、虚拟 helper 模块——三块公共底座，不做完它们，后面所有宏都得各自重发明。
    link: /guide/01-sfc-parse-and-ast-edit
  - title: 复合层（composite）
    details: props/emit 重写、defineModels、better-define、响应式语法糖、SFC 结构扩展、JSX 指令、模板/渲染重定向、静态提升、语法垫片——九个具体宏的化身。
    link: /guide/04-props-emit-macro-rewrite
  - title: 系统层（system）
    details: 版本感知配置、主聚合管道、volar IDE 镜像、Nuxt / Astro / DevTools 框架集成——把宏装成一个系统。
    link: /guide/13-config-version-aware
---

## 一句话主线

vue-macros 的全部宏都是**编译期改写器**——在源码送进 Vue 编译器之前，把更顺手的写法翻成 Vue 原生形态，运行时一尘不染。围绕这条范式，它把「懒解析 + 偏移增量编辑」收成一块公共底座、把「门控 + 物化」收成分发层、把「同一特性拆前后两段」收成管道规则，再用虚拟模块、IDE 镜像、框架回收三套外延机制，把改写边界推到运行时、编辑器、宿主框架三个外部世界。

## 快速开始

```bash
cd site
bun install           # 或 npm install / pnpm install
bun run docs:dev      # 本地开发：http://localhost:5173
bun run docs:build    # 构建产物到 .vitepress/dist
bun run docs:preview  # 预览构建产物
```

## 怎么读这本书

- **线性路线**：按章号 1→16 顺序读，每章承接前一章的地基。
- **最薄路径**：1 → 4 → 5 → 14，足以抓住「编译期改写 + 管道编排」的命门。
- **按主题**：详见[导读](/guide/00-prologue)里的「按主题路线」一节，针对类型 / 虚拟模块 / 双向绑定 / JSX / IDE / 框架集成等不同子目标各有一条最短章节序列。

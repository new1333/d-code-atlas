---
layout: home

hero:
  name: "vuejs-pinia"
  text: "源码解读"
  tagline: 三块基础设施加一条总线，撑起 Pinia 的整个生态
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 第一章
      link: /guide/01-subscription-scope-cleanup

features:
  - title: 集中聚合
    details: 状态聚成一棵树、副作用聚进一个作用域、插件聚成一条总线、store 聚进一张名册。
  - title: 隐式上下文指针
    details: 一根模块级变量记住"当前活跃者"，让任意上下文零参数找回当前实例。
  - title: 运行时特征探测
    details: 靠值自带的可观测特征分类，不靠用户贴标签——同一套探测在建立侧与消费侧各跑一遍。
  - title: 作用域绑定的资源回收
    details: 注册时挂靠作用域，销毁时统一结清；detached 开口给少数需要独立存活的资源留一条生路。
  - title: 复用既有管道
    details: 到了扩展层，不另起炉灶——devtools、热更新、SSR、测试替身全是搭便车。
  - title: 自包含可构建
    details: 一个 bun install && bun run docs:build 即可独立构建部署的 VitePress 文档站。
---

## 快速开始

```bash
cd site
bun install
bun run docs:dev      # 本地开发预览
bun run docs:build    # 构建静态站点
bun run docs:preview  # 预览构建产物
```

## 本书结构

全书 13 章按拓扑顺序排列，分三层：

- **原子层**（第 1–2 章）：订阅原语、作用域与集中状态树——全书最早落地的地基。
- **复合层**（第 3–8 章）：从 store 的懒创建、自动分流、状态变更，到组件消费。
- **系统层**（第 9–13 章）：插件总线、热更新、开发者工具、SSR、测试替身——全是搭在核心之上的横切能力。

建议从 [导读](/guide/00-prologue) 读起，那里有贯穿全书的主线和一张全书脉络图。

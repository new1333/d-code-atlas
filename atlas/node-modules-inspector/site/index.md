---
title: node-modules-inspector 源码导读
hero:
  name: node-modules-inspector
  text: 逐章深度拆解
  tagline: 从流式 JSON 解析、依赖图物化、过滤器 DSL，到 WebContainer、CLI 多形态与可视化层。
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/01-json-stream-parser
    - theme: alt
      text: 可视化层（终章）
      link: /guide/17-visualizations

features:
  - icon: 🧱
    title: 原子层（primitive）
    details: 流式解析、包管理器策略、依赖图物化、模块类型推断、安装体积测算、package.json 字段归一化——所有底层基本件。
    link: /guide/01-json-stream-parser
    linkText: 从第一章开始 →
  - icon: 🧩
    title: 复合层（composite）
    details: resolvePackage 流水线、声明式过滤器 + DSL、维护者行动算法、npm 元信息拉取、响应式 payload 级联、URL 双向绑定。
    link: /guide/07-resolve-package-pipeline
    linkText: 进入复合层 →
  - icon: 🛠️
    title: 系统层（system）
    details: devframe RPC 一份 handler 多种传输、Backend 三态前端、WebContainer 浏览器内 pnpm、CLI 多形态、五种可视化视角。
    link: /guide/13-devframe-rpc
    linkText: 进入系统层 →

---

# node-modules-inspector 源码导读

> 一份对 [node-modules-inspector](https://github.com/antfu/node-modules-inspector) 工程的逐章深度拆解。每章从「一个工程师会问的真实问题」切入，展开核心机制、最小可跑演示、关键权衡——读完每一章你都能回答「为什么这么设计、换来了什么、代价是什么」。

## 三层共十七章

全站按 **primitive → composite → system** 三层共 17 章组织，章节顺序严格按依赖关系拓扑排序——后面的章节建立在前面章节建立的物理基础之上，可以按顺序读，也可以跳读。

- **原子层（6 章）**：解决「从磁盘到一份节点表」的全部底层问题。
- **复合层（6 章）**：在节点表之上构造「富信息节点 + 过滤器 + 响应式数据流」。
- **系统层（5 章）**：把所有能力做成 dev/static/webcontainer 三态可跑、CLI 五形态可调用、五种视角可看。

## 快速开始

```bash
# 安装依赖（任选其一）
pnpm install
# 或 npm install
# 或 bun install

# 启动本地开发服务器
pnpm docs:dev

# 构建静态产物（产物在 .vitepress/dist 下）
pnpm docs:build

# 本地预览构建产物
pnpm docs:preview
```

## 这份导读适合谁

- **想读懂 antfu 这套工具实现的人**：每章贴源码、给执行轨迹、不省略「为什么」。
- **想抄设计思路的人**：每章末尾的关键权衡都按「做了什么 → 换来了什么 → 代价是什么」三段式展开，便于在自己项目里复用同样的取舍。
- **想讲清楚复杂工程的人**：本书的写作风格——「从工程师会问的真实问题切入、用类比 + 最小可跑演示 + 执行轨迹」——可以作为讲技术文章的范本。

## 写作约定

- **代码 / 路径 / slug / 字段名**：保留英文原文，便于与源码对照。
- **叙述文字**：全程中文。
- **章节标题**：来自原文 `work/outline.json` 的 `title` 字段，与源仓库的领域用语一致。

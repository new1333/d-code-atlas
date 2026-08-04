---
layout: home

hero:
  name: "mitt"
  text: "源码逐层解读"
  tagline: 一个约 200 字节的事件发射器，从一张 Map 到多格式分发的完整旅程
  actions:
    - theme: brand
      text: 导读
      link: /guide/00-prologue
    - theme: alt
      text: 第一章
      link: /guide/01-emitter-state-as-map

features:
  - title: 原子层
    details: 一张 Map 当唯一状态、无 this 的函数工厂、惰性追加式订阅、无分支安全移除与重载清空。
  - title: 复合层
    details: 快照式派发抵御中途改表、通配符保留键的第二条派发路径、一张 Events 映射派生全 API 类型、条件类型区分可选载荷事件。
  - title: 系统层
    details: 一份 TS 源码经 microbundle 产出 ESM/CJS/UMD，靠 package.json 条件 exports 通吃所有 JS 运行时。
---

## 快速开始

```sh
cd site
bun install        # 或 npm install
bun run docs:dev   # 本地预览：http://localhost:5173
```

构建静态站点：

```sh
bun run docs:build
```

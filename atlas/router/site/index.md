---
layout: home

hero:
  name: "vue-router 源码解读"
  text: "Code Atlas"
  tagline: 逐章拆解 vue-router——从 URL 编码、路径评分，到可取消的导航状态机、文件路由与编译期类型生成。
  actions:
    - theme: brand
      text: 开始阅读
      link: /guide/00-prologue
    - theme: alt
      text: 第一章
      link: /guide/01-url-encoding-query

features:
  - title: 结构化语义优先
    details: 路由在内部是一条从根到叶排好序的 matched 记录链。"我在哪""渲染谁""谁高亮"都靠这条链的引用、包含、下标关系精确得出，而非比字符串前缀。
  - title: 把能前移的全部前移
    details: 评分在注册期算、匹配表在注册期编译、类型在构建期推导——运行期热路径几乎只剩一次正则命中与一次指针回溯。
  - title: 失败即结构化控制流
    details: 中止、取消、重定向、未匹配都是带种类、可恢复的结构化值，不再笼统地 throw，也不污染错误通道。
  - title: 可取消的异步导航
    details: 一块公共白板记下当前在途的导航，每个阶段之间插一道"我还是不是最新那次"的身份校验。
---

## 快速开始

```sh
bun install
bun run docs:dev      # 启动本地开发服务器
bun run docs:build    # 构建静态站点
bun run docs:preview  # 预览构建产物
```

全书十六章按 `primitive → composite → system` 三层组织：原子层铺地基零件，复合层总装成导航机器，系统层再把动态性与正确性尽量推到构建期。建议从 [导读](/guide/00-prologue) 进入，或按侧边栏顺序线性阅读。

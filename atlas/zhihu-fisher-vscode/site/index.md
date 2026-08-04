---
hero:
  name: zhihu-fisher-vscode
  text: 源码解读
  tagline: 一个让你在 VSCode 里偷偷刷知乎的摸鱼扩展——十三章逐层拆解它的两件原语。
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 直接看第一章
      link: /guide/01-global-shared-store
---

## 这本书在讲什么

zhihu-fisher-vscode 把知乎搬进 VSCode：侧边栏热榜、详情阅读、评论翻页、收藏夹、扫码登录，必要时还能伪装成代码文件。剥开功能清单往下看一层，它在反复用两件原语对抗两重外部约束：

1. **一个模块级可变单例容器**——所有模块 `import` 同一个对象，换来零胶水跨模块通信。
2. **一台伪装好的真实 Chrome**——替扩展去跑知乎自己的加密 JS，把「对抗」降级成「伪装」。

全书十三章，都是这两件原语在不同业务面的具象化。

## 快速开始

```bash
# 安装依赖（任选其一）
bun install
# 或 npm install / pnpm install

# 本地起 dev server
bun run docs:dev

# 构建静态站点
bun run docs:build
```

## 怎么读

- **线性路线**：按侧边栏顺序（导读 → 原子层 → 复合层 → 系统层），每章承接前一章打开的新问题。
- **主题路线**：见导读章，按你想搞懂的目标（反爬对抗 / VSCode 平台契约 / 分页缓存 / 伪装 / 读写分工 / 装配）挑一条子序列。

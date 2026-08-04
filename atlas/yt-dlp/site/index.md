---
layout: home

hero:
  name: yt-dlp
  text: 架构逐层拆解
  tagline: 从可插拔传输层、插件注册、info_dict 数据总线，到协议驱动下载与声明式后处理——读懂这个视频下载利器如何把「发请求 / 解析 / 下载 / 加工」压成一条贯穿始终的 info_dict 主管线。
  actions:
    - theme: brand
      text: 从导读开始
      link: /guide/00-prologue
    - theme: alt
      text: 直接看原子层
      link: /guide/01-networking-abstraction

features:
  - icon: 🧩
    title: 可插拔传输层
    details: Request/Response 与传输中立，多个 RequestHandler 竞争，RequestDirector 按偏好函数择优，能力探测换来多后端可插拔与优雅降级。
    link: /guide/01-networking-abstraction
  - icon: 📋
    title: 约定胜配置的插件
    details: MetaPathFinder 造虚拟命名空间包 + 类名后缀约定(IE/PP/RH) + Indirect 全局查表，丢一个文件即注册新提取器/后处理器/请求处理器。
    link: /guide/02-plugin-registry
  - icon: 🗂️
    title: info_dict 数据总线
    details: 一个字段极丰富的字典在 提取器→编排器→下载器→后处理器 间流动，各阶段对其做纯变换，InfoExtractor 基类吸收全部抓取样板。
    link: /guide/04-info-dict-contract
  - icon: ⬇️
    title: 协议驱动下载
    details: protocol 字段决定下载策略，get_suitable_downloader 把协议映射到 FileDownloader 子类，外部下载器可自荐接管。
    link: /guide/06-downloader-framework
  - icon: 🔧
    title: 声明式后处理
    details: 一条 PP 链：每个 PostProcessor.run 接收并返回 (待删文件列表, info)，CLI 开关被翻译成有序的声明式流水线。
    link: /guide/08-postprocessor-pipeline
  - icon: 🎛️
    title: YoutubeDL 编排器
    details: 一个胖协调器把 extract_info→选格式→下载→后处理串成主管线，独占 cookiejar、urlopen 门面、去重归档等横切关注点。
    link: /guide/12-orchestrator-pipeline
---

## 快速开始

本站是一个自包含的 VitePress 工程，构建与本地预览零外部服务依赖。

```bash
# 进入站点目录
cd site

# 安装依赖（任选其一）
bun install        # 推荐：最快
# npm install
# pnpm install

# 本地开发预览（热更新）
bun run docs:dev

# 生产构建（产出 site/.vitepress/dist）
bun run docs:build

# 本地预览构建产物
bun run docs:preview
```

构建产物位于 `site/.vitepress/dist`，可托管至任意静态站点服务（GitHub Pages、Cloudflare Pages、Netlify 等），实现站点独立部署。

# site/ 是完整自包含、可独立部署的 VitePress 工程

Assembler 的产出不是裸 markdown，而是一个能 `cd site && bun install && bun run docs:build` 直接构建部署的完整工程：`package.json`（pin vitepress 依赖）、`.vitepress/config.ts`（侧边栏按 outline 的 `level` 分组、章节按拓扑顺序自动排序与编号）、`index.md`（首页）、`guide/{nn-slug}.md`（各章）。

> **关于章节内嵌的原理演示**（2026-07 修订）：本 ADR 原要求"每章内嵌最小**可运行的 ts/js** 复刻 + `replica/` 可运行副本"。现放宽为：演示载体**按被分析仓库的主语言/类型选择**——TS/JS 仓库仍可写成能 `bun run`/`node` 跑的脚本（能跑最好，**非硬要求**）；Go/Rust/Python 等用各自惯用法；VSCode 扩展 / IDE 插件 / 需要宿主或图形界面的机制，演**机制骨架 + 文字执行轨迹**即可，不强求真跑。`replica/` 落盘在 stdout 输出模式下也已非硬要求。一句话：**演示服务于"演透原理"，不是服务于"能跑"。** 原则不变的是 site/ 工程本身仍可独立部署（上一句）。

代价是多生成脚手架文件；收益是产物即开即用、不依赖外部预设环境——满足"完整源码可独立部署"。

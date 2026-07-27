# site/ 是完整自包含、可独立部署的 VitePress 工程

Assembler 的产出不是裸 markdown，而是一个能 `cd site && bun install && bun run docs:build` 直接构建部署的完整工程：`package.json`（pin vitepress 依赖）、`.vitepress/config.ts`（侧边栏按 outline 的 `level` 分组、章节按拓扑顺序自动排序与编号）、`index.md`（首页）、`guide/{nn-slug}.md`（各章）。每章 markdown 内嵌一段最小可运行的 ts/js 复刻（把该章原理用几十行重实现），`work/chapters/{slug}/replica/` 另存可运行副本供 Writer/Critic 校验。代价是多生成脚手架文件；收益是产物即开即用、不依赖外部预设环境——满足"完整源码可独立部署"。

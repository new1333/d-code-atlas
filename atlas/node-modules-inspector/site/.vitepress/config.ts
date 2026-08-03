import { defineConfig } from "vitepress";

export default defineConfig({
  title: "node-modules-inspector 源码导读",
  description:
    "一份对 node-modules-inspector 工程的逐章深度拆解：从流式 JSON 解析、依赖图物化、过滤器 DSL，到 WebContainer、CLI 多形态与可视化层。",
  lang: "zh-CN",
  lastUpdated: true,
  cleanUrls: true,
  themeConfig: {
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一章", next: "下一章" },
    sidebar: [
      {
        text: "原子层",
        collapsed: false,
        items: [
          {
            text: "流式 JSON 解析：应付百万行依赖输出",
            link: "/guide/01-json-stream-parser",
          },
          {
            text: "包管理器策略：pnpm/npm/bun 三态归一",
            link: "/guide/02-package-manager-strategy",
          },
          {
            text: "依赖图物化：flatDeps/dependents/depth 一次算清",
            link: "/guide/03-dep-graph-materialize",
          },
          {
            text: "静态推断模块类型 cjs/esm/dual/faux/dts",
            link: "/guide/04-module-type-analyzer",
          },
          {
            text: "安装体积测算与文件类别分类",
            link: "/guide/05-install-size-classifier",
          },
          {
            text: "package.json 字段规范化（author/repo/license/funding）",
            link: "/guide/06-pkg-json-normalizer",
          },
        ],
      },
      {
        text: "复合层",
        collapsed: false,
        items: [
          {
            text: "resolvePackage：把磁盘包变可读节点",
            link: "/guide/07-resolve-package-pipeline",
          },
          {
            text: "过滤器与搜索：声明式 schema + 字段 DSL",
            link: "/guide/08-filters-and-search",
          },
          {
            text: "维护者行动算法：迁移比例与 catalog 解析",
            link: "/guide/09-maintainer-action-cohort",
          },
          {
            text: "npm 元信息拉取：批量化、TTL、漏洞",
            link: "/guide/10-npm-meta-fetch",
          },
          {
            text: "响应式 payload 级联：main→excluded→available→filtered",
            link: "/guide/11-computed-payload-cascade",
          },
          {
            text: "URL ↔ 状态双向绑定",
            link: "/guide/12-query-url-binding",
          },
        ],
      },
      {
        text: "系统层",
        collapsed: false,
        items: [
          {
            text: "devframe RPC：一份 handler，多种传输",
            link: "/guide/13-devframe-rpc",
          },
          {
            text: "Backend 抽象：dev/static/webcontainer 三态前端",
            link: "/guide/14-backend-abstraction",
          },
          {
            text: "WebContainer：浏览器里跑真 pnpm",
            link: "/guide/15-webcontainer-runtime",
          },
          {
            text: "CLI 多形态：dev/build/check/report/mcp",
            link: "/guide/16-cli-commands",
          },
          {
            text: "可视化层：treemap/sunburst/flamegraph/graph/grid",
            link: "/guide/17-visualizations",
          },
        ],
      },
    ],
  },
});

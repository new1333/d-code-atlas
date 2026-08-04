import { defineConfig } from "vitepress";

// 本文件由 Assembler 用字符串模板生成，所有数据硬编码（ADR-0006 自包含）。
// 侧边栏分组顺序固定：导读(若有) → 原子层(primitive) → 复合层(composite) → 系统层(system)；
// 组内顺序 = outline.json 的 topoOrder（不是字母序）。
export default defineConfig({
  title: "vue-router 源码解读",
  description:
    "逐章拆解 vue-router 源码：从 URL 编码、路径评分，到可取消的导航状态机、文件路由与编译期类型生成。",
  lang: "zh-CN",
  lastUpdated: true,
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，符合 ADR-0006 自包含）。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：work/prologue/draft.md 存在，固定为侧边栏首组。
        text: "导读",
        items: [{ text: "导读", link: "/guide/00-prologue" }],
      },
      {
        text: "原子层",
        items: [
          { text: "URL 分段编码与查询串", link: "/guide/01-url-encoding-query" },
          { text: "路由位置与 URL 解析", link: "/guide/02-route-location-url" },
          {
            text: "路径模式编译与优先级评分",
            link: "/guide/03-path-pattern-ranking",
          },
          {
            text: "导航失败的语义化分类",
            link: "/guide/04-navigation-failure-types",
          },
          {
            text: "History 抽象：URL 模型的可导航可监听接口",
            link: "/guide/05-history-abstraction",
          },
        ],
      },
      {
        text: "复合层",
        items: [
          {
            text: "路由匹配表：从配置到 matched 链",
            link: "/guide/06-route-matcher-table",
          },
          { text: "导航守卫管线", link: "/guide/07-navigation-guards" },
          { text: "滚动位置恢复", link: "/guide/08-scroll-restoration" },
          {
            text: "Router 核心与导航主循环",
            link: "/guide/09-router-core-navigation",
          },
          { text: "RouterView 嵌套渲染", link: "/guide/10-router-view-nesting" },
          {
            text: "RouterLink 与激活态判定",
            link: "/guide/11-router-link-active",
          },
        ],
      },
      {
        text: "系统层",
        items: [
          {
            text: "类型安全路由的编译期推导",
            link: "/guide/12-typed-routes",
          },
          {
            text: "文件路由：约定与前缀树",
            link: "/guide/13-file-routing-conventions",
          },
          { text: "导航期数据加载器", link: "/guide/14-data-loaders" },
          { text: "新一代路由解析器", link: "/guide/15-route-resolver" },
          {
            text: "文件路由：类型生成与构建期集成",
            link: "/guide/16-file-routing-codegen",
          },
        ],
      },
    ],
  },
});

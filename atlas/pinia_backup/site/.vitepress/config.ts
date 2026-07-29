import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pinia",
  description: "Pinia 源码精读 · Code Atlas（primitive → composite → system 三层逐章拆解）",
  lang: "zh-CN",
  lastUpdated: true,
  themeConfig: {
    outline: { level: [2, 3], label: "本章目录" },
    docFooter: { prev: "上一章", next: "下一章" },
    sidebar: [
      {
        text: "原子层",
        items: [
          { text: "核心类型契约与全局声明", link: "/guide/01-core-types" },
          { text: "发布-订阅原语", link: "/guide/02-subscription-primitive" },
          { text: "运行时诊断与错误码体系", link: "/guide/03-diagnostics" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "Pinia 根实例与活跃上下文", link: "/guide/04-pinia-instance" },
          { text: "store 的定义与实例化", link: "/guide/05-store-definition" },
          { text: "store 实例的变更与订阅 API", link: "/guide/06-store-instance-api" },
          { text: "响应式引用提取", link: "/guide/07-store-to-refs" },
          { text: "Options API 映射辅助", link: "/guide/08-map-helpers" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "模块热更新支持", link: "/guide/09-hmr" },
          { text: "Vue Devtools 集成", link: "/guide/10-devtools" },
          { text: "@pinia/nuxt 模块与 SSR payload", link: "/guide/11-nuxt-module" },
          { text: "@pinia/testing 测试夹具", link: "/guide/12-testing" },
        ],
      },
    ],
  },
});

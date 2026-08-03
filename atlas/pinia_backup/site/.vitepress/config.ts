import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pinia 源码导读",
  description: "从 effectScope 到 Nuxt 集成：分层拆解 Pinia 的设计与实现",
  lang: "zh-CN",
  cleanUrls: true,
  themeConfig: {
    search: { provider: "local" },
    sidebar: [
      {
        text: "原子层",
        items: [
          {
            text: "Pinia 实例：用 effectScope 持有全局状态",
            link: "/guide/01-effect-scope-pinia",
          },
          {
            text: "订阅原语：Set + onScopeDispose 的自动回收",
            link: "/guide/02-subscriptions",
          },
          {
            text: "$patch 与深度合并：批量变更的统一入口",
            link: "/guide/03-patch-and-merge",
          },
          {
            text: "Action 包装：before/after/onError 三段拦截",
            link: "/guide/04-action-wrapping",
          },
          {
            text: "storeToRefs：从 reactive store 解构出 refs",
            link: "/guide/05-store-to-refs",
          },
        ],
      },
      {
        text: "复合层",
        items: [
          {
            text: "defineStore：懒注册与 store 注册表",
            link: "/guide/06-store-definition-registry",
          },
          {
            text: "Setup Store 构建器：分类 setup 返回值为 state/getter/action",
            link: "/guide/07-setup-store-builder",
          },
          {
            text: "Options Store 适配：声明式选项翻译成 setup",
            link: "/guide/08-options-store-adapter",
          },
          {
            text: "State 集中化与 SSR hydration",
            link: "/guide/09-state-centralization-and-hydration",
          },
          {
            text: "插件系统：扩展每一个 store",
            link: "/guide/10-plugin-system",
          },
        ],
      },
      {
        text: "系统层",
        items: [
          {
            text: "HMR：保留状态下的 store 热更新",
            link: "/guide/11-hmr",
          },
          {
            text: "Vue DevTools 集成：时间线与 store 检查器",
            link: "/guide/12-devtools-integration",
          },
          {
            text: "mapHelpers：Options API 兼容垫片",
            link: "/guide/13-map-helpers-options-api",
          },
          {
            text: "@pinia/nuxt：SSR payload 状态运输与自动导入",
            link: "/guide/14-nuxt-module",
          },
          {
            text: "@pinia/testing：用插件桩化 action 与 $patch",
            link: "/guide/15-testing-pinia",
          },
        ],
      },
    ],
  },
});

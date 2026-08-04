import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Pinia",
  description:
    "Vue 官方状态管理库 Pinia 的源码解读——从响应式托管、全局活跃上下文，到装配流水线、订阅系统，再到 SSR、HMR、DevTools 与测试的完整机制拆解。",
  lang: "zh-CN",
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：全书级入口，固定为侧边栏首组。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          {
            text: "Pinia 实例：根状态、注册表与全局活跃上下文",
            link: "/guide/01-pinia-instance-active-context",
          },
          {
            text: "订阅原语：回调集合与作用域自动清理",
            link: "/guide/02-subscription-primitive",
          },
        ],
      },
      {
        text: "复合层",
        items: [
          {
            text: "defineStore：惰性 useStore 闭包与注册表缓存",
            link: "/guide/03-define-store-hook",
          },
          {
            text: "Store 装配：effectScope 托管的返回值分类与状态镜像",
            link: "/guide/04-store-assembly",
          },
          {
            text: "状态变更模型：$patch 双形态与暂停监听批处理",
            link: "/guide/05-state-patch-model",
          },
          {
            text: "订阅系统：$onAction 的动作包裹与 $subscribe 的监听协调",
            link: "/guide/06-action-state-subscriptions",
          },
          {
            text: "Options Store：双作者语法统一于单一装配路径",
            link: "/guide/07-options-store-unification",
          },
          {
            text: "storeToRefs：从 reactive store 定向提取 ref",
            link: "/guide/08-store-to-refs",
          },
          {
            text: "插件系统：context 注入的 store 增强",
            link: "/guide/09-plugin-system",
          },
          {
            text: "mapHelpers：组合式 store 到 Options API 的适配层",
            link: "/guide/10-map-helpers-options-api",
          },
        ],
      },
      {
        text: "系统层",
        items: [
          {
            text: "HMR：保留状态的就地热更新",
            link: "/guide/11-hmr-hot-update",
          },
          {
            text: "DevTools 集成：作为 Pinia 插件的可观测层",
            link: "/guide/12-devtools-plugin",
          },
          {
            text: "SSR 与状态水合：单一根状态的序列化契约",
            link: "/guide/13-ssr-hydration",
          },
          {
            text: "Nuxt 模块：自动导入、运行时插件与自动 HMR 的框架集成",
            link: "/guide/14-nuxt-module",
          },
          {
            text: "测试：以插件重塑 store 行为",
            link: "/guide/15-testing-pinia",
          },
        ],
      },
    ],
  },
});

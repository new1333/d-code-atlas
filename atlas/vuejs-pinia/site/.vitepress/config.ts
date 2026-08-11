import { defineConfig } from "vitepress";

export default defineConfig({
  title: "vuejs-pinia 源码解读",
  description: "三块基础设施加一条总线，撑起 Pinia 的整个生态",
  lang: "zh-CN",
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。缺失则站点不出现搜索框——必须配。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：固定为侧边栏首组（work/prologue/draft.md 存在时出现）。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          { text: "随作用域清理的发布订阅", link: "/guide/01-subscription-scope-cleanup" },
          { text: "Pinia 容器与集中式状态树", link: "/guide/02-pinia-container-state-tree" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "活跃实例指针：在任意上下文找回 Pinia", link: "/guide/03-active-pinia-pointer" },
          { text: "defineStore 的懒装配与循环引用破解", link: "/guide/04-define-store-lazy-init" },
          { text: "Setup Store 的运行时自动分流", link: "/guide/05-setup-store-runtime-classify" },
          { text: "Options Store：声明式三分与统一组装", link: "/guide/06-options-store-three-way" },
          { text: "状态变更的双管道：动作拦截与批量合并", link: "/guide/07-mutation-dual-pipeline" },
          { text: "在组件中消费 Store：解构与映射", link: "/guide/08-consume-store-in-component" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "插件扩展总线", link: "/guide/09-plugin-extension-bus" },
          { text: "热更新与 Store 身份保持", link: "/guide/10-hmr-identity-preservation" },
          { text: "开发者工具的可观测性接入", link: "/guide/11-devtools-observability" },
          { text: "服务端渲染的状态传递", link: "/guide/12-ssr-state-transfer" },
          { text: "测试替身：借插件实现 Mock", link: "/guide/13-testing-mock-via-plugin" },
        ],
      },
    ],
  },
});

import { defineConfig } from "vitepress";

// 站点配置：自包含（所有数据硬编码于此，不运行时 import outline.json）。
// 侧边栏按 layer 分组（primitive → composite → system），组内按 topoOrder 顺序。
export default defineConfig({
  title: "Pinia 源码图谱",
  description: "逐层拆解 Pinia 响应式状态管理内核的源码导读",
  lang: "zh-CN",
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    outline: { level: [2, 3], label: "本页导航" },
    docFooter: {
      prev: "上一章",
      next: "下一章",
    },
    sidebar: [
      {
        text: "原子层",
        items: [
          {
            text: "全局活跃指针与 Pinia 实例契约",
            link: "/guide/01-active-pinia",
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
            text: "createPinia：effectScope 状态根与插件装载",
            link: "/guide/03-pinia-instance",
          },
          {
            text: "defineStore：useStore 工厂与懒实例化",
            link: "/guide/04-define-store",
          },
          {
            text: "store 装配机器：双形态归一与属性自动分类",
            link: "/guide/05-store-assembly",
          },
          {
            text: "$patch：状态变更与深度合并",
            link: "/guide/06-state-patch",
          },
          {
            text: "$subscribe 与 $onAction：状态及动作订阅",
            link: "/guide/07-subscriptions-actions",
          },
          {
            text: "storeToRefs：响应式引用的按型重建",
            link: "/guide/08-store-to-refs",
          },
          {
            text: "插件系统：store 扩展点与混入",
            link: "/guide/09-plugin-system",
          },
          {
            text: "HMR：保持引用的热迁移",
            link: "/guide/10-hmr",
          },
        ],
      },
      {
        text: "系统层",
        items: [
          {
            text: "mapHelpers：Options API 适配",
            link: "/guide/11-map-helpers",
          },
          {
            text: "Vue Devtools 集成",
            link: "/guide/12-devtools",
          },
          {
            text: "测试替身：作为插件链的 spy 注入",
            link: "/guide/13-testing-pinia",
          },
          {
            text: "Nuxt SSR：payload 序列化与自动导入",
            link: "/guide/14-nuxt-ssr",
          },
          {
            text: "诊断目录：dev-only 可索引警告系统",
            link: "/guide/15-diagnostics",
          },
        ],
      },
    ],
  },
});

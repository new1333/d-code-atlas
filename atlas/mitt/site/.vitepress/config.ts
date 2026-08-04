import { defineConfig } from "vitepress";

export default defineConfig({
  title: "mitt",
  description: "一个约 200 字节的事件发射器——源码逐层解读的 Code Atlas",
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。缺失则站点不出现搜索框——必须配。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：work/prologue/draft.md 存在，固定为侧边栏首组。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          { text: "把 pubsub 退化成一张查找表", link: "/guide/01-emitter-state-as-map" },
          { text: "函数工厂与无 this 的方法", link: "/guide/02-functional-factory-no-this" },
          { text: "惰性初始化的追加式订阅", link: "/guide/03-on-lazy-append" },
          { text: "无分支安全移除与重载清空", link: "/guide/04-off-branchless-removal" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "快照式派发抵御中途改表", link: "/guide/05-emit-snapshot-iteration" },
          { text: "通配符星号的第二条派发路径", link: "/guide/06-wildcard-dispatch" },
          { text: "一张 Events 映射派生全 API 类型", link: "/guide/07-events-type-inference" },
          { text: "条件类型区分可选载荷事件", link: "/guide/08-optional-payload-conditional-type" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "一源多格式通吃所有 JS 运行时", link: "/guide/09-package-multi-format-distribution" },
        ],
      },
    ],
  },
});

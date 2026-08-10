import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Vue Macros 源码解读",
  description: "Vue Macros 源码解读 —— 编译期宏如何用变换换零运行时",
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
          { text: "编译期宏的本质：运行时不存在的「变换提示」", link: "/guide/01-compiler-macro-essence" },
          { text: "<script setup> 与内置宏的设计动机", link: "/guide/02-script-setup-macros" },
          { text: "SFC 编译管线与宏的注入时机", link: "/guide/03-sfc-compile-pipeline" },
          { text: "靠 AST 而非正则识别宏调用节点", link: "/guide/04-ast-traversal" },
          { text: "magic-string：sourcemap 友好的源码就地变换", link: "/guide/05-magic-string-sourcemap" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "Vue Macros 的宏变换流水线", link: "/guide/06-macro-transform-pipeline" },
          { text: "宏的设计原型：把什么前移到编译期", link: "/guide/07-macro-design-catalog" },
          { text: "unplugin：跨构建工具的统一插件抽象", link: "/guide/08-unplugin-abstraction" },
          { text: "Volar 的虚拟代码生成与位置回映", link: "/guide/09-volar-virtual-code" },
          { text: "Vue Language Plugin 接口与 SFC 解析扩展点", link: "/guide/10-volar-language-plugin" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "双轨制：编译变换与 IDE 类型支持为何必须并存", link: "/guide/11-dual-track-compile-and-ide" },
          { text: "vue-tsc：在 CLI 复用 Volar 插件做类型检查", link: "/guide/12-vue-tsc-type-check" },
          { text: "配置系统：一份配置驱动两条管线", link: "/guide/13-config-and-feature-flags" },
          { text: "根本权衡：零运行时 vs 可调试性，以及宏的生态演进", link: "/guide/14-tradeoffs-cost-debugging" },
        ],
      },
    ],
  },
});

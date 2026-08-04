import { defineConfig } from "vitepress";

export default defineConfig({
  title: "vue-macros Atlas",
  description: "vue-macros 源码解读：30+ 个宏共用同一套机制、各自的复杂度都花在边界上",
  lang: "zh-CN",
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。
    search: {
      provider: "local",
    },
    sidebar: [
      {
        // 导读组：prologue 是全书级入口，固定为侧边栏首组。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        // 原子层（primitive）：第 1-3 章
        text: "原子层",
        items: [
          { text: "SFC 解析与增量 AST 编辑", link: "/guide/01-sfc-parse-and-ast-edit" },
          { text: "一次编写、六套构建器适配的 unplugin 模式", link: "/guide/02-unplugin-multi-bundler" },
          { text: "编译期注入虚拟 helper 模块", link: "/guide/03-virtual-helper-module" },
        ],
      },
      {
        // 复合层（composite）：第 4-12 章
        text: "复合层",
        items: [
          { text: "props/emit 宏的编译期重写与类型转换", link: "/guide/04-props-emit-macro-rewrite" },
          { text: "defineModels：从类型合成 props/emits 双向绑定", link: "/guide/05-define-models-two-way-binding" },
          { text: "better-define：把 TS 类型降级为运行时校验", link: "/guide/06-better-define-type-to-runtime" },
          { text: "响应式语法糖：赋值即 .value", link: "/guide/07-reactivity-transform" },
          { text: "突破单 script setup 的 SFC 结构扩展", link: "/guide/08-sfc-structure-extensions" },
          { text: "在 JSX 里镜像 Vue 模板指令", link: "/guide/09-jsx-directives" },
          { text: "模板与渲染函数的重定向", link: "/guide/10-template-and-render-redirect" },
          { text: "静态提升与 export 语义重写", link: "/guide/11-hoist-static-and-export-rewrite" },
          { text: "为旧版本补齐与简化样板的语法垫片", link: "/guide/12-syntax-shims" },
        ],
      },
      {
        // 系统层（system）：第 13-16 章
        text: "系统层",
        items: [
          { text: "统一配置体系与版本感知默认值", link: "/guide/13-config-version-aware" },
          { text: "主聚合插件与转换管道顺序编排", link: "/guide/14-macros-pipeline" },
          { text: "volar：编译期能力的 IDE 镜像", link: "/guide/15-volar-ide-mirror" },
          { text: "Nuxt / Astro / DevTools 框架集成", link: "/guide/16-framework-integration" },
        ],
      },
    ],
  },
});

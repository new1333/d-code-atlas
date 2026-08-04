import { defineConfig } from "vitepress";

export default defineConfig({
  // 站名取自仓库元数据（repo 字段）
  title: "yt-dlp",
  description:
    "从可插拔传输层、插件注册、info_dict 数据总线，到协议驱动下载与声明式后处理——逐层拆解 yt-dlp 的架构。",
  lang: "zh-CN",
  lastUpdated: true,
  cleanUrls: true,
  themeConfig: {
    // 启用 VitePress 内置本地搜索（基于 MiniSearch，零外部服务、零额外依赖，
    // 符合 ADR-0006 自包含）。缺失则站点不出现搜索框——必须配。
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
      label: "本页内容",
    },
    docFooter: {
      prev: "上一章",
      next: "下一章",
    },
    // 侧边栏：数据硬编码（字符串模板生成，不在运行时读取大纲文件，保持 site 自包含 ADR-0006）。
    // 分组顺序固定：导读(因 prologue 存在) → 原子层(primitive) → 复合层(composite) → 系统层(system)。
    // 组内顺序 = topoOrder（不是字母序）。
    sidebar: [
      {
        // 导读组：因存在导读章节而出现，固定为侧边栏首组。
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          { text: "可插拔传输层：请求中立与处理器竞争", link: "/guide/01-networking-abstraction" },
          { text: "约定胜配置的插件注册机制", link: "/guide/02-plugin-registry" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "浏览器指纹伪装：作为扩展叠加的传输能力", link: "/guide/03-impersonation" },
          { text: "info_dict 数据总线与提取器骨架", link: "/guide/04-info-dict-contract" },
          { text: "进程内手写 JS 解释器：本地执行对抗性脚本", link: "/guide/05-js-interpreter" },
          { text: "协议字段驱动的下载策略分派", link: "/guide/06-downloader-framework" },
          { text: "分片化下载：把长流拆成可恢复的工作单元", link: "/guide/07-fragment-downloading" },
          { text: "声明式后处理流水线与链式 info 变换", link: "/guide/08-postprocessor-pipeline" },
          { text: "格式选择 DSL：从 -f 串到选择器 AST", link: "/guide/09-format-selection" },
          { text: "输出模板引擎：命名即元数据投影", link: "/guide/10-output-template" },
          { text: "统一 cookiejar：从浏览器密钥环解密登录态", link: "/guide/11-cookies" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "YoutubeDL 编排器：贯穿各阶段的 info_dict 主管线", link: "/guide/12-orchestrator-pipeline" },
          { text: "CLI 层：从命令行表面到 ydl_opts 与声明式流水线", link: "/guide/13-cli-options" },
        ],
      },
    ],
  },
});

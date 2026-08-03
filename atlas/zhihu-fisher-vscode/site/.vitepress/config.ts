import { defineConfig } from "vitepress";

export default defineConfig({
  title: "zhihu-fisher-vscode 源码解读",
  description: "一个让你在 VSCode 里偷偷刷知乎的摸鱼扩展——十三章逐层拆解它的两件原语：全局共享状态容器与一台替你跑知乎加密 JS 的真实 Chrome。",
  themeConfig: {
    search: {
      provider: "local",
    },
    sidebar: [
      {
        text: "导读",
        items: [
          { text: "导读", link: "/guide/00-prologue" },
        ],
      },
      {
        text: "原子层",
        items: [
          { text: "全局共享状态容器", link: "/guide/01-global-shared-store" },
          { text: "Cookie 凭证的清洗与校验", link: "/guide/02-cookie-manager" },
          { text: "防反爬浏览器引擎", link: "/guide/03-puppeteer-browser-engine" },
          { text: "知乎 JSON API 写操作客户端", link: "/guide/04-zhihu-api-client" },
        ],
      },
      {
        text: "复合层",
        items: [
          { text: "侧边栏内容列表", link: "/guide/05-sidebar-tree-provider" },
          { text: "详情页爬取与反爬内容提取", link: "/guide/06-webview-content-crawling" },
          { text: "详情页 HTML 渲染与双向消息", link: "/guide/07-webview-render-messaging" },
          { text: "评论父子树的游标分页", link: "/guide/08-comments-cursor-pagination" },
          { text: "收藏夹树形结构与本地缓存", link: "/guide/09-collections-tree-cache" },
          { text: "智能伪装引擎", link: "/guide/10-smart-disguise-engine" },
        ],
      },
      {
        text: "系统层",
        items: [
          { text: "扫码登录全流程", link: "/guide/11-qr-login-flow" },
          { text: "侧边栏伪装成假文件树", link: "/guide/12-sidebar-disguise-filetree" },
          { text: "扩展激活与命令编排", link: "/guide/13-command-assembly" },
        ],
      },
    ],
  },
});

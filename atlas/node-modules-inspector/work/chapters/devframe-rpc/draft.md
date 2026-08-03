# devframe RPC：一份 handler，多种传输

想象你在维护一个工具——它能扫 node_modules、能跑 publint、能拉 npm registry。你最初只在浏览器里跑过它。但现在出现了五种入口想用同一份能力：浏览器实时分析、CI 检查、CLI 报表、给 AI agent 调用的 MCP 工具、还有打包成静态产物的前端 dump。如果每接一个入口都把业务逻辑复制一遍，五份代码各自漂移，bug 会改五次，缓存逻辑要写五份，每份都会忘掉一两个细节。

这一章讲的就是怎么避免这种漂移——把业务逻辑放在一个闭包里，让所有入口共用它，传输层各自处理自己的事。

## 1. 先有一块「业务闭包」

最底层的那块是一个工厂函数。它接受所有外部依赖（cwd、depth、配置文件路径、缓存用的 storage……），把这些东西一次性闭包进内部，然后吐出几个方法。说人话就是：这是一个「我拿到了所有上下文，现在可以干活了」的对象。

这个对象对外暴露 6 个方法：`getPayload`（读完整依赖图）、`getPackagesNpmMeta` / `getPackagesNpmMetaLatest`（拉 npm 元信息）、`getPublint`（跑 publint）、`openInEditor` / `openInFinder`（调系统命令）。注意，它**不**暴露内部的缓存变量——外部只能调方法，不能读 `_payload`。这种「方法在外、状态藏起来」的写法，让调用方天然不会去摸不该摸的东西。

> 顺手点一句：你可能在别的地方见过 `nmi:report-sizes` 这个 RPC 名。它**不**在 handler 上——它是一个独立的 RPC，内部 `await handlers.getPayload()` 复用上面那份读盘结果，然后跑 `computeInstallSizes` 算尺寸。这恰好印证了下面第五层要讲的：handler 闭包才是真正的复用单元，连「算尺寸」这种派生能力都是 handler 之上的薄包装。

类比一下：handler 闭包像一台烤箱，电源线（外部依赖）都接好了，面板上只有 6 个按钮（方法）。按钮怎么按、按完结果送哪儿去，是后面传输层的事。

## 2. 把单个方法包成一个「带名字的元组」

光有 handler 还不够——传输层不知道你想让它调用哪个方法、用哪种方式调用（要返回值还是触发副作用）、能不能把结果当 JSON 落盘。所以每个 RPC 文件做的事就是把 handler 上的一个方法包成一个元组：

```ts
{
  name: 'nmi:get-payload',
  type: 'query',
  handler: (force?: boolean) => handlers.getPayload(force),
}
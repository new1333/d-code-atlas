# 约定胜配置的插件注册机制

> 本章属于 primitive 层。无前置依赖章；与紧邻上一章的关系是对照而非承接——上一章的 RH（请求处理器）走**显式装饰器登记**，本章的 IE（提取器）/PP（后处理器）走完全相反的路：约定即登记，没有任何中心注册表。
> 学完你能：用一句话讲清「上千个提取器/后处理器不写一行登记代码就能被发现、还能被用户同名覆盖」——靠的是「后缀即令牌 + 延迟盒子 + 前置合并」三件套咬合。

## 1. 为什么需要它

上一章讲 RH（请求处理器）时，「注册」这件事一句话讲完：写一个 `@register_rh` 装饰器挂到类上，导入的瞬间类就把自己写进模块级 `_REQUEST_HANDLERS` 字典。这套显式登记能成立，是因为 RH 一只手数得过来——urllib、requests、websockets、curl_cffi，加起来不到十个。

但它留下的口子正等着本章撞上。yt-dlp 真正的规模在另一处：内置**提取器**一千多个（每个站点一个：YouTube、B 站、Twitter、Twitch……），**后处理器**十几个，社区每天都在贡献新站点。沿用「每个类写一行 `register`」的老办法会立刻撞上尴尬：

- 中心注册表膨胀到上千行，与源码强耦合——删/加一个类要改两处；
- 外部贡献者无法做到「丢一个文件就走」——必须找到那张表、编辑源码、重新打包发布；
- 用户也无法在不改源码的前提下，给某站点提取器打补丁。

这里要解决的矛盾是：**既要能无限扩展，又不能有任何中心化的登记动作**。

## 2. 核心思想

**类名后缀即注册令牌，散落目录即命名空间——约定即配置**。系统不维护「谁注册了」的清单；它只放一个空盒子在那里，等用到了再去扫「名字长得对的类」把它们填进去。

## 3. 心智模型

整个机制由三件套咬合而成。

**(a) 延迟绑定的「盒子」`Indirect`**。一个只包了 `.value` 字段的可变容器。`globals.py` 把所有跨模块共享的注册表都做成 `Indirect`——这样 `extractor/__init__.py` 在导入期就能 `from ..globals import extractors` 拿到盒子的**引用**，此时盒子里的真实字典还是空的，但没关系，引用是有效的。真实填值要等到运行期。

**(b) 规格卡 `PluginSpec`**。每一类插件登记一张四元组：模块名、后缀、主查表盒子（`destination`）、插件专用查表盒子（`plugin_destination`）。当前仓库里实际只有两张规格卡——提取器（后缀 `IE`）与后处理器（后缀 `PP`）。RH 不在这里，它走上一章那套装饰器。

**(c) 命名空间发现 + 前置合并**。注册规格卡时，把一个自定义查找器 `PluginFinder` 顶进 Python 导入链最前面，让它**独占**对 `yt_dlp_plugins.<kind>` 这一虚拟命名空间的解析权。等真正需要插件时（首次构造主编排器），系统把用户配置目录里散落的 `extractor/*.py` 当成命名空间包的搜索位置，逐个导入、按后缀挑类，最后用「首个非空胜出」的合并规则把插件**前置**并入主查表——同名时插件盖过内置。

有一个不变量贯穿全局：**主查表盒子在懒触发前是空的**。谁先读盒子很重要——读早了拿到空表，且不报错。

## 4. 关键权衡

### 后缀即类型，约定胜配置

**选择**：用类名后缀（`IE` / `PP`）判定一个类属于哪类插件，不写任何显式注册表。
**换来**：内置类与用户插件走完全相同的发现路径——丢一个文件即装好，无差别。
**代价**：类名受硬命名约束，**未带正确后缀的类会被静默忽略**——用户以为注册了，其实没有，且没有任何报错。
**化解的本质矛盾**：「无限可扩展」与「零中心配置」表面冲突——加能力通常意味着改一张表；这里把声明合并进类的命名，表就消失了。

### 先发盒子，后填值

**选择**：注册表用一个可变盒子对象 `Indirect`，而非直接字典。
**换来**：各模块在导入期就能拿到「将来才填充」的同一份共享注册表，**彻底打破循环依赖**——`extractor/__init__.py` 想在导入期引用提取器表，而表的填充又依赖插件加载、插件加载又可能反向引用提取器；盒子把「拿到引用」与「填值」拆到两个时刻，绕开了环。
**代价**：注册表的真实填充**被推迟到首次使用**，谁读早了（在懒触发之前取值）会拿到一张空表，时序错位会**静默失败**。
**化解的本质矛盾**：Python 模块导入顺序几乎不可重组，而注册表的填充又必须等所有相关模块都导入完；中间塞一个间接层，让「持有引用」和「写入数据」分别落在两个时刻，就同时满足了两个矛盾的时间约束。

### 借用语言导入系统造虚拟命名空间包

**选择**：不自写文件扫描器，而是把自定义查找器顶到 `sys.meta_path` 最前，让用户的插件目录被当成一个无 `__init__.py` 的命名空间包。
**换来**：插件可散落在多个用户/系统配置目录、甚至压缩包内——同一套机制覆盖单文件、目录、zip 三种载体，对用户而言「丢个文件夹即装好」。
**代价**：实现**深度依赖 Python 导入系统的内部细节**（`submodule_search_locations`、空操作加载器），可移植性差、向后兼容脆弱——源码注释明说本插件 API 不保证兼容。
**化解的本质矛盾**：「不重复造文件发现的轮子」与「要让用户目录看起来像包」本不可兼得；借力宿主语言已有的元路径机制，把扫描器问题降级成「往 Python 的查找器链里塞一个东西」。

### 前置合并，同名即覆盖

**选择**：合并规则用「首个非空胜出」，把插件类放第一个参数，于是插件**同名盖过内置**；另有一路 `override` 通过 `__init_subclass__` 就地 `setattr` 替换掉基础类在其模块里的名字。
**换来**：用户插件能**不改源码地给某站点提取器打补丁**——既支持「新增类」也支持「替换类」。
**代价**：覆盖**完全隐式**——同名即覆盖、与加载顺序敏感，调试时一眼看不出「某个内置类其实已被插件悄悄替换」，排错成本高。
**化解的本质矛盾**：「内置实现要稳健不被乱改」与「用户要能修 bug 不等上游」；用「插件在前、内置在后」的固定优先级把决定权交给用户目录里的命名，省去一套显式的覆盖声明。

## 5. 最小原理演示

下面这段 TS 把上面权衡①②④三件套演一遍。**唯独权衡③（借用 Python 导入系统）没法跨语言演**——那是 Python 专有语义，留在正文文字里讲。这里用「扫描一组模块对象、按后缀过滤」**模拟**「导入系统发现插件」这一步。

```ts
// 延迟绑定盒子：模块导入期就能拿到引用，真实字典运行期才填入
class Indirect<T> { value: T; constructor(initial: T) { this.value = initial; } }

interface Spec {
  suffix: string;
  destination: Indirect<Record<string, unknown>>;       // 主查表：内置 + 插件合并
  pluginDestination: Indirect<Record<string, unknown>>; // 仅插件查表（兼容旧式 import）
}

// 约定过滤：后缀即令牌；同时排除 override（PLUGIN_NAME 非 null）与 re-export
function getRegularClasses(mod: Record<string, any>, moduleName: string, suffix: string) {
  const picked: Record<string, any> = {};
  for (const [name, cls] of Object.entries(mod)) {
    if (typeof cls !== 'function') continue;
    if (!name.endsWith(suffix)) continue;        // 类名以后缀结尾
    if (cls.__module__ !== moduleName) continue; // 必须本模块定义（Python 自动给类挂 __module__）
    if (name.startsWith('_')) continue;          // 私有约定
    if (cls.PLUGIN_NAME != null) continue;       // override 类另走一路
    picked[name] = cls;
  }
  return picked;
}

// 首个非空胜出：插件作为第一参数，故同名时插件盖过内置
function mergeFirstWins(plugins: Record<string, any>, builtins: Record<string, any>) {
  const out: Record<string, any> = { ...builtins };
  for (const [k, v] of Object.entries(plugins)) {
    if (v != null) out[k] = v;
  }
  return out;
}

// 懒触发：把所有「用户模块」扫一遍，前置并入主盒子
function loadPlugins(spec: Spec, builtins: Record<string, any>, userModules: any[]) {
  const moduleName = 'yt_dlp_plugins.extractor';
  const regular: Record<string, any> = {};
  for (const mod of userModules) {
    Object.assign(regular, getRegularClasses(mod, moduleName, spec.suffix));
  }
  spec.pluginDestination.value = regular;                       // 整体替换插件盒
  spec.destination.value = mergeFirstWins(regular, builtins);   // 前置并入主盒
}
```

## 6. 执行轨迹

设用户在约定目录下放了一个 `extractor/myplugin.py`，里面定义了一个以 `IE` 结尾的类 `MyPluginIE`。

**态①·导入期**：`extractor/__init__.py` 被加载时，`register_plugin_spec` 把一张规格卡（后缀 `IE`）写入全局 `plugin_specs`，并把 `PluginFinder('yt_dlp_plugins.extractor')` 顶进 `sys.meta_path[0]`。此时 `extractors.value` 盒子存在但内容为空——内置提取器表也还没填。同时 `MyPluginIE` 的源代码还没被任何 import 触达。

**态②·首次构造主编排器**：`YoutubeDL.__init__` 检查 `all_plugins_loaded.value`，发现是 `False`，调 `load_all_plugins()`。该函数遍历每张规格卡，对 `yt_dlp_plugins.extractor` 触发一次 `import`——Python 导入系统从 `meta_path[0]` 开始问，命中 `PluginFinder`，它把用户配置目录里所有 `extractor/` 子目录算成命名空间包的 `submodule_search_locations`，`pkgutil.iter_modules` 枚举出 `myplugin`，逐个 `exec_module`。

**态③·约定过滤**：在刚导入的 `myplugin` 模块对象上跑 `get_regular_classes`——`MyPluginIE` 名字以 `IE` 结尾、`__module__` 以 `yt_dlp_plugins.extractor` 开头、非下划线、`PLUGIN_NAME is None`——全部命中，被收进 `regular`。

**态④·前置合并**：`extractors.value` 此时已被另一路填进内置提取器表（一千多个）。`merge_dicts(regular, extractors.value)` 走「首个非空胜出」——若 `MyPluginIE` 与某个内置类同名，插件胜出；若不同名，则新增。盒子被替换为合并后的字典。

**态⑤·消费**：之后任何「按 URL 匹配提取器」的调用读到的就是合并表——匹配 `MyPluginIE` 的 URL 会被它接管；用户若没放任何插件，盒子仅含内置，行为退化为纯内置。

## 7. 教学简化说明

本章演示故意省略了：真实文件系统扫描、压缩包（zip/egg/whl）内目录枚举与缓存、多配置目录（用户级/系统级/可执行文件同级/PYTHONPATH）的优先级收集与去重、`override` 包装链（沿 `__wrapped__` 找真实父类）、内置提取器「YouTube 最先、Generic 兜底」的排序微优化与懒生成。这些是工程化脚手架，不是原理。

## 8. 小结

把注册表做成「会延迟填值的盒子」，把「是哪类插件」编码进类名后缀，把「用户能不能盖过内置」交给合并顺序——三件套咬合后，「丢个文件即注册」无需任何中心登记表也成立。代价都落在「静默」二字上：名字拼错的类没人提醒你，读早了的盒子没人告诉你它还空着。

下一章讲「浏览器指纹伪装」——它不是新机制，而是**叠加在上一章的请求处理器之上**的能力：怎么在已有 RH 注册表的基础上，让带「伪装目标」的请求**偏好**那个真能改 TLS 指纹的 handler。
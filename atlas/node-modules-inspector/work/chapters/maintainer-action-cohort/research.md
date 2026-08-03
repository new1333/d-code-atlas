# 维护者行动算法：迁移比例与 catalog 解析 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：一个真实项目里常常装着几百上千个依赖，每个又拖出一长串传递依赖，结果同一个包往往并存 2、3、5 个版本。维护者面对这一团乱麻时最常问的问题不是"谁重复了"——而是「我该先升哪些？哪些已经迁过去了？还有谁卡在旧线？」没有一份"按消费方分组的待办清单"的话，这问题只能靠人肉翻每个 package.json。本机制要做的就是自动产出这份清单。

- **一句话核心思想**：先按依赖名把全场已安装版本聚成 cohort 拿到「最高 stable 版」基线，再用每条声明的 semver 范围去判它属于"已迁"还是"落后"，最后按消费方重组，就得到一张可行动的升级待办表。

- **设计动机（为什么需要它）**：迁移比例（migrated / total）天然是 0~1 之间的一个数，既能给单条声明打分、又能聚合到一个消费者头上做整体优先级排序；而「semver 范围判定」本身是纯静态、可批量重跑、不依赖网络的。把这两件事拼起来做成核心引擎，就把"该先升谁"这个主观问题降维成了一个数值排序问题——维护者不再需要读 package.json，只需要看一张按比例排好的表。

- **关键权衡（本 Atlas 的核心）**：
  - **跳过同仓库兄弟**：选择「消费方和候选包的 repository URL 相同就忽略」→ 换来了 monorepo 内部 alias（@scope/a 依赖 @scope/b 实为兄弟包）不会被误报成迁移机会 → 代价是没填 repository 字段的包会漏掉这层保护，可能产生本应被屏蔽的"假迁移机会"。
  - **只信 stable 版本做"最高版"基线**：选择「先 filter 掉 prerelease、只用 stable 排序取末位作最高版」→ 换来了迁移建议永远不会指向一个 alpha/beta（避免引导用户升到不稳版）→ 代价是某个依赖"全是 prerelease"时，整条依赖被静默跳过（stats 记为 null），用户看不到任何提示。
  - **catalog 引用先解析后判定，原始值仅作附带信息保留**：选择「声明 `catalog:foo` 时先解析回真实 semver 再走判定，但 rawRange/catalogName 字段仍随结果返回」→ 换来了上层 UI 既能用解析后的范围做计算、又能给用户显示「这条来自 catalog:foo」→ 代价是两条信息（declaredRange vs rawRange）必须始终成对出现，调用方混淆就会算错。
  - **两阶段扫包：先全员累计、再二次扫生成 item**：选择「第一轮把每个 depName 的 migrated/behind 计数累加进共享 stats，第二轮再用累计好的 stats 生成可执行 item」→ 换来了每条 item 的 totalCount 是"全局口径"而非"自己看到的口径"（迁移比例语义稳定）→ 代价是必须遍历两次 packages，对超大依赖图来说是双倍扫描成本。

- **最小心智模型（5 步）**：
  1. 把所有已装包按 depName 收拢，过滤掉 prerelease，取 stable 最高版作 cohort 基线。
  2. 对每个消费方的每条 peer/prod 依赖声明，先用 catalog 解析出真实范围，扔掉所有非纯 semver 写法（workspace:/link:/file:/git+/http: 等）。
  3. 用「最高版是否满足范围」判迁移/落后，分别累加进该 cohort 的 migrated/behind 计数。
  4. 再扫一遍：凡最高版 > 范围、且消费方与候选包不同仓库的，生成一条 dep-upgrade 待办，附上迁移比例。
  5. 按 consumer.spec 重组成 MaintainerActionGroup，按 depth/migration/latest 三种模式之一排序输出。

- **最小原理演示（替代旧"复刻范围"）**：
  - 应演示：一个约 50 行的"cohort 聚合 + 范围判定 + 兄弟跳过"骨架——只演透三件事：**为什么必须先全员累计、再二次扫**（item 的 totalCount 才稳定）；**为什么必须先做 catalog 解析**（否则 `catalog:foo` 会被当作非 semver 直接排除）；**为什么 repository URL 相同要跳**（避免 monorepo 兄弟被误报）。
  - 应故意省略：publint 共存、DTO 剥离、多排序模式切换、authors 聚合、latestOnly 过滤、limit 截断等工程化逻辑。
  - **演示载体建议**：本章仓库主语言是 TypeScript，建议写成一段可直接 `bun run`/`node --experimental-strip-types` 跑的脚本（用一个 semver 库的 satisfies/isGreaterThanRange 即可），构造 3~4 个 fake 节点（其中两个 @scope/ 兄弟共享同一 repository URL），打印出每条声明是被收编进 cohort、还是被跳过、为什么被跳。**能跑最好，但跑不通也不影响演透原理**——关键是让读者看到 cohort 的"计数累加"和"二次扫"两个阶段是分离的。

- **正文不宜展开的细节**：
  - `kind: 'publint'` 作为另一种 action 类型和 dep-upgrade 并存于 items——这只是"顺路打包送给 UI"，不是原理要点，正文一句带过即可。
  - DTO 层只是把 Group 内部的 PackageNode 引用"展平成字符串/spec"，方便跨 RPC 序列化，原理上无新东西。
  - computeDuplicates / computeInstallSizes 是和 cohort 主线平行的两个兄弟函数（同在 reports/ 目录、被 CLI report 命令平行调用），不属于本机制的原理链条，正文最多在"同级产物"提一句。

- **推荐的一个执行轨迹例子**：
  - 输入：4 个 fake 包 — `app@1.0.0`（prod 声明 `react: "^17.0.0"`）、`@scope/lib-a@1.0.0`（peer 声明 `react: ">=18"`，且与 react 共享同一 repository URL）、`lib-b@2.0.0`（声明 `react: "*"`）、`react@17.0.0` / `react@18.2.0` 两个真实版本。
  - 中间态：cohort "react" 的 highestVersion=18.2.0、stable=[17.0.0, 18.2.0]、migrated=0/behind=0；扫 app 时 `18.2.0 > ^17.0.0` 命中 → behind+1；扫 lib-a 时虽命中 gtr，但因 repository URL 相同被跳过；扫 lib-b 时 `*` 被 isPlainSemverRange 排除，根本不进入判定。
  - 输出：一条 dep-upgrade item（consumer=app, depName=react, declaredRange="^17.0.0", installedHighestVersion="18.2.0", migratedCount=0, totalCount=1, migrationRatio=0），按 consumer 分组后 app 这一组 maxMigrationRatio=0、latestReleasedAt 取其 publishedAt。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **三段产物分工**：`computeMaintainerActions` 产扁平 items 数组、`groupMaintainerActions` 按 consumer 重组与排序、`toMaintainersGroupDto` 把内部对象引用剥离成可序列化 DTO。三者严格分阶段。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:125、:283；packages/node-modules-inspector/src/shared/reports/dto.ts:48、:72

- **cohort 基线 = stable 最高版**：getStats 把同一 depName 的所有版本过滤 prerelease 后取末位作 highestPkg；若一个 stable 版本都没有，整个 depName 的 stats 记为 null、被静默跳过。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:130-154

- **范围分类硬过滤**：`isPlainSemverRange` 显式排除 `*`/`latest`/`x` 及 `workspace:`/`link:`/`file:`/`npm:`/`git+`/`git:`/`http:`/`https:`/`github:` 前缀——只有"纯 semver 范围"才参与迁移判定。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:66、81-85

- **catalog 解析是判定前置**：声明形如 `catalog:foo` 时必须先在传入的 `catalogs` 字典里查回真实 semver 才能继续判定；解析失败（catalogs 未提供或名字查不到）就让该声明作废。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:68-79

- **三态判定**：safeSatisfies 判"已迁"、safeGtr 判"落后"、其余（声明比最高版还高）既不计入 migrated 也不计入 behind，被注释为「ignored (not part of this cohort)」。两个判定函数都包了 try/catch，semver 库抛错时返回 null 视作不命中。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:87-103、169-176

- **两阶段扫描的硬证据**：第 156-178 行只对 stats 做 migrated/behind 累加、不 push item；第 182-228 行才基于已稳定的 stats 生成 item——且生成条件是 `safeGtr(...) !== true` 时 continue，即只把"落后"的声明升级为可执行 item，"已迁"的不产生 item 但仍参与 totalCount。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:156、182

- **兄弟跳过的双 truthy 守卫**：`if (consumerRepo && depRepo && consumerRepo === depRepo) continue`——必须两边都有 repository URL 且相等才跳过；只要任一边没填 repository，跳过逻辑就不生效（落回判定）。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:200-204

- **迁移比例的口径**：`migrationRatio = total ? migrated / total : 0`，total 仅由 migrated+behind 构成（"声明比最高版高"的那类不计入分母）。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:205-222

- **publint 作为旁路 action**：第三段循环独立扫描每个 consumer 的 publint 消息，按 error/warning/suggestion 计数后作为一种独立 kind 的 item push 进同一 items 数组。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:230-245

- **分组的"按 name 取最高版"消重**：groupMaintainerActions 先按 `consumer.spec` 分桶，再按 `consumer.name` 二次去重——同名只保留 version 最高的那个 spec；这样同名多版本的消费者不会重复出现。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:288-316

- **三种排序模式都把 depth 作为次级 key**：migration 模式按 maxMigrationRatio 降序、latest 模式按 latestReleasedAt 降序、默认 depth 模式按 depth 升序；三者都用 depth 作二级、consumer.name 字典序作三级 tie-breaker。源码位置: packages/node-modules-inspector/src/shared/reports/maintainers.ts:348-357

- **duplicates 是"按 name 聚合 → 比 minVersions → 排序"的纯计数**：用 Map<string, PackageNode[]> 分桶，pkgs.length < minVersions 直接 continue，结果按 versions 数量降序+name 字典序；minVersions 默认 2。源码位置: packages/node-modules-inspector/src/shared/reports/duplicates.ts:12-43

- **sizes 同样按指定维度拍平后排序截断**：默认 exclude workspace 包（无意义安装体积），按 bytes 降序、limit 默认 50 截断；categories 字段直接透传 resolved.installSize.categories。源码位置: packages/node-modules-inspector/src/shared/reports/sizes.ts:11-37

- **DTO 层是"字段重命名 + 引用剥离"**：MaintainersGroupDto 把 PackageNode 类型的 `consumer`/`installedHighest` 字段展平成 spec/name/version 字符串与 installedHighestSpec；MaintainerActionItem 用 discriminated union（kind: 'dep-upgrade' | 'publint'）保证跨 RPC 后仍可类型窄化。源码位置: packages/node-modules-inspector/src/shared/reports/dto.ts:15-46、48-85

## 关键调用链
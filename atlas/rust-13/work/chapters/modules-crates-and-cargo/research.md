# 模块、Crate 与 Cargo：工程组织与标准化工具链 · 主题精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：项目一旦变大，前端工程师熟悉的世界就迅速碎片化——`package.json` 管 npm 依赖、`tsconfig.json` 管类型、`vite.config.ts`/`webpack.config.js` 管打包、`.eslintrc` 管风格、CI 里还要再拼一套构建脚本；改一个文件的位置就会牵动一堆 `import` 路径；每个库各自定义"怎么构建/测试/发布"。Rust 工程师面对同样规模的项目，往往只打开一个清单文件就能完成构建、测试、运行、生成文档、发布，新机器上 clone 下来一条命令就能全量编译。本章要讲清楚：这份"省心"不是偶然，而是靠把概念分层 + 强约定**换来的**。

- **一句话核心思想**：把「代码组织（module）、编译单元（crate）、工程发布（package）」拆成三个正交层，每层只管一件事，再用强约定让构建工具对其中两层几乎零配置。

- **设计动机（为什么需要它）**：要让编译期静态检查在工程规模下依然可控，必须有一个明确的「编译单元」边界——它同时是借用检查、单态化、链接的最小作用域，这正是 crate 这个抽象存在的理由。围绕 crate，Rust 又向下拆出 module（管"代码怎么分组、谁看得见谁"），向上拆出 package（管"一组 crate 怎么一起发布、依赖怎么管版本"）。**承前**：（已在第 1 章『设计哲学与编译模型总览』讲透 Cargo/rustc『提前编译 + 借用检查』的心智总图，本章只看它的新侧面：编译单元与代码组织如何被三层抽象切分，以及强约定如何消除工程配置地狱。）——本章不再重讲"为什么是编译期"，而是讲"编译单元的边界怎么定、代码怎么组织进这个边界、工程怎么围绕它标准化"。

- **关键权衡（本 Atlas 的核心；本章机制丰富，给 4 条）**：
  1. **显式模块挂载 vs 隐式"文件即模块"** → 选择"文件存在并不等于模块可见，必须在父模块里用声明把它挂到模块树上" → 换来模块树与文件系统**解耦**（可重构文件位置而不动导入路径）、可见性可精确推理、没有隐式魔法解析 → 代价是初学者最大困惑源："我明明建了文件为什么编译器说找不到"，且每个子模块要多写一行挂载声明（对照 Node 的 `index.js` 自动解析）。
  2. **约定优于配置 vs 配置自由** → 选择固定约定（固定入口文件代表二进制、固定入口文件代表库、固定测试/基准/示例目录、固定构建产物目录） → 换来"开箱即用"：构建/测试/运行/文档/发布命令全生态统一、新项目上手成本极低、整个生态共享同一套工程词汇 → 代价是灵活性受限，想深度定制构建流程必须写构建脚本或干脆绕过这套工具，偏离约定就会处处碰壁。
  3. **默认 SemVer 兼容 + lockfile 分策略** → 选择依赖版本默认按 SemVer 兼容范围解析（允许 patch/minor 自动升级），但同时用锁文件锁定一个具体版本；并约定"二进制锁、库不锁" → 换来库生态能平滑演进（下游自动获得兼容修复）而应用构建可复现，二者两全 → 代价是必须理解 SemVer 契约（主版本号即破坏性变更），库作者一旦违约会波及整个下游，且升级可能引入未预期的 patch 行为变化。
  4. **edition 作为"可选项式的破坏性变更"** → 选择每隔几年发布一个 edition，允许语言做小幅不向后兼容的演进，但以单个 crate 为单位可选启用、跨 edition 互相兼容 → 换来语言能持续进化，既不像某些老语言那样背负历史包袱到难以推动，也不像某些语言的大版本切换那样撕裂整个生态、强迫所有依赖同步升级 → 代价是读者要多一个"edition"概念，偶尔会遇到 edition 特有的语义差异，需要用迁移工具按 crate 独立升级。

- **最小心智模型（3～7 步）**：
  1. 在清单文件里声明一个 package（名字、版本、edition、依赖列表）。
  2. 构建工具按约定找到这个 package 的 crate 根（库 crate 根或二进制 crate 根），把它交给编译器。
  3. 编译器从 crate 根出发：每遇到一个模块声明，就把对应源码挂载进模块树（这是唯一让子代码"出生"的方式，文件存在本身不生效）。
  4. `pub` 决定哪些项能跨模块边界被看到，`pub(crate)` 把可见性收窄到本 crate 内。
  5. `use` 只是把长路径起个别名（纯导入，不创建模块）。
  6. 整个 crate 被编译成**一个编译单元**（一个库产物或一个可执行文件）——借用检查、单态化都在这个范围内完成。
  7. 构建工具解析依赖树、按 SemVer 选版本、读锁文件锁定，对每个依赖 crate 重复第 3～6 步，最后链接成产物。

- **最小原理演示（替代旧"复刻范围"）**：
  - **应演示**：用一个几十行的小程序演透"**显式模块挂载 + 可见性**"这一全章灵魂——文件存在 ≠ 模块可见，必须先挂载、再标记公开，才能被路径解析到。每一行都要对应上面某个原理点（挂载 = 模块树父子边、可见性 = 跨边界过滤、路径解析 = 沿树下行）。
  - **应故意省略**：edition 迁移、workspace 多 crate 编排、构建脚本、feature flag、锁文件格式、注册表发布流程、条件编译等工程化细节——这些是"配置"层面的产物，不是原理。
  - **演示载体建议**：topic 模式**首选 TS/JS**（本 Atlas 产物是 JS 生态站点）。用一个 TS 写的"模块树解析器"模拟 Rust 的 `mod`/`pub`/路径解析，能让 JS 读者立刻 get 到"为什么 Rust 不像 Node 那样 import 路径直接对应文件"。无语言特有语义阻碍，不需要退回 Rust。

- **正文不宜展开的细节**（供 Writer 裁剪）：
  - 三种版本说明符（`^`/`~`/`=`）的完整对照表与通配符、比较运算符写法（点到"默认就是 caret"即可，不要背文档）。
  - workspace 根清单 `[workspace]` 段、成员枚举、共享锁文件的完整语法。
  - `[features]` 条件编译、可选依赖、平台特定依赖。
  - 构建脚本（`build.rs`）的执行时机与产物传递。
  - `pub(in path)` / `pub(super)` / `pub(self)` 等可见性细分的全展开。
  - 路径 `self`/`super`/`crate` 前缀的枚举式罗列（举 `crate::` 一例点透"绝对路径从 crate 根起"即可）。
  - 2018 edition 文件映射规则（`foo.rs` vs `foo/mod.rs`）的迁移历史——只点一句"有两种等价写法"。

- **推荐的一个执行轨迹例子**（演核心思想，不是演全量调用）：
  - **输入**：一个 package，清单声明名字/edition/一个外部依赖；二进制根里写"挂载 network 模块，然后调用 network 的 tcp 子模块的 connect"——**但故意在 network 里漏写"挂载 tcp"**。
  - **关键中间态①**：构建工具读清单 → 按 SemVer 选出依赖具体版本 → 锁文件锁定 → 定位到二进制 crate 根，把它交给编译器。
  - **关键中间态②**：编译器从根出发建模块树：`mod network;` 成功挂上 network；但 network 内没有 `mod tcp;`，所以 tcp **根本不在树里**（尽管它的源文件躺在磁盘上）。
  - **关键中间态③**：解析路径 `network::tcp::connect` 失败 → 报"找不到模块 tcp（提示：需要声明 `mod tcp;`）"——这正是"显式挂载"的代价具象化。
  - **输出**：补上那一行挂载声明 → 树完整 → 编译通过 → 链接成可执行文件。读者由此看到：磁盘文件是死的，模块树是活的，唯一让子代码"出生"的动作是父模块里那行挂载声明。

> 以上钩子供 Writer 写「动机 → 核心思想 → 心智模型 → 关键权衡 → 原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **crate（编译单元）**：编译器视角的最小独立编译单位，分库 crate 和二进制 crate 两类；一个 crate 编译后产生一个产物（库中间文件或可执行文件）。借用检查、单态化都以 crate 为作用域。依据: The Rust Programming Language 第 7.1 节「Packages and Crates」。
- **module（代码组织）**：crate 内部的命名空间分组机制，用于控制代码结构与可见性（`pub`）。模块构成一棵以 crate 根为顶点的树。依据: The Rust Programming Language 第 7.2 节「Paths for Referring to an Item in the Module Tree」。
- **package（Cargo 概念，非编译器概念）**：由一个清单文件定义、包含一个或多个 crate 的发布单元。关键事实：**编译器本身不认识 package，package 纯粹是构建工具的概念**——你运行新建项目命令得到的就是一个 package。一个 package 最多含一个库 crate，但可含任意多个二进制 crate；必须至少含一个 crate。依据: The Rust Book Abridged 第 7 章「Packages, Crates, and Modules」、The Rust Programming Language 第 7.1 节。
- **三层职责的严格切分**：module 管"代码怎么分组、谁看得见谁"（语言级）；crate 管"一起编译/链接成什么"（语言级）；package 管"一起发布、依赖怎么管版本"（工具级）。依据: The Rust Programming Language 第 7 章「Managing Growing Projects with Packages, Crates, and Modules」。
- **crate 根**：编译器编译一个 crate 的入口源文件——库 crate 根与二进制 crate 根是固定约定位置。构建工具按约定自动发现它们，无需在清单里显式罗列源文件。依据: The Cargo Book「Package Layout」、The Rust Programming Language 第 7.1 节。
- **约定目录结构**：固定入口代表二进制、固定入口代表库、固定目录放集成测试、固定目录放基准、固定目录放示例、固定目录放构建产物。这是"约定优于配置"的具体落地。依据: The Cargo Book「Package Layout」。
- **`mod` 显式挂载**：子模块源文件存在**并不**使模块自动可见；必须在其父模块中以模块声明把它挂到树上，编译器才会去找它的源码。这是模块树与文件系统解耦的核心机制。依据: fasterthanli.me「Rust modules vs files」、Shesh Babu「Clear explanation of Rust's module system」。
- **文件查找规则**：挂载一个名为 `foo` 的子模块时，编译器按"文件 + 同名目录"或"目录内特殊入口文件"两种等价约定之一查找；后者是更早的约定，前者是较新 edition 引入并推荐的替代写法，二者当前都合法。依据: The Rust Reference「Items and modules」、The Rust Edition Guide 2018「Path clarity」。
- **可见性默认私有**：模块内所有项默认只对本模块可见；用 `pub` 才允许跨模块边界访问，`pub(crate)` 收窄到本 crate 内可见。依据: The Rust Programming Language 第 7.3 节「Paths for Referring to an Item in the Module Tree」与第 7.4 节。
- **`use` 是别名，不是声明**：`use` 仅把已存在的路径引入当前作用域起短名，不创建模块、不改变可见性（对私有项 `use` 进来也无法绕过可见性）。依据: The Rust Programming Language 第 7.4 节「Bringing Paths into Scope with the use Keyword」。
- **依赖版本默认 caret**：在清单里写 `version = "1.2.3"` 等价于 `^1.2.3`，即允许 SemVer 兼容更新（`>=1.2.3, <2.0.0`）。这与某些 JS 包管理器"裸版本号=精确锁定"的语义不同——在 Rust 里裸版本号**默认就是兼容范围**。依据: The Cargo Book「Specifying Dependencies」（Caret requirements 一节）。
- **SemVer 契约**：主版本号递增表示破坏性变更；0.x 阶段按特殊规则把 0.y.z 的 minor 视作破坏性（即 `^0.3.0` 只允许 `>=0.3.0, <0.4.0`）。依据: The Cargo Book「SemVer compatibility」。
- **锁文件二选一惯例**：二进制 crate 应提交锁文件以保证可复现构建；库 crate 不提交（提交了也会被下游忽略、且发布时被自动剥离），因为下游用的是它自己的锁文件。依据: The Cargo Book「Cargo.lock」、rust-lang/cargo Issue #7319。
- **edition**：每约三年一个版本（已有 2015/2018/2021/2024），是编译器的"兼容模式"——以单个 crate 为单位声明，未声明者回退到最早的 2015。关键性质：**同一依赖树里不同 crate 用不同 edition 可无缝互操作**，可任意顺序迁移。依据: The Rust Edition Guide「What are editions?」。
- **edition 是 per-crate opt-in**：在清单里设 `edition` 字段启用；提供自动迁移工具辅助升级。依据: The Rust Edition Guide「Migrating to a new edition」、RFC 3085（edition 2021）。
- **注册表发布不可撤销**：发布到官方公共注册表的某个版本是永久的，不可删除/覆盖（出于可复现构建与依赖稳定性）。依据: The Cargo Book「Publishing on crates.io」。

## 关键流程

**A. 构建流水线（清单 → 产物）**
清单文件 → 依赖解析（按 SemVer 兼容范围选版本）→ 读/写锁文件锁定具体版本 → 按 crate 间依赖顺序调度 → 每个 crate：定位 crate 根 → 编译器建模块树（`mod` 挂载 + `pub` 过滤）→ 借用检查/单态化/类型检查（作用域 = 本 crate）→ 产出库中间件或可执行文件 → 链接 → 写入固定构建产物目录。
依据: The Cargo Book「Specifying Dependencies」「Cargo.lock」、The Rust Programming Language 第 7 章。

**B. 模块树生长流程（crate 根 → 完整树）**
crate 根模块 → 遇到 `mod foo;` 声明 → 按"文件+同名目录"或"目录内入口文件"约定找到 foo 的源码 → 把 foo 挂为当前模块的子节点 → 递归进入 foo 重复此过程 → `pub` 在每条边界上过滤跨模块可见性 → `use` 在叶子上起别名。
依据: fasterthanli.me「Rust modules vs files」、The Rust Reference「Items and modules」。

**C. 三层职责对照**
- module：分组 + 可见性（语言级，编译器管）
- crate：编译/链接单元（语言级，编译器管）
- package：发布 + 依赖版本单元（工具级，构建工具管，编译器不认识）
依据: The Rust Programming Language 第 7 章、The Rust Book Abridged 第 7 章。

## 易混淆 / 边界 / 推断

- **事实**：`version = "1.2.3"` 与 `version = "^1.2.3"` 在 Rust 里**完全等价**（裸版本号默认 caret）；这与某些 JS 包管理器"手写裸版本号=精确锁定"相反。依据: The Cargo Book「Specifying Dependencies」、Clippy 讨论中"显式写 ^ 是冗余"的共识。
- **事实**：0.x 版本下 `^0.3.0` 解析为 `>=0.3.0, <0.4.0`（把 minor 当破坏性），这是 SemVer 在 0.x 阶段的特殊规则，常被新手忽略导致"明明只升了一个 minor 却升不动"的困惑。依据: The Cargo Book「SemVer compatibility / Caret requirements」。
- **事实**：库 crate 即使提交了锁文件，下游也**不会**使用它——下游只用自己的锁文件；发布时锁文件还会被自动剥离。依据: rust-lang/cargo Issue #7319、users.rust-lang.org 相关讨论。
- **事实**：新建 package 时未声明 edition，默认回退到 **2015**（而非"当前最新"）。依据: The Rust Edition Guide「What are editions?」。
- **事实**：同一个 package 可以同时含库 crate 和多个二进制 crate；当库二进制混合时，按"是否把此 package 当作可交付应用"决定是否提交锁文件（惯例：当应用就提交）。依据: Stack Overflow「Should Cargo.lock be committed when the crate is both a library and an executable?」。
- **推断（标注为推断）**：模块树与文件系统**解耦**这一设计，意图是让"代码的逻辑组织"与"源码的物理摆放"互相独立——重构文件位置不必动导入路径，模块结构可从 crate 根一眼推读。社区资料（fasterthanli.me、Shesh Babu）普遍把它解释为"显式 > 隐式"这一 Rust 一贯取舍的延伸，但官方 Reference 未直接陈述此意图，故标为推断。
- **易混淆**：`crate::` 是从 crate 根起的绝对路径，`self::` 是从当前模块起的相对路径，`super::` 是上一级——它们都是"从哪儿开始往下走"的前缀，不改变可见性规则本身。
- **易混淆**：`use` 把路径引入作用域，但若该项本身对当前模块不可见，`use` 进来也无法使用——`use` 不是"绕过私有"的口子。
- **边界**：构建脚本（`build.rs`）在编译 crate **之前**运行，可生成代码或设置环境变量；其与 feature flag 的组合是工程化进阶，本章不展开。依据: The Cargo Book「Build Scripts」。
- **未理解 / 待查证**：Cargo 在"多版本共存"（依赖树里同一 crate 出现两个不兼容主版本）时的符号链接/mangle 细节，以及 workspace 共享锁文件时成员 crate 版本协调的精确算法，本调研未深入核对原始文档，Writer 若需展开应另行查证 The Cargo Book「Workspaces」与「SemVer compatibility」章节。
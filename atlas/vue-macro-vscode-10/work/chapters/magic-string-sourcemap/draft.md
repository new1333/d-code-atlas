# magic-string：改代码却不丢位置，靠一张「编辑账本」换回 sourcemap

> 本章属于 primitive 层。前置：靠 AST 而非正则识别宏调用节点。
> 学完你能：用一句话讲清「为什么宏变换必须用 offset 级的就地改写、而不是随手拼字符串，以及这么做换来可回溯调试的代价」。

## 1. 为什么需要它

上一章解决了「怎么认出宏」——靠 AST 按节点类型加调用名精确匹配，顺带从节点上拿到它在源码里的字符 offset。但拿到 offset 只是第一步。真正动手改代码那一刻，位置信息就开始流失，而这正是上一章那个「报错难还原到用户写法」代价的根源。本章就接住这个口子：怎么在改写代码的同时，不让原始位置丢掉。

想象你在用 `defineProps` 或 Vue Macros 的 `defineModel`。你写的是一套声明式语法，编译产物里这段变成了 `__props` 或 `ref(...)`。然后你打开浏览器调试，想在那一行打个断点，结果断点要么落空、要么落进一段你从没写过的代码里；报错堆栈的行号指向编译产物的某一行，你对不上自己写的源码。

这就是编译期变换要交的「调试税」。如果不补一张把产物位置换算回源码位置的翻译表，宏省下的运行时开销，会在调试体验上连本带利还回去。

这张翻译表从哪来？最直觉的想法是：改完代码之后，给产物里每个字符标上它对应源码的哪个字符。但这要求改写过程中始终记得「这段新代码替换的是源码的哪一段」。朴素的字符串拼接做不到这件事。你一旦把新字符串拼好、把旧的丢掉，原始字符的位置就永久消失了，没法事后重建这张表。

magic-string 就是来填这个坑的。

## 2. 核心思想

所有改写都以「**原始源码的字符偏移量**」为坐标就地登记，原始位置永不丢弃，最后一次性把这张「编辑账本」逆向翻译成 sourcemap。

这句话里有个关键约束值得单独记住：原始串构造完就不再改动，改写只发生在账本上。

## 3. 心智模型

打一个比方。想象你在一份纸质合同上手改条款。你不会把整份合同重抄一遍，而是用红笔在原文上划掉一段、在旁边写上新内容，并在边上注明「这里原是第 3 条第 2 款」。最后要誊清时，你按原文顺序走一遍：遇到划掉的就誊新内容、没划的就誊原文，同时顺手记下「誊清稿的第几行对应原稿的第几行」。magic-string 干的就是这件事，只不过坐标不是「第几条第几款」，而是字符在原始串里的 offset。

它的运作可以拆成五步：

1. **建坐标系**。`new MagicString(source)` 把整段原始源码当成一个覆盖 `[0, 长度)` 的整体，原始 offset 从此刻起成为所有操作的绝对坐标。这个坐标是不可变的。
2. **取节点 offset**。遍历 AST 命中宏调用，读出该节点在源码里的 `start / end`（这正是上一章的产出）。
3. **就地改写**。对要替换的节点调 `overwrite(start, end, 新代码)`。内部会在 start、end 两处把整体「劈开」成相邻的小片段，被换掉的那个片段挂上新内容，但它绑定的原始位置仍是 start，不会跟着新内容走。
4. **一次性输出**。所有编辑登记完毕后，调 `toString()`，按片段顺序缝出最终产物。
5. **一次性映射**。调 `generateMap()` 遍历片段：没动过的代码天然映射回它自己的原始位置；被替换或新插入的内容，则映射到它所替换掉、所依附的那个原始 offset——相当于「假装这段新代码来自原文本的那个位置」。

贯穿这五步的不变量只有一条：**所有坐标都指原始串，永远不指改完之后的产物**。这条不变量是 sourcemap 能成立的根基。

这里有个容易看漏的点：`overwrite(14, 44, '__props')` 并不去原串里找第 14 到 44 个字符再就地替换。原串从头到尾不动。它只是在账本上记一笔：「把原始 `[14,44)` 这段换成 `__props`」。真实 magic-string 为了支持快速定位，内部用双向片段链表加起止索引表来维护这些片段（劈开 = split），但那是为了性能；原理上，一张按 offset 排序的编辑数组就够演透了。

## 4. 关键权衡

这一节是全章重点。magic-string 的几个核心设计取舍，每一条都在化解「两个对立需求打架」的矛盾。

### 权衡一：只能用 offset 定位的就地操作，放弃自由字符串替换

- **选择**：所有改写的坐标都钉死在原始 offset 上，`overwrite` / `remove` / `appendLeft` 一律按原始串的偏移量定位。
- **换来**：原始位置信息贯穿整个编辑过程不丢失，sourcemap 可以在最后逆向重建出来。可回溯调试成了改写的免费副产物。
- **代价**：你必须先有一份 AST 给出每个节点的 `start / end`，不能像写脚本那样随手 `.replace()`；而且后续所有操作仍得以原始 offset 为坐标系，不能用「改完之后的第几个字符」来定位——那个坐标系在每次编辑后都会失效。
- **化解的本质矛盾**：**自由度 vs 可回溯性**。你越想让改写像写脚本一样随意（按改完后的文本去定位下一次编辑），就越无法事后重建位置映射；反过来，要让 sourcemap 成立，就得约束自己只能用改写前的坐标系。magic-string 选了后者，把可回溯做成默认能力，代价是改写动作必须先经 AST 翻译成 offset。

这一条直接决定了 magic-string 和上一章 AST 识别的关系：上一章给的 offset 不是可有可无的便利，而是本章整套机制能运转的唯一入口。没有 offset，就没有 offset 级的改写。

### 权衡二：用片段链表加劈开记录编辑，而非每次重拼字符串

- **选择**：内部用片段（chunk）组成的链表记录编辑，`overwrite` 只是劈片段、改标记，绝不整体重算字符串。
- **换来**：多次编辑互不干扰，定位到任意 offset 接近 O(1)，还支持 `move` 把一段代码整体搬到别处。
- **代价**：内部数据结构比一段朴素字符串复杂得多，最终输出和 sourcemap 生成都要额外跑一次对全部片段的遍历。
- **化解的本质矛盾**：**简单性 vs 可叠加编辑**。朴素字符串每改一次，其后所有字符的位置都要整体重算，多次编辑互相踩踏；要支持「无数次小手术叠加在同一份代码上」，就得把单段字符串拆成可独立标记的片段。这其实是「可变状态如何承载多步编辑」的通解骨架：把每一步编辑做成对独立单元的标记，而不是每次重建整体。数据库的 MVCC、编辑器的 piece table，都是同一个骨架的不同化身。

### 权衡三：sourcemap 默认走低分辨率

- **选择**：`generateMap` 默认只在有限位置（行边界、词边界）打映射点，配合 VLQ 差值编码压缩体积；要逐字符精度得显式开 `hires`。
- **换来**：sourcemap 体积小，比逐字符映射通常小一个数量级。sourcemap 是要随产物一起被加载、解析的，这个体积差很实在。
- **代价**：映射粒度粗，列级精度丢失。断点可能只精确到「这一行的某个词」而不是精确列；开了 `hires` 又会让体积膨胀。
- **化解的本质矛盾**：**精度 vs 体积**。逐字符精确意味着每个产物字符都要留一条记录，体积会爆炸。默认粗粒度，是把「大多数调试场景不需要列级精度」这条经验固化成默认值。这同样是「默认值该怎么取」的通解：选覆盖大多数场景的便宜档位，把贵的精确档留给显式开启的人。

三条权衡放在一起看，magic-string 的立场很清楚：它把「可回溯」当成不可妥协的默认值（权衡一），用一套可叠加的片段账本支撑无数次编辑（权衡二），再用粗粒度默认值控制 sourcemap 体积（权衡三）。代价是改写动作受限、内部结构更重、精度可调但默认偏粗。

## 5. 最小原理演示

下面这段从零实现，只演透核心思想，不追求工程完整。每一行都对应上面某个原理点。

```ts
class MiniMagicString {
  // ① 原始串即绝对坐标系，构造后永不改动（原理点：offset 坐标系）
  constructor(private readonly source: string) {}

  // ② 编辑账本：每条 = 「把原始串 [start,end) 换成 content」
  private edits: { start: number; end: number; content: string }[] = [];

  // ③ overwrite 只往账本追加一条——原始串纹丝不动（原理点：就地登记）
  overwrite(start: number, end: number, content: string) {
    this.edits.push({ start, end, content });
  }

  // ④ 输出：按原始 offset 顺序走，账本外的誊原文、账本内的誊新内容
  toString(): string {
    const sorted = [...this.edits].sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0; // 当前誊到原始串的哪里
    for (const e of sorted) {
      out += this.source.slice(cursor, e.start); // 账本外的原文
      out += e.content;                          // 账本内的替换
      cursor = e.end;
    }
    return out + this.source.slice(cursor);      // 收尾原文
  }

  // ⑤ 逆翻译：账本外片段映射到自身 offset；账本内片段映射回它替换掉的原位置
  //    （原理点：新代码「假装」来自它替换掉的那个原始 offset）
  generateMap() {
    const sorted = [...this.edits].sort((a, b) => a.start - b.start);
    const map: { fragment: string; mapsToOffset: number }[] = [];
    let cursor = 0;
    for (const e of sorted) {
      if (e.start > cursor)
        map.push({ fragment: `原文[${cursor},${e.start})`, mapsToOffset: cursor });
      // ↓ 关键：替换进来的新内容，映射回它替换掉的原位置 e.start
      map.push({ fragment: `替换为"${e.content}"`, mapsToOffset: e.start });
      cursor = e.end;
    }
    if (cursor < this.source.length)
      map.push({ fragment: `原文[${cursor},${this.source.length})`, mapsToOffset: cursor });
    return map;
  }
}

// 上一章 AST 给出的宏调用节点 offset：defineProps<{ msg: string }>() 落在 [14,44)
const s = new MiniMagicString("const props = defineProps<{ msg: string }>()");
s.overwrite(14, 44, "__props");

console.log(s.toString());
// → "const props = __props"

console.log(s.generateMap());
// → [
//     { fragment: '原文[0,14)',       mapsToOffset: 0  },
//     { fragment: '替换为"__props"',   mapsToOffset: 14 }   ← 新代码「假装」来自 offset 14
//   ]
```

最后那行就是全章的「啊哈」时刻：产物里新插进去的 `__props`，在 sourcemap 里被映射回了 offset 14，也就是 `defineProps` 原本所在的位置。于是用户在产物 `__props` 上打的断点、看到的报错，经 sourcemap 一换算，落回源码里 `defineProps` 那一行。变换「可回溯」这件事，在这行输出里直接显形了。

## 6. 执行轨迹

拿一个具体输入走一遍，看账本和产物怎么联动。

**输入**：源码 `const props = defineProps<{ msg: string }>()`，AST 给出宏调用节点 `defineProps<{ msg: string }>()` 的 offset 为 `[14, 44)`。

**登记**：`s.overwrite(14, 44, "__props")`。此时账本里多了一条 `{start:14, end:44, content:"__props"}`，原始串 `const props = defineProps<{ msg: string }>()` 一个字没动。

**输出 `toString()`**：`cursor` 从 0 起步。先誊原文 `[0,14)` 得到 `const props = `，再誊账本内容得到 `__props`，`cursor` 跳到 44；44 已到串尾，没有收尾原文。产物：`const props = __props`。

**映射 `generateMap()`**：原文片段 `[0,14)` 映射到 offset 0（它自己原来的位置）；替换进来的 `__props` 映射到 offset 14（它替换掉的原位置）。于是产物里 `const props = ` 的每个字符各自回指自己，`__props` 回指 `defineProps` 当年所在之处。

**下游效果**：产物加 sourcemap 一起交给打包器和浏览器。在产物 `__props` 处的断点和报错，经 sourcemap 还原到源码里 `defineProps` 的位置——用户看到的始终是自己写的那份代码。

## 7. 教学简化说明

这段演示故意省了几样东西：双向片段链表和起止索引表是性能优化，不是原理，所以只用了一张排序数组；`move` / `reset` / `indent` 等高级操作、`appendLeft` 与 `prependRight` 在 move 场景下的归属差异都没涉及；sourcemap 的 VLQ 编码（把每个映射值差值再压成 Base64 串）也省了，演示里直接用 offset 数组，编码是下游 codec 的事；多文件、链式 sourcemap 合并（输入本身已带 sourcemap 时要复合）也没展开。这些不影响理解「为什么改写还能保住位置」这条主线。

## 8. 小结

一句话收束：magic-string 让「改代码」和「保住原始位置」同时成立，靠的是把所有改写钉在不可变的原始 offset 上记成账本，最后再逆翻译成 sourcemap。它的代价是改写动作必须先经 AST 翻译成 offset、内部结构更重、精度可调但默认偏粗。

到这里，连续两章给出了宏变换的两个支柱：上一章的 AST 负责「认出宏、给出 offset」，本章的 magic-string 负责「按 offset 安全改写并保住 sourcemap」。这两件事拼到一起，就成了宏变换的一个标准动作单元。下一章「Vue Macros 的宏变换流水线」要做的，就是把这样的动作单元串成一条可插拔的流水线。
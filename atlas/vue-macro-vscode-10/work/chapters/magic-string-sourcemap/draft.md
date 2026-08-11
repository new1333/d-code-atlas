# magic-string：sourcemap 友好的源码就地变换

> 本章属于 primitive 层。前置：靠 AST 而非正则识别宏调用节点。
> 学完你能：用一句话讲清「为什么宏改写代码必须用 offset 账本而非字符串替换，以及它付出的代价」。

## 1. 为什么需要它（设计动机）

上一章把「找得准」办成了——靠 AST 精确命中宏调用节点，并拿到了它在源码里的字符 offset。但这留下了一个更棘手的口子：找到节点之后呢？你总要对源码动刀，把 `defineProps()` 改写成 `__props`。这一刀下去，麻烦就来了。

想象一下：用户写了 `const props = defineProps<{ msg: string }>()`，编译期你把它改成了 `const props = __props`。看起来皆大欢喜——直到用户在浏览器里打断点，断点落不到自己写的那行；运行时报错，调用栈指向一段自己从没写过的代码。编译期擦除换来的运行时红利，在调试这一刻变成了灾难。

调试要能继续，浏览器/IDE 就得有一张翻译表，把产物里的行列号换算回源码的行列号，这就是 sourcemap。问题在于：朴素的 `.replace('defineProps', '__props')` 一旦执行，原始字符位置就永远丢失了——你没法事后问出「`__props` 这 7 个字符，原来对应源码的哪 14 个字符」。

所以「改写代码」和「保留原始位置」必须同时成立。但它们看起来天然矛盾——你改了，位置不就乱了吗？magic-string 就是为填这个坑而生的。

## 2. 核心思想

所有改写都以**原始源码的字符偏移量**为坐标就地登记，原始位置永不丢弃，最后一次性把这张「编辑账本」逆向翻译成 sourcemap。

换句话说，magic-string 不重新生成代码，而是把源码当成一张手术台——你要替换的、要插入的，都登记在源码的 offset 坐标系里；输出时把账本里的新内容和原始未被改动的片段缝合成产物，并同时吐出映射关系。

## 3. 心智模型

按 7 步建立心智：

1. **建立坐标系**：`new MagicString(source)` 把整段源码装进来，原始 offset 从这一刻起就是绝对坐标系，永不变更。
2. **取节点 offset**：从 AST 拿到宏调用节点的 `start`/`end`——上一章已经办好的事。
3. **overwrite 就地替换**：`s.overwrite(start, end, 新代码)`，账本上多一条「这个原始 offset 区间换成新内容」，区间两端的原始 offset 仍钉在那里。
4. **appendLeft / prependRight 就地插入**：`s.appendLeft(offset, 代码)`，插入物挂在某个原始 offset 的左侧或右侧。
5. **toString() 输出产物**：所有编辑登记完毕后调用一次，按 offset 顺序把账外原始片段与账内新内容缝合出来。
6. **generateMap() 输出映射**：遍历账本，未编辑片段天然映射到自身位置，被替换/插入的内容映射到它所锚定的那个原始 offset（「假装这段新代码来自原文本的那个位置」）。
7. **下游回溯**：产物 + sourcemap 交给打包器、运行时、调试器，断点与报错栈经 sourcemap 换算后落回用户写的源码。

整个模型的关键不变量：**原始 offset 永远是真理之源**。无论做了多少次编辑，账本上每一条都还能溯源回源码的某个位置。

## 4. 关键权衡

这是本章的重头戏。magic-string 每一条设计都对应一个被化解的矛盾。

### 4.1 牺牲自由字符串替换，换 offset 坐标系贯穿到底

**选择**：所有编辑操作（overwrite / remove / appendLeft / prependRight）只接收原始 offset 作为定位参数，明确禁用「按改完之后的位置定位」或「按内容自由替换」。

**换来**：原始位置信息贯穿整个编辑过程，永不丢失——每条编辑都钉在原始 offset 上，账本本身就是 sourcemap 的源头，最后那次 generateMap 只是把账本逆向翻译成标准格式。

**代价**：你必须先有 AST 给出每个节点的 start/end offset，随手 `.replace()` 的脚本式改写范式被堵死了；所有后续操作都以原始 offset 为坐标系，读者得换一种心智——**问「原始第几个字符」而非「改完之后第几个字符」**。

**本质矛盾**：这是「编辑的便利性」与「位置的可追溯性」之间的取舍。一旦允许自由字符串替换，就再也无法保证每段产物都能溯源到源码，因为替换会改写文本结构、原始 offset 立刻作废。magic-string 选了后者，把便利性让渡给前置的 AST 阶段。

### 4.2 用区块链表记账，不每次重拼字符串

**选择**：内部维护一个 chunk 链表（双向链表 + 起止索引表），每次 overwrite 都是「劈开相邻 chunk + 给目标 chunk 打标」，绝不重新拼接整个字符串。

**换来**：多次编辑互不干扰、O(1) 定位到任意位置、甚至支持 `move()` 把一段代码搬到别处——编辑只是改 chunk 属性，chunk 之间的链接关系从未被破坏。

**代价**：内部数据结构比朴素字符串复杂得多；最终 toString 与 generateMap 都需要一次 O(n) 遍历整个链表。不过这次遍历是「摊到所有编辑上」的一次性成本，远好于每改一次就重拼一次。

**本质矛盾**：这是「单次编辑的简单性」与「多次编辑的可组合性」之间的取舍。朴素字符串每改一次都得重新建立 offset 对照（字符串长度变了），N 次编辑是 O(N²)；链表把每次编辑成本摊到 O(1)，代价是引入「chunk 是 sourcemap 的最小单元」这层抽象。

### 4.3 默认走低分辨率 sourcemap，按词/行边界打点

**选择**：`generateMap({ hires: false })`（默认值）只在有限的几个位置打映射点——通常是行边界或词边界，而非每个字符都打。

**换来**：sourcemap 体积小，配合 VLQ 差值编码后比逐字符映射小一个数量级，加载与解析都快。

**代价**：映射粒度粗，列级精度丢失。断点可能只精确到「这一行的某个词」而非精确列。要逐字符精度得显式开 `hires: true`，但 sourcemap 体积会膨胀。

**本质矛盾**：这是「调试精度」与「产物体积」之间的取舍。多数场景下行/词级精度够用（断点通常落到行就够了），所以默认走低分辨率；当用户真的需要列级调试时再显式 opt-in。这是把决策权交给使用者，而非替使用者拍板。

## 5. 最小原理演示

下面这几十行实现，只演示核心思想：**原始 offset 作为坐标系 + 编辑账本 + 逆向翻译成 sourcemap**。不演示性能优化、不演示完整 API。

```ts
class MiniMagicString {
  private original: string;
  // 编辑账本：每条记录「原始 [start,end) 区间被换成 content」
  // 未在账本里的 offset 区间原样保留
  private edits: Array<{ start: number; end: number; content: string }> = [];

  constructor(source: string) {
    this.original = source;
  }

  // 就地登记一条编辑：仅记账，不动原始串
  overwrite(start: number, end: number, content: string) {
    this.edits.push({ start, end, content });
  }

  // 在某个原始 offset 的左侧插入，本质是「替换 0 长度区间」
  appendLeft(at: number, content: string) {
    this.edits.push({ start: at, end: at, content });
  }

  // 输出产物：按原始 offset 顺序，缝合账外原始片段与账内新内容
  toString(): string {
    this.edits.sort((a, b) => a.start - b.start);
    let out = "";
    let cursor = 0;
    for (const e of this.edits) {
      out += this.original.slice(cursor, e.start); // 账外片段，原样保留
      out += e.content;                            // 账内片段，用新内容
      cursor = Math.max(cursor, e.end);            // 跳过被替换掉的原始区间
    }
    out += this.original.slice(cursor);            // 尾部原始片段
    return out;
  }

  // 输出 decoded sourcemap：每段产物映射到它对应的源码行列
  // 这里只演映射规则，VLQ 编码留给下游 codec
  generateDecodedMap() {
    const gen: Array<[number, number]> = []; // 产物的 [行, 列]
    const ori: Array<[number, number]> = []; // 源码的 [行, 列]
    this.edits.sort((a, b) => a.start - b.start);
    let genCol = 0;
    let cursor = 0;
    for (const e of this.edits) {
      // 账外片段：产物与源码行列完全一致
      for (let i = cursor; i < e.start; i++) {
        gen.push([0, genCol++]);
        ori.push(offsetToLineCol(this.original, i));
      }
      // 账内片段：产物用新内容的列推进，但映射回原始区间起点的源码位置
      for (let i = 0; i < e.content.length; i++) {
        gen.push([0, genCol++]);
        ori.push(offsetToLineCol(this.original, e.start));
      }
      cursor = Math.max(cursor, e.end);
    }
    for (let i = cursor; i < this.original.length; i++) {
      gen.push([0, genCol++]);
      ori.push(offsetToLineCol(this.original, i));
    }
    return { generated: gen, original: ori };
  }
}

// offset 转 [line, col] 的工具
function offsetToLineCol(s: string, off: number): [number, number] {
  let line = 0, col = 0;
  for (let i = 0; i < off; i++) {
    if (s[i] === "\n") { line++; col = 0; } else col++;
  }
  return [line, col];
}
```

跑一遍下面这个输入：

```ts
const src = "const props = defineProps<{ msg: string }>()";
const s = new MiniMagicString(src);
s.overwrite(14, 46, "__props");   // 把宏调用整段换成 __props
console.log(s.toString());
// → "const props = __props()"

const m = s.generateDecodedMap();
// 产物里 "__props" 那 7 个字符，每一条记录的 original 都是 [0, 14]
// 也就是「假装这 7 个字符来自源码 offset 14（defineProps 原本所在）」
```

这一刻——新插入的 `__props` 被映射回了它替换掉的原始 offset 14——是全章的「啊哈」瞬间。变换「可回溯」这件事就这么落地了。

## 6. 执行轨迹

拿上面的输入走一遍内部状态：

```
原始源码：const props = defineProps<{ msg: string }>()
offset:   0         14       23                 46   48
```

**步骤 1 · 构造**：`new MiniMagicString(src)` 装入原始串，账本为空，坐标系确立。

**步骤 2 · 登记编辑**：`s.overwrite(14, 46, "__props")`，账本多一条 `{start:14, end:46, content:"__props"}`。原始串本身没动。

**步骤 3 · toString**：按 offset 顺序遍历账本——
- 账外片段 `src.slice(0, 14)` = `"const props = "`，原样输出。
- 账内片段 `"__props"`，新内容输出。
- cursor 跳到 46。
- 账外尾部 `src.slice(46)` = `"()"`，原样输出。

最终产物：`"const props = __props()"`。

**步骤 4 · generateDecodedMap**：逐字符标注——
- 产物第 0～13 个字符（`const props = `），每个映射到源码同样 offset 的行列。
- 产物第 14～20 个字符（`__props`），**每个**都映射到源码 offset 14 的行列，也就是 `defineProps` 原本所在位置。
- 产物第 21、22 个字符（`()`），映射到源码 offset 46、47。

**步骤 5 · 下游使用**：浏览器拿到产物 + 这张 map 后，当用户在产物 `__props` 处打断点，调试器查 map 发现这位置对应源码 offset 14，于是断点落回用户写的 `defineProps` 上——变换「可回溯」达成。

## 7. 教学简化说明

本章演示故意省略了：

- **双向链表 + byStart/byEnd 索引**：那是 magic-string 真实源码的性能优化，不是原理。演示用「账本数组 + 排序」就能演透同样的思想。
- **VLQ 的 Base64 编码**：那是 sourcemap 字符串层面的压缩算法，与「offset 坐标系」无关。演示里 decoded 映射直接用行列数组。
- **`move` / `reset` / `indent` 等高级操作**：它们是就地编辑的延伸能力，不是核心思想。
- **链式 sourcemap 合并**：当输入本身已经带 sourcemap（如 TS → JS 之后再做宏变换），需要 `@jridgewell/trace-mapping` 这类工具做合并，magic-string 自身不处理。
- **`appendLeft` vs `prependRight` 在 move 场景下的归属差异**：纯 overwrite 场景下两者行为接近，move 才有区别。

## 8. 小结

magic-string 把「改写代码」和「保留原始位置」这件看似矛盾的事，用一个简单的思想统一起来：**别动原始串，只登记改写**。所有编辑都钉在原始 offset 上，sourcemap 就成了编辑的免费副产物——逆向把账本翻译一遍就行。代价是放弃随手 `.replace()` 的脚本式便利，把定位权交给前置的 AST。

下一章「Vue Macros 的宏变换流水线」会看到，每个特性宏都被做成了「AST visitor 命中节点 + 对 magic-string 实例做 overwrite/appendLeft」的标准化动作单元——本章建立的这套 offset 账本范式，正是那条流水线上每个变换器都遵循的共同动作。
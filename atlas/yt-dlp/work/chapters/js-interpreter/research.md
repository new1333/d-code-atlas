# 进程内手写 JS 解释器：本地执行对抗性脚本 · 源码精读

## 给 Writer 的教学钩子（必填，8 子项缺一不可）

- **用户痛点 / 场景**：很多视频站点为了防盗链，下发的播放地址不是最终 URL，而是一段混淆过的 JavaScript——必须先在本地运行这段脚本（算签名、解 n 参数、解密 key），才能拼出真正能下载的地址。这段脚本是站点下发的对抗性代码，会不定期变样。问题来了：用户机器上没装浏览器、没装 Node，下载器怎么「跑」掉这段 JS？

- **一句话核心思想**：与其拉一个外部 JS 引擎进来，不如在进程内手写一个「刚好够用」的 JS 求值器，把对手下发的脚本当数据本地跑掉。

- **设计动机（为什么需要它）**：它解决的是「拿到一段不可信、会变的 JS，要在没有浏览器/Node 的环境里可移植地、行为可锁定地执行它」这个矛盾——换来了零外部依赖、跨平台可移植、且运行结果完全可控可预测（不会被引擎版本差异带偏）。
  - 承前关系：（已在第 4 章『info_dict 数据总线与提取器骨架』讲透「一个胖字典在各阶段间流动」——本章只看它的一个新侧面：info_dict 里有些字段不是抓出来的，而是必须先执行站点下发的 JS 才能算出来；这个求值器的输出，最终也是汇入那条数据总线的一个输入源。）Writer 不必重演「数据总线」本身，只点「JS 求值是总线某些字段的供给方」即可。

- **关键权衡（本 Atlas 的核心）**：
  1. **选择「正则文本切片 + 边解析边求值的递归下降」，而不是经典的「词法→语法树→字节码」流水线** → 换来用单个文件覆盖站点实际用到的 JS 子集、无需完整编译器骨架 → 代价是解析与求值耦合在一个巨大的分发函数里、每遇到一种新语法就得在巨函数里加一个前缀分支。
  2. **选择「把 break / continue / throw 建模为宿主语言的异常」** → 换来非局部跳转几乎零成本实现（循环体捕获对应异常即可，try/catch 天然就是异常捕获）→ 代价是「正常控制流」和「错误传播」共用同一条异常通道，调试时栈轨迹会误导。
  3. **选择「为每个运算符单独写语义包装函数、强制复刻 JS 的数值/类型规则」，而不是直接复用宿主语言的运算符** → 换来对 JS 边界行为的精确模拟（32 位整数回绕、除零得无穷、零除零得 NaN、`0**0===1`、特定的 falsy 集合）→ 代价是每个运算符都要手写包装、JS 子集越宽维护成本越高。
  4. **选择「把 JS 函数惰性提取、首次调用时编译成宿主语言闭包并缓存」** → 换来「调用过的函数只编译一次」、且 JS 函数天然成为一等公民可在作用域里传来传去 → 代价是函数提取靠正则在源码文本里捞、遇到非典型定义形态会失败、必须持续打补丁。

- **最小心智模型（7 步）**：
  1. 拿到一段站点下发的 JS 源码文本，构造解释器（此刻不立即解析，只存文本）。
  2. 外部点名要执行某个函数 → 用正则在源码文本里捞出该函数的形参表与函数体文本。
  3. 把函数体编译成一个宿主语言闭包（绑定形参名、套上一层作用域栈）。
  4. 调用闭包 → 把实参按形参名塞进作用域栈顶 → 进入「逐语句解释」循环。
  5. 每条语句先用手写切片器按分号切；对最后一条做**前缀模式分发**（声明/返回/对象字面量/数组/控制流/赋值/表达式）。
  6. 表达式里的二元运算按优先级切片，交给对应的语义包装函数求值；若操作数里又出现函数调用，则递归回到第 2 步。
  7. 遇到 break/continue/throw 就抛对应异常、由外层循环或 try 捕获；遇到 return 就带一个「应返回」标记逐层向上传播，直到闭包边界把它变成返回值。

- **最小原理演示（替代旧「复刻范围」）**：
  - **应演示**：一个几十行的「最小 JS 求值器」骨架，演透主线——**正则文本切片 + 前缀分发递归求值 + 用异常做控制流 + 用显式深度计数器防栈溢出**。具体可演：对形如 `function f(a,b){ var c=a+b; return c*2; }` 的调用能正确求值；并附带演两个「JS 语义≠宿主语义」的细节（如 `x/0` 得到无穷、`break` 用异常跳出循环），以及递归调用被深度计数器限流时的报错。
  - **应故意省略**：完整运算符表、对象字面量提取、原型/方法分派、正则字面量内部的字符组状态机、调试器、JS↔JSON 转换等工程化外壳。
  - **演示载体建议**：**首选 TS/JS**。理由：本章核心是「递归下降求值 + 异常做控制流 + 深度计数防溢出」这套与语言无关的机制，用 TS/JS 完全能忠实演透，读者可直接 `node`/`bun` 跑通。本 Atlas 产物本身就是 JS 生态站点，TS/JS 演示对读者最友好。**无需退回原仓库语言（Python）**——这里用 Python 只是实现选型，本章教的并非 Python 特有语义；强行用 Python 反而让读者分心于宿主语法。配一个最小 `package.json` 使其能 `bun run`/`node` 即可。

- **正文不宜展开的细节**：正则字面量里字符组 `[]` 与转义的状态机细节；JS 数字转字符串在非十进制 radix 下的舍入传播；`new Date(...)` 的解析；调试器装饰器的缩进式轨迹打印；多种函数定义语法（`function x` / `x: function` / `var x = function`）的正则并集；`switch` 用「先匹配 case、再单独扫 default」的两轮策略。这些是工程外壳，Writer 应裁剪。

- **推荐的一个执行轨迹例子**：输入源码 `function f(a){return a+1}` 并调用 `f(41)` →（正则提出形参 `a`、函数体 `return a+1`；编译成闭包；调用时作用域栈顶写入 `{a:41}`）→ 语句 `return a+1` 命中「return」前缀、表达式 `a+1` 命中「变量名 + 二元运算」→ 查得 `a=41`，求 `41+1` → 输出 `42`，且「应返回」标记向上传播使闭包把 42 作为最终返回值交还调用方。

> 以上钩子供 Writer 写「动机→核心思想→心智模型→关键权衡→原理演示」；下面事实部分供核对，不要被 Writer 当目录照抄。

## 概念要点

- **JS 的 `undefined` 与 `null` 必须分开表示**：用一个空类 `JS_Undefined` 表示 JS 的 undefined，而宿主语言的 `None` 留给 JS 的 null。整套算术包装都靠「检测到 undefined 就返回 NaN」来复刻 JS 的 `undefined` 参与运算行为。源码位置: yt_dlp/jsinterp.py:202-203, 47-49, 60-63

- **位运算强制走 32 位有符号整数**：`int_to_int32` 取低 32 位，若最高位置位则减 `0x100000000` 转为有符号；所有位运算（`| ^ & << >>`）的两侧操作数与结果都经此转换，复刻 JS 的 ToInt32 抽象操作。源码位置: yt_dlp/jsinterp.py:21-26, 29-41

- **算术边界单独复刻**：`_js_div` 让除数为 0 时返回 `Infinity`、两值皆 0（或含 undefined）返回 `NaN`；`_js_exp` 规定 `0**0 === 1`（源码注释 `even 0 ** 0 !!`）；`_js_mod` 在模数为 0 时返回 `NaN`。这些都不是宿主语言原生行为。源码位置: yt_dlp/jsinterp.py:54-71

- **falsy 集合被显式列举**：`_js_ternary` 把 `(False, None, 0, '', JS_Undefined)` 与 `NaN` 判为假，其余为真——这是 JS 真值规则的一比一复刻，驱动 `if`/`while`/三元/逻辑短路。源码位置: yt_dlp/jsinterp.py:96-103

- **运算符是一张表 + 占位**：`_OPERATORS` 把每个符号映射到一个语义包装函数；其中 `?` `??` `||` `&&` 映射为 `None`，表示它们在 `_operator` 里走短路/条件特殊路径，而不是直接套函数。源码位置: yt_dlp/jsinterp.py:162-192, 365-378

- **控制流 = 异常**：`JS_Break` / `JS_Continue` / `JS_Throw` 三个异常类（都继承自提取器错误基类）承担 break / continue / throw 的非局部跳转；循环体 `try ... except JS_Break: break`、`except JS_Continue: pass`；try/catch 直接用宿主 try/except 实现。源码位置: yt_dlp/jsinterp.py:206-219, 567-548

- **作用域是 ChainMap**：`LocalNameSpace` 叠加多层字典。写入时**向上查找**已存在的同名变量就地改写（模拟 JS 对外层变量的赋值），找不到才写当前层；`set_local` 强制写当前层（用于 var 声明注册）；`get_local` 只看当前层。源码位置: yt_dlp/jsinterp.py:222-239

- **手写切片器是解析核心**：`_separate` 是一个状态机式分割器，同时跟踪「括号配对计数、当前引号、转义、是否刚离开操作符、是否在正则字符组内」。其中「是否刚离开操作符」用来消歧 `/`：操作符之后的 `/` 当成正则字面量起始，否则当除号。这是手写 JS tokenizer 最棘手的部分。源码位置: yt_dlp/jsinterp.py:317-354

- **前缀分发递归下降**：`interpret_statement` 是一个按「语句首字符/首关键字」做前缀匹配的巨型分发器（引号字面量 → `new` → `void` → `{}` 对象/块 → `()` → `[]` → try/if/for/switch → 赋值 → `++/--` → 裸变量/字面量 → 属性与方法调用 → 函数调用）。它返回 `(值, 应返回)` 二元组，「应返回」标志让 return 信号逐层上传。源码位置: yt_dlp/jsinterp.py:404-886

- **函数惰性提取 + 缓存为闭包**：首次调用某函数时，用正则在源码文本里定位其定义（支持 `function x` / `x: function` / `var x = function` 三种形态并集），编译成 `build_function` 返回的宿主闭包，缓存进 `_functions`；对象（`{key: function...}`）同理缓存进 `_objects`。源码位置: yt_dlp/jsinterp.py:881-883, 894-919, 921-941, 960-971

- **显式递归深度计数器防溢出**：每层调用消耗一点 `allow_recursion`（默认 100），到负数即抛「Recursion limit reached」。因为 tree-walking 的每一层 JS 调用都吃宿主调用栈，必须用计数器在崩溃前主动截断。源码位置: yt_dlp/jsinterp.py:405-408, 964-968

- **中间值「具名化」以复用解析路径**：`_named_object` 把字面量（数组、对象、求值结果）注入作用域，起一个形如 `__yt_dlp_jsinterp_objN` 的名字，让「后续对它的成员访问」能走和普通变量一样的解析路径，避免为「临时值」另写一套访问逻辑。源码位置: yt_dlp/jsinterp.py:298-304, 488-491

## 关键调用链

对外（提取器/YoutubeDL 侧）：
`JSInterpreter(code)` 构造（只存文本，不解析） → `call_function(name, *args)` / `extract_function(name)` → `extract_function_code`（正则提出形参+函数体） → `build_function` 返回宿主闭包 `resf` → 调用 `resf(args, allow_recursion)` → `interpret_statement(函数体, LocalNameSpace(...))`

对内（执行一个函数调用表达式 `fname(args)`）：
`interpret_statement` 前缀分发命中「函数调用」→ 求值参数列表 → 若 `fname` 已在作用域（已编译闭包/内置）则直接调；否则 `extract_function` 编译并缓存进 `_functions` → 进入闭包 → `interpret_statement(函数体)` 递归 → 内部遇到二元运算走 `_operator`、遇到成员方法走 `eval_method`、遇到嵌套函数调用又回到本链。

典型外部用法示例（VK 提取器）：构造解释器包一层 `function salt(){...}`，再 `extract_function('salt')([])` 取结果。
源码位置: yt_dlp/extractor/vk.py:61-62

## 源码摘录（带行号，全文累计 ≤ 30 行）

演「权衡 3：精确复刻 JS 数值语义」——32 位整数回绕：

```python
def int_to_int32(n):
    """Converts an integer to a signed 32-bit integer"""
    n &= 0xFFFFFFFF
    if n & 0x80000000:
        return n - 0x100000000
    return n
```
源码位置: yt_dlp/jsinterp.py:21-26

演「权衡 3」——除零与幂的边界（非宿主原生行为）：

```python
def _js_div(a, b):
    if JS_Undefined in (a, b) or not (a or b):
        return float('nan')
    return (a or 0) / b if b else float('inf')

def _js_exp(a, b):
    if not b:
        return 1  # even 0 ** 0 !!
    elif JS_Undefined in (a, b):
        return float('nan')
    return (a or 0) ** b
```
源码位置: yt_dlp/jsinterp.py:54-71

演「权衡 2：用异常做控制流」——break 与 throw 即异常：

```python
class JS_Break(ExtractorError):
    def __init__(self):
        ExtractorError.__init__(self, 'Invalid break')

class JS_Throw(ExtractorError):
    def __init__(self, e):
        self.error = e
        ExtractorError.__init__(self, f'Uncaught exception {e}')
```
源码位置: yt_dlp/jsinterp.py:206-219

演「权衡 4 + 心智模型步骤 3-4」——JS 函数编译成的宿主闭包（注意 allow_recursion 递减、实参按形参名注入作用域、should_abort 决定是否返回）：

```python
def resf(args, kwargs={}, allow_recursion=100):
    global_stack[0].update(itertools.zip_longest(argnames, args, fillvalue=None))
    global_stack[0].update(kwargs)
    var_stack = LocalNameSpace(*global_stack)
    ret, should_abort = self.interpret_statement(code.replace('\n', ' '), var_stack, allow_recursion - 1)
    if should_abort:
        return ret
```
源码位置: yt_dlp/jsinterp.py:964-970

## 易混淆 / 边界 / 推断

- **事实**：`interpret_statement` 的返回签名是 `(ret, should_return)`，`should_return=True` 表示触发了 `return`。`interpret_expression` 包了一层：若内部 `should_return` 为真就抛「Cannot return from an expression」（表达式语境不允许 return）。源码位置: yt_dlp/jsinterp.py:888-892
- **事实**：JS 的「严格相等 `===` / `!==`」被实现为宿主的 `operator.is_` / `operator.is_not`（对象同一性）。源码位置: yt_dlp/jsinterp.py:172-173
- **推断（标注为推断）**：用对象同一性来近似 `===`，对小整数和短字符串通常成立（因宿主会缓存它们），但严格说 JS 的 `===` 是「同类型且值相等」，并非引用相等。作者大概率是在「站点实际用到的比较场景下两者结果一致」这一经验前提下做的近似；若站点脚本出现大整数或构造出的字符串做 `===`，理论上可能偏离 JS 规范——这一点未见测试明确覆盖，标注待核。
- **事实**：JS 正则的 `g`/`d`/`y` 标志在宿主 `re` 里没有对应，故被分配了远高于现有位掩码上限的值（1024/2048/4096），仅作标记保留；源码注释指出尚未实现用这些标志执行匹配。源码位置: yt_dlp/jsinterp.py:274-285, 431-436
- **边界**：`_separate` 的 `/` 消歧依赖 `after_op` 状态机，正则字面量内部的字符组 `[]` 与反斜杠转义各有专门分支；这套手写状态机是整个解析器最脆弱的部分，站点 JS 一旦用到罕见的正则写法就可能切错。源码位置: yt_dlp/jsinterp.py:317-354
- **未理解**：`_separate` 中 `in_unary_op` 那一支（`after_op not in (True, False)` 的判断）的精确触发条件未完全厘清，它似乎是为了在「前缀一元 `+/-`」与「后续分隔符」之间消歧，但其与 `after_op` 取真值分支的交互边界需结合具体用例才能确认。建议 Writer 在正文里只讲「/ 消歧」这一层、不深入此分支。
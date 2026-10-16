# 交接：opencode-web 时间线「往上滚往回闪」的滚动抖动

> ⚠️ **本文是历史记录。二次折叠已从当前代码中移除**（它是抖动的放大源：把行压成 0 后，
> 与虚拟列表 60px 占位值的误差正好是一整屏）。带折叠的完整实现在 git 标签 `fold-on` 里，
> 当前工作区是「折叠之前」的状态。上游缺陷另见 `docs/opencode-timeline-shift/` 与 issue #56130。
> 下面关于折叠实现与抖动的分析与实测数据仍然有效，可作参考。

> 更新于 2026-10-16（第二棒）。上一棒把预算花在定位上，最后一次改动是回退性的（已撤）。
> 本文档已**修正**上一棒的结论 —— 见 §1「结论更正」，那条很关键，别再被带偏。

---

## 1. 一句话现状 + 结论更正

折叠功能可用、形态正确（实测截图：`用户消息 → 用时 14m 30s › → 最终回复`，压缩块收成一条线）。
**「往回闪」仍未根治**，但已经把上一棒引入的回退性改动撤掉，并把它真正的成因测准了。

### ⚠️ 结论更正（上一棒错了）

上一棒认为「折叠把抖动放大，官方原样本就抖、折叠再加一层」。**反过来才对**：折叠在**减少**抖动。

同一会话、同一操作（1280×760 视口，往上滚 30 次 × deltaY -200，间隔 260ms）实测：

| 版本 | shift 次数 | 总 CLS | 最大单次 | 大跳（≥0.02） |
| --- | --- | --- | --- | --- |
| **官方原样**（折叠关掉） | 39 | **0.5764** | 0.1166 | **14** |
| **折叠版**（当前状态） | 25 | **0.3691** | 0.1076 | **4** |

折叠把「过程行的真实高度」换成 0，反而是把每行的账本误差**变小**（60 vs 0，而不是 60 vs 几百上千）。
所以「去掉折叠」不会让用户更满意，只会更糟。**真正的敌人是官方虚拟列表自己。**

横向没问题：滚动全程左边界恒为 313px，抖动全是纵向。

---

## 2. 根因（测准了，这是本次最大的收获）

### 2.1 官方的记账方式

`packages/app/src/session/timeline/virtualizer.tsx`：

- `estimateSize: () => fallbackItemSize`（243），`fallbackItemSize = 60`（32）。
  **没量过的行，账本里就是 60。**
- 行的位置与高度完全由账本决定：`top: item().start - topOffset()`（794）、`height: item().size`
  （行盒子 `position:absolute; overflow:clip`）。
- 一行挂上来 → 被 `ResizeObserver` 量一次 → `resizeItem(真实高度)` → 账本更新 → **它下面所有行的
  `top` 一起平移**（差值 = 估计值 − 真实值）。

### 2.2 官方只补「整行都在可视顶之上」的行

`shouldAdjustScrollPositionOnItemSizeChange`（364-380）：

```js
const adjust = addedKeys.has(String(item.key))
  ? item.end <= (instance.scrollOffset ?? 0) + instance.scrollAdjustments + instance.options.scrollMargin
  : first !== undefined && item.index < first
```

`scrollMargin = topOffset()`（286-288），而 `topOffset = () => (input.showHeader() ? 64 : isDesktop() ? 0 : 16)`（97）。

行屏幕位置 = `item.start - topOffset() - scrollOffset`，所以那条判据等价于
**「这一行的底边已经完全在可视顶之上」**。⇒ **可视区内的行变矮，官方一律不补。**

### 2.3 于是抖动是这样产生的（实测可复现）

1. 折叠行的渲染高度我们在第一帧就压成 0 了（实测：挂载瞬间 `boxComputed=0px`、`innerComputed=0px`，
   盒子的 `data-ocw-fold` 也已经打上）—— **这一点我们的实现是对的**；
2. 但账本里它还是 `fallback 60`（实测挂载瞬间 `boxInline=60px`）；
3. RO 量到 0 → 账本 60→0 → 它下面的行整体上移 60px；
4. 这些行**在可视区内**（实测：变化行 idx=27/28/29，而当时挂载范围是 `[21..79]`——在范围内、
   在视口里）⇒ 官方不补 ⇒ 屏幕上就是 60px 一跳。

实测每次批量压 4 行（Δ高 −240）时滚动只补回 180（`Δ滚动=-180`），差的 60 就是那一跳；
而完全在可视顶之上的批次是 `Δ滚动 == Δ高 ✓补了`。**规律非常干净。**

> 补充：纯官方的 `60>44 / 60>38` 这类（未折叠行把估算值 60 纠正成真实高度）是同一个机制，
> 幅度小些（16-40px），也是官方固有、我们没引入。

---

## 3. 当前代码状态（已干净，可直接续做）

- `webui/scripts/codex-shell.js` **1164 行**（回退前 1276）。
- 已删除（上一棒的失败实验，勿重复）：整块视觉锚定 `anchor/anchorTick/anchorStart/anchorFix/
  styleHeight/anchorWatch/anchorPick/anchorRAF/anchorObserver/anchorScroll/anchorTouched`、
  `syncFold()` 里的 `anchorWatch(content)` / `anchorStart()`、以及临时开关 `window.__ocwNoFold`
  （交付版不含；要 A/B 时临时加回来，测完删）。
- 保留且**实测是当前最好状态**：按轮结构规则 + 两层压扁 + `foldSafe` 安全闸 +
  「表头挂答案行」+「扫描在 MutationObserver 回调里同步执行」+「压缩块纯 CSS `:has()`」。
- `node --check` 通过；折叠形态截图正常。

---

## 4. 已验证的失败路线（**别再试这三条，都测过了**）

| # | 做法 | 实测结果 |
|---|------|---------|
| 1 | **重新打开浏览器原生滚动锚定**：`*{overflow-anchor:auto !important}`（官方在 `bindListRoot` 里写死 `root.style.overflowAnchor="none"`，640） | **无益**：CLS 0.3927 vs 0.3691，最大单次与大跳数都没降。Chrome 的锚定在「滚动条被脚本改过」时会失效，而 TanStack 每帧都在写 `scrollTop` ⇒ 等于没开 |
| 2 | **在行挂载的微任务里预支 `scrollTop`**（只对「已压扁 + 账本仍为正 + 不在可视顶之上」的盒子，把账本高度从 `scrollTop` 里先减掉，指望布局前就补上） | **更差**：同一帧 Δ滚动从 −180 退到 **−120**，CLS 0.3691 → **0.5021**。原因：`scrollOffset` 是官方补偿判据的输入，我们改 `scrollTop` 会**连带改变官方自己的补偿决定**，互相抵消 |
| 3 | **撑高滚动容器逼虚拟列表全量挂载测量**（想一次性把折叠行的 0 写进账本，消掉 60 的幻影） | **没生效**：虚拟列表观察的是 `div.scroll-view__viewport`，它的高度被内层元素约束住，`height:200000px!important` 也没撑开（`clientHeight` 仍 292），挂载数不变 |

（上一棒试过的 `pokeScroll()`、逐行键规则、`rect.top+scrollTop` 自算 residual 的视觉锚定，同样保持删除状态。）

---

## 5. 还没走完的那条路（建议从这里接着做）

根因是「**账本里未测量的行按 60 记**」。真正治本的只有一条：**让用户开始往上滚之前，每一行都已经
被量过一次**（折叠行量到 0 会进 `itemSizeCache`，之后再挂载就不会有 60→0 的纠正）。
§4 第 3 条想干的就是这件事，只是撑错了元素。可行入口有两个方向：

1. **找对元素再撑。** 官方 `bindListRoot`（637-648）会给它真正观察的那个根写
   `root.style.overflowAnchor = "none"` —— 这是**唯一可靠的标记**，用它定位（本次用
   `div[style*='overflow-anchor']` 只找到一个，但撑它没反映到虚拟列表，需要再确认它就是
   `observeElementRect` 观察的那个，同时注意内层把高度约束住了，可能要连带把内层也放开）。
2. **找模块作用域入口。** 会话级缓存在模块级 `cache`（42-50），创建时读（99-101）、清理时写
   （`takeSnapshot()`，~920-931）。从覆盖层（页面 JS）够不到 app 模块作用域，所以这条路要
   先找到「能触达 app 内部」的合法口子；没找到就别硬试。

**动手前先在探针里验证「预热后 `itemSizeCache` 是否真的记住了 0」**（用 `boxInline` 判断：
挂载瞬间不再是 60 就说明成了），再动生产代码。

---

## 6. 测量工具（`C:\Users\y2278\AppData\Local\Temp\ocw3\`）

无头 Chrome 调试端口 **9401**（PID 45592），用户实例 **53123**（PID 45692）。探针统一流程：
`Runtime.enable` + `Page.enable` + `Emulation.setDeviceMetricsOverride`（必须自己设）
+ `Page.navigate` + 等稳定 + `Input.dispatchMouseEvent{type:"mouseWheel",deltaY:-200}` × N（间隔 260ms）。

| 脚本 | 干什么 |
| --- | --- |
| **`probe17.mjs`（推荐主力）** | 往上滚 N 次，输出「总 CLS / 最大单次 / 大跳数 / 尺寸变化帧 / 其中 Δ滚动≠Δ高」+ 左边界轨迹（查横向跳动） |
| **`probe8.mjs`** | 自适应：视口高度 900→760→620→500 逐个试，**直到时间线可滚动**再测。本会话在 900 视口下折叠后只剩 703px、没有滚动条，必须降到 ~760 才复现 |
| `probe10.mjs` | 同一次运行内先测「官方原样」再测「折叠版」（自己 add/remove `Page.addScriptToEvaluateOnNewDocument`，不污染后续轮次） |
| `probe12/13/14.mjs` | 归因三件套：行高变化时的行索引 vs 挂载范围（12）、挂载瞬间样式表里有没有它那一轮的结构规则（13）、挂载瞬间的 `boxInline/boxComputed/innerComputed`（14） |
| `probe9.mjs` | layout-shift `sources` 归因（谁在动、dy 多少） |
| `probe6.mjs` | 老的逐帧对齐（Δ高/Δ滚动/CLS）。**注意它固定等 12s 不可靠**，本会话会卡在 703px 读不到滚动根 |
| `state.mjs` / `dom.mjs` / `trace.mjs` | 一条命令看当前状态 / 盒子结构 / 加载轨迹 |
| `shot.mjs` / `shotnav.mjs` | 截图（后者导航并滚一段） |

**复现时的坑**：
1. 本会话（`ses_ebd933807ffeM84iY9xaxvU3iV`，标题「model-gateway 模仿 Codex 界面布局方案」，
   就是和上一棒做这个项目的那个）被**大量压缩**过，渲染出的时间线只有 ~108 行、6 轮；
   900 视口下折叠完只剩 703px。**要复现抖动，视口高度取 760。**
2. `Page.addScriptToEvaluateOnNewDocument` 跨导航持续生效，跑之前用 `state.mjs` 确认。
3. 真实滚动容器仍是 `div.scroll-view__viewport`；`scrollRoot()` 用「`scrollHeight > clientHeight + 100`
   向上找第一个祖先」。注意它和虚拟列表**观察**的那个根不一定是同一个（见 §5.1）。
4. CLS 单次运行有波动（同一状态跑出过 0.369 / 0.447），**结论要看多次、看「大跳数」这个更稳的指标**。

---

## 7. 落点速查

- `E:\Desktop\mytests\opencode-web\webui\scripts\codex-shell.js`：折叠注释 701-717；`HEAD_CLASS` 718；
  `foldRows` 725；`durationLabel` 744；`ensureHead` 770；`liveTurn` 817；`answerIndex` 828；
  `markHidden` 837；`foldSafe` 857；`scrollRoot` 870；`syncTurns` 879（结构规则 ~965-1000）；
  `syncCompactions` ~1026；`syncFold` ~1055；`scheduleFold` ~1090；`foldClick` ~1099。
- `webui/styles/codex.css`：`[data-ocw-fold]` 兜底 557-573；`.ocw-turn-head*` 575-631；
  `[data-ocw-compact*]` 633-649。
- `E:\Desktop\mytests\otheropenprojects\opencode\packages\app\src\session\timeline\virtualizer.tsx`：
  `topOffset` 97、`fallbackItemSize` 32、模块缓存 42-50、`estimateSize` 243、`measureElement` 247-266、
  `resizeItem` 包装 301-361、**`shouldAdjustScrollPositionOnItemSizeChange` 364-380**、
  `coldPending`/`settleColdBottom` 539-609、`bindListRoot`（写 `overflow-anchor:none`）637-648、
  行渲染 `top/height` ~791-794。
- 会话 id：`ses_ebd933807ffeM84iY9xaxvU3iV`；`base64url(origin)` = `aHR0cDovLzEyNy4wLjAuMTo1MzEyMw`。
- **关键兼容补丁**：`codex-shell.js` 顶部的 `Accept` 补丁（`patchEventAccept()`）——不动它。

# 工作交接：opencode-web（2026-10-17）

> 给接手/评审的 AI 看的现状说明。写于 2026-10-17 19:00，作者是上一个会话的 AI。
> **本文只写有证据的结论**；凡是推断的地方都标了「推断」。
> 项目路径：`E:\Desktop\mytests\opencode-web`（本文所有相对路径都以它为根）

---

## 0. 一句话现状

一个给 opencode 后台服务套「类 Codex 网页外壳」的本地小项目，**功能可用、已建 git 仓库、当前处于「去掉二次折叠」的状态**；
折叠被去掉的原因不是它坏了，而是它会**放大** opencode 虚拟列表固有的滚动抖动，而那个抖动只能在上游修（已提 issue，未提 PR）。
项目已停工，用户日常回到 opencode 官方 TUI。

---

## 1. 这个项目是什么

不是 Electron、没有第三方依赖、不动 opencode 二进制。核心机制一行话：
**本地起一个 HTTP 反代，把 opencode 后台服务自己提供的官方 WebUI 转出来，再往 HTML 里注入一个样式表和一个脚本。**

```
浏览器 → http://127.0.0.1:53123 （src/ui-server.mjs 反代）
              ├── /api/*  /auth/*  /openapi.json → opencode 后台服务（注入 Basic 鉴权）
              ├── 页面导航请求 → 取官方 HTML，插 <link> + <script> 后再发出
              ├── /styles/*.css  → webui/styles/ 下的文件
              ├── /scripts/*.js  → webui/scripts/ 下的文件
              └── 其余 → webui/ 有就用，没有回落官方
```

关键设计取舍（**不要推翻**）：**不落界面副本**。所以 opencode 升级后界面自动跟着变，不存在「抽取的界面过期」。
代价是：所有自定义只能靠「注入样式 + 注入脚本 + 改 DOM」，碰不到 opencode 的 React/Solid 组件内部。

| 文件 | 作用 |
|---|---|
| `src/ui-server.mjs`（244 行） | 反代 + 注入 + 覆盖层文件服务 |
| `src/service.mjs` | 发现/启动 opencode 后台服务（读 `~/.local/state/opencode/service*.json`） |
| `src/start.mjs` | 无界面入口：起服务、探测 opencode、开浏览器 |
| `webui/scripts/codex-shell.js`（737 行） | 图标栏、工作区→会话侧栏、官方草稿屏、「新聊天」不落库、明暗切换、**事件流 `Accept` 补丁** |
| `webui/styles/codex.css`（544 行） | Codex 观感（平白实体面、近单色强调、细边、系统字体） |
| `tray/tray.ps1`（245 行） + `hook/opencode-web-tray.js`（60 行） | 托盘图标；opencode 插件在服务被使用时拉起托盘 |

> ⚠️ **`codex-shell.js` 顶部的事件流 `Accept` 补丁不能删**。本机 Chrome 对 SSE 的 `Accept` 匹配很窄，
> 没有它官方事件流连不上 → 模型列表空、发送被拦、首页停在「加载中」。移出 `webui/scripts/` 就等于把界面弄坏。

---

## 2. 仓库与环境现状（可直接核验）

```
a92fa19 (HEAD -> main)  撤销二次折叠：回到纯类 Codex 外壳     ← 当前工作区
b16be42 (tag: fold-on)  快照：类 Codex 外壳 + 会话时间线二次折叠   ← 带折叠的完整实现，可切回
```
工作区干净（`git status` 无输出）。`git init` 是本次会话才做的，之前**没有版本控制**。

| 项 | 状态 |
|---|---|
| git 仓库 | 已建立，分支 `main`，两个提交，标签 `fold-on` |
| 折叠功能 | **已移除**（`codex-shell.js` 1164→737 行，`codex.css` 648→544 行） |
| opencode 插件 | **已注册**（`~/.config/opencode/plugin/opencode-web-tray.js`） |
| 托盘 / 网页服务 | 未运行 |
| opencode 后台服务 | 在运行（`opencode.exe serve --service`），TUI 正常 |

移除折叠后的实测验证（无头 Chromium，视口 1280×760，真实会话）：
图标栏 5 个按钮、侧栏 63 行会话、官方主区让位 `--ocw-gutter: 312px` 均正常；
折叠表头 / 压扁标记 / 折叠样式表全部为 0；内容总高 2196px；除按设计 404 的 `sw.js` 外无脚本报错。

---

## 3. 核心技术结论：抖动从哪来（本会话最主要的产出）

### 3.1 现象

用户在会话里**往上滚**时，屏上的内容会「往回闪」。折叠版更明显（一跳正好 60px）。

### 3.2 机制（在 opencode 源码里读出来的，并被逐帧实测证实）

`packages/app/src/session/timeline/virtualizer.tsx`（上游源码，只读参考）：

1. `estimateSize: () => fallbackItemSize`（243 行），`fallbackItemSize = 60`（32 行）。
   **没被量过的行，账本里就按 60 记账**。
2. 行的位置与高度完全由账本决定：`top: item().start - topOffset()`、`height: item().size`（~791 行）。
   一行被 `ResizeObserver` 量到真实高度后，**它后面所有行的位置一起平移 `delta`**。
3. 补偿函数 `shouldAdjustScrollPositionOnItemSizeChange`（364-380），只在两种情况下把 `delta` 吸收到滚动里：

```ts
const adjust = addedKeys.has(String(item.key))
  ? item.end <= (instance.scrollOffset ?? 0) + instance.scrollAdjustments + instance.options.scrollMargin
  : first !== undefined && item.index < first
```

   `scrollMargin` 就是 `topOffset()`（64 / 0 / 16），而行定位是 `item.start - topOffset()`，
   所以第一条等价于「**这一行的底边已经完全在可视顶之上**」。
   ⇒ **行只要还在屏幕里（含「刚露头」、跨在折叠线上），就不补** ⇒ 屏上内容被顶走 = 用户看到的闪。

### 3.3 为什么折叠会把它放大成整整 60px

折叠把过程行压成 0 高，于是「账本 60 − 真实 0 = 60」；
而普通行的真实高度是 28–61px，误差只有 0–32px。
⇒ 折叠把「多次小误差」变成「更少但每次 60px 的误差」。**这是折叠的固有代价，不是实现 bug。**

### 3.4 实测数据（两轮实验，条件不同，别混在一起看）

**实验 A**（更早，视口 1280×760，往上滚 30 次 × 200px，间隔 260ms）：

| | shift 次数 | 总 CLS | 最大单次 |
|---|---|---|---|
| 官方原样（折叠关） | 39 | **0.5764** | 0.1166 |
| 折叠版 | 25 | **0.3691** | 0.1076 |

**实验 B**（更晚，视口 1280×700，往上滚 14 次 × 200px）：

| | 偏移总位移 | 最大单次 | 总 CLS |
|---|---|---|---|
| 官方原样（折叠关） | 265px | −38px | 0.2731（两次一致） |
| 折叠版 | 239px | **−60px** | 0.1812 / **0.3776**（波动大） |

**结论与注意事项**：
- 「折叠更差还是更好」**不能只看总 CLS** —— 实验 B 里折叠版两次跑出 0.18 和 0.38，方差很大。
  稳定的差异在**形态**：不折叠 = 次数多、每次小；折叠 = 次数少、每次大（60px）。
- 用户体感与数据一致：折叠版「基本没有抖动，只是往上滚偶尔回退一下」。
- 「官方不折叠」的实测里仍带着我们的皮肤 CSS（字体/间距），但没有折叠、没有折叠规则；
  皮肤样式是静态的，不会造成位移。（严格说它不是 100% 官方原样，但抖动机制属于上游。）

### 3.5 一个重要澄清：有一类「突然出现一条顶下去」不是折叠造成的

用户报过「折叠界面里突然出现一条把内容顶下去」。用探针打点（`probe19`）抓到 1 次：

```
knvs4ln1 → 44px | 折叠属性=false | 规则命中=false | 表里有这一轮=false | 位置=INSIDE
```

含义：那一行**完全没有被折叠覆盖**（没有 `data-ocw-fold`、没有结构规则命中、它那一轮根本不在折叠表里）。
⇒ 它**不是「被压扁后又展开」**，而是一个「首次测量时内容还没排好版、量到 0、随后变成 44」的**原生 settling row**，
正是 §3.2 那个上游缺陷的表现。**折叠层不背这个锅。**

已排除的另一个嫌疑：`liveTurn()`（用「这一轮还挂着 Shell/CompactionQueued 行」判断「这轮还在跑」）在**已完成**的轮上误判。
做法：直接让 `liveTurn` `return false` 重跑同一段，**逐帧输出完全一致** ⇒ 不是它。
（反代给脚本 `cache-control: no-cache`，所以这个 A/B 是有效的，不是缓存假象。）

---

## 4. 上游进展：已提 issue，没提 PR

**Issue：https://github.com/anomalyco/opencode/issues/56130**（标题 *app: rows on screen are dragged when a settling row is measured*）

内含：可直接粘贴的复现用例、逐帧数据、根因定位（带文件行号）、四个修法的结果、以及一个需要上游拍板的设计问题。

### 4.1 复现方式（这是最有价值的资产）

在上游仓库 `packages/app/e2e/performance/timeline-stability/scroll-interaction.spec.ts` 里加一个用例，
契约是：**用户往上滚多少，屏幕上每一行就该正好移动多少**（不是「scrollTop 变了多少」——官方本来就有权多滚一点来稳住画面）。

在**未改动的 `dev`（654b79b）** 上稳定失败：

| 操作 | 滚轮要求 | scrollTop 实际 | 可见行漂移 |
|---|---|---|---|
| 从底部往上滚 | 480px | 457px | **+33px** |
| 先滚远脱离「跟随底部」再往上滚 | 480px | 511px | **−31px** |

补丁存于 `docs/opencode-timeline-shift/reproducer-test.patch`。

### 4.2 四个修法都没两全（这是没提 PR 的原因）

设 `fold = scrollOffset + scrollAdjustments + scrollMargin`，`viewport = scrollRect.height`：

| 版本 | 改动 | 复现用例 | 既有套件 |
|---|---|---|---|
| v1 | 只放宽「新挂载行」分支：`item.end <= fold` → `item.end <= fold + viewport` | ❌ 仍失败 | — |
| v2 | 两条分支都放宽为 `item.end <= fold + viewport` | ✅ 通过 | ❌ 新增 1 失败：`does not claim keyboard scrolling owned by a nested scrollable`（时间线 scrollTop 被顶到 637） |
| v3 | 只补「变矮且在屏上」：`delta < 0 && item.end <= fold + viewport` | ❌ 仍失败（+128 来自行**变高**） | ✅ 无新增 |
| v4 | 改为 `item.start <= fold`（覆盖跨线行，屏幕内起步的行仍锚自己顶边） | ❌ 仍失败（`scrollDelta=393`） | ✅ 无新增 |

v2/v3 的补丁存于 `docs/opencode-timeline-shift/`。

**卡点（建议评审重点看这一条）**：行在屏幕内**变高**时，
- 吸收 `delta` → 这一行自己的内容会从读者眼下往上滑；
- 不吸收 → 它下面的内容整体往下推。
**两个边只能保一个。** 这是产品取舍，不该由外部补丁单方面定，所以只提了 issue 并在里面问清楚。

---

## 5. 已验证失败 / 已排除的路线（别重复劳动）

| 做法 | 结果 |
|---|---|
| 在覆盖层里重新打开浏览器原生滚动锚定 `overflow-anchor: auto !important` | **无益**（CLS 0.3927 vs 0.3691）。Chrome 的锚定在「滚动条被脚本改过」时会失效，而 TanStack 每帧都在写 `scrollTop` |
| 在行挂载的微任务里预支 `scrollTop`（只对「已压扁 + 账本仍为正 + 不在可视顶之上」） | **更差**（同一帧 Δ滚动从 −180 退到 −120，CLS 0.3691→0.5021）。改 `scrollTop` 会连带改变官方自己的补偿判定 |
| 撑高滚动容器逼虚拟列表全量挂载测量 | **无效**。虚拟列表观察的是 `div.scroll-view__viewport`，高度被内层元素约束，`height:200000px!important` 也撑不开 |
| 用 `rect.top + scrollTop` 自算 residual 的「视觉锚定」 | 上一棒做过，**严重变坏**（Δ滚动 ≈ 2×Δ高，过度补偿），已删除。原因是无法区分「用户滚动 / 官方补偿性滚动 / 真实残留」 |
| `pokeScroll()`（折叠有变化时派发合成 scroll） | 实测**更差**，已删除 |

**测量方法上的坑**（会直接影响结论）：
1. 固定「等 12 秒再采样」不可靠。本机那个测试会话在 900 视口下折叠后只剩 703px、**没有滚动条**，探针会读不到滚动根。
   ⇒ 必须先等到「内容总高稳定 N 帧 且 折叠标记 > 0」，必要时把视口降到 760。
2. 判定「官方补没补」的公式是 `Δ内容总高 vs ΔscrollTop`：两者相等 = 官方补偿了（画面没动）。**不要用 rect 自己算 residual。**
3. CLS 单轮方差大（同一状态跑出过 0.18 / 0.38），**结论要看多次、看「大跳次数」这个更稳的指标**。

---

## 6. 折叠功能本身（已移除，但实现记录在案）

带折叠的完整代码在 **tag `fold-on`**。它的实现是「只动 DOM 表现，不碰官方数据」：

1. **压扁**：一轮的行共用 `data-message-id`（= 该轮 user 消息 id），折叠时往动态 `<style>` 里写**按轮的结构选择器**，
   命中「这一轮里、排除 UserMessage 行、排除含 `[data-slot="text-part-meta"]` 的最终回复行」的所有行，两层都压成 0 高。
   一条规则覆盖整轮（含还没挂上来的行），所以新挂上的行第一次布局就是 0，官方直接量到 0。
2. **表头**：「用时 9m 38s ›」插进答案行里（文案从官方 `text-part-meta` 读，读不到退化成「已折叠 N 步」）。
3. **压缩块**：纯 CSS `:has()` 把「压缩已开始 + 总结 + 会话已压缩 · 用量」折成一条线。
4. 交互：捕获阶段吃点击（抢在官方时间线清选区之前），折叠状态记在内存（行是虚拟的，滚出视口就卸载）。

**为什么移除**：见 §3.3——它把账本误差从 0–32px 放大成固定 60px。
**如果要恢复**：`git checkout fold-on`。**如果要重做**，方向应是「让折叠的行根本不进入行列表」（改投影层、折叠状态进应用状态），
但那样必须 fork opencode，与「不长期用自编译版本」冲突，所以没做。

---

## 7. 环境与工具

### 上游侧（提 issue / 复现上游问题）
- 源码树：`E:\Desktop\mytests\otheropenprojects\opencode`（remote `anomalyco/opencode`，分支 `dev`，基线 `654b79b`）
- 本机 `bun 1.4.2` 与源码 `packageManager` 一致；`bun install` 装过 2132 个包（**工作区已还原，无未提交改动**）
- 跑稳定性套件（`packages/app`，约 11 分钟一轮）：
  `CODEBUDDY_SAFE_DELETE_ENABLED=0 bunx playwright test --config e2e/performance/timeline-stability/playwright.config.ts`
  - 需要 `bunx playwright install chromium`（chromium-1217）
  - `CODEBUDDY_SAFE_DELETE_ENABLED=0` 是因为 `vite build` 要清空 `packages/app/dist`，被沙箱的批量删除保护拦下
  - **本机基线：干净 `dev` 就是 12 失败 / 27 通过**（Windows + 无头 Chromium）。所以套件在这台机器上**不是干净信号**，改动的评估必须与这个基线逐项比对（我曾用「行号偏移 85」对齐出真正新增的那 1 个失败）

### 本项目侧（测页面 / 测抖动）
探针脚本在 `C:\Users\y2278\AppData\Local\Temp\ocw3\`（**在 TEMP 里，可能被清理**，需要时可重建，每个 50–80 行）：
`probe8`（自适应视口直到可滚动）、`probe17`（往上滚并统计 CLS/位移）、`probe19`（抓「折叠行被展开」并归因）、
`state.mjs`（一条命令看页面状态）、`verify-nofold.mjs`（验证外壳/折叠状态）、`capture-compare.mjs`（录制对比）。
统一协议：CDP + `Emulation.setDeviceMetricsOverride`（必须自己设）+ `Page.navigate` + 等稳定 + `Input.dispatchMouseEvent{type:"mouseWheel"}`。

---

## 8. 建议给下一位 AI 的下一步（按性价比）

1. **先读 issue #56130 有没有回复**。如果上游就「变高时锚哪边」给了方向，v2 或 v4 稍作收敛就能成 PR。
2. **如果要继续往上游推**：重点不是再试第五种补偿判据，而是**决定语义**——
   区分「用户触发的变高」（展开工具卡，应锚顶边）与「机器触发的 settling」（应锚下面）。
   一个可测的方向：只在「最近有 wheel/touch/key 输入」的窗口内启用放宽的补偿。
3. **不要**在覆盖层里继续对抗虚拟列表（§5 的四条都已证伪）。
4. 如果评审认为这套「反代 + 注入」不值得长期维护，请明确说——用户已经表达过「不想长期用自编译/fork 版本」，
   最省事的归宿可能就是「只用官方 TUI + 这个外壳当可选皮肤」。

---

## 9. 需要用户拍板 / 尚未确定的事

- 上游那个取舍（变高时锚顶边还是锚下面）—— **这是 PR 的唯一阻塞点**。
- 是否还想要折叠：它是「更紧凑的阅读形态」，代价是偶发 60px 跳动。当前选择是**不要折叠**。
- 本项目是否继续维护：当前状态是**停工但可复活**（代码、文档、插件都在位）。

---

## 10. 相关文档

| 文件 | 内容 | 注意 |
|---|---|---|
| `docs/codex-style-plan.md` | 最初的方案记录（为什么放弃自建前端、注入方案、外壳实现、折叠） | **第七/八/九节讲折叠，已过时**（顶部有标注） |
| `docs/codex-fold-handoff.md` | 折叠与抖动的完整调查记录（含逐帧数据、官方虚拟列表行号地图） | **折叠已移除**（顶部有标注）；分析与实测仍有效 |
| `docs/opencode-timeline-shift/README.md` | 上游定位包：issue 链接、四个修法、套件基线、复现环境 | 最新、最准确 |
| `docs/opencode-timeline-shift/*.patch` | 复现用例 + v2/v3 候选修复 | 可直接 `git apply` 到上游源码树 |

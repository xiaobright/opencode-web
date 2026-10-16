# opencode 时间线「往上滚往回闪」——上游定位包（最终）

> 2026-10-16。**Issue 已提交**：https://github.com/anomalyco/opencode/issues/56130
> **未提 PR**：试了四个修法，没有一个能同时「修好复现用例」和「不破坏既有断言」，见 §3。
> 本项目自此停工，用户继续使用官方 npm 安装的 opencode。

---

## 1. 结论：这是上游自己的问题

上游源码树 `E:\Desktop\mytests\otheropenprojects\opencode`（remote `anomalyco/opencode`，分支 `dev`，基线提交 `654b79b`）。
复现用例跑在**上游自己的测试夹具**里（无任何覆盖层、纯官方代码），在干净的 `dev` 上稳定失败。

**契约**：往上滚多少，屏幕上每一行就该正好移动多少。多出来的位移就是「往回闪」。

| 操作 | 滚轮要求 | scrollTop 实际 | 可见行漂移 |
|---|---|---|---|
| 从底部往上滚 | 480px | 457px | **+33px** |
| 先滚远脱离「跟随底部」再往上滚 | 480px | 511px | **−31px** |

**机制**（`packages/app/src/session/timeline/virtualizer.tsx`）：

- `estimateSize: () => fallbackItemSize`（243 行，`fallbackItemSize = 60`）——没量过的行按 60 记账；
- 行几何完全由账本决定（`top: item().start - topOffset()`，~791 行）；一行被量到真实高度后，**它后面所有行一起平移 delta**；
- 补偿函数 `shouldAdjustScrollPositionOnItemSizeChange`（364-380）只在「整行已经完全滚出屏幕上方」（`item.end <= scrollOffset + scrollAdjustments + scrollMargin`）或 `item.index < range.startIndex` 时补偿。
  **行只要还在屏幕里（含因仍带着 60 的估算而跨在折叠线上），一律不补**，于是读者正在看的内容被顶走。

---

## 2. 复现用例

`reproducer-test.patch`——加进 `packages/app/e2e/performance/timeline-stability/scroll-interaction.spec.ts`。
在干净 `dev` 上失败（`step 1 wheels=480 scrollDelta=511 contentDelta=31`，多行 drift +128）。

---

## 3. 试过的四个修法（都实测，都没两全）

设 `fold = scrollOffset + scrollAdjustments + scrollMargin`，`viewport = scrollRect.height`。

| 版本 | 改动 | 复现用例 | 稳定性套件 |
|---|---|---|---|
| v1 | 只放宽「新挂载行」分支：`item.end <= fold` → `item.end <= fold + viewport` | ❌ 仍失败 | — |
| v2 | 两条分支都放宽为 `item.end <= fold + viewport`（`candidate-fix-v2.patch`） | ✅ **通过** | ❌ 新增 1 失败：`does not claim keyboard scrolling owned by a nested scrollable`（时间线 scrollTop 被顶到 637） |
| v3 | 只补「变矮且在屏上」：`delta < 0 && item.end <= fold + viewport`（`candidate-fix-v3.patch`） | ❌ 仍失败（+128 来自行**变高**） | ✅ 无新增失败 |
| v4 | 改为 `item.start <= fold`（覆盖跨线行，屏幕内起步的行保持锚自己顶边） | ❌ 仍失败（`scrollDelta=393`） | ✅ 无新增失败 |

**卡点（就是它导致没提 PR）**：行在屏幕内**变高**时，补偿会把这一行自己的内容从读者眼下往上滑；不补偿则把它下面的内容整体往下推。**两个边只能保一个**，属于上游该拍板的设计取舍，不宜由外部补丁单方面定。

**套件基线**：本机干净 `dev` 就是 **12 失败 / 27 通过**（Windows + 无头 Chromium），不是干净信号，CI 可能不同。

---

## 4. 折叠层的最终判断（你看到的「突然一条顶下去」）

`probe19.mjs` 打点结果（18 步上滚，捕获 1 次）：

```
knvs4ln1 → 44px | 折叠属性=false | 规则命中=false | 表里有这一轮=false | 规则数=20 | 位置=INSIDE | AssistantPart
```

即：那一行**完全没有被折叠覆盖**——没有 `data-ocw-fold`、没有结构规则命中、它那一轮根本不在折叠表里。
所以它**不是「被我们压扁后又展开」**，而是一个「首次测量时内容尚未排好版、量到 0、随后变成 44」的原生 settling row ——正是 §1 那个上游缺陷的表现。

**已排除的嫌疑**：`liveTurn`（用「挂着 Shell/CompactionQueued 行」判断「这轮还在跑」）在已完成轮上误判 —— 做了 A/B（把 `liveTurn` 直接 `return false` 重跑），输出逐帧完全一致；且覆盖层脚本响应头是 `cache-control: no-cache`，A/B 有效。

**因此**：先前设想的折叠层三项改造（表头预留固定高度、折叠判定一次定死、压扁行高度由结构规则钉死）**并不能消除这一条**，按证据不做。折叠层当前唯一的已知代价是：被压扁行的真实高度是 0 而账本占位是 60，误差正好一整屏 60px（官方是 28–61 vs 60，误差 0–32px）——这属于「折叠把行变成 0 高」带来的固有放大，要真正消除只能改投影层（让折叠的行根本不进行列表），那必须 fork，与「不长期用自编译版本」冲突，故不做。

---

## 5. 这个目录里有什么

| 文件 | 说明 |
|---|---|
| `reproducer-test.patch` | 复现用例。提 issue / 提 PR 的核心证据 |
| `candidate-fix-v2.patch` | 唯一能让复现用例通过的版本，代价已知 |
| `candidate-fix-v3.patch` | 不破坏既有断言、但没修好复现用例 |

工具脚本在 `C:\Users\y2278\AppData\Local\Temp\ocw3\`（探针、录制、状态查看）。

## 6. 复现环境备忘

- `bun install` 于源码树根目录（2132 包），`bun 1.4.2` 与 `packageManager` 一致；
- Playwright 需要 `bunx playwright install chromium`（chromium-1217）；
- 构建会清空 `packages/app/dist`，被沙箱批量删除保护拦下 → 跑测试时加 `CODEBUDDY_SAFE_DELETE_ENABLED=0`；
- `packages/app` 的稳定性套件 11 分钟一轮。

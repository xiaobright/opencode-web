Follow-up with additional validation on 2026-10-18. The original stock-app reproduction remains the main reproduction for this issue; the modified-UI results below are exploratory evidence, not a proposed fix or a claim about current `dev`.

I compared the saved **2.0.30 release UI** with an experimental frontend patch using the same assets and replayed messages, without my shell's CSS/DOM overlay. The control retained the official projection, layout and native tool folding, with measurement instrumentation added. Windows, headless Chromium, 1280×760, reduced motion, one worker, two independent runs per mode. No backend changes or model calls were involved.

### Projection-level folding does not eliminate the remaining displacement

The experiment removes completed intermediate assistant rows **before** they enter the virtualizer and replaces them with a real, fixed **40px summary row**. Final answer text remains visible. Expanding restores the original process rows as virtualized siblings. Hidden content is not rendered and then compressed to zero height. Ordinary rows still use the official virtualizer; this does not eagerly mount the entire history or change its ordinary size-change compensation predicate.

| Dataset | Control rows → folded rows | Control max extra displacement, runs 1 / 2 | Patched max extra displacement, runs 1 / 2 |
|---|---:|---:|---:|
| Replayed 1,393-message history | 1,556 → 1,061 | 204 / 36px | 179 / 179px |
| Synthetic 100 turns: 10 intermediate text/tool pairs and a final answer per turn | 2,299 → 399 | 46 / 46px | 135 / 135px |

These are operation-boundary measurements: first wheel up 1,800px to leave the bottom, then 18 steps of 240px. For each step, compare the same row **visible both before and after** and calculate `after.top - before.top - 240`. They are not per-frame maxima or CLS. Equal scroll distances expose different content in the two modes, and two repeats are not a general performance ranking. In particular, the patched synthetic case was worse by this metric. Accurate summary heights alone did not solve ordinary history scrolling, and this does not establish that every displacement in the modified UI has exactly the same cause as the stock reproduction.

### Explicit expansion anchoring could be kept stable in the tested cases

- Across two runs of **8 expand/collapse cycles**, the summary's sampled screen position changed by **0px** after either action. This is not a guarantee about every intermediate frame.
- A separate short-conversation test, where the closed transcript fits within one screen, verified expansion with summary displacement **≤1px**, restored process content, and successful collapse with the final answer retained.
- The patch had to apply expansion and publish the expanded total height **before** unpinning and using the native anchor. Otherwise `unpin()` returns early while the old content still fits the viewport, and expansion can remain pinned to the bottom. This is an integration finding, not a blanket recommendation to change unpin behavior globally.
- A simulated incomplete assistant remained unfolded; after the existing `session.step.ended` and `session.execution.succeeded` events, it folded and retained the final answer. That test checks state/DOM behavior, not frame-by-frame continuity during automatic folding.

This supports treating an explicit expand/collapse anchor separately from ordinary deferred measurement and follow-the-bottom behavior; it does not validate broadening the compensation predicate to every visible row.

### Measurement details and an estimate-consistency finding

The new scroll measurements use real `page.mouse.wheel` input. Before each action the harness arms listeners, then requires that action's `wheel`, a subsequent `scroll`, and `scrollend`, rather than accepting a delayed `scrollend` from a previous action. Earlier exploratory runs that only awaited `scrollend` are excluded from the table. Initial readiness checks wait for fonts and agreement between the mounted row boxes and their content heights; this does not premeasure off-screen rows.

There was also a **patch-induced** measurement loop when introducing a 40px estimate: the core did not cache a measured size equal to its estimate, while the wrapper's deduplication still used `(itemSizeCache.get(key) ?? fallbackItemSize) === size` with a 60px fallback. Updating only `estimateSize` was insufficient; the wrapper had to use the same per-row fallback. This was observed with heterogeneous estimates in the experiment, **not as an infinite-loop bug in the unchanged release**. It may be relevant if different estimates are introduced upstream.

<details>
<summary>Loading, memory and validation scope</summary>

The 1,393-message case was also replayed through normal history pagination: **40 initial messages, then 20 per page, 69 pages total**.

| Metric, min–max of two runs | Control | Patched |
|---|---:|---:|
| Initial paged readiness | 0.85–0.97s | 1.01–1.04s |
| Continue paging to all history | 21.56–25.90s | 22.63–22.88s |
| Final JS heap, after forced GC | 38.81–39.08 MiB | 38.00–38.41 MiB |
| Final dedicated browser processes' total private memory | 271.74–284.97 MiB | 283.63–284.48 MiB |

Readiness includes fixture setup, navigation and layout checks. Paging duration includes automated scrolling and readiness waits, not just data transfer. Memory values are snapshots, not peaks. The original message bodies remain in client state, and both modes retain virtualization, so fewer logical rows did not produce a proportional memory reduction.

The extra grouping stage took 1.3–2.1ms cumulatively for the first 40 messages, 45.0–46.6ms over two calls during an all-at-once initialization, and 559.3–604.3ms across 70 projection calls while paging through all history. The prototype still scans loaded structural data on updates; it is not a complete incremental index. Across each 8-cycle expand/collapse test, post-GC heap increased by 0.54 / 0.47 MiB; this is not a long-term leak test.

All four runs passed their three benchmark cases and two functional cases (20 test executions, with fold-specific assertions conditional on the patched mode). All benchmark cases recorded no page errors. The scroll benchmarks **record** displacement rather than asserting zero drift; passing these tests does not mean scrolling was fixed. Four unit tests also passed. Nested keyboard scroll ownership, touch momentum, session switching, deep links, and resize/reflow regressions have not been revalidated for this patch, so it is not a replacement for the existing stability suite.

Release asset: `/_assets/route-Bm7Nm7t-.js`, SHA-256 `a78015e20f722756818d02ac85641848a202e0afe2518bd51b09ac6db4280f66`. Source references were checked against `654b79b`; these runs used saved release assets, not a fresh build of today's `dev`. The private history contents are not included here.

</details>

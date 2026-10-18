// Auto-sleep for the opencode background service: when nobody has the web UI open, the
// service behind the gateway is stopped, and the next page open starts a fresh one.
//
// "Nobody has it open" is three independent signals, all measured at the gateway, the one
// process every web request passes through:
//   * a request (page open, API call, asset) — the tray's own 2s probe is excluded there,
//     otherwise it would keep the service awake forever
//   * a live /api/event stream — every open browser tab holds exactly one for as long as
//     the tab is open, so a stream is the strongest evidence the UI is open
//   * a session touched inside the window — the service is shared with the TUI and the
//     desktop app, which never talk to this gateway, so their activity is read from the
//     service itself
// All three idle at once is what "not opened" means here. Stopping a service the TUI is
// on is not fatal: its client runs Service.ensure and brings one back on next use.

export function autoSleep(env = process.env) {
  if (env.OPENCODE_WEB_SLEEP === "0") return { enabled: false, minutes: 0, ms: 0 }

  const minutes = Number(env.OPENCODE_WEB_IDLE_MINUTES ?? 15)
  if (!Number.isFinite(minutes) || minutes <= 0) return { enabled: false, minutes: 0, ms: 0 }

  return { enabled: true, minutes, ms: Math.round(minutes * 60_000) }
}

/** Pure decision: "keep" while any signal says somebody is around, "sleep" once all are quiet. */
export function idleVerdict({ streams = 0, idleFor = 0, sessionAge = Infinity, ms }) {
  if (streams > 0) return { action: "keep", reason: "a browser is holding an event stream" }
  if (idleFor < ms) return { action: "keep", reason: "the web UI was used recently" }
  if (sessionAge < ms) return { action: "keep", reason: "a session was used recently" }
  return { action: "sleep", reason: `no web use, no event stream and no session activity for ${ms / 60_000} minutes` }
}

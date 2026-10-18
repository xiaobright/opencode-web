import * as Service from "./service.mjs"

// One startup per gateway, shared by all tabs and proxy requests. Discovery
// only reads existing registrations; it never starts the backend.
export function createBackend({ service = Service, log = () => {} } = {}) {
  let pending
  let phase = "idle"
  return {
    get phase() { return phase },
    async discover() {
      const found = await service.discover()
      if (found) phase = "ready"
      else if (!pending && phase === "ready") phase = "idle"
      return found
    },
    start() {
      if (pending) return pending
      phase = "starting"
      pending = Promise.resolve().then(() => service.resolve({ onStart: () => log("starting the opencode background service") }))
        .then((found) => { phase = "ready"; return found })
        .catch((error) => { phase = "error"; throw error })
        .finally(() => { pending = undefined })
      return pending
    },
  }
}

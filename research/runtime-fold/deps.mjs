import { createRequire } from "node:module"
import { resolve } from "node:path"
export const upstream = process.env.OPENCODE_SOURCE ?? "E:/Desktop/mytests/otheropenprojects/opencode"
export const requireUpstream = createRequire(resolve(upstream, "packages/app/package.json"))
export const { test, expect, defineConfig } = requireUpstream("@playwright/test")

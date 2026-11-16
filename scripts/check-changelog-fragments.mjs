#!/usr/bin/env node
// Release gate for changelog fragments (changelog.d/README.md).
// A release PR (branch release/*) must have collected every fragment into CHANGELOG.md.
// If any fragment file is left in changelog.d/, this script fails. Other branches pass.
import { readdirSync } from "node:fs"
import { execSync } from "node:child_process"

function branchName() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF
  try { return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() } catch { return "" }
}

const branch = branchName()
let left = []
try { left = readdirSync("changelog.d").filter((f) => f.endsWith(".md") && f !== "README.md") } catch { left = [] }
if (branch.startsWith("release/")) {
  if (left.length > 0) {
    console.error()
    for (const f of left) console.error()
    console.error("Merge origin/development, move every fragment into the new release section and delete the files (docs/development.md, Cut a release).")
    process.exit(1)
  }
  console.log()
} else {
  console.log()
}

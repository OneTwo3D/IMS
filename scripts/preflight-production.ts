#!/usr/bin/env tsx

import path from 'node:path'
import { pathToFileURL } from 'node:url'

export {
  formatPreflightResult,
  runProductionPreflight,
  type PreflightCheck,
  type PreflightResult,
  type PreflightStatus,
} from '../lib/ops/production-preflight.ts'

import {
  formatPreflightResult,
  runProductionPreflight,
} from '../lib/ops/production-preflight.ts'

async function main(): Promise<void> {
  const result = await runProductionPreflight()
  const output = formatPreflightResult(result)
  if (result.ok) {
    console.log(output)
  } else {
    console.error(output)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}


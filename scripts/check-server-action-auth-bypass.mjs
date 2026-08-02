#!/usr/bin/env node

/**
 * Static guard: no Server Action may accept a SERIALIZABLE authorization
 * bypass (o3d-43oz).
 *
 * A module-wide `'use server'` file makes every exported function directly
 * POST-callable, and every argument crosses the RPC boundary. So a plain
 * option like
 *
 *     options?: { skipPermissionCheck?: boolean }
 *
 * is something any client can simply send. `applySalesOrderStatusTransition`
 * had exactly that: sending it suppressed `requirePermission('sales.process')`
 * outright, after which a caller with no permission could drive any
 * state-machine-legal transition — including CANCELLED from
 * PROCESSING/ALLOCATED/PICKING/PACKING, which releases reservations and
 * deletes pending shipments. The state machine constrains the SHAPE of a
 * transition; it is not authorization.
 *
 * The supported pattern is an unforgeable capability: a `symbol`, which cannot
 * be serialized and so can only be supplied by server-side code that imports
 * it. See lib/sales/status-transition-bypass.ts.
 *
 * This guard flags PARAMETER declarations in `'use server'` files whose name
 * reads like an auth bypass and whose type is serializable. Behaviour flags
 * (`force`, `allowCache`, `skipLog`, …) are deliberately NOT matched — they do
 * not gate a permission check. The names below are the ones that do.
 *
 * Per-line waiver: `// server-action-auth-bypass-ok: <ticket>: <reason>` on the
 * same line or the line immediately above.
 *
 * Run via `npm run check:server-action-auth-bypass`; invoked by
 * `npm run check:all`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib']
const EXTS = new Set(['.ts', '.tsx'])
const SKIP_DIRS = new Set(['node_modules', '.next', 'generated', 'dist', 'build'])

/**
 * Names that gate AUTHORIZATION rather than behaviour. Deliberately narrow: a
 * broad match on /skip|bypass/ would flag skipLog, skipPreferredSupplierUpdate
 * and similar, and a guard that cries wolf gets waived into uselessness.
 */
const AUTH_BYPASS_NAME = /\b(skipPermissionCheck|skipAuth|skipPermission|bypassPermission|bypassAuth|skipAuthorization|allowUnauthenticated|asSystem|isInternal|internalCall|trusted)\b/

/** Serializable — i.e. a client can send it. `symbol` is what we want instead. */
const SERIALIZABLE_TYPE = /:\s*(boolean|string|number|true|false)\b/

const WAIVER = /server-action-auth-bypass-ok:/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.has(extname(entry))) out.push(full)
  }
  return out
}

const violations = []

for (const root of SCAN_ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const source = readFileSync(file, 'utf8')
    // Only module-wide 'use server' files expose every export over RPC.
    if (!/^\s*['"]use server['"]/m.test(source.slice(0, 400))) continue

    const lines = source.split('\n')
    lines.forEach((line, i) => {
      if (!AUTH_BYPASS_NAME.test(line)) return
      if (!SERIALIZABLE_TYPE.test(line)) return
      if (WAIVER.test(line) || (i > 0 && WAIVER.test(lines[i - 1]))) return
      // A comment ABOUT the pattern is not the pattern.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      violations.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
    })
  }
}

if (violations.length > 0) {
  console.error(
    'Server Action authorization-bypass violation: a serializable option that '
    + 'gates a permission check is directly POST-callable by any client.\n'
    + 'Use an unforgeable capability instead — a `symbol` cannot be serialized. '
    + 'See lib/sales/status-transition-bypass.ts and o3d-43oz.\n'
    + 'If this is genuinely not an auth gate, add a waiver:\n'
    + '// server-action-auth-bypass-ok: <ticket>: <reason>\n',
  )
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

console.log('Server Action auth-bypass check passed.')

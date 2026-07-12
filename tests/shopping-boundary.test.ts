import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * mz3ly/th34p (WC-followup Phase 6): freeze the shopping-connector boundary in the shared
 * app layer. Non-connector dashboard/page/component code must consume generic shopping
 * selectors/descriptors — it must NOT import from lib/connectors/woocommerce or read
 * `wc_*` settings directly, so the active shopping connector can change without editing
 * shared code.
 *
 * Scope = shared UI: app/(dashboard)/** and components/**. EXEMPT:
 *  - app/(dashboard)/sync/  — the integrations/admin tab is the connector-owned admin
 *    surface (its descriptor refactor is tracked under czuf4), not shared page code.
 *  - *.test.* files.
 * Connector-identity flags like `plugins.woocommerce` are fine (they name the connector,
 * not a `wc_` setting); the guard targets the `wc_<key>` form and direct connector imports.
 */

const ROOT = process.cwd()
const SCANNED = [path.join('app', '(dashboard)'), 'components']
const EXEMPT_DIRS = [path.join('app', '(dashboard)', 'sync')]
const CODE_EXT = new Set(['.ts', '.tsx'])

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full)
    if (EXEMPT_DIRS.some((ex) => rel === ex || rel.startsWith(ex + path.sep))) continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      out.push(...walk(full))
    } else if (CODE_EXT.has(path.extname(entry.name)) && !entry.name.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

const sharedFiles = SCANNED.flatMap((d) => walk(path.join(ROOT, d)))

test('the th34p audit found shared UI files to scan (guard is wired up)', () => {
  assert.ok(sharedFiles.length > 50, `expected to scan shared UI files, found ${sharedFiles.length}`)
})

test('no shared dashboard/component code imports from lib/connectors/woocommerce (th34p)', () => {
  // Catch every import form — static `from '…'`, side-effect `import '…'`, dynamic
  // `import('…')`, and `require('…')` — and any path (alias OR relative) that resolves
  // into a woocommerce connector module, since dynamic connector imports are a common
  // repo pattern that could otherwise sneak into shared UI.
  const offenders = sharedFiles.filter((file) =>
    /(?:from|import|require)\s*\(?\s*['"][^'"]*\/connectors\/woocommerce/.test(readFileSync(file, 'utf8')),
  )
  assert.deepEqual(
    offenders.map((f) => path.relative(ROOT, f)),
    [],
    'shared UI must consume the generic shopping boundary, not import lib/connectors/woocommerce directly',
  )
})

test('no shared dashboard/component code reads wc_* settings/fields directly (th34p)', () => {
  const offenders: string[] = []
  for (const file of sharedFiles) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // `wc_<key>` is the WooCommerce-specific Setting-key / field form, including a
      // template-built key like `wc_${name}`. `woocommerce` (connector identity) and
      // `externalOrder*` (generic fields) are intentionally not matched.
      if (/\bwc_[a-z$]/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`)
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'shared UI must read shopping state through generic selectors, not wc_* keys/fields',
  )
})

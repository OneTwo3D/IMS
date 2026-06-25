import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * vwyfw/bulhr: freeze lib/accounting.ts as the permanent app-facing accounting boundary.
 *
 * The facade must expose only GENERIC accounting capabilities — core app code imports
 * from here, never from a connector module. Connector-specific implementations are
 * reached through dynamic `await import('@/lib/connectors/<connector>/…')` dispatch
 * INSIDE function bodies, so they never become part of the module's public/static
 * contract. These guards fail if a connector import leaks into the top-level import
 * block or a connector name leaks into the exported type surface, which would mean a new
 * accounting connector requires editing this boundary file.
 */

const ACCOUNTING_BOUNDARY = path.join(process.cwd(), 'lib', 'accounting.ts')
const source = readFileSync(ACCOUNTING_BOUNDARY, 'utf8')

// Module specifiers of static `import … from '…'` / `export … from '…'` statements,
// including multi-line ones. Every static import/re-export uses `from '<spec>'`; dynamic
// imports use the `import('<spec>')` call form (no `from`) and are intentionally NOT
// matched, since those are the allowed in-function connector dispatch.
function staticImportSpecifiers(code: string): string[] {
  return [...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
}

test('lib/accounting.ts does not statically import any connector module (bulhr)', () => {
  const offenders = staticImportSpecifiers(source).filter((spec) => spec.includes('/connectors/'))
  assert.deepEqual(
    offenders,
    [],
    `lib/accounting.ts must reach connectors via dynamic import() only; static connector imports found: ${offenders.join(', ')}`,
  )
})

test('lib/accounting.ts static imports name no specific accounting connector (bulhr)', () => {
  const offenders = staticImportSpecifiers(source).filter((spec) => /xero|quickbooks/i.test(spec))
  assert.deepEqual(
    offenders,
    [],
    `lib/accounting.ts's static contract must be connector-agnostic; connector-named imports found: ${offenders.join(', ')}`,
  )
})

test('exported type names in lib/accounting.ts are connector-agnostic (bulhr)', () => {
  const exportedTypeNames = [...source.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  const offenders = exportedTypeNames.filter((name) => /Xero|QuickBooks/i.test(name))
  assert.deepEqual(
    offenders,
    [],
    `lib/accounting.ts public types must be generic; connector-named exported types found: ${offenders.join(', ')}`,
  )
  // Sanity: we actually found the boundary's exported types (guards against a regex that
  // silently matches nothing if the file is renamed/restructured).
  assert.ok(exportedTypeNames.length >= 3, 'expected lib/accounting.ts to export generic accounting types')
})

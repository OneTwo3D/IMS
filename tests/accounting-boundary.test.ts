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

/**
 * THE ONE STATIC `/connectors/` IMPORT THIS BOUNDARY MAY HAVE (o3d-remove-parked-connectors).
 *
 * `lib/connectors/accounting-registry` is the CONNECTOR-AGNOSTIC registry — the id union, the
 * definition list and the keyed factory. It is the opposite of what this rule forbids: the rule
 * exists so a new accounting connector does not require editing this file, and resolving "which
 * connectors exist" from the registry is precisely what makes that true. The alternative is the
 * shape this branch removed — hand-written `if (id === 'xero') … if (id === 'quickbooks')` chains,
 * which name connectors in this file and have to be edited for every new one.
 *
 * It is allowed BY NAME, not by pattern: `lib/connectors/xero/...` and every other connector module
 * is still refused, and the second test below independently refuses any static import whose
 * specifier NAMES a connector — so this allowance cannot be widened into one.
 */
const CONNECTOR_AGNOSTIC_IMPORTS = ['@/lib/connectors/accounting-registry']

test('lib/accounting.ts does not statically import any connector module (bulhr)', () => {
  const offenders = staticImportSpecifiers(source)
    .filter((spec) => spec.includes('/connectors/'))
    .filter((spec) => !CONNECTOR_AGNOSTIC_IMPORTS.includes(spec))
  assert.deepEqual(
    offenders,
    [],
    `lib/accounting.ts must reach connectors via dynamic import() only; static connector imports found: ${offenders.join(', ')}`,
  )
})

test('the allowance names only modules that really are in the file, and really are agnostic (bulhr)', () => {
  // A stale allowance is an allowance for something else. Both halves are checked: the specifier is
  // actually imported, and it names no connector (which the next test then re-checks over the WHOLE
  // import list, so the allowance cannot be used to smuggle one in).
  const specifiers = staticImportSpecifiers(source)
  for (const allowed of CONNECTOR_AGNOSTIC_IMPORTS) {
    assert.ok(specifiers.includes(allowed), `${allowed} is allowed but not imported — delete the allowance`)
    assert.ok(!/xero|quickbooks|woocommerce|mintsoft|shopify/i.test(allowed),
      `${allowed} names a connector, so it cannot be allowed as connector-agnostic`)
  }
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

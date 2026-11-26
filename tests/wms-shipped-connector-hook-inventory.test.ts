/**
 * A REGISTRY ENTRY CANNOT SILENTLY LOSE A HOOK (o3d-j8yq).
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. The behavioural tests
 * (tests/wms-dispatch-hook-wiring.test.ts, tests/wms-booked-in-recheck-wiring.test.ts) drive three
 * hooks through the production entrypoints and go red when those hooks are deleted. This is the
 * UNIVERSAL backstop for the other four, which have no such test against the SHIPPED connector:
 * `asn`, `productSync`, `syncDashboard` and `onboarding` are driven only against the fictitious
 * `acme-wms` in the seam suites, where the registry module is replaced wholesale — so the shipped
 * Mintsoft registration could lose any of them and every suite in the repo would stay green.
 *
 * BE CLEAR ABOUT WHAT IT ESTABLISHES. This proves DECLARATION, not REACHABILITY: it says the shipped
 * connector still declares a hook, never that the generic layer routes to it. That is the weaker
 * claim, and it is the reason this file is a backstop rather than the answer — a hook whose only
 * coverage is here is a hook whose wiring is still unproven, and the fix for that is a test like the
 * two named above, not a longer list here.
 *
 * WHY THE LIST IS DERIVED AND NOT WRITTEN DOWN. A hand-written array of seven names is a second copy
 * of the contract, and a second copy is what stops noticing. So the hook names come out of the
 * PARSE TREE of `WmsConnectorHooks` (lib/connectors/wms/connector-hooks.ts) — the one place the
 * generic layer says which capabilities it routes on — using the TypeScript compiler the repo
 * already depends on for scripts/check-wms-connector-boundary.mjs. Adding a hook to the contract
 * therefore fails this test until the shipped connector declares it, or until somebody writes down
 * in `DELIBERATELY_NOT_DECLARED` below why it cannot.
 *
 * NON-VACUOUS BY CONSTRUCTION. The derived set is asserted non-empty and its members are printed, so
 * a parse that silently resolved nothing cannot pass: a guard that finds no subjects and reports
 * success is the failure mode this repo has been bitten by before.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS_CONTRACT = 'lib/connectors/wms/connector-hooks.ts'

/**
 * A hook the shipped connector genuinely cannot serve, and why.
 *
 * EMPTY TODAY, and that is the point: Mintsoft declares every hook the contract admits. An entry
 * here is a deliberate statement that a capability does not apply to this warehouse, which the
 * generic layer must already degrade around — never a way to quiet this test.
 */
const DELIBERATELY_NOT_DECLARED: Readonly<Record<string, string>> = {}

/** Every member name of the `WmsConnectorHooks` type alias, read from its own parse tree. */
function hookNamesFromContract(): string[] {
  const file = path.join(repoRoot, HOOKS_CONTRACT)
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)

  const alias = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === 'WmsConnectorHooks',
  )
  // A HARD FAILURE, never a silently shorter list — the same rule the boundary guard learned in
  // o3d-remove-shiphero round 4. A guard that cannot resolve its subject has not checked anything.
  assert.ok(alias, `could not find the WmsConnectorHooks type alias in ${HOOKS_CONTRACT}`)
  assert.ok(
    ts.isTypeLiteralNode(alias.type),
    'WmsConnectorHooks is no longer a type literal — this test reads its members and must be rewritten,'
    + ' not skipped',
  )

  const names: string[] = []
  for (const member of alias.type.members) {
    assert.ok(
      ts.isPropertySignature(member) && member.name !== undefined,
      'every WmsConnectorHooks member must be a named property for this guard to resolve it',
    )
    const name = member.name
    assert.ok(
      ts.isIdentifier(name) || ts.isStringLiteral(name),
      `a WmsConnectorHooks member name this guard cannot resolve: ${name.getText(source)}`,
    )
    names.push(name.text)
  }
  return names
}

test('inventory: every hook the generic layer routes on is declared by the connector this build ships', async () => {
  const { BUILT_IN_WMS_CONNECTOR_REGISTRATIONS } = await import('../lib/connectors/wms/registry.ts')
  const contractHooks = hookNamesFromContract()

  // PRINT THE MATCH COUNT, and refuse a suspiciously small one. Seven is what the contract carries
  // today; the bound is a floor rather than an equality so adding a hook does not fail HERE, it
  // fails on the per-connector assertion below where the remedy is.
  console.log(`[o3d-j8yq] WmsConnectorHooks declares ${contractHooks.length} hook(s): ${contractHooks.join(', ')}`)
  assert.ok(
    contractHooks.length >= 7,
    `the contract resolved to only ${contractHooks.length} hook(s) — this guard has stopped seeing its`
    + ' subject, which is worse than it failing',
  )

  const registrations = Object.entries(BUILT_IN_WMS_CONNECTOR_REGISTRATIONS) as Array<[string, { hooks?: Record<string, unknown> }]>
  assert.ok(registrations.length >= 1, 'precondition: this build registers at least one WMS connector')

  let checked = 0
  for (const [connectorId, registration] of registrations) {
    const declared = registration.hooks ?? {}
    for (const hook of contractHooks) {
      checked += 1
      const exemption = DELIBERATELY_NOT_DECLARED[`${connectorId}.${hook}`]
      if (exemption) continue
      assert.equal(
        typeof declared[hook], 'function',
        `the shipped "${connectorId}" registration no longer declares hooks.${hook}. The generic layer`
        + ' routes on the PRESENCE of that declaration, so dropping it does not fail — it makes the flow'
        + ' report "this connector cannot do that" for a connector that can. If the capability really'
        + ` does not apply, say so in DELIBERATELY_NOT_DECLARED ('${connectorId}.${hook}') with the reason.`,
      )
    }
  }
  console.log(`[o3d-j8yq] checked ${checked} (connector, hook) pair(s) across ${registrations.length} registration(s)`)
  assert.equal(
    checked, registrations.length * contractHooks.length,
    'precondition: every (connector, hook) pair was reached — a walk that skipped pairs proves nothing',
  )
})

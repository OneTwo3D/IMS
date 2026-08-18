import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { ROLES, getPermissions, hasPermission, landingForRole, landingIsReachableBy } from '@/lib/permissions'
import { installSyncPageMocks, renderSyncPage, resetSyncPageState, state } from './sync-page-harness'

// ---------------------------------------------------------------------------
// o3d-osl8 round 5, finding 4 — where the Integrations denial screen SENDS a refused role.
//
// The screen was introduced in round 4 to stop an entitlement failure being reported as a crash
// with two dead-end buttons. It then offered a single hard-coded /dashboard link on the claim that
// "every authenticated role can reach it". SUPPLIER cannot: it does not hold `dashboard`, so
// /dashboard's own read throws a typed denial and the reader lands in the generic error boundary —
// the exact dead end the screen exists to remove, one click later. The claim was reviewed and
// approved; being plausible is what made it dangerous.
//
// So reachability is never asserted from a route NAME here. Each destination declares the gate it
// has to pass, and the gate is checked twice: against ROLE_PERMISSIONS, and against the target's
// OWN source. A route that silently re-gates itself fails this file rather than the operator.
// ---------------------------------------------------------------------------

installSyncPageMocks()

test.beforeEach(resetSyncPageState)

/** Roles refused by /sync. Derived from the matrix, so a future grant of `sync` shows up here. */
const DENIED_ROLES = ROLES.filter((role) => !hasPermission(role, 'sync'))

test('the roles this screen is for are exactly the ones without `sync`', () => {
  assert.deepEqual(DENIED_ROLES, ['WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER'])
  // The premise of the whole finding: one of them cannot reach the old hard-coded destination.
  assert.ok(!getPermissions('SUPPLIER').has('dashboard'), 'SUPPLIER holds no `dashboard` — /dashboard would deny it')
  assert.ok(getPermissions('WAREHOUSE').has('dashboard'), 'while the other three do hold it')
})

test('EVERY role — denied or not — gets a landing it actually satisfies', () => {
  for (const role of ROLES) {
    const landing = landingForRole(role)
    assert.ok(
      landingIsReachableBy(landing, role),
      `${role} is sent to ${landing.href}, whose gate (${JSON.stringify(landing.gate)}) it does not satisfy`,
    )
  }
})

test('SUPPLIER is sent to the supplier portal, not to /dashboard', () => {
  assert.deepEqual(landingForRole('SUPPLIER'), {
    href: '/supplier/rfqs',
    label: 'Go to your RFQs',
    gate: { kind: 'role', role: 'SUPPLIER' },
  })
  // And the reason it is a ROLE gate rather than a permission one: holding supplier_portal.rfq is
  // not what the target checks, so declaring a permission there would be the same unverified
  // claim in a new place.
  assert.ok(!landingIsReachableBy(landingForRole('SUPPLIER'), 'ADMIN'), 'ADMIN does not satisfy a SUPPLIER-role gate')
})

test('an unknown or missing role falls back to the one destination every role holds', () => {
  for (const role of [null, undefined, '', 'FUTURE_ROLE']) {
    assert.equal(landingForRole(role).href, '/help', `${String(role)} must not be handed a link it cannot open`)
  }
  for (const role of ROLES) {
    assert.ok(hasPermission(role, 'help'), `${role} must hold \`help\` for /help to be a safe fallback`)
  }
})

// --- the destinations' OWN gates, read from their own source ----------------
//
// ROLE_PERMISSIONS agreement is necessary and not sufficient: what actually refuses a reader is
// the code at the destination. These read it.

function sourceOf(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), 'utf8')
}

test('/dashboard really gates on the `dashboard` permission', () => {
  const page = sourceOf('app', '(dashboard)', 'dashboard', 'page.tsx')
  assert.match(page, /getDashboardData\(/, 'the page still gets its data from getDashboardData')

  const action = sourceOf('app', 'actions', 'dashboard.ts')
  const body = action.slice(action.indexOf('export async function getDashboardData'))
  assert.match(
    body.slice(0, body.indexOf('\n}\n')),
    /await requirePermission\('dashboard'\)/,
    'if this read is ever re-gated, the roles sent to /dashboard must be re-decided',
  )
})

test('/supplier/rfqs really gates on the SUPPLIER role', () => {
  const page = sourceOf('app', '(dashboard)', 'supplier', 'rfqs', 'page.tsx')
  assert.match(page, /await requireAuth\(\)/, 'authentication only, plus:')
  assert.match(
    page,
    /session\.user\.role !== 'SUPPLIER'/,
    'a ROLE check, not a permission one — which is why the landing declares a role gate',
  )
})

test('/help is authentication-only, which is what makes it the universal fallback', () => {
  const page = sourceOf('app', '(dashboard)', 'help', 'page.tsx')
  assert.doesNotMatch(page, /requirePermission\(/, 'a permission gate here would break the fallback for some role')
  // The (dashboard) layout still requires a session, so this is not a public page.
  assert.match(sourceOf('app', '(dashboard)', 'layout.tsx'), /await requireAuth\(\)/)
})

// --- what the refused reader is actually shown ------------------------------

test('the rendered destination is correct for EVERY denied role, SUPPLIER included', async () => {
  state.plugins = { woocommerce: true, xero: true }

  for (const role of DENIED_ROLES) {
    state.role = role
    state.calls = []
    const { names, html } = await renderSyncPage()

    const landing = landingForRole(role)
    assert.deepEqual(names, ['SyncAccessDenied'], `${role} must still be refused the page itself`)
    assert.match(html, new RegExp(`href="${landing.href}"`), `${role} must be offered ${landing.href}`)
    assert.match(html, new RegExp(landing.label), `${role} must be told where the link goes`)
    assert.ok(landingIsReachableBy(landing, role), `${role} must be able to open it`)
  }
})

test('SUPPLIER is no longer sent to a page that denies it', async () => {
  // The regression, stated as the operator experiences it.
  state.role = 'SUPPLIER'
  state.plugins = { xero: true }

  const { html } = await renderSyncPage()

  assert.ok(!html.includes('href="/dashboard"'), 'the destination SUPPLIER cannot open must be gone')
  assert.match(html, /href="\/supplier\/rfqs"/)
})

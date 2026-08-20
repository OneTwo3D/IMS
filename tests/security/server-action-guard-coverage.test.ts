import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  createRepoGraph,
  prismaSurfaceOf,
  scanActionsDir,
  scanAuthenticationOnlyActions,
  scanSecretReadingActions,
  scanSource,
  scanUseServerOutsideActions,
} from './server-action-guard-scan'

// Regression guard for onetwo3d-ims-mgq1: every exported async function in a
// 'use server' module is a callable RPC endpoint, so it must either enforce an
// auth/authorization guard directly, or be explicitly listed here as public or
// as a facade that delegates to another guarded action. A NEW unguarded export
// fails this test until it is fixed or (with justification) allowlisted.
//
// The detection rules live in ./server-action-guard-scan.ts and are themselves
// tested in ./server-action-guard-detector.test.ts (o3d-hic9). This file owns
// only the policy: the allowlist, the inventory, and the tree they are applied to.
//
// o3d-512h round 3: every rule below is handed a resolving MODULE GRAPH
// (./module-graph.ts). "Delegates to a guarded action" is now something the rule
// checked rather than something the allowlist asserted, which is why six entries
// could be deleted outright this round rather than reworded again.

const ROOT = process.cwd()
const SCAN_ROOTS = ['app', 'lib', 'components']
const ACTIONS_DIR = path.join(ROOT, 'app', 'actions')
const ACTIONS_KEY_PREFIX = 'app/actions'

const graph = createRepoGraph(ROOT, SCAN_ROOTS)

// Identifiers that establish an auth/authorization boundary.
const GUARD_IDENTIFIERS = new Set([
  'requireAuth', 'requireRole', 'requireAdmin', 'requireFreshAuth', 'requireFreshAdmin',
  'requirePermission', 'requireFreshPermission', 'requireApiAuth', 'requireApiAdmin',
  'requireApiFreshAdmin', 'requireSupplier', 'assertSupplierOwnsResource',
  'requireMintsoftReadAccess', 'requireMintsoftWriteAccess', 'requireFreshMintsoftWriteAccess',
  'requireMintsoftReturnsWriteAccess', 'requireSyncPermission', 'requireFreshShoppingAdmin',
  'getVerifiedSession', 'consumeDestructiveActionCode', 'validateImportFile',
])

// Exports intentionally without a direct guard. Each entry needs a reason.
const ALLOWLIST: Record<string, string> = {
  // Pre-auth by design (account recovery / login ceremonies).
  'password-reset.ts:*': 'password reset is pre-auth; rate-limited + anti-enumeration',
  'passkey.ts:getPasskeyAuthenticationOptions': 'pre-auth passkey login ceremony',
  'passkey.ts:verifyPasskeyAuthentication': 'pre-auth passkey login ceremony (one-time token bound)',
  // Public, static content.
  'help.ts:*': 'static product help content; slug is allowlisted/sanitized',
  // Public, static (non-sensitive) connector catalogue.
  'company.ts:getShoppingConnectors': 'returns static connector id/label/available metadata only',

  // o3d-512h round 3 — SIX ENTRIES DELETED, none of them by rewording.
  //
  //   * 'auth.ts:*' matched nothing: app/actions/auth.ts does not exist and has
  //     not for some time. A stale entry is a standing invitation to create a file
  //     with that name and inherit a blanket exemption nobody reviewed — so the
  //     "no dead entries" test below now fails the build on one.
  //   * 'shopping-sync.ts:getShoppingSyncLogsForConnector' claimed "dispatcher →
  //     guarded shopify/wc sync-log actions; no unguarded arm". True, as it
  //     happens — and now VERIFIED, by resolution, so the claim does not need to
  //     be taken on trust or re-checked by hand each round.
  //   * 'quickbooks-daily-batch.ts:*' said "verified: both getters gate on
  //     requirePermission(sync) and refresh delegates to one". Also true, also now
  //     machine-checked, so the exemption suppresses nothing and is gone. That the
  //     rule below FOUND it is the point: three of these six were only visible
  //     once something checked whether each entry was still about live code.
  //   * 'wms-sync.ts:*', 'wms-asn.ts:*' and 'wms-onboarding.ts:*' each carried a
  //     reason that admitted, in as many words, that the no-connector arm returns
  //     UNGUARDED. That is the accounting-sync defect in Mintsoft's dispatchers,
  //     and an allowlist entry describing a hole is not a reason, it is a bug
  //     report filed against yourself. All six endpoints now carry their own
  //     delegate's gate — 'sync' for the three reads, 'purchasing.receive' and
  //     'stock_control.transfer' for the two ASN creates, which do NOT share a
  //     permission and would have been wrong to gate alike.
  //
  // Nothing about accounting-sync.ts or accounting-batch.ts belongs here again
  // either: every dispatcher carries its delegate's gate (see the note at the top
  // of app/actions/accounting-sync.ts).

  // o3d-512h — REASON NARROWED. An allowlist reason is a claim about code, and
  // this one claimed more than the code does. What is actually true is stated
  // here; what is NOT verified is stated as not verified, because "connector
  // facade → guarded X actions" reads as a coverage guarantee and was being taken
  // as one.
  //
  // quickbooks-sync.ts is not a facade at all: six of its exports
  // (getQuickBooksSettingsMasked, getQuickBooksConnectionStatus,
  // getQuickBooksAccounts, fetchQuickBooksTaxCodes, getQuickBooksSyncLogs,
  // getQuickBooksSyncReadiness) carry NO guard and read Prisma or the QuickBooks
  // API directly. They are separately addressable endpoints. QuickBooks is out of
  // scope for this branch by owner instruction, so they are left as they are —
  // but this entry no longer asserts they are guarded.
  'quickbooks-sync.ts:*':
    'OUT OF SCOPE (QuickBooks, owner instruction) — NOT verified as guarded: six exports carry no guard; reachable via accounting-sync.ts only behind its dispatcher gate',
}

test('every exported server action enforces an auth guard or is allowlisted', () => {
  const violations = scanActionsDir(ACTIONS_DIR, ALLOWLIST, scanSource, graph, ACTIONS_KEY_PREFIX)

  assert.deepEqual(
    violations,
    [],
    `Unguarded exported server action(s) found — add a guard or allowlist with a reason:\n${violations.join('\n')}`,
  )
})

/**
 * o3d-512h round 3 — an allowlist entry is a claim about code that exists.
 *
 * 'auth.ts:*' sat in the list above naming a file that had been gone for
 * releases. Nothing failed, because a suppression that suppresses nothing is
 * invisible — and the day someone adds app/actions/auth.ts, every export in it is
 * exempt on a reason written for different code. The same goes for a per-export
 * entry whose export was renamed.
 *
 * So the allowlist is checked against the tree: every entry must currently
 * suppress something. This is the same rule the branch applies to prose — a
 * justification that cannot be shown to be about live code does not get to stand.
 */
test('every allowlist entry actually suppresses a live violation — no dead exemptions', () => {
  const unsuppressed = new Set(scanActionsDir(ACTIONS_DIR, {}, scanSource, graph, ACTIONS_KEY_PREFIX))
  const dead: string[] = []

  for (const entry of Object.keys(ALLOWLIST)) {
    const [file, name] = splitEntry(entry)
    const covers = name === '*'
      ? [...unsuppressed].some((v) => v.startsWith(`${file}:`))
      : unsuppressed.has(entry)
    if (!covers) dead.push(entry)
  }

  assert.deepEqual(
    dead,
    [],
    'Allowlist entries that suppress nothing. Either the export gained a real guard '
    + '(delete the entry — that is the good direction), or the file/export was renamed '
    + 'or removed and the exemption is now a trap set for whoever recreates the name:\n'
    + dead.join('\n'),
  )
})

test('every allowlist entry states a reason', () => {
  for (const [entry, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `${entry} needs a stated reason`)
  }
})

/**
 * o3d-hic9: the directive, not the directory, is what creates the endpoint.
 * Scanning only app/actions/ left every `'use server'` module elsewhere
 * unexamined — which is how lib/connectors/woocommerce/products.ts came to
 * export an unauthenticated WooCommerce SKU probe.
 */
const OUTSIDE_ACTIONS_ALLOWLIST: Record<string, string> = {}

test('every `use server` export OUTSIDE app/actions enforces an auth guard or is allowlisted', () => {
  const violations = scanUseServerOutsideActions(
    ROOT,
    SCAN_ROOTS,
    OUTSIDE_ACTIONS_ALLOWLIST,
    scanSource,
    graph,
  )

  assert.deepEqual(
    violations,
    [],
    `Unguarded exported server action(s) found outside app/actions:\n${violations.join('\n')}`,
  )
})

/**
 * o3d-512h: authentication is not an answer to an authorization question.
 *
 * The two rules above ask only "is there a guard at all", and that is precisely
 * how the first sweep of this branch walked past
 * app/actions/company.ts:getEmailSettings — it held `requireAuth`, so it was
 * never a violation, while handing the decrypted SMTP configuration to every
 * signed-in role including SUPPLIER. The generic `getSetting` sibling was found
 * and fixed because it had NO guard; the one that had the wrong guard did not
 * register.
 *
 * This third rule is what makes a repeat cost a red build rather than another
 * review round: an endpoint that reaches the settings-store readers (which
 * decrypt SENSITIVE_SETTING_KEYS) must hold an authorization guard, not just an
 * authentication one.
 *
 * The allowlists are empty and should stay that way — an endpoint reading a
 * credential under authentication only is the defect, not a shape to excuse.
 */
const SECRET_READ_ALLOWLIST: Record<string, string> = {}

test('every server action reading a stored secret holds an authorization guard, not just requireAuth', () => {
  const violations = scanActionsDir(
    ACTIONS_DIR,
    SECRET_READ_ALLOWLIST,
    scanSecretReadingActions,
    graph,
    ACTIONS_KEY_PREFIX,
  )

  assert.deepEqual(
    violations,
    [],
    `Server action(s) reading stored settings behind authentication only — these decrypt SENSITIVE_SETTING_KEYS, so they need requirePermission/requireRole:\n${violations.join('\n')}`,
  )
})

test('the same secret-read rule applies OUTSIDE app/actions', () => {
  const violations = scanUseServerOutsideActions(
    ROOT,
    SCAN_ROOTS,
    SECRET_READ_ALLOWLIST,
    scanSecretReadingActions,
    graph,
  )

  assert.deepEqual(
    violations,
    [],
    `Secret-reading 'use server' export(s) behind authentication only, outside app/actions:\n${violations.join('\n')}`,
  )
})

/**
 * o3d-512h — the AUTHENTICATION-ONLY inventory.
 *
 * ROUND 3 CHANGED WHAT THIS MEANS. It used to be a 78-line list of business
 * reads, defended as "requireAuth is the right answer for most of these". It was
 * not: `requireAuth` answers "is someone signed in", and SUPPLIER — an external
 * company we issue a login to — is signed in. Every entry on that list was a
 * supplier-reachable endpoint, and purchase-orders.ts:getPurchaseOrder was
 * handing a supplier any other supplier's order by id.
 *
 * Those 70-odd endpoints now hold `requireInternalUser`, which is an
 * authorization gate, so they are simply not on this list any more. What is left
 * is the set for which authentication genuinely IS the whole answer: endpoints
 * that are SELF-SCOPED by session.user.id — your own profile, your own passkeys.
 * A supplier reaching those reaches only its own row, which is the property that
 * makes the gate sufficient.
 *
 * Adding an entry therefore means asserting that new claim, in the diff:
 * this endpoint is self-scoped to the caller, and an external principal reading
 * it reads nothing but its own.
 */
const AUTHENTICATION_ONLY_ACTIONS: string[] = [
  'passkey.ts:deletePasskey',
  'passkey.ts:getPasskeyRegistrationOptions',
  'passkey.ts:listPasskeys',
  'passkey.ts:renamePasskey',
  'passkey.ts:verifyPasskeyRegistration',
  'profile.ts:changePassword',
  'profile.ts:getProfileData',
  'profile.ts:updatePictureUrl',
  'profile.ts:updateProfile',
]

/**
 * o3d-512h round 3, Codex finding 3 — WHAT each of those endpoints reaches.
 *
 * The inventory pinned WHICH endpoints are authentication-only and said nothing
 * about what they return, so an endpoint could start serving privileged rows
 * without ever leaving the list — which is the exact question the inventory
 * exists to force. Worse, it could not have caught the class it was written for:
 * settings.ts:getAccountCodes and purchase-orders.ts:getBillPaymentAccounts
 * reached the stored chart of accounts through a helper two modules away, and
 * nothing in their own source looked like an accounting read.
 *
 * The module graph resolves through those helpers, so the pin can be about the
 * DATA SURFACE: the Prisma models each endpoint reaches, transitively, through
 * every callee that resolves. A self-scoped profile read that starts touching
 * `supplier`, `purchaseOrder` or `setting` turns the build red on the line that
 * names the model, whatever its gate still says.
 *
 * `activityLog` appears on the mutations because logActivity writes one; that is
 * a write of the caller's own action, not a read of anyone's data.
 *
 * WHAT THIS PIN DOES NOT DO — Codex round 4, finding 4.
 *
 * Round 3 presented this as covering the supplier-isolation class. It does not.
 * It pins WHICH models an endpoint reaches; the inventory's whole justification
 * is that each endpoint is SCOPED TO THE CALLER, and scope is not a property of
 * the model list. `db.user.findUnique` looks identical whether the filter is the
 * session's own id or an id from the request, so the escalation the inventory
 * exists to prevent — an endpoint every signed-in principal may call starting to
 * return somebody else's row — can happen without this pin moving a character.
 * Anything pinned here in the name of self-scoping would be a proxy for the
 * property, and a proxy accepted as the property is the defect this whole branch
 * has been unwinding.
 *
 * So it is not pinned here. It is EXECUTED, in
 * tests/security/authentication-only-self-scoping.test.ts: every endpoint on the
 * list below is called as an external SUPPLIER principal, with foreign ids where
 * it takes one, and every query it issues is inspected for the caller's own id.
 * That file also asserts its coverage is exactly this inventory, so a new
 * authentication-only endpoint cannot arrive with the self-scoping claim merely
 * assumed. The two pins answer different questions and neither substitutes for
 * the other: this one is static reach, that one is observed scope.
 */
const AUTHENTICATION_ONLY_PRISMA_SURFACE: Record<string, string[]> = {
  'passkey.ts:deletePasskey': ['$transaction', 'activityLog', 'passkey', 'user'],
  'passkey.ts:getPasskeyRegistrationOptions': ['oneTimeToken', 'setting', 'user'],
  'passkey.ts:listPasskeys': ['passkey'],
  'passkey.ts:renamePasskey': ['activityLog', 'passkey'],
  'passkey.ts:verifyPasskeyRegistration': ['$transaction', 'activityLog', 'oneTimeToken', 'passkey', 'setting', 'user'],
  'profile.ts:changePassword': ['activityLog', 'user'],
  'profile.ts:getProfileData': ['user'],
  'profile.ts:updatePictureUrl': ['activityLog', 'user'],
  'profile.ts:updateProfile': ['activityLog', 'user'],
}

const AUTHENTICATION_ONLY_OUTSIDE_ACTIONS: string[] = []

test('the set of server actions gated on AUTHENTICATION ONLY is exactly the pinned inventory', () => {
  const found = scanActionsDir(
    ACTIONS_DIR,
    {},
    scanAuthenticationOnlyActions,
    graph,
    ACTIONS_KEY_PREFIX,
  ).sort()

  assert.deepEqual(
    found,
    [...AUTHENTICATION_ONLY_ACTIONS].sort(),
    'An endpoint moved into or out of authentication-only gating. If you ADDED one, say in the '
    + 'diff why an EXTERNAL principal — a SUPPLIER session — may call it, which for an '
    + 'authentication-only endpoint means showing it is scoped to that caller\'s own row. '
    + 'If you REMOVED one by giving it a real authorization gate, just delete the line.',
  )
})

test('the pinned inventory also pins WHAT each endpoint reaches, not only its gate', () => {
  const surface = prismaSurfaceOf(
    AUTHENTICATION_ONLY_ACTIONS.map((entry) => {
      const [file, name] = splitEntry(entry)
      return { key: entry, file: `${ACTIONS_KEY_PREFIX}/${file}`, name }
    }),
    graph,
  )

  assert.deepEqual(
    surface,
    AUTHENTICATION_ONLY_PRISMA_SURFACE,
    'The DATA SURFACE of an authentication-only endpoint changed. The gate did not have to '
    + 'move for this to be a privilege escalation: an endpoint every signed-in principal may '
    + 'call, including SUPPLIER, now reaches a different set of tables. Justify the new model '
    + 'in the diff — or give the endpoint an authorization gate, which removes it from the '
    + 'inventory and from this pin.',
  )
})

test('the authentication-only inventory covers `use server` modules OUTSIDE app/actions too', () => {
  const found = scanUseServerOutsideActions(
    ROOT,
    SCAN_ROOTS,
    {},
    scanAuthenticationOnlyActions,
    graph,
  ).sort()

  assert.deepEqual(
    found,
    [...AUTHENTICATION_ONLY_OUTSIDE_ACTIONS].sort(),
    'An endpoint outside app/actions moved into or out of authentication-only gating.',
  )
})

test('the pinned inventory names no endpoint this branch gave an authorization gate', () => {
  // The ones this branch moved off requireAuth, across all three rounds. If any
  // reappears above, a later edit put it back on authentication only — which is
  // the regression, not a stale list to refresh.
  const regated = [
    'company.ts:getEmailSettings',
    'settings.ts:getAccountCodes',
    'settings.ts:getSetting',
    'settings.ts:getUsers',
    'purchase-orders.ts:getBillPaymentAccounts',
    'purchase-orders.ts:getPurchaseOrder',
    'purchase-orders.ts:getPurchaseOrders',
    'purchase-orders.ts:getSupplierLastPrices',
    'purchase-orders.ts:getGoodsPosForLinking',
    'purchase-orders.ts:getLinkedFreightPos',
    'allocation.ts:getOrderAllocations',
    'allocation.ts:getOrderShipments',
    'allocation.ts:getOrderFulfillmentRequirements',
  ]
  for (const name of regated) {
    assert.ok(
      !AUTHENTICATION_ONLY_ACTIONS.includes(name),
      `${name} was gated on a permission by o3d-512h; it must not be back on requireAuth`,
    )
  }
})

function splitEntry(entry: string): [string, string] {
  const sep = entry.lastIndexOf(':')
  return [entry.slice(0, sep), entry.slice(sep + 1)]
}

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  AccountingTenantNotAllowedError,
  assertTenantAllowed,
  checkTenantAllowed,
  readTenantAllowlist,
} from '@/lib/connectors/accounting-tenant-guard'

/**
 * o3d-iaqy, root cause of o3d-t74p: the e2e instance posted 553 objects — including 14
 * payments — into the LIVE Xero organisation over eleven days. There was no technical barrier:
 * the OAuth flow accepts whichever organisation the operator picks and stores it, and nothing
 * compared that against what the instance is permitted to use.
 */

const LIVE = 'live-tenant-uuid'
const DEMO = '5c949ed5-9ac0-4f43-b716-b38ee59fe7cf'

test('unset is permissive — a guard that ships refusing would stop live invoicing (o3d-iaqy)', () => {
  assert.equal(readTenantAllowlist('xero', {}), null)
  assert.deepEqual(checkTenantAllowed({ connector: 'xero', tenantId: LIVE, env: {} }), { allowed: true })
})

test('an allowlist admits only what it names (o3d-iaqy)', () => {
  const env = { ACCOUNTING_ALLOWED_TENANT_IDS: DEMO }
  assert.deepEqual(checkTenantAllowed({ connector: 'xero', tenantId: DEMO, env }), { allowed: true })

  const refused = checkTenantAllowed({ connector: 'xero', tenantId: LIVE, env })
  assert.equal(refused.allowed, false)
  assert.ok(refused.allowed === false)
  assert.match(refused.reason, /Refusing to use xero organisation live-tenant-uuid/)
  assert.match(refused.reason, /change the allowlist/, 'must say how to proceed deliberately')
})

test('set but EMPTY is the explicit fail-closed setting (o3d-iaqy)', () => {
  // For an instance that must never reach a real organisation at all.
  const env = { ACCOUNTING_ALLOWED_TENANT_IDS: '' }
  assert.deepEqual(readTenantAllowlist('xero', env), [])
  for (const tenantId of [LIVE, DEMO, '', null, undefined]) {
    const decision = checkTenantAllowed({ connector: 'xero', tenantId, env })
    assert.equal(decision.allowed, false, `${tenantId} must be refused`)
    assert.ok(decision.allowed === false)
    assert.match(decision.reason, /NO accounting organisation/)
  }
})

test('a connector-specific value wins, even when empty (o3d-iaqy)', () => {
  // So one connector can be locked down without locking down the other. An `||` fallback would
  // have made an empty override silently inherit the shared list — the opposite of the intent.
  const env = { ACCOUNTING_ALLOWED_TENANT_IDS: LIVE, XERO_ALLOWED_TENANT_IDS: '' }
  assert.deepEqual(readTenantAllowlist('xero', env), [], 'the empty override must apply')
  assert.equal(checkTenantAllowed({ connector: 'xero', tenantId: LIVE, env }).allowed, false)
  // QuickBooks has no override here, so it falls back to the shared list.
  assert.equal(checkTenantAllowed({ connector: 'quickbooks', tenantId: LIVE, env }).allowed, true)
})

test('lists are parsed forgivingly (o3d-iaqy)', () => {
  const env = { ACCOUNTING_ALLOWED_TENANT_IDS: `  ${DEMO} , , ${LIVE}  ` }
  assert.deepEqual(readTenantAllowlist('xero', env), [DEMO, LIVE])
  assert.equal(checkTenantAllowed({ connector: 'xero', tenantId: ` ${LIVE} `, env }).allowed, true)
})

test('assertTenantAllowed throws a named error (o3d-iaqy)', () => {
  const env = { ACCOUNTING_ALLOWED_TENANT_IDS: DEMO }
  assert.doesNotThrow(() => assertTenantAllowed({ connector: 'xero', tenantId: DEMO, env }))
  assert.throws(
    () => assertTenantAllowed({ connector: 'xero', tenantId: LIVE, env }),
    AccountingTenantNotAllowedError,
  )
})

test('the guard sits at the ONE place each connector stamps its tenant (o3d-iaqy)', async () => {
  // Guarding the sync processors instead would leave the pollers, the repair sweep and every
  // reference-data read unguarded — and a caller nobody remembered to update could bypass it.
  const xeroApi = await readFile(path.join(process.cwd(), 'lib/connectors/xero/api.ts'), 'utf8')
  const at = xeroApi.indexOf('async function xeroFetchWithAuth')
  assert.notEqual(at, -1)
  const body = xeroApi.slice(at, at + 1400)
  const guardAt = body.indexOf("assertTenantAllowed({ connector: 'xero'")
  const headerAt = body.indexOf("'Xero-Tenant-Id': auth.tenantId")
  assert.ok(guardAt !== -1 && headerAt !== -1, 'guard and tenant header must both be present')
  assert.ok(guardAt < headerAt, 'the guard must run BEFORE the request is built')

  const qboApi = await readFile(path.join(process.cwd(), 'lib/connectors/quickbooks/api.ts'), 'utf8')
  const buildAt = qboApi.indexOf('function buildUrl(')
  assert.notEqual(buildAt, -1)
  const buildBody = qboApi.slice(buildAt, qboApi.indexOf('\n}', buildAt))
  assert.match(buildBody, /assertTenantAllowed\(\{ connector: 'quickbooks', tenantId: realmId \}\)/)
})

test('a disallowed token is never PERSISTED, on connect or refresh (o3d-iaqy)', async () => {
  // The call-boundary guard alone would let an operator bind the wrong organisation and walk
  // away believing it worked.
  for (const [file, connector] of [
    ['lib/connectors/xero/auth.ts', 'xero'],
    ['lib/connectors/quickbooks/auth.ts', 'quickbooks'],
  ] as const) {
    const source = await readFile(path.join(process.cwd(), file), 'utf8')
    const at = source.indexOf('async function upsertStoredToken(')
    assert.notEqual(at, -1, `${file} must still have one persist point`)
    const body = source.slice(at, at + 1200)
    const guardAt = body.indexOf(`assertTenantAllowed({ connector: '${connector}'`)
    const dataAt = body.indexOf('const data = {')
    assert.ok(guardAt !== -1, `${file} must guard before persisting`)
    assert.ok(guardAt < dataAt, 'the guard must precede building the row')

    // One persist point means refresh is covered too — pin that it stays that way.
    assert.equal(
      (source.match(/async function upsertStoredToken\(/g) ?? []).length,
      1,
      'a second persist path would bypass the guard',
    )
  }
})

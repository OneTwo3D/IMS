import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { hasPermission, type Permission, type Role } from '@/lib/permissions'

/**
 * o3d-ngmt.21 — WHO MAY DELETE A SYNCED INVOICE OR BILL. The two actions use the permission that edits the document today
 * (`sales.process`, `purchasing.invoice`), and a principal without it is refused before the service is reached.
 */

let role: Role = 'ADMIN'
const requested: Array<{ kind: string; documentId: string; requestedById: string | null }> = []

class Denied extends Error {}

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: Permission) => {
      if (!hasPermission(role, permission)) throw new Denied(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'u-1', role } }
    },
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/accounting', { namedExports: { getActiveAccountingConnectorId: async () => 'xero' } })
mock.module('@/lib/connectors/xero/invoice-number-claim', { namedExports: { lookupXeroInvoiceNumberClaim: async () => ({ ok: false, error: 'not asked in this test' }) } })
mock.module('@/lib/domain/accounting/document-delete-service', {
  namedExports: {
    requestAccountingDocumentDelete: async (params: { kind: string; documentId: string; requestedById: string | null }) => {
      requested.push(params)
      return { ok: true, deletionId: 'd-1', releasedNumber: 'INV-1-DEL-AAAAAA' }
    },
  },
})

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY']

test('a sales invoice delete needs sales.process: every role that lacks it is refused and the service is never reached', async () => {
  const { deleteSyncedSalesInvoice } = await import('@/app/actions/accounting-document-delete')
  let denied = 0
  let allowed = 0
  for (const r of ROLES) {
    role = r
    requested.length = 0
    if (hasPermission(r, 'sales.process')) {
      const result = await deleteSyncedSalesInvoice('so-1')
      assert.equal(result.success, true, r)
      assert.match(String(result.notice), /INV-1-DEL-AAAAAA/)
      assert.deepEqual(requested, [{ kind: 'SALES_INVOICE', documentId: 'so-1', requestedById: 'u-1' }])
      allowed += 1
    } else {
      await assert.rejects(() => deleteSyncedSalesInvoice('so-1'), /missing permission sales\.process/, r)
      assert.equal(requested.length, 0, `${r}: the service was never reached`)
      denied += 1
    }
  }
  assert.ok(allowed >= 1 && denied >= 1, 'the table exercises both sides')
})

test('a bill delete needs purchasing.invoice: every role that lacks it is refused and the service is never reached', async () => {
  const { deleteSyncedPurchaseBill } = await import('@/app/actions/accounting-document-delete')
  let denied = 0
  let allowed = 0
  for (const r of ROLES) {
    role = r
    requested.length = 0
    if (hasPermission(r, 'purchasing.invoice')) {
      assert.equal((await deleteSyncedPurchaseBill('bill-1')).success, true, r)
      assert.deepEqual(requested, [{ kind: 'PURCHASE_BILL', documentId: 'bill-1', requestedById: 'u-1' }])
      allowed += 1
    } else {
      await assert.rejects(() => deleteSyncedPurchaseBill('bill-1'), /missing permission purchasing\.invoice/, r)
      assert.equal(requested.length, 0, `${r}: the service was never reached`)
      denied += 1
    }
  }
  assert.ok(allowed >= 1 && denied >= 1, 'the table exercises both sides')
})

test('an empty document id is refused without reaching the service', async () => {
  role = 'ADMIN'
  requested.length = 0
  const { deleteSyncedSalesInvoice, deleteSyncedPurchaseBill } = await import('@/app/actions/accounting-document-delete')
  assert.equal((await deleteSyncedSalesInvoice('  ')).success, false)
  assert.equal((await deleteSyncedPurchaseBill('')).success, false)
  assert.equal(requested.length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { NextResponse } from 'next/server'
import { handlePurchaseOrderPdfGet } from '../../app/api/purchase-order/[id]/route.ts'
import { hasPermission } from '../../lib/permissions.ts'
import { apiRouteAuthPolicy } from '../../lib/security/route-auth-policy.ts'

const session = (role: string) => ({
  user: { id: `${role}-u`, email: `${role}@example.com`, name: role, role, supplierId: role === 'SUPPLIER' ? 'sup-1' : null, totpEnabled: false, totpVerified: true },
})

function deps(role: string | 'anon', pdf: { buffer: Buffer; reference: string } | null = { buffer: Buffer.from('%PDF-fake'), reference: 'PO-1' }) {
  const built: string[] = []
  return {
    built,
    overrides: {
      authorize: async () => (role === 'anon' ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : (session(role) as never)),
      hasPermission,
      buildPdf: async (id: string) => { built.push(id); return pdf },
    },
  }
}

test('the route is registered as authenticated', () => {
  assert.equal((apiRouteAuthPolicy as Record<string, { access: string }>)['/api/purchase-order/[id]']?.access, 'authenticated')
})

test('anonymous callers get 401 and nothing is built', async () => {
  const d = deps('anon')
  const res = await handlePurchaseOrderPdfGet({ id: 'po-1' }, d.overrides)
  assert.equal(res.status, 401)
  assert.deepEqual(d.built, [])
})

test('supplier-portal users are refused: the PO carries our costs', async () => {
  const d = deps('SUPPLIER')
  const res = await handlePurchaseOrderPdfGet({ id: 'po-1' }, d.overrides)
  assert.equal(res.status, 403)
  assert.deepEqual(d.built, [])
})

test('a role without purchasing permission is refused', async () => {
  const roles = ['ADMIN', 'MANAGER', 'WAREHOUSE', 'SALES', 'VIEWER', 'ACCOUNTANT']
  const without = roles.filter((r) => !hasPermission(r as never, 'purchasing'))
  for (const role of without) {
    const d = deps(role)
    assert.equal((await handlePurchaseOrderPdfGet({ id: 'po-1' }, d.overrides)).status, 403, role)
    assert.deepEqual(d.built, [])
  }
})

test('a purchasing role gets the PDF; a missing order is 404', async () => {
  const roles = ['ADMIN', 'MANAGER', 'WAREHOUSE', 'SALES', 'VIEWER', 'ACCOUNTANT'].filter((r) => hasPermission(r as never, 'purchasing'))
  assert.ok(roles.length > 0)
  const d = deps(roles[0])
  const ok = await handlePurchaseOrderPdfGet({ id: 'po-1' }, d.overrides)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'application/pdf')
  assert.match(ok.headers.get('content-disposition') ?? '', /PO-PO-1\.pdf/)
  assert.deepEqual(d.built, ['po-1'])
  const missing = await handlePurchaseOrderPdfGet({ id: 'nope' }, deps(roles[0], null).overrides)
  assert.equal(missing.status, 404)
})

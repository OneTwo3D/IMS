import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The customers list rendered only its Name column: the lazy useState initialiser
// returned the defaultVisibility FUNCTION instead of calling it, so every
// visible[key] except `name` (Function.prototype.name) was undefined.

mock.module('next/navigation', {
  namedExports: { useRouter: () => ({ push() {}, replace() {}, refresh() {} }) },
})
mock.module('next/link', {
  defaultExport: ({ children, href }: { children?: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
})
mock.module('@/app/actions/customers', {
  namedExports: {
    createCustomer: async () => ({}),
    updateCustomer: async () => ({}),
    importContactsCsv: async () => ({}),
    anonymiseCustomer: async () => ({}),
  },
})
mock.module('@/components/providers/base-currency-provider', {
  namedExports: { useBaseCurrency: () => ({ code: 'GBP', symbol: '£', symbolPosition: 'before' }) },
})
mock.module('@/components/providers/timezone-provider', {
  namedExports: { useFormatDateTime: () => (iso: string) => iso },
})

const CUSTOMER = {
  id: 'c1', firstName: 'Test', lastName: 'Customer', fullName: 'Test Customer', email: 'test@example.test',
  phone: null, company: 'Example Co', taxNumber: null, billingAddress: null, shippingAddress: null,
  notes: null, active: true, orderCount: 3, lifetimeValueBase: 100, currentYearSalesBase: 50, lifetimeValueUpperBound: false,
  lastOrderAt: null, createdAt: '2026-01-01T00:00:00.000Z', gdprAnonymisedAt: null,
}

test('the customers list renders its default columns, not just Name', async () => {
  const { ContactsClient } = await import('@/app/(dashboard)/sales/contacts/contacts-client')
  const html = renderToStaticMarkup(
    React.createElement(ContactsClient, { initialCustomers: [CUSTOMER] }),
  )
  for (const header of ['Company', 'Email', 'Orders', 'Lifetime Value']) {
    assert.ok(html.includes(`>${header}<`) || html.includes(header), `default column "${header}" must render`)
  }
  assert.ok(html.includes('Example Co'), 'the company cell renders')
})

test('resolveColumnVisibility overlays a partial stored preference on the defaults', async () => {
  const { resolveColumnVisibility } = await import('@/app/(dashboard)/sales/contacts/column-visibility')
  const defaults = { name: true, email: true, phone: false }
  assert.deepEqual(resolveColumnVisibility(defaults, null), defaults)
  assert.deepEqual(resolveColumnVisibility(defaults, '{"phone":true}'), { name: true, email: true, phone: true })
  assert.deepEqual(resolveColumnVisibility(defaults, 'not json'), defaults)
  assert.deepEqual(resolveColumnVisibility(defaults, '[1]'), defaults)
  assert.deepEqual(resolveColumnVisibility(defaults, '{"email":"yes","zzz":true}'), defaults)
})

test('the customers list overlays a saved column preference on the defaults', async () => {
  const { ContactsClient } = await import('@/app/(dashboard)/sales/contacts/contacts-client')
  const g = globalThis as Record<string, unknown>
  g.window = {}
  g.localStorage = { getItem: () => JSON.stringify({ phone: true, company: false }), setItem() {} }
  try {
    const html = renderToStaticMarkup(
      React.createElement(ContactsClient, { initialCustomers: [CUSTOMER] }),
    )
    assert.ok(html.includes('Phone'), 'the saved choice to show Phone is honoured')
    assert.ok(!html.includes('Example Co'), 'the saved choice to hide Company is honoured')
    assert.ok(html.includes('Lifetime Value'), 'columns the preference does not mention keep their defaults')
  } finally {
    delete g.window
    delete g.localStorage
  }
})

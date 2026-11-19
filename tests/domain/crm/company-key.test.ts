import assert from 'node:assert/strict'
import test from 'node:test'

import { companyEmailDomain, companyKeys, companyNameKey, sameCompany } from '@/lib/domain/crm/company-key'

test('the company name key ignores case, full stops, commas and spacing, and keeps the legal suffix', () => {
  assert.equal(companyNameKey('  Acme  Widgets, Ltd. '), 'acme widgets ltd')
  assert.equal(companyNameKey('ACME WIDGETS LTD'), 'acme widgets ltd')
  assert.notEqual(companyNameKey('Acme Ltd'), companyNameKey('Acme Limited'))
  assert.equal(companyNameKey('   '), null)
  assert.equal(companyNameKey(null), null)
})

test('a company domain is a key, a free-mail domain is not', () => {
  assert.equal(companyEmailDomain('Buyer@Acme-Widgets.co.uk'), 'acme-widgets.co.uk')
  assert.equal(companyEmailDomain('someone@gmail.com'), null)
  assert.equal(companyEmailDomain('someone@outlook.com'), null)
  assert.equal(companyEmailDomain('deleted@site.invalid'), null) // a placeholder is not an email
  assert.equal(companyEmailDomain(null), null)
})

test('two customers are one company by name OR by domain, never by a free-mail domain', () => {
  const a = companyKeys({ company: 'Acme Widgets', email: 'a@gmail.com' })
  const b = companyKeys({ company: 'acme widgets', email: 'b@yahoo.com' })
  assert.ok(sameCompany(a, b), 'same name key')
  const c = companyKeys({ company: null, email: 'c@acme.com' })
  const d = companyKeys({ company: 'Other', email: 'd@acme.com' })
  assert.ok(sameCompany(c, d), 'same company domain')
  const e = companyKeys({ company: null, email: 'e@gmail.com' })
  const f = companyKeys({ company: null, email: 'f@gmail.com' })
  assert.ok(!sameCompany(e, f), 'gmail.com says nothing about an employer')
  assert.ok(!sameCompany(companyKeys({ company: null, email: null }), companyKeys({ company: null, email: null })))
})

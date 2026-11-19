import assert from 'node:assert/strict'
import test from 'node:test'

import { companyEmailDomain, companyKeys, companyNameKey, sameCompany } from '@/lib/domain/crm/company-key'

test('the company name key ignores case, full stops, commas and spacing', () => {
  assert.equal(companyNameKey('  Acme  Widgets, Ltd. '), 'acme widgets')
  assert.equal(companyNameKey('ACME WIDGETS'), 'acme widgets')
  assert.equal(companyNameKey('   '), null)
  assert.equal(companyNameKey(null), null)
})

test('legal suffixes fold away when comparing and normalising (owner decision 2026-11-19)', () => {
  const one = companyNameKey('Acme Ltd')
  for (const variant of ['Acme Limited', 'ACME LTD.', 'Acme, Inc.', 'Acme Incorporated', 'Acme plc', 'Acme PLC', 'Acme L.L.C.', 'Acme LLC', 'Acme GmbH', 'Acme Co', 'Acme Co.', 'Acme Company', 'Acme Company Limited', 'Acme & Co Ltd', 'Acme and Co', 'Acme']) {
    assert.equal(companyNameKey(variant), one, variant)
  }
  assert.equal(one, 'acme')
  assert.ok(sameCompany(companyKeys({ company: 'Acme Limited', email: null }), companyKeys({ company: 'Acme Ltd', email: null })))
  // only TRAILING words fold, the first word is never removed, and different companies stay apart
  assert.equal(companyNameKey('Co Ltd'), 'co')
  assert.equal(companyNameKey('Company'), 'company')
  assert.equal(companyNameKey('Limited Edition Widgets'), 'limited edition widgets')
  assert.equal(companyNameKey('Black and Decker'), 'black and decker')
  assert.notEqual(companyNameKey('Acme Widgets Ltd'), companyNameKey('Acme Gadgets Ltd'))
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

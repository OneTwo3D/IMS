import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blockingScopeFor, missingScopes, parseGrantedScopes, requiredScopeForSyncType,
  scopeBlockedError, SCOPE_RECONSENT_PREFIX, XERO_REQUESTED_SCOPES, XERO_SCOPE_STRING,
} from '@/lib/connectors/xero/scopes'

/**
 * o3d-g2i. Adding a scope to the authorization URL only affects FUTURE consents: an existing refresh
 * token keeps the grant it was minted with. So `accounting.payments` was added in PR #530 and every
 * payment POST went on 401ing AuthorizationUnsuccessful on any connection that never reconnected —
 * invoices and bills posted and were marked paid locally, and were never settled in Xero.
 *
 * The whole design rests on one distinction: a grant we have READ and found wanting, versus a grant we
 * have never recorded. The first must block; the second must not.
 */

test('an UNRECORDED grant blocks nothing', () => {
  // The upgrade case, and the one that would take every installation down if it were got wrong: a token
  // stored before the column existed knows nothing about its own scopes. Unknown means "let Xero answer".
  assert.equal(parseGrantedScopes(null), null)
  assert.equal(parseGrantedScopes(undefined), null)
  assert.deepEqual(missingScopes(null), [])
  assert.equal(blockingScopeFor('INVOICE_PAYMENT', null), null)
})

test('a grant of NOTHING is not the same as an unrecorded one', () => {
  // An empty string is a positively-read grant. Everything is missing, and the payment sync is blocked.
  assert.deepEqual(parseGrantedScopes(''), [])
  assert.deepEqual(missingScopes([]), [...XERO_REQUESTED_SCOPES])
  assert.equal(blockingScopeFor('INVOICE_PAYMENT', []), 'accounting.payments')
})

test('the real failure: a connection granted everything EXCEPT accounting.payments', () => {
  // Exactly the state PR #530 left behind. Payments are refused with a cause; nothing else is touched.
  const granted = XERO_REQUESTED_SCOPES.filter((s) => s !== 'accounting.payments')
  assert.deepEqual(missingScopes(granted), ['accounting.payments'])
  assert.equal(blockingScopeFor('INVOICE_PAYMENT', granted), 'accounting.payments')
  assert.equal(blockingScopeFor('BILL_PAYMENT', granted), 'accounting.payments')

  assert.equal(blockingScopeFor('SALES_INVOICE', granted), null, 'invoices are unaffected')
  assert.equal(blockingScopeFor('CREDIT_NOTE', granted), null)
  assert.equal(blockingScopeFor('COGS_JOURNAL', granted), null, 'journals are unaffected')
})

test('a complete grant blocks nothing at all', () => {
  const granted = [...XERO_REQUESTED_SCOPES]
  assert.deepEqual(missingScopes(granted), [])
  for (const type of ['INVOICE_PAYMENT', 'BILL_PAYMENT', 'BILL_ATTACHMENT', 'COGS_JOURNAL', 'SALES_INVOICE']) {
    assert.equal(blockingScopeFor(type, granted), null, type)
  }
})

test('extra scopes Xero threw in are not treated as missing anything', () => {
  const granted = [...XERO_REQUESTED_SCOPES, 'accounting.reports.read', 'accounting.journals.read']
  assert.deepEqual(missingScopes(granted), [])
})

test('the scope string sent to Xero is the same list the check reads', () => {
  // The drift this guards against is silent: ask for a scope, never check it, and the 401 comes back
  // months later with no clue which scope it is about.
  assert.equal(XERO_SCOPE_STRING, XERO_REQUESTED_SCOPES.join(' '))
  assert.deepEqual(parseGrantedScopes(XERO_SCOPE_STRING), [...XERO_REQUESTED_SCOPES])
  assert.deepEqual(missingScopes(parseGrantedScopes(XERO_SCOPE_STRING)), [])
})

test('a grant string with odd whitespace still parses', () => {
  // Xero returns space-separated; be tolerant rather than deciding a connection has no scopes because
  // of a stray newline, which would block every payment sync.
  assert.deepEqual(parseGrantedScopes('  accounting.invoices\n accounting.payments  '), [
    'accounting.invoices', 'accounting.payments',
  ])
})

test('each scope-dependent sync type names the right scope, and the rest name none', () => {
  assert.equal(requiredScopeForSyncType('INVOICE_PAYMENT'), 'accounting.payments')
  assert.equal(requiredScopeForSyncType('BILL_PAYMENT'), 'accounting.payments')
  assert.equal(requiredScopeForSyncType('BILL_ATTACHMENT'), 'accounting.attachments')
  assert.equal(requiredScopeForSyncType('REALISED_FX_JOURNAL'), 'accounting.manualjournals')
  assert.equal(requiredScopeForSyncType('DAILY_BATCH_GROUP_B'), 'accounting.manualjournals')
  assert.equal(requiredScopeForSyncType('SALES_INVOICE'), null)
  assert.equal(requiredScopeForSyncType('PURCHASE_INVOICE'), null)
  assert.equal(requiredScopeForSyncType('TAX_RATE_SYNC'), null)
})

test('the blocked-row error says what to DO, and is recognisable', () => {
  // The point of the whole exercise: "401 AuthorizationUnsuccessful" could be a dozen things. This
  // names the scope, names the cause, and says nothing was sent — and carries a stable prefix so the
  // rows blocked this way can be found and retried after a reconnect.
  const msg = scopeBlockedError('INVOICE_PAYMENT', 'accounting.payments')
  assert.ok(msg.startsWith(SCOPE_RECONSENT_PREFIX))
  assert.match(msg, /accounting\.payments/)
  assert.match(msg, /INVOICE_PAYMENT/)
  assert.match(msg, /reconnect/i)
  assert.match(msg, /Nothing was sent/)
})

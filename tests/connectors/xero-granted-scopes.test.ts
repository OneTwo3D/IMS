import assert from 'node:assert/strict'
import test from 'node:test'

import {
  blockingScopeFor, missingScopes, parseGrantedScopes, requiredScopeForSyncType,
  scopeBlockedError, scopesFromTokenResponse, SCOPE_RECONSENT_PREFIX,
  XERO_REQUESTED_SCOPES, XERO_SCOPE_STRING,
} from '@/lib/connectors/xero/scopes'

/** A minimal JWT: header.payload.signature, payload base64url-encoded, as Xero's access token is. */
function jwtWith(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked`
}

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


// --- reading the grant off a token response ----------------------------------

test('the top-level scope field is used when Xero sends one', () => {
  assert.equal(
    scopesFromTokenResponse({ scope: 'accounting.invoices accounting.payments' }),
    'accounting.invoices accounting.payments',
  )
})

test('an ARRAY of scopes is normalised, not stringified into nonsense', () => {
  assert.equal(scopesFromTokenResponse({ scope: ['accounting.invoices', 'accounting.payments'] }),
    'accounting.invoices accounting.payments')
})

test('when the response omits scope, the access-token JWT claim is read instead', () => {
  // Xero's auth-code response does not GUARANTEE a top-level `scope`. Taking null from its absence
  // meant a perfectly good reconnect persisted "unknown" — and unknown fails open, so validation
  // stayed switched off on precisely the connection someone had just fixed.
  const token = jwtWith({ scope: 'accounting.settings accounting.payments', xero_userid: 'u' })
  assert.equal(scopesFromTokenResponse({ access_token: token }), 'accounting.settings accounting.payments')
})

test('a JWT carrying its scope claim as an array works too', () => {
  const token = jwtWith({ scope: ['accounting.settings', 'accounting.payments'] })
  assert.equal(scopesFromTokenResponse({ access_token: token }), 'accounting.settings accounting.payments')
})

test('an opaque or malformed token yields UNKNOWN, and never throws', () => {
  // Failing a connection Xero has just accepted, because we could not parse its token, would be a
  // self-inflicted outage. Unknown is the safe answer.
  assert.equal(scopesFromTokenResponse({ access_token: 'not-a-jwt' }), null)
  assert.equal(scopesFromTokenResponse({ access_token: 'a.!!!not-base64!!!.c' }), null)
  assert.equal(scopesFromTokenResponse({}), null)
  assert.equal(scopesFromTokenResponse(null), null)
  assert.equal(scopesFromTokenResponse({ scope: '   ' }), null)
})

// --- Xero's broad legacy scopes ----------------------------------------------

test('a legacy accounting.transactions grant is NOT reported as missing the granular scopes', () => {
  // Xero accepts accounting.transactions through September 2027 and it authorises the granular
  // transactional endpoints. Judging such a connection "missing accounting.payments" would block every
  // payment row that Xero would have accepted — a compatibility outage of our own making.
  const granted = ['openid', 'profile', 'email', 'offline_access', 'accounting.settings',
    'accounting.contacts', 'accounting.transactions', 'accounting.attachments']
  assert.deepEqual(missingScopes(granted), [], 'the broad scope covers invoices, payments and journals')
  assert.equal(blockingScopeFor('INVOICE_PAYMENT', granted), null)
  assert.equal(blockingScopeFor('BILL_PAYMENT', granted), null)
  assert.equal(blockingScopeFor('COGS_JOURNAL', granted), null)
})

test('a broad grant still cannot conjure a scope it does not entail', () => {
  // accounting.transactions says nothing about attachments — so BILL_ATTACHMENT is still blocked, and
  // the warning still names what is genuinely absent.
  const granted = ['accounting.transactions']
  assert.equal(blockingScopeFor('BILL_ATTACHMENT', granted), 'accounting.attachments')
  assert.ok(missingScopes(granted).includes('accounting.attachments'))
  assert.ok(!missingScopes(granted).includes('accounting.payments'))
})

test('a mixed broad-and-granular grant is fine', () => {
  const granted = [...XERO_REQUESTED_SCOPES, 'accounting.transactions']
  assert.deepEqual(missingScopes(granted), [])
})

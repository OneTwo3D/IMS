import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertTenantSwitchIsSafe,
  collectTenantSwitchEvidence,
  lastConnectedTenantSettingKey,
  recordConnectedTenantId,
  tenantSwitchEvidenceTotal,
  type TenantSwitchGuardClient,
} from '@/lib/domain/accounting/tenant-switch-guard'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 1 — the compound (id, provenance) index made a realm switch CORRUPTING where
// the old global index only made it BLOCKING.
//
// Under the global unique index, realm B's colliding integer id could not be written at all.
// Legitimate work was blocked, but no two rows ever existed whose ids a downstream reader could
// confuse. Under the pair, the same write succeeds and quickbooks/payment-poller.ts — which selects
// on `accountingInvoiceId != null` and never reads the provenance column — marks the retired realm's
// bill paid. Auditing ~190 consumers is a separate piece of work (o3d-5hku); this guard removes the
// ability to CREATE the state, which covers the consumers that do not exist yet and the document
// types (SalesOrder, SalesOrderRefund, SupplierCreditNote) that have no provenance column to audit.
//
// The store below INTERPRETS the where clauses rather than returning canned counts, so a guard that
// kept the calls but stopped applying a predicate fails here.
// ---------------------------------------------------------------------------

const CONNECTOR = 'quickbooks'
const REALM_A = 'quickbooks:realm-A'
const REALM_B = 'quickbooks:realm-B'

type Store = {
  settings: Map<string, string>
  bills: Array<{ accountingInvoiceId: string | null; accountingInvoiceProvenance: string }>
  syncRows: Array<{ connector: string; externalTransactionId: string | null; provenance: string | null }>
  orders: Array<{ accountingInvoiceId: string | null }>
  refunds: Array<{ accountingCreditNoteId: string | null }>
  supplierCreditNotes: Array<{ accountingCreditNoteId: string | null }>
}

function emptyStore(): Store {
  return { settings: new Map(), bills: [], syncRows: [], orders: [], refunds: [], supplierCreditNotes: [] }
}

/** Enough Prisma where semantics for these predicates, and it THROWS on anything it cannot model. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'NOT') {
      if (matches(row, condition as Record<string, unknown>)) return false
      continue
    }
    if (key === 'OR') {
      if (!(condition as Array<Record<string, unknown>>).some((clause) => matches(row, clause))) return false
      continue
    }
    const value = row[key] ?? null
    if (condition === null) {
      if (value !== null) return false
      continue
    }
    if (typeof condition === 'object') {
      const operators = condition as Record<string, unknown>
      const unsupported = Object.keys(operators).filter((op) => !['not', 'notIn', 'in'].includes(op))
      if (unsupported.length > 0) throw new Error(`unsupported operator(s) ${unsupported.join(', ')} on "${key}"`)
      if ('not' in operators) {
        if (operators.not === null) { if (value === null) return false } else if (value === operators.not) return false
      }
      if ('notIn' in operators && (operators.notIn as unknown[]).includes(value)) return false
      if ('in' in operators && !(operators.in as unknown[]).includes(value)) return false
      continue
    }
    if (value !== condition) return false
  }
  return true
}

function makeClient(store: Store): TenantSwitchGuardClient {
  const counter = <T extends Record<string, unknown>>(rows: T[]) =>
    async (args: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, args.where)).length
  return {
    setting: {
      async findUnique(args) {
        const value = store.settings.get(args.where.key)
        return value === undefined ? null : { value }
      },
      async upsert(args) {
        store.settings.set(args.where.key, args.update.value)
        return {}
      },
    },
    purchaseInvoice: { count: counter(store.bills) },
    salesOrder: { count: counter(store.orders) },
    salesOrderRefund: { count: counter(store.refunds) },
    supplierCreditNote: { count: counter(store.supplierCreditNotes) },
    accountingSyncLog: { count: counter(store.syncRows) },
  }
}

function guard(store: Store, incomingTenantId: string) {
  return assertTenantSwitchIsSafe(makeClient(store), {
    connector: CONNECTOR,
    connectorLabel: 'QuickBooks',
    tenantNoun: 'company',
    incomingTenantId,
  })
}

test('[o3d-9kek r4 f1] a first connection is allowed, and is remembered for next time', async () => {
  const store = emptyStore()
  // Nothing recorded: there is no previous tenant, so there is nothing to confuse this one with.
  // Note this holds even though the store below would otherwise be full of foreign ids — the
  // question the guard asks is "is this a SWITCH", and with no history the answer is no.
  store.bills.push({ accountingInvoiceId: '42', accountingInvoiceProvenance: '' })
  assert.deepEqual(await guard(store, 'realm-A'), { ok: true, previousTenantId: null })

  await recordConnectedTenantId(makeClient(store), CONNECTOR, 'realm-A')
  assert.equal(store.settings.get(lastConnectedTenantSettingKey(CONNECTOR)), 'realm-A')
})

test('[o3d-9kek r4 f1] ordinary re-auth to the SAME company is never blocked, and counts nothing', async () => {
  const store = emptyStore()
  store.settings.set(lastConnectedTenantSettingKey(CONNECTOR), 'realm-A')
  // A full ledger of this realm's own ids, plus legacy sentinel rows. None of it is a reason to
  // refuse: it is the same company. Blocking here would break every expired-refresh-token reconnect,
  // which is the common case and the one that must never fail.
  store.bills.push(
    { accountingInvoiceId: '42', accountingInvoiceProvenance: REALM_A },
    { accountingInvoiceId: '43', accountingInvoiceProvenance: '' },
  )
  store.orders.push({ accountingInvoiceId: '99' })

  const client = makeClient(store)
  let counted = 0
  client.purchaseInvoice.count = async () => { counted++; return 1 }

  const decision = await assertTenantSwitchIsSafe(client, {
    connector: CONNECTOR, connectorLabel: 'QuickBooks', tenantNoun: 'company', incomingTenantId: 'realm-A',
  })
  assert.deepEqual(decision, { ok: true, previousTenantId: 'realm-A' })
  assert.equal(counted, 0, 'the same-tenant answer must not depend on counting anything')
})

test('[o3d-9kek r4 f1] a switch is REFUSED while another realm\'s bill ids are still stored', async () => {
  const store = emptyStore()
  store.settings.set(lastConnectedTenantSettingKey(CONNECTOR), 'realm-A')
  // The exact shape that corrupts: realm A issued bill id "42"; realm B will happily issue "42" too,
  // and the payment poller cannot tell them apart.
  store.bills.push({ accountingInvoiceId: '42', accountingInvoiceProvenance: REALM_A })

  const decision = await guard(store, 'realm-B')
  assert.equal(decision.ok, false)
  assert.equal(decision.ok === false && decision.evidence.billsWithForeignProvenance, 1)
  // The refusal has to name the way out, or it is just a broken Connect button.
  assert.match(decision.ok === false ? decision.error : '', /reconnect to company realm-A|clear the existing/i)
  assert.match(decision.ok === false ? decision.error : '', /realm-B/)
})

test('[o3d-9kek r4 f1] the SENTINEL and NULL namespaces are foreign too — unknown is not "ours"', async () => {
  // The '' sentinel on a bill and a NULL sync-row provenance both mean "issuer unidentifiable".
  // Treating them as belonging to whoever connects next is exactly the confident-wrong-answer the
  // whole area forbids, and the compound index gives them their own shared namespace in which a new
  // realm's id can collide freely.
  for (const store of [
    (() => { const s = emptyStore(); s.bills.push({ accountingInvoiceId: '42', accountingInvoiceProvenance: '' }); return s })(),
    (() => { const s = emptyStore(); s.syncRows.push({ connector: CONNECTOR, externalTransactionId: '42', provenance: null }); return s })(),
  ]) {
    store.settings.set(lastConnectedTenantSettingKey(CONNECTOR), 'realm-A')
    assert.equal((await guard(store, 'realm-B')).ok, false)
  }
})

test('[o3d-9kek r4 f1] models with NO provenance column block a switch by their mere existence', async () => {
  // SalesOrder, SalesOrderRefund and SupplierCreditNote store an external id and have nowhere to
  // record who issued it. No reader-side guard can ever be written for them, which is precisely why
  // the fix has to be "do not create the state" rather than "check on read".
  for (const seed of [
    (s: Store) => s.orders.push({ accountingInvoiceId: '42' }),
    (s: Store) => s.refunds.push({ accountingCreditNoteId: '42' }),
    (s: Store) => s.supplierCreditNotes.push({ accountingCreditNoteId: '42' }),
  ]) {
    const store = emptyStore()
    store.settings.set(lastConnectedTenantSettingKey(CONNECTOR), 'realm-A')
    seed(store)
    assert.equal((await guard(store, 'realm-B')).ok, false)
  }
})

test('[o3d-9kek r4 f1] a switch with nothing stored is allowed — the guard protects ids, not tenancy', async () => {
  const store = emptyStore()
  store.settings.set(lastConnectedTenantSettingKey(CONNECTOR), 'realm-A')
  // Rows that carry no external id, and this realm's OWN rows, are not evidence of anything
  // confusable. A genuine clean move must stay possible or operators will find a way around the
  // guard instead of through it.
  store.bills.push({ accountingInvoiceId: null, accountingInvoiceProvenance: '' })
  store.syncRows.push(
    { connector: CONNECTOR, externalTransactionId: null, provenance: null },
    { connector: CONNECTOR, externalTransactionId: '7', provenance: REALM_B },
    { connector: 'xero', externalTransactionId: '7', provenance: 'xero:other' },
  )

  assert.deepEqual(await guard(store, 'realm-B'), { ok: true, previousTenantId: 'realm-A' })
})

test('[o3d-9kek r4 f1] NULL provenance is counted exactly once, not in both buckets', async () => {
  // `provenance: { not: X }` drops NULLs under SQL three-valued logic, so which bucket a NULL lands
  // in would otherwise depend on how Prisma renders the operator. The split is asserted directly
  // because the refusal MESSAGE quotes both numbers back to the operator.
  const store = emptyStore()
  store.syncRows.push(
    { connector: CONNECTOR, externalTransactionId: '1', provenance: null },
    { connector: CONNECTOR, externalTransactionId: '2', provenance: REALM_A },
  )
  const evidence = await collectTenantSwitchEvidence(makeClient(store), {
    connector: CONNECTOR,
    incomingProvenance: REALM_B,
  })
  assert.equal(evidence.syncRowsWithUnknownProvenance, 1)
  assert.equal(evidence.syncRowsWithForeignProvenance, 1)
  assert.equal(tenantSwitchEvidenceTotal(evidence), 2)
})

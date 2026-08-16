// ---------------------------------------------------------------------------
// REFUSE A TENANT/REALM SWITCH THAT WOULD MAKE TWO COMPANIES' EXTERNAL IDS CONFUSABLE
// (o3d-9kek r4 finding 1)
//
// THE MISTAKE THIS CORRECTS. The r3 note on quickbooks/auth.ts disconnect() claimed a retired
// realm's history stays "readable and inert" after reconnecting to a different company, because
// every stored id carries the provenance of the connection that issued it and uniqueness is
// enforced over the PAIR. The first half is true. The second half — "inert" — was FALSE, and
// provably so: quickbooks/payment-poller.ts selects every linked bill with
// `accountingInvoiceId != null, paidAt: null` and never looks at accountingInvoiceProvenance, so a
// paid bill in realm B whose integer id collides with a retired realm-A bill marks the A bill paid.
// Roughly 190 call sites read a naked accountingInvoiceId / accountingCreditNoteId across sales,
// purchasing, payment reconciliation, attachments and the update paths, and document types like
// SalesOrder and SalesOrderRefund have no provenance column at all to check even if they wanted to.
//
// AND THE COMPOUND INDEX IS WHAT CREATED THE EXPOSURE. Under the old GLOBAL unique index on
// purchase_invoices.accounting_invoice_id, realm B's colliding id simply failed to write: that
// blocked legitimate work, but it never produced two rows whose ids a downstream reader could
// confuse. Under the (id, provenance) pair the same write succeeds cleanly and the confusion is
// created silently. A compound index with unaudited consumers is therefore WORSE than what it
// replaced, and shipping one without closing that gap is not an option.
//
// WHAT THIS DOES INSTEAD OF AUDITING 190 CALL SITES. It removes the ability to CREATE the
// collision state at all: connecting to a different tenant/realm is refused while any document or
// sync row still carries an id this connection did not issue. That is one guard on one path, it
// fails closed, and it holds for every consumer — including the ones with no provenance column and
// the ones nobody has written yet. The audit is still owed and is filed separately; this is what
// makes the window not exist while it happens.
//
// WHY "LAST CONNECTED TENANT" AND NOT THE PIN. The realm pin (`*_expected_*`) is DELETED by
// disconnect, on purpose: an explicit disconnect is how an operator declares they intend to move.
// So at connect time the pin can no longer tell us who we used to be, which is exactly the moment
// this question matters. A separate last-connected marker is written on every successful connect
// and SURVIVES disconnect, so a switch is recognisable as a switch.
//
// WHY IT DOES NOT BLOCK ORDINARY RE-AUTH. Re-authorising to the SAME tenant compares equal and is
// waved through without counting anything, so an expired-refresh-token reconnect — the common case,
// and one that must never be blocked — is untouched. Only a genuinely different tenant id reaches
// the evidence count.
//
// FAIL CLOSED ON UNKNOWN PROVENANCE. An id whose issuer cannot be identified (the '' sentinel on a
// bill, a NULL sync-row provenance, or a document type with no provenance column) counts as
// foreign. It is not provably this tenant's, and the whole point is that a confident wrong answer
// is worse than a refusal.
// ---------------------------------------------------------------------------

/**
 * The Setting row holding the tenant/realm of the last connection this connector completed.
 *
 * Read and written as a RAW Setting row, deliberately not through settings-store: getSettingValue
 * applies an environment-variable fallback, and a guard whose "who were we connected to" answer can
 * be supplied by an env var is not a guard. Same reasoning as the sweep's cursor store — this is
 * machine state, not a configured value, and it is not in the settings UI.
 */
export function lastConnectedTenantSettingKey(connector: string): string {
  return `${connector}_last_connected_tenant_id`
}

/** The minimal Prisma surface this guard reads. Structural, so a test double satisfies it. */
export type TenantSwitchGuardClient = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
    upsert(args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }): Promise<unknown>
  }
  purchaseInvoice: { count(args: { where: Record<string, unknown> }): Promise<number> }
  salesOrder: { count(args: { where: Record<string, unknown> }): Promise<number> }
  salesOrderRefund: { count(args: { where: Record<string, unknown> }): Promise<number> }
  supplierCreditNote: { count(args: { where: Record<string, unknown> }): Promise<number> }
  accountingSyncLog: { count(args: { where: Record<string, unknown> }): Promise<number> }
}

/**
 * What still points at a ledger document this connection did not issue.
 *
 * Split by source rather than summed, because the counts say different things to an operator: the
 * *ForeignProvenance ones name a KNOWN other tenant, the *Unknown / *Unnamespaced ones name ids
 * whose issuer cannot be established at all — the legacy '' sentinel population and the document
 * types that have no provenance column yet.
 */
export type TenantSwitchEvidence = {
  /** Bills linked under a DIFFERENT, identifiable connection. */
  billsWithForeignProvenance: number
  /** Bills linked under the '' sentinel — issuer unknown, so not provably ours. */
  billsWithUnknownProvenance: number
  /** Posted sync rows stamped with a different connection. */
  syncRowsWithForeignProvenance: number
  /** Posted sync rows with NULL provenance — issued before the column existed, or unidentifiable. */
  syncRowsWithUnknownProvenance: number
  /** SalesOrder.accountingInvoiceId — no provenance column exists on this model at all. */
  salesOrdersWithUnnamespacedId: number
  /** SalesOrderRefund.accountingCreditNoteId — likewise. */
  refundsWithUnnamespacedId: number
  /** SupplierCreditNote.accountingCreditNoteId — likewise. */
  supplierCreditNotesWithUnnamespacedId: number
}

export function tenantSwitchEvidenceTotal(evidence: TenantSwitchEvidence): number {
  return Object.values(evidence).reduce((sum, count) => sum + count, 0)
}

/**
 * Count everything that would become confusable with `incomingProvenance`'s ids.
 *
 * The sales/refund/supplier-credit-note counts are NOT filtered by provenance, because those models
 * have none. On a tenant switch every one of their stored ids is unattributable by construction, so
 * their mere existence is the evidence. That is also why this guard, and not a per-consumer check,
 * is the fix: there is nothing on those rows for a consumer to check.
 */
export async function collectTenantSwitchEvidence(
  db: TenantSwitchGuardClient,
  params: { connector: string; incomingProvenance: string },
): Promise<TenantSwitchEvidence> {
  const [
    billsWithForeignProvenance,
    billsWithUnknownProvenance,
    syncRowsWithForeignProvenance,
    syncRowsWithUnknownProvenance,
    salesOrdersWithUnnamespacedId,
    refundsWithUnnamespacedId,
    supplierCreditNotesWithUnnamespacedId,
  ] = await Promise.all([
    db.purchaseInvoice.count({
      where: {
        accountingInvoiceId: { not: null },
        accountingInvoiceProvenance: { notIn: ['', params.incomingProvenance] },
      },
    }),
    db.purchaseInvoice.count({
      where: { accountingInvoiceId: { not: null }, accountingInvoiceProvenance: '' },
    }),
    db.accountingSyncLog.count({
      where: {
        connector: params.connector,
        externalTransactionId: { not: null },
        // NOT(match OR null), not `{ not: incoming }`: SQL's three-valued logic drops NULL rows from
        // an inequality, so which of the two counts a NULL-provenance row lands in would depend on
        // how Prisma renders `not`. Excluding NULLs here explicitly makes the split exact and keeps
        // them counted once, below, under the name that actually describes them.
        NOT: { OR: [{ provenance: params.incomingProvenance }, { provenance: null }] },
      },
    }),
    db.accountingSyncLog.count({
      where: { connector: params.connector, externalTransactionId: { not: null }, provenance: null },
    }),
    db.salesOrder.count({ where: { accountingInvoiceId: { not: null } } }),
    db.salesOrderRefund.count({ where: { accountingCreditNoteId: { not: null } } }),
    db.supplierCreditNote.count({ where: { accountingCreditNoteId: { not: null } } }),
  ])
  return {
    billsWithForeignProvenance,
    billsWithUnknownProvenance,
    syncRowsWithForeignProvenance,
    syncRowsWithUnknownProvenance,
    salesOrdersWithUnnamespacedId,
    refundsWithUnnamespacedId,
    supplierCreditNotesWithUnnamespacedId,
  }
}

export async function readLastConnectedTenantId(
  db: TenantSwitchGuardClient,
  connector: string,
): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: lastConnectedTenantSettingKey(connector) } })
  return row?.value ? row.value : null
}

/**
 * Remember who we just connected to. Called after a connection SUCCEEDS, and never cleared by
 * disconnect — surviving disconnect is the entire reason this exists rather than reusing the pin.
 */
export async function recordConnectedTenantId(
  db: TenantSwitchGuardClient,
  connector: string,
  tenantId: string,
): Promise<void> {
  const key = lastConnectedTenantSettingKey(connector)
  await db.setting.upsert({ where: { key }, create: { key, value: tenantId }, update: { value: tenantId } })
}

/**
 * The refusal an operator reads. It has to name the manual action, because a refusal nobody knows
 * how to clear is just a broken Connect button: either go back to the company that issued the
 * existing links, or clear those links deliberately (which is a decision about financial records,
 * not a checkbox, and is why nothing here does it automatically).
 */
export function tenantSwitchRefusalMessage(params: {
  connectorLabel: string
  tenantNoun: string
  previousTenantId: string
  incomingTenantId: string
  evidence: TenantSwitchEvidence
}): string {
  const { evidence } = params
  const lines = [
    `${evidence.billsWithForeignProvenance} supplier bill(s) linked to another ${params.tenantNoun}`,
    `${evidence.billsWithUnknownProvenance} supplier bill(s) whose issuing ${params.tenantNoun} is unknown`,
    `${evidence.syncRowsWithForeignProvenance + evidence.syncRowsWithUnknownProvenance} posted sync row(s) not issued by this ${params.tenantNoun}`,
    `${evidence.salesOrdersWithUnnamespacedId} sales order(s), ${evidence.refundsWithUnnamespacedId} refund(s) and `
      + `${evidence.supplierCreditNotesWithUnnamespacedId} supplier credit note(s) carrying an external id with no recorded ${params.tenantNoun}`,
  ]
  return (
    `Refusing to connect ${params.connectorLabel} ${params.tenantNoun} ${params.incomingTenantId}: this system still holds external `
    + `document ids issued by ${params.tenantNoun} ${params.previousTenantId}. Those ids are ${params.tenantNoun}-owned and can repeat `
    + `across companies, so keeping both would let a payment, reconciliation or update land on the wrong document — silently. Found: `
    + `${lines.join('; ')}. To proceed, either reconnect to ${params.tenantNoun} ${params.previousTenantId}, or clear the existing `
    + `accounting links first (they are financial records — export them before you do).`
  )
}

export type TenantSwitchDecision =
  | { ok: true; previousTenantId: string | null }
  | { ok: false; error: string; previousTenantId: string; evidence: TenantSwitchEvidence }

/**
 * May this connector connect to `incomingTenantId`?
 *
 * Allowed when there is no previous connection recorded, when the incoming tenant IS the previous
 * one (ordinary re-auth — nothing is counted, so this cannot become slow or flaky on the hot path),
 * or when a switch is genuinely clean: no id anywhere that this tenant did not issue.
 *
 * Refused otherwise. The refusal is the whole point — see the module header — and it is deliberately
 * not overridable from the UI: the escape hatch is an explicit, auditable decision about the stored
 * links, not a checkbox next to the Connect button.
 */
export async function assertTenantSwitchIsSafe(
  db: TenantSwitchGuardClient,
  params: { connector: string; connectorLabel: string; tenantNoun: string; incomingTenantId: string },
): Promise<TenantSwitchDecision> {
  const previousTenantId = await readLastConnectedTenantId(db, params.connector)
  if (previousTenantId === null || previousTenantId === params.incomingTenantId) {
    return { ok: true, previousTenantId }
  }

  const evidence = await collectTenantSwitchEvidence(db, {
    connector: params.connector,
    incomingProvenance: `${params.connector}:${params.incomingTenantId}`,
  })
  if (tenantSwitchEvidenceTotal(evidence) === 0) return { ok: true, previousTenantId }

  return {
    ok: false,
    previousTenantId,
    evidence,
    error: tenantSwitchRefusalMessage({
      connectorLabel: params.connectorLabel,
      tenantNoun: params.tenantNoun,
      previousTenantId,
      incomingTenantId: params.incomingTenantId,
      evidence,
    }),
  }
}

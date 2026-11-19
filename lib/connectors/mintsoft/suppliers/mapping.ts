import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
import { acquirePinnedAdvisoryLockOrNull } from '@/lib/db/pinned-advisory-lock'
import { mintsoftProducerSeam } from '../producer-seam'
import { ASN_SUPPLIER_ACTION } from './asn-supplier'
import { DUPLICATE_GUARD_MIN_SCORE, scoreSupplierPair, suggestMintsoftSuppliers, type SupplierSuggestion } from './match'
import { MINTSOFT_ASN_SEND_SUPPLIER_SETTING, MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, MINTSOFT_SUPPLIER_CREATE_SETTING, MINTSOFT_SUPPLIER_SETTING_KEYS, MINTSOFT_TRANSFER_SUPPLIER_SETTING, readMintsoftSupplierCacheMaxAgeMinutes, readMintsoftSupplierCreateEnabled, readMintsoftSupplierLastSyncAt } from './settings'

/**
 * THE OPERATOR'S DECISIONS ON IMS SUPPLIER -> MINTSOFT SUPPLIER. Every one is audited in the same transaction as the link change (a failed
 * audit rolls the decision back), names who decided and what the operator was shown (the suggestion score), and none of them ever writes the
 * DETAILS of an existing Mintsoft supplier: IMS has no update route to Mintsoft's suppliers at all.
 *
 *   confirm   the operator accepts a suggestion (source OPERATOR_CONFIRMED_SUGGESTION) or picks any cached Mintsoft supplier (OPERATOR_PICKED).
 *   create    "create in Mintsoft": a REAL write. With `mintsoft_supplier_create_enabled` off it is recorded as CREATE_PENDING and nothing is sent.
 *             With it on it passes the producer seam (shadow = nothing sent) and the outbound hold, REQUIRES a cached list read within the last N minutes
 *             (config), and refuses when any cached supplier scores at DUPLICATE_GUARD_MIN_SCORE (the suggestion floor, 55) or more against the name (or shares an e-mail / VAT /
 *             code) unless the operator confirms "create anyway" with a reason. Creating beside an existing supplier is how duplicates are made.
 *   unmap     removes the decision; ASNs for that supplier are refused again while `mintsoft_asn_supplier_required` is on. Refused on a CREATING row.
 *   resolve   the ONLY way out of CREATING (an unknown outcome): an administrator records the Mintsoft id found by hand, or marks it not created.
 */

export type MappingActor = { userId: string | null; label: string }
export type DuplicateCandidate = { externalId: string; name: string; score: number; active: boolean }
export type MappingResult =
  | { success: true; message: string; shadowed?: boolean; warning?: string }
  | { success: false; error: string; shadowed?: boolean; /** The create was refused by the duplicate guard; the operator may repeat it with "create anyway" and a reason. */ duplicates?: DuplicateCandidate[] }

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0]

/** The audit entry of one decision. Names the IMS supplier and the Mintsoft id, never contact details. */
async function audit(tx: Tx, actor: MappingActor, supplierId: string, action: string, description: string, metadata: Record<string, unknown>, level: 'INFO' | 'WARNING' = 'INFO') {
  await logActivityInTransaction(tx, { userId: actor.userId, entityType: 'SUPPLIER', entityId: supplierId, tag: 'sync', action, level, description, metadata: { ...metadata, decidedBy: actor.label } })
}

/** An audit entry on its own (a refusal, an outcome). Never throws: after a live write, a failed audit must not hide what happened. */
async function auditBestEffort(actor: MappingActor, supplierId: string, action: string, description: string, metadata: Record<string, unknown>, level: 'INFO' | 'WARNING' = 'WARNING'): Promise<void> {
  try {
    await db.$transaction((tx) => audit(tx, actor, supplierId, action, description, metadata, level))
  } catch (error) {
    console.error(`[mintsoft-suppliers] audit ${action} for supplier ${supplierId} failed:`, error)
  }
}

/** A refusal before the claim, audited so it is traceable. */
async function refusal(actor: MappingActor, supplierId: string, supplierName: string, why: string, error: string, extra: Record<string, unknown> = {}): Promise<MappingResult> {
  await auditBestEffort(actor, supplierId, 'mintsoft_supplier_create_refused', `"Create in Mintsoft" for IMS supplier "${supplierName}" was refused: ${why}. Nothing was sent.`, { why, ...extra })
  return { success: false, error }
}

const REASON_MIN = 5
/** "Resolve unknown outcome" is refused until the create attempt is at least this old: a slow request may still be in flight (and would land after a NOT_CREATED). */
export const RESOLVE_UNKNOWN_MIN_WAIT_MINUTES = 2
const cleanReason = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, 500) : '')

/** Lets any open "ASN not created: supplier not mapped" task for this supplier close once it is mapped. */
async function closeUnmappedTasks(tx: Tx, supplierId: string) {
  await tx.refusedAction.updateMany({
    where: { action: ASN_SUPPLIER_ACTION, resolvedAt: null, intent: { path: ['imsSupplierId'], equals: supplierId } },
    data: { resolvedAt: new Date(), resolution: 'NO_LONGER_NEEDED' },
  })
}

export const MAPPING_DECISION_SOURCES = ['OPERATOR_CONFIRMED_SUGGESTION', 'OPERATOR_PICKED', 'OPERATOR_CREATE', 'OPERATOR_CREATE_PENDING', 'OPERATOR_RESOLVED_UNKNOWN_CREATE'] as const

const CREATING_BLOCK = 'A create in Mintsoft is in progress or its outcome is unknown for this supplier. Only an administrator can settle it, with "Resolve unknown outcome" (look for the supplier in Mintsoft first). Nothing was changed.'

/** Other IMS suppliers already mapped to this Mintsoft supplier (names), so an operator is warned before two suppliers share one. */
async function otherMappingsOf(tx: Pick<Tx, 'mintsoftSupplierLink'>, externalId: string, exceptSupplierId: string): Promise<Array<{ supplierId: string; name: string }>> {
  const rows = await tx.mintsoftSupplierLink.findMany({ where: { state: 'MAPPED', externalSupplierId: externalId, supplierId: { not: exceptSupplierId } }, select: { supplier: { select: { id: true, name: true } } } })
  return rows.map((row) => ({ supplierId: row.supplier.id, name: row.supplier.name }))
}
const sharedWarning = (others: Array<{ name: string }>, externalId: string) =>
  others.length > 0 ? `Warning: Mintsoft supplier ${externalId} is also mapped to ${others.map((o) => `"${o.name}"`).join(', ')}. Both will put the same supplier on their ASNs. Unmap one if that is not intended.` : undefined

export async function confirmSupplierMapping(input: { supplierId: string; externalSupplierId: string; source: 'OPERATOR_CONFIRMED_SUGGESTION' | 'OPERATOR_PICKED'; suggestionScore?: number | null; actor: MappingActor }): Promise<MappingResult> {
  const externalId = input.externalSupplierId.trim()
  if (!/^\d+$/.test(externalId)) return { success: false, error: 'Choose a Mintsoft supplier from the list.' }
  return db.$transaction(async (tx): Promise<MappingResult> => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true } })
    if (!supplier) return { success: false as const, error: 'That IMS supplier no longer exists.' }
    const remote = await tx.mintsoftSupplier.findUnique({ where: { externalId }, select: { name: true, missingSince: true, active: true } })
    if (!remote) return { success: false as const, error: 'That Mintsoft supplier is not in the cached list. Refresh the Mintsoft supplier list and try again.' }
    if (remote.missingSince) return { success: false as const, error: 'That Mintsoft supplier is no longer in Mintsoft. Refresh the list and choose another.' }
    if (!remote.active) return { success: false as const, error: 'That Mintsoft supplier is inactive in Mintsoft, so it cannot be mapped. Reactivate it in Mintsoft and refresh the list, or choose another.' }
    const before = await tx.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true, externalSupplierId: true } })
    if (before?.state === 'CREATING') return { success: false as const, error: CREATING_BLOCK }
    const score = input.source === 'OPERATOR_CONFIRMED_SUGGESTION' ? input.suggestionScore ?? null : null
    const data = { state: 'MAPPED', externalSupplierId: externalId, decisionSource: input.source, suggestionScore: score, decidedBy: input.actor.userId, decidedAt: new Date() }
    // Conditional, so a create claim taken after the read above is never overwritten.
    const written = before
      ? (await tx.mintsoftSupplierLink.updateMany({ where: { supplierId: supplier.id, state: { not: 'CREATING' } }, data })).count
      : (await tx.mintsoftSupplierLink.createMany({ data: [{ supplierId: supplier.id, ...data }], skipDuplicates: true })).count
    if (written !== 1) return { success: false as const, error: 'This supplier was changed by someone else (a create may be in progress). Reload and check.' }
    await closeUnmappedTasks(tx, supplier.id)
    const others = await otherMappingsOf(tx, externalId, supplier.id)
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_mapped',
      `IMS supplier "${supplier.name}" mapped to Mintsoft supplier ${externalId} ("${remote.name}") (${input.source === 'OPERATOR_PICKED' ? 'picked by the operator' : 'suggestion confirmed'}).`,
      { externalSupplierId: externalId, mintsoftName: remote.name, source: input.source, suggestionScore: score, previousState: before?.state ?? null, previousExternalSupplierId: before?.externalSupplierId ?? null, alsoMappedTo: others.map((o) => o.supplierId) },
      others.length > 0 ? 'WARNING' : 'INFO')
    return { success: true as const, message: `"${supplier.name}" is mapped to Mintsoft supplier ${externalId}.`, warning: sharedWarning(others, externalId) }
  })
}

export async function unmapSupplier(input: { supplierId: string; actor: MappingActor }): Promise<MappingResult> {
  return db.$transaction(async (tx): Promise<MappingResult> => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true } })
    if (!supplier) return { success: false as const, error: 'That IMS supplier no longer exists.' }
    const before = await tx.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true, externalSupplierId: true } })
    if (!before) return { success: true as const, message: `"${supplier.name}" had no mapping.` }
    // A CREATING row may be a live create in flight: deleting it would leave a Mintsoft supplier with no IMS record.
    if (before.state === 'CREATING') return { success: false as const, error: CREATING_BLOCK }
    const removed = await tx.mintsoftSupplierLink.deleteMany({ where: { supplierId: supplier.id, state: { not: 'CREATING' } } })
    if (removed.count !== 1) return { success: false as const, error: 'This supplier was changed by someone else (a create may be in progress). Reload and check.' }
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_unmapped',
      `IMS supplier "${supplier.name}" unmapped from Mintsoft${before.externalSupplierId ? ` supplier ${before.externalSupplierId}` : ''}. Nothing was changed in Mintsoft.`,
      { previousState: before.state, previousExternalSupplierId: before.externalSupplierId })
    return { success: true as const, message: `"${supplier.name}" is no longer mapped.` }
  })
}

/**
 * RESOLVE AN UNKNOWN CREATE OUTCOME (administrators only; the action layer requires a fresh sign-in). The row is in CREATING: a create was sent and
 * its outcome is not known. The administrator looked in Mintsoft and either records the supplier id found there, or marks it not created. A reason is
 * required and kept in the audit. The list must have been read AFTER the create was attempted, so the screen the administrator looked at is not older
 * than the attempt. Compare-and-set on the claim: a row that changed meanwhile is refused.
 */
export async function resolveUnknownSupplierCreate(input: { supplierId: string; actor: MappingActor; reason: string; outcome: { kind: 'FOUND'; externalSupplierId: string } | { kind: 'NOT_CREATED' } }): Promise<MappingResult> {
  const reason = cleanReason(input.reason)
  if (reason.length < REASON_MIN) return { success: false, error: 'Give a reason (at least a few words): what you checked in Mintsoft.' }
  const lastSync = await readMintsoftSupplierLastSyncAt()
  return db.$transaction(async (tx): Promise<MappingResult> => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true } })
    if (!supplier) return { success: false as const, error: 'That IMS supplier no longer exists.' }
    const claim = await tx.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true, decidedAt: true } })
    if (!claim || claim.state !== 'CREATING') return { success: false as const, error: 'This supplier is not waiting on an unknown create outcome. Reload.' }
    const waitedMs = Date.now() - claim.decidedAt.getTime()
    if (waitedMs < RESOLVE_UNKNOWN_MIN_WAIT_MINUTES * 60_000) return { success: false as const, error: `The create attempt is only ${Math.max(0, Math.round(waitedMs / 1000))} seconds old and its request may still be running. Wait at least ${RESOLVE_UNKNOWN_MIN_WAIT_MINUTES} minutes after the attempt, refresh the list, then resolve.` }
    if (!lastSync || lastSync < claim.decidedAt) return { success: false as const, error: 'Refresh the Mintsoft supplier list first, so the list you check is newer than the create attempt.' }
    if (input.outcome.kind === 'NOT_CREATED') {
      const removed = await tx.mintsoftSupplierLink.deleteMany({ where: { supplierId: supplier.id, state: 'CREATING', decidedAt: claim.decidedAt } })
      if (removed.count !== 1) return { success: false as const, error: 'This supplier was changed by someone else. Reload and check.' }
      await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_create_resolved_not_created',
        `Unknown create outcome for IMS supplier "${supplier.name}" resolved: marked NOT created in Mintsoft. Reason: ${reason}`, { reason, attemptedAt: claim.decidedAt.toISOString() }, 'WARNING')
      return { success: true as const, message: `"${supplier.name}" is marked as not created. Create (or map) it again when ready.` }
    }
    const externalId = input.outcome.externalSupplierId.trim()
    if (!/^\d+$/.test(externalId)) return { success: false as const, error: 'Enter the numeric Mintsoft supplier id you found.' }
    const remote = await tx.mintsoftSupplier.findUnique({ where: { externalId }, select: { name: true, missingSince: true, active: true } })
    if (!remote || remote.missingSince) return { success: false as const, error: 'That Mintsoft supplier is not in the latest read of the list. Refresh the list; if it still is not there it cannot be mapped.' }
    if (!remote.active) return { success: false as const, error: 'That Mintsoft supplier is inactive in Mintsoft, so it cannot be mapped.' }
    const done = await tx.mintsoftSupplierLink.updateMany({
      where: { supplierId: supplier.id, state: 'CREATING', decidedAt: claim.decidedAt },
      data: { state: 'MAPPED', externalSupplierId: externalId, decisionSource: 'OPERATOR_RESOLVED_UNKNOWN_CREATE', suggestionScore: null, decidedBy: input.actor.userId, decidedAt: new Date() },
    })
    if (done.count !== 1) return { success: false as const, error: 'This supplier was changed by someone else. Reload and check.' }
    await closeUnmappedTasks(tx, supplier.id)
    const others = await otherMappingsOf(tx, externalId, supplier.id)
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_create_resolved_found',
      `Unknown create outcome for IMS supplier "${supplier.name}" resolved: found in Mintsoft as supplier ${externalId} ("${remote.name}") and mapped. Reason: ${reason}`,
      { reason, externalSupplierId: externalId, mintsoftName: remote.name, attemptedAt: claim.decidedAt.toISOString(), alsoMappedTo: others.map((o) => o.supplierId) }, 'WARNING')
    return { success: true as const, message: `"${supplier.name}" is mapped to Mintsoft supplier ${externalId}.`, warning: sharedWarning(others, externalId) }
  })
}

/** The cached suppliers (not missing) that look like `supplier`: a name score at DUPLICATE_GUARD_MIN_SCORE (55) or more, or a shared e-mail / VAT / code. */
export function findDuplicateCandidates(supplier: { id: string; name: string; email: string | null; vatNumber: string | null; accountNumber: string | null }, cached: ReadonlyArray<{ externalId: string; name: string; code: string | null; email: string | null; vatNumber: string | null; active: boolean }>): DuplicateCandidate[] {
  return cached
    .map((row) => ({ row, pair: scoreSupplierPair(supplier, row) }))
    .filter(({ pair }) => pair.score >= DUPLICATE_GUARD_MIN_SCORE || pair.signals.length > 0)
    .sort((a, b) => b.pair.score - a.pair.score || a.row.name.localeCompare(b.row.name))
    .slice(0, 5)
    .map(({ row, pair }) => ({ externalId: row.externalId, name: row.name, score: pair.score, active: row.active }))
}

/**
 * "CREATE IN MINTSOFT". THE ONE PLACE IMS CREATES A MINTSOFT SUPPLIER, through the producer seam and the outbound hold.
 * The claim (state CREATING, audited in the same transaction) is taken BEFORE the request, so two clicks cannot both create, and every later write on
 * the row is a compare-and-set on THAT claim. A create that fails cleanly (the hold, a refusal by Mintsoft) releases the claim; one whose outcome is
 * unknown (a thrown transport error) KEEPS it, because the supplier may exist, and Create cannot run again until an administrator resolves it. A create
 * that succeeded is NEVER rolled back: if the claim was lost meanwhile the supplier is still cached and audited.
 */
export async function createMintsoftSupplierForImsSupplier(input: { supplierId: string; actor: MappingActor; createAnyway?: { reason: string } }): Promise<MappingResult> {
  const supplier = await db.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true, email: true, contactName: true, phone: true, vatNumber: true, accountNumber: true } })
  if (!supplier) return { success: false, error: 'That IMS supplier no longer exists.' }
  const existing = await db.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true } })
  if (existing?.state === 'MAPPED') return { success: false, error: `"${supplier.name}" is already mapped to a Mintsoft supplier. Unmap it first if you want to choose again.` }
  if (existing?.state === 'CREATING') return refusal(input.actor, supplier.id, supplier.name, 'a create is in progress or its outcome is unknown', CREATING_BLOCK)

  if (!(await readMintsoftSupplierCreateEnabled())) {
    await db.$transaction(async (tx) => {
      const data = { state: 'CREATE_PENDING', externalSupplierId: null, decisionSource: 'OPERATOR_CREATE_PENDING', suggestionScore: null, decidedBy: input.actor.userId, decidedAt: new Date() }
      await tx.mintsoftSupplierLink.upsert({ where: { supplierId: supplier.id }, create: { supplierId: supplier.id, ...data }, update: data })
      await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_create_pending',
        `"Create in Mintsoft" chosen for IMS supplier "${supplier.name}", recorded as pending: mintsoft_supplier_create_enabled is off, so nothing was sent.`,
        { source: 'OPERATOR_CREATE_PENDING' })
    })
    return { success: true, message: `Recorded as pending. Nothing was sent to Mintsoft: creating suppliers there is switched off.` }
  }

  // ONE LOCK FOR THE LIST READ AND EVERY CREATE. A create never overlaps a refresh (whose sweep could mark the new supplier missing and hide it from the
  // duplicate guard), and two creates never overlap each other, so two similar IMS suppliers cannot both pass the guard before either is cached.
  // A refusal here is a refusal to start: nothing was sent.
  const lock = await acquirePinnedAdvisoryLockOrNull(0, WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE)
  if (!lock) return refusal(input.actor, supplier.id, supplier.name, 'a Mintsoft supplier refresh or another create is running', 'A Mintsoft supplier refresh or another create is running. Wait for it to finish, then reload and try again. Nothing was sent.')
  try {
    return await createLockedMintsoftSupplier(input, supplier)
  } finally {
    await lock.release()
  }
}

type ImsSupplierForCreate = { id: string; name: string; email: string | null; contactName: string | null; phone: string | null; vatNumber: string | null; accountNumber: string | null }

/** The create from the duplicate guard on, run under the list-sync lock. */
async function createLockedMintsoftSupplier(input: { supplierId: string; actor: MappingActor; createAnyway?: { reason: string } }, supplier: ImsSupplierForCreate): Promise<MappingResult> {
  // THE DUPLICATE GUARD. A create is only as safe as the list it was checked against.
  const maxAge = await readMintsoftSupplierCacheMaxAgeMinutes()
  const lastSync = await readMintsoftSupplierLastSyncAt()
  const ageMinutes = lastSync ? (Date.now() - lastSync.getTime()) / 60_000 : null
  if (ageMinutes === null || ageMinutes > maxAge) {
    return refusal(input.actor, supplier.id, supplier.name, ageMinutes === null ? 'the Mintsoft supplier list has never been read' : `the Mintsoft supplier list is ${Math.round(ageMinutes)} minutes old (limit ${maxAge})`,
      `The Mintsoft supplier list ${ageMinutes === null ? 'has not been read yet' : `was last read ${Math.round(ageMinutes)} minutes ago (the limit is ${maxAge})`}. Refresh it first, so IMS can check the supplier does not already exist.`, { ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes), maxAge })
  }
  const cached = await db.mintsoftSupplier.findMany({ where: { missingSince: null }, select: { externalId: true, name: true, code: true, email: true, vatNumber: true, active: true } })
  const duplicates = findDuplicateCandidates(supplier, cached)
  let confirmedAnyway: string | null = null
  if (duplicates.length > 0) {
    const reason = cleanReason(input.createAnyway?.reason)
    if (!input.createAnyway) {
      await auditBestEffort(input.actor, supplier.id, 'mintsoft_supplier_create_refused', `"Create in Mintsoft" for IMS supplier "${supplier.name}" was refused: Mintsoft already holds a similar supplier. Nothing was sent.`, { why: 'similar-supplier-exists', duplicates })
      return { success: false, duplicates, error: `Mintsoft already has a similar supplier: ${duplicates.map((d) => `"${d.name}" (${d.externalId}, ${d.score}%${d.active ? '' : ', inactive'})`).join(', ')}. Map one of them instead, or confirm "create anyway" with a reason.` }
    }
    if (reason.length < REASON_MIN) return { success: false, duplicates, error: 'To create anyway, give a reason (why none of the similar Mintsoft suppliers is this one).' }
    confirmedAnyway = reason
  }

  const connector = getWmsConnector('mintsoft')
  if (typeof connector.createSupplier !== 'function') return { success: false, error: 'The Mintsoft connector cannot create suppliers.' }
  const seam = await mintsoftProducerSeam({
    operation: 'supplier.create',
    subjectType: 'Supplier',
    subjectId: supplier.id,
    payload: { supplierId: supplier.id, name: supplier.name },
    summary: { kind: 'Supplier' },
  })
  if (!seam.proceed) return { ...(await refusal(input.actor, supplier.id, supplier.name, 'the producer hold (shadow) is active', seam.notice)), shadowed: true }

  // The claim, before the send, audited in the same transaction. claimedAt is the claim's identity: every later write compares on it.
  const claimedAt = new Date()
  const claimData = { state: 'CREATING', externalSupplierId: null, decisionSource: 'OPERATOR_CREATE', suggestionScore: null, decidedBy: input.actor.userId, decidedAt: claimedAt }
  const claimed = await db.$transaction(async (tx) => {
    const fresh = (await tx.mintsoftSupplierLink.createMany({ data: [{ supplierId: supplier.id, ...claimData }], skipDuplicates: true })).count === 1
    const fromPending = !fresh && (await tx.mintsoftSupplierLink.updateMany({ where: { supplierId: supplier.id, state: 'CREATE_PENDING' }, data: claimData })).count === 1
    if (!fresh && !fromPending) return false
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_create_claimed',
      `"Create in Mintsoft" sent for IMS supplier "${supplier.name}" (a REAL write to Mintsoft).${confirmedAnyway ? ` Created anyway despite similar suppliers. Reason: ${confirmedAnyway}` : ''}`,
      { source: 'OPERATOR_CREATE', createAnyway: confirmedAnyway ? { reason: confirmedAnyway, duplicates } : null, cacheReadAt: lastSync?.toISOString() ?? null }, 'WARNING')
    return true
  })
  if (!claimed) return refusal(input.actor, supplier.id, supplier.name, 'the supplier was mapped or is being created by someone else', 'This supplier was mapped or is being created by someone else. Reload and check.')
  const claimWhere = { supplierId: supplier.id, state: 'CREATING', decidedAt: claimedAt }

  let result: Awaited<ReturnType<NonNullable<typeof connector.createSupplier>>>
  try {
    result = await connector.createSupplier({ name: supplier.name, email: supplier.email, contactName: supplier.contactName, phone: supplier.phone }, seam.clearance)
  } catch (error) {
    // Outcome unknown: the claim stays, so nobody creates a second one blindly.
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'unknown error'
    await auditBestEffort(input.actor, supplier.id, 'mintsoft_supplier_create_unknown',
      `"Create in Mintsoft" for IMS supplier "${supplier.name}" did not finish cleanly (${detail}). The supplier MAY exist in Mintsoft; the row stays CREATING until an administrator resolves it.`, { error: detail })
    return { success: false, error: `The Mintsoft create did not finish cleanly (${detail}). The supplier may exist in Mintsoft: refresh the list, look for it, and ask an administrator to resolve the unknown outcome before trying again.` }
  }
  if (!result.created) {
    await db.mintsoftSupplierLink.deleteMany({ where: claimWhere })
    await auditBestEffort(input.actor, supplier.id, 'mintsoft_supplier_create_declined',
      `"Create in Mintsoft" for IMS supplier "${supplier.name}" ${result.held ? 'was not sent (held)' : 'was refused by Mintsoft'}: ${result.message}`, { held: Boolean(result.held), message: result.message })
    return { success: false, error: result.held ? `Not sent: ${result.message}` : `Mintsoft did not create the supplier: ${result.message}` }
  }

  // The supplier EXISTS in Mintsoft now. Nothing below may roll that back or lose it.
  const externalId = result.externalId
  try {
    return await db.$transaction(async (tx): Promise<MappingResult> => {
      // Cached honestly: never read by a sync (epoch lastSeenAt), but stamped with a run id so the next full read can mark it missing.
      await tx.mintsoftSupplier.upsert({
        where: { externalId },
        create: { externalId, name: supplier.name, email: supplier.email, active: true, lastSeenRunId: 'ims-create', lastSeenAt: new Date(0), createdAt: new Date() },
        update: {},
      })
      const done = await tx.mintsoftSupplierLink.updateMany({ where: claimWhere, data: { state: 'MAPPED', externalSupplierId: externalId, decidedAt: new Date() } })
      if (done.count === 1) {
        await closeUnmappedTasks(tx, supplier.id)
        await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_created',
          `IMS supplier "${supplier.name}" created in Mintsoft as supplier ${externalId} and mapped to it.`, { externalSupplierId: externalId, source: 'OPERATOR_CREATE' })
        return { success: true as const, message: `Created in Mintsoft as supplier ${externalId} and mapped.` }
      }
      await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_created_claim_lost',
        `IMS supplier "${supplier.name}" WAS created in Mintsoft as supplier ${externalId}, but its create claim had been changed meanwhile, so the mapping was NOT written. The supplier is cached; map it by hand.`,
        { externalSupplierId: externalId, source: 'OPERATOR_CREATE' }, 'WARNING')
      return { success: false as const, error: `The supplier WAS created in Mintsoft as supplier ${externalId}, but this row changed while the request ran, so it was not mapped. It is in the cached list: map "${supplier.name}" to it by hand.` }
    })
  } catch (error) {
    // The record could not be written. The claim is untouched (still CREATING, i.e. unknown outcome), and the id is in the message and the log.
    console.error(`[mintsoft-suppliers] supplier ${supplier.id} was created in Mintsoft as ${externalId} but recording it failed:`, error)
    await auditBestEffort(input.actor, supplier.id, 'mintsoft_supplier_created_unrecorded',
      `IMS supplier "${supplier.name}" WAS created in Mintsoft as supplier ${externalId} but IMS could not record it. The row stays CREATING; resolve it with that id.`, { externalSupplierId: externalId })
    return { success: false, error: `The supplier WAS created in Mintsoft as supplier ${externalId}, but IMS could not record it. Ask an administrator to resolve the unknown outcome with that id.` }
  }
}

export type SupplierMappingRow = {
  supplierId: string
  name: string
  active: boolean
  state: 'UNMAPPED' | 'MAPPED' | 'CREATE_PENDING' | 'CREATING'
  externalSupplierId: string | null
  mappedName: string | null
  /** The mapped Mintsoft supplier is gone from the latest read, or inactive: it is not sent and needs a new decision. */
  mappedMissing: boolean
  mappedInactive: boolean
  /** Other IMS suppliers mapped to the SAME Mintsoft supplier (names). */
  sharedWith: string[]
  decisionSource: string | null
  decidedAt: string | null
  suggestions: SupplierSuggestion[]
}

export type SupplierMappingScreen = {
  rows: SupplierMappingRow[]
  remote: Array<{ externalId: string; name: string; code: string | null }>
  lastSyncedAt: string | null
  cacheMaxAgeMinutes: number
  /** True when the list was never read, or was last read longer ago than the create guard allows. */
  cacheStale: boolean
  transferSupplierId: string | null
  createEnabled: boolean
  asnRequired: boolean
  sendSupplierEnabled: boolean
  /** Set by the server action from the session: only an administrator is offered the switches' save and "Resolve unknown outcome". */
  viewerIsAdmin: boolean
  counts: { total: number; mapped: number; unmapped: number; pending: number }
}

/** Everything the mapping screen shows, in a bounded number of queries. Suggestions are computed for suppliers that are not mapped. */
export async function loadSupplierMappingScreen(): Promise<SupplierMappingScreen> {
  const [suppliers, links, remotes, settings] = await Promise.all([
    db.supplier.findMany({ where: { active: true }, select: { id: true, name: true, email: true, vatNumber: true, accountNumber: true, active: true }, orderBy: { name: 'asc' } }),
    db.mintsoftSupplierLink.findMany(),
    db.mintsoftSupplier.findMany({ orderBy: { name: 'asc' } }),
    db.setting.findMany({ where: { key: { in: [...MINTSOFT_SUPPLIER_SETTING_KEYS] } } }),
  ])
  const setting = (key: string) => settings.find((row) => row.key === key)?.value ?? null
  const transferSupplierId = setting(MINTSOFT_TRANSFER_SUPPLIER_SETTING)?.trim() || null
  // The transfer supplier is listed even when inactive: it is mapped through this same screen.
  const missingTransfer = transferSupplierId && !suppliers.some((row) => row.id === transferSupplierId)
    ? await db.supplier.findUnique({ where: { id: transferSupplierId }, select: { id: true, name: true, email: true, vatNumber: true, accountNumber: true, active: true } })
    : null
  const all = missingTransfer ? [...suppliers, missingTransfer] : suppliers
  const linkBySupplier = new Map(links.map((link) => [link.supplierId, link]))
  const remoteById = new Map(remotes.map((row) => [row.externalId, row]))
  // Only suppliers present in the latest read AND active are ever suggested, picked or sent.
  const live = remotes.filter((row) => row.missingSince === null && row.active).map((row) => ({ externalId: row.externalId, name: row.name, code: row.code, email: row.email, vatNumber: row.vatNumber, active: row.active }))

  const rows = all.map((supplier): SupplierMappingRow => {
    const link = linkBySupplier.get(supplier.id)
    const mapped = link?.state === 'MAPPED' ? remoteById.get(link.externalSupplierId ?? '') : undefined
    const sharedWith = link?.state === 'MAPPED' && link.externalSupplierId
      ? all.filter((other) => other.id !== supplier.id && linkBySupplier.get(other.id)?.state === 'MAPPED' && linkBySupplier.get(other.id)?.externalSupplierId === link.externalSupplierId).map((other) => other.name)
      : []
    return {
      supplierId: supplier.id,
      name: supplier.name,
      active: supplier.active,
      state: !link ? 'UNMAPPED' : (link.state as SupplierMappingRow['state']),
      externalSupplierId: link?.externalSupplierId ?? null,
      mappedName: mapped?.name ?? null,
      mappedMissing: Boolean(link?.state === 'MAPPED' && (!mapped || mapped.missingSince || !mapped.active)),
      mappedInactive: Boolean(link?.state === 'MAPPED' && mapped && !mapped.missingSince && !mapped.active),
      sharedWith,
      decisionSource: link?.decisionSource ?? null,
      decidedAt: link?.decidedAt.toISOString() ?? null,
      suggestions: link?.state === 'MAPPED' ? [] : suggestMintsoftSuppliers({ id: supplier.id, name: supplier.name, email: supplier.email, vatNumber: supplier.vatNumber, accountNumber: supplier.accountNumber }, live),
    }
  })
  const mapped = rows.filter((row) => row.state === 'MAPPED' && !row.mappedMissing).length
  // The age of the list comes from the sync's own record, never from row timestamps (a row inserted by an IMS create is not a read).
  const [lastSyncedAt, cacheMaxAgeMinutes] = await Promise.all([readMintsoftSupplierLastSyncAt(), readMintsoftSupplierCacheMaxAgeMinutes()])
  return {
    rows,
    remote: live.map(({ externalId, name, code }) => ({ externalId, name, code })),
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    cacheMaxAgeMinutes,
    cacheStale: !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > cacheMaxAgeMinutes * 60_000,
    transferSupplierId,
    createEnabled: setting(MINTSOFT_SUPPLIER_CREATE_SETTING) === 'true',
    asnRequired: setting(MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING) === 'true',
    sendSupplierEnabled: setting(MINTSOFT_ASN_SEND_SUPPLIER_SETTING) === 'true',
    viewerIsAdmin: false,
    counts: { total: rows.length, mapped, unmapped: rows.filter((row) => row.state === 'UNMAPPED' || row.mappedMissing).length, pending: rows.filter((row) => row.state === 'CREATE_PENDING' || row.state === 'CREATING').length },
  }
}

import { db } from '@/lib/db'
import { logActivityInTransaction } from '@/lib/activity-log'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { mintsoftProducerSeam } from '../producer-seam'
import { ASN_SUPPLIER_ACTION } from './asn-supplier'
import { normalizeSupplierName, suggestMintsoftSuppliers, type SupplierSuggestion } from './match'
import { MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING, MINTSOFT_SUPPLIER_CREATE_SETTING, MINTSOFT_SUPPLIER_SETTING_KEYS, MINTSOFT_TRANSFER_SUPPLIER_SETTING, readMintsoftSupplierCreateEnabled } from './settings'

/**
 * THE OPERATOR'S DECISIONS ON IMS SUPPLIER -> MINTSOFT SUPPLIER. Every one is audited in the same transaction as the link change (a failed
 * audit rolls the decision back), names who decided and what the operator was shown (the suggestion score), and none of them ever writes the
 * DETAILS of an existing Mintsoft supplier: IMS has no update route to Mintsoft's suppliers at all.
 *
 *   confirm   the operator accepts a suggestion (source OPERATOR_CONFIRMED_SUGGESTION) or picks any cached Mintsoft supplier (OPERATOR_PICKED).
 *   create    "create in Mintsoft": a REAL write. With `mintsoft_supplier_create_enabled` off it is recorded as CREATE_PENDING and nothing is sent.
 *             With it on it passes the producer seam (shadow = nothing sent) and the outbound hold, and refuses when the name already exists
 *             in the cached list (map that one instead: creating beside it is how duplicates are made).
 *   unmap     removes the decision; ASNs for that supplier are refused again while `mintsoft_asn_supplier_required` is on.
 */

export type MappingActor = { userId: string | null; label: string }
export type MappingResult = { success: true; message: string; shadowed?: boolean } | { success: false; error: string; shadowed?: boolean }

export const MAPPING_DECISION_SOURCES = ['OPERATOR_CONFIRMED_SUGGESTION', 'OPERATOR_PICKED', 'OPERATOR_CREATE', 'OPERATOR_CREATE_PENDING'] as const

/** The audit entry of one decision. Names the IMS supplier and the Mintsoft id, never contact details. */
async function audit(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], actor: MappingActor, supplierId: string, action: string, description: string, metadata: Record<string, unknown>) {
  await logActivityInTransaction(tx, { userId: actor.userId, entityType: 'SUPPLIER', entityId: supplierId, tag: 'sync', action, description, metadata: { ...metadata, decidedBy: actor.label } })
}

/** Lets any open "ASN not created: supplier not mapped" task for this supplier close once it is mapped. */
async function closeUnmappedTasks(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], supplierId: string) {
  await tx.refusedAction.updateMany({
    where: { action: ASN_SUPPLIER_ACTION, resolvedAt: null, intent: { path: ['imsSupplierId'], equals: supplierId } },
    data: { resolvedAt: new Date(), resolution: 'NO_LONGER_NEEDED' },
  })
}

export async function confirmSupplierMapping(input: { supplierId: string; externalSupplierId: string; source: 'OPERATOR_CONFIRMED_SUGGESTION' | 'OPERATOR_PICKED'; suggestionScore?: number | null; actor: MappingActor }): Promise<MappingResult> {
  const externalId = input.externalSupplierId.trim()
  if (!/^\d+$/.test(externalId)) return { success: false, error: 'Choose a Mintsoft supplier from the list.' }
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true } })
    if (!supplier) return { success: false as const, error: 'That IMS supplier no longer exists.' }
    const remote = await tx.mintsoftSupplier.findUnique({ where: { externalId }, select: { name: true, missingSince: true } })
    if (!remote) return { success: false as const, error: 'That Mintsoft supplier is not in the cached list. Refresh the Mintsoft supplier list and try again.' }
    if (remote.missingSince) return { success: false as const, error: 'That Mintsoft supplier is no longer in Mintsoft. Refresh the list and choose another.' }
    const before = await tx.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true, externalSupplierId: true } })
    if (before?.state === 'CREATING') return { success: false as const, error: 'A create in Mintsoft is in progress or was interrupted for this supplier. Check Mintsoft, refresh the list, then unmap this supplier and map it by hand.' }
    const score = input.source === 'OPERATOR_CONFIRMED_SUGGESTION' ? input.suggestionScore ?? null : null
    const data = { state: 'MAPPED', externalSupplierId: externalId, decisionSource: input.source, suggestionScore: score, decidedBy: input.actor.userId, decidedAt: new Date() }
    await tx.mintsoftSupplierLink.upsert({ where: { supplierId: supplier.id }, create: { supplierId: supplier.id, ...data }, update: data })
    await closeUnmappedTasks(tx, supplier.id)
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_mapped',
      `IMS supplier "${supplier.name}" mapped to Mintsoft supplier ${externalId} ("${remote.name}") (${input.source === 'OPERATOR_PICKED' ? 'picked by the operator' : 'suggestion confirmed'}).`,
      { externalSupplierId: externalId, mintsoftName: remote.name, source: input.source, suggestionScore: score, previousState: before?.state ?? null, previousExternalSupplierId: before?.externalSupplierId ?? null })
    return { success: true as const, message: `"${supplier.name}" is mapped to Mintsoft supplier ${externalId}.` }
  })
}

export async function unmapSupplier(input: { supplierId: string; actor: MappingActor }): Promise<MappingResult> {
  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true } })
    if (!supplier) return { success: false as const, error: 'That IMS supplier no longer exists.' }
    const before = await tx.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true, externalSupplierId: true } })
    if (!before) return { success: true as const, message: `"${supplier.name}" had no mapping.` }
    await tx.mintsoftSupplierLink.delete({ where: { supplierId: supplier.id } })
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_unmapped',
      `IMS supplier "${supplier.name}" unmapped from Mintsoft${before.externalSupplierId ? ` supplier ${before.externalSupplierId}` : ''}. Nothing was changed in Mintsoft.`,
      { previousState: before.state, previousExternalSupplierId: before.externalSupplierId })
    return { success: true as const, message: `"${supplier.name}" is no longer mapped.` }
  })
}

/**
 * "CREATE IN MINTSOFT". THE ONE PLACE IMS CREATES A MINTSOFT SUPPLIER, through the producer seam and the outbound hold.
 * The claim (state CREATING) is taken BEFORE the request, so two clicks cannot both create. A create that fails cleanly (the hold, a refusal by
 * Mintsoft) releases the claim; one whose outcome is unknown (a thrown transport error) KEEPS it, because the supplier may exist.
 */
export async function createMintsoftSupplierForImsSupplier(input: { supplierId: string; actor: MappingActor }): Promise<MappingResult> {
  const supplier = await db.supplier.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true, email: true, contactName: true, phone: true } })
  if (!supplier) return { success: false, error: 'That IMS supplier no longer exists.' }
  const existing = await db.mintsoftSupplierLink.findUnique({ where: { supplierId: supplier.id }, select: { state: true } })
  if (existing?.state === 'MAPPED') return { success: false, error: `"${supplier.name}" is already mapped to a Mintsoft supplier. Unmap it first if you want to choose again.` }
  if (existing?.state === 'CREATING') return { success: false, error: 'A create in Mintsoft is already in progress, or was interrupted, for this supplier. Check Mintsoft, refresh the list and map it by hand.' }

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

  const cachedCount = await db.mintsoftSupplier.count()
  if (cachedCount === 0) return { success: false, error: 'The Mintsoft supplier list has not been read yet. Refresh it first so IMS can check the supplier does not already exist.' }
  const wanted = normalizeSupplierName(supplier.name)
  const clash = (await db.mintsoftSupplier.findMany({ where: { missingSince: null }, select: { externalId: true, name: true } })).find((row) => normalizeSupplierName(row.name) === wanted)
  if (clash) return { success: false, error: `Mintsoft already has "${clash.name}" (${clash.externalId}). Map it instead of creating a second one.` }

  const connector = getWmsConnector('mintsoft')
  if (typeof connector.createSupplier !== 'function') return { success: false, error: 'The Mintsoft connector cannot create suppliers.' }
  const seam = await mintsoftProducerSeam({
    operation: 'supplier.create',
    subjectType: 'Supplier',
    subjectId: supplier.id,
    payload: { supplierId: supplier.id, name: supplier.name },
    summary: { kind: 'Supplier' },
  })
  if (!seam.proceed) return { success: false, shadowed: true, error: seam.notice }

  // The claim, before the send.
  const claimData = { state: 'CREATING', externalSupplierId: null, decisionSource: 'OPERATOR_CREATE', suggestionScore: null, decidedBy: input.actor.userId, decidedAt: new Date() }
  const fresh = (await db.mintsoftSupplierLink.createMany({ data: [{ supplierId: supplier.id, ...claimData }], skipDuplicates: true })).count === 1
  const fromPending = !fresh && (await db.mintsoftSupplierLink.updateMany({ where: { supplierId: supplier.id, state: 'CREATE_PENDING' }, data: claimData })).count === 1
  if (!fresh && !fromPending) return { success: false, error: 'This supplier was mapped or is being created by someone else. Reload and check.' }

  let result: Awaited<ReturnType<NonNullable<typeof connector.createSupplier>>>
  try {
    result = await connector.createSupplier({ name: supplier.name, email: supplier.email, contactName: supplier.contactName, phone: supplier.phone }, seam.clearance)
  } catch (error) {
    // Outcome unknown: the claim stays, so nobody creates a second one blindly.
    return { success: false, error: `The Mintsoft create did not finish cleanly (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}). The supplier may exist in Mintsoft: refresh the list and map it by hand before trying again.` }
  }
  if (!result.created) {
    await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: supplier.id, state: 'CREATING' } })
    return { success: false, error: result.held ? `Not sent: ${result.message}` : `Mintsoft did not create the supplier: ${result.message}` }
  }
  await db.$transaction(async (tx) => {
    const now = new Date()
    await tx.mintsoftSupplier.upsert({
      where: { externalId: result.externalId },
      create: { externalId: result.externalId, name: supplier.name, email: supplier.email, active: true, lastSeenAt: now },
      update: {},
    })
    await tx.mintsoftSupplierLink.update({ where: { supplierId: supplier.id }, data: { state: 'MAPPED', externalSupplierId: result.externalId, decidedAt: now } })
    await closeUnmappedTasks(tx, supplier.id)
    await audit(tx, input.actor, supplier.id, 'mintsoft_supplier_created',
      `IMS supplier "${supplier.name}" created in Mintsoft as supplier ${result.externalId} and mapped to it.`,
      { externalSupplierId: result.externalId, source: 'OPERATOR_CREATE' })
  })
  return { success: true, message: `Created in Mintsoft as supplier ${result.externalId} and mapped.` }
}

export type SupplierMappingRow = {
  supplierId: string
  name: string
  active: boolean
  state: 'UNMAPPED' | 'MAPPED' | 'CREATE_PENDING' | 'CREATING'
  externalSupplierId: string | null
  mappedName: string | null
  mappedMissing: boolean
  decisionSource: string | null
  decidedAt: string | null
  suggestions: SupplierSuggestion[]
}

export type SupplierMappingScreen = {
  rows: SupplierMappingRow[]
  remote: Array<{ externalId: string; name: string; code: string | null }>
  lastSyncedAt: string | null
  transferSupplierId: string | null
  createEnabled: boolean
  asnRequired: boolean
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
  const live = remotes.filter((row) => row.missingSince === null).map((row) => ({ externalId: row.externalId, name: row.name, code: row.code, email: row.email, vatNumber: row.vatNumber, active: row.active }))

  const rows = all.map((supplier): SupplierMappingRow => {
    const link = linkBySupplier.get(supplier.id)
    const mapped = link?.state === 'MAPPED' ? remoteById.get(link.externalSupplierId ?? '') : undefined
    return {
      supplierId: supplier.id,
      name: supplier.name,
      active: supplier.active,
      state: !link ? 'UNMAPPED' : (link.state as SupplierMappingRow['state']),
      externalSupplierId: link?.externalSupplierId ?? null,
      mappedName: mapped?.name ?? null,
      mappedMissing: Boolean(link?.state === 'MAPPED' && (!mapped || mapped.missingSince)),
      decisionSource: link?.decisionSource ?? null,
      decidedAt: link?.decidedAt.toISOString() ?? null,
      suggestions: link?.state === 'MAPPED' ? [] : suggestMintsoftSuppliers({ id: supplier.id, name: supplier.name, email: supplier.email, vatNumber: supplier.vatNumber, accountNumber: supplier.accountNumber }, live),
    }
  })
  const mapped = rows.filter((row) => row.state === 'MAPPED' && !row.mappedMissing).length
  const lastSyncedAt = remotes.reduce<Date | null>((latest, row) => (!latest || row.lastSeenAt > latest ? row.lastSeenAt : latest), null)
  return {
    rows,
    remote: live.map(({ externalId, name, code }) => ({ externalId, name, code })),
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    transferSupplierId,
    createEnabled: setting(MINTSOFT_SUPPLIER_CREATE_SETTING) === 'true',
    asnRequired: setting(MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING) === 'true',
    counts: { total: rows.length, mapped, unmapped: rows.filter((row) => row.state === 'UNMAPPED' || row.mappedMissing).length, pending: rows.filter((row) => row.state === 'CREATE_PENDING' || row.state === 'CREATING').length },
  }
}

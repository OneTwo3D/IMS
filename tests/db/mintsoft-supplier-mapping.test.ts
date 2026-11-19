import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * MINTSOFT SUPPLIER MAPPING against a real database (o3d-qk7z0): the migration's constraints, the read-only cache sync, every decision and its audit
 * row, the "create in Mintsoft" claim, and the ASN supplier resolution reading real rows. GATED like the other tests/db files (npm run test:db).
 * Mintsoft is never contacted: the connector is a double and the producer seam runs unenforced.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/mintsoft-supplier-mapping.test.ts would have been skipped')
}

const connector = {
  created: [] as Array<{ name: string }>,
  next: { created: true, externalId: '901' } as { created: true; externalId: string } | { created: false; held?: true; message: string } | Error,
  /** Runs while the "request" is in flight: lets a test change the row the way a second operator would. */
  during: null as null | (() => Promise<void>),
  /** The list a sync reads; `duringList` runs while the walk is "in flight" (an IMS create landing mid-walk, a second operator acting). */
  list: [] as Array<{ externalId: string; name: string; code: null; email: null; vatNumber: null; active: boolean; raw: null }>,
  duringList: null as null | (() => Promise<void>),
  async listSuppliers() {
    if (this.duringList) await this.duringList()
    return this.list
  },
  async createSupplier(input: { name: string }) {
    this.created.push({ name: input.name })
    if (this.during) await this.during()
    if (this.next instanceof Error) throw this.next
    return this.next
  },
}
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => connector } })
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })

test('mintsoft supplier mapping: constraints, cache sync, decisions, create claim, ASN resolution', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { confirmSupplierMapping, createMintsoftSupplierForImsSupplier, loadSupplierMappingScreen, resolveUnknownSupplierCreate, unmapSupplier } = await import('@/lib/connectors/mintsoft/suppliers/mapping')
  const { markUnseenMintsoftSuppliersMissing, persistMintsoftSupplierList } = await import('@/lib/connectors/mintsoft/suppliers/supplier-sync')
  const { runMintsoftSupplierSync } = await import('@/lib/connectors/mintsoft/suppliers/supplier-sync')
  const { acquirePinnedAdvisoryLockOrNull } = await import('@/lib/db/pinned-advisory-lock')
  const { WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE } = await import('@/lib/db/advisory-locks')
  const { resolveAsnSupplier } = await import('@/lib/connectors/mintsoft/suppliers/asn-supplier')

  const RUN = `MS-${process.pid}-${randomUUID().slice(0, 8)}`
  const actor = { userId: null, label: 'test operator' }
  const mk = (name: string, extra: Record<string, unknown> = {}) => db.supplier.create({ data: { name, ...extra }, select: { id: true } })
  const acme = await mk(`${RUN} Acme Plastics Ltd`)
  const zed = await mk(`${RUN} Zed Components`)
  const own = await mk(`${RUN} One Two Enterprises Ltd`)
  const ids = [acme.id, zed.id, own.id]
  const remoteIds = ['9001', '9002', '9003', '901', '902', '903']
  const settingKeys = ['mintsoft_supplier_create_enabled', 'mintsoft_asn_supplier_required', 'mintsoft_asn_send_supplier_enabled', 'mintsoft_supplier_cache_max_age_minutes', 'mintsoft_asn_supplier_cache_max_age_hours', 'mintsoft_supplier_last_sync_at', 'mintsoft_transfer_supplier_id']
  const priorSettings = await db.setting.findMany({ where: { key: { in: settingKeys } } })
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { entityId: { in: ids } } })
    await db.refusedAction.deleteMany({ where: { entityId: { startsWith: RUN } } })
    await db.purchaseOrder.deleteMany({ where: { reference: { startsWith: RUN } } })
    await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: { in: ids } } })
    await db.supplier.deleteMany({ where: { id: { in: ids } } })
    await db.mintsoftSupplier.deleteMany({ where: { externalId: { in: remoteIds } } })
    await db.setting.deleteMany({ where: { key: { in: settingKeys } } })
    if (priorSettings.length) await db.setting.createMany({ data: priorSettings.map((s) => ({ key: s.key, value: s.value })) })
  })
  const setSetting = (key: string, value: string) => db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  const link = (supplierId: string) => db.mintsoftSupplierLink.findUnique({ where: { supplierId } })
  const stampSync = (at = new Date()) => setSetting('mintsoft_supplier_last_sync_at', at.toISOString())
  const backdateAttempt = (supplierId: string) => db.mintsoftSupplierLink.update({ where: { supplierId }, data: { decidedAt: new Date(Date.now() - 3 * 60_000) } })
  const auditActions = async (supplierId: string) => (await db.activityLog.findMany({ where: { entityId: supplierId, entityType: 'SUPPLIER' }, orderBy: { createdAt: 'asc' } })).map((r) => r.action)

  await t.test('the migration: a MAPPED link needs an id, the state is constrained, a supplier delete cascades', async () => {
    await assert.rejects(db.$executeRaw`INSERT INTO mintsoft_supplier_links (id, supplier_id, state, decision_source, updated_at) VALUES (${randomUUID()}, ${acme.id}, 'MAPPED', 'X', now())`, /mapped_has_id_check/)
    await assert.rejects(db.$executeRaw`INSERT INTO mintsoft_supplier_links (id, supplier_id, state, decision_source, updated_at) VALUES (${randomUUID()}, ${acme.id}, 'BOGUS', 'X', now())`, /state_check/)
    const doomed = await mk(`${RUN} Doomed`)
    await db.mintsoftSupplierLink.create({ data: { supplierId: doomed.id, state: 'CREATE_PENDING', decisionSource: 'OPERATOR_CREATE_PENDING' } })
    await db.supplier.delete({ where: { id: doomed.id } })
    assert.equal(await db.mintsoftSupplierLink.count({ where: { supplierId: doomed.id } }), 0)
  })

  await t.test('the cache sync stores the list, marks a supplier it no longer lists as missing, and never deletes', async () => {
    const sup = (externalId: string, name: string) => ({ externalId, name, code: null, email: null, vatNumber: null, active: true, raw: { ID: Number(externalId), Name: name } })
    const first = await db.$transaction((tx) => persistMintsoftSupplierList(tx, [sup('9001', `${RUN} ACME PLASTICS LIMITED`), sup('9002', `${RUN} Zed Comp`), sup('9003', 'Gone Soon')], 'run-1', new Date()))
    assert.equal(first.created, 3)
    const second = await db.$transaction((tx) => persistMintsoftSupplierList(tx, [sup('9001', `${RUN} ACME PLASTICS LIMITED`), sup('9002', `${RUN} Zed Comp`)], 'run-2', new Date()))
    assert.equal(second.updated, 2)
    assert.ok(second.missing >= 1)
    assert.ok((await db.mintsoftSupplier.findUnique({ where: { externalId: '9003' } }))?.missingSince, 'marked missing, not deleted')
  })

  await t.test('the screen suggests the near name first and a confirm maps it with an audit row', async () => {
    const screen = await loadSupplierMappingScreen()
    const row = screen.rows.find((r) => r.supplierId === acme.id)!
    assert.equal(row.state, 'UNMAPPED')
    assert.equal(row.suggestions[0]?.externalId, '9001')
    assert.ok(!screen.remote.some((r) => r.externalId === '9003'), 'a missing supplier is not offered')
    const refused = await confirmSupplierMapping({ supplierId: acme.id, externalSupplierId: '9003', source: 'OPERATOR_PICKED', actor })
    assert.equal(refused.success, false, 'a missing Mintsoft supplier cannot be mapped')
    const ok = await confirmSupplierMapping({ supplierId: acme.id, externalSupplierId: '9001', source: 'OPERATOR_CONFIRMED_SUGGESTION', suggestionScore: row.suggestions[0]!.score, actor })
    assert.equal(ok.success, true)
    const l = await link(acme.id)
    assert.deepEqual([l?.state, l?.externalSupplierId, l?.decisionSource], ['MAPPED', '9001', 'OPERATOR_CONFIRMED_SUGGESTION'])
    assert.deepEqual(await auditActions(acme.id), ['mintsoft_supplier_mapped'])
  })

  await t.test('unmap removes the decision and is audited; unmapping nothing is a no-op', async () => {
    assert.equal((await unmapSupplier({ supplierId: acme.id, actor })).success, true)
    assert.equal(await link(acme.id), null)
    assert.deepEqual(await auditActions(acme.id), ['mintsoft_supplier_mapped', 'mintsoft_supplier_unmapped'])
    assert.equal((await unmapSupplier({ supplierId: acme.id, actor })).success, true)
    assert.equal((await auditActions(acme.id)).length, 2)
  })

  await t.test('create in Mintsoft with the setting OFF records pending and sends nothing', async () => {
    connector.created.length = 0
    await db.setting.deleteMany({ where: { key: 'mintsoft_supplier_create_enabled' } })
    const out = await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor })
    assert.equal(out.success, true)
    assert.equal(connector.created.length, 0, 'nothing was sent')
    const l = await link(own.id)
    assert.deepEqual([l?.state, l?.externalSupplierId, l?.decisionSource], ['CREATE_PENDING', null, 'OPERATOR_CREATE_PENDING'])
    assert.deepEqual(await auditActions(own.id), ['mintsoft_supplier_create_pending'])
  })

  await t.test('create with the setting ON: needs a fresh list, refuses a SIMILAR name unless confirmed with a reason, audits the claim and every outcome', async () => {
    await setSetting('mintsoft_supplier_create_enabled', 'true')
    connector.created.length = 0
    // No read has been stamped: refused before anything is sent, and the refusal is audited.
    await db.setting.deleteMany({ where: { key: 'mintsoft_supplier_last_sync_at' } })
    const stale = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(stale.success, false)
    assert.match((stale as { error: string }).error, /has not been read yet/)
    await stampSync(new Date(Date.now() - 3 * 3_600_000))
    assert.match(((await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })) as { error: string }).error, /hours? ago|minutes ago/, 'an old read is refused too (N from config)')
    assert.equal(connector.created.length, 0)
    assert.ok((await auditActions(zed.id)).includes('mintsoft_supplier_create_refused'))

    // A fresh read: "Zed Components" is not an exact fold of the cached "Zed Comp", but it is similar, so the guard refuses.
    await stampSync()
    const clash = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(clash.success, false)
    assert.ok((clash as { duplicates?: unknown[] }).duplicates?.length, 'the similar suppliers are named')
    assert.equal(connector.created.length, 0)
    assert.equal(await link(zed.id), null, 'refused before any claim')
    const noReason = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: { reason: ' x ' } })
    assert.equal(noReason.success, false)
    assert.equal(connector.created.length, 0)
    const anyway = { reason: 'Different company: Zed Components is the trading arm' }

    connector.next = { created: false, message: 'Name already taken' }
    const refused = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: anyway })
    assert.equal(refused.success, false)
    assert.equal(await link(zed.id), null, 'a clean refusal releases the claim')
    assert.deepEqual((await auditActions(zed.id)).slice(-2), ['mintsoft_supplier_create_claimed', 'mintsoft_supplier_create_declined'])
    const claimAudit = await db.activityLog.findFirst({ where: { entityId: zed.id, action: 'mintsoft_supplier_create_claimed' } })
    assert.match(JSON.stringify(claimAudit?.metadata), /Different company/, 'the create-anyway reason is in the audit')

    // UNKNOWN OUTCOME: the claim stays, Create cannot run again, and Unmap / remap are refused. Only a resolution gets out.
    connector.next = new Error('socket hang up')
    const unknown = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: anyway })
    assert.equal(unknown.success, false)
    assert.equal((await link(zed.id))?.state, 'CREATING', 'an unknown outcome keeps the claim')
    assert.ok((await auditActions(zed.id)).includes('mintsoft_supplier_create_unknown'))
    const sent = connector.created.length
    assert.equal((await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: anyway })).success, false)
    assert.equal(connector.created.length, sent, 'Create never runs again until the row is resolved')
    assert.equal((await confirmSupplierMapping({ supplierId: zed.id, externalSupplierId: '9002', source: 'OPERATOR_PICKED', actor })).success, false, 'no quiet remap')
    assert.equal((await unmapSupplier({ supplierId: zed.id, actor })).success, false, 'no unmap: that is how a live create loses its record')
    assert.equal((await link(zed.id))?.state, 'CREATING')
    await stampSync(new Date(Date.now() + 1000))
    const tooSoon = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'looked in Mintsoft, not there', outcome: { kind: 'NOT_CREATED' } })
    assert.equal(tooSoon.success, false, 'a create attempt under 2 minutes old cannot be resolved: its request may still be running')
    assert.match((tooSoon as { error: string }).error, /Wait at least 2 minutes/)
    assert.equal((await link(zed.id))?.state, 'CREATING')
    await backdateAttempt(zed.id)
    const lacks = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: '', outcome: { kind: 'NOT_CREATED' } })
    assert.equal(lacks.success, false, 'a reason is required')
    await db.setting.deleteMany({ where: { key: 'mintsoft_supplier_last_sync_at' } })
    const noRefresh = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'looked in Mintsoft, not there', outcome: { kind: 'NOT_CREATED' } })
    assert.equal(noRefresh.success, false, 'the list must have been read after the attempt')
    await stampSync()
    const notCreated = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'Searched Mintsoft by name and code: not there', outcome: { kind: 'NOT_CREATED' } })
    assert.equal(notCreated.success, true)
    assert.equal(await link(zed.id), null)
    assert.ok((await auditActions(zed.id)).includes('mintsoft_supplier_create_resolved_not_created'))
    assert.equal((await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'again, no claim now', outcome: { kind: 'NOT_CREATED' } })).success, false, 'only a CREATING row can be resolved')

    // Unknown again, this time the administrator finds it.
    connector.next = new Error('socket hang up')
    await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: anyway })
    await backdateAttempt(zed.id)
    await stampSync(new Date(Date.now() + 1000))
    const found = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'Found it by hand in Mintsoft', outcome: { kind: 'FOUND', externalSupplierId: '9002' } })
    assert.equal(found.success, true)
    const lf = await link(zed.id)
    assert.deepEqual([lf?.state, lf?.externalSupplierId, lf?.decisionSource], ['MAPPED', '9002', 'OPERATOR_RESOLVED_UNKNOWN_CREATE'])
    // Mapping a SECOND IMS supplier to the same Mintsoft supplier warns.
    const shared = await confirmSupplierMapping({ supplierId: acme.id, externalSupplierId: '9002', source: 'OPERATOR_PICKED', actor })
    assert.equal(shared.success, true)
    assert.match((shared as { warning?: string }).warning ?? '', /also mapped to/)
    assert.deepEqual((await loadSupplierMappingScreen()).rows.find((r) => r.supplierId === acme.id)!.sharedWith.length, 1)
    assert.equal((await unmapSupplier({ supplierId: acme.id, actor })).success, true)
    assert.equal((await unmapSupplier({ supplierId: zed.id, actor })).success, true)

    // THE CLAIM IS LOST DURING A LIVE CREATE (a second operator removes the row): the create is never rolled back.
    connector.next = { created: true, externalId: '902' }
    connector.during = async () => { await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: zed.id } }) }
    const lost = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: anyway })
    connector.during = null
    assert.equal(lost.success, false)
    assert.match((lost as { error: string }).error, /WAS created in Mintsoft as supplier 902/)
    assert.ok(await db.mintsoftSupplier.findUnique({ where: { externalId: '902' } }), 'the created supplier is cached')
    assert.equal(await link(zed.id), null, 'and nothing was mapped over the lost claim')
    assert.ok((await auditActions(zed.id)).includes('mintsoft_supplier_created_claim_lost'))

    // The pending choice from before is executed once the setting is on, and the cache row is honest.
    connector.next = { created: true, externalId: '901' }
    // (Every name in this file shares the run prefix, so the 55+ guard names the other suppliers: confirmed anyway.)
    const guarded = await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor })
    assert.equal(guarded.success, false, 'the 55-79 band blocks a create too')
    assert.ok((guarded as { duplicates?: unknown[] }).duplicates?.length)
    const done = await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor, createAnyway: { reason: 'Our own company, not a supplier lookalike' } })
    assert.equal(done.success, true)
    const l = await link(own.id)
    assert.deepEqual([l?.state, l?.externalSupplierId, l?.decisionSource], ['MAPPED', '901', 'OPERATOR_CREATE'])
    const cachedRow = await db.mintsoftSupplier.findUnique({ where: { externalId: '901' } })
    assert.ok(cachedRow, 'the created supplier is cached')
    assert.equal(cachedRow.lastSeenRunId, 'ims-create', 'stamped, so the next read can mark it missing')
    assert.equal(cachedRow.lastSeenAt.getTime(), 0, 'lastSeenAt is not faked: no read has seen it')
    assert.deepEqual(await auditActions(own.id), ['mintsoft_supplier_create_pending', 'mintsoft_supplier_create_refused', 'mintsoft_supplier_create_claimed', 'mintsoft_supplier_created'])
    assert.equal((await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor })).success, false, 'a mapped supplier is never created again')
    const screen = await loadSupplierMappingScreen()
    assert.ok(new Date(screen.lastSyncedAt!).getTime() > Date.now() - 60_000, 'the screen shows the real read time, not the create')
    // A read that does not list the IMS-created row marks it missing even with a NULL run id.
    await db.mintsoftSupplier.update({ where: { externalId: '901' }, data: { lastSeenRunId: null } })
    const sweep = await db.$transaction((tx) => markUnseenMintsoftSuppliersMissing(tx, 'run-9', new Date()))
    assert.ok(sweep >= 1)
    assert.ok((await db.mintsoftSupplier.findUnique({ where: { externalId: '901' } }))?.missingSince)
    await db.mintsoftSupplier.updateMany({ where: { externalId: { in: ['9001', '9002', '901', '902'] } }, data: { missingSince: null } })
  })

  await t.test('the producer hold: a shadowed create sends and claims nothing', async () => {
    const { PRODUCER_HOLD_ENFORCED_ENV } = await import('@/lib/security/producer-disposition-constants')
    const saved = process.env[PRODUCER_HOLD_ENFORCED_ENV]
    process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'mintsoft'
    try {
      connector.created.length = 0
      await stampSync()
      const out = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: { reason: 'Different company, checked by hand' } })
      assert.equal(out.success, false)
      assert.equal((out as { shadowed?: boolean }).shadowed, true)
      assert.equal(connector.created.length, 0)
      assert.equal(await link(zed.id), null)
    } finally {
      if (saved === undefined) delete process.env[PRODUCER_HOLD_ENFORCED_ENV]
      else process.env[PRODUCER_HOLD_ENFORCED_ENV] = saved
    }
  })

  await t.test('a create and a refresh never interleave; the sweep spares a row created mid-walk; the stamp predates the walk (o3d-ypqzi)', async () => {
    await setSetting('mintsoft_supplier_create_enabled', 'true')
    await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: { in: ids } } })
    const sup = (externalId: string, name: string) => ({ externalId, name, code: null, email: null, vatNumber: null, active: true, raw: null })
    // 1. A refresh is mid-walk (it holds the lock): a create is refused before anything is claimed or sent.
    await stampSync()
    connector.created.length = 0
    connector.next = { created: true, externalId: '903' }
    const syncLock = await acquirePinnedAdvisoryLockOrNull(0, WMS_SUPPLIER_LIST_SYNC_LOCK_NAMESPACE)
    assert.ok(syncLock, 'the sync lock was free')
    try {
      const during = await createMintsoftSupplierForImsSupplier({ supplierId: acme.id, actor })
      assert.equal(during.success, false)
      assert.match((during as { error: string }).error, /refresh or another create is running/)
      assert.equal(connector.created.length, 0, 'nothing sent')
      assert.equal(await link(acme.id), null, 'nothing claimed')
    } finally {
      await syncLock.release()
    }
    // 2. A create is in flight (the PUT is running): a refresh is refused and never reads Mintsoft, and a second create is refused too.
    let refreshWhileCreating: unknown = null
    let secondCreate: unknown = null
    connector.during = async () => {
      refreshWhileCreating = await runMintsoftSupplierSync({ triggeredBy: 't' }).then(() => 'ran', (error: Error) => error.message)
      secondCreate = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor, createAnyway: { reason: 'a different company entirely' } })
    }
    const created = await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor, createAnyway: { reason: 'a different company entirely' } })
    connector.during = null
    assert.equal(created.success, true)
    assert.match(String(refreshWhileCreating), /already running/)
    assert.equal((secondCreate as { success: boolean }).success, false, 'two creates are serialised')
    assert.equal(connector.created.length, 1, 'only the first create was sent')
    assert.equal(await link(zed.id), null)
    await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: { in: ids } } })
    await db.mintsoftSupplier.deleteMany({ where: { externalId: '903' } })

    // 3. The sweep itself: a row inserted at or after the walk started is spared; an older unseen row is not.
    const walkStart = new Date()
    await db.mintsoftSupplier.create({ data: { externalId: '903', name: `${RUN} mid-walk`, lastSeenRunId: 'ims-create', lastSeenAt: new Date(0), createdAt: new Date(walkStart.getTime() + 5) } })
    await db.mintsoftSupplier.updateMany({ where: { externalId: { in: ['9001', '9002'] } }, data: { lastSeenRunId: 'old-run', missingSince: null } })
    const swept = await db.$transaction((tx) => markUnseenMintsoftSuppliersMissing(tx, 'run-new', new Date(walkStart.getTime() + 10), walkStart))
    assert.ok(swept >= 2, 'older unseen rows are marked missing')
    assert.equal((await db.mintsoftSupplier.findUnique({ where: { externalId: '903' } }))?.missingSince, null, 'the row created mid-walk is not marked missing')
    assert.ok((await db.mintsoftSupplier.findUnique({ where: { externalId: '9001' } }))?.missingSince)
    await db.mintsoftSupplier.updateMany({ where: { externalId: { in: ['9001', '9002'] } }, data: { missingSince: null } })

    // 4. End to end: an IMS create lands while the walk is running, and the attempt is made during the walk. The new row survives, and the stamp is
    //    NOT newer than the attempt, so "resolve unknown" still demands a later read.
    connector.list = [sup('9001', `${RUN} ACME PLASTICS LIMITED`), sup('9002', `${RUN} Zed Comp`)]
    await db.mintsoftSupplier.deleteMany({ where: { externalId: '903' } })
    let attemptAt = new Date(0)
    connector.duringList = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await db.mintsoftSupplier.create({ data: { externalId: '903', name: `${RUN} created mid-walk`, lastSeenRunId: 'ims-create', lastSeenAt: new Date(0) } })
      attemptAt = new Date()
      await db.mintsoftSupplierLink.create({ data: { supplierId: zed.id, state: 'CREATING', decisionSource: 'OPERATOR_CREATE', decidedAt: attemptAt } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await db.setting.deleteMany({ where: { key: 'mintsoft_supplier_last_sync_at' } })
    await runMintsoftSupplierSync({ triggeredBy: 't' })
    connector.duringList = null
    assert.equal((await db.mintsoftSupplier.findUnique({ where: { externalId: '903' } }))?.missingSince, null, 'a supplier created during the refresh is not marked missing')
    const stamp = (await db.setting.findUnique({ where: { key: 'mintsoft_supplier_last_sync_at' } }))!.value
    assert.ok(new Date(stamp).getTime() < attemptAt.getTime(), 'the list-last-read stamp predates the walk, so it is older than an attempt made during it')
    // The rule consumes exactly that comparison: an attempt older than the wait but newer than the last read is refused.
    const attempt = new Date(Date.now() - 3 * 60_000)
    await db.mintsoftSupplierLink.update({ where: { supplierId: zed.id }, data: { decidedAt: attempt } })
    await stampSync(new Date(attempt.getTime() - 1000))
    const early = await resolveUnknownSupplierCreate({ supplierId: zed.id, actor, reason: 'looked in Mintsoft, not there', outcome: { kind: 'NOT_CREATED' } })
    assert.equal(early.success, false)
    assert.match((early as { error: string }).error, /Refresh the Mintsoft supplier list first/)
    await db.mintsoftSupplierLink.deleteMany({ where: { supplierId: zed.id } })
    await db.mintsoftSupplier.updateMany({ where: { externalId: { in: ['9001', '9002', '901', '902', '903'] } }, data: { missingSince: null } })
  })

  await t.test('ASN supplier resolution reads the real rows: mapped sends, unmapped is refused only when required, and a mapping closes the task', async () => {
    await stampSync()
    const po = await db.purchaseOrder.create({ data: { reference: `${RUN}-PO`, supplierId: acme.id, currency: 'GBP', fxRateToBase: 1, subtotalForeign: 0, subtotalBase: 0, totalForeign: 0, totalBase: 0 }, select: { id: true } })
    await db.setting.deleteMany({ where: { key: 'mintsoft_asn_supplier_required' } })
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id }), { kind: 'none' })
    await setSetting('mintsoft_asn_send_supplier_enabled', 'true')
    await setSetting('mintsoft_asn_supplier_required', 'true')
    const refused = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(refused.kind, 'refuse')
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER', resolvedAt: null } }), 1)
    await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER' } }), 1, 'a repeat is the same task')
    await confirmSupplierMapping({ supplierId: acme.id, externalSupplierId: '9001', source: 'OPERATOR_PICKED', actor })
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER', resolvedAt: null } }), 0, 'mapping the supplier closes the task')
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id }), { kind: 'send', externalSupplierId: '9001', supplierName: `${RUN} Acme Plastics Ltd` })
    // A Mintsoft supplier that went inactive, or is absent from the latest read, is never sent: refused with a task.
    await db.mintsoftSupplier.update({ where: { externalId: '9001' }, data: { active: false } })
    const inactive = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(inactive.kind, 'refuse')
    assert.match((inactive as { error: string }).error, /inactive in Mintsoft/)
    assert.equal((await confirmSupplierMapping({ supplierId: zed.id, externalSupplierId: '9001', source: 'OPERATOR_PICKED', actor })).success, false, 'an inactive supplier cannot be mapped')
    const screenInactive = await loadSupplierMappingScreen()
    assert.ok(!screenInactive.remote.some((r) => r.externalId === '9001'), 'an inactive supplier is not offered')
    assert.ok(screenInactive.rows.find((r) => r.supplierId === acme.id)!.mappedInactive)
    await db.mintsoftSupplier.update({ where: { externalId: '9001' }, data: { active: true, missingSince: new Date() } })
    assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })).kind, 'refuse')
    await db.mintsoftSupplier.update({ where: { externalId: '9001' }, data: { missingSince: null } })
    // A list last read long ago cannot vouch for the supplier: refused with a task, until a refresh.
    await stampSync(new Date(Date.now() - 25 * 3_600_000))
    const staleRead = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(staleRead.kind, 'refuse')
    assert.match((staleRead as { error: string }).error, /not been read recently enough/)
    await stampSync()
    assert.equal((await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })).kind, 'send')
    // With the send switch OFF the mapped supplier is not sent at all.
    await db.setting.deleteMany({ where: { key: 'mintsoft_asn_supplier_required' } })
    await setSetting('mintsoft_asn_send_supplier_enabled', 'false')
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id }), { kind: 'none' })
    await setSetting('mintsoft_asn_send_supplier_enabled', 'true')
    await setSetting('mintsoft_transfer_supplier_id', own.id)
    assert.equal((await confirmSupplierMapping({ supplierId: own.id, externalSupplierId: '901', source: 'OPERATOR_PICKED', actor })).success, true)
    const transfer = await resolveAsnSupplier({ kind: 'Transfer', id: 'no-such-transfer' })
    assert.deepEqual(transfer, { kind: 'send', externalSupplierId: '901', supplierName: `${RUN} One Two Enterprises Ltd` })
  })
})

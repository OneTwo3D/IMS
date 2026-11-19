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
  async createSupplier(input: { name: string }) {
    this.created.push({ name: input.name })
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
  const { confirmSupplierMapping, createMintsoftSupplierForImsSupplier, loadSupplierMappingScreen, unmapSupplier } = await import('@/lib/connectors/mintsoft/suppliers/mapping')
  const { persistMintsoftSupplierList } = await import('@/lib/connectors/mintsoft/suppliers/supplier-sync')
  const { resolveAsnSupplier } = await import('@/lib/connectors/mintsoft/suppliers/asn-supplier')

  const RUN = `MS-${process.pid}-${randomUUID().slice(0, 8)}`
  const actor = { userId: null, label: 'test operator' }
  const mk = (name: string, extra: Record<string, unknown> = {}) => db.supplier.create({ data: { name, ...extra }, select: { id: true } })
  const acme = await mk(`${RUN} Acme Plastics Ltd`)
  const zed = await mk(`${RUN} Zed Components`)
  const own = await mk(`${RUN} One Two Enterprises Ltd`)
  const ids = [acme.id, zed.id, own.id]
  const remoteIds = ['9001', '9002', '9003', '901']
  const settingKeys = ['mintsoft_supplier_create_enabled', 'mintsoft_asn_supplier_required', 'mintsoft_transfer_supplier_id']
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

  await t.test('create with the setting ON: refuses a name Mintsoft already has, claims before sending, maps on success, keeps the claim when the outcome is unknown', async () => {
    await setSetting('mintsoft_supplier_create_enabled', 'true')
    connector.created.length = 0
    // zed's normalised name is not an exact match of "Zed Comp", so the clash guard does not fire; acme's would.
    await db.mintsoftSupplier.update({ where: { externalId: '9002' }, data: { name: `${RUN} Zed Components Limited` } })
    const clash = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(clash.success, false)
    assert.match((clash as { error: string }).error, /Map it instead/)
    assert.equal(connector.created.length, 0)
    await db.mintsoftSupplier.update({ where: { externalId: '9002' }, data: { name: `${RUN} Zed Comp` } })

    connector.next = { created: false, message: 'Name already taken' }
    const refused = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(refused.success, false)
    assert.equal(await link(zed.id), null, 'a clean refusal releases the claim')

    connector.next = new Error('socket hang up')
    const unknown = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(unknown.success, false)
    assert.equal((await link(zed.id))?.state, 'CREATING', 'an unknown outcome keeps the claim')
    const again = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
    assert.equal(again.success, false)
    assert.equal(connector.created.length, 2, 'the second click sent nothing')
    assert.equal((await confirmSupplierMapping({ supplierId: zed.id, externalSupplierId: '9002', source: 'OPERATOR_PICKED', actor })).success, false, 'an interrupted create blocks a quiet remap')
    assert.equal((await unmapSupplier({ supplierId: zed.id, actor })).success, true)

    // The pending choice from before is executed once the setting is on.
    connector.next = { created: true, externalId: '901' }
    const done = await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor })
    assert.equal(done.success, true)
    const l = await link(own.id)
    assert.deepEqual([l?.state, l?.externalSupplierId, l?.decisionSource], ['MAPPED', '901', 'OPERATOR_CREATE'])
    assert.ok(await db.mintsoftSupplier.findUnique({ where: { externalId: '901' } }), 'the created supplier is cached')
    assert.deepEqual(await auditActions(own.id), ['mintsoft_supplier_create_pending', 'mintsoft_supplier_created'])
    assert.equal((await createMintsoftSupplierForImsSupplier({ supplierId: own.id, actor })).success, false, 'a mapped supplier is never created again')
  })

  await t.test('the producer hold: a shadowed create sends and claims nothing', async () => {
    const { PRODUCER_HOLD_ENFORCED_ENV } = await import('@/lib/security/producer-disposition-constants')
    const saved = process.env[PRODUCER_HOLD_ENFORCED_ENV]
    process.env[PRODUCER_HOLD_ENFORCED_ENV] = 'mintsoft'
    try {
      connector.created.length = 0
      const out = await createMintsoftSupplierForImsSupplier({ supplierId: zed.id, actor })
      assert.equal(out.success, false)
      assert.equal((out as { shadowed?: boolean }).shadowed, true)
      assert.equal(connector.created.length, 0)
      assert.equal(await link(zed.id), null)
    } finally {
      if (saved === undefined) delete process.env[PRODUCER_HOLD_ENFORCED_ENV]
      else process.env[PRODUCER_HOLD_ENFORCED_ENV] = saved
    }
  })

  await t.test('ASN supplier resolution reads the real rows: mapped sends, unmapped is refused only when required, and a mapping closes the task', async () => {
    const po = await db.purchaseOrder.create({ data: { reference: `${RUN}-PO`, supplierId: acme.id, currency: 'GBP', fxRateToBase: 1, subtotalForeign: 0, subtotalBase: 0, totalForeign: 0, totalBase: 0 }, select: { id: true } })
    await db.setting.deleteMany({ where: { key: 'mintsoft_asn_supplier_required' } })
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id }), { kind: 'none' })
    await setSetting('mintsoft_asn_supplier_required', 'true')
    const refused = await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(refused.kind, 'refuse')
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER', resolvedAt: null } }), 1)
    await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id })
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER' } }), 1, 'a repeat is the same task')
    await confirmSupplierMapping({ supplierId: acme.id, externalSupplierId: '9001', source: 'OPERATOR_PICKED', actor })
    assert.equal(await db.refusedAction.count({ where: { entityId: po.id, action: 'WMS_ASN_SUPPLIER', resolvedAt: null } }), 0, 'mapping the supplier closes the task')
    assert.deepEqual(await resolveAsnSupplier({ kind: 'PurchaseOrder', id: po.id }), { kind: 'send', externalSupplierId: '9001', supplierName: `${RUN} Acme Plastics Ltd` })
    await setSetting('mintsoft_transfer_supplier_id', own.id)
    const transfer = await resolveAsnSupplier({ kind: 'Transfer', id: 'no-such-transfer' })
    assert.deepEqual(transfer, { kind: 'send', externalSupplierId: '901', supplierName: `${RUN} One Two Enterprises Ltd` })
  })
})

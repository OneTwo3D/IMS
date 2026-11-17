import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

// o3d-zvec.1 part 2: courier -> AST provider mapping on the tracking item IMS writes to WooCommerce, behind
// `wc_ast_provider_mapping_enabled` (default off). The table is pinned to a fixture copied from the woo-mintsoft plugin
// (wc_mintsoft_config.py.example, MINTSOFT_COURIER_TO_AST_PROVIDER). No network: every WooCommerce call is a double.

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/wms-courier-to-ast-provider.json', import.meta.url), 'utf8')) as Record<string, string>
const SHIPPED_AT = new Date('2026-11-01T10:00:00.000Z')
const TS = String(Math.floor(SHIPPED_AT.getTime() / 1000))

type Call = { path: string; body: unknown }
const state = {
  setting: undefined as string | undefined,
  settingReads: 0,
  settingThrows: false,
  carrier: 'Royal Mail Tracked 24 [Parcel]',
  wcMeta: [] as Array<{ id: number; key: string; value: unknown }>,
  puts: [] as Call[],
  logs: [] as Array<Record<string, unknown>>,
  syncLogs: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          assert.equal(where.key, 'wc_ast_provider_mapping_enabled')
          state.settingReads++
          if (state.settingThrows) throw new Error('db down')
          return state.setting === undefined ? null : { value: state.setting }
        },
      },
      salesOrder: {
        findUnique: async () => ({
          orderNumber: 'SO-1',
          trackingNumber: null,
          shippingService: null,
          shippedAt: null,
          shoppingLinks: [{ externalOrderId: '501', externalOrderNumber: '501' }],
          shipments: [{ trackingNumber: 'TN1', shippingService: state.carrier, shippedAt: SHIPPED_AT, createdAt: SHIPPED_AT }],
        }),
      },
      shoppingSyncLog: { create: async ({ data }: { data: Record<string, unknown> }) => { state.syncLogs.push(data); return data } },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (a: Record<string, unknown>) => { state.logs.push(a) } } })
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: { meta_data: state.wcMeta }, error: null }),
    wcPut: async (path: string, body: unknown) => { state.puts.push({ path, body }); return { data: { date_modified_gmt: '2026-11-01T10:00:01' }, error: null } },
  },
})
mock.module('@/lib/connectors/woocommerce/attempt-fence', { namedExports: { assertWcAttemptMayStillSend: async () => {} } })

type Mapping = typeof import('../lib/connectors/woocommerce/sync/ast-provider-mapping.ts')
type Sync = typeof import('../lib/connectors/woocommerce/sync/tracking-sync.ts')
const unwrap = <T,>(ns: unknown): T => ('default' in (ns as object) ? (ns as { default: T }).default : (ns as T))
// Imported lazily: the module doubles above must be registered first, and test files are CJS (no top-level await).
let loaded: { mapping: Mapping; sync: Sync } | undefined
async function load() {
  loaded ??= {
    mapping: unwrap<Mapping>(await import('../lib/connectors/woocommerce/sync/ast-provider-mapping.ts')),
    sync: unwrap<Sync>(await import('../lib/connectors/woocommerce/sync/tracking-sync.ts')),
  }
  return loaded
}

function reset(over: Partial<typeof state> = {}) {
  Object.assign(state, { setting: undefined, settingReads: 0, settingThrows: false, carrier: 'Royal Mail Tracked 24 [Parcel]', wcMeta: [], puts: [], logs: [], syncLogs: [] }, over)
}
const meta = (key: string, value: unknown) => ({ id: 1, key, value })
const sentItems = () => ((state.puts[0].body as { meta_data: Array<{ value: unknown[] }> }).meta_data[0].value)

test('every plugin table entry maps identically (table-driven from the plugin fixture)', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  assert.equal(Object.keys(FIXTURE).length, 31)
  assert.deepEqual({ ...mapping.WMS_COURIER_TO_AST_PROVIDER }, FIXTURE)
  for (const [courier, slug] of Object.entries(FIXTURE)) {
    assert.deepEqual(mapping.resolveAstProvider({ courier, orderMeta: [] }), { kind: 'courier', slug }, courier)
  }
})

test('the lookup is exact like the plugin: no aliases, no case folding, no partial match', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  for (const courier of ['royal mail tracked 24 [parcel]', 'ROYAL MAIL TRACKED 24 [PARCEL]', 'Royal Mail', 'DHL', 'Local Collection', 'Palletline', '', null, undefined, 'toString', '__proto__']) {
    assert.deepEqual(mapping.resolveAstProvider({ courier, orderMeta: [] }), { kind: 'unmapped', courier: (courier ?? '').trim() }, String(courier))
  }
  // only surrounding whitespace is trimmed
  assert.equal(mapping.resolveAstProvider({ courier: '  UPS Standard ', orderMeta: [] }).kind, 'courier')
})

test('FedEx-labelled orders map to fedex, Click & Drop to royal-mail, FedEx first (the plugin order)', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  const fedex = [meta('_fedex_tracking_number', '7777')]
  assert.deepEqual(mapping.resolveAstProvider({ courier: 'Local Collection ', orderMeta: fedex }), { kind: 'fedex', slug: 'fedex' })
  assert.deepEqual(mapping.resolveAstProvider({ courier: 'x', orderMeta: [meta('_fedex_shipment_id', 'S1')] }), { kind: 'fedex', slug: 'fedex' })
  const cd = [meta('_clickdrop_label_pushed', '1')]
  assert.deepEqual(mapping.resolveAstProvider({ courier: 'Local Collection ', orderMeta: cd }), { kind: 'clickdrop', slug: 'royal-mail' })
  assert.equal(mapping.resolveAstProvider({ courier: 'UPS Standard', orderMeta: cd }).kind, 'clickdrop')
  assert.deepEqual(mapping.resolveAstProvider({ courier: 'Local Collection', orderMeta: [...cd, ...fedex] }), { kind: 'fedex', slug: 'fedex' })
  // empty / "0" flags do not brand
  assert.equal(mapping.resolveAstProvider({ courier: 'UPS Standard', orderMeta: [meta('_clickdrop_label_pushed', '0')] }).kind, 'courier')
  assert.equal(mapping.resolveAstProvider({ courier: 'Local Collection', orderMeta: [meta('_fedex_tracking_number', '')] }).kind, 'unmapped')
})

test('applyAstProvider: slug in tracking_provider, empty custom fields; unmapped leaves the item untouched', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  const item = { tracking_provider: 'UPS Standard', custom_tracking_provider: 'UPS Standard', tracking_number: 'T', date_shipped: '1' }
  assert.deepEqual(mapping.applyAstProvider(item, { kind: 'courier', slug: 'ups' }), { tracking_provider: 'ups', custom_tracking_provider: '', custom_tracking_link: '', tracking_number: 'T', date_shipped: '1' })
  assert.equal(mapping.applyAstProvider(item, { kind: 'unmapped', courier: 'X' }), item)
})

test('setting reader: only the string true is on; a read failure propagates', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  const reader = (v: string | null) => ({ setting: { findUnique: async () => (v === null ? null : { value: v }) } })
  assert.equal(await mapping.readAstProviderMappingEnabled(reader(null)), false)
  for (const v of ['', 'false', 'TRUE', '1', 'yes']) assert.equal(await mapping.readAstProviderMappingEnabled(reader(v)), false, v)
  assert.equal(await mapping.readAstProviderMappingEnabled(reader('true')), true)
  await assert.rejects(() => mapping.readAstProviderMappingEnabled({ setting: { findUnique: async () => { throw new Error('boom') } } }))
})

test('setting OFF: the WooCommerce payload is byte-identical to the pre-mapping item, whatever the order carries', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  const expected = JSON.stringify([sync.toWcTrackingItem({ trackingNumber: 'TN1', carrier: 'Royal Mail Tracked 24 [Parcel]', shippedAt: SHIPPED_AT })])
  for (const setting of [undefined, 'false', '', 'nope']) {
    reset({ setting, wcMeta: [meta('_fedex_tracking_number', '77'), meta('_clickdrop_label_pushed', '1')] })
    assert.deepEqual(await sync.pushImsTrackingToWc('o1'), { success: true })
    assert.equal(JSON.stringify(sentItems()), expected)
    assert.equal(expected, `[{"tracking_provider":"Royal Mail Tracked 24 [Parcel]","custom_tracking_provider":"Royal Mail Tracked 24 [Parcel]","tracking_number":"TN1","date_shipped":"${TS}"}]`)
    assert.equal(JSON.stringify((state.syncLogs[0].payload as { items: unknown }).items), expected)
    assert.equal(state.logs.some((l) => l.action === 'wc_tracking_provider_unmapped'), false)
  }
})

test('setting ON: a table courier writes the AST slug in the plugin shape, and the sync log records what was sent', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  reset({ setting: 'true' })
  assert.deepEqual(await sync.pushImsTrackingToWc('o1'), { success: true })
  const expected = [{ tracking_provider: 'royal-mail', custom_tracking_provider: '', custom_tracking_link: '', tracking_number: 'TN1', date_shipped: TS }]
  assert.deepEqual(sentItems(), expected)
  assert.deepEqual((state.syncLogs[0].payload as { items: unknown }).items, expected)
})

test('setting ON: FedEx-labelled and Click & Drop orders are branded whatever the courier name says', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  reset({ setting: 'true', carrier: 'Local Collection ', wcMeta: [meta('_fedex_tracking_number', '77')] })
  await sync.pushImsTrackingToWc('o1')
  assert.equal((sentItems()[0] as { tracking_provider: string }).tracking_provider, 'fedex')
  reset({ setting: 'true', carrier: 'Local Collection ', wcMeta: [meta('_clickdrop_label_pushed', 1)] })
  await sync.pushImsTrackingToWc('o1')
  assert.equal((sentItems()[0] as { tracking_provider: string }).tracking_provider, 'royal-mail')
})

test('setting ON: an unknown courier keeps today\'s item and is counted in the activity log, never guessed', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  reset({ setting: 'true', carrier: 'Acme Freight' })
  await sync.pushImsTrackingToWc('o1')
  assert.deepEqual(sentItems(), [{ tracking_provider: 'Acme Freight', custom_tracking_provider: 'Acme Freight', tracking_number: 'TN1', date_shipped: TS }])
  const log = state.logs.find((l) => l.action === 'wc_tracking_provider_unmapped')
  assert.ok(log)
  assert.deepEqual((log!.metadata as Record<string, unknown>).couriers, ['Acme Freight'])
  assert.equal((log!.metadata as Record<string, unknown>).unmappedCount, 1)
})

test('setting ON: an already-mapped item on the order is not rewritten (idempotent); an unreadable setting refuses the push', async () => {
  const { mapping, sync } = await load()
  void mapping; void sync
  reset({ setting: 'true', wcMeta: [meta('_wc_shipment_tracking_items', [{ tracking_provider: 'royal-mail', custom_tracking_provider: '', custom_tracking_link: '', tracking_number: 'TN1', date_shipped: TS }])] })
  assert.deepEqual(await sync.pushImsTrackingToWc('o1'), { success: true, skipped: true })
  assert.equal(state.puts.length, 0)
  reset({ settingThrows: true })
  const r = await sync.pushImsTrackingToWc('o1')
  assert.equal(r.success, false)
  assert.equal(state.puts.length, 0)
})

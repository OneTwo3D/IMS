import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { loadEnv } from './po-landed-fixtures'

/**
 * A BASE-CURRENCY CHANGE DECIDES WHETHER IT IS REFUSED ONLY INSIDE THE FX TABLE LOCK (app/actions/company.ts updateOrganisation).
 * Two requests change the base to the same code. The second one is held up (a pooled connection that is slow to arrive, a queue for the lock) AFTER it has read the base currency and BEFORE it
 * reads the lock marker. The first one commits in that gap and sets the marker. A check made outside the lock then finds "marker set, and the base I saw is not the target" and refuses a request
 * that, under the lock, is no change at all. The gap is forced here (the pre-lock read of the marker is parked until the first request has finished), so the failure does not depend on timing.
 * Real Postgres. Mutation: put a base / marker check back before the lock -> the second request is refused; read the in-lock state off the global client -> the lock holder asks the pool for a second
 * connection; drop the in-lock marker check -> the lock test refuses nothing.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireFreshPermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

async function waitingOnAdvisoryLock(db: { $queryRaw: <T>(q: TemplateStringsArray) => Promise<T> }): Promise<number> {
  let waiting = 0
  for (let i = 0; i < 100 && waiting === 0; i++) {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    waiting = Number(rows[0]?.n ?? 0)
    if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
  }
  return waiting
}

test('a base change that read the old base before an earlier identical change committed is not refused by the lock marker that change set', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  const { withFxTableWriteLock } = await import('@/lib/currencies/fx-table-lock')
  const realBaseCurrency = await import('@/lib/base-currency')
  // The lock marker alone decides here (the rest of the tier leaves master data behind). A pre-lock read (no client) of the FIRST caller that reaches it parks on the gate; every other read is plain.
  const gate: { armed: boolean; parked: Promise<void>; release: () => void } = { armed: false, parked: Promise.resolve(), release: () => {} }
  let signalParked: () => void = () => {}
  const markerLocked = async (client?: typeof db) => (await (client ?? db).setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value === 'true'
  mock.module('@/lib/base-currency', {
    namedExports: {
      ...realBaseCurrency,
      isBaseCurrencyLocked: async (client?: typeof db) => {
        if (!client && gate.armed) {
          gate.armed = false
          const released = new Promise<void>((r) => { gate.release = r })
          signalParked()
          await released
        }
        return markerLocked(client)
      },
    },
  })
  const { updateOrganisation } = await import('@/app/actions/company')

  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const gbpExisted = (await db.currency.count({ where: { code: 'GBP' } })) > 0
  const aud = await db.currency.findUnique({ where: { code: 'AUD' } })
  t.after(async () => {
    gate.release()
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    if (!gbpExisted) await db.currency.deleteMany({ where: { code: 'GBP' } })
    if (aud) await db.currency.update({ where: { code: 'AUD' }, data: { active: aud.active } })
    else await db.currency.deleteMany({ where: { code: 'AUD' } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })

  // PRECONDITION: base GBP, unlocked, FX source not Aelia
  await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  await db.currency.upsert({ where: { code: 'GBP' }, update: {}, create: { code: 'GBP', name: 'GBP', symbol: 'GBP', active: true } })
  await db.currency.upsert({ where: { code: 'AUD' }, update: { active: false }, create: { code: 'AUD', name: 'AUD', symbol: 'AUD', active: false } })

  gate.parked = new Promise<void>((r) => { signalParked = r })
  gate.armed = true
  let releaseHolder: () => void = () => {}
  const holderGate = new Promise<void>((r) => { releaseHolder = r })
  let holderIn: () => void = () => {}
  const holderEntered = new Promise<void>((r) => { holderIn = r })
  const holder = withFxTableWriteLock(async () => { holderIn(); await holderGate })
  await holderEntered

  // The second request (B) starts first, while the lock is held. With a pre-lock check it reads the base (GBP) and parks before it reads the marker; without one it queues for the lock.
  const second = updateOrganisation({ baseCurrency: 'aud ' })
  const parkedOrQueued = await Promise.race([gate.parked.then(() => 'parked'), waitingOnAdvisoryLock(db).then((n) => (n >= 1 ? 'queued' : 'neither'))])
  assert.notEqual(parkedOrQueued, 'neither', 'PRECONDITION: the second request is parked before the lock, or queued for it')

  // The lock holder lets go; an earlier-arriving-in-effect request (A) changes the base to the same code, commits and sets the marker.
  releaseHolder()
  await holder
  const first = await updateOrganisation({ baseCurrency: 'AUD' })
  assert.deepEqual(first, { success: true })
  assert.equal((await db.setting.findUnique({ where: { key: 'base_currency_locked' } }))?.value, 'true', 'PRECONDITION: the first change set the lock marker')

  // Now the second request goes on. Under the lock the base is already AUD: no change, nothing to refuse.
  gate.release()
  assert.deepEqual(await second, { success: true }, 'the second change to the same base is not refused by the marker the first one set')
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'AUD')
})

test('under the lock a change to a DIFFERENT base is still refused once the lock marker is set, and nothing is written', SKIP, async (t) => {
  loadEnv()
  const { db } = await import('@/lib/db')
  // (company.ts is already loaded with the marker-only isBaseCurrencyLocked from the first test, whose gate is disarmed here)
  const { updateOrganisation } = await import('@/app/actions/company')
  const orgExisted = await db.organisation.findFirst({ select: { id: true, baseCurrency: true } })
  const org = orgExisted ?? await db.organisation.create({ data: { name: 'Base lock test org', baseCurrency: 'GBP' }, select: { id: true, baseCurrency: true } })
  const lockedSetting = await db.setting.findUnique({ where: { key: 'base_currency_locked' } })
  const sourceKeys = ['fx_rate_source', 'fx_rate_source_since', 'fx_rate_source_history']
  const savedSource = await db.setting.findMany({ where: { key: { in: sourceKeys } } })
  const nzdExisted = (await db.currency.count({ where: { code: 'NZD' } })) > 0
  t.after(async () => {
    if (orgExisted) await db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } })
    else await db.organisation.deleteMany({ where: { id: org.id } })
    if (!nzdExisted) await db.currency.deleteMany({ where: { code: 'NZD' } })
    await db.setting.deleteMany({ where: { key: { in: ['base_currency_locked', ...sourceKeys] } } })
    for (const s of [...savedSource, ...(lockedSetting ? [lockedSetting] : [])]) await db.setting.create({ data: { key: s.key, value: s.value } })
  })
  await db.setting.deleteMany({ where: { key: { in: sourceKeys } } })
  await db.organisation.updateMany({ data: { baseCurrency: 'GBP' } })
  await db.setting.upsert({ where: { key: 'base_currency_locked' }, create: { key: 'base_currency_locked', value: 'true' }, update: { value: 'true' } })
  const refused = await updateOrganisation({ baseCurrency: 'NZD' })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /locked after setup/)
  assert.equal((await db.organisation.findFirst({ select: { baseCurrency: true } }))?.baseCurrency, 'GBP', 'the base currency was not changed')
  assert.equal(await db.currency.count({ where: { code: 'NZD' } }), nzdExisted ? 1 : 0, 'the would-be base currency was not created')
  assert.deepEqual(await updateOrganisation({ baseCurrency: 'GBP' }), { success: true }, 'the current base is no change, so the lock does not refuse it')
})

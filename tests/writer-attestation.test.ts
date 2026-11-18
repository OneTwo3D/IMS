import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const logged: Array<{ action: string; userId?: string | null; level?: string }> = []
let logResult = true
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivityPersisted: async (entry: { action: string; userId?: string | null; level?: string }) => { logged.push(entry); return logResult },
    logActivity: async (entry: { action: string }) => { logged.push(entry as never) },
  },
})

// Loaded after the mock is installed.
const load = async () => ({
  store: await import('../lib/domain/writer-attestation/store'),
  cli: await import('../scripts/writers-attest'),
  constants: await import('../lib/security/writer-attestation-constants'),
})

type Row = { id: string; kind: string; attestedAt: Date; userId: string }
function fakeDb(throwOnRead = false) {
  const rows: Row[] = []
  return {
    rows,
    db: {
      writerAttestation: {
        create: async ({ data }: { data: { kind: string; userId: string } }) => { const row = { id: `a${rows.length + 1}`, kind: data.kind, attestedAt: new Date(`2026-12-0${rows.length + 1}T00:00:00Z`), userId: data.userId }; rows.push(row); return row },
        findFirst: async ({ where }: { where: { kind: string } }) => { if (throwOnRead) throw new Error('read failed'); return rows.filter((r) => r.kind === where.kind).sort((a, b) => b.attestedAt.getTime() - a.attestedAt.getTime())[0] ?? null },
      },
    },
  }
}

test('recording writes the row AND an audit-log entry; an unknown kind, a missing user and a log that cannot be written are refused or reported', async () => {
  const { store, constants } = await load()
  logged.length = 0; logResult = true
  const { db, rows } = fakeDb()
  const ok = await store.recordWriterAttestation(db as never, { kind: 'qoblex-stock-push-stopped', userId: 'user-1', note: ' stopped in Qoblex ' })
  assert.equal(ok.ok, true)
  assert.equal(rows.length, 1)
  assert.deepEqual(logged.map((l) => [l.action, l.userId]), [[constants.WRITER_ATTESTATION_ACTION, 'user-1']])
  assert.equal((await store.recordWriterAttestation(db as never, { kind: 'nope', userId: 'u' })).ok, false)
  assert.equal((await store.recordWriterAttestation(db as never, { kind: 'qoblex-xero-stopped', userId: '  ' })).ok, false)
  assert.equal(rows.length, 1, 'refusals write nothing')
  logResult = false
  const unlogged = await store.recordWriterAttestation(db as never, { kind: 'qoblex-xero-stopped', userId: 'user-1' })
  assert.equal(unlogged.ok, false)
  assert.match((unlogged as { error: string }).error, /audit-log/)
})

test('the setting guard: wc_stock_sync_enabled=true and xero_sync_enabled=true are refused without the matching attestation (MUTATION: drop the guard => red)', async () => {
  const { store } = await load()
  logResult = true
  const { db } = fakeDb()
  const off = async () => 'false'
  const stock = await store.refuseGuardedSettingWithoutAttestation({ wc_stock_sync_enabled: 'true' }, { db: db as never, currentValue: off })
  assert.match(stock ?? '', /wc_stock_sync_enabled/)
  const xero = await store.refuseGuardedSettingWithoutAttestation({ xero_sync_enabled: 'true' }, { db: db as never, currentValue: off })
  assert.match(xero ?? '', /xero_sync_enabled/)
  // Turning OFF, or a different setting, is never refused.
  assert.equal(await store.refuseGuardedSettingWithoutAttestation({ wc_stock_sync_enabled: 'false', xero_sync_enabled: 'false', wc_sync_enabled: 'true' }, { db: db as never, currentValue: off }), null)
  // The MATCHING kind is what counts: the Xero confirmation does not unlock the stock push.
  await store.recordWriterAttestation(db as never, { kind: 'qoblex-xero-stopped', userId: 'u' })
  assert.match((await store.refuseGuardedSettingWithoutAttestation({ wc_stock_sync_enabled: 'true' }, { db: db as never, currentValue: off })) ?? '', /wc_stock_sync_enabled/)
  assert.equal(await store.refuseGuardedSettingWithoutAttestation({ xero_sync_enabled: 'true' }, { db: db as never, currentValue: off }), null)
  await store.recordWriterAttestation(db as never, { kind: 'qoblex-stock-push-stopped', userId: 'u' })
  assert.equal(await store.refuseGuardedSettingWithoutAttestation({ wc_stock_sync_enabled: 'true' }, { db: db as never, currentValue: off }), null)
})

test('the guard only gates a switch-ON: a setting already on is left alone; an unreadable attestation is a refusal, not consent', async () => {
  const { store } = await load()
  logResult = true
  const { db } = fakeDb()
  assert.equal(await store.refuseGuardedSettingWithoutAttestation({ wc_stock_sync_enabled: 'true' }, { db: db as never, currentValue: async () => 'true' }), null)
  const broken = fakeDb(true)
  assert.match((await store.refuseGuardedSettingWithoutAttestation({ xero_sync_enabled: 'true' }, { db: broken.db as never, currentValue: async () => 'false' })) ?? '', /xero_sync_enabled/)
})

test('writers:attest records with --yes only, lists, and refuses bad arguments (usage 3) and failures (5)', async () => {
  const { cli } = await load()
  logged.length = 0; logResult = true
  const { db, rows } = fakeDb()
  const out: string[] = []; const err: string[] = []
  const run = (argv: string[]) => cli.runWritersAttestCli({ argv, db: db as never, stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) }, disconnect: async () => undefined })
  assert.equal(await run(['--kind', 'qoblex-xero-stopped', '--by', 'owner']), 0)
  assert.equal(rows.length, 0, 'without --yes nothing is recorded')
  assert.equal(await run(['--kind', 'qoblex-xero-stopped', '--by', 'owner', '--yes']), 0)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.userId, 'cli:owner')
  assert.equal(logged.length, 1)
  assert.equal(await run(['--list']), 0)
  assert.ok(out.some((l) => /^qoblex-xero-stopped: confirmed/.test(l)) && out.some((l) => /^qoblex-stock-push-stopped: not confirmed/.test(l)))
  for (const bad of [['--kind', 'qoblex-xero-stopped'], ['--kind', 'other', '--by', 'x'], ['--bogus'], ['--kind'], []]) assert.equal(await run(bad), 3, JSON.stringify(bad))
  logResult = false
  assert.equal(await run(['--kind', 'qoblex-xero-stopped', '--by', 'owner', '--yes']), 5)
})

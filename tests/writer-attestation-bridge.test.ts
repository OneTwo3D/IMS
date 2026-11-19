import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { sampleReport } from './ops/bridge-status-fixtures'

const logged: Array<{ action: string; userId?: string | null; level?: string; metadata?: Record<string, unknown> }> = []
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivityPersisted: async (entry: { action: string }) => { logged.push(entry); return true },
    logActivity: async (entry: { action: string }) => { logged.push(entry) },
    logActivityInTransaction: async (_tx: unknown, entry: { action: string; userId?: string | null; level?: string; metadata?: Record<string, unknown> }) => { logged.push(entry) },
  },
})

const load = async () => ({
  store: await import('../lib/domain/writer-attestation/store'),
  cli: await import('../scripts/writers-attest'),
  constants: await import('../lib/security/writer-attestation-constants'),
})

type Row = { id: string; kind: string; attestedAt: Date; userId: string; payload: unknown }
function fakeDb() {
  const rows: Row[] = []
  const tx = {
    writerAttestation: {
      create: async ({ data }: { data: { kind: string; userId: string; payload: unknown } }) => { const row = { id: `a${rows.length + 1}`, kind: data.kind, attestedAt: new Date(`2026-12-20T12:0${rows.length}:00Z`), userId: data.userId, payload: data.payload }; rows.push(row); return row },
    },
    activityLog: {},
  }
  return {
    rows,
    db: {
      writerAttestation: { findFirst: async ({ where }: { where: { kind: string } }) => rows.filter((r) => r.kind === where.kind).sort((a, b) => b.attestedAt.getTime() - a.attestedAt.getTime())[0] ?? null },
      $transaction: async <T,>(fn: (client: typeof tx) => Promise<T>): Promise<T> => fn(tx),
    },
  }
}
const NOW = new Date('2026-12-20T12:00:00Z')

test('the bridge kind is registered with a label, a statement and a report requirement', async () => {
  const { constants } = await load()
  assert.ok(constants.WRITER_ATTESTATION_KINDS.includes('bridge-units-masked'))
  assert.match(constants.WRITER_ATTESTATION_LABEL['bridge-units-masked'], /masked and inactive/)
  assert.ok(constants.WRITER_ATTESTATION_REPORT_KINDS.includes('bridge-units-masked'))
})

test('recording the bridge kind parses the pasted output, keeps the structured payload and audits who recorded it with the report facts', async () => {
  const { store } = await load()
  logged.length = 0
  const { db, rows } = fakeDb()
  const result = await store.recordWriterAttestation(db as never, { kind: 'bridge-units-masked', userId: 'user-1', output: sampleReport(), now: NOW })
  assert.equal(result.ok, true)
  assert.equal(rows.length, 1)
  const payload = rows[0]!.payload as { schema: number; host: string; lastTriggerAt: string | null; units: Record<string, { loadState: string }>; raw: string }
  assert.equal(payload.schema, 1)
  assert.equal(payload.host, 'bridge-host')
  assert.equal(payload.lastTriggerAt, '2026-11-30T23:55:01.000Z')
  assert.equal(payload.units['wc-mintsoft-webhook.service']!.loadState, 'masked')
  assert.ok(payload.raw.includes('# bridge_writers_status v1'))
  assert.equal(logged[0]!.userId, 'user-1')
  assert.equal(logged[0]!.metadata?.lastTriggerAt, '2026-11-30T23:55:01.000Z')
  // The kind needs the report; the others refuse one (MUTATION: accept a bridge confirmation without a report => red).
  assert.equal((await store.recordWriterAttestation(db as never, { kind: 'bridge-units-masked', userId: 'user-1', now: NOW })).ok, false)
  assert.equal((await store.recordWriterAttestation(db as never, { kind: 'bridge-units-masked', userId: 'user-1', output: 'all fine', now: NOW })).ok, false)
  assert.equal((await store.recordWriterAttestation(db as never, { kind: 'qoblex-xero-stopped', userId: 'user-1', output: sampleReport(), now: NOW })).ok, false)
  assert.equal(rows.length, 1, 'refusals write nothing')
  // A stale report is refused; a report that shows an UNMASKED unit is still recorded (the history keeps it; the check judges the newest).
  const stale = await store.recordWriterAttestation(db as never, { kind: 'bridge-units-masked', userId: 'user-1', output: sampleReport({ generatedAt: '2026-12-20T09:00:00Z' }), now: NOW })
  assert.equal(stale.ok, false)
  const failing = await store.recordWriterAttestation(db as never, { kind: 'bridge-units-masked', userId: 'user-1', output: sampleReport({ units: { 'wc-mintsoft-webhook.service': 'LoadState=loaded ActiveState=active UnitFileState=enabled' } }), now: NOW })
  assert.equal(failing.ok, true)
})

test('the command: without --yes it summarises and records nothing; with --yes it records; it needs --output-file for this kind and refuses it for the others', async () => {
  const { cli } = await load()
  const { db, rows } = fakeDb()
  const out: string[] = []
  const err: string[] = []
  const run = (argv: string[], report = sampleReport()) => cli.runWritersAttestCli({
    argv, db: db as never, stdout: { log: (m: string) => out.push(String(m)) }, stderr: { error: (m: string) => err.push(String(m)) }, disconnect: async () => undefined,
    readReport: () => report, now: NOW,
  })
  assert.equal(await run(['--kind', 'bridge-units-masked', '--by', 'jan', '--output-file', '-']), 0)
  assert.equal(rows.length, 0)
  assert.match(out.join('\n'), /all three units masked and inactive/)
  assert.equal(await run(['--kind', 'bridge-units-masked', '--by', 'jan', '--output-file', '-', '--yes']), 0)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.userId, 'cli:jan')
  assert.equal(await run(['--kind', 'bridge-units-masked', '--by', 'jan', '--yes']), 3, 'the report is required')
  assert.equal(await run(['--kind', 'qoblex-xero-stopped', '--by', 'jan', '--output-file', '-', '--yes']), 3, 'the other kinds take none')
  assert.equal(await run(['--kind', 'bridge-units-masked', '--by', 'jan', '--output-file', '-', '--yes'], 'garbage'), 5, 'an unparsable report is not recorded')
  assert.equal(rows.length, 1)
})

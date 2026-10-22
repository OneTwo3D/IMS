import assert from 'node:assert/strict'
import test, { afterEach, mock } from 'node:test'

import { D, fakeBasisPort, goodState, healthyLiveness } from './basis-fixtures.ts'
import { NOW, cleanup, realEvidence, scratchDir } from './helpers.ts'
import type { ImsQueryClient } from '../../lib/reconciliation-pack/ims-readers.ts'
import type { LivenessPort } from '../../lib/reconciliation-pack/run.ts'

/**
 * WITHOUT INJECTED DOUBLES the command builds the REAL ports (default-ports.ts) - the status command as a child process and a basis
 * client of its own - and runs the items through them. The module is mocked so no child is started and no database is touched; what
 * is proved is the wiring: which ports, built with what, and that a run and --basis-only both go through them.
 * [mutation: the default ports are not built / --basis-only built its own instead]
 */
const bases: string[] = []
afterEach(() => cleanup(bases))

test('with no doubles the command builds childLivenessPort (in the checkout) and ownClientBasisPort, and a run and --basis-only read through them', async () => {
  const built: { liveness: Array<{ cwd: string }>; basis: number } = { liveness: [], basis: 0 }
  let livenessReads = 0
  const live = healthyLiveness()
  const counting: LivenessPort = { read: async () => { livenessReads += 1; return live.read() } }
  const basis = fakeBasisPort(goodState())
  mock.module('@/lib/reconciliation-pack/default-ports', {
    namedExports: {
      childLivenessPort: (deps: { cwd: string }) => { built.liveness.push({ cwd: deps.cwd }); return counting },
      ownClientBasisPort: () => { built.basis += 1; return basis },
    },
  })
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const out: string[] = []
  const client: ImsQueryClient = { async query(sql) {
    if (/pg_current_snapshot/.test(sql)) return { rows: [{ snapshot: '10:20:', read_only: 'on', isolation: 'repeatable read' }] }
    if (/pg_control_system/.test(sql)) return { rows: [{ sid: '7000000000000000001', db: 'ims' }] }
    return { rows: [] }
  } }
  const dir = scratchDir(bases)
  const common = { env: { DATABASE_URL: 'postgresql://ims@127.0.0.1:1/x' }, uid: 1000, checkoutOwnerUid: 1000, repoRoot: '/var/tmp', stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t) }
  const deps = { now: () => NOW, openIms: async () => ({ client, close: async () => undefined }), runInvariant: async () => realEvidence(), disconnect: async () => undefined }

  const basisOnly = await runPackCli({ ...common, argv: ['--phase', 'P1', '--as-of', D, '--basis-only', '--report-dir', dir], deps })
  assert.equal(basisOnly, 0, out.join('\n'))
  assert.deepEqual(built, { liveness: [{ cwd: '/var/tmp' }], basis: 1 }, '--basis-only builds the same real ports, in the checkout')
  assert.equal(livenessReads, 2)

  livenessReads = 0
  const full = await runPackCli({ ...common, argv: ['--phase', 'P1', '--as-of', D, '--items', 'R3,R6', '--report-dir', dir], deps })
  assert.equal(full, 5, out.join('\n'))
  assert.ok(out.includes('R3 pass -') && out.includes('R6 pass -'), out.join('\n'))
  assert.equal(livenessReads, 2, 'the status report is read at the start and at the end')
  assert.equal(built.liveness.length, 2)
  assert.equal(built.basis, 2)
  mock.reset()
})

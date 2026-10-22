import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

/**
 * The invariant run of the command binds the application's database client (lib/db) to ONE snapshot transaction, which only works
 * if nothing imported lib/db before it (invariant-snapshot.ts). The liveness reader and the as-of basis are read before the items and
 * again after them, so the modules they, the command and the gate's pack reader are made of must not create that client when they
 * are LOADED. lib/db creates it on first import and publishes it on globalThis, so a fresh process says whether any of them did.
 *
 * [mutation: basis.ts imports the date helpers from account-balance-snapshots (which imports lib/db) again => red]
 */
test('loading the command and every pack module does not create the application\'s database client', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'tests/reconciliation-pack/no-application-client-child.ts')], {
    encoding: 'utf8' as const,
    // A database URL that cannot connect: if the client were created it would exist (creation does not connect) and be seen.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', DATABASE_URL: 'postgresql://ims@127.0.0.1:1/none', NODE_OPTIONS: '', NODE_ENV: 'test' },
    timeout: 120_000,
  })
  assert.equal(child.status, 0, String(child.stderr).slice(-400))
  const result = JSON.parse(String(child.stdout).trim().split('\n').at(-1)!) as { modules: number; applicationClient: boolean }
  assert.ok(result.modules >= 9, 'precondition: the modules were loaded')
  assert.equal(result.applicationClient, false)
})

// The rig can fail: loading the application's client does create it in the same kind of process.
test('the rig can fail: importing lib/db in a fresh process does create the application\'s client', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./lib/db/index.ts'); console.log(JSON.stringify({ c: globalThis.prisma !== undefined }))"], {
    encoding: 'utf8' as const, cwd: process.cwd(), input: '',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', DATABASE_URL: 'postgresql://ims@127.0.0.1:1/none', NODE_OPTIONS: '', NODE_ENV: 'test' },
    timeout: 120_000,
  })
  assert.equal(child.status, 0, String(child.stderr).slice(-400))
  assert.equal(JSON.parse(String(child.stdout).trim().split('\n').at(-1)!).c, true)
})

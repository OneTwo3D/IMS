/**
 * THE EXTERNAL VERIFIER, AS THE REGRESSIONS SEE IT (o3d-2sm1.5 r41).
 *
 * THE FINDING is that `pg_hba.conf` has password-dependent methods which check somebody else's
 * store rather than `pg_authid.rolpassword` -- `ldap`, `pam`, `radius`, `bsd` -- and that under
 * every one of them r40's negative control behaves EXACTLY as it does on a healthy
 * `scram-sha-256` endpoint: the random control is refused, the asserted password is accepted, and
 * the endpoint is admitted while answering about a credential no `ALTER ROLE` can reach.
 *
 * A TEST CANNOT SHOW THAT WITHOUT A REAL ONE. An external verifier that refuses everything would
 * make the old probe fail on its POSITIVE half, so a regression built on it would pass against
 * r40's code too and prove nothing. What is needed is a verifier that says YES to one password and
 * NO to another, while the ROLE's own password is a third thing entirely -- because that gap is
 * where the outage lives.
 *
 * RADIUS is the one such method every PostgreSQL build has. `ldap` and `pam` are configure-time
 * options a distribution may or may not have enabled; RADIUS is compiled in unconditionally and
 * needs no library, no directory and no system configuration -- only something answering UDP.
 *
 * This module starts that something as a CHILD PROCESS and reads its record of what it was asked
 * off a file. Both are forced by the same fact: the regressions drive the shipped shell through
 * `execFileSync`, which blocks this process's event loop for the whole of a run, so neither a
 * socket nor a pipe owned by this process can make progress while PostgreSQL is waiting on it.
 * radius-verifier.mjs says the same thing at more length.
 *
 * It is NOT a `.test.ts` file, so the runner's `tests/**\/*.test.ts` glob does not execute it.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanLibpqEnv } from './real-postgres-cluster.ts'

export interface RadiusVerifier {
  readonly port: number
  /** Every username the directory was asked about, in order -- read from the child's own file. */
  asked(): string[]
  stop(): Promise<void>
}

/**
 * A verifier that accepts exactly one password for exactly one user, and refuses everything else.
 *
 * `accepts` is deliberately NOT the role's password in the tests that use this: the whole point is
 * that the directory and the role disagree, and that the endpoint sounds completely healthy while
 * they do.
 */
export function startRadiusVerifier(
  root: string,
  secret: string,
  user: string,
  accepts: string,
): Promise<RadiusVerifier> {
  const log = join(root, 'radius-queries.log')
  writeFileSync(log, '')
  const script = join(process.cwd(), 'tests/scripts/radius-verifier.mjs')
  assert.ok(existsSync(script), `precondition: ${script} must exist`)
  const child: ChildProcess = spawn('node', [
    script,
    `--secret=${secret}`,
    `--user=${user}`,
    `--accepts=${accepts}`,
    `--log=${log}`,
  ], { env: cleanLibpqEnv(), stdio: ['ignore', 'pipe', 'pipe'] })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the RADIUS verifier did not bind in time: ${stdout}${stderr}`))
    }, 10_000)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const match = /^radius-listening (\d+)$/m.exec(stdout)
      if (match === null) return
      clearTimeout(timer)
      resolve({
        port: Number(match[1]),
        asked() {
          return readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0)
        },
        stop() {
          return new Promise<void>((done) => {
            if (child.exitCode !== null || child.signalCode !== null) { done(); return }
            child.once('exit', () => done())
            child.kill('SIGKILL')
          })
        },
      })
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the RADIUS verifier exited (${code}) before it bound: ${stdout}${stderr}`))
    })
  })
}

/**
 * The pg_hba record that points ONE database at that verifier, and leaves the rest alone.
 *
 * `connection` is a parameter since r42 (Codex HIGH), because the finding that round is about the
 * TRANSPORT a record is matched on: `hostnossl` puts the directory on the cleartext route ONLY,
 * underneath a `hostssl` record that checks the role's own credential, which is the configuration
 * where a reader reporting `scram-sha-256` and a probe answered by a directory are both telling
 * the truth about different connections. `host` — the default — matches either transport.
 */
export function radiusHbaLine(
  database: string,
  port: number,
  secret: string,
  connection: 'host' | 'hostssl' | 'hostnossl' = 'host',
): string {
  return `${connection} ${database} all 127.0.0.1/32 radius radiusservers="127.0.0.1" radiusports="${port}" radiussecrets="${secret}"`
}

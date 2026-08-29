/**
 * REAL POSTGRESQL CLUSTERS FOR THE INSTALLER REGRESSIONS (o3d-2sm1.5).
 *
 * Extracted from tests/scripts/install-database-endpoint-binding.test.ts in r38, unchanged, so
 * that the credential-preservation regressions bring up their clusters the same way rather than
 * carrying a second copy of the same 120 lines. It is NOT a `.test.ts` file, so the runner's
 * `tests/**\/*.test.ts` glob does not execute it on its own.
 *
 * WHY REAL CLUSTERS. Every finding these files answer is about what a SERVER does — which one a
 * connection lands on, whether a password still authenticates. A fake psql would test whether the
 * author models libpq correctly, which is the thing the findings say was modelled wrongly.
 *
 * The clusters are created by initdb into a throwaway directory, listen on loopback ports nothing
 * else holds, and are stopped and deleted by their callers' finally blocks. Nothing here touches
 * this machine's own cluster: every connection states its socket directory or its host, and its
 * port. These helpers THROW rather than skip when no PostgreSQL server binaries are present — a
 * guard that quietly does nothing on the machine that runs it is the defect this branch keeps
 * shipping, one layer down.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

/** One shipped shell function, lifted whole, so the tests run the real bytes and not a copy. */
export function shippedFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {\n`)
  assert.notEqual(start, -1, `precondition: scripts/install.sh must define ${name}()`)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1, `precondition: ${name}() must end at a } in column 0`)
  return source.slice(start + 1, end + 3)
}

/** The server binaries, wherever this distribution keeps them. */
export function pgBinDir(): string {
  const candidates = execFileSync('bash', [
    '-c',
    'ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1; command -v initdb 2>/dev/null | xargs -r dirname',
  ], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) return dir
  }
  throw new Error(
    'no PostgreSQL server binaries (initdb, pg_ctl) were found. These tests bring up real clusters ' +
      'on purpose — a fake psql would only test this file\'s model of libpq. Install the postgresql ' +
      'server package (Debian: apt-get install postgresql) and re-run.',
  )
}

/** A loopback port nothing currently holds. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

export interface Cluster {
  readonly name: string
  readonly data: string
  readonly socket: string
  readonly port: number
  psql(args: string[], options?: { host?: string; password?: string; user?: string; database?: string }): string
  stop(): void
}

/** The OS account the tests run as, which is also the cluster's superuser. */
export function currentUser(): string {
  return execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
}

/** An environment with every libpq variable removed, so no test inherits a connection. */
export function cleanLibpqEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(PG|PSQL)/.test(key)) delete env[key]
  return env
}

/**
 * A cluster of our own: its own data directory, its own socket directory, its own port.
 *
 * `listen` is a parameter because one test needs TWO clusters on the SAME port — which is only
 * possible if at most one of them binds TCP. That pair is what makes the identity comparison
 * reachable at all: the port alone cannot tell them apart.
 *
 * `hbaHostLines` is a parameter for the same class of reason (r40, Codex HIGH): the finding is
 * that the installer's password probe is only valid under SOME pg_hba configurations, and the
 * only honest way to test that is to BUILD the other ones. Lines given here are prepended to the
 * generated pg_hba.conf, so they win over the `--auth-host` default below — which is how a
 * `trust` rule on one database and scram on the rest is expressed.
 */
export interface ClusterOptions {
  /**
   * Generate a self-signed certificate and start with `ssl = on` (r41).
   *
   * Debian's packaged cluster ships `ssl = on`, and libpq's default `sslmode=prefer` therefore
   * negotiates TLS on every ordinary install this script performs -- while an `initdb` cluster
   * ships `ssl = off` and never does. A regression suite that only ever runs the second one leaves
   * the transport the real installations use completely unmeasured, and the pg_hba record matched
   * over TLS is a DIFFERENT record from the one matched in the clear wherever `hostssl` and
   * `hostnossl` are both present.
   */
  readonly ssl?: boolean
}

export function startCluster(
  root: string,
  name: string,
  port: number,
  listen: string,
  hbaHostLines: string[] = [],
  options: ClusterOptions = {},
): Cluster {
  const bin = pgBinDir()
  const data = join(root, name, 'data')
  const socket = join(root, name, 'sock')
  mkdirSync(socket, { recursive: true })
  execFileSync(join(bin, 'initdb'), [
    '-D', data,
    '--auth-local=trust',
    '--auth-host=scram-sha-256',
    '-E', 'UTF8',
    '--no-sync',
    '-N',
  ], { stdio: 'pipe' })
  if (hbaHostLines.length > 0) {
    const hba = join(data, 'pg_hba.conf')
    // FIRST, because PostgreSQL takes the FIRST matching record and stops. Appending would be a
    // test that silently measures the default.
    writeFileSync(hba, `${hbaHostLines.join('\n')}\n${readFileSync(hba, 'utf8')}`)
  }
  if (options.ssl === true) {
    // The default ssl_cert_file/ssl_key_file are `server.crt`/`server.key` in the data directory,
    // so naming them is enough; the key must be 0600 or the postmaster refuses to start.
    // SUBJECT ALTERNATIVE NAMES, so the certificate can be VERIFIED and not merely negotiated
    // (o3d-2sm1.5 r45). Without them a `verify-full` client -- the application's driver, libpq and
    // this suite's reader alike -- rejects the connection on the hostname even when the chain is
    // trusted, and a test for TLS-only external databases could then only ever exercise the mode
    // that verifies nothing. The certificate is its own CA, so `sslrootcert=server.crt` is a
    // complete trust root for it.
    execFileSync('openssl', [
      'req', '-new', '-x509', '-days', '2', '-nodes',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', join(data, 'server.key'),
      '-out', join(data, 'server.crt'),
    ], { stdio: 'pipe' })
    chmodSync(join(data, 'server.key'), 0o600)
    writeFileSync(join(data, 'postgresql.conf'), `${readFileSync(join(data, 'postgresql.conf'), 'utf8')}\nssl = on\n`)
  }
  execFileSync(join(bin, 'pg_ctl'), [
    '-D', data,
    '-l', join(root, name, 'pg.log'),
    '-o', `-p ${port} -k ${socket} -c listen_addresses=${listen}`,
    '-w', 'start',
  ], { stdio: 'pipe' })

  return {
    name,
    data,
    socket,
    port,
    psql(args, options = {}) {
      const env = cleanLibpqEnv()
      if (options.password !== undefined) env.PGPASSWORD = options.password
      return execFileSync('psql', [
        '-X', '-w', '-q', '-tA', '-v', 'ON_ERROR_STOP=1',
        '-h', options.host ?? socket,
        '-p', String(port),
        '-U', options.user ?? currentUser(),
        '-d', options.database ?? 'postgres',
        ...args,
      ], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    },
    stop() {
      try {
        execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' })
      } catch {
        // A cluster that never came up, or one already gone; the directory removal below is what
        // actually matters and it happens either way.
      }
    },
  }
}

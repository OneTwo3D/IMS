'use strict'
/**
 * NO TEST MAY OPEN A NETWORK CONNECTION TO ANYTHING BUT THIS MACHINE (o3d-bhvu rounds 2 and 3).
 *
 * WHY. Several integrations this repository talks to are LIVE: Mintsoft (ClientId 89) fulfils whatever it
 * is sent, and the review of o3d-bhvu found a unit test that, after a merge, drove an ASN creator with the
 * real Mintsoft list reader unstubbed and `@/lib/security/connector-fetch` unmocked. With working database
 * credentials and stored Mintsoft settings that test would have issued GETs to the live tenant. A mock
 * that a test forgets is silent; this is not.
 *
 * WHY THIS FILE IS CommonJS, and the only file here that is (round 3). The trap has to install itself in
 * three kinds of process, and only a `.cjs` file can be loaded by all three ways of asking:
 * `--import` (this process and every Node child), `--require` (a worker thread, where `--import` is
 * accepted and then SILENTLY IGNORED — measured on Node 22.23), and `require()` from a child that is not
 * running under `tsx`. Written as TypeScript it would need `tsx` in every child as well, resolved from
 * whatever working directory that child happens to have; written as ESM it would need Node's
 * `require(esm)`, which is only unflagged from 22.12 while `package.json` allows 22.11. The cost is that
 * `tsc` does not type-check this file (tsconfig's include list covers .ts, .tsx and .mts only), so
 * keep it small, dependency-free and covered by tests/no-outbound-network.test.ts.
 *
 * ── WHAT IS COVERED ──────────────────────────────────────────────────────────────────────────────────
 *
 * 1. THIS PROCESS. `net.Socket.prototype.connect` is wrapped — the one place every TCP and TLS client in
 *    Node ends up: `http`/`https` requests (which is what `connectorFetch` uses), `fetch` (undici),
 *    `tls.connect`, `http2`, WebSocket, and database drivers alike. A Unix socket proceeds. An IP LITERAL
 *    proceeds only if it is loopback (127.0.0.0/8, ::1, ::ffff:127.x). A NAME — including `localhost` and
 *    `*.localhost`, which round 2 waved through unresolved (review L-c) — is resolved first, through the
 *    caller's own `lookup` where it has one so that connectorFetch's SSRF refusals still surface as
 *    themselves, and is refused if it resolves to any address that is not loopback. The refusal is an
 *    `OutboundNetworkBlockedError` naming the host and port, raised before the socket connects.
 * 2. A NODE CHILD PROCESS. `--require <this file>` is appended to `process.env.NODE_OPTIONS`, so every
 *    child that inherits the environment installs the trap in itself, and `node:child_process` is wrapped
 *    so that a child launched with a REPLACEMENT environment (`{ PATH: … }`) or with `NODE_OPTIONS`
 *    cleared gets it too. That covers the two places the suite spawns a Node child that runs connector
 *    code: tests/accounting/xero-unrecorded-remote-write.test.ts and
 *    tests/concurrency/email-outbox-claim-fence.concurrent.test.ts.
 * 3. A WORKER THREAD. `worker_threads.Worker` is wrapped to pass `--require <this file>` in the worker's
 *    `execArgv`. A worker is a fresh realm with its own `net` module, so the parent's patch does not reach
 *    it; `--import` in `execArgv` is ignored, `--require` is not.
 * 4. A CHILD THAT IS A KNOWN NETWORK CLIENT. Spawning `curl`, `wget`, `nc`, `telnet`, `ssh`, `rsync` and
 *    the like, or `git fetch`/`pull`/`push`/`clone`/`ls-remote`, is REFUSED at the spawn boundary before
 *    the process exists, because nothing can be installed inside a binary that is not Node.
 *
 * ── WHAT IS NOT COVERED, PLAINLY (review M-a) ────────────────────────────────────────────────────────
 *
 * * A NON-NODE CHILD THAT IS NOT ON THAT LIST. `psql -h <remote>`, a shell program that reaches the
 *   network by any other means (`bash -c 'exec 3<>/dev/tcp/…'`), or a binary the list does not name, is
 *   not stopped. This is the honest residual: the trap is a per-process patch, and a process that is not
 *   Node cannot be patched. The list is a denylist of the tools that would actually be reached for, not a
 *   proof.
 * * A NODE CHILD WHOSE ENVIRONMENT IS REBUILT BY SOMETHING OTHER THAN `node:child_process` — a shell that
 *   unsets `NODE_OPTIONS` before exec'ing Node, which is exactly what the negative control in
 *   tests/no-outbound-network.test.ts does to prove the rest of this is not vacuous.
 * * A WORKER STARTED FROM A TRUE-ESM MODULE THAT DESTRUCTURES THE CONSTRUCTOR, i.e. a `.mjs` doing
 *   `import { Worker } from 'node:worker_threads'` while running under `tsx`. MEASURED, not guessed: a
 *   builtin's ESM facade snapshots its named exports when it is first imported, `tsx` imports
 *   `node:worker_threads` for its own hook thread BEFORE any `--import` preload runs, so that snapshot is
 *   the unguarded constructor — `import { Worker }` and `require('node:worker_threads').Worker` are then
 *   different objects. Every test file here is TypeScript that `tsx` transpiles to CommonJS, so the suite
 *   reads through the patched module object (the test asserts exactly that, by marker); `node:child_process`
 *   has no such facade yet when this loads, so its named imports ARE patched (also measured). A `.mjs`
 *   that wants a guarded worker must pass `execArgv: ['--require', <this file>]` itself.
 * * UDP and raw `dgram`. DNS lookups still resolve: a lookup sends a name, not our data.
 * * Any test run that does not load this file: `npm run test:unit`, `npm run test:concurrency` and
 *   `npm run test:db` do; a focused `npx tsx --test …` does not unless you add the `--import` yourself.
 * * A REFUSED IP LITERAL IS DESTROYED ON THE NEXT TICK rather than synchronously, so the socket is
 *   returned before it errors and `http2.connect()` emits one spurious `'connect'` on its session before
 *   the error arrives (review L-d). Nothing is sent — the real `connect` is never called — but a test that
 *   waits for `'connect'` and nothing else can see a connection that did not happen. Throwing
 *   synchronously instead would break every caller that handles `'error'`, which is all of them.
 */
const dns = require('node:dns')
const net = require('node:net')
const path = require('node:path')

const TRAP = Symbol.for('ims.tests.noOutboundNetwork')
const SELF = __filename

/** `--require <this file>`, quoted for NODE_OPTIONS only if the repository path needs it. */
const REQUIRE_FLAG = '--require ' + (/\s/.test(SELF) ? '"' + SELF + '"' : SELF)

/**
 * Binaries that exist to move bytes to another host. A child that is not Node cannot be given the trap,
 * so the only thing left is to refuse to start it. Deliberately a denylist: an allowlist would have to
 * name `bash`, `psql`, `openssl`, `git`, `systemctl`, `busctl`, `crontab` and a dozen more that this
 * suite really does spawn, and `bash` alone makes an allowlist no stronger than this.
 */
const NETWORK_CLIENTS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'aria2c', 'httpie', 'http', 'https',
  'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'lftp', 'links', 'lynx', 'w3m', 'wsdump',
])

/** `git` is local in this suite (`ls-files`, `rev-parse`); these subcommands are not. */
const GIT_NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule'])

function isLoopbackHost(host) {
  if (host == null || host === '') return true // Node defaults an omitted host to localhost
  const value = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  return false
}

function isIpLiteral(host) {
  return net.isIP(String(host).replace(/^\[|\]$/g, '')) !== 0
}

function blockedError(host, port, resolved) {
  const error = new Error(
    'Blocked outbound network connection to ' + host + ':' + port + (resolved ? ' (resolved to ' + resolved + ')' : '') + ' '
    + 'from a test process (tests/no-outbound-network.cjs). Unit and concurrency tests must stub the HTTP '
    + 'boundary; several integrations this repository calls are LIVE.',
  )
  error.name = 'OutboundNetworkBlockedError'
  return error
}

function blockedSpawn(command, detail) {
  const error = new Error(
    `Blocked spawning ${command} from a test process (tests/no-outbound-network.cjs): ${detail}. A child `
    + 'that is not Node cannot be given the outbound-network trap, so it is refused instead. Stub the '
    + 'boundary in-process; several integrations this repository calls are LIVE.',
  )
  error.name = 'OutboundNetworkBlockedError'
  return error
}

// ---------------------------------------------------------------------------
// 1. THIS PROCESS
// ---------------------------------------------------------------------------

function targetOf(args) {
  const first = args[0]
  if (Array.isArray(first)) return targetOf(first) // net's internal normalized [options, cb] form
  if (first && typeof first === 'object') return first
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first }
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined }
}

/**
 * A HOSTNAME IS DECIDED AFTER IT RESOLVES, NOT BEFORE. Some callers resolve through their own `lookup`
 * and refuse addresses there — connectorFetch's SSRF guard rejects private and metadata addresses inside
 * its lookup, and its tests assert on that rejection. So the name's own lookup (the caller's, or DNS)
 * runs first and its error, if any, passes through unchanged; only an address it RESOLVES TO that is not
 * loopback is refused here, before the socket connects to it.
 *
 * `localhost` GOES THROUGH HERE TOO (review L-c). Round 2 treated the NAME `localhost` as loopback
 * without resolving it, so a caller that supplied a lookup mapping it to a routable address connected.
 * There is no reason to trust the name: the address is what the socket uses, and that is what is checked.
 */
function guardedLookup(original, host, port) {
  const resolve = original ?? ((hostname, options, callback) => {
    dns.lookup(hostname, options ?? {}, callback)
  })
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family)
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [String(address)]
      const remote = addresses.find((entry) => !isLoopbackHost(entry))
      if (remote) return callback(blockedError(host, port, remote))
      return callback(null, address, family)
    })
  }
}

function installSocketTrap() {
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function trappedConnect(...args) {
    const target = targetOf(args)
    if (target.path || target.host == null || target.host === '') {
      return original.apply(this, args)
    }
    if (isIpLiteral(target.host)) {
      if (isLoopbackHost(target.host)) return original.apply(this, args)
      const error = blockedError(target.host, target.port)
      process.nextTick(() => this.destroy(error))
      return this
    }
    // A name: let it resolve, then refuse any non-loopback address it resolves to.
    const options = { ...target }
    options.lookup = guardedLookup(options.lookup, String(target.host), target.port)
    if (Array.isArray(args[0])) {
      // net's internal normalized form carries a private marker symbol on the ARRAY; replace the options
      // in place so the marker survives and the call is not re-normalized.
      args[0][0] = options
      return original.apply(this, args)
    }
    const callback = args.find((arg) => typeof arg === 'function')
    return original.apply(this, callback ? [options, callback] : [options])
  }
}

// ---------------------------------------------------------------------------
// 2 and 4. CHILD PROCESSES
// ---------------------------------------------------------------------------

function isNodeExecutable(command) {
  if (typeof command !== 'string' || command === '') return false
  if (command === process.execPath) return true
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, '')
  return base === 'node' || base === 'nodejs' || base === 'tsx'
}

/** The executable's own name, for the denylist: `/usr/bin/curl` and `curl` are the same refusal. */
function basenameOf(command) {
  return typeof command === 'string' ? path.basename(command).toLowerCase().replace(/\.exe$/, '') : ''
}

/**
 * The first word of each `;`, `|`, `&&` or newline separated segment of a shell command line. `exec()`
 * and `execSync()` take a program, not an executable, so the denylist has to look at what that program
 * starts. It is NOT applied to a program passed as an ARGUMENT (`bash -c '…'`): those are 100+ call sites
 * of real shell here, and guessing at their contents would refuse the suite rather than the network.
 */
function shellHeadWords(command) {
  return String(command)
    .split(/[;\n|&]+|&&|\|\|/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? '')
    .filter((word) => word !== '' && !word.includes('='))
}

function refuseNetworkClient(command, args) {
  const argv = Array.isArray(args) ? args.map((value) => String(value)) : []
  const base = basenameOf(command)
  if (NETWORK_CLIENTS.has(base)) {
    throw blockedSpawn(base, 'it is a network client')
  }
  if (base === 'git' && argv.length > 0 && GIT_NETWORK_SUBCOMMANDS.has(argv[0])) {
    throw blockedSpawn(`git ${argv[0]}`, 'that git subcommand talks to a remote')
  }
}

function refuseNetworkClientInProgram(command) {
  for (const word of shellHeadWords(command)) {
    const base = basenameOf(word)
    if (NETWORK_CLIENTS.has(base)) throw blockedSpawn(base, 'it is a network client, started by: ' + String(command).slice(0, 120))
  }
}

/** NODE_OPTIONS with the trap appended, idempotently. */
function withTrap(value) {
  const current = typeof value === 'string' ? value : ''
  if (current.includes(SELF)) return current
  return current === '' ? REQUIRE_FLAG : `${current} ${REQUIRE_FLAG}`
}

/**
 * A COPY, never a mutation: the caller's options object may be reused, asserted on, or frozen. An absent
 * `env` needs nothing — the child inherits this process's environment, which already carries the flag.
 */
function injectIntoOptions(argument) {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return argument
  const supplied = argument.env
  if (supplied === null || typeof supplied !== 'object') return argument
  return { ...argument, env: { ...supplied, NODE_OPTIONS: withTrap(supplied.NODE_OPTIONS) } }
}

const PROMISIFY_CUSTOM = Symbol.for('nodejs.util.promisify.custom')

/**
 * The REAL module object, not the ES namespace: under this toolchain `import * as` yields a copy, and
 * assigning to a copy patches nothing. Every consumer — a transpiled `import { spawnSync }`, a true-ESM
 * named import, `require()` — reads through the object this hands back. (Same reasoning, and the same
 * measured behaviour, as tests/temp-dir-sentinel.ts, which wraps these functions for TMPDIR; the two
 * wrappers compose, in whichever order the scripts load them.)
 */
function installChildProcessTrap() {
  const childProcess = require('node:child_process')
  const SHELL_FORMS = new Set(['exec', 'execSync'])
  for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
    const original = childProcess[name]
    if (typeof original !== 'function') continue

    const guard = (args) => {
      const command = args[0]
      if (SHELL_FORMS.has(name)) {
        refuseNetworkClientInProgram(command)
        const head = shellHeadWords(command)[0]
        return isNodeExecutable(head) ? args.map(injectIntoOptions) : args
      }
      // `fork` always runs this Node binary, whatever module path it is given.
      if (name === 'fork') return args.map(injectIntoOptions)
      refuseNetworkClient(command, args[1])
      return isNodeExecutable(command) ? args.map(injectIntoOptions) : args
    }

    const guarded = function guardedSpawn(...args) {
      return original.apply(this, guard(args))
    }

    const promisified = original[PROMISIFY_CUSTOM]
    if (typeof promisified === 'function') {
      guarded[PROMISIFY_CUSTOM] = function guardedSpawnPromise(...args) {
        return promisified.apply(this, guard(args))
      }
    }

    childProcess[name] = guarded
  }
}

// ---------------------------------------------------------------------------
// 3. WORKER THREADS
// ---------------------------------------------------------------------------

/**
 * A worker is a fresh realm: its `net` module is a different object, so the patch above does not reach it,
 * and neither `NODE_OPTIONS` nor an inherited `--import` installs anything there (both measured on Node
 * 22.23: the `--import` is accepted and ignored). `--require` in the worker's own `execArgv` does work,
 * which is the whole reason this file is CommonJS.
 *
 * When the caller passes no `execArgv` a worker inherits the parent's, so passing one drops that
 * inheritance. For module hooks that inheritance does nothing, and nothing in this repository starts a
 * worker at all, so an explicit minimal `execArgv` is the smaller risk: the alternative is forwarding
 * `--test` and friends into a worker, which Node may refuse outright.
 */
function installWorkerTrap() {
  const workerThreads = require('node:worker_threads')
  const Original = workerThreads.Worker
  if (typeof Original !== 'function') return
  class GuardedWorker extends Original {
    constructor(specifier, options) {
      const given = options && typeof options === 'object' ? options : {}
      const execArgv = Array.isArray(given.execArgv) ? given.execArgv : []
      super(specifier, execArgv.includes(SELF)
        ? given
        : { ...given, execArgv: [...execArgv, '--require', SELF] })
    }
  }
  Object.defineProperty(GuardedWorker, 'name', { value: 'Worker' })
  // A marker, so a test can assert that the constructor IT was given is the guarded one rather than
  // inferring it from a connection that failed for some other reason.
  GuardedWorker.imsOutboundNetworkTrap = true
  workerThreads.Worker = GuardedWorker
}

// ---------------------------------------------------------------------------

const registry = globalThis
if (!registry[TRAP]) {
  registry[TRAP] = true
  installSocketTrap()
  installChildProcessTrap()
  installWorkerTrap()
  process.env.NODE_OPTIONS = withTrap(process.env.NODE_OPTIONS)
}

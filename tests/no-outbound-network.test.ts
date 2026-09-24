import assert from 'node:assert/strict'
import { exec, spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

/**
 * tests/no-outbound-network.cjs, PROVEN ABLE TO FIRE (o3d-bhvu rounds 2 and 3).
 *
 * The trap is only worth having if it is loaded and actually refuses: so this asserts it is installed in
 * this very process, that a connection to a routable address is refused with the trap's own error (not a
 * timeout, which a slow network would also produce), that the real connectorFetch pointed at the live
 * Mintsoft host is refused, that loopback still works, and that all three test scripts load it.
 *
 * AND THAT IT REACHES THE THREE PLACES ROUND 2 MISSED (review M-a): a Node child process, a worker
 * thread, and a child that is not Node at all. Those are measured against A REAL LISTENER ON THIS
 * MACHINE'S OWN ROUTABLE ADDRESS — nothing leaves the host, but every one of them is a non-loopback
 * address as far as the trap is concerned, and a connection to it is immediate rather than a timeout. The
 * assertion in each case is TWO-PART: the attempt was refused by name, AND the server counted zero
 * connections. The second half is the property; the first is how we know it was the trap.
 *
 * THE NEGATIVE CONTROL IS PART OF THE PROOF. `a shell that unsets NODE_OPTIONS` connects, and the server
 * counts it. So the rig can see a connection, these tests are not passing because the listener is
 * unreachable — and that residual is stated in the trap's own header rather than left to be discovered.
 */

/** This machine's own non-loopback IPv4, which is a remote address as far as the trap is concerned. */
function routableAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

type Listener = { host: string; port: number; connections: () => number; close: () => Promise<void> }

async function listenOnRoutableAddress(host: string): Promise<Listener> {
  let connections = 0
  const server = net.createServer((socket) => { connections += 1; socket.destroy() })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  return {
    host,
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A child's verdict on one connection attempt, on stdout, whatever the child is. */
function connectProbe(host: string, port: number): string {
  return `const net = require('node:net');`
    + `const s = net.connect({ host: ${JSON.stringify(host)}, port: ${port} });`
    + `s.on('connect', () => { console.log('CONNECTED'); s.destroy(); process.exit(0) });`
    + `s.on('error', (e) => { console.log('REFUSED:' + e.name); process.exit(0) });`
}

function runToCompletion(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', reject)
    child.on('close', () => resolve(out.trim()))
  })
}

test('the trap is installed in this test process', () => {
  assert.equal((globalThis as unknown as Record<symbol, unknown>)[Symbol.for('ims.tests.noOutboundNetwork')], true,
    'run through npm run test:unit / test:concurrency / test:db, which --import tests/no-outbound-network.cjs')
})

test('a raw TCP connection to a routable address is refused by the trap, before anything is sent', async () => {
  const error = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: '192.0.2.10', port: 443 })
    socket.on('connect', () => resolve(new Error('connected — the trap did not fire')))
    socket.on('error', resolve)
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
  assert.match(error.message, /192\.0\.2\.10:443/)
})

test('an IPv4-MAPPED routable address is refused, not read as loopback because of the ::ffff: prefix', async (t) => {
  // The MAPPED mutation — `^::ffff:` instead of `^::ffff:127\.` — survived round 2 because nothing
  // asserted this. `::ffff:127.0.0.1` IS loopback; the mapped form of this machine's own routable
  // address is not, and neither is the bracketed form a URL would carry. Aimed at a REAL listener, so a
  // trap that lets it through connects at once and this fails by name rather than hanging on a
  // black-holed address until the runner gives up.
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  try {
    for (const host of [`::ffff:${routable}`, `[::ffff:${routable}]`]) {
      const error = await new Promise<Error>((resolve) => {
        const socket = net.connect({ host, port: listener.port })
        socket.on('connect', () => { socket.destroy(); resolve(new Error(`connected to ${host} — the trap did not fire`)) })
        socket.on('error', resolve)
      })
      assert.equal(error.name, 'OutboundNetworkBlockedError', `${host}: ${error.message}`)
    }
    assert.equal(listener.connections(), 0, 'and nothing reached the listener')
  } finally {
    await listener.close()
  }
  // …and the mapped loopback address still passes, so the check above is not simply refusing everything.
  const loopback = await new Promise<string>((resolve) => {
    const socket = net.connect({ host: '::ffff:127.0.0.1', port: 1 })
    socket.on('error', (error: Error) => resolve(error.name === 'OutboundNetworkBlockedError' ? 'blocked' : 'passed the trap'))
    socket.on('connect', () => { socket.destroy(); resolve('passed the trap') })
  })
  assert.equal(loopback, 'passed the trap', '::ffff:127.0.0.1 is loopback and must still be allowed')
})

test('a remote NAME is refused once it resolves, and a caller’s own lookup error still surfaces as itself', async () => {
  const error = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: 'remote.example.test', port: 443, lookup: (_host, _options, callback) => (callback as (e: null, a: string, f: number) => void)(null, '198.51.100.7', 4) })
    socket.on('connect', () => resolve(new Error('connected — the trap did not fire')))
    socket.on('error', resolve)
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
  assert.match(error.message, /198\.51\.100\.7/)
  const own = await new Promise<Error>((resolve) => {
    const socket = net.connect({ host: 'refused.example.test', port: 443, lookup: (_host, _options, callback) => (callback as (e: Error) => void)(new Error('the caller refused this name itself')) })
    socket.on('error', resolve)
  })
  assert.equal(own.message, 'the caller refused this name itself', 'the caller’s own refusal is not masked by the trap')
  const local = await new Promise<string>((resolve) => {
    const socket = net.connect({ host: 'loopback.example.test', port: 1, lookup: (_host, _options, callback) => (callback as (e: null, a: string, f: number) => void)(null, '127.0.0.1', 4) })
    socket.on('error', (error: Error) => resolve(error.name === 'OutboundNetworkBlockedError' ? 'blocked' : 'passed the trap'))
    socket.on('connect', () => { socket.destroy(); resolve('passed the trap') })
  })
  assert.equal(local, 'passed the trap', 'a name that resolves to loopback is let through (port 1 then refuses the connection itself)')
})

test('localhost is RESOLVED like any other name: a lookup that points it at a routable address is refused', async (t) => {
  // Review L-c: round 2 treated the name `localhost` (and `*.localhost`) as loopback without resolving
  // it, so a caller supplying its own lookup could reach a routable address through that name. The
  // address is what the socket uses, so the address is what is checked.
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  try {
    for (const host of ['localhost', 'api.localhost']) {
      const error = await new Promise<Error>((resolve) => {
        const socket = net.connect({
          host,
          port: listener.port,
          lookup: (_host, _options, callback) => (callback as (e: null, a: string, f: number) => void)(null, routable, 4),
        })
        socket.on('connect', () => resolve(new Error(`connected through ${host} — the trap did not fire`)))
        socket.on('error', resolve)
      })
      assert.equal(error.name, 'OutboundNetworkBlockedError', `${host}: ${error.message}`)
      assert.match(error.message, new RegExp(routable.replace(/\./g, '\\.')))
    }
    assert.equal(listener.connections(), 0, 'and nothing reached the listener')
  } finally {
    await listener.close()
  }
})

test('an http request to a remote host is refused by the trap', async () => {
  const error = await new Promise<Error>((resolve) => {
    const req = httpRequest({ host: '192.0.2.11', port: 80, path: '/' }, () => resolve(new Error('got a response')))
    req.on('error', resolve)
    req.end()
  })
  assert.equal(error.name, 'OutboundNetworkBlockedError', error.message)
})

test('connectorFetch against the LIVE Mintsoft host is refused by the trap, not sent', async () => {
  const { connectorFetch } = await import('@/lib/security/connector-fetch')
  await assert.rejects(
    // The live Mintsoft host, resolved through connectorFetch's own injectable lookup to a public address
    // (TEST-NET-3), so the proof needs no DNS: connectorFetch's SSRF check passes it, the trap refuses it.
    connectorFetch('https://api.mintsoft.co.uk/api/Warehouse', { method: 'GET' }, {
      connectorName: 'Mintsoft',
      lookup: async () => [{ address: '203.0.113.20', family: 4 }],
    }),
    (error: unknown) => error instanceof Error && /Blocked outbound network connection|OutboundNetworkBlocked/.test(`${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`),
  )
})

test('loopback connections still work, so local test servers and the scratch database are unaffected', async () => {
  const server = createServer((_request, response) => { response.end('ok') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as net.AddressInfo).port
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(body, 'ok')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('THE RIG IS NOT VACUOUS: a shell that unsets NODE_OPTIONS reaches the listener, and it is counted', async (t) => {
  // Every test below asserts "the server saw nothing". That assertion is worth exactly as much as the
  // listener's ability to see something, so this is the control: the same address, the same probe, the
  // same machine, with the one mechanism the trap relies on for children removed from the environment by
  // a shell. It connects. It is also the honest residual, stated in the trap's header: a non-Node child
  // can rebuild the environment, and nothing in-process can stop it.
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  try {
    const probe = connectProbe(routable, listener.port)
    const output = await runToCompletion('bash', ['-c', `unset NODE_OPTIONS; exec "$NODE_BINARY" -e "$PROBE"`], {
      env: { ...process.env, NODE_BINARY: process.execPath, PROBE: probe },
    })
    assert.equal(output, 'CONNECTED', `the control must actually connect, or nothing below measures anything: ${output}`)
    assert.equal(listener.connections(), 1, 'and the listener must have counted it')
  } finally {
    await listener.close()
  }
})

test('a NODE CHILD PROCESS inherits the trap and cannot reach the listener (review M-a)', async (t) => {
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  try {
    const probe = connectProbe(routable, listener.port)
    // 1. The ordinary case: the child inherits this process's environment, which carries the trap.
    const inherited = await runToCompletion(process.execPath, ['-e', probe])
    assert.equal(inherited, 'REFUSED:OutboundNetworkBlockedError', `an inherited-environment child: ${inherited}`)
    // 2. A REPLACEMENT environment, which is how several harnesses here launch children, and a CLEARED
    //    NODE_OPTIONS, which is how four of them launch guard scripts. Neither can lose the trap: it is
    //    put back at the spawn boundary.
    const replaced = await runToCompletion(process.execPath, ['-e', probe], { env: { PATH: process.env.PATH ?? '' } as unknown as NodeJS.ProcessEnv })
    assert.equal(replaced, 'REFUSED:OutboundNetworkBlockedError', `a replacement-environment child: ${replaced}`)
    const cleared = await runToCompletion(process.execPath, ['-e', probe], { env: { ...process.env, NODE_OPTIONS: '' } })
    assert.equal(cleared, 'REFUSED:OutboundNetworkBlockedError', `a child with NODE_OPTIONS cleared: ${cleared}`)
    assert.equal(listener.connections(), 0, 'and no child reached the listener')
  } finally {
    await listener.close()
  }
})

test('a WORKER THREAD gets the trap through execArgv and cannot reach the listener (review M-a)', async (t) => {
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  try {
    // A worker is a fresh realm with its own `net`, and `--import`/NODE_OPTIONS do not install anything
    // in it (measured on Node 22.23) — `--require` in its execArgv does, which is why the trap is CJS.
    // FIRST, that the constructor THIS FILE was handed is the guarded one: `tsx` transpiles these tests to
    // CommonJS, so `Worker` here is the patched module property. A true-ESM `.mjs` under `tsx` gets the
    // builtin's ESM-facade snapshot instead, which `tsx` creates for its own hook thread before any
    // preload runs — that residual is stated in the trap's header and in docs/development.md.
    assert.equal((Worker as unknown as { imsOutboundNetworkTrap?: boolean }).imsOutboundNetworkTrap, true,
      'the Worker constructor this test file sees is not the trap\u2019s — the patch did not reach it')
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads');`
      + `const installed = !!globalThis[Symbol.for('ims.tests.noOutboundNetwork')];`
      + `const net = require('node:net');`
      + `const s = net.connect({ host: ${JSON.stringify(routable)}, port: ${listener.port} });`
      + `s.on('connect', () => { parentPort.postMessage('installed=' + installed + ' CONNECTED'); s.destroy() });`
      + `s.on('error', (e) => parentPort.postMessage('installed=' + installed + ' REFUSED:' + e.name));`,
      { eval: true },
    )
    const verdict = await new Promise<string>((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('the worker reported neither a connection nor a refusal within 20s')), 20_000)
      giveUp.unref()
      const settle = (outcome: string | Error) => {
        clearTimeout(giveUp)
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }
      worker.once('message', settle)
      worker.once('error', settle)
      worker.once('exit', (code: number) => settle(new Error(`the worker exited (${code}) without reporting anything`)))
    }).finally(() => worker.terminate())
    assert.equal(verdict, 'installed=true REFUSED:OutboundNetworkBlockedError', verdict)
    assert.equal(listener.connections(), 0, 'and the worker reached nothing')
  } finally {
    await listener.close()
  }
})

test('a child that is NOT Node and exists to move bytes is refused at the spawn boundary (review M-a)', async (t) => {
  const routable = routableAddress()
  if (!routable) return t.skip('this host has no non-loopback IPv4 address to aim at')
  const listener = await listenOnRoutableAddress(routable)
  const url = `http://${routable}:${listener.port}/`
  try {
    // Nothing can be installed inside a binary that is not Node, so the refusal is the spawn itself —
    // before the process exists, which is why it does not matter whether curl is installed here.
    //
    // THE ARGUMENTS ARE CHOSEN SO THAT A TRAP WHICH FAILED TO REFUSE FAILS THIS TEST FAST, AND REACHES
    // NOTHING. Measured the hard way: with the refusal mutated out, `wget -q <url>` retries a destroyed
    // connection twenty times INSIDE spawnSync, which blocks the event loop and turns a clean assertion
    // failure into a whole-file timeout — and `git fetch origin` would have gone to the real remote. So
    // each tool is given its own one-shot timeout, and git a local path that is not a repository.
    assert.throws(() => spawnSync('curl', ['-s', '--max-time', '2', url]), (error: unknown) => (error as Error).name === 'OutboundNetworkBlockedError')
    assert.throws(() => spawnSync('/usr/bin/wget', ['-q', '--tries=1', '--timeout=2', url]), (error: unknown) => (error as Error).name === 'OutboundNetworkBlockedError')
    assert.throws(() => spawn('nc', ['-w', '2', routable, String(listener.port)]), (error: unknown) => (error as Error).name === 'OutboundNetworkBlockedError')
    assert.throws(() => exec(`curl -s --max-time 2 ${url} | cat`), (error: unknown) => (error as Error).name === 'OutboundNetworkBlockedError')
    // git is local in this suite (`ls-files`, `rev-parse`) — its remote subcommands are not.
    assert.throws(() => spawnSync('git', ['fetch', '/nonexistent-remote-for-a-test']), (error: unknown) => (error as Error).name === 'OutboundNetworkBlockedError')
    assert.equal(spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).status, 0,
      'and an ordinary local git command still runs, so this is a denylist and not a ban on git')
    assert.equal(listener.connections(), 0, 'nothing reached the listener')
  } finally {
    await listener.close()
  }
})

test('all three test scripts load the trap', () => {
  const scripts = (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  for (const name of ['test:unit', 'test:concurrency', 'test:db']) {
    assert.match(scripts[name] ?? '', /--import\s+\.\/tests\/no-outbound-network\.cjs/, `${name} must --import the trap`)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { endpointKey, normaliseAddress, ownEndpointsFrom, parseProcAddress } from '../../lib/first-load/apply/db/own-sessions.ts'
import { precondition } from './helpers.ts'

/** Which sessions are ours, from invented /proc tables: the identity is the FULL endpoint (address and port), in one canonical form. */

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const row = (local: string, remote: string, inode: string) => `   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`
const SERVER = { addr: '127.0.0.1', port: 5432 }

test('addresses are compared in one canonical form: dotted IPv4, IPv4-mapped IPv6 as IPv4, compressed IPv6; unspecified and garbage are none', (t) => {
  precondition(t, 'cases', 9)
  assert.equal(parseProcAddress('0100007F'), '127.0.0.1')
  assert.equal(parseProcAddress('0200007F'), '127.0.0.2')
  assert.equal(parseProcAddress('00000000'), null, 'unspecified')
  assert.equal(parseProcAddress('0000000000000000FFFF00000100007F'), '127.0.0.1', 'an IPv4-mapped IPv6 address is its IPv4 address')
  assert.equal(parseProcAddress('00000000000000000000000001000000'), '::1')
  assert.equal(normaliseAddress('::ffff:10.0.0.5'), '10.0.0.5')
  assert.equal(normaliseAddress('2001:0db8:0000:0000:0000:0000:0000:0001'), '2001:db8::1')
  assert.equal(normaliseAddress('::'), null)
  assert.equal(normaliseAddress('not an address'), null)
})

test('a socket is ours only on the FULL endpoint: the same port on another address is not ours', (t) => {
  // Mutation named: build the set from the port alone -> the second assertion fails.
  const table = HEADER + row('0100007F:C350', '0100007F:1538', '777') + row('0100007F:D000', '0100007F:1538', '888')
  const own = ownEndpointsFrom(new Set(['777']), [table], SERVER)
  precondition(t, 'own endpoints', own.size)
  assert.deepEqual([...own], [endpointKey('127.0.0.1', 0xc350)])
  assert.ok(own.has(endpointKey('127.0.0.1', 50000)))
  assert.ok(!own.has(endpointKey('127.0.0.2', 50000)), 'same port, another address')
  assert.ok(!own.has(endpointKey('127.0.0.1', 0xd000)), 'a socket this process does not hold')
})

test('only sockets to THIS server count: another remote address or port is not ours', () => {
  const table = HEADER + row('0100007F:C350', '0100007F:1539', '1') + row('0100007F:C351', '0200007F:1538', '2') + row('0100007F:C352', '0100007F:1538', '3')
  assert.deepEqual([...ownEndpointsFrom(new Set(['1', '2', '3']), [table], SERVER)], [endpointKey('127.0.0.1', 0xc352)])
})

test('IPv6 and IPv4-mapped sockets are matched in canonical form, and rows it cannot parse are not guessed at', () => {
  const v6 = HEADER + row('0000000000000000FFFF00000100007F:C350', '0000000000000000FFFF00000100007F:1538', '5') + row('ZZZZ:C350', '0100007F:1538', '6')
  assert.deepEqual([...ownEndpointsFrom(new Set(['5', '6']), [v6], SERVER)], [endpointKey('127.0.0.1', 0xc350)])
})

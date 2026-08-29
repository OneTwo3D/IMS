#!/usr/bin/env node
/**
 * THE EXTERNAL PASSWORD VERIFIER ITSELF, IN A PROCESS OF ITS OWN (o3d-2sm1.5 r41).
 *
 * WHY IT IS NOT IN THE TEST PROCESS, which is where it was first written and where it deadlocked.
 * The regressions drive the shipped shell through `execFileSync`, which BLOCKS THE NODE EVENT LOOP
 * for the whole of the run. A UDP socket owned by the test process therefore cannot answer while
 * psql is waiting on it: PostgreSQL's RADIUS client retries for its full timeout, gives up, and the
 * endpoint refuses every password -- which looks exactly like a verifier that discriminates badly,
 * and would have made the two tests that need one pass vacuously. It was measured, not reasoned
 * about: the in-process version reported R40_PAIR_PASSES_ON_RADIUS=no on a cluster where the whole
 * point is that it says yes.
 *
 * So the verifier is a separate process, and the record of what it was asked goes to a FILE the
 * parent reads synchronously, for the same reason: a pipe the parent has to drain is a pipe that is
 * not drained while `execFileSync` holds the loop.
 *
 * WHAT IT IMPLEMENTS, and it is only what PostgreSQL's client sends:
 *   * Access-Request (code 1) in, Access-Accept (2) or Access-Reject (3) out.
 *   * User-Name (attribute 1) and User-Password (attribute 2). The password is obfuscated as
 *     RFC 2865 section 5.2 describes -- XOR against MD5(secret || previous-block), the first
 *     previous block being the request authenticator -- and PostgreSQL pads it with NULs to 16
 *     bytes and refuses to send one longer than that.
 *   * The Response Authenticator, MD5(code || id || length || request-authenticator || attributes
 *     || secret), which PostgreSQL VERIFIES: get it wrong and the server logs a warning and treats
 *     the reply as no reply at all, so the tests would time out rather than fail.
 *
 * Usage: node radius-verifier.mjs --secret=S --user=U --accepts=P --log=PATH
 * It prints `radius-listening <port>` on stdout once bound, and nothing else.
 */
import { createHash } from 'node:crypto'
import dgram from 'node:dgram'
import { appendFileSync } from 'node:fs'
import process from 'node:process'

const ACCESS_REQUEST = 1
const ACCESS_ACCEPT = 2
const ACCESS_REJECT = 3
const ATTRIBUTE_USER_NAME = 1
const ATTRIBUTE_USER_PASSWORD = 2
/** PostgreSQL's NUL padding, built rather than typed so no byte of this file is invisible. */
const TRAILING_NULS = new RegExp(String.fromCharCode(0) + '+$')

const options = new Map()
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z]+)=([\s\S]*)$/.exec(argument)
  if (match === null) throw new Error(`unrecognised argument ${argument}`)
  options.set(match[1], match[2])
}
for (const required of ['secret', 'user', 'accepts', 'log']) {
  if (!options.has(required)) throw new Error(`--${required}= is required`)
}
const SECRET = options.get('secret')
const USER = options.get('user')
const ACCEPTS = options.get('accepts')
const LOG = options.get('log')

/** RFC 2865 section 5.2, run backwards: each cipher block is the key for the block after it. */
function decodePassword(secret, authenticator, cipher) {
  let previous = authenticator
  const plain = []
  for (let offset = 0; offset < cipher.length; offset += 16) {
    const block = cipher.subarray(offset, offset + 16)
    const key = createHash('md5').update(Buffer.concat([Buffer.from(secret, 'utf8'), previous])).digest()
    const decoded = Buffer.alloc(block.length)
    for (let index = 0; index < block.length; index += 1) decoded[index] = block[index] ^ key[index]
    plain.push(decoded)
    previous = block
  }
  // Only the padding is trimmed; a password that genuinely ended in something else keeps it.
  return Buffer.concat(plain).toString('utf8').replace(TRAILING_NULS, '')
}

const socket = dgram.createSocket('udp4')
socket.on('message', (packet, remote) => {
  if (packet.length < 20 || packet[0] !== ACCESS_REQUEST) return
  const identifier = packet[1]
  const authenticator = packet.subarray(4, 20)
  let name = ''
  let password = ''
  let offset = 20
  while (offset + 2 <= packet.length) {
    const type = packet[offset]
    const length = packet[offset + 1]
    if (length < 2) break
    const value = packet.subarray(offset + 2, offset + length)
    if (type === ATTRIBUTE_USER_NAME) name = value.toString('utf8')
    if (type === ATTRIBUTE_USER_PASSWORD) password = decodePassword(SECRET, authenticator, value)
    offset += length
  }
  const accepted = name === USER && password === ACCEPTS
  // THE RECORD OF WHAT THE DIRECTORY WAS ASKED, which is how a test proves the endpoint really was
  // external rather than a pg_hba rule that failed to load.
  appendFileSync(LOG, name + ' ' + (accepted ? 'accept' : 'reject') + '\n')
  const header = Buffer.from([accepted ? ACCESS_ACCEPT : ACCESS_REJECT, identifier, 0, 20])
  const responseAuthenticator = createHash('md5')
    .update(Buffer.concat([header, authenticator, Buffer.from(SECRET, 'utf8')]))
    .digest()
  socket.send(Buffer.concat([header, responseAuthenticator]), remote.port, remote.address)
})
socket.bind(0, '127.0.0.1', () => {
  process.stdout.write('radius-listening ' + socket.address().port + '\n')
})

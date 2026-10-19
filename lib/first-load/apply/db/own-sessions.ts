/**
 * WHICH DATABASE SESSIONS ARE THIS PROCESS'S OWN.
 *
 * An application_name is a label any client can set, and a client PORT alone is not an identity either: a client on another host can use the same source port. What a process
 * owns is its sockets. Every connection it holds is a TCP socket whose inode appears in /proc/self/fd, and /proc/net/tcp{,6} lists that socket's full endpoints. The server shows the
 * same connection in pg_stat_activity with `client_addr` and `client_port` equal to OUR local address and port.
 *
 * A session is OURS only when BOTH its client address and client port equal the local endpoint of one of our sockets AND that socket's remote endpoint is the server's own endpoint
 * (`inet_server_addr()` / `inet_server_port()` of the connection that asks). Addresses are compared in one canonical text form (an IPv4-mapped IPv6 address is its IPv4 address;
 * IPv6 is compressed), so the two spellings of one address match and two different addresses never do.
 *
 * It fails closed: a Unix-socket server or client (no address), a wildcard or unparseable address, an unreadable /proc, or a non-Linux host cannot prove ownership, and the caller
 * refuses. Read-only: this opens no connection and writes nothing.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

export class OwnSessionsUnknown extends Error {
  constructor() {
    super('the sockets of this process could not be listed')
    this.name = 'OwnSessionsUnknown'
  }
}

/** One IP address as canonical text: dotted IPv4 (an IPv4-mapped IPv6 address becomes its IPv4 form) or compressed IPv6. Null when it is not an address or is the unspecified address. */
export function normaliseAddress(text: string | null | undefined): string | null {
  if (!text) return null
  let value = text.trim().replace(/%.*$/, '')
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)
  if (mapped) value = mapped[1]!
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number)
    if (parts.some((p) => p > 255)) return null
    return parts.every((p) => p === 0) ? null : parts.join('.')
  }
  if (!value.includes(':')) return null
  try {
    const host = new URL(`http://[${value}]`).hostname.slice(1, -1)
    // WHATWG URL prints an IPv4-mapped address in hex ("::ffff:7f00:1"); turn it back into dotted form.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
    if (hex) {
      const high = Number.parseInt(hex[1]!, 16)
      const low = Number.parseInt(hex[2]!, 16)
      return normaliseAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return host === '::' ? null : host
  } catch {
    return null
  }
}

/** An address as /proc/net/tcp prints it: IPv4 as one little-endian hex word, IPv6 as four little-endian hex words. */
export function parseProcAddress(hex: string): string | null {
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return normaliseAddress([3, 2, 1, 0].map((i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.'))
  if (/^[0-9A-Fa-f]{32}$/.test(hex)) {
    const groups: string[] = []
    for (let word = 0; word < 4; word++) {
      const bytes = [3, 2, 1, 0].map((i) => hex.slice(word * 8 + i * 2, word * 8 + i * 2 + 2))
      groups.push(`${bytes[0]}${bytes[1]}`, `${bytes[2]}${bytes[3]}`)
    }
    return normaliseAddress(groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':'))
  }
  return null
}

export interface ServerEndpoint {
  addr: string
  port: number
}

/** `address|port` of the local end of a connection, in canonical form. */
export const endpointKey = (addr: string, port: number): string => `${addr}|${port}`

/**
 * The local endpoints of this process's sockets whose remote end is `server`. `socketInodes` are the process's socket inodes; `tables` are the texts of /proc/net/tcp and /proc/net/tcp6.
 * Pure, so it can be tested with invented tables.
 */
export function ownEndpointsFrom(socketInodes: ReadonlySet<string>, tables: readonly string[], server: ServerEndpoint): Set<string> {
  const own = new Set<string>()
  for (const text of tables) {
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || !socketInodes.has(cols[9]!)) continue
      const [localHex, localPortHex] = cols[1]!.split(':')
      const [remoteHex, remotePortHex] = cols[2]!.split(':')
      if (!localHex || !localPortHex || !remoteHex || !remotePortHex) continue
      const localAddr = parseProcAddress(localHex)
      const remoteAddr = parseProcAddress(remoteHex)
      const localPort = Number.parseInt(localPortHex, 16)
      const remotePort = Number.parseInt(remotePortHex, 16)
      if (localAddr === null || remoteAddr === null || !Number.isFinite(localPort) || !Number.isFinite(remotePort)) continue
      if (remoteAddr === server.addr && remotePort === server.port) own.add(endpointKey(localAddr, localPort))
    }
  }
  return own
}

/** Read this process's sockets from /proc. Throws OwnSessionsUnknown where that is not possible. */
export function ownEndpoints(server: ServerEndpoint): Set<string> {
  const inodes = new Set<string>()
  try {
    for (const fd of readdirSync('/proc/self/fd')) {
      let target: string
      try { target = readlinkSync(`/proc/self/fd/${fd}`) } catch { continue }
      const match = /^socket:\[(\d+)\]$/.exec(target)
      if (match) inodes.add(match[1]!)
    }
  } catch {
    throw new OwnSessionsUnknown()
  }
  const tables: string[] = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { tables.push(readFileSync(table, 'utf8')) } catch { /* the other family may be absent */ }
  }
  if (tables.length === 0) throw new OwnSessionsUnknown()
  return ownEndpointsFrom(inodes, tables, server)
}

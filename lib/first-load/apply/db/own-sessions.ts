/**
 * WHICH DATABASE SESSIONS ARE THIS PROCESS'S OWN.
 *
 * An application_name is a label any client can set, so it proves nothing about who owns a session. What a process owns is its sockets: every connection it holds (the
 * application pool, the lock pool, anything else) is a TCP socket whose inode appears in /proc/self/fd, and /proc/net/tcp{,6} lists that socket's local and remote port.
 * The server sees the same connection in pg_stat_activity with `client_port` = our local port. A session is OURS only when its client_port is the local port of one of our
 * sockets whose remote end is the server's port. A session from another process (even on the same machine, and even one that copied our application_name) has a different
 * client port, so it is not ours.
 *
 * Linux only, and TCP only: a connection over a Unix socket carries no client port, so it cannot be proven ours and is counted as another client; where /proc cannot be read nothing
 * can be proven and the caller refuses. Read-only: this opens no connection and writes nothing.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

export class OwnSessionsUnknown extends Error {
  constructor() {
    super('the sockets of this process could not be listed')
    this.name = 'OwnSessionsUnknown'
  }
}

/** The local ports of this process's TCP sockets whose remote port is `serverPort`. */
export function ownClientPorts(serverPort: number): Set<number> {
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
  const ports = new Set<number>()
  let tables = 0
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try { text = readFileSync(table, 'utf8') } catch { continue }
    tables++
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const local = cols[1]!
      const remote = cols[2]!
      const inode = cols[9]!
      if (!inodes.has(inode)) continue
      const localPort = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
      const remotePort = Number.parseInt(remote.slice(remote.lastIndexOf(':') + 1), 16)
      if (remotePort === serverPort && Number.isFinite(localPort)) ports.add(localPort)
    }
  }
  if (tables === 0) throw new OwnSessionsUnknown()
  return ports
}

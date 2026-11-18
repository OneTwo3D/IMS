import { pathToFileURL } from 'node:url'

import { latestWriterAttestation, recordWriterAttestation, type AttestationDb } from '@/lib/domain/writer-attestation/store'
import {
  WRITER_ATTESTATION_COMMAND,
  WRITER_ATTESTATION_KINDS,
  WRITER_ATTESTATION_LABEL,
  WRITER_ATTESTATION_NOTE_MAX,
  isWriterAttestationKind,
} from '@/lib/security/writer-attestation-constants'

/**
 * `npm run writers:attest -- --kind <kind> --by <name> [--note <text>] [--yes]` records an owner confirmation; `-- --list` shows the newest of each kind.
 * Without `--yes` it prints what it would record and records nothing. Exit codes: 0 ok, 3 usage, 5 failed.
 */

type Logger = Pick<typeof console, 'log' | 'error'>
export type WritersAttestCliOptions = {
  argv?: string[]
  db?: AttestationDb
  stdout?: Pick<Logger, 'log'>
  stderr?: Pick<Logger, 'error'>
  disconnect?: () => Promise<void>
}

export async function runWritersAttestCli(options: WritersAttestCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? console
  const stderr = options.stderr ?? console
  const args = options.argv ?? process.argv.slice(2)
  const usage = `Usage: ${WRITER_ATTESTATION_COMMAND} -- --kind <${WRITER_ATTESTATION_KINDS.join('|')}> --by <name> [--note <text>] [--yes]   |   -- --list`

  let list = false
  let yes = false
  let kind: string | undefined
  let by: string | undefined
  let note = ''
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--list') list = true
    else if (arg === '--yes') yes = true
    else if (arg === '--kind' || arg === '--by' || arg === '--note') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) { stderr.error(usage); return 3 }
      i += 1
      if (arg === '--kind') kind = value
      else if (arg === '--by') by = value
      else note = value
    } else { stderr.error(usage); return 3 }
  }

  try {
    const db = options.db ?? ((await import('@/lib/db')).db as unknown as AttestationDb)
    if (list) {
      if (kind !== undefined || yes) { stderr.error(usage); return 3 }
      for (const k of WRITER_ATTESTATION_KINDS) {
        const latest = await latestWriterAttestation(db, k)
        stdout.log(`${k}: ${latest ? `confirmed ${latest.attestedAt.toISOString()} by ${latest.userId}` : 'not confirmed'}`)
      }
      return 0
    }
    if (!isWriterAttestationKind(kind) || !by || by.trim() === '' || note.length > WRITER_ATTESTATION_NOTE_MAX) { stderr.error(usage); return 3 }
    if (!yes) {
      stdout.log(`Would record: ${WRITER_ATTESTATION_LABEL[kind]} (by ${by}). Nothing recorded; add --yes to record it.`)
      return 0
    }
    const result = await recordWriterAttestation(db, { kind, userId: `cli:${by.trim()}`, note })
    if (!result.ok) { stderr.error(result.error); return 5 }
    stdout.log(`Recorded ${result.kind} at ${result.attestedAt.toISOString()}.`)
    return 0
  } catch {
    stderr.error('The confirmation could not be recorded.')
    return 5
  } finally {
    if (options.disconnect) await options.disconnect()
    else if (!options.db) {
      const { db } = await import('@/lib/db')
      await db.$disconnect()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWritersAttestCli().then((code) => process.exit(code), () => process.exit(5))
}

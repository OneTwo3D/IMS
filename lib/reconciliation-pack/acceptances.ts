/**
 * THE WRITTEN-ACCEPTANCE FILE R15 USES: the readiness gate's own format and parser, read under the same trust policy.
 *
 * An acceptance is a person's decision, so who could have written the file matters: it is used only if it is a regular file
 * (a symlink is never followed) owned by root or the running account, not writable by group or others, in a directory whose
 * every ancestor only root or that account can modify (readTrustedRegularFile). Otherwise the WHOLE file is rejected and
 * accepts nothing: R15 then fails on every warning, which is the safe side. Nothing from the file reaches text.
 */

import path from 'node:path'

import { parseAcceptanceFile, type AcceptanceFile } from '@/lib/ops/readiness-gate'
import { ACCEPTANCES_DEFAULT_FILE } from '@/lib/ops/readiness-gate-constants'
import { UntrustedPathError, readTrustedRegularFile } from '@/lib/ops/published-report'

export const MAX_ACCEPTANCE_BYTES = 1024 * 1024

/** A DEFAULT path that does not exist means none; a NAMED path that cannot be read is a refusal. */
export function loadAcceptances(explicit: string | null, repoRoot: string): { file: AcceptanceFile } | { refused: true } {
  const file = path.resolve(explicit !== null ? explicit : path.join(repoRoot, ACCEPTANCES_DEFAULT_FILE))
  try {
    return { file: parseAcceptanceFile(readTrustedRegularFile(file, MAX_ACCEPTANCE_BYTES)) }
  } catch (error) {
    if (error instanceof UntrustedPathError) return { file: { status: 'rejected', problems: [], entries: [] } }
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && explicit === null) return { file: parseAcceptanceFile(null) }
    if (explicit !== null) return { refused: true }
    return { file: { status: 'rejected', problems: [], entries: [] } }
  }
}

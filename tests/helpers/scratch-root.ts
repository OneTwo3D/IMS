import { accessSync, constants, statSync } from 'node:fs'

/**
 * The parent directory for test scratch material (throwaway Postgres clusters, report directories, temp trees).
 *
 * IMS_SCRATCH_ROOT, when it names an existing directory this account can write to, moves that material off the
 * SSD onto a RAM disk. Otherwise (unset, missing, a file, not writable) the answer is /var/tmp, exactly where these
 * tests have always put it, so CI and every run without the variable behave as before.
 *
 * The directory must be root-owned and sticky (1777) like /var/tmp: the report-directory trust checks refuse any other
 * writable ancestor. Keep the value short: a Postgres unix-socket path is limited to about 107 bytes, and the cluster lives below it.
 */
export function scratchRoot(): string {
  const configured = process.env.IMS_SCRATCH_ROOT
  if (configured) {
    try {
      if (statSync(configured).isDirectory()) {
        accessSync(configured, constants.W_OK | constants.X_OK)
        return configured
      }
    } catch {
      // missing or not writable: fall through to the fixed default
    }
  }
  return '/var/tmp'
}

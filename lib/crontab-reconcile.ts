import { execFile, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { getCronSecret } from '@/lib/cron-secret'
import {
  buildOtiCrontabBlock,
  emulateRuntimeSecretExtraction,
  isCronSafePath,
  isNoCrontabDiagnostic,
  spliceOtiBlock,
  type CrontabSecretRef,
} from '@/lib/crontab-sync'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { withCrontabReconcileLock, type HeldCrontabReconcileLock } from '@/lib/crontab-reconcile-lock'

/** How long `crontab -` gets to accept the new file before it is killed and reported as failed. */
const CRONTAB_WRITE_TIMEOUT_MS = 5000

/**
 * THE CRONTAB RECONCILIATION, SEPARATED FROM ITS PERMISSION GATE (o3d-osl8 round 9, finding 4).
 *
 * `syncCrontab` in app/actions/cron.ts is a `'use server'` export, so it re-runs
 * `requirePermission('settings.company')` on every call. That gate answers a missing, invalidated
 * or 2FA-unverified session by calling `redirect()`, which signals by THROWING `NEXT_REDIRECT`.
 *
 * Post-commit steps run inside a guard that classifies failures instead of rejecting the action
 * (lib/domain/post-commit.ts). Round 8's guard was a catch-all, so a redirect raised by this
 * re-entered gate was converted into "saved, but the scheduler is behind" and the operator stayed
 * on the page instead of going to the challenge. Two independent fixes, both applied:
 *
 *   1. `runPostCommit` calls `unstable_rethrow` before classifying anything, so a framework throw
 *      from ANY post-commit step propagates.
 *   2. the reconciliation no longer carries a gate to re-enter. Callers that have ALREADY gated —
 *      `savePublicAppUrl`, `saveCronJobSettings`, `saveIntegrationPluginState`, all of which run
 *      `requirePermission('settings.company')` as their first statement — call this directly.
 *
 * NOT exported from a `'use server'` module, deliberately: a module's export surface there is an
 * RPC manifest, and an ungated crontab writer on it would be reachable by anyone who can reach the
 * app. The only server action wrapping this is `syncCrontab`, which gates first.
 *
 * Reads all cron_* settings, generates the crontab block between OTI markers, and writes it via
 * `crontab -` (stdin pipe, no shell injection) for the CALLING OS user — i.e. the user the app runs
 * as.
 */
export type CrontabReconcileResult = {
  /** Did the crontab itself change? This, and only this, is whether the SCHEDULER is up to date. */
  success: boolean
  /** Why the crontab write failed. */
  error?: string
  /**
   * A step AFTER a successful crontab write did not complete — the audit row, the rendered cache
   * (Codex r20 MEDIUM).
   *
   * It is reported separately because it is a different fact with a different remedy. This function
   * used to `await` the audit row and the revalidate on the success path, so a logging failure
   * turned an APPLIED crontab into `{ success: false }` at the caller — a screen telling the
   * operator the scheduler could not be updated and to go and re-apply it, over a crontab that was
   * already correct. That is worse than the missing audit row it was reporting, and worse still when
   * combined with a local failure, since the scheduler warning is the one that wins.
   */
  followUpError?: string
}

/**
 * SERIALIZED, AND THE SERIALIZATION COVERS THE SNAPSHOT (Codex r21 HIGH, r22 HIGH).
 *
 * Everything from reading the settings to writing the crontab happens under ONE host-local file
 * lock, so two saves committing opposite enablement cannot end with the earlier snapshot writing
 * last — the state an earlier round removed by a different route: an enablement row on, no cron
 * line, and every caller reporting success. The whole argument — why a lock taken after the
 * snapshot would not have helped, why the exclusion is an `flock` on a file rather than a
 * PostgreSQL advisory lock, and what that trade gives up — is in lib/crontab-reconcile-lock.ts.
 *
 * THE LOCK IS TAKEN HERE, NOT AT THE CALL SITES, and that is deliberate. Six server actions
 * reconcile the crontab — `savePublicAppUrl`, `saveBackupScheduleSettings`,
 * `saveIntegrationPluginState`, `saveCronJobSettings`, `saveOnboardingPluginState` and the gated
 * `syncCrontab` — and a seventh will be added by someone who has not read this file. A rule that
 * every caller must remember to wrap is a rule that will be broken; taking it inside the only
 * function that touches the crontab makes coverage a property of the code rather than of a habit.
 *
 * COVERAGE IS A PROPERTY OF THE CODE, AND THE CODE IS NOT ONLY THIS LANGUAGE (r22). The other
 * writer of this file is `scripts/install.sh`, which is shell, runs as root, and has no database
 * connection when it gets there. It joins the same protocol by taking the same `flock` on the same
 * path — see the "Cron jobs" section there and the writer census in
 * tests/settings/crontab-reconcile-serialization.test.ts.
 *
 * The audit row and the cache revalidation stay OUTSIDE the lock: they observe a write that has
 * already happened and cannot change it, so holding the exclusion across them would only make every
 * other reconciliation wait for a log insert.
 */
export async function reconcileCrontab(): Promise<CrontabReconcileResult> {
  const outcome = await withCrontabReconcileLock(applyCrontabFromSettings)
  if (!outcome.locked) return { success: false, error: outcome.error }
  const result = outcome.result

  // THE CRONTAB IS ALREADY WRITTEN, OR ALREADY NOT (Codex r20 MEDIUM). Nothing below can change
  // that, so nothing below may turn `result` into a failure. `unstable_rethrow` runs first for the
  // same reason it does in `runPostCommit`: a swallowed NEXT_REDIRECT leaves a principal whose
  // session just became invalid sitting on a page instead of at the challenge.
  try {
    if (result.success) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'crontab_sync',
        description: `Crontab synced from scheduled jobs settings (user ${os.userInfo().username})`,
      })
    } else {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'crontab_sync',
        level: 'ERROR',
        description: `Crontab sync failed: ${result.error}`,
      })
    }

    revalidatePath('/settings/system')
  } catch (error) {
    unstable_rethrow(error)
    return {
      ...result,
      followUpError: error instanceof Error ? error.message : 'Failed to record the crontab change',
    }
  }

  return result
}

/**
 * The read-modify-write itself: SNAPSHOT the settings, read the crontab, write the crontab.
 *
 * Not exported, and called from exactly one place — `reconcileCrontab` above, under the lock. All
 * three steps belong to one another; a caller that ran this without the lock would reintroduce the
 * defect in full, which is why there is nothing here for anyone else to reach.
 */
async function applyCrontabFromSettings(
  lock: HeldCrontabReconcileLock,
): Promise<{ success: boolean; error?: string }> {
  const secret = await getCronSecret()
  if (!secret) {
    return { success: false, error: 'Cron secret is not configured.' }
  }

  const baseUrl = await getPublicAppUrl()
  if (!baseUrl) {
    return { success: false, error: 'Public app URL is not configured.' }
  }
  const pluginState = await getIntegrationPluginState()
  const jobs = getAllCronJobs().filter((job) => isIntegrationModuleVisible(job.module, pluginState))

  // Read enabled/schedule settings for every registered job, plus legacy keys
  const settingKeys = jobs.flatMap((j) => [
    `cron_${j.settingKey}_enabled`,
    `cron_${j.settingKey}_schedule`,
  ])
  const legacyKeys = jobs
    .filter((j) => j.legacyEnabledKey)
    .map((j) => j.legacyEnabledKey!)

  const rows = await db.setting.findMany({
    where: { key: { in: [...settingKeys, ...legacyKeys] } },
  })
  const settings = new Map(rows.map((r) => [r.key, r.value]))

  const logPath = process.env.OTI_CRON_LOG_PATH?.trim() || undefined
  const block = buildOtiCrontabBlock({ jobs, settings, secretRef: resolveSecretRef(secret), baseUrl, logPath })
  if (!block.ok) return { success: false, error: block.error }

  // REFUSE, DO NOT SPLICE INTO A GUESS (o3d-p9dq, Codex r29 HIGH #1). The only reading that lets
  // this proceed is one that RESOLVED: a crontab that was read, or a crontab that provably is not
  // there. Anything else stops here, with the crontab untouched — the write is what would have
  // done the damage, and it is the write that does not happen.
  const read = await readOwnCrontabResult()
  if (!read.resolved) {
    return {
      success: false,
      error: `The crontab could not be read, so it was NOT changed: ${read.reason}. `
        + 'Splicing the managed block into a crontab this process could not read would have '
        + 'written back only the block, deleting every line the crontab is the sole record of.',
    }
  }
  const newCrontab = spliceOtiBlock(read.text, block.lines)

  return writeCrontab(newCrontab, lock.fd)
}

/**
 * Write the crontab, WITH THE LOCK DESCRIPTOR INHERITED BY THE CHILD (Codex r22 HIGH).
 *
 * The write is not done by this process — `crontab -` does it. Round 21's exclusion was a
 * PostgreSQL session lock, which could only be CHECKED before the spawn: a connection that died
 * after that check left this child writing with no exclusion, so a second reconciliation could
 * acquire, read newer settings, write, and then be overtaken by this child finishing LAST with a
 * stale snapshot. Nothing to re-verify would have helped, because the write was already gone.
 *
 * Passing the lock fd as the child's fd 3 removes the window instead of narrowing it. An `flock`
 * belongs to an open file description, and `spawn` gives the child a DUPLICATE of ours; the kernel
 * releases the lock only when every duplicate is closed. So the exclusion covers this write for as
 * long as the child lives — including the case where this process is killed the instant after the
 * spawn, which is the one that produced the stale last write.
 *
 * `spawn`, not `execFile`, and that is load-bearing: `execFile` builds its own options for `spawn`
 * and DROPS `stdio`, so the descriptor would silently not reach the child and the lock would end at
 * this process again.
 */
function writeCrontab(contents: string, lockFd: number): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('crontab', ['-'], { stdio: ['pipe', 'ignore', 'pipe', lockFd] })
    let stderr = ''
    let settled = false
    const settle = (outcome: { success: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    // The same 5s bound the previous `execFile` carried, kept because the lock wait is sized from it.
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      settle({ success: false, error: 'crontab write failed: timed out after 5000ms' })
    }, CRONTAB_WRITE_TIMEOUT_MS)
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    proc.on('error', (err) => settle({ success: false, error: `crontab write failed: ${err.message}` }))
    proc.on('close', (code) => {
      if (code === 0) return settle({ success: true })
      settle({ success: false, error: `crontab write failed: ${stderr.trim() || `crontab exited ${code}`}` })
    })
    proc.stdin?.on('error', () => {
      // A crontab that exited before reading stdin surfaces as the non-zero close above.
    })
    proc.stdin?.write(contents)
    proc.stdin?.end()
  })
}

/**
 * What a `crontab -l` actually established — an ANSWER, or the fact that there was none.
 *
 * `present: false` is the genuinely absent crontab, and it is a resolved read: there is nothing
 * scheduled, and a reconciliation may splice its block into an empty file. `resolved: false` is
 * every other outcome, and it carries the reason instead of a value, because there is no value it
 * could carry that would not be a fabrication.
 */
export type CrontabReadResult =
  | { resolved: true; text: string; present: boolean }
  | { resolved: false; reason: string }

/**
 * THE APPLICATION'S OWN READ, FAILING CLOSED (o3d-p9dq, Codex r29 HIGH #1).
 *
 * This resolved `err ? empty-string : stdout` — every timeout, permission denial, spool I/O error and
 * failed fork became the empty string. `applyCrontabFromSettings` then spliced the managed block
 * into that fabricated empty crontab and handed it to `crontab -`, so a read that failed while the
 * WRITE would have succeeded deleted every unmanaged operator line in the file and reported a
 * successful reconciliation. That is the identical shape this branch closed in the three shell
 * entrypoints and in the thirteen `crontab -l` call sites behind them; it had no business
 * surviving in the TypeScript reader the branch is named after.
 *
 * The discrimination is `isNoCrontabDiagnostic` — the SAME rule the shell reader applies, held to
 * it by an executed cross-check rather than by a comment. Its derivation, why the exit status
 * alone cannot decide, and why there are two copies at all are documented on that function in
 * lib/crontab-sync.ts.
 *
 * There is no timeout branch to special-case: `execFile` `timeout` kills the child and reports
 * it as an error like any other, and an error is unresolved.
 */
export function readOwnCrontabResult(): Promise<CrontabReadResult> {
  const user = (() => {
    try { return os.userInfo().username } catch { return '' }
  })()
  return new Promise<CrontabReadResult>((resolve) => {
    execFile('crontab', ['-l'], { timeout: 5000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
      const errText = typeof stderr === 'string' ? stderr : String(stderr ?? '')
      if (!err) return resolve({ resolved: true, text: out, present: true })
      // Non-zero AND empty stdout AND the one benign diagnostic, whole — all three, or nothing.
      if (out === '' && user && isNoCrontabDiagnostic(user, errText)) {
        return resolve({ resolved: true, text: '', present: false })
      }
      const said = errText.trim() || 'nothing at all'
      resolve({
        resolved: false,
        reason: `\`crontab -l\` failed and did not answer that ${user || 'this user'} has no crontab`
          + ` — it said: ${said}. An unreadable crontab is not an empty one`,
      })
    })
  })
}

/**
 * Prefer cron lines that read CRON_SECRET from the app's .env at RUNTIME
 * (ryxy: an embedded literal silently 401'd every managed job after a secret
 * rotation) — but ONLY when the Node-side emulation of the exact shell
 * pipeline proves the .env yields the ACTIVE process secret byte-for-byte
 * (Codex: line presence alone chose runtime mode even when the .env value was
 * stale, exotic, or shadowed by a service-manager override). Everything else
 * embeds the current literal, which is always correct at sync time.
 */
export function resolveSecretRef(secret: string): CrontabSecretRef {
  const envFilePath = path.join(process.cwd(), '.env')
  try {
    if (
      isCronSafePath(envFilePath)
      && existsSync(envFilePath)
      && emulateRuntimeSecretExtraction(readFileSync(envFilePath, 'utf8')) === secret
    ) {
      return { kind: 'env-file', envFilePath }
    }
  } catch {
    // unreadable .env → embedded fallback below
  }
  return { kind: 'literal', secret }
}

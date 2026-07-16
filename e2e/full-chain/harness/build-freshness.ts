/**
 * Is the server this suite is about to test actually running the code in this tree?
 * (o3d-0qk)
 *
 * The full-chain rig serves a PRODUCTION build: ims-e2e-dev.service runs `npm run start`,
 * which loads `.next` at boot and serves it unchanged. So there are two ways to spend four
 * minutes testing something other than your working tree:
 *
 *   1. you edited code and did not rebuild   -> `.next` is older than the source;
 *   2. you rebuilt but did not restart       -> the running process predates the build.
 *
 * Neither is hypothetical. `npm run e2e:full-chain` neither builds nor restarts, the
 * Playwright config declares no `webServer` (deliberately — a managed one would load .env
 * and resolve the STAGE database), and the unit's ExecStartPre only checks that `.next`
 * EXISTS, not that it matches anything. The whole of Phase 2 was run by rebuilding and
 * restarting by hand, which is exactly the discipline that fails the once it matters — a
 * green run that proves nothing is worse than a red one.
 *
 * WHY MTIMES AND NOT A GIT SHA. Stamping `git rev-parse HEAD` into the build and comparing
 * would miss the most common case by construction: the SHA is IDENTICAL before and after an
 * uncommitted edit, and "edit, run the suite, forget to build" is precisely the trap. File
 * mtimes catch uncommitted work; a SHA cannot.
 *
 * WHY NOT ASK THE SERVER. The public health route is unauthenticated and internet-facing;
 * teaching it to report a build identity would leak version information to the world for a
 * test's convenience. Everything here runs on the same box as the server, so the filesystem
 * and the service manager are better sources than an HTTP endpoint anyway.
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'

/**
 * Tracked paths that are NOT compiled into the Next build, so changing them cannot make the
 * served build stale.
 *
 * Deliberately an EXCLUDE list, not an include list. The failure directions are asymmetric:
 * a path wrongly excluded means a stale build slips through — the exact bug this guards
 * against — whereas a path wrongly included only asks for an unnecessary rebuild. So the
 * default is "this counts", and every entry below has to earn its place by being obviously
 * outside the bundle. `scripts/` is here because it is standalone tsx run by hand; the
 * first draft of this check flagged a scripts/ edit as a stale build, which is the kind of
 * false positive that teaches people to ignore the guard.
 */
const NON_BUILD_PATHS = [
  ':(exclude)e2e',
  ':(exclude)tests',
  ':(exclude)docs',
  ':(exclude)scripts',
  ':(exclude)deploy',
  ':(exclude).github',
  ':(exclude)*.md',
]

export type BuildFacts = {
  /** mtime of the newest tracked file that is compiled into the build. */
  newestSourceMs: number | null
  newestSourcePath: string | null
  /** mtime of the build marker, i.e. when the build finished. */
  buildMs: number | null
  /** When the serving process started, or null if it could not be determined. */
  serverStartMs: number | null
}

export type FreshnessReport = { problems: string[]; warnings: string[] }

/**
 * systemd reports timestamps to the second, while stat gives sub-second precision. Compare
 * both floored to the second, so a build finishing at 23.85 and a restart at 23.90 does not
 * read as "the server predates the build". The cost is a blind spot narrower than one
 * second, which no human rebuild-and-restart can fit inside.
 */
const sec = (ms: number) => Math.floor(ms / 1000)

/** Pure so the decision is testable without a filesystem, a build, or systemd. */
export function evaluateBuildFreshness(facts: BuildFacts): FreshnessReport {
  const problems: string[] = []
  const warnings: string[] = []

  if (facts.buildMs === null) {
    problems.push(
      'No production build found (.next/BUILD_ID is missing). The rig serves `npm run start`, ' +
        'which needs one. Build as the service user, then restart as root:\n' +
        '  runuser -u ims -- npm run build && systemctl restart ims-e2e-dev.service',
    )
    return { problems, warnings }
  }

  if (facts.newestSourceMs === null) {
    warnings.push('Could not list tracked source files, so build staleness was NOT checked.')
  } else if (facts.newestSourceMs > facts.buildMs) {
    const drift = Math.round((facts.newestSourceMs - facts.buildMs) / 1000)
    problems.push(
      `STALE BUILD: ${facts.newestSourcePath} was modified ${drift}s AFTER the last build, so the ` +
        'server is not running this tree. The suite would pass or fail on code you are not testing. ' +
        'Build as the service user, then restart as root:\n' +
        '  runuser -u ims -- npm run build && systemctl restart ims-e2e-dev.service',
    )
  }

  if (facts.serverStartMs === null) {
    warnings.push(
      'Could not read the service start time, so "rebuilt but not restarted" was NOT checked. ' +
        'If the server is not managed by ims-e2e-dev.service, restart it yourself after a build.',
    )
  } else if (sec(facts.serverStartMs) < sec(facts.buildMs)) {
    problems.push(
      'SERVER PREDATES THE BUILD: a build finished after the server started, and `npm run start` ' +
        'serves whatever it loaded at boot — so the new build is on disk but not being served. ' +
        'Restart as root: systemctl restart ims-e2e-dev.service',
    )
  }

  return { problems, warnings }
}

function newestTrackedSource(cwd: string): { ms: number | null; path: string | null } {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', '.', ...NON_BUILD_PATHS], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    })
    let newest = 0
    let newestPath: string | null = null
    for (const file of out.toString('utf8').split('\0')) {
      if (!file) continue
      try {
        const ms = statSync(`${cwd}/${file}`).mtimeMs
        if (ms > newest) {
          newest = ms
          newestPath = file
        }
      } catch {
        // Tracked but absent from the working tree (e.g. mid-checkout). Not our concern.
      }
    }
    return newestPath ? { ms: newest, path: newestPath } : { ms: null, path: null }
  } catch {
    return { ms: null, path: null }
  }
}

function serviceStartMs(unit: string): number | null {
  try {
    const raw = execFileSync('systemctl', ['show', unit, '--property=ExecMainStartTimestamp', '--value'], {
      encoding: 'utf8',
    }).trim()
    if (!raw) return null
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export function collectBuildFacts(cwd = process.cwd()): BuildFacts {
  const source = newestTrackedSource(cwd)
  let buildMs: number | null = null
  try {
    // BUILD_ID is written when the build completes, so its mtime is the build's finish time.
    buildMs = statSync(`${cwd}/.next/BUILD_ID`).mtimeMs
  } catch {
    buildMs = null
  }
  return {
    newestSourceMs: source.ms,
    newestSourcePath: source.path,
    buildMs,
    serverStartMs: serviceStartMs(process.env.FULL_CHAIN_SERVICE ?? 'ims-e2e-dev.service'),
  }
}

export function checkBuildFreshness(cwd = process.cwd()): FreshnessReport {
  return evaluateBuildFreshness(collectBuildFacts(cwd))
}

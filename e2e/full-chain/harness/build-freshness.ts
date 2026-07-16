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
import { readdirSync, statSync, type Dirent } from 'node:fs'

/**
 * Directory names that never contribute to the served bundle, skipped during the walk.
 *
 * Deliberately an EXCLUDE list, not an include list. The failure directions are asymmetric:
 * a path wrongly excluded means a stale build slips through — the exact bug this guards
 * against — whereas a path wrongly included only asks for an unnecessary rebuild. So the
 * default is "this counts", and every entry has to earn its place by being obviously outside
 * the bundle. `scripts` is here because it is standalone tsx run by hand; the first draft
 * flagged a scripts/ edit as a stale build, which is the kind of false positive that teaches
 * people to ignore a guard.
 *
 * `node_modules` and `.next` are skipped for cost, not correctness: a dependency change
 * arrives as a package.json/lockfile edit, which the walk sees.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.cache', '.npm-cache', '.npm', '.local', '.config',
  'e2e', 'tests', 'docs', 'scripts', 'deploy', '.github',
  'test-results', 'playwright-report', 'blob-report', '.pwprobe',
  // Written CONSTANTLY at runtime or by tooling. Without these the guard reports a stale
  // build after every bd command or invoice PDF — noise that would get it ignored, and an
  // ignored guard is worse than none.
  '.beads', '.beads-hooks', '.remember', 'data',
])

/**
 * Files that cannot affect the bundle.
 * .tsbuildinfo is tsc's incremental cache — running `npx tsc --noEmit` rewrites it, so a
 * type-check would otherwise "prove" the build stale.
 */
const SKIP_FILE = (name: string) =>
  name.endsWith('.md') ||
  name.endsWith('.tsbuildinfo') ||
  name.startsWith('.full-chain-') ||
  name.startsWith('.tmp-')

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

  // "Could not check" FAILS, it does not warn (found in review of PR #489).
  //
  // The first cut warned and carried on, which is a guard that fails OPEN: the two ways the
  // check goes blind — an unscannable tree, an unreadable service — are exactly the states in
  // which a stale build sails through, and a warning nobody reads is indistinguishable from
  // no check at all. checkBuildFreshness has already established that the server under test IS
  // this box's systemd unit, so both facts are readable here as a matter of course; failing to
  // read them is anomalous and worth stopping for. FULL_CHAIN_SKIP_FRESHNESS=true is the
  // escape hatch for the genuinely odd case (a hand-started server), and it is explicit —
  // someone chose it, rather than a silent degrade choosing for them.
  if (facts.newestSourceMs === null) {
    problems.push(
      'Could not scan the source tree, so build staleness could NOT be checked and this run ' +
        'cannot be trusted. Set FULL_CHAIN_SKIP_FRESHNESS=true to override deliberately.',
    )
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
    problems.push(
      'Could not read the start time of ims-e2e-dev.service, so "rebuilt but not restarted" ' +
        'could NOT be checked — the server may be serving a build older than the one on disk. ' +
        'If it is not managed by that unit, set FULL_CHAIN_SERVICE, or ' +
        'FULL_CHAIN_SKIP_FRESHNESS=true to override deliberately.',
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

/**
 * Newest mtime among everything that feeds the bundle, by walking the FILESYSTEM.
 *
 * NOT `git ls-files`. The first cut used it and had three false negatives — all in the
 * dangerous direction, where a stale build passes (found in review of PR #489):
 *   - an UNTRACKED new file (add app/api/foo/route.ts after building) is not tracked, so it
 *     was invisible and the stale build passed;
 *   - a DELETED file made statSync throw into a swallowing catch, so the bundle kept serving
 *     a route the tree no longer has;
 *   - the GENERATED PRISMA CLIENT (app/generated/prisma) is gitignored yet imported by
 *     lib/db and compiled in, so regenerating it changed the build invisibly.
 * "Tracked" was simply the wrong universe: the build reads the filesystem, so the check must
 * read the filesystem.
 *
 * DIRECTORY mtimes count too, which is what catches deletions: removing a file cannot be seen
 * by looking at files, but it does bump its parent directory's mtime.
 */
function newestSource(cwd: string): { ms: number | null; path: string | null } {
  let newest = 0
  let newestPath: string | null = null

  const walk = (dir: string, rel: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // A directory's own mtime changes when an entry is added or removed — the only signal a
    // DELETION leaves behind, since the deleted file cannot be stat'd.
    //
    // The repo ROOT is excluded from that, though: it is a dumping ground for transient
    // artifacts, and a skipped FILE still bumps its parent's mtime. The harness itself writes
    // .full-chain-run-id there on every run, so counting the root would have made the guard
    // report a stale build after every single run — self-inflicted noise, and noise is how a
    // guard gets ignored. The cost is that deleting a TOP-LEVEL file goes unnoticed; deletions
    // inside app/, lib/, components/ — where source actually lives — are still caught, and
    // deleting next.config.ts breaks the build far too loudly to need this check.
    if (rel) {
      try {
        const dms = statSync(dir).mtimeMs
        if (dms > newest) {
          newest = dms
          newestPath = rel
        }
      } catch { /* raced away mid-walk */ }
    }

    for (const e of entries) {
      if (e.isSymbolicLink()) continue // do not follow; a symlink's target is someone else's tree
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(`${dir}/${e.name}`, childRel)
      } else if (e.isFile() && !SKIP_FILE(e.name)) {
        try {
          const ms = statSync(`${dir}/${e.name}`).mtimeMs
          if (ms > newest) {
            newest = ms
            newestPath = childRel
          }
        } catch { /* raced away mid-walk */ }
      }
    }
  }

  walk(cwd, '')
  return newestPath ? { ms: newest, path: newestPath } : { ms: null, path: null }
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
  const source = newestSource(cwd)
  let buildMs: number | null = null
  try {
    // BUILD_ID is NOT written at the end of the build — verified against the installed Next
    // 16.2.10, where it lands before static generation and trace finalisation (its mtime is a
    // second behind .next/trace and the manifests). An earlier draft of this comment claimed
    // otherwise and was simply wrong.
    //
    // Keeping BUILD_ID anyway, because being EARLY is the safe direction here: it understates
    // when the build finished, so the "source newer than build" test is if anything too eager,
    // and an over-eager rebuild prompt costs two minutes while a missed one costs a green run
    // that proved nothing. Using the newest .next artefact instead would overstate the finish
    // time and start hiding real staleness.
    //
    // The narrow gap this leaves: a file edited AFTER the compiler read it but BEFORE BUILD_ID
    // is written reads as older than the build and is missed. That needs an edit landing
    // inside a specific second of a running build — accepted rather than engineered around.
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

/** The rig this check can actually reason about: the local tree + the local systemd unit. */
const LOCAL_RIG_URL = 'https://ims-e2e.onetwo3d.co.uk'

export function checkBuildFreshness(cwd = process.cwd()): FreshnessReport {
  // Only meaningful when the server under test IS the one this box builds and runs.
  //
  // Everything here reads the local filesystem and the local systemd unit, while Playwright
  // aims at E2E_BASE_URL — so pointed at any other server the check answers a question nobody
  // asked, in both directions: a fresh local build would vouch for a stale remote one, and a
  // legitimately fresh hand-started server would be blocked by an unrelated stale unit. Say
  // that plainly instead of pretending to have checked (found in review of PR #489).
  if (process.env.FULL_CHAIN_SKIP_FRESHNESS === 'true') {
    return {
      problems: [],
      warnings: ['FULL_CHAIN_SKIP_FRESHNESS=true — build freshness was NOT checked. This run cannot prove which code it tested.'],
    }
  }

  const baseUrl = process.env.E2E_BASE_URL ?? LOCAL_RIG_URL
  if (baseUrl !== LOCAL_RIG_URL) {
    return {
      problems: [],
      warnings: [
        `E2E_BASE_URL is ${baseUrl}, not the local rig (${LOCAL_RIG_URL}), so the build-freshness ` +
          'check was NOT run: it can only vouch for the server this box builds and starts. ' +
          'Whatever is serving that URL may be running any code at all.',
      ],
    }
  }
  return evaluateBuildFreshness(collectBuildFacts(cwd))
}

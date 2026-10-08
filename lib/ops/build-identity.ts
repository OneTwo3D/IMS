/**
 * WHICH BUILD IS THIS? One immutable identifier, computed the same way by the fresh-install rehearsal
 * (which records it) and the readiness gate (which requires it to match).
 *
 * The identifier is the git COMMIT and the git TREE object of the checkout, plus whether the working tree
 * is CLEAN, and the REAL PATH of the checkout it was read from. It is not a release artefact digest: deploy.sh's BUILD_ID exists only after `next build`, and
 * the fence artefact digest (IMS_FENCE_ARTEFACT_SHA256) names the cut-over driver, not the application, so
 * neither can be computed from the source tree a rehearsal runs on. A commit plus its tree is what both
 * sides can compute from a checkout, and a dirty tree has no immutable identity, so it never matches.
 *
 * THE SCOPE, stated wherever a verdict is: source commit and tree only. It does NOT cover the build artefact
 * (`.next/BUILD_ID`) or the `.env` configuration, which are ignored by git. A different checkout path is
 * surfaced as a warning (BUILD_IDENTITY_TEXT.differentPath).
 *
 * `git` is run without a shell, with a two-variable environment, read-only commands only.
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

export type BuildIdentity = { commit: string; tree: string; clean: boolean; /** realpath of the checkout the identity was read from */ path: string }

const OBJECT_ID = /^[0-9a-f]{40}$/

/** The single-sourced operator text for a build that does not match, or cannot be identified. */
export const BUILD_IDENTITY_TEXT = {
  absent: 'the rehearsal report carries no build identifier (it was made before reports recorded one), so it cannot be tied to this build; run `npm run rehearse:first-install` from this checkout',
  malformed: 'the rehearsal report carries a build identifier this gate cannot read, so it cannot be tied to this build',
  reportDirty: 'the rehearsal ran on a checkout with uncommitted changes, so its build has no immutable identity',
  gateDirty: 'this checkout has uncommitted changes, so this build has no immutable identity to match a rehearsal against',
  gateUnreadable: 'the build identity of this checkout could not be read',
  mismatch: (reportCommit: string, gateCommit: string) => `the rehearsal was run on commit ${reportCommit}, not on this build (commit ${gateCommit}); run \`npm run rehearse:first-install\` from this checkout`,
  differentPath: (reportPath: string, gatePath: string) => `rehearsal ran on a different checkout path (${reportPath}), not this one (${gatePath}); the commit and source tree match, but ignored files such as .env and .next are outside that identity and may differ`,
  treeMismatch: (reportTree: string, gateTree: string) => `the rehearsal's source tree ${reportTree} is not this build's source tree ${gateTree}`,
} as const

export function isBuildIdentity(value: unknown): value is BuildIdentity {
  const v = value as Partial<BuildIdentity> | null
  return v !== null && typeof v === 'object'
    && typeof v.commit === 'string' && OBJECT_ID.test(v.commit)
    && typeof v.tree === 'string' && OBJECT_ID.test(v.tree)
    && typeof v.clean === 'boolean'
    && typeof v.path === 'string' && v.path.startsWith('/')
}

export type GitRunner = (args: string[]) => string

export function defaultGit(repoRoot: string): GitRunner {
  return (args) => execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', GIT_OPTIONAL_LOCKS: '0' } as unknown as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Throws when the identity cannot be read. */
export function readBuildIdentity(repoRoot: string, git: GitRunner = defaultGit(repoRoot)): BuildIdentity {
  const commit = git(['rev-parse', 'HEAD']).trim()
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim()
  const dirty = git(['status', '--porcelain']).trim() !== ''
  const identity = { commit, tree, clean: !dirty, path: realpathSync(repoRoot) }
  if (!isBuildIdentity(identity)) throw new Error('git did not return commit and tree object ids')
  return identity
}

export type BuildWarning = { id: string; message: string }
export type BuildComparison = { ok: true; warnings: BuildWarning[] } | { ok: false; kind: 'absent' | 'malformed' | 'report-dirty' | 'gate-dirty' | 'mismatch'; message: string }

/** The one comparison. `report` is whatever the rehearsal report held (undefined = absent). */
export function compareBuildIdentity(report: unknown, gate: BuildIdentity): BuildComparison {
  if (!gate.clean) return { ok: false, kind: 'gate-dirty', message: BUILD_IDENTITY_TEXT.gateDirty }
  if (report === undefined || report === null) return { ok: false, kind: 'absent', message: BUILD_IDENTITY_TEXT.absent }
  if (!isBuildIdentity(report)) return { ok: false, kind: 'malformed', message: BUILD_IDENTITY_TEXT.malformed }
  if (!report.clean) return { ok: false, kind: 'report-dirty', message: BUILD_IDENTITY_TEXT.reportDirty }
  if (report.commit !== gate.commit) return { ok: false, kind: 'mismatch', message: BUILD_IDENTITY_TEXT.mismatch(report.commit, gate.commit) }
  if (report.tree !== gate.tree) return { ok: false, kind: 'mismatch', message: BUILD_IDENTITY_TEXT.treeMismatch(report.tree, gate.tree) }
  // The same commit and tree in a DIFFERENT checkout: the ignored files (.env, .next) can differ, and the
  // identity does not cover them, so this is surfaced as a warning that needs a written acceptance.
  if (report.path !== gate.path) {
    return { ok: true, warnings: [{ id: `rehearsal-different-checkout-path:${report.path}->${gate.path}`, message: BUILD_IDENTITY_TEXT.differentPath(report.path, gate.path) }] }
  }
  return { ok: true, warnings: [] }
}

/**
 * check:docs-required — a PR that changes behaviour-bearing code changes docs in the same PR, or carries a
 * reasoned `Docs: none — <reason>` line in a changelog.d fragment it adds.
 *
 * The pure decision is tested directly; the git plumbing (merge-base, push/PR base, vacuous range) is run
 * end to end as a subprocess against a throwaway repo. No network: git runs on local temp repos only.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  CI_ONLY_GUARDS,
  evaluateDocsRequired,
  findOptOuts,
  isBehaviourPath,
  isDocPath,
  isRevertOnly,
  MIN_REASON_LENGTH,
  parseAddedLines,
  reasonProblem,
} from '@/scripts/check-docs-required.mjs'

import { createTempDirSync } from './temp-dir.ts'

// An em dash, built at runtime so the source stays plain ASCII.
const EM = String.fromCharCode(0x2014)
const EN = String.fromCharCode(0x2013)
const REASON = 'internal refactor, no behaviour or UI change'

test('behaviour-bearing paths', () => {
  for (const p of [
    'app/sales/page.tsx',
    'app/api/cron/x/route.ts',
    'lib/domain/inventory/fifo.ts',
    'components/ui/button.tsx',
    'prisma/schema.prisma',
    'prisma/migrations/20990101000000_x/migration.sql',
    'scripts/cli.ts',
    'scripts/update.sh',
    'scripts/lib/thing.ts',
    'deploy/bin/deploy.sh',
    'deploy/systemd/ims-stage.service',
    'proxy.ts',
    'next.config.ts',
    'instrumentation.ts',
    'sentry.server.config.ts',
    'sentry.edge.config.ts',
    'prisma.config.ts',
    'prisma/seed.ts',
    'Dockerfile',
  ]) assert.equal(isBehaviourPath(p), true, p)
})

test('narrow exclusions and non-behaviour paths', () => {
  for (const p of [
    'lib/foo.test.ts',
    'app/x/page.spec.tsx',
    'lib/__tests__/a.ts',
    'lib/__mocks__/b.ts',
    'lib/types/global.d.ts',
    'lib/connectors/README.md',
    'deploy/README.md',
    'deploy/tests/run.sh',
    'deploy/tests/stubs/curl',
    'lib/releases.ts',
    'scripts/check-docs-required.mjs',
    'scripts/check-producer-census.ts',
    'scripts/check-migration-conventions.mjs',
    'scripts/producer-census-declarations.ts',
    'scripts/ledger-standing-reader-declarations.mjs',
    'scripts/decimal-boundary-targets.json',
    'scripts/cogs-e2e-fixture.ts',
    'scripts/validate-local.sh',
    'scripts/e2e-select.mjs',
    'tests/foo.test.ts',
    'e2e/x.spec.ts',
    'package.json',
    'package-lock.json',
    '.github/workflows/static-guards.yml',
    'CHANGELOG.md',
    'changelog.d/x.md',
    'types/next-auth.d.ts',
    'public/logo.png',
  ]) assert.equal(isBehaviourPath(p), false, p)
  // Exclusions are anchored and explicit: a file merely NAMED like a tool elsewhere is still behaviour.
  assert.equal(isBehaviourPath('scripts/check-new-guard.mjs'), true, 'a new check-* script is behaviour until listed as CI-only')
  assert.equal(isBehaviourPath('lib/check-stock.ts'), true)
  assert.equal(isBehaviourPath('lib/releases-view.ts'), true)
  assert.equal(isBehaviourPath('scripts/sub/check-x.ts'), true)
})

test('documentation paths', () => {
  for (const p of ['docs/sales.md', 'docs/agent/env-vars.md', 'help-docs/sales.md', 'README.md', 'deploy/README.md', '.env.example'])
    assert.equal(isDocPath(p), true, p)
  for (const p of ['docs/scratch/x.md', 'docs/todo/plan.md', 'docs/completed/p.md', 'docs/archive/a.md', 'CHANGELOG.md',
    'changelog.d/x.md', 'CLAUDE.md', 'AGENTS.md', 'lib/README.md', 'app/docs/page.tsx'])
    assert.equal(isDocPath(p), false, p)
})

test('parseAddedLines reads + lines with their file and ignores headers, deletions and context', () => {
  const patch = [
    'diff --git a/changelog.d/a.md b/changelog.d/a.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/changelog.d/a.md',
    '@@ -0,0 +1,2 @@',
    '+### Title (area)',
    `+Docs: none ${EM} ${REASON}`,
    'diff --git a/changelog.d/b.md b/changelog.d/b.md',
    'deleted file mode 100644',
    '--- a/changelog.d/b.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-Docs: none ${EM} ${REASON}`,
    'diff --git a/changelog.d/c.md b/changelog.d/c.md',
    '--- a/changelog.d/c.md',
    '+++ b/changelog.d/c.md',
    '@@ -1 +1 @@',
    '-old',
    '+++ content that looks like a header',
  ].join('\n')
  assert.deepEqual(parseAddedLines(patch), [
    { file: 'changelog.d/a.md', line: '### Title (area)', newFile: true },
    { file: 'changelog.d/a.md', line: `Docs: none ${EM} ${REASON}`, newFile: true },
    { file: 'changelog.d/c.md', line: '++ content that looks like a header', newFile: false },
  ])
})

test('opt-out marker: accepted separators and forms', () => {
  for (const line of [
    `Docs: none ${EM} ${REASON}`,
    `Docs: none ${EN} ${REASON}`,
    `docs: NONE - ${REASON}`,
    `Docs: none -- ${REASON}`,
    `Docs: none: ${REASON}`,
    `- Docs: none ${EM} ${REASON}`,
    `* Docs:none${EM}${REASON}`,
  ]) {
    const r = findOptOuts([{ file: 'changelog.d/x.md', line }])
    assert.deepEqual(r.errors, [], line)
    assert.deepEqual(r.accepted, [{ file: 'changelog.d/x.md', reason: REASON }], line)
  }
})

test('opt-out marker: a bare or placeholder reason is an error, not an opt-out', () => {
  for (const line of [
    'Docs: none',
    `Docs: none ${EM}`,
    `Docs: none ${EM} n/a`,
    `Docs: none ${EM} <reason>`,
    `Docs: none ${EM} none`,
    `Docs: none ${EM} tbd`,
    `Docs: none ${EM} ${'x'.repeat(MIN_REASON_LENGTH - 1)}`,
  ]) {
    const r = findOptOuts([{ file: 'changelog.d/x.md', line }])
    assert.equal(r.accepted.length, 0, line)
    assert.equal(r.errors.length, 1, line)
  }
  // exactly the minimum is enough (three words, 20 characters)
  const minimal = 'abc defgh ijklmnopqr'
  assert.equal(minimal.length, MIN_REASON_LENGTH)
  assert.equal(findOptOuts([{ file: 'changelog.d/x.md', line: `Docs: none ${EM} ${minimal}` }]).accepted.length, 1)
})

// [mutation: keep the old `none\b` prefix]
test('L4: prose that starts "Docs: none" without a separator is not a marker (neither accepted nor an error)', () => {
  for (const line of ['Docs: none of the help pages needed a change here', 'Docs: none.', 'Docs: none needed', '- Docs: nonetheless updated']) {
    assert.deepEqual(findOptOuts([{ file: 'changelog.d/x.md', line }]), { accepted: [], errors: [] }, line)
  }
  // the separators and the end of the line still make it a marker
  assert.equal(findOptOuts([{ file: 'changelog.d/x.md', line: 'Docs: none' }]).errors.length, 1)
  assert.equal(findOptOuts([{ file: 'changelog.d/x.md', line: `Docs: none${EN}${REASON}` }]).accepted.length, 1)
})

// [mutation: drop the word count; drop the repeated-run check]
test('L5: a junk reason is refused: fewer than three words, or a run of repeated characters', () => {
  for (const reason of ['internal-refactor-of-the-consumer only', 'xxxxxxxxxxxxxxxxxxxxxxxx', 'aaaaaaaa bbbbbbbb cccccccc', 'refactor ..... nothing changed']) {
    assert.ok(reasonProblem(reason), reason)
    const r = findOptOuts([{ file: 'changelog.d/x.md', line: `Docs: none ${EM} ${reason}` }])
    assert.equal(r.accepted.length, 0, reason)
    assert.equal(r.errors.length, 1, reason)
  }
  assert.equal(reasonProblem(REASON), null)
})

// [mutation: count a marker added to an older (modified) fragment]
test('L6: a marker counts only in a fragment the change ADDS', () => {
  const line = `Docs: none ${EM} ${REASON}`
  assert.deepEqual(findOptOuts([{ file: 'changelog.d/old.md', line, newFile: false }]), { accepted: [], errors: [] })
  assert.equal(findOptOuts([{ file: 'changelog.d/new.md', line, newFile: true }]).accepted.length, 1)
  const patch = [
    'diff --git a/changelog.d/old.md b/changelog.d/old.md',
    '--- a/changelog.d/old.md',
    '+++ b/changelog.d/old.md',
    '@@ -1 +1,2 @@',
    `+${line}`,
    'diff --git a/changelog.d/new.md b/changelog.d/new.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/changelog.d/new.md',
    '@@ -0,0 +1 @@',
    `+${line}`,
  ].join('\n')
  assert.deepEqual(parseAddedLines(patch).map((x) => [x.file, x.newFile]), [['changelog.d/old.md', false], ['changelog.d/new.md', true]])
  const r = evaluateDocsRequired({ changedFiles: ['lib/a.ts', 'changelog.d/old.md'], addedLines: parseAddedLines(patch).filter((x) => x.file === 'changelog.d/old.md') })
  assert.equal(r.ok, false)
})

// [mutation: drop the revert reason; drop the revert-only pass; pass a range with one non-revert commit]
test('L7: "Docs: none - revert of #N" is accepted, and a range of git reverts only passes', () => {
  assert.equal(findOptOuts([{ file: 'changelog.d/x.md', line: `Docs: none ${EM} revert of #1234` }]).accepted.length, 1)
  assert.equal(reasonProblem('Revert of #7'), null)
  assert.ok(reasonProblem('revert of something'))
  assert.equal(isRevertOnly(['Revert "feat: x (#12)"']), true)
  assert.equal(isRevertOnly(['Revert "feat: x (#12)"', 'fix: y']), false)
  assert.equal(isRevertOnly([]), false)
  assert.equal(evaluateDocsRequired({ changedFiles: ['lib/a.ts'], addedLines: [], commitSubjects: ['Revert "feat: x (#12)"'] }).ok, true)
  assert.equal(evaluateDocsRequired({ changedFiles: ['lib/a.ts'], addedLines: [], commitSubjects: ['Revert "feat: x"', 'more code'] }).ok, false)
})

// [mutation: keep the unanchored *.md exclusion]
test('L10: only a README.md or a docs/ page next to code is excluded; other Markdown under a behaviour path counts', () => {
  for (const p of ['lib/connectors/README.md', 'app/README.md', 'lib/x/docs/notes.md']) assert.equal(isBehaviourPath(p), false, p)
  for (const p of ['lib/prompts/system.md', 'app/emails/template.md', 'components/help/intro.md']) assert.equal(isBehaviourPath(p), true, p)
})

test('opt-out marker: only counts in a changelog.d fragment (not README, not elsewhere)', () => {
  const line = `Docs: none ${EM} ${REASON}`
  for (const file of ['changelog.d/README.md', 'docs/x.md', 'CHANGELOG.md', 'changelog.d/sub/x.md', 'lib/x.ts']) {
    const r = findOptOuts([{ file, line }])
    assert.deepEqual(r, { accepted: [], errors: [] }, file)
  }
  // prose that mentions docs is not a marker
  assert.deepEqual(findOptOuts([{ file: 'changelog.d/x.md', line: '- Docs: updated sales.md' }]), { accepted: [], errors: [] })
})

test('evaluate: behaviour change with no docs and no opt-out fails and names the paths and the opt-out syntax', () => {
  const r = evaluateDocsRequired({ changedFiles: ['lib/a.ts', 'tests/a.test.ts', 'changelog.d/x.md'], addedLines: [] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.behaviour, ['lib/a.ts'])
  const out = r.lines.join('\n')
  assert.match(out, /FAILED/)
  assert.match(out, /lib\/a\.ts/)
  assert.match(out, /Docs: none/)
})

test('evaluate: behaviour change with a docs change passes and lists the docs', () => {
  const r = evaluateDocsRequired({ changedFiles: ['app/x/page.tsx', 'help-docs/sales.md'], addedLines: [] })
  assert.equal(r.ok, true)
  assert.match(r.lines.join('\n'), /help-docs\/sales\.md/)
})

test('evaluate: a scratch or plan doc does not satisfy the rule', () => {
  const r = evaluateDocsRequired({ changedFiles: ['lib/a.ts', 'docs/scratch/design.md', 'docs/todo/plan.md'], addedLines: [] })
  assert.equal(r.ok, false)
})

test('evaluate: behaviour change with a valid opt-out passes and PRINTS the accepted reason', () => {
  const r = evaluateDocsRequired({
    changedFiles: ['lib/a.ts', 'changelog.d/x.md'],
    addedLines: [{ file: 'changelog.d/x.md', line: `Docs: none ${EM} ${REASON}` }],
  })
  assert.equal(r.ok, true)
  assert.match(r.lines.join('\n'), new RegExp(`Accepted reason \\(changelog\\.d/x\\.md\\): ${REASON}`))
})

test('evaluate: a malformed marker fails even when docs changed or nothing needs docs', () => {
  for (const changedFiles of [['lib/a.ts', 'docs/x.md', 'changelog.d/x.md'], ['tests/a.test.ts', 'changelog.d/x.md']]) {
    const r = evaluateDocsRequired({ changedFiles, addedLines: [{ file: 'changelog.d/x.md', line: 'Docs: none' }] })
    assert.equal(r.ok, false, changedFiles.join(','))
    assert.match(r.lines.join('\n'), /Malformed docs opt-out/)
  }
})

test('evaluate: no behaviour-bearing change passes (tests, CI, deps, docs only)', () => {
  const r = evaluateDocsRequired({ changedFiles: ['tests/a.test.ts', 'package.json', '.github/workflows/x.yml', 'lib/releases.ts'], addedLines: [] })
  assert.equal(r.ok, true)
  assert.match(r.lines.join('\n'), /no behaviour-bearing path changed/)
})

// ---- end to end against a throwaway git repo -------------------------------------------------------------
const SCRIPT = join(process.cwd(), 'scripts/check-docs-required.mjs')

function repo(t: import('node:test').TestContext) {
  const dir = createTempDirSync('ims-docsreq-', t)
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  const commit = (msg: string) => {
    g('add', '-A')
    g('commit', '-q', '-m', msg)
    return g('rev-parse', 'HEAD')
  }
  g('init', '-q', '-b', 'development')
  put('lib/a.ts', 'export const a = 1\n')
  put('docs/a.md', '# a\n')
  put('changelog.d/old.md', `### Old (x)\nDocs: none ${EM} ${REASON}\n`)
  const base = commit('base')
  return { dir, g, put, commit, base }
}

function run(dir: string, env: Record<string, string>, args: string[] = []) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...env } as unknown as NodeJS.ProcessEnv })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

test('e2e: PR path (origin/<base> vs HEAD) fails a code-only change, and an old fragment marker is not reused', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  g('update-ref', 'refs/remotes/origin/development', base)
  put('lib/a.ts', 'export const a = 2\n')
  commit('code')
  const r = run(dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /FAILED/)
  assert.match(r.out, /lib\/a\.ts/)
})

test('e2e: merge-base is used, so base-branch changes after the fork do not count either way', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  g('checkout', '-q', '-b', 'feat')
  put('lib/a.ts', 'export const a = 2\n')
  commit('code on feature')
  g('checkout', '-q', 'development')
  put('docs/b.md', '# docs added on the base after the fork\n')
  const advanced = commit('base advances with a doc')
  g('checkout', '-q', 'feat')
  g('update-ref', 'refs/remotes/origin/development', advanced)
  const r = run(dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 1, `a doc that landed on the base must not satisfy the PR: ${r.out}`)
  assert.notEqual(advanced, base)
})

test('e2e: opt-out in an added fragment passes and prints the reason; a docs change passes', (t) => {
  const a = repo(t)
  a.g('update-ref', 'refs/remotes/origin/development', a.base)
  a.put('lib/a.ts', 'export const a = 2\n')
  a.put('changelog.d/feat-x.md', `### X (area)\n- thing\n\nDocs: none ${EM} ${REASON}\n`)
  a.commit('code + opt-out')
  const r = run(a.dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, new RegExp(`Accepted reason \\(changelog\\.d/feat-x\\.md\\): ${REASON}`))

  const b = repo(t)
  b.g('update-ref', 'refs/remotes/origin/development', b.base)
  b.put('lib/a.ts', 'export const a = 2\n')
  b.put('docs/a.md', '# a\n\nupdated\n')
  b.commit('code + docs')
  const ok = run(b.dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(ok.status, 0, ok.out)
  assert.match(ok.out, /docs\/a\.md/)
})

test('e2e: PUSH path takes the before SHA from the env or the event payload; base == head fails loudly in CI', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  put('lib/a.ts', 'export const a = 2\n')
  const head = commit('code')
  g('update-ref', 'refs/remotes/origin/development', head) // the trap: the default base is HEAD itself

  const vacuous = run(dir, { CI: 'true' })
  assert.equal(vacuous.status, 1, vacuous.out)
  assert.match(vacuous.out, /comparison range .* is empty/)

  const viaEnv = run(dir, { CI: 'true', DOCS_REQUIRED_BASE_REF: base })
  assert.equal(viaEnv.status, 1, viaEnv.out)
  assert.match(viaEnv.out, /lib\/a\.ts/)

  const event = join(dir, 'event.json') // untracked: not part of any committed range
  writeFileSync(event, JSON.stringify({ before: base }))
  const viaEvent = run(dir, { CI: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event })
  assert.equal(viaEvent.status, 1, viaEvent.out)
  assert.match(viaEvent.out, /lib\/a\.ts/)

  const zero = run(dir, { CI: 'true', DOCS_REQUIRED_BASE_REF: '0'.repeat(40) })
  assert.equal(zero.status, 1, zero.out)
  assert.match(zero.out, /lib\/a\.ts/, 'an all-zero before SHA compares against the parent commit')

  const bad = run(dir, { CI: 'true', DOCS_REQUIRED_BASE_REF: 'deadbeef'.repeat(5) })
  assert.equal(bad.status, 1, bad.out)
  assert.match(bad.out, /Cannot resolve the comparison range/)
})

// [mutation: drop the merge-base == head check]
test('e2e L2: in CI a head that is an ancestor of the base (a backwards force push) fails as an empty range', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  put('lib/a.ts', 'export const a = 2\n')
  const later = commit('later')
  g('reset', '-q', '--hard', base) // HEAD back to the base: merge-base(later, HEAD) == HEAD
  const r = run(dir, { CI: 'true', DOCS_REQUIRED_BASE_REF: later })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /is an ancestor of/)
})

// [mutation: fail instead of falling back; fall back outside a push event]
test('e2e L3: on a push whose before SHA is not in the clone, it compares HEAD^ with a warning', (t) => {
  const { dir, put, commit } = repo(t)
  put('lib/a.ts', 'export const a = 2\n')
  commit('code')
  const missing = 'deadbeef'.repeat(5)
  const push = run(dir, { CI: 'true', GITHUB_EVENT_NAME: 'push', DOCS_REQUIRED_BASE_REF: missing })
  assert.equal(push.status, 1, push.out)
  assert.match(push.out, /not in this clone .*comparing against HEAD\^/)
  assert.match(push.out, /lib\/a\.ts/, 'the pushed commit is still examined')
  const pr = run(dir, { CI: 'true', DOCS_REQUIRED_BASE_REF: missing })
  assert.match(pr.out, /Cannot resolve the comparison range/, 'not a push: no fallback')
})

// [mutation: count a marker added to an existing fragment]
test('e2e L6: a marker added to an OLDER fragment does not excuse a code change', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  g('update-ref', 'refs/remotes/origin/development', base)
  put('lib/a.ts', 'export const a = 2\n')
  put('changelog.d/old.md', `### Old (x)\nDocs: none ${EM} ${REASON}\nDocs: none ${EM} another internal change, nothing visible\n`)
  commit('code + marker in an old fragment')
  const r = run(dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /FAILED/)
})

// [mutation: read only non-merge subjects as reverts when one is not]
test('e2e L7: a range made only of git reverts passes without docs', (t) => {
  const { dir, g, put, commit, base } = repo(t)
  g('update-ref', 'refs/remotes/origin/development', base)
  put('lib/a.ts', 'export const a = 2\n')
  commit('Revert "feat: a (#12)"')
  const r = run(dir, { CI: 'true', GITHUB_BASE_REF: 'development' })
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /every commit is a revert/)
})

// [mutation: compare only committed changes locally]
test('e2e L8: outside CI the uncommitted working tree and untracked files are included', (t) => {
  const { dir, g, put, base } = repo(t)
  g('update-ref', 'refs/remotes/origin/development', base)
  put('lib/a.ts', 'export const a = 2\n') // uncommitted
  const dirty = run(dir, {})
  assert.equal(dirty.status, 1, dirty.out)
  assert.match(dirty.out, /lib\/a\.ts/)
  assert.match(dirty.out, /working tree/)
  put('changelog.d/new-fragment.md', `### X (area)\nDocs: none ${EM} ${REASON}\n`) // untracked
  const ok = run(dir, {})
  assert.equal(ok.status, 0, ok.out)
  assert.match(ok.out, /Accepted reason \(changelog\.d\/new-fragment\.md\)/)
  put('lib/new.ts', 'export const b = 1\n') // an untracked code file counts too
  put('changelog.d/new-fragment.md', '### X (area)\n- y\n')
  const untracked = run(dir, {})
  assert.equal(untracked.status, 1, untracked.out)
  assert.match(untracked.out, /lib\/new\.ts/)
})

// [mutation: fail locally on a missing base or a shallow clone; skip in CI too]
test('e2e L9: outside CI a missing base or a shallow clone is warned about and skipped; in CI it still fails', (t) => {
  const { dir, put, commit } = repo(t)
  put('lib/a.ts', 'export const a = 2\n')
  commit('code') // no origin/development in this repo
  const local = run(dir, {})
  assert.equal(local.status, 0, local.out)
  assert.match(local.out, /SKIPPED \(not in CI\).*not in this clone/)
  const ci = run(dir, { CI: 'true' })
  assert.equal(ci.status, 1, ci.out)

  // A shallow clone without the network: git reads `.git/shallow` (the grafted boundary commits) to decide.
  const b = repo(t)
  b.g('update-ref', 'refs/remotes/origin/development', b.base)
  writeFileSync(join(b.dir, '.git', 'shallow'), `${b.base}\n`)
  const s = run(b.dir, {})
  assert.equal(s.status, 0, s.out)
  assert.match(s.out, /SKIPPED \(not in CI\).*shallow clone/)
})

// ---- the CI-only guard list cannot drift from what actually ships ---------------------------------------
const REPO = process.cwd()

function walk(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
}

/** The shell scripts and host files that ship and run on installation/production hosts. */
const SHIPPED_SHELL = [
  'scripts/deploy.sh',
  'scripts/update.sh',
  'scripts/install.sh',
  ...walk('deploy').filter((f) => !f.startsWith('deploy/tests/') && !f.endsWith('.md')),
].map((f) => ({ file: f, body: readFileSync(join(REPO, f), 'utf8') }))

function shippedReferences(basename: string): string[] {
  const stem = basename.replace(/\.[^.]+$/, '').replace(/[.]/g, '\\.')
  const ext = basename.slice(basename.lastIndexOf('.')).replace(/[.]/g, '\\.')
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${stem}(${ext})?([^A-Za-z0-9_-]|$)`, 'm')
  return SHIPPED_SHELL.filter(({ body }) => re.test(body)).map(({ file }) => file)
}

test('the shipped-shell census is not vacuous (it finds the known production-host gates)', () => {
  assert.ok(SHIPPED_SHELL.length > 5)
  for (const f of ['check-db-writers.mjs', 'check-app-db-object-access.mjs', 'check-prisma-drift.mjs', 'check-wms-push-state-enum.mjs'])
    assert.notDeepEqual(shippedReferences(f), [], `${f} must be found in a shipped shell script`)
})

test('CI_ONLY_GUARDS is exactly the check:* scripts a workflow runs and no shipped shell script references', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const workflows = readdirSync(join(REPO, '.github/workflows')).map((f) => readFileSync(join(REPO, '.github/workflows', f), 'utf8')).join('\n')
  const derived = new Set<string>()
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('check:')) continue
    const m = /scripts\/(check-[^\s"'/]+)/.exec(cmd)
    if (!m) continue
    const runByWorkflow = new RegExp(`npm run ${name}(\\s|$)`, 'm').test(workflows)
    if (runByWorkflow && shippedReferences(m[1]).length === 0) derived.add(m[1])
  }
  assert.deepEqual([...CI_ONLY_GUARDS].sort(), [...derived].sort())
})

test('every shipped or operator check-* script counts as behaviour', () => {
  for (const f of walk('scripts').filter((p) => /^scripts\/check-[^/]+$/.test(p))) {
    const base = f.slice('scripts/'.length)
    if (!(CI_ONLY_GUARDS as string[]).includes(base)) assert.equal(isBehaviourPath(f), true, f)
  }
  for (const f of ['check-db-writers.mjs', 'check-app-db-object-access.mjs', 'check-prisma-drift.mjs', 'check-wms-push-state-enum.mjs', 'check-so.ts', 'check-bom-recipe-consistency.ts'])
    assert.equal(isBehaviourPath(`scripts/${f}`), true, f)
})

test('no excluded scripts/ file is referenced by a shipped shell script', () => {
  const excluded = walk('scripts').filter((f) => !isBehaviourPath(f) && !f.endsWith('.md'))
  assert.ok(excluded.length > 10, 'the census must see the excluded tooling')
  for (const f of excluded) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    assert.deepEqual(shippedReferences(base), [], `${f} is excluded as tooling but ships`)
  }
})

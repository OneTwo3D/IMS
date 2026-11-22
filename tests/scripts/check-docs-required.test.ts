/**
 * check:docs-required — a PR that changes behaviour-bearing code changes docs in the same PR, or carries a
 * reasoned `Docs: none — <reason>` line in a changelog.d fragment it adds.
 *
 * The pure decision is tested directly; the git plumbing (merge-base, push/PR base, vacuous range) is run
 * end to end as a subprocess against a throwaway repo. No network: git runs on local temp repos only.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  evaluateDocsRequired,
  findOptOuts,
  isBehaviourPath,
  isDocPath,
  MIN_REASON_LENGTH,
  parseAddedLines,
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
    'prisma/seed.ts',
    'public/logo.png',
  ]) assert.equal(isBehaviourPath(p), false, p)
  // Exclusions are anchored: a file merely NAMED like a tool elsewhere is still behaviour.
  assert.equal(isBehaviourPath('lib/check-stock.ts'), true)
  assert.equal(isBehaviourPath('lib/releases-view.ts'), true)
  assert.equal(isBehaviourPath('scripts/sub/check-x.ts'), true)
})

test('documentation paths', () => {
  for (const p of ['docs/sales.md', 'docs/agent/env-vars.md', 'help-docs/sales.md', 'README.md', 'deploy/README.md'])
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
    { file: 'changelog.d/a.md', line: '### Title (area)' },
    { file: 'changelog.d/a.md', line: `Docs: none ${EM} ${REASON}` },
    { file: 'changelog.d/c.md', line: '++ content that looks like a header' },
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
    'Docs: none.',
    `Docs: none ${EM}`,
    `Docs: none ${EM} n/a`,
    `Docs: none ${EM} <reason>`,
    `Docs: none ${EM} none`,
    `Docs: none ${EM} tbd`,
    `Docs: none ${EM} ${'x'.repeat(MIN_REASON_LENGTH - 1)}`,
    'Docs: none needed',
  ]) {
    const r = findOptOuts([{ file: 'changelog.d/x.md', line }])
    assert.equal(r.accepted.length, 0, line)
    assert.equal(r.errors.length, 1, line)
  }
  // exactly the minimum is enough
  assert.equal(findOptOuts([{ file: 'changelog.d/x.md', line: `Docs: none ${EM} ${'x'.repeat(MIN_REASON_LENGTH)}` }]).accepted.length, 1)
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

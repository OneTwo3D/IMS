import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { shellConstant, shellFunction } from './shell-symbol.ts'
import { createTempDirSync } from './temp-dir.ts'
import { protectedLibraryTextAt } from './fence-artefact-harness.ts'

// ===========================================================================
// o3d-kyqa / o3d-z5be / o3d-xf9m — WHAT A PRIVILEGED RUN MAY EXECUTE, AND WHAT IT MAY
// TREAT AS PERMISSION.
//
// THE RULE, as a property:
//
//   NO PRIVILEGED RUN MAY EXECUTE BYTES THAT AN UNPRIVILEGED ACCOUNT COULD HAVE CHANGED
//   AFTER THE RUN BEGAN.
//
// and its neighbour, which is the same sentence one step over:
//
//   NO PRIVILEGED RUN MAY TAKE AN UNPRIVILEGED ACCOUNT'S DELETION AS PERMISSION TO
//   DESTROY DATA.
//
// WHAT IS HELD HERE, and the route each takes:
//
//   1. GRAMMAR. No entrypoint resolves a node helper out of ${IMS_SCRIPT_LIB_DIR} for a
//      root-side execution. Asked of the code lines of all three, with the match counts
//      printed and the anchors asserted, so a walk that stopped reaching the files fails
//      instead of passing.                                            (repository walk)
//   2. GRAMMAR. The snapshot is published at script scope, as the statement immediately
//      after the library is sourced — not "within N lines of" it, which is a proximity
//      rule and always satisfiable — and before the first resolution in the file.
//   3. LOAD-BEARING, run for real: the shipped publication and the shipped resolution,
//      against a scratch root, including the one thing a second on-disk record cannot
//      do — refusing a tree THIS RUN did not publish.
//   4. LOAD-BEARING, run for real: every hostile shape at the source and at the
//      destination, and the operator pin in both directions.
//   5. o3d-z5be: the driver and the metadata are published root-owned, update.sh reads
//      the root-owned copy, and docs/installation.md's documented command is that copy.
//   6. o3d-xf9m: the shipped absent-.env gate, run for real over the four combinations
//      of its two witnesses, plus the grammar that keeps it reachable.
//
// EVERYTHING BEHAVIOURAL RUNS THE SHIPPED TEXT. The library's ONE root literal is
// substituted before sourcing — the technique fence-artefact-harness.ts already uses for
// ${DB_FENCE_RECOVERY_DIR} — and every path beneath it is composed by the shipped file,
// unchanged, `readonly` and all.
// ===========================================================================

const REPO = process.cwd()
const LIB_REL = 'scripts/lib/privileged-helpers.sh'
const LIB_SOURCE = readFileSync(join(REPO, LIB_REL), 'utf8')
const FENCE_LIB_REL = 'scripts/lib/db-fence-protected.sh'
/** Every library the three entrypoints `source`. Asserted against their text, so a new one is a decision. */
const SOURCED_LIBS = ['scripts/lib/db-fence-protected.sh', 'scripts/lib/crontab-lock.sh', 'scripts/lib/cutover-namespace.sh',
  'scripts/lib/unit-environment.sh', 'scripts/lib/privileged-helpers.sh']

const ENTRYPOINTS = ['scripts/install.sh', 'scripts/update.sh', 'scripts/deploy.sh'] as const
const ENTRYPOINT_SOURCE = new Map<string, string>(
  ENTRYPOINTS.map((rel) => [rel, readFileSync(join(REPO, rel), 'utf8')] as const),
)

/** The node helpers that live in scripts/lib — the set a privileged run might execute late. Read
 *  from the directory rather than listed, so a helper added there is covered on the day it lands. */
function libNodeHelpers(): string[] {
  return readdirSync(join(REPO, 'scripts/lib')).filter((name) => name.endsWith('.mjs')).sort()
}

/** The helper names the entrypoints actually RESOLVE through privileged_helper_path — which is the
 *  set that gets EXECUTED out of the published tree, and not the same thing as the set of files
 *  copied into it. Read from the call sites so it grows with the code. */
function resolvedHelperNames(sources: Iterable<string>): string[] {
  const names = new Set<string>()
  for (const source of sources) {
    for (const { text } of codeLines(source)) {
      for (const match of text.matchAll(/privileged_helper_path\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(match[1])
    }
  }
  return [...names].sort()
}

/** Code lines only: `[line number, text]`, comments dropped. The entrypoints quote every retired
 *  construct in their own prose — that is where the reasoning lives — so a rule about text would
 *  fire on the paragraph explaining why the text is gone. */
function codeLines(source: string): Array<{ n: number; text: string }> {
  return source.split('\n')
    .map((text, index) => ({ n: index + 1, text }))
    .filter((line) => !/^\s*#/.test(line.text))
}

/** Script-scope statements: unindented, non-comment, non-blank. Used for the ORDER claim, which is
 *  about statements bash executes at top level and not about how close two lines are. */
function scriptScopeLines(source: string): Array<{ n: number; text: string }> {
  return codeLines(source).filter((line) => /^\S/.test(line.text))
}

/** The ONE line the harnesses substitute: `shellConstant` returns the whole assignment, which is what
 *  a rig executes, so the value is taken out of it here rather than re-typed. */
const LIB_ROOT_DECLARATION = shellConstant(LIB_SOURCE, 'IMS_DRIVER_ROOT', LIB_REL)
const DRIVER_ROOT = (() => {
  const match = /^readonly IMS_DRIVER_ROOT="([^"]+)"$/.exec(LIB_ROOT_DECLARATION)
  assert.ok(match, `${LIB_REL} must declare its root as one quoted literal: ${JSON.stringify(LIB_ROOT_DECLARATION)}`)
  return match[1]
})()

/** The shipped library, with its single root literal aimed at a scratch directory. Everything else
 *  — every path composed from it, every function, every message — is the shipped text. */
function libraryAt(root: string): string {
  const replacement = `readonly IMS_DRIVER_ROOT="${root}"`
  assert.ok(LIB_SOURCE.includes(LIB_ROOT_DECLARATION),
    `${LIB_REL} must declare its root as one substitutable literal; looked for ${LIB_ROOT_DECLARATION}`)
  const out = LIB_SOURCE.replace(LIB_ROOT_DECLARATION, replacement)
  assert.notEqual(out, LIB_SOURCE, 'the substitution must have changed the text')
  assert.ok(!out.includes(LIB_ROOT_DECLARATION), 'and there must be exactly one such literal')
  return out
}

type Run = { status: number; stdout: string; stderr: string }

/**
 * Run a program with the shipped fence library and the shipped privileged-helpers library sourced,
 * ${IMS_SCRIPT_LIB_DIR} pointed at a scratch source directory, and the publication root inside a
 * scratch tree.
 *
 * NOT `set -e`: these programs deliberately drive functions that REFUSE, and errexit would end the
 * program at the first refusal instead of letting the assertions read what happened after it. Each
 * subject is nonetheless run as ITS OWN STATEMENT with its status captured — never as the left side
 * of `&&`/`||` with the assertion on the right, which is the shape that passes vacuously.
 */
function run(dirs: { root: string; src: string; work: string }, program: string, env: Record<string, string> = {}): Run {
  const libPath = join(dirs.work, 'privileged-helpers.sh')
  writeFileSync(libPath, libraryAt(dirs.root))
  const script = [
    'set -uo pipefail',
    `source ${JSON.stringify(join(REPO, FENCE_LIB_REL))}`,
    `IMS_SCRIPT_LIB_DIR=${JSON.stringify(dirs.src)}`,
    `source ${JSON.stringify(libPath)}`,
    program,
  ].join('\n')
  const scriptPath = join(dirs.work, 'program.sh')
  writeFileSync(scriptPath, script)
  const out = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

/**
 * THE VERSIONED DIRECTORY A DOCUMENTED NAME RESOLVES TO (o3d-z5be r3).
 *
 * ASSERTING THE SHAPE IS THE POINT, not a step on the way to a path: the whole of the r3 fix is that
 * `helpers` and `driver` are SYMBOLIC LINKS flipped by one `rename(2)`, so a test that read them as
 * plain directories would pass just as well against the sequence that could nest one publication
 * inside another.
 */
function standingVersionDir(root: string, pointer: 'helpers' | 'driver'): string {
  const st = lstatSync(join(root, pointer))
  assert.ok(st.isSymbolicLink(),
    `${pointer} must be the symbolic link a publication commits, not a directory a publication overwrote`)
  const link = readlinkSync(join(root, pointer))
  assert.match(link, new RegExp(`^\\.version-[a-z]+\\.[1-9][0-9]*\\.[A-Za-z0-9]+/${pointer}$`),
    `${pointer} must name one versioned publication directory and one tree beneath the root: ${link}`)
  return join(root, link.split('/')[0])
}

/** The record or manifest OF THE PUBLICATION THAT IS STANDING. It lives inside the versioned directory
 *  rather than at a fixed path precisely so that one rename commits it with the tree. */
function standingFile(root: string, pointer: 'helpers' | 'driver', name: string): string {
  return join(standingVersionDir(root, pointer), name)
}

/** Take a publication away entirely — the pointer and every versioned directory — so a following run
 *  starts from nothing. A test that removed only the pointer would leave a tree the sweep would find. */
function clearStanding(root: string, pointer: 'helpers' | 'driver'): void {
  rmSync(join(root, pointer), { force: true })
  for (const name of readdirSync(root)) {
    if (name.startsWith('.version-') || name.startsWith('.publish-')) {
      rmSync(join(root, name), { recursive: true, force: true })
    }
  }
}

/**
 * WHAT A REFUSED PUBLICATION LOOKS LIKE FROM OUTSIDE, and why it is not read off the return code.
 *
 * publish_privileged_helper_set() TOLERATES a failure when the account running it is not root —
 * `update.sh --dry-run` and `--print-fence-digest` are documented to work unprivileged, they execute
 * nothing as root, and so they have nothing to refuse. This harness is not root either, so its return
 * code would be 0 for every refusal and asserting on it would be asserting on the tolerance rather
 * than on the mechanism. What is measured instead is the three things that actually gate execution:
 *
 *   * ${IMS_DRIVER_HELPER_SHA256} is EMPTY — it is set only by a publication that completed, and
 *     privileged_helper_path() refuses outright without it;
 *   * nothing is left at the destination;
 *   * the reason reached stderr, where a caller reading this library through a command substitution
 *     can actually see it.
 *
 * The tolerance itself is measured separately, with `id` stubbed, in the test that follows them.
 */
function assertPublishedNothing(out: Run, root: string, what: string): void {
  assert.match(out.stdout, /^DIGEST=$/m,
    `${what}: no digest may be recorded in the run:\n${out.stdout}${out.stderr}`)
  assert.equal(existsSync(join(root, 'helpers')), false, `${what}: no tree may be left at the destination`)
  assert.equal(lstatSync(join(root, 'helpers'), { throwIfNoEntry: false }), undefined,
    `${what}: and not a dangling pointer either`)
  // The root itself need not exist — a refusal on the ancestry walk never creates it — and "there is
  // no root" is a stronger form of "nothing was published", not an exception to it.
  assert.deepEqual(existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('.version-')) : [], [],
    `${what}: and no versioned publication, which is where the record now lives`)
}

/** The program every refusal test runs: attempt the publication, report the digest, attempt a
 *  resolution. Both subjects are their own statements with their statuses captured. */
const PUBLISH_THEN_RESOLVE = [
  'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
  'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  'p="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
].join('\n')

/** A scratch source lib and a scratch publication root, both cleaned up by the test context. */
function scratch(t: TestContext, helpers: string[] = ['chown-tree.mjs', 'pg-auth-request.mjs']): { root: string; src: string; work: string } {
  const base = createTempDirSync('privileged-helper-set-', t)
  const root = join(base, 'root')
  const src = join(base, 'src')
  const work = join(base, 'work')
  mkdirSync(root); mkdirSync(src); mkdirSync(work)
  for (const name of helpers) {
    writeFileSync(join(src, name), `// ${name}\nprocess.exit(0)\n`)
  }
  return { root, src, work }
}

// ---------------------------------------------------------------------------
// 1. THE REPOSITORY WALK (o3d-kyqa)
// ---------------------------------------------------------------------------

test('[o3d-kyqa] no entrypoint resolves a node helper out of its own lib directory for a root-side run', () => {
  const helpers = libNodeHelpers()

  // PRECONDITIONS, so that a walk which reached nothing cannot pass as a walk that found nothing
  // wrong. Two numbers and one anchor per file.
  assert.ok(helpers.length >= 2,
    `scripts/lib must hold the node helpers this rule is about; found ${helpers.length}: ${helpers.join(', ')}`)
  assert.ok(helpers.includes('chown-tree.mjs') && helpers.includes('pg-auth-request.mjs'),
    `the two helpers o3d-kyqa names must be there; found ${helpers.join(', ')}`)

  let linesWalked = 0
  const offenders: string[] = []
  const resolutions = new Map<string, string[]>()
  for (const [rel, source] of ENTRYPOINT_SOURCE) {
    const lines = codeLines(source)
    assert.ok(lines.length > 300, `${rel}: the walk must reach a real entrypoint (${lines.length} code lines)`)
    linesWalked += lines.length
    for (const { n, text } of lines) {
      // THE DEFECT'S GRAMMAR: the script's own lib directory named in the same word as a node
      // helper. That is the resolution o3d-kyqa is about, whatever the surrounding syntax.
      if (/\$\{IMS_SCRIPT_LIB_DIR(:-)?\}[^"']*\.mjs/.test(text)) {
        offenders.push(`${rel}:${n}: ${text.trim()}`)
      }
      for (const match of text.matchAll(/privileged_helper_path\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
        const name = match[1]
        if (!resolutions.has(name)) resolutions.set(name, [])
        resolutions.get(name)!.push(`${rel}:${n}`)
      }
    }
  }

  assert.ok(linesWalked > 5000, `the walk must reach the three entrypoints (walked ${linesWalked} code lines)`)
  assert.deepEqual(offenders, [],
    'a privileged run may not resolve a node helper out of a directory the service account owns; '
    + 'it is published root-owned at startup and resolved with privileged_helper_path (o3d-kyqa)')

  // AND THE WALK FOUND THE REPLACEMENT, which is what makes the empty offender list a statement
  // about the code rather than about the regular expression.
  assert.deepEqual([...resolutions.keys()].sort(), resolvedHelperNames(ENTRYPOINT_SOURCE.values()),
    `the walk and the shared call-site reader must agree; found ${JSON.stringify([...resolutions])}`)
  assert.deepEqual([...resolutions.keys()].sort(), ['chown-tree.mjs', 'pg-auth-request.mjs'],
    `the two helpers must be resolved through the root-owned snapshot; found ${JSON.stringify([...resolutions])}`)
  for (const [name, sites] of resolutions) {
    assert.ok(sites.length >= 1, `${name} must be resolved somewhere (${sites.join(', ')})`)
  }

  // EVERY OTHER node helper the entrypoints run is run AS THE APPLICATION USER, which is why it is
  // not in the table above. Stated as a census so a new root-side invocation shows up here.
  const privilegedNodeCalls: string[] = []
  for (const [rel, source] of ENTRYPOINT_SOURCE) {
    for (const { n, text } of codeLines(source)) {
      const nodeMatch = /(^|[^A-Za-z_.\-])node\s/.exec(text)
      if (!nodeMatch) continue
      // INSIDE A STRING IS NOT A COMMAND. The entrypoints' refusal messages say "node is not on
      // PATH" and "would run: node scripts/…", and a census that counted those would be a rule about
      // prose — the shape this repository keeps having to un-write. An odd number of double quotes
      // before the match means the word is inside one.
      const before = text.slice(0, nodeMatch.index + nodeMatch[1].length)
      if ((before.split('"').length - 1) % 2 === 1) continue
      if ((before.split("'").length - 1) % 2 === 1) continue
      if (/echo|printf|command -v|--version/.test(text)) continue
      // The privilege drop may be on this line or on one of the continued lines above it; the
      // statement is what matters, so the check is against the whole logical statement.
      const statement = logicalStatementAt(source, n)
      if (/run_as_user|as_app_user/.test(statement)) continue
      if (/privileged_helper_path|IMS_CHOWN_TREE_HELPER|\$\{helper\}|\$\{probe\}/.test(statement)) continue
      privilegedNodeCalls.push(`${rel}:${n}: ${text.trim()}`)
    }
  }
  assert.deepEqual(privilegedNodeCalls, [],
    'every `node` invocation in the three entrypoints must either drop to the application user or '
    + 'resolve its program through the root-owned snapshot')
})

/** The whole logical statement a line belongs to: backslash continuations joined upwards and
 *  downwards. A privilege drop written on the line above is part of the same statement, and a rule
 *  that read one physical line would miss it. */
function logicalStatementAt(source: string, lineNumber: number): string {
  const lines = source.split('\n')
  let start = lineNumber - 1
  while (start > 0 && /\\$/.test(lines[start - 1] ?? '')) start -= 1
  let end = lineNumber - 1
  while (/\\$/.test(lines[end] ?? '') && end < lines.length - 1) end += 1
  return lines.slice(start, end + 1).join('\n')
}

test('[o3d-kyqa] the snapshot is published at script scope, immediately after the library is sourced and before anything resolves out of it', () => {
  for (const [rel, source] of ENTRYPOINT_SOURCE) {
    const scope = scriptScopeLines(source)
    assert.ok(scope.length > 50, `${rel}: the walk must reach script-scope statements (${scope.length})`)

    const sourceIndex = scope.findIndex((line) =>
      /^source "\$\{IMS_SCRIPT_LIB_DIR\}\/privileged-helpers\.sh"/.test(line.text))
    assert.notEqual(sourceIndex, -1, `${rel} must source ${LIB_REL} at script scope`)

    // THE NEXT script-scope statement that is not part of the source block's own `|| { … }` must be
    // the publication. This is a claim about the ORDER OF STATEMENTS, not about how many lines
    // separate two of them: a proximity rule ("within N lines") is satisfied by any text that
    // happens to sit nearby, which is why one is not written here.
    const after = scope.slice(sourceIndex + 1).filter((line) => !/^\}$/.test(line.text.trim()))
    assert.ok(after.length > 0, `${rel}: there must be a statement after the source`)
    // THE WRITE-NOTHING GUARD (o3d-z5be r5, Codex MEDIUM). update.sh and deploy.sh have modes that promise
    // to change nothing, so their publication sits inside a guard naming exactly those modes; install.sh
    // has no such mode and publishes unconditionally. The guard is still the NEXT statement, and the
    // publication is still the first thing inside it.
    const guard = ({
      'scripts/update.sh': 'if ! $DRY_RUN && ! $PRINT_FENCE_DIGEST; then',
      'scripts/deploy.sh': 'if ! $DRY_RUN; then',
      'scripts/install.sh': null,
    } as Record<string, string | null>)[rel]
    if (guard) {
      assert.equal(after[0].text, guard, `${rel}: the next script-scope statement after sourcing ${LIB_REL} must be the write-nothing guard, and it is "${after[0].text}" at line ${after[0].n}`)
      const inside = codeLines(source).find((line) => line.n > after[0].n && line.text.trim() !== '')
      assert.equal(inside?.text, '  publish_privileged_helper_set || {', `${rel}: the publication must be the first statement inside the guard`)
    } else {
      assert.match(after[0].text, /^publish_privileged_helper_set \|\| \{$/,
        `${rel}: the snapshot must be taken in the same instant as the libraries are read — the next `
        + `script-scope statement after sourcing ${LIB_REL} must be the publication, and it is `
        + `"${after[0].text.trim()}" at line ${after[0].n}`)
    }

    // AND BEFORE ANY RESOLUTION IN THE FILE. A publication below a use would be a use of nothing.
    const firstResolution = codeLines(source).find((line) => /privileged_helper_path\s/.test(line.text))
    if (firstResolution) {
      assert.ok(firstResolution.n > scope[sourceIndex].n,
        `${rel}: privileged_helper_path is used at line ${firstResolution.n}, before the library is sourced at ${scope[sourceIndex].n}`)
    }
  }

  // install.sh is the file with the two call sites, so its shape is asserted directly rather than
  // left to the census above.
  const install = ENTRYPOINT_SOURCE.get('scripts/install.sh')!
  assert.match(install, /helper="\$\(privileged_helper_path chown-tree\.mjs\)" \|\| die/,
    'chown_state_tree() must resolve its helper through the root-owned snapshot and refuse if it cannot')
  assert.match(shellFunction(install, 'db_auth_request_probe_path', 'scripts/install.sh'),
    /^\s*privileged_helper_path pg-auth-request\.mjs$/m,
    'db_auth_request_probe_path() must resolve through the root-owned snapshot')
  // AND THE RETIRED APPARATUS HAS NOT COME BACK (o3d-secops r22's ruling, restated because this
  // change is the one that would be tempted to).
  assert.equal(existsSync(join(REPO, 'scripts/lib/pin-source-file.mjs')), false,
    'scripts/lib/pin-source-file.mjs authenticated bytes that cannot be authenticated; this change '
    + 'establishes a boundary instead of moving one, and must not resurrect it')
  assert.ok(!/pin-source-file/.test(LIB_SOURCE.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')),
    `${LIB_REL} may explain why that helper went, in prose, and must not reference it in code`)
})

test('[o3d-kyqa] the helpers a privileged run executes import nothing that needs a node_modules above them', () => {
  // WHY THIS IS LOAD-BEARING AND NOT TIDINESS. The published tree is /etc/ims-cutover-driver/helpers,
  // and there is no node_modules anywhere above /etc. The fence artefact solves the same problem by
  // VENDORING its entry file's whole dependency closure and hashing that too; this publication is a
  // flat copy, which is only correct while the helpers import node: builtins and nothing else.
  //
  // So the property is asserted rather than assumed: a helper that grows a third-party import fails
  // here, where the message can say what to do about it, instead of at `node` in a fenced window.
  // THE SET IS THE ONE THAT IS EXECUTED, not the one that is copied. scripts/lib also holds
  // ts-import-aliases.mjs, a developer tool that imports `typescript`: it lands in the published tree
  // because the publication copies the directory whole (which is what keeps a new helper covered by
  // the digest on the day it is added), and nothing ever runs it from there. A rule about the copied
  // set would fire on it and say nothing about what root executes.
  const helpers = resolvedHelperNames(ENTRYPOINT_SOURCE.values())
  assert.deepEqual(helpers, ['chown-tree.mjs', 'pg-auth-request.mjs'],
    `precondition: the walk must find the helpers the entrypoints resolve (${helpers.join(', ')})`)
  for (const name of helpers) {
    assert.ok(libNodeHelpers().includes(name), `${name} must be a file in scripts/lib`)
  }
  let specifiersSeen = 0
  const external: string[] = []
  for (const name of helpers) {
    const source = readFileSync(join(REPO, 'scripts/lib', name), 'utf8')
    for (const match of source.matchAll(/^\s*(?:import\s[^'"]*from\s*|import\s*)['"]([^'"]+)['"]/gm)) {
      specifiersSeen += 1
      if (!match[1].startsWith('node:') && !match[1].startsWith('./') && !match[1].startsWith('../')) {
        external.push(`${name}: ${match[1]}`)
      }
    }
    for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g)) {
      specifiersSeen += 1
      if (!match[1].startsWith('node:') && !match[1].startsWith('./') && !match[1].startsWith('../')) {
        external.push(`${name}: ${match[1]}`)
      }
    }
  }
  assert.ok(specifiersSeen >= 5, `the scan must have found real import statements (${specifiersSeen})`)
  assert.deepEqual(external, [],
    'a helper published into /etc and executed as root may import node: builtins and its own siblings '
    + 'only: there is no node_modules above that directory, and a flat copy does not vendor a '
    + 'dependency closure the way the fence artefact does. Either drop the import or give this '
    + 'publication the vendoring the fence has.')
})

// ---------------------------------------------------------------------------
// 2. THE PUBLICATION AND THE RESOLUTION, RUN FOR REAL (o3d-kyqa)
// ---------------------------------------------------------------------------

test('[o3d-kyqa] the shipped publication leaves a sealed tree the shipped resolution will run, and a digest recorded in the run', (t) => {
  const dirs = scratch(t)
  const out = run(dirs, [
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
    'resolved="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
    'echo "RESOLVED=${resolved}"',
    // The digest is `readonly` from the publication onwards: nothing later in a run may restate
    // what its own helpers are supposed to hash to.
    'IMS_DRIVER_HELPER_SHA256=deadbeef 2>/dev/null; echo "REASSIGN_RC=$?"',
    'echo "AFTER=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))

  assert.match(out.stdout, /^PUBLISH_RC=0$/m, `${out.stdout}${out.stderr}`)
  const digest = /^DIGEST=([0-9a-f]{64})$/m.exec(out.stdout)
  assert.ok(digest, `the publication must record a digest in the run:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^RESOLVE_RC=0$/m, `${out.stdout}${out.stderr}`)
  // THE RESOLVED PATH IS THE VERSIONED ONE, not the pointer (o3d-z5be r3): the tree inside a versioned
  // directory is immutable for as long as it exists, so the bytes sealed and digested by the resolution
  // are the bytes `node` opens even if another privileged run flips the pointer in the interval.
  assert.match(out.stdout,
    new RegExp(`^RESOLVED=${dirs.root}/\\.version-helpers\\.[1-9][0-9]*\\.[A-Za-z0-9]+/helpers/chown-tree\\.mjs$`, 'm'),
    out.stdout)
  assert.doesNotMatch(out.stdout, /^REASSIGN_RC=0$/m,
    `the published digest must be readonly for the rest of the run:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, new RegExp(`^AFTER=${digest[1]}$`, 'm'), out.stdout)

  // THE SEAL, MEASURED ON DISK rather than taken from the function that asserted it: every entry
  // owned by this account, nothing writable by group or other, and no symlinks.
  const uid = process.getuid!()
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const st = lstatSync(path)
    // THE ONLY SYMBOLIC LINKS UNDER THE ROOT ARE THE TWO POINTERS, and each names a versioned
    // publication and nothing else. A link anywhere else would be executable surface no digest covers.
    if (st.isSymbolicLink()) {
      assert.ok(name === 'helpers' || name === 'driver', `${path} is a symbolic link that is not a pointer`)
      assert.equal(st.uid, uid, `${path} must be owned by the publishing account`)
      standingVersionDir(dir, name as 'helpers' | 'driver')
      return []
    }
    assert.ok(st.isFile() || st.isDirectory(), `${path} must be a regular file or a directory`)
    assert.equal(st.uid, uid, `${path} must be owned by the publishing account`)
    assert.equal(st.mode & 0o022, 0, `${path} must not be writable by group or other (mode ${(st.mode & 0o7777).toString(8)})`)
    return st.isDirectory() ? walk(path) : [path]
  })
  const files = walk(dirs.root)
  assert.ok(files.length >= 4, `the publication must have produced the tree, the record and the manifest: ${files.join(', ')}`)
  const record = readFileSync(standingFile(dirs.root, 'helpers', 'helper-set.sha256'), 'utf8')
  assert.match(record, new RegExp(`^tree_sha256=${digest[1]}$`, 'm'), record)
  assert.match(record, /^tree_complete=1$/m, 'the record must carry its completion sentinel last')
  assert.match(readFileSync(standingFile(dirs.root, 'helpers', 'helper-set.manifest'), 'utf8'), /\bchown-tree\.mjs$/m)
  // AND THE RECORD IS REACHABLE BY THE PATH THE LIBRARY AND THE DOCS NAME — `${pointer}/../<name>`,
  // which the kernel resolves from the directory the link landed in, so it always names the record of
  // the tree that is standing. That is what makes one rename commit the tree and its record together.
  assert.equal(readFileSync(`${join(dirs.root, 'helpers')}/../helper-set.sha256`, 'utf8'), record,
    'the record must be reachable through the pointer, which is how the library and docs/installation.md name it')
})

test('[o3d-kyqa] the resolution refuses a tree THIS RUN did not publish, which is what the on-disk record alone cannot detect', (t) => {
  const dirs = scratch(t)
  // The mutation is performed by a SECOND publication out of a different source — which is exactly
  // what a concurrent privileged run does, and what only root can do — and the record on disk is
  // rewritten with it, so a check against the record would pass.
  const out = run(dirs, [
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'before="$(privileged_helper_path chown-tree.mjs)"; echo "BEFORE_RC=$?"',
    'echo "BEFORE=${before}"',
    // A second run, in its own shell, publishing different bytes into the same root.
    `printf 'process.exit(1)\\n' >> ${JSON.stringify(join(dirs.src, 'chown-tree.mjs'))}`,
    `bash -c ${JSON.stringify(
      `set -uo pipefail; source ${JSON.stringify(join(REPO, FENCE_LIB_REL))}; `
      + `IMS_SCRIPT_LIB_DIR=${JSON.stringify(dirs.src)}; source ${JSON.stringify(join(dirs.work, 'privileged-helpers.sh'))}; `
      + 'publish_privileged_helper_set',
    )}; echo "SECOND_RC=$?"`,
    'after="$(privileged_helper_path chown-tree.mjs)"; echo "AFTER_RC=$?"',
    'echo "AFTER=${after}"',
  ].join('\n'))

  // NOT VACUOUS: it resolved before the second publication and refused after it, so the refusal is
  // the digest comparison talking and not a rig that never resolved anything.
  assert.match(out.stdout, /^PUBLISH_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^BEFORE_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout,
    new RegExp(`^BEFORE=${dirs.root}/\\.version-helpers\\.[1-9][0-9]*\\.[A-Za-z0-9]+/helpers/chown-tree\\.mjs$`, 'm'),
    out.stdout)
  assert.match(out.stdout, /^SECOND_RC=0$/m, `the second publication must succeed:\n${out.stdout}${out.stderr}`)
  assert.doesNotMatch(out.stdout, /^AFTER_RC=0$/m,
    `the resolution must refuse a tree this run did not publish:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^AFTER=$/m, out.stdout)
  // AND THE REFUSAL REACHES THE OPERATOR. The callers read this function through a command
  // substitution, so a reason kept only in a variable dies with the subshell.
  assert.match(out.stderr, /refusing to execute bytes this run did not publish/, out.stderr)
  assert.match(out.stderr, /sha256sum -c .*helper-set\.manifest/, out.stderr)
  // The RECORD on disk now matches the tampered tree, which is the point of the in-memory digest.
  const record = readFileSync(standingFile(dirs.root, 'helpers', 'helper-set.sha256'), 'utf8')
  const recorded = /^tree_sha256=([0-9a-f]{64})$/m.exec(record)![1]
  const measured = execFileSync('bash', ['-c',
    `cd ${JSON.stringify(join(dirs.root, 'helpers'))} && find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum`,
  ], { encoding: 'utf8' }).split(' ')[0]
  assert.equal(recorded, measured,
    'the on-disk record must agree with the tampered tree — that is why the check is against the digest the RUN holds')
})

test('[o3d-kyqa] a published tree made hostile after the publication is refused, and the same tree untouched resolves', (t) => {
  for (const shape of [
    {
      name: 'a symlink planted inside the published tree',
      plant: (root: string) => symlinkSync('/etc/passwd', join(root, 'helpers', 'planted.mjs')),
      expect: /is no longer sealed/,
    },
    {
      name: 'a published helper made group-writable',
      plant: (root: string) => chmodSync(join(root, 'helpers', 'chown-tree.mjs'), 0o664),
      expect: /is no longer sealed/,
    },
    {
      name: 'a published helper rewritten in place',
      plant: (root: string) => writeFileSync(join(root, 'helpers', 'chown-tree.mjs'), '// other bytes\n'),
      expect: /refusing to execute bytes this run did not publish/,
    },
  ]) {
    const dirs = scratch(t)
    // PRECONDITION: publish, and resolve. Without this the refusal below could be a rig that never
    // reached the function at all.
    const control = run(dirs, [
      'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
      'p="$(privileged_helper_path chown-tree.mjs)"; echo "CONTROL_RC=$?"',
    ].join('\n'))
    assert.match(control.stdout, /^PUBLISH_RC=0$/m, `${shape.name}: ${control.stdout}${control.stderr}`)
    assert.match(control.stdout, /^CONTROL_RC=0$/m,
      `${shape.name}: the unmodified tree must resolve, or the refusal below proves nothing:\n${control.stdout}${control.stderr}`)

    // THE HAZARD: the tree is made hostile AFTER it was published, and this run's digest is the one
    // it was published with — which is what the second line supplies, since a fresh shell has none.
    shape.plant(dirs.root)
    const digest = /^tree_sha256=([0-9a-f]{64})$/m.exec(readFileSync(standingFile(dirs.root, 'helpers', 'helper-set.sha256'), 'utf8'))![1]
    const refused = run(dirs, [
      `IMS_DRIVER_HELPER_SHA256=${JSON.stringify(digest)}`,
      'p="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
      'echo "PATH_IS=${p}"',
    ].join('\n'))
    assert.doesNotMatch(refused.stdout, /^RESOLVE_RC=0$/m,
      `${shape.name} must be refused:\n${refused.stdout}${refused.stderr}`)
    assert.match(refused.stdout, /^PATH_IS=$/m, `${shape.name}: and no path handed back`)
    assert.match(refused.stderr, shape.expect, `${shape.name}:\n${refused.stderr}`)
  }
})

test('[o3d-kyqa] a source directory that is not a flat set of regular files publishes NOTHING', (t) => {
  // A symlink in the SOURCE would be copied as its target's bytes or followed at exec; either way it
  // is executable surface the digest does not describe. It is refused, and the refusal publishes
  // nothing at all — not a partial tree, not an empty one.
  for (const shape of [
    {
      name: 'a symlink',
      plant: (src: string) => symlinkSync('/etc/passwd', join(src, 'sneaky.mjs')),
      clean: (src: string) => rmSync(join(src, 'sneaky.mjs')),
    },
    {
      // A SUBDIRECTORY IS REFUSED TOO, and not because it is dangerous: the one-level copy would skip
      // it while the DOCUMENTED digest recipe (`find . -type f`, no maxdepth) would hash its contents,
      // so an operator's IMS_HELPER_SET_SHA256 could never match and the refusal would name no cause.
      name: 'a subdirectory',
      plant: (src: string) => { mkdirSync(join(src, 'nested')); writeFileSync(join(src, 'nested', 'x.mjs'), '// x\n') },
      clean: (src: string) => rmSync(join(src, 'nested'), { recursive: true }),
    },
    {
      name: 'a fifo',
      plant: (src: string) => { execFileSync('mkfifo', [join(src, 'pipe.mjs')]) },
      clean: (src: string) => rmSync(join(src, 'pipe.mjs')),
    },
  ]) {
    const dirs = scratch(t)
    shape.plant(dirs.src)
    const out = run(dirs, PUBLISH_THEN_RESOLVE)
    assertPublishedNothing(out, dirs.root, `${shape.name} in the source`)
    assert.match(out.stderr, /is not a regular file\. Only regular files are published/, `${shape.name}:\n${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^RESOLVE_RC=0$/m, `${shape.name}: and nothing may be resolved afterwards`)

    // NOT VACUOUS: the same root with the shape gone publishes.
    shape.clean(dirs.src)
    const ok = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
    assert.match(ok.stdout, /^DIGEST=[0-9a-f]{64}$/m, `${shape.name}: ${ok.stdout}${ok.stderr}`)
  }
})

test('[o3d-kyqa] the documented digest recipe reproduces what the publication records', (t) => {
  // THE PIN IS ONLY USABLE IF AN OPERATOR CAN COMPUTE IT. docs/installation.md prints a command; this
  // runs that command over the source directory and requires it to equal the digest the shipped
  // publication recorded. A recipe that had drifted from the implementation would make every pin fail
  // with a message that names two digests and no cause.
  const dirs = scratch(t)
  const out = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
  const digest = /^DIGEST=([0-9a-f]{64})$/m.exec(out.stdout)
  assert.ok(digest, `${out.stdout}${out.stderr}`)

  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const recipe = "find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum"
  assert.ok(doc.includes(recipe), `docs/installation.md must print the recipe verbatim: ${recipe}`)
  const measured = execFileSync('bash', ['-c', `cd ${JSON.stringify(dirs.src)} && ${recipe}`], { encoding: 'utf8' }).split(' ')[0]
  assert.equal(measured, digest[1],
    'the documented recipe must reproduce the digest the publication recorded, or no operator can pin')
})

test('[o3d-kyqa] a source directory with no regular files in it is a refusal, not a publication of nothing', (t) => {
  const dirs = scratch(t, [])
  const out = run(dirs, PUBLISH_THEN_RESOLVE)
  assertPublishedNothing(out, dirs.root, 'an empty source directory')
  assert.match(out.stderr, /holds no regular files/, out.stderr)

  // NOT VACUOUS: one file in it and the same call publishes.
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// x\n')
  const ok = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
  assert.match(ok.stdout, /^DIGEST=[0-9a-f]{64}$/m, ok.stdout)
})

test('[o3d-kyqa] a privileged run STOPS when it cannot publish, and an unprivileged one carries on having published nothing', (t) => {
  // THE TOLERANCE, AND THE FATALITY, MEASURED SEPARATELY — because the harness is not root and would
  // otherwise only ever see the tolerant branch.
  //
  // ROUTE: the same failure (an empty source directory) driven twice. Once as this account, where
  // the function returns 0 because an unprivileged run executes nothing privileged and so has nothing
  // to refuse; once with `id` reporting uid 0, where the same failure must return 1 so the entrypoint
  // stops before it has changed anything.
  const dirs = scratch(t, [])
  const tolerant = run(dirs, 'publish_privileged_helper_set; echo "PUBLISH_RC=$?"\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
  assert.match(tolerant.stdout, /^PUBLISH_RC=0$/m,
    `an unprivileged run must not be stopped by a publication it was never going to make:\n${tolerant.stdout}${tolerant.stderr}`)
  assertPublishedNothing(tolerant, dirs.root, 'unprivileged')

  const fatal = run(dirs, [
    // The shipped function asks `id -u`. A shell function shadows the binary for the whole program,
    // which is how this harness states "suppose this were root" without being root.
    'id() { if [[ "${1:-}" == "-u" ]]; then echo 0; else command id "$@"; fi; }',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))
  assert.match(fatal.stdout, /^PUBLISH_RC=1$/m,
    `a privileged run must stop when it cannot publish:\n${fatal.stdout}${fatal.stderr}`)
  assertPublishedNothing(fatal, dirs.root, 'privileged')
})

test('[o3d-kyqa] IMS_HELPER_SET_SHA256 refuses a tree it does not describe, and publishes the one it does', (t) => {
  const dirs = scratch(t)
  const measured = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
  const digest = /^DIGEST=([0-9a-f]{64})$/m.exec(measured.stdout)
  assert.ok(digest, measured.stdout + measured.stderr)
  clearStanding(dirs.root, 'helpers')

  const wrong = 'f'.repeat(64)
  const refused = run(dirs, PUBLISH_THEN_RESOLVE, { IMS_HELPER_SET_SHA256: wrong })
  assertPublishedNothing(refused, dirs.root, 'a pin that does not match')
  assert.match(refused.stderr, new RegExp(`IMS_HELPER_SET_SHA256 expects ${wrong} but .* hashes to ${digest[1]}`), refused.stderr)

  // NOT VACUOUS IN THE OTHER DIRECTION: the right digest publishes, so the pin is a comparison and
  // not a blanket refusal.
  const accepted = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"', { IMS_HELPER_SET_SHA256: digest[1] })
  assert.match(accepted.stdout, new RegExp(`^DIGEST=${digest[1]}$`, 'm'), `${accepted.stdout}${accepted.stderr}`)
})

test('[o3d-kyqa] the publication root is refused under an ancestor somebody else can rename, and accepted once it is not', (t) => {
  const base = createTempDirSync('privileged-helper-ancestry-', t)
  const parent = join(base, 'parent')
  const src = join(base, 'src')
  const work = join(base, 'work')
  mkdirSync(parent); mkdirSync(src); mkdirSync(work)
  writeFileSync(join(src, 'chown-tree.mjs'), '// x\n')
  const dirs = { root: join(parent, 'root'), src, work }

  chmodSync(parent, 0o777)
  const refused = run(dirs, PUBLISH_THEN_RESOLVE)
  assertPublishedNothing(refused, dirs.root, 'a world-writable parent')
  assert.match(refused.stderr, new RegExp(`${parent} has mode 777`), refused.stderr)
  assert.match(refused.stderr, /chmod g-w,o-w/, 'the refusal must name the remedy')

  // NOT VACUOUS: the same root under the same parent, with group and other write taken off, publishes.
  chmodSync(parent, 0o755)
  const ok = run(dirs, 'publish_privileged_helper_set >/dev/null 2>&1\necho "DIGEST=${IMS_DRIVER_HELPER_SHA256}"')
  assert.match(ok.stdout, /^DIGEST=[0-9a-f]{64}$/m, `${ok.stdout}${ok.stderr}`)

  // AND THE STICKY BIT IS NOT CREDITED AT THE PARENT, only above it: a 1777 parent still lets
  // another account create that name before this run does.
  rmSync(join(parent, 'root'), { recursive: true })
  chmodSync(parent, 0o1777)
  const sticky = run(dirs, PUBLISH_THEN_RESOLVE)
  assertPublishedNothing(sticky, dirs.root, 'a sticky parent')
  assert.match(sticky.stderr, /immediate parent, where the sticky bit would still let another account create that name first/, sticky.stderr)
  chmodSync(parent, 0o755)
})

test('[o3d-kyqa] a resolution with no publication behind it refuses, and says why nothing was published', (t) => {
  const dirs = scratch(t)
  const out = run(dirs, [
    'p="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
    'for name in ../../etc/passwd "" "a/b"; do q="$(privileged_helper_path "${name}")"; echo "NAME_RC=$?"; done',
  ].join('\n'))
  assert.doesNotMatch(out.stdout, /^RESOLVE_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stderr, /no root-owned snapshot of the helper set was published by this run/, out.stderr)
  const names = out.stdout.match(/^NAME_RC=\d+$/gm) ?? []
  assert.equal(names.length, 3, `all three names must be answered: ${out.stdout}`)
  assert.deepEqual([...new Set(names)], ['NAME_RC=1'], `no name may be resolved: ${out.stdout}`)
})

// ---------------------------------------------------------------------------
// 3. THE ROOT-OWNED DRIVER AND ITS METADATA (o3d-z5be)
// ---------------------------------------------------------------------------

test('[o3d-z5be] the driver is published root-owned, with the three entrypoints and the library beside them', (t) => {
  const base = createTempDirSync('privileged-driver-', t)
  const root = join(base, 'root')
  const scripts = join(base, 'scripts')
  const work = join(base, 'work')
  mkdirSync(root); mkdirSync(join(scripts, 'lib'), { recursive: true }); mkdirSync(work)
  for (const name of ['install.sh', 'update.sh', 'deploy.sh']) writeFileSync(join(scripts, name), `# ${name}\n`)
  writeFileSync(join(scripts, 'lib', 'chown-tree.mjs'), '// x\n')
  const dirs = { root, src: join(scripts, 'lib'), work }

  const out = run(dirs, [
    `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
    'echo "DIGEST=${IMS_DRIVER_PUBLISHED_DIGEST}"',
  ].join('\n'))
  assert.match(out.stdout, /^RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^DIGEST=[0-9a-f]{64}$/m, out.stdout)
  for (const rel of [
    join(root, 'driver/install.sh'), join(root, 'driver/update.sh'), join(root, 'driver/deploy.sh'),
    join(root, 'driver/lib/chown-tree.mjs'),
    standingFile(root, 'driver', 'driver.sha256'), standingFile(root, 'driver', 'driver.manifest'),
  ]) {
    assert.ok(existsSync(rel), `${rel} must be published`)
    const st = statSync(rel)
    assert.equal(st.uid, process.getuid!(), `${rel} must be owned by the publishing account`)
    assert.equal(st.mode & 0o022, 0, `${rel} must not be writable by group or other`)
  }

  // A missing entrypoint is a refusal, not a driver with a hole in it.
  rmSync(join(scripts, 'deploy.sh'))
  const missing = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`)
  assert.doesNotMatch(missing.stdout, /^RC=0$/m, `${missing.stdout}${missing.stderr}`)
  assert.match(missing.stderr, /deploy\.sh is not in this checkout/, missing.stderr)
  // And the previous driver is still standing: a failed publication replaces nothing.
  assert.ok(existsSync(join(root, 'driver/deploy.sh')), 'a failed publication must leave the old tree')
})

test('[o3d-z5be] the deployment metadata is published root-owned and private, and only a private file is read back', (t) => {
  const dirs = scratch(t)
  const out = run(dirs, [
    'printf \'GIT_REPO_URL=git@example.invalid:o/r.git\\nGIT_BRANCH=main\\n\' | publish_privileged_deploy_meta; echo "WRITE_RC=$?"',
    'path="$(privileged_deploy_meta_path)"; echo "READ_RC=$?"',
    'echo "PATH_IS=${path}"',
  ].join('\n'))
  assert.match(out.stdout, /^WRITE_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^READ_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, new RegExp(`^PATH_IS=${dirs.root}/deploy-meta$`, 'm'), out.stdout)
  const st = statSync(join(dirs.root, 'deploy-meta'))
  assert.equal(st.mode & 0o7777, 0o600, `the metadata must be private (mode ${(st.mode & 0o7777).toString(8)})`)
  assert.match(readFileSync(join(dirs.root, 'deploy-meta'), 'utf8'), /^GIT_REPO_URL=git@example\.invalid:o\/r\.git$/m)

  // A file anybody may write is not evidence about anything.
  chmodSync(join(dirs.root, 'deploy-meta'), 0o666)
  const loose = run(dirs, 'path="$(privileged_deploy_meta_path)"; echo "READ_RC=$?"')
  assert.doesNotMatch(loose.stdout, /^READ_RC=0$/m, `${loose.stdout}${loose.stderr}`)
  assert.match(loose.stderr, /not a regular file owned by this account and writable by nobody else/, loose.stderr)

  // An absent one refuses with the sentence an operator can act on, rather than being read as an answer.
  rmSync(join(dirs.root, 'deploy-meta'))
  const absent = run(dirs, 'path="$(privileged_deploy_meta_path)"; echo "READ_RC=$?"')
  assert.doesNotMatch(absent.stdout, /^READ_RC=0$/m, `${absent.stdout}${absent.stderr}`)
  assert.match(absent.stderr, /install\.sh writes it from o3d-z5be onwards/, absent.stderr)
})

test('[o3d-z5be] install.sh publishes both, update.sh reads the root-owned metadata and announces any fall back', () => {
  const install = ENTRYPOINT_SOURCE.get('scripts/install.sh')!
  const update = ENTRYPOINT_SOURCE.get('scripts/update.sh')!

  const installCode = codeLines(install).map((l) => l.text).join('\n')
  assert.match(installCode, /publish_privileged_driver "\$\(dirname "\$\{IMS_SCRIPT_LIB_DIR\}"\)"/,
    'install.sh must publish the root-owned driver from the release it is installing')
  assert.match(installCode, /\| publish_privileged_deploy_meta \|\| die/,
    'install.sh must publish the root-owned deployment metadata, and refuse if it cannot')

  // THE READ. Every GIT_* value must come from the resolved source, never from the app-owned path
  // directly — and the count is asserted so a fourth key added elsewhere shows up here.
  const reads = codeLines(update).filter((l) => /env_file_value GIT_/.test(l.text))
  assert.equal(reads.length, 3, `update.sh must read exactly the three deployment keys: ${reads.map((r) => r.text.trim()).join(' | ')}`)
  for (const read of reads) {
    assert.match(read.text, /env_file_value GIT_[A-Z_]+ "\$\{DEPLOY_META_SOURCE\}"/,
      `update.sh:${read.n} must read the resolved metadata source, not an application-owned path directly: ${read.text.trim()}`)
  }
  const updateCode = codeLines(update).map((l) => l.text).join('\n')
  assert.match(updateCode, /DEPLOY_META_SOURCE="\$\(privileged_deploy_meta_path\)" \|\| DEPLOY_META_SOURCE=""/,
    'update.sh must prefer the root-owned metadata')
  assert.match(updateCode, /warn "Reading the re-clone source from \$\{DEPLOY_META_FILE\}, which \$\{APP_USER\} owns\./,
    'and it must ANNOUNCE a fall back to the application-owned file rather than taking it silently')
  assert.match(updateCode, /publish_privileged_driver "\$\{APP_DIR\}\/scripts"/,
    'update.sh must refresh the root-owned driver from the release it has just deployed')
})

test('[o3d-z5be] the documented update command is the root-owned driver', () => {
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const programDir = `${DRIVER_ROOT}/driver`

  const heading = doc.indexOf('\n## Updating\n')
  assert.notEqual(heading, -1, 'docs/installation.md must still have an Updating section')
  const fenceStart = doc.indexOf('```bash', heading)
  assert.notEqual(fenceStart, -1, 'and it must still open with a command block')
  const fenceEnd = doc.indexOf('```', fenceStart + 7)
  const block = doc.slice(fenceStart, fenceEnd)
  assert.ok(block.length > 0 && block.length < 2000, `the command block must be the short one (${block.length} bytes)`)

  // THE CLAIM IS ABOUT THE COMMAND, not about a nearby sentence: the runnable lines of the first
  // block under `## Updating` are what an operator copies.
  const commands = block.split('\n').slice(1).filter((line) => line.trim() && !line.trim().startsWith('#'))
  assert.deepEqual(commands, [`sudo bash ${programDir}/update.sh`],
    `the documented update command must be the root-owned driver, and it is: ${JSON.stringify(commands)}`)
  assert.ok(doc.includes(programDir), 'and the document must name that directory')
  assert.ok(!doc.includes('cd /opt/one-two-inventory\n\n# Preferred: run the bundled update script'),
    'the application-owned form must no longer be the documented one')
})

// ---------------------------------------------------------------------------
// 3b. WHAT VOUCHES FOR THE BYTES THAT ENTER THE ROOT-OWNED DRIVER
//     (o3d-z5be r2, Codex HIGH 1)
//
// THE FINDING. update.sh refreshed ${IMS_DRIVER_PROGRAM_DIR} at the END of a successful run
// from ${APP_DIR}/scripts — a tree ${APP_USER} owns — so that account could replace
// update.sh there after every fetch and build check and before the copy. Root then copied
// those bytes into the root-owned driver with no external digest, and the next documented
// `sudo bash ${IMS_DRIVER_PROGRAM_DIR}/update.sh` executed them AS ROOT. Root ownership and
// the one-release lag postponed the escalation; they did not remove it.
//
// THE RULE NOW, and it is the one this repository already reached for the fence artefact: a
// source only the publishing account can write vouches for itself; otherwise the operator
// vouches out of band with IMS_DRIVER_SHA256; otherwise NOTHING is published and the copy
// standing there is untouched. Every case below runs the shipped publication.
// ---------------------------------------------------------------------------

/** A scratch release tree — scripts/{install,update,deploy}.sh and scripts/lib — beside a scratch
 *  publication root. Everything is created by this process, so "owned by the publishing account and
 *  writable by nobody else" holds until a case below deliberately breaks it. */
function scratchRelease(t: TestContext, prefix = 'privileged-driver-vouch-'): {
  root: string; scripts: string; dirs: { root: string; src: string; work: string }
} {
  const base = createTempDirSync(prefix, t)
  const root = join(base, 'root')
  const scripts = join(base, 'scripts')
  const work = join(base, 'work')
  mkdirSync(root); mkdirSync(join(scripts, 'lib'), { recursive: true }); mkdirSync(work)
  for (const name of ['install.sh', 'update.sh', 'deploy.sh']) writeFileSync(join(scripts, name), `# ${name}\n`)
  writeFileSync(join(scripts, 'lib', 'chown-tree.mjs'), '// chown-tree.mjs\nprocess.exit(0)\n')
  return { root, scripts, dirs: { root, src: join(scripts, 'lib'), work } }
}

/** Verbatim from docs/installation.md — asserted to be verbatim by the test below, so this constant
 *  and the document cannot drift into two different recipes. */
const DOCUMENTED_DRIVER_RECIPE = 'd="$(mktemp -d)" && mkdir "${d}/lib" \\\n'
  + '  && cp scripts/install.sh scripts/update.sh scripts/deploy.sh "${d}/" \\\n'
  + '  && cp scripts/lib/* "${d}/lib/" \\\n'
  + '  && ( cd "${d}" && find . -type f -printf \'%P\\0\' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum ) \\\n'
  + '  ; rm -rf "${d}"'

/** The digest the documented recipe produces for the tree a driver publication WOULD publish: the
 *  three entrypoints and lib, and nothing else that happens to sit in scripts/. An operator who
 *  cannot compute this cannot use IMS_DRIVER_SHA256, so it is computed here the way the document
 *  says to and compared against what the shipped publication records. */
function documentedDriverDigest(scripts: string): string {
  const recipe = DOCUMENTED_DRIVER_RECIPE.replaceAll('scripts/', `${scripts}/`)
  return execFileSync('bash', ['-c', recipe], { encoding: 'utf8' }).trim().split(' ')[0]
}

test('[o3d-z5be] a driver source an unprivileged account could rewrite publishes NOTHING, and the standing copy is untouched', (t) => {
  // THE SHAPES ARE MODE-BASED, not owner-based, and the two are the same question: this harness
  // cannot chown a file to another account, and "writable by somebody who is not the publisher" is
  // what the gate asks. In production the publisher is root and ${APP_DIR}/scripts fails the OWNER
  // half of exactly this check; here it fails the MODE half of exactly this check.
  for (const shape of [
    {
      name: 'an entrypoint the group can write',
      offender: (scripts: string) => join(scripts, 'update.sh'),
      break_: (scripts: string) => chmodSync(join(scripts, 'update.sh'), 0o664),
      mend: (scripts: string) => chmodSync(join(scripts, 'update.sh'), 0o644),
    },
    {
      name: 'a library helper the world can write',
      offender: (scripts: string) => join(scripts, 'lib', 'chown-tree.mjs'),
      break_: (scripts: string) => chmodSync(join(scripts, 'lib', 'chown-tree.mjs'), 0o666),
      mend: (scripts: string) => chmodSync(join(scripts, 'lib', 'chown-tree.mjs'), 0o644),
    },
    {
      name: 'a scripts directory anybody can write',
      offender: (scripts: string) => scripts,
      break_: (scripts: string) => chmodSync(scripts, 0o777),
      mend: (scripts: string) => chmodSync(scripts, 0o755),
    },
    {
      name: 'a lib directory the group can write',
      offender: (scripts: string) => join(scripts, 'lib'),
      break_: (scripts: string) => chmodSync(join(scripts, 'lib'), 0o775),
      mend: (scripts: string) => chmodSync(join(scripts, 'lib'), 0o755),
    },
  ]) {
    const { root, scripts, dirs } = scratchRelease(t)

    // PRECONDITION: the same source, unbroken, publishes. Without this the refusal below could be a
    // rig that never reached the publication at all.
    const control = run(dirs, [
      `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
      'echo "DIGEST=${IMS_DRIVER_PUBLISHED_DIGEST}"',
    ].join('\n'))
    assert.match(control.stdout, /^RC=0$/m, `${shape.name}: ${control.stdout}${control.stderr}`)
    const published = /^DIGEST=([0-9a-f]{64})$/m.exec(control.stdout)
    assert.ok(published, `${shape.name}: ${control.stdout}${control.stderr}`)
    const standing = readFileSync(join(root, 'driver', 'update.sh'), 'utf8')

    // THE HAZARD. The bytes change too, because that is what an account with write access does —
    // and it is the substitution that must not reach ${IMS_DRIVER_PROGRAM_DIR}.
    shape.break_(scripts)
    writeFileSync(join(scripts, 'update.sh'), '# update.sh\nexec /bin/sh\n')
    const refused = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`)
    assert.match(refused.stdout, /^RC=2$/m,
      `${shape.name}: an unvouched source must be refused with status 2:\n${refused.stdout}${refused.stderr}`)
    assert.match(refused.stderr, /NOTHING VOUCHES FOR THE BYTES/, `${shape.name}:\n${refused.stderr}`)
    assert.ok(refused.stderr.includes(shape.offender(scripts)),
      `${shape.name}: the refusal must NAME the path an operator has to act on; it said:\n${refused.stderr}`)
    assert.match(refused.stderr, /IMS_DRIVER_SHA256=/, `${shape.name}: and the out-of-band way out`)
    assert.match(refused.stderr, /fetch the release as root into a directory root has just created/, `${shape.name}: and the other one`)
    // AND NOT A RELABEL (o3d-z5be r6, Codex HIGH 1): chown/chmod of an existing tree revokes no write descriptor.
    assert.doesNotMatch(refused.stderr, /take group and other write off/, `${shape.name}: the remedy must not be a relabel`)

    // AND THE COPY STANDING THERE IS THE ONE THE CONTROL PUBLISHED, byte for byte.
    assert.equal(readFileSync(join(root, 'driver', 'update.sh'), 'utf8'), standing,
      `${shape.name}: a refused publication must replace nothing`)
    assert.match(readFileSync(standingFile(root, 'driver', 'driver.sha256'), 'utf8'),
      new RegExp(`^tree_sha256=${published[1]}$`, 'm'), `${shape.name}: nor the record`)
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('.publish-')), [],
      `${shape.name}: and a refused publication leaves no staging directory behind`)

    // NOT VACUOUS IN THE OTHER DIRECTION: mend the one thing this case broke — the hostile bytes are
    // still there — and the same call publishes them, because the tree now vouches for itself.
    shape.mend(scripts)
    const mended = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`)
    assert.match(mended.stdout, /^RC=0$/m,
      `${shape.name}: mending the mode must be the whole difference:\n${mended.stdout}${mended.stderr}`)
    assert.match(readFileSync(join(root, 'driver', 'update.sh'), 'utf8'), /exec \/bin\/sh/,
      `${shape.name}: and it publishes what is there, which is why the gate is about who could write it`)
  }
})

test('[o3d-z5be] IMS_DRIVER_SHA256 is what an operator vouches with, and it refuses the tree it does not describe', (t) => {
  const { root, scripts, dirs } = scratchRelease(t)

  // The digest of the tree AS THE RELEASE SHIPS IT, taken while the source still vouches for itself.
  const control = run(dirs, [
    `publish_privileged_driver ${JSON.stringify(scripts)} >/dev/null 2>&1; echo "RC=$?"`,
    'echo "DIGEST=${IMS_DRIVER_PUBLISHED_DIGEST}"',
  ].join('\n'))
  const digest = /^DIGEST=([0-9a-f]{64})$/m.exec(control.stdout)
  assert.ok(digest, `${control.stdout}${control.stderr}`)
  assert.equal(documentedDriverDigest(scripts), digest[1],
    'the documented recipe must reproduce the digest the shipped publication records, or no operator can use the pin')
  clearStanding(root, 'driver')

  // NOW THE SOURCE IS ONE SOMEBODY ELSE CAN WRITE, and the content is unchanged — so the release's
  // digest still describes it, and the operator's statement is what lets it through.
  chmodSync(join(scripts, 'update.sh'), 0o664)
  const unpinned = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`)
  assert.match(unpinned.stdout, /^RC=2$/m, `${unpinned.stdout}${unpinned.stderr}`)
  assert.equal(existsSync(join(root, 'driver')), false, 'nothing may be published without a voucher')

  const pinned = run(dirs, [
    `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
    'echo "DIGEST=${IMS_DRIVER_PUBLISHED_DIGEST}"',
  ].join('\n'), { IMS_DRIVER_SHA256: digest[1] })
  assert.match(pinned.stdout, /^RC=0$/m,
    `the operator's digest must publish the tree it describes:\n${pinned.stdout}${pinned.stderr}`)
  assert.match(pinned.stdout, new RegExp(`^DIGEST=${digest[1]}$`, 'm'), pinned.stdout)
  assert.ok(existsSync(join(root, 'driver', 'update.sh')))

  // AND A DIGEST THAT DESCRIBES SOMETHING ELSE REFUSES — naming IMS_DRIVER_SHA256 and not the
  // helper set's variable, which is a different pin on a different tree.
  writeFileSync(join(scripts, 'update.sh'), '# update.sh\nexec /bin/sh\n')
  const wrong = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
    { IMS_DRIVER_SHA256: digest[1] })
  assert.match(wrong.stdout, /^RC=1$/m,
    `a pin that does not match is a failure and not the "nothing vouched" answer:\n${wrong.stdout}${wrong.stderr}`)
  assert.match(wrong.stderr, new RegExp(`IMS_DRIVER_SHA256 expects ${digest[1]} but the root-owned deployment driver`), wrong.stderr)
  assert.doesNotMatch(wrong.stderr, /IMS_HELPER_SET_SHA256/, 'the refusal must name the variable the operator would set')
  assert.doesNotMatch(readFileSync(join(root, 'driver', 'update.sh'), 'utf8'), /exec \/bin\/sh/,
    'and the tree that was there is still there')
})

test('[o3d-z5be] the documented driver-digest recipe is the one in docs/installation.md, verbatim', () => {
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  assert.ok(doc.includes(DOCUMENTED_DRIVER_RECIPE),
    `docs/installation.md must print the driver-digest recipe verbatim; looked for:\n${DOCUMENTED_DRIVER_RECIPE}`)
  assert.ok(doc.includes('IMS_DRIVER_SHA256'),
    'and it must document the variable the operator sets it on')
})

test('[o3d-z5be] a source renamed UNDER the copy is refused, though its trust answer was clean', (t) => {
  // THE WINDOW THE TRUST WALK ALONE DOES NOT CLOSE. A rename changes no path, no owner and no mode —
  // only which object a path names — so asking "who can write this?" twice cannot see it. The shipped
  // filler takes the kernel's view of the source before the copy and again after it.
  //
  // THE SWAP IS DRIVEN THROUGH `cat`, which is the command the shipped filler copies WITH: a shell
  // function shadows it for the whole program, so the source changes between the first entrypoint and
  // the end of the copy without this harness reimplementing any part of the publication.
  const { root, scripts, dirs } = scratchRelease(t, 'privileged-driver-ident-')
  const swap = [
    'swapped=0',
    'cat() {',
    '  command cat "$@"',
    '  if (( swapped == 0 )); then',
    '    swapped=1',
    `    command mv ${JSON.stringify(join(scripts, 'lib'))} ${JSON.stringify(join(scripts, 'lib.moved'))}`,
    `    command mkdir ${JSON.stringify(join(scripts, 'lib'))}`,
    `    printf '// other bytes\\n' > ${JSON.stringify(join(scripts, 'lib', 'chown-tree.mjs'))}`,
    '  fi',
    '}',
  ].join('\n')

  const refused = run(dirs, [
    swap,
    `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
    'echo "SWAPPED=${swapped}"',
  ].join('\n'))
  assert.match(refused.stdout, /^SWAPPED=1$/m,
    `the harness must actually have swapped the source:\n${refused.stdout}${refused.stderr}`)
  assert.match(refused.stdout, /^RC=1$/m, `${refused.stdout}${refused.stderr}`)
  assert.match(refused.stderr, /was not the same tree after the copy as before it/, refused.stderr)
  assert.equal(existsSync(join(root, 'driver')), false, 'and nothing may be published')

  // NOT VACUOUS: the same source, the same call, no swap.
  rmSync(join(scripts, 'lib'), { recursive: true })
  rmSync(join(scripts, 'lib.moved'), { recursive: true, force: true })
  mkdirSync(join(scripts, 'lib'))
  writeFileSync(join(scripts, 'lib', 'chown-tree.mjs'), '// chown-tree.mjs\n')
  const ok = run(dirs, `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`)
  assert.match(ok.stdout, /^RC=0$/m, `${ok.stdout}${ok.stderr}`)
})

// ---------------------------------------------------------------------------
// 3c. TWO OVERLAPPING RUNS SHARE NO STAGING TREE (o3d-z5be r2, Codex HIGH 2)
// ---------------------------------------------------------------------------

test('[o3d-kyqa] a concurrent publication cannot substitute its bytes into the tree THIS run is about to hash', (t) => {
  // THE FINDING. Every publication of a kind used to assemble at ONE name — `${target}.staged` — and
  // the publication happens before the shared cutover lock, so a second privileged run could empty
  // and refill the first run's staging tree in the window between the first run assembling it and the
  // first run HASHING it. The first then hashed, renamed and recorded the SECOND run's bytes as its
  // own: its readonly digest matched them, privileged_helper_path() handed them out, and the
  // substitution the design calls "a refusal in every run that did not perform it" was undetected.
  //
  // THE INTERLEAVING IS DRIVEN AT THE EXACT POINT THE WINDOW OPENED: `chmod -R u=rwX,go=rX` is the
  // shipped statement between the fill and the digest, and shadowing that command puts the second run
  // there without reimplementing anything. The assertion is about the BYTES that end up resolvable,
  // which is what the whole mechanism is for.
  const dirs = scratch(t)
  const mine = readFileSync(join(dirs.src, 'chown-tree.mjs'), 'utf8')
  const theirs = '// THE SECOND RUN\nprocess.exit(1)\n'
  const shared = join(dirs.root, 'helpers.staged')

  const out = run(dirs, [
    'injected=0',
    'chmod() {',
    '  command chmod "$@"',
    '  if [[ "$*" == *u=rwX* ]] && (( injected == 0 )); then',
    '    injected=1',
    `    echo "ROOT_DURING=$(command ls -A ${JSON.stringify(dirs.root)} | LC_ALL=C sort | tr '\\n' ' ')"`,
    `    command rm -rf ${JSON.stringify(shared)}`,
    `    command mkdir -p ${JSON.stringify(shared)}`,
    `    printf ${JSON.stringify(theirs)} > ${JSON.stringify(join(shared, 'chown-tree.mjs'))}`,
    '  fi',
    '}',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "INJECTED=${injected}"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
    'p="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
    'echo "RESOLVED=${p}"',
  ].join('\n'))

  // PRECONDITIONS, so a pass cannot be a rig that never reached the window.
  assert.match(out.stdout, /^INJECTED=1$/m,
    `the second run must have run inside the window:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^PUBLISH_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^RESOLVE_RC=0$/m, `${out.stdout}${out.stderr}`)

  // THE STAGING TREE THIS RUN ASSEMBLED IN WAS ITS OWN, and it was not the shared name.
  const during = /^ROOT_DURING=(.*)$/m.exec(out.stdout)
  assert.ok(during, out.stdout)
  const staging = during[1].trim().split(/\s+/).filter((name) => name.startsWith('.publish-'))
  assert.equal(staging.length, 1, `the publication must assemble in exactly one private directory: ${during[1]}`)
  assert.match(staging[0], /^\.publish-helpers\.[0-9]+\.[A-Za-z0-9]+$/,
    `and its name must carry the kind and the publishing shell: ${staging[0]}`)
  assert.ok(!during[1].split(/\s+/).includes('helpers.staged'),
    `nothing may be assembled at a name a second run would use: ${during[1]}`)

  // AND THE BYTES ROOT WOULD EXECUTE ARE THIS RUN'S. This is the assertion the shared name failed:
  // the second run's tree is still sitting there, and it is not what was published or resolved.
  const resolved = /^RESOLVED=(.+)$/m.exec(out.stdout)
  assert.ok(resolved, out.stdout)
  assert.equal(readFileSync(resolved[1], 'utf8'), mine,
    'the resolution must hand back the bytes THIS run published, not the bytes a concurrent run staged')
  assert.notEqual(readFileSync(resolved[1], 'utf8'), theirs)
  assert.equal(readFileSync(join(shared, 'chown-tree.mjs'), 'utf8'), theirs,
    'precondition: the second run really did write a different tree at the shared name')

  // AND THE RECORDED DIGEST DESCRIBES THIS RUN'S SOURCE, measured with the documented recipe over the
  // source directory — so "it published something" cannot pass for "it published the right thing".
  const measured = execFileSync('bash', ['-c',
    `cd ${JSON.stringify(dirs.src)} && find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum`,
  ], { encoding: 'utf8' }).split(' ')[0]
  assert.match(out.stdout, new RegExp(`^DIGEST=${measured}$`, 'm'),
    `the digest this run holds must describe its own source:\n${out.stdout}`)
})

test('[o3d-kyqa] a staging directory whose run is gone is swept, and a live one is left alone', (t) => {
  // THE COST OF PER-RUN NAMES, PAID RATHER THAN LEFT: a run killed between the `mktemp` and the
  // rename leaves a root-owned copy of an old release under /etc that nothing will ever finish
  // publishing. The sweep takes those and only those, and "only those" is the half that has to be
  // measured — a sweep that took a LIVE run's tree would be the substitution bug again.
  const dirs = scratch(t)
  const dead = join(dirs.root, '.publish-helpers.999999999.aaaaaa')
  mkdirSync(dead); writeFileSync(join(dead, 'x'), 'x\n')

  const out = run(dirs, [
    // A directory named for THIS program's own shell, which is alive for as long as the publication
    // runs — so if the sweep asked no question about liveness it would take this one too.
    `live=${JSON.stringify(join(dirs.root, '.publish-helpers'))}.$$.bbbbbb`,
    'command mkdir -p "${live}"',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "LIVE_KEPT=$( [[ -d "${live}" ]] && echo yes || echo no )"',
    `echo "DEAD_SWEPT=$( [[ -d ${JSON.stringify(dead)} ]] && echo no || echo yes )"`,
  ].join('\n'))

  assert.match(out.stdout, /^PUBLISH_RC=0$/m, `${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^DEAD_SWEPT=yes$/m,
    `an orphan whose publisher is gone must be removed:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^LIVE_KEPT=yes$/m,
    `and a directory whose publisher is alive must be left alone:\n${out.stdout}${out.stderr}`)
  // The publication's own directory is gone too: nothing is left behind on the success path.
  const leftovers = readdirSync(dirs.root).filter((name) => name.startsWith('.publish-') && !name.includes('bbbbbb'))
  assert.deepEqual(leftovers, [], `a completed publication must leave no staging directory: ${leftovers.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 3d. TWO PUBLISHERS RACING OVER THE FINAL NAME (o3d-z5be r3, Codex HIGH)
// ---------------------------------------------------------------------------

/**
 * A SECOND PUBLISHER, AS A SHELL FRAGMENT: a shadow of `mv` that plants a COMPLETE publication of its
 * own at the documented name at every instant that name is free, and counts how many instants it found.
 *
 * WHY `mv` IS THE SEAM. It is the command every version of this publication has used to change what a
 * documented name resolves to, so the rig needs to know nothing about the sequence around it — which is
 * what lets the same test measure the shape that raced and the shape that cannot.
 */
function secondPublisherAtEveryFreeInstant(root: string, target: string, bytes: string): string {
  const theirs = join(root, '.theirs')
  return [
    'planted=0',
    // TAKE THE NAME IF IT IS FREE, and say so. A whole publication of the second run's own: the
    // interloper is not a marker file, because what the trap turned on was the destination being a
    // populated DIRECTORY.
    'take_the_name_if_free() {',
    `  if [[ -e ${JSON.stringify(target)} ]] || [[ -L ${JSON.stringify(target)} ]]; then return 0; fi`,
    '  planted=$(( planted + 1 ))',
    `  command rm -rf ${JSON.stringify(theirs)}`,
    `  command mkdir -p ${JSON.stringify(theirs)}`,
    `  printf ${JSON.stringify(bytes)} > ${JSON.stringify(join(theirs, 'chown-tree.mjs'))}`,
    `  printf ${JSON.stringify(bytes)} > ${JSON.stringify(join(theirs, 'pg-auth-request.mjs'))}`,
    `  command cp -r ${JSON.stringify(theirs)} ${JSON.stringify(target)}`,
    '}',
    // SAMPLED ON BOTH SIDES OF THE RENAME, which is the difference between measuring the window and
    // measuring one end of it. A sequence that frees the name with something other than `mv` —
    // `rm -rf ${target}` immediately before the rename, say — opens exactly the window this is about,
    // and an exit-only sample would never see it.
    'mv() {',
    '  take_the_name_if_free',
    '  command mv "$@"',
    '  local rc=$?',
    '  take_the_name_if_free',
    '  return $rc',
    '}',
  ].join('\n')
}

test('[o3d-z5be] two publishers racing over the FINAL name: no tree is nested inside another and no digest is recorded for bytes the driver will not run', (t) => {
  // THE FINDING (Codex HIGH, r3). Per-run staging fixed the wrong half. The publication still did
  // `mv ${target} retired` and then `mv staged ${target}`, and BETWEEN those two the documented name did
  // not exist — so a second privileged run could take it. `mv src dst` where `dst` is an existing
  // DIRECTORY does not replace dst: it moves src INSIDE it, as `dst/staged`, and RETURNS SUCCESS. The
  // loser therefore recorded its own digest, reported a publication, and left its tree nested inside the
  // winner's, while the documented command executed the winner's top-level files.
  //
  // THE FIX UNDER TEST is that the documented name is a symbolic link flipped by one `rename(2)`, so
  // there is no instant at which it is free and no destination a rename could nest into.
  const dirs = scratch(t)
  const target = join(dirs.root, 'helpers')
  const mine = readFileSync(join(dirs.src, 'chown-tree.mjs'), 'utf8')
  const theirs = '// THE SECOND PUBLISHER\nprocess.exit(1)\n'
  const rig = secondPublisherAtEveryFreeInstant(dirs.root, target, theirs)

  // ---- THE RIG CAN FIRE, PROVED WITHOUT THE PUBLICATION IN THE PICTURE. A race test whose interloper
  // never ran would pass against anything, and this is the only way to know it CAN run that does not
  // depend on the very sequence under test.
  const capable = run(dirs, [
    rig,
    `mv ${JSON.stringify(join(dirs.work, 'a'))} ${JSON.stringify(join(dirs.work, 'b'))} 2>/dev/null`,
    'echo "PLANTED=${planted}"',
    `echo "TOOK_THE_NAME=$( [[ -d ${JSON.stringify(target)} ]] && echo yes || echo no )"`,
  ].join('\n'))
  assert.match(capable.stdout, /^PLANTED=1$/m,
    `the rig must plant when the documented name is free, or it proves nothing below:\n${capable.stdout}${capable.stderr}`)
  assert.match(capable.stdout, /^TOOK_THE_NAME=yes$/m,
    `and what it plants must really occupy the name:\n${capable.stdout}${capable.stderr}`)
  rmSync(target, { recursive: true, force: true })

  // ---- A PUBLICATION IS STANDING, which is the state every box is in after an install. This is what
  // makes the retire step reachable in the shape that raced.
  const first = run(dirs, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(first.stdout, /^RC=0$/m, `${first.stdout}${first.stderr}`)

  // ---- AND NOW THE RACE, over the final name, with the second publisher taking it at every instant it
  // is free.
  const raced = run(dirs, [
    rig,
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "PLANTED=${planted}"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))

  // NOTHING IS NESTED. This is the assertion the retire-then-rename sequence failed: it left OUR tree at
  // `helpers/staged/` inside the second publisher's directory.
  const entries = readdirSync(target, { withFileTypes: true })
  assert.deepEqual(entries.filter((e) => e.isDirectory()).map((e) => e.name), [],
    `no publication may end up nested inside another at ${target}: ${entries.map((e) => e.name).join(', ')}`)
  assert.deepEqual(entries.map((e) => e.name).sort(), ['chown-tree.mjs', 'pg-auth-request.mjs'],
    `the documented name must hold exactly one flat publication: ${entries.map((e) => e.name).join(', ')}`)

  // AND THE BYTES AT THE DOCUMENTED NAME ARE THE ONES WHOSE DIGEST WAS RECORDED. On the shape that
  // raced these two disagreed, which is the whole finding.
  const standingBytes = readFileSync(join(target, 'chown-tree.mjs'), 'utf8')
  assert.equal(standingBytes, mine,
    `the documented name must resolve to the publication that reported success:\n${raced.stdout}${raced.stderr}`)
  assert.notEqual(standingBytes, theirs)
  assert.match(raced.stdout, /^PUBLISH_RC=0$/m, `${raced.stdout}${raced.stderr}`)
  const digest = /^DIGEST=([0-9a-f]{64})$/m.exec(raced.stdout)
  assert.ok(digest, `${raced.stdout}${raced.stderr}`)
  const measured = execFileSync('bash', ['-c',
    `cd ${JSON.stringify(target)} && find . -type f -printf '%P\\0' | LC_ALL=C sort -z | xargs -0 -r sha256sum -- | sha256sum`,
  ], { encoding: 'utf8' }).split(' ')[0]
  assert.equal(digest[1], measured,
    'the digest reported as published must be the digest of the tree the documented name resolves to')
  assert.match(readFileSync(standingFile(dirs.root, 'helpers', 'helper-set.sha256'), 'utf8'),
    new RegExp(`^tree_sha256=${digest[1]}$`, 'm'),
    'and the record committed beside that tree must describe it, because one rename committed both')

  // AND THERE WAS NEVER AN INSTANT TO RACE FOR. The rig plants whenever the documented name is free and
  // it has just been proved able to; that it found no instant is the atomicity claim, measured.
  assert.match(raced.stdout, /^PLANTED=0$/m,
    `the publication must never leave the documented name unoccupied:\n${raced.stdout}${raced.stderr}`)
})

test('[o3d-z5be] the name a publication commits and the name the resolution will follow are the same name', () => {
  // WHY THIS IS NOT TIDINESS. The versioned directory name is BUILT from ${IMS_DRIVER_VERSION_PREFIX} and
  // VALIDATED by a literal regular expression inside driver_standing_tree(), because a pointer whose text
  // is merely followed could name a tree outside the one directory whose ownership this run established.
  // Two spellings of one name is a silent break: change the constant and every publication still commits,
  // while every resolution refuses what it just committed — and the failure lands minutes later, as root,
  // on a box mid-cutover.
  const prefix = /^readonly IMS_DRIVER_VERSION_PREFIX="([^"]+)"$/
    .exec(shellConstant(LIB_SOURCE, 'IMS_DRIVER_VERSION_PREFIX', LIB_REL))
  assert.ok(prefix, 'the version prefix must be one quoted literal')
  const resolve = shellFunction(LIB_SOURCE, 'driver_standing_tree', LIB_REL)
  const escaped = prefix[1].replace(/\./g, '\\.')
  assert.ok(resolve.includes(`^${escaped}`),
    `driver_standing_tree() must validate the prefix it is committed under (^${escaped}); it says:\n${resolve}`)
  // AND THE SWEEP MUST KNOW THE SAME THREE NAMES, or residue accumulates under /etc unexamined.
  const sweep = shellFunction(LIB_SOURCE, 'driver_sweep_orphans', LIB_REL)
  for (const name of ['IMS_DRIVER_PUBLISH_PREFIX', 'IMS_DRIVER_VERSION_PREFIX', 'IMS_DRIVER_RETIRE_PREFIX', 'IMS_DRIVER_POINTER_PREFIX']) {
    assert.ok(sweep.includes(name), `driver_sweep_orphans() must collect ${name} residue`)
  }
})

test('[o3d-z5be] a publication another run overtakes at the final name reports NOTHING published', (t) => {
  // THE OTHER HALF OF THE SAME RACE. Whichever rename lands last decides what stands — that is what a
  // single mutable object means, and both candidates are complete, sealed, separately vouched-for trees.
  // What must not happen is the loser announcing a digest for bytes the documented command will not run.
  const dirs = scratch(t)
  const target = join(dirs.root, 'helpers')
  const theirs = '// THE RUN THAT LANDED LAST\nprocess.exit(1)\n'
  const overtake = [
    'overtaken=0',
    'mv() {',
    '  command mv "$@"',
    '  local rc=$?',
    `  if (( rc == 0 )) && [[ "\${!#}" == ${JSON.stringify(target)} ]] && (( overtaken == 0 )); then`,
    '    overtaken=1',
    `    command rm -rf ${JSON.stringify(join(dirs.root, '.theirs'))} ${JSON.stringify(target)}`,
    `    command mkdir -p ${JSON.stringify(join(dirs.root, '.theirs'))}`,
    `    printf ${JSON.stringify(theirs)} > ${JSON.stringify(join(dirs.root, '.theirs', 'chown-tree.mjs'))}`,
    `    command cp -r ${JSON.stringify(join(dirs.root, '.theirs'))} ${JSON.stringify(target)}`,
    '  fi',
    '  return $rc',
    '}',
  ].join('\n')

  const out = run(dirs, [
    overtake,
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "OVERTAKEN=${overtaken}"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
    'p="$(privileged_helper_path chown-tree.mjs)"; echo "RESOLVE_RC=$?"',
  ].join('\n'))

  // PRECONDITION: the rig really did take the name after this run's own rename landed.
  assert.match(out.stdout, /^OVERTAKEN=1$/m,
    `the second run must have taken the name after this one committed:\n${out.stdout}${out.stderr}`)
  assert.equal(readFileSync(join(target, 'chown-tree.mjs'), 'utf8'), theirs,
    'precondition: the tree standing at the documented name is the other run\'s')

  // MEASURED ON THE DIGEST AND THE REASON, NOT ON THE RETURN CODE — the same reason
  // assertPublishedNothing() gives: publish_privileged_helper_set() TOLERATES a failure when the account
  // running it is not root, and this harness is not root, so a return code would be measuring the
  // tolerance. ${IMS_DRIVER_HELPER_SHA256} is what actually gates every later execution.
  assert.match(out.stdout, /^DIGEST=$/m,
    `no digest may be recorded for bytes the documented name does not resolve to:\n${out.stdout}${out.stderr}`)
  assert.match(out.stderr, /another privileged run published/, out.stderr)
  assert.doesNotMatch(out.stdout, /^RESOLVE_RC=0$/m,
    'and nothing may be resolved out of a snapshot this run does not hold the digest of')
})

test('[o3d-z5be] a publication that fails after its tree is built leaves the PREVIOUS one standing, which is what the caller reports', (t) => {
  // THE FINDING (Codex MEDIUM 1, r3). The retired tree was deleted, and the record, manifest and final
  // fsync were written, AFTER the swap. A failure in any of them returned nonzero — callers say "the
  // driver was NOT refreshed" — with the NEW tree already standing and nothing left to restore, and
  // driver execution consults no record, so the next documented invocation ran the new bytes anyway.
  //
  // THE FIX UNDER TEST is that the record is written beside the tree inside the staging directory and the
  // pointer flip is the LAST mutation, so every failure path is upstream of anything becoming visible.
  //
  // THE INJECTION IS AT A SHIPPED SEAM: `_fence_publish_file` takes its temporary through `mktemp
  // "${target}.XXXXXX"`, so refusing that one `mktemp` fails exactly the record write, wherever in the
  // sequence it happens to be.
  const dirs = scratch(t, ['chown-tree.mjs'])
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// THE PUBLICATION THAT STANDS\n')
  const first = run(dirs, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(first.stdout, /^RC=0$/m, `${first.stdout}${first.stderr}`)
  const standing = readFileSync(join(dirs.root, 'helpers', 'chown-tree.mjs'), 'utf8')
  // THE RECORD NAMED THE WAY THE LIBRARY AND THE DOCS NAME IT, through the pointer. This path reaches the
  // record of the standing publication whichever way a release keeps it — `helpers/..` is the root itself
  // when `helpers` is a plain directory — so the assertions below are about the ORDERING and not about
  // the layout, which is what lets the same test fail against the sequence it was written for.
  const standingRecordPath = `${join(dirs.root, 'helpers')}/../helper-set.sha256`
  const standingRecord = readFileSync(standingRecordPath, 'utf8')

  // The next release's bytes, and a record write that cannot complete.
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// THE PUBLICATION THAT MUST NOT LAND\n')
  // THE COUNT GOES TO A FILE, NOT A VARIABLE. `_fence_publish_file` takes its temporary through
  // `tmp="$(mktemp ...)"` — a command substitution — and a variable incremented inside one dies with the
  // subshell, so a counter would read zero however many times the shadow fired.
  const marks = join(dirs.work, 'record-writes-refused')
  const failed = run(dirs, [
    'mktemp() {',
    `  if [[ "$*" == *helper-set.sha256.XXXXXX* ]]; then echo x >> ${JSON.stringify(marks)}; return 1; fi`,
    '  command mktemp "$@"',
    '}',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    `echo "REFUSED=$( [[ -f ${JSON.stringify(marks)} ]] && wc -l < ${JSON.stringify(marks)} || echo 0 )"`,
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))

  // PRECONDITION: the record write really was the thing that failed, once.
  assert.match(failed.stdout, /^REFUSED=1$/m,
    `the record write must have been reached and refused:\n${failed.stdout}${failed.stderr}`)
  // AND THE REPORT IS THE REFUSAL, not the return code: publish_privileged_helper_set() tolerates a
  // failure off root and this harness is not root, so the digest and the reason are the measurement.
  assert.match(failed.stdout, /^DIGEST=$/m, failed.stdout)

  // AND THE STATE MATCHES THE REPORT. This is the assertion the previous ordering failed: it reported
  // "not refreshed" while the new tree was the one the documented command would execute.
  assert.equal(readFileSync(join(dirs.root, 'helpers', 'chown-tree.mjs'), 'utf8'), standing,
    'the tree the documented name resolves to must be the one the caller was told is still standing')
  assert.equal(readFileSync(standingRecordPath, 'utf8'), standingRecord,
    'and its record must be untouched, so the record still describes the tree that is running')
  assert.deepEqual(readdirSync(dirs.root).filter((name) => name.startsWith('.publish-')), [],
    'and the abandoned staging tree must be gone')
  assert.equal(readdirSync(dirs.root).filter((name) => name.startsWith('.version-')).length, 1,
    'and no half-published version may be left under the root')
  // AND THE REASON SAYS WHICH STEP FAILED, on stderr, where a caller reading this library through a
  // command substitution can see it.
  assert.match(failed.stderr, /the digest record for the privileged helper set could not be written/,
    `the caller must be told the record could not be written:\n${failed.stderr}`)
})

test('[o3d-z5be] a superseded publication is swept once nothing names it, and the standing one never is', (t) => {
  // THE COST OF PUBLISHING BY POINTER FLIP, PAID RATHER THAN LEFT. Every publication is a new directory,
  // so without a sweep /etc accumulates every release ever deployed. And "only the superseded ones" is
  // the half that has to be measured: a sweep that took the STANDING tree would break the documented
  // command, and one that took a LIVE publisher's would be the substitution bug again.
  const dirs = scratch(t, ['chown-tree.mjs'])
  const versions: string[] = []
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(join(dirs.src, 'chown-tree.mjs'), `// release ${i}\n`)
    const out = run(dirs, [
      // A versioned directory named for THIS program's own shell, alive for as long as the publication
      // runs — so a sweep that asked no question about liveness would take it.
      `live=${JSON.stringify(join(dirs.root, '.version-helpers'))}.$$.zzzzzz`,
      'command mkdir -p "${live}"',
      'publish_privileged_helper_set; echo "RC=$?"',
      'echo "LIVE_KEPT=$( [[ -d "${live}" ]] && echo yes || echo no )"',
    ].join('\n'))
    assert.match(out.stdout, /^RC=0$/m, `publication ${i}: ${out.stdout}${out.stderr}`)
    assert.match(out.stdout, /^LIVE_KEPT=yes$/m,
      `publication ${i}: a versioned directory whose publisher is alive must be left alone:\n${out.stdout}`)
    // The live decoy is this test's, not a publication: take it away so the next round measures the
    // sweep against real versions only.
    for (const name of readdirSync(dirs.root)) {
      if (name.endsWith('.zzzzzz')) rmSync(join(dirs.root, name), { recursive: true, force: true })
    }
    versions.push(standingVersionDir(dirs.root, 'helpers'))
  }

  // PRECONDITION: three distinct publications really happened.
  assert.equal(new Set(versions).size, 3, `each publication must be its own directory: ${versions.join(', ')}`)
  // THE STANDING ONE IS THERE, and the oldest — superseded twice over, its publisher gone — is not.
  assert.ok(existsSync(versions[2]), 'the standing publication must never be swept')
  assert.equal(readFileSync(join(dirs.root, 'helpers', 'chown-tree.mjs'), 'utf8'), '// release 2\n')
  assert.equal(existsSync(versions[0]), false,
    `a publication nothing names, whose publisher is gone, must be swept: ${versions[0]} is still there`)
})

// ---------------------------------------------------------------------------
// 3e. HOW STALE THE STANDING DRIVER CAN GET, AND SAYING SO (o3d-z5be r3, Codex MEDIUM 2)
// ---------------------------------------------------------------------------

test('[o3d-z5be] the documented lag is unbounded rather than "one release", and the standing driver reports its own age', (t) => {
  // THE FINDING (Codex MEDIUM 2). A no-digest update deliberately leaves the driver untouched, so
  // repeated successful updates leave it arbitrarily many releases behind — while three statements said
  // otherwise: docs/installation.md called the copy "refreshed by every successful update" and "at most
  // one release behind", and update.sh called it the previous release.
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const upd = ENTRYPOINT_SOURCE.get('scripts/update.sh')!
  // PRECONDITIONS, so a walk that stopped reaching the files cannot pass as a walk that found the
  // claims corrected. Both files, and the section each claim lives in.
  assert.ok(doc.length > 100_000 && upd.length > 100_000, 'both files must have been read in full')
  assert.ok(doc.includes('sudo bash /etc/ims-cutover-driver/driver/update.sh'),
    'the documented update command must still be in installation.md, or this test is reading the wrong text')
  assert.ok(upd.includes('publish_privileged_driver "${APP_DIR}/scripts"'),
    'and update.sh must still refresh the driver at the end of a successful run')

  // THE THREE CORRECTED STATEMENTS. Each is asserted as a claim about the bound, not by proximity to a
  // paragraph that could sit next to the text correcting it.
  for (const [where, text, stale] of [
    ['docs/installation.md', doc, 'at most one release behind'],
    ['docs/installation.md', doc, 'refreshed by every'],
    ['scripts/update.sh', upd, 'ALWAYS ONE RELEASE BEHIND'],
    ['scripts/update.sh', upd, "The copy standing there is the previous release's"],
  ] as const) {
    assert.ok(!text.includes(stale), `${where} must no longer claim "${stale}": the lag is not bounded at one`)
  }
  assert.ok(doc.includes('not bounded at one'), 'installation.md must say what is true instead')
  assert.ok(doc.includes('refreshes nothing'),
    'and that an update without the digest completes while refreshing nothing')
  assert.ok(upd.includes('AT LEAST ONE RELEASE BEHIND WHAT IT DEPLOYS, AND THE LAG IS NOT BOUNDED AT ONE'),
    'and update.sh must say the same about the copy it declines to refresh')

  // AND THE STANDING DRIVER CAN SAY HOW OLD IT IS, which is what gives an operator who never supplies a
  // digest something to notice. Measured for real: publish, backdate the record, read the note.
  const { root, scripts, dirs } = scratchRelease(t, 'privileged-driver-age-')
  const published = run(dirs, [
    `publish_privileged_driver ${JSON.stringify(scripts)}; echo "RC=$?"`,
    'echo "NOTE=$(privileged_driver_age_note)"',
  ].join('\n'))
  assert.match(published.stdout, /^RC=0$/m, `${published.stdout}${published.stderr}`)
  assert.match(published.stdout, /^NOTE=.*was published 0 day\(s\) ago/m,
    `a driver published just now must report an age of zero:\n${published.stdout}${published.stderr}`)

  const record = standingFile(root, 'driver', 'driver.sha256')
  const backdated = readFileSync(record, 'utf8')
    .replace(/^tree_published_at=\d+$/m, `tree_published_at=${Math.floor(Date.now() / 1000) - 400 * 86_400}`)
  assert.match(backdated, /^tree_published_at=\d+$/m, 'the record must carry a publication date to backdate')
  writeFileSync(record, backdated)
  const aged = run(dirs, 'echo "NOTE=$(privileged_driver_age_note)"')
  assert.match(aged.stdout, /^NOTE=.*was published 400 day\(s\) ago.*NOT one release behind/m,
    `the note must read the date off the standing record:\n${aged.stdout}${aged.stderr}`)

  // AND UPDATE.SH PRINTS IT ON THE PATH WHERE THE REFRESH DID NOT HAPPEN, which is the only path an
  // operator who never supplies a digest ever takes.
  const warnBlock = upd.slice(upd.indexOf('DRIVER_PUBLISH_RC == 0'))
  const elseBranch = warnBlock.slice(0, warnBlock.indexOf('DEPLOY_OK=true'))
  assert.ok(elseBranch.includes('privileged_driver_age_note'),
    'update.sh must print the standing driver\'s age where it reports that the refresh did not happen')
  assert.ok(elseBranch.indexOf('was NOT refreshed') < elseBranch.indexOf('privileged_driver_age_note'),
    'and it must print it as part of that report rather than somewhere unrelated')
})

test('[o3d-z5be] the three-valued status is the shipped contract, and both entrypoints read all three', () => {
  const body = shellFunction(LIB_SOURCE, 'driver_fill_program', LIB_REL)

  // THE ORDER IS THE CLAIM: the provenance question is asked, answered and acted on BEFORE any byte
  // is copied. A gate after the copy would be a gate over bytes already in /etc.
  const trust = body.indexOf('driver_source_trust "${scripts_dir}"')
  const refuse = body.indexOf('return 2')
  const copy = body.indexOf('cat < "${scripts_dir}/${name}"')
  const identBefore = body.indexOf('before="$(driver_source_ident)"')
  const identAfter = body.indexOf('after="$(driver_source_ident)"')
  const positions: Array<[string, number]> = [
    ['the trust question', trust], ['the refusal', refuse], ['the copy', copy],
    ['the ident before', identBefore], ['the ident after', identAfter],
  ]
  for (const [what, at] of positions) {
    assert.notEqual(at, -1, `${what} must be in driver_fill_program():\n${body}`)
  }
  assert.ok(trust < refuse && refuse < identBefore && identBefore < copy && copy < identAfter,
    `the order must be trust, refuse, ident, copy, ident — got ${JSON.stringify({ trust, refuse, identBefore, copy, identAfter })}`)
  assert.equal(body.split('return 2').length - 1, 1, 'there must be exactly one "nothing vouched" answer')

  // AND THE LISTS THE `find` IS AIMED AT ARE THIS FRAME'S, so no other path can empty them and make
  // the question vacuous — the lesson lib/db-fence-protected.sh records above its own path lists.
  assert.match(body, /local -a _DRIVER_SRC_DIRS=\(\) _DRIVER_SRC_FILES=\(\) _DRIVER_SRC_TREES=\(\) _DRIVER_SRC_PARENTS=\(\)/,
    `the path lists must be locals of the frame that consumes the answer:\n${body}`)
  assert.match(body, /local IMS_DRIVER_SOURCE_UNTRUSTED_PATH=""/, `and so must the answer:\n${body}`)
  const libCode = LIB_SOURCE.split('\n').filter((line) => !/^\s*#/.test(line))
  assert.deepEqual(libCode.filter((line) => /^(_DRIVER_SRC_|IMS_DRIVER_SOURCE_UNTRUSTED_PATH=)/.test(line)), [],
    'and neither may exist at script scope, where another path could pre-set it')

  // BOTH ENTRYPOINTS DISTINGUISH 2 FROM EVERY OTHER FAILURE. Collapsing them would either abort a
  // deployment over a driver refresh or report a publication that did not happen.
  const install = codeLines(ENTRYPOINT_SOURCE.get('scripts/install.sh')!).map((l) => l.text).join('\n')
  const update = codeLines(ENTRYPOINT_SOURCE.get('scripts/update.sh')!).map((l) => l.text).join('\n')
  assert.match(install, /DRIVER_PUBLISH_RC=0\n\s*publish_privileged_driver "\$\(dirname "\$\{IMS_SCRIPT_LIB_DIR\}"\)" \|\| DRIVER_PUBLISH_RC=\$\?/,
    'install.sh must capture the status rather than treating every non-zero the same')
  assert.match(install, /if \(\( DRIVER_PUBLISH_RC == 2 \)\); then/, 'install.sh must warn on the vouch refusal')
  assert.match(install, /elif \(\( DRIVER_PUBLISH_RC != 0 \)\); then/, 'and still refuse on every other failure')
  assert.match(update, /DRIVER_PUBLISH_RC=0\n\s*publish_privileged_driver "\$\{APP_DIR\}\/scripts" \|\| DRIVER_PUBLISH_RC=\$\?/,
    'update.sh must capture the status too')
  assert.match(update, /if \(\( DRIVER_PUBLISH_RC == 2 \)\); then/, 'and say what would refresh the driver')
  assert.match(update, /IMS_DRIVER_SHA256=/, 'naming the digest an operator supplies')
})

// ---------------------------------------------------------------------------
// 4. AN ABSENT .env IS NOT PERMISSION TO MINT (o3d-xf9m)
// ---------------------------------------------------------------------------

const INSTALL_SOURCE = ENTRYPOINT_SOURCE.get('scripts/install.sh')!

/** The shipped absent-.env gate, run outside the shipped file with its two witnesses stubbed at the
 *  level the gate ASKS them — upgrade_in_place() and DB_CREATED_BY_THIS_RUN — and with `die` and
 *  `warn` replaced by sentinels so both outcomes are observable. */
function runAbsentEnvGate(t: TestContext, opts: { upgrade: boolean; dbCreated: boolean; remint?: boolean }): Run {
  const dir = createTempDirSync('absent-env-gate-', t)
  const body = shellFunction(INSTALL_SOURCE, 'require_absent_env_is_a_first_install', 'scripts/install.sh')
  const program = [
    'set -uo pipefail',
    'APP_DIR=/opt/one-two-inventory',
    'APP_USER=imsapp',
    'APP_NAME=one-two-inventory',
    `DB_CREATED_BY_THIS_RUN=${opts.dbCreated}`,
    'DB_NEWNESS_FINDING="database \'ims\' already existed on this server"',
    opts.remint ? 'IMS_INSTALL_REMINT_SECRETS=yes' : 'IMS_INSTALL_REMINT_SECRETS=',
    'die() { echo "DIED: $*"; exit 9; }',
    'warn() { echo "WARNED: $*"; }',
    `upgrade_in_place() { return ${opts.upgrade ? 0 : 1}; }`,
    body,
    'require_absent_env_is_a_first_install; echo "GATE_RC=$?"',
  ].join('\n')
  const scriptPath = join(dir, 'gate.sh')
  writeFileSync(scriptPath, program)
  try {
    return { status: 0, stdout: execFileSync('bash', [scriptPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('[o3d-xf9m] an absent .env permits minting only when the host AND the database both say first install', (t) => {
  // PRECONDITION: the gate was lifted out of the shipped file and really is the shipped text.
  const body = shellFunction(INSTALL_SOURCE, 'require_absent_env_is_a_first_install', 'scripts/install.sh')
  assert.ok(body.includes('upgrade_in_place'), `the gate must ask the host question:\n${body}`)
  assert.ok(body.includes('DB_CREATED_BY_THIS_RUN'), `and the database question:\n${body}`)

  // THE ONE COMBINATION THAT MINTS: nothing on the host, and this run created the database. That is
  // the supported from-scratch install, and it must not be made impossible by this gate.
  const fresh = runAbsentEnvGate(t, { upgrade: false, dbCreated: true })
  assert.match(fresh.stdout, /^GATE_RC=0$/m, `a genuine first install must mint:\n${fresh.stdout}`)
  assert.doesNotMatch(fresh.stdout, /^DIED/m, fresh.stdout)
  assert.doesNotMatch(fresh.stdout, /^WARNED/m, 'and it must not be warned at either')

  // EITHER WITNESS ALONE REFUSES, which is what makes the case above a decision rather than a
  // default. Both orders, because an `||` that short-circuits on the first would hide the second.
  for (const shape of [
    { name: 'an installation on this host', upgrade: true, dbCreated: true, expect: /an existing installation was found on this host/ },
    { name: 'a database this run did not create', upgrade: false, dbCreated: false, expect: /already existed on this server/ },
    { name: 'both', upgrade: true, dbCreated: false, expect: /an existing installation was found on this host/ },
  ]) {
    const refused = runAbsentEnvGate(t, { upgrade: shape.upgrade, dbCreated: shape.dbCreated })
    assert.equal(refused.status, 9, `${shape.name} must be refused:\n${refused.stdout}`)
    assert.doesNotMatch(refused.stdout, /^GATE_RC=/m, `${shape.name}: and the gate must not return:\n${refused.stdout}`)
    assert.match(refused.stdout, /^DIED: .*is ABSENT/m, `${shape.name}:\n${refused.stdout}`)
    assert.match(refused.stdout, shape.expect, `${shape.name}: the refusal must name what it found:\n${refused.stdout}`)
    assert.match(refused.stdout, /SETTINGS_ENCRYPTION_KEY/, `${shape.name}: and what is at stake`)
    assert.match(refused.stdout, /IMS_INSTALL_REMINT_SECRETS=yes/, `${shape.name}: and the deliberate way out`)
  }

  // AND THE OVERRIDE IS A DELIBERATE STATEMENT, NOT A SILENT ONE.
  const overridden = runAbsentEnvGate(t, { upgrade: true, dbCreated: false, remint: true })
  assert.match(overridden.stdout, /^GATE_RC=0$/m, overridden.stdout)
  assert.match(overridden.stdout, /^WARNED: IMS_INSTALL_REMINT_SECRETS=yes/m, overridden.stdout)
  assert.match(overridden.stdout, /permanently undecryptable/, overridden.stdout)
})

test('[o3d-xf9m] the preservation gate cannot return on an absent .env without consulting the first-install witnesses', () => {
  const body = shellFunction(INSTALL_SOURCE, 'require_preserved_secrets', 'scripts/install.sh')

  // THE DEFECT'S GRAMMAR: a bare short-circuit on anything but "read". That single line was the
  // whole of o3d-xf9m — it returned 0 for `absent`, which is what an unlink produces.
  assert.ok(!/^\s*\[\[ "\$\{ENV_FILE_STATE:-absent\}" == "read" \]\] \|\| return 0\s*$/m.test(body),
    `require_preserved_secrets() must not treat an absent .env as permission:\n${body}`)
  assert.match(body, /require_absent_env_is_a_first_install/,
    `it must consult the witnesses instead:\n${body}`)

  // AND THE FUNCTION IS STILL CALLED, at script scope, BEFORE the file that commits the mint is
  // written. A gate nobody reaches is not a gate.
  const scope = scriptScopeLines(INSTALL_SOURCE)
  const gate = scope.find((line) => line.text.trim() === 'require_preserved_secrets')
  assert.ok(gate, 'install.sh must still call require_preserved_secrets at script scope')
  const mint = codeLines(INSTALL_SOURCE).find((line) => /^AUTH_SECRET="\$\(existing_env AUTH_SECRET/.test(line.text))
  assert.ok(mint, 'install.sh must still mint AUTH_SECRET through existing_env')
  assert.ok(mint.n < gate!.n,
    `the mint is computed at line ${mint!.n} and gated at ${gate!.n}; the gate must come after the values are known and before they are written`)
  const publish = codeLines(INSTALL_SOURCE).find((line) => /write_app_env_file|APP_ENV_FILE_TARGET/.test(line.text) && line.n > gate!.n)
  assert.ok(publish, 'and the environment file must be written after the gate')
})

// ---------------------------------------------------------------------------
// 3f. THE STARTUP BLOCK: ONE PIN WITH NO FALLBACK, AND A ROOT REFUSAL (o3d-z5be r4/r5)
//
// r4 (Codex HIGH 1). The pointer flip is one `rename(2)`, which makes one RESOLUTION atomic and pins
// no reader: bash opened the entrypoint through the pointer and every `source` traversed it again.
// Each entrypoint now takes its directory off the descriptor bash is reading it from.
//
// r5 (Codex HIGH 2). r4's pin FELL BACK to `cd -P … && pwd -P` when the descriptor could not be
// validated — which resolves the pointer again. A sweep that unlinked the running release made the
// descriptor read "(deleted)" and the fallback land on the NEXT release: a silent mixture. The pin
// now refuses.
//
// r5 (Codex HIGH 1). Root running out of a tree another account can write cannot be made safe from
// inside that tree, so it is refused at startup — best-effort — and unsupported.
// ---------------------------------------------------------------------------

const STARTUP_FIRST_LINE = '# THE STARTUP BLOCK: WHICH TREE THIS RUN IS, AND WHETHER ROOT MAY RUN IT (o3d-z5be r4/r5)'
const STARTUP_LAST_LINE = '# ===================== END OF THE STARTUP BLOCK =============================='
/** The shipped startup block, lifted whole out of an entrypoint — from the rule line above its title to
 *  its end marker. Every behavioural assertion below runs THIS text. */
function pinBlock(rel: string): string {
  const source = ENTRYPOINT_SOURCE.get(rel)!
  const title = source.indexOf(STARTUP_FIRST_LINE)
  assert.notEqual(title, -1, `${rel} must carry the startup block`)
  const start = source.lastIndexOf('# ====', title)
  assert.ok(start >= 0 && start < title, `${rel}: the startup block must open with its rule line`)
  const end = source.indexOf(STARTUP_LAST_LINE, title)
  assert.notEqual(end, -1, `${rel} must close the startup block with its end marker`)
  return source.slice(start, end + STARTUP_LAST_LINE.length)
}

/** The block's CODE, comments dropped — the prose quotes the retired fallback by name. */
function blockCode(block: string): string {
  return block.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

test('[o3d-z5be] every entrypoint pins its library directory ONCE, off its own descriptor, as the first code it runs', () => {
  const blocks = ENTRYPOINTS.map((rel) => [rel, pinBlock(rel)] as const)
  assert.equal(blocks.length, 3)
  for (const [rel, block] of blocks) {
    assert.ok(block.length > 3000, `${rel}: the startup block must have been lifted whole (${block.length} bytes)`)
    // ONE TEXT, THREE FILES: it cannot live in a library, so byte-identity is the only defence against drift.
    assert.equal(block, blocks[0][1], `${rel} must carry the same startup block as ${blocks[0][0]}, byte for byte`)
    const code = blockCode(block)
    assert.ok(code.includes('link="$(readlink -- "/proc/$$/fd/255" 2>/dev/null)" || link=""'),
      `${rel} must pin off the descriptor bash is reading the script from`)
    // r5 HIGH 2: NO FALLBACK. Absence checks over the CODE — the comments name the retired form on purpose.
    assert.doesNotMatch(code, /\bcd -P\b|\bpwd -P\b|\bpwd\b/, `${rel}: the pin must have no path-resolving fallback:\n${code}`)
    assert.ok(code.includes("*' (deleted)'"), `${rel}: a deleted entrypoint must be refused in its own right`)
    assert.ok(code.includes("stat -L -c '%d:%i' -- \"/proc/$$/fd/255\""), `${rel}: the open inode must be compared with the path`)
  }
  for (const rel of ENTRYPOINTS) {
    const source = ENTRYPOINT_SOURCE.get(rel)!
    assert.ok(!source.includes('IMS_SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"'),
      `${rel} must not resolve its library through the pointer on every source`)
    const assignments = codeLines(source).filter((line) => /(^|[\s;])IMS_SCRIPT_LIB_DIR=/.test(line.text))
    assert.equal(assignments.length, 1, `${rel} must assign the pinned directory exactly once: ${JSON.stringify(assignments)}`)
    // AND IT IS THE FIRST CODE THE FILE RUNS: nothing before the block but the shebang, `set` and `IFS`.
    const blockAt = source.indexOf(pinBlock(rel))
    const before = codeLines(source.slice(0, blockAt)).map((line) => line.text.trim()).filter((text) => text !== '')
    assert.ok(before.length >= 1, `${rel}: precondition — the walk must have seen the lines before the block`)
    assert.deepEqual(before.filter((text) => !/^(#!\/usr\/bin\/env bash|set -euo pipefail|IFS=\$'\\n\\t')$/.test(text)), [],
      `${rel}: the startup block must be the first code this file executes`)
    const lines = scriptScopeLines(source)
    const pinAt = lines.findIndex((line) => /^IMS_SCRIPT_LIB_DIR=/.test(line.text))
    const firstSource = lines.findIndex((line) => /^source "\$\{IMS_SCRIPT_LIB_DIR\}/.test(line.text))
    assert.ok(pinAt >= 0 && firstSource >= 0 && pinAt < firstSource,
      `${rel} must pin before the first library read (pin at statement ${pinAt}, first source at ${firstSource})`)
  }
})

/** A two-release publication root: `driver -> .version-driver.1.aaaaaa/driver`, each release with its
 *  own lib/marker.sh, and the program `flipAndSource` that commits release B the way a publication does. */
function twoReleases(t: TestContext) {
  const base = createTempDirSync('privileged-pin-', t)
  const root = join(base, 'root')
  const versionA = join(root, '.version-driver.1.aaaaaa')
  const versionB = join(root, '.version-driver.2.bbbbbb')
  mkdirSync(join(versionA, 'driver', 'lib'), { recursive: true })
  mkdirSync(join(versionB, 'driver', 'lib'), { recursive: true })
  writeFileSync(join(versionA, 'driver', 'lib', 'marker.sh'), 'RELEASE=A\n')
  writeFileSync(join(versionB, 'driver', 'lib', 'marker.sh'), 'RELEASE=B\n')
  const reset = () => {
    rmSync(join(root, 'driver'), { force: true })
    symlinkSync('.version-driver.1.aaaaaa/driver', join(root, 'driver'))
  }
  reset()
  const flip = [
    `ln -s -- .version-driver.2.bbbbbb/driver ${JSON.stringify(join(root, '.pointer-driver.9.cccccc'))}`,
    `mv -T ${JSON.stringify(join(root, '.pointer-driver.9.cccccc'))} ${JSON.stringify(join(root, 'driver'))}`,
    `echo "FLIPPED_TO=$(readlink ${JSON.stringify(join(root, 'driver'))})"`,
  ].join('\n')
  const sourceIt = 'source "${IMS_SCRIPT_LIB_DIR}/marker.sh"\necho "SOURCED=${RELEASE}"'
  const runVia = (name: string, program: string) => {
    writeFileSync(join(versionA, 'driver', name), `${program}\n`)
    const out = spawnSync('bash', [join(root, 'driver', name)], { encoding: 'utf8' })
    return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
  }
  return { root, versionA, versionB, reset, flip, sourceIt, runVia }
}

test('[o3d-z5be] a publication that lands mid-run cannot change which release a pinned run sources from', (t) => {
  const r = twoReleases(t)
  const out = r.runVia('update.sh', [
    'set -uo pipefail',
    pinBlock('scripts/update.sh'),
    'echo "SELF=${IMS_ENTRYPOINT_SELF}"',
    r.flip,
    r.sourceIt,
  ].join('\n'))
  assert.match(out.stdout, /^FLIPPED_TO=\.version-driver\.2\.bbbbbb\/driver$/m,
    `the concurrent publication must really have committed:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, new RegExp(`^SELF=${r.versionA}/driver/update\\.sh$`, 'm'),
    `the pin must name the inode being executed, not the pointer:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^SOURCED=A$/m,
    `a pinned run must source the release it was launched from:\n${out.stdout}${out.stderr}`)

  // NOT VACUOUS: the r3 logical form, in the same rig, reaches the other release — the r4 finding.
  r.reset()
  const retired = r.runVia('legacy.sh', [
    'set -uo pipefail',
    'IMS_SCRIPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"',
    r.flip,
    r.sourceIt,
  ].join('\n'))
  assert.match(retired.stdout, /^SOURCED=B$/m,
    `the rig must be able to see a mixture: the logical form must reach the other release:\n${retired.stdout}${retired.stderr}`)
})

test('[o3d-z5be] a pin that cannot be validated REFUSES — a deleted release is never re-resolved through the pointer', (t) => {
  // THE r5 FINDING (Codex HIGH 2), DRIVEN FOR REAL. The subject program does what a concurrent
  // publication plus a sweep do to a run that has just opened release A through the pointer: B is
  // committed at the documented name and A is unlinked — and only THEN does the startup block run. bash
  // keeps executing A's bytes off its open descriptor, which now reads "… (deleted)". r4's pin fell back
  // to `cd -P` over `dirname "${BASH_SOURCE[0]}"` — the pointer — and sourced B's library.
  const r = twoReleases(t)
  const deleted = r.runVia('update.sh', [
    'set -uo pipefail',
    r.flip,
    `rm -rf ${JSON.stringify(r.versionA)}`,
    `echo "A_GONE=$( [[ -e ${JSON.stringify(r.versionA)} ]] && echo no || echo yes )"`,
    pinBlock('scripts/update.sh'),
    r.sourceIt,
  ].join('\n'))
  // PRECONDITIONS: the flip happened and A really is gone while bash is still running A's bytes.
  assert.match(deleted.stdout, /^FLIPPED_TO=\.version-driver\.2\.bbbbbb\/driver$/m, `${deleted.stdout}${deleted.stderr}`)
  assert.match(deleted.stdout, /^A_GONE=yes$/m, `${deleted.stdout}${deleted.stderr}`)
  // AND THE RUN REFUSES, BEFORE ANY `source`: no release's library was read at all.
  assert.doesNotMatch(deleted.stdout, /^SOURCED=/m,
    `a pin over a deleted entrypoint must not source anything — least of all the next release:\n${deleted.stdout}${deleted.stderr}`)
  assert.equal(deleted.status, 1, `${deleted.stdout}${deleted.stderr}`)
  assert.match(deleted.stderr, /has been DELETED since bash opened it/, deleted.stderr)

  // AND A DESCRIPTOR THAT CANNOT BE READ AT ALL IS A REFUSAL TOO — the branch r4 filled with a fallback.
  // mkdirSync recreates A so the run has something to execute.
  mkdirSync(join(r.versionA, 'driver', 'lib'), { recursive: true })
  writeFileSync(join(r.versionA, 'driver', 'lib', 'marker.sh'), 'RELEASE=A\n')
  r.reset()
  const unreadable = r.runVia('update.sh', [
    'set -uo pipefail',
    'readlink() { return 1; }',
    pinBlock('scripts/update.sh'),
    r.sourceIt,
  ].join('\n'))
  assert.doesNotMatch(unreadable.stdout, /^SOURCED=/m, `${unreadable.stdout}${unreadable.stderr}`)
  assert.equal(unreadable.status, 1)
  assert.match(unreadable.stderr, /cannot read \/proc\/[0-9]+\/fd\/255/, unreadable.stderr)

  // AND A DESCRIPTOR PATH THAT NAMES A DIFFERENT FILE THAN THE ONE OPEN — the one shape the basename and
  // "(deleted)" checks both pass. `readlink` is shadowed to answer with release B's update.sh: absolute,
  // the right basename, not deleted, a regular file. Only the comparison of the OPEN inode with that
  // path's inode stands between this and sourcing B's library.
  r.reset()
  writeFileSync(join(r.versionB, 'driver', 'update.sh'), '# release B\n')
  const elsewhere = r.runVia('update.sh', [
    'set -uo pipefail',
    `readlink() { echo ${JSON.stringify(join(r.versionB, 'driver', 'update.sh'))}; }`,
    pinBlock('scripts/update.sh'),
    r.sourceIt,
  ].join('\n'))
  assert.doesNotMatch(elsewhere.stdout, /^SOURCED=/m, `${elsewhere.stdout}${elsewhere.stderr}`)
  assert.equal(elsewhere.status, 1)
  assert.match(elsewhere.stderr, /no longer names the file this run is executing/, elsewhere.stderr)
})

// ---------------------------------------------------------------------------
// 3g. ROOT DOES NOT RUN OUT OF A TREE ANOTHER ACCOUNT CAN WRITE (o3d-z5be r5, Codex HIGH 1)
// ---------------------------------------------------------------------------

test('[o3d-z5be] the startup refusal names any path another account could have written, and passes a tree only its owner can', (t) => {
  // THE RULE, run for real: ims_startup_tree_offender lifted out of the shipped entrypoint. In production
  // it is called with uid 0; this suite cannot own files as root, so it asks the same question with its
  // own uid for the shapes that are about MODES — and with uid 0 over its own tree for the half that is
  // about OWNERSHIP, which is exactly how a tree owned by `imsapp` looks to the production call.
  const fn = shellFunction(ENTRYPOINT_SOURCE.get('scripts/update.sh')!, 'ims_startup_tree_offender', 'scripts/update.sh')
  const uid = String(process.getuid!())
  const base = createTempDirSync('startup-tree-', t)
  const rel = join(base, 'rel')
  const scripts = join(rel, 'scripts')
  const entry = join(scripts, 'update.sh')
  const lib = join(scripts, 'lib')
  const fresh = () => {
    rmSync(rel, { recursive: true, force: true })
    mkdirSync(join(lib, 'sub'), { recursive: true })
    writeFileSync(entry, '# update.sh\n')
    writeFileSync(join(lib, 'a.sh'), 'A=1\n')
    writeFileSync(join(lib, 'sub', 'b.mjs'), '// b\n')
    for (const dir of [rel, scripts, lib, join(lib, 'sub')]) chmodSync(dir, 0o755)
  }
  const ask = (trusted: string) => {
    const out = spawnSync('bash', ['-c', `set -uo pipefail\n${fn}\nims_startup_tree_offender ${JSON.stringify(entry)} ${trusted}; echo "RC=$?"; echo "OFFENDER=\${IMS_STARTUP_OFFENDER}"`], { encoding: 'utf8' })
    return `${out.stdout}${out.stderr}`
  }
  fresh()
  // PRECONDITION: the scratch tree's own ancestry passes, or every case below would name an ancestor.
  assert.match(ask(uid), /^RC=0\nOFFENDER=$/m, `a tree only its owner can write must pass:\n${ask(uid)}`)

  const shapes: Array<[string, () => void, string]> = [
    ['a library writable by group', () => chmodSync(join(lib, 'a.sh'), 0o664), join(lib, 'a.sh')],
    ['the entrypoint writable by other', () => chmodSync(entry, 0o646), entry],
    ['a file deeper in lib/ writable by group', () => chmodSync(join(lib, 'sub', 'b.mjs'), 0o664), join(lib, 'sub', 'b.mjs')],
    ['a symbolic link in lib/', () => symlinkSync('/etc/hostname', join(lib, 'link.sh')), join(lib, 'link.sh')],
    ['the scripts directory writable by group', () => chmodSync(scripts, 0o775), scripts],
    ['an ancestor writable by other and not sticky', () => chmodSync(rel, 0o757), rel],
  ]
  for (const [what, breakIt, offender] of shapes) {
    fresh()
    breakIt()
    const out = ask(uid)
    assert.match(out, /^RC=0$/m, `${what}: ${out}`)
    assert.ok(out.includes(`OFFENDER=${offender}\n`), `${what} must be named as the offender (${offender}):\n${out}`)
  }

  // A STICKY world-writable ancestor is credited: nobody but an entry's owner can rename it.
  fresh()
  chmodSync(rel, 0o1777)
  assert.match(ask(uid), /^RC=0\nOFFENDER=$/m, `a sticky ancestor must pass:\n${ask(uid)}`)

  // THE OWNERSHIP HALF: the production question (uid 0) over a tree another account owns names it.
  fresh()
  const asRoot = ask('0')
  assert.ok(asRoot.includes(`OFFENDER=${entry}\n`), `a tree not owned by root must be refused by the uid-0 call:\n${asRoot}`)

  // AN UNANSWERABLE QUESTION IS NOT A CLEAN ANSWER.
  fresh()
  rmSync(lib, { recursive: true })
  assert.match(ask(uid), /^RC=1$/m, `a tree whose lib/ cannot be inspected must return failure:\n${ask(uid)}`)
})

test('[o3d-z5be] the startup block refuses, as root, BEFORE any library is read, and names the root-owned driver', (t) => {
  // THE WIRING. The block's root gate is `${EUID}` — which no test can make 0 — so this runs the shipped
  // block with exactly TWO substitutions, each asserted to have happened once: the gate becomes `true`
  // and the trusted uid becomes this account's. Everything else — the order, the refusal, the exit — is
  // the shipped text. That the gate is `${EUID}` and the uid is 0 is asserted on the unsubstituted text.
  const block = pinBlock('scripts/deploy.sh')
  const code = blockCode(block)
  assert.equal(code.split('if [[ "${EUID}" == "0" ]]; then').length - 1, 1, 'the refusal must be gated on EUID 0, once')
  assert.equal(code.split('ims_startup_tree_offender "${IMS_ENTRYPOINT_SELF}" 0; then').length - 1, 1,
    'and must ask the question of uid 0')
  assert.ok(code.includes(`sudo bash ${DRIVER_ROOT}/driver/`), `the refusal must name the root-owned driver at ${DRIVER_ROOT}/driver`)
  const uid = String(process.getuid!())
  const wired = block
    .replace('if [[ "${EUID}" == "0" ]]; then', 'if true; then')
    .replace('ims_startup_tree_offender "${IMS_ENTRYPOINT_SELF}" 0; then', `ims_startup_tree_offender "\${IMS_ENTRYPOINT_SELF}" ${uid}; then`)
  assert.ok(!wired.includes('if [[ "${EUID}" == "0" ]]; then') && wired.includes(`"\${IMS_ENTRYPOINT_SELF}" ${uid}; then`),
    'both substitutions must have happened')

  const base = createTempDirSync('startup-wired-', t)
  const scripts = join(base, 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  chmodSync(base, 0o755); chmodSync(scripts, 0o755); chmodSync(join(scripts, 'lib'), 0o755)
  writeFileSync(join(scripts, 'lib', 'first.sh'), 'echo LIBRARY_READ\n')
  writeFileSync(join(scripts, 'deploy.sh'), `set -euo pipefail\n${wired}\nsource "\${IMS_SCRIPT_LIB_DIR}/first.sh"\n`)
  const clean = spawnSync('bash', [join(scripts, 'deploy.sh')], { encoding: 'utf8' })
  assert.equal(clean.status, 0, `a tree only its owner can write must run:\n${clean.stdout}${clean.stderr}`)
  assert.match(clean.stdout, /^LIBRARY_READ$/m, 'precondition: the rig reaches the first source on a clean tree')

  chmodSync(join(scripts, 'lib', 'first.sh'), 0o666)
  const refused = spawnSync('bash', [join(scripts, 'deploy.sh')], { encoding: 'utf8' })
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`)
  assert.doesNotMatch(refused.stdout, /LIBRARY_READ/, 'the refusal must come before the first library is read')
  assert.match(refused.stderr, /REFUSING TO RUN AS ROOT OUT OF A TREE ANOTHER ACCOUNT CAN WRITE/, refused.stderr)
  assert.ok(refused.stderr.includes(join(scripts, 'lib', 'first.sh')), `and name the path:\n${refused.stderr}`)
  assert.ok(refused.stderr.includes(`sudo bash ${DRIVER_ROOT}/driver/deploy.sh`), `and the supported command:\n${refused.stderr}`)
})

test('[o3d-z5be] docs/installation.md makes the writable-tree invocation UNSUPPORTED and does not call its refusal a boundary', () => {
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  assert.ok(doc.length > 100_000, 'precondition: the whole document was read')
  // ABSENCE of every statement that supported it — universal, so a correction beside one cannot hide it.
  for (const stale of [
    'still supported for a host',
    'it remains supported',
    'supported, unprotected',
    'unprotected-but-supported',
    'the three-read content-stability check above: a rewrite after the run starts is a refusal',
    '`bash scripts/update.sh --dry-run` from\nthe checkout does the same',
  ]) {
    assert.ok(!doc.includes(stale), `docs/installation.md must no longer say "${stale}"`)
  }
  const anchor = doc.indexOf('<a id="supported-invocations"></a>')
  assert.notEqual(anchor, -1, 'the supported-invocations section must exist')
  const section = doc.slice(anchor, doc.indexOf('`privileged_helper_path <name>` is the only way', anchor))
  assert.ok(section.length > 1000 && section.length < 8000, `the section must have been isolated (${section.length} bytes)`)
  const row = section.split('\n').find((line) => line.startsWith('| `sudo bash /opt/one-two-inventory/scripts/update.sh`'))
  assert.ok(row, 'the writable-tree row must be in the table')
  assert.match(row, /\*\*NOT SUPPORTED — refused at startup\*\*/, row)
  assert.match(section, /best-effort, and it is not the security boundary/, 'the refusal must be called best-effort, not a boundary')
  assert.match(section, /inside the tree it distrusts/, 'and say why')
  // And the library that withdrew the r4 content check really did.
  const libCode = LIB_SOURCE.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(libCode, /driver_fill_pin_digest|IMS_DRIVER_FILL_EXPECTED_DIGEST/,
    'the content-stability check the docs call withdrawn must not be in the code')
})

// ---------------------------------------------------------------------------
// 3h. A WRITE-NOTHING MODE WRITES NOTHING (o3d-z5be r5, Codex MEDIUM)
// ---------------------------------------------------------------------------

/**
 * The shipped entrypoint up to the statement after its startup publication, run from a scratch tree whose
 * lib/ is the shipped library with ONE substitution — the publication root — so what the prelude would
 * publish lands somewhere this test can look. `transform` is applied to the prelude text (the control
 * uses it to remove the write-nothing guard).
 */
function runPrelude(t: TestContext, rel: 'scripts/update.sh' | 'scripts/deploy.sh', flags: string[], transform = (text: string) => text) {
  const cut = rel === 'scripts/update.sh' ? /^DEPLOY_META_SOURCE=""$/ : /^crontab_lock_paths "\$\{CUTOVER_STATE_DIR\}"$/
  const lines = ENTRYPOINT_SOURCE.get(rel)!.split('\n')
  const end = lines.findIndex((line) => cut.test(line))
  assert.ok(end > 100, `${rel}: the prelude must be cut after the startup publication (line ${end})`)
  const base = createTempDirSync('write-nothing-', t)
  const root = join(base, 'publication-root')
  const stage = join(base, 'stage', 'scripts')
  const app = join(base, 'app')
  mkdirSync(join(stage, 'lib'), { recursive: true })
  mkdirSync(app)
  writeFileSync(join(app, '.env'), 'DATABASE_URL=postgresql://app:pw@127.0.0.1:5432/ims\n')
  writeFileSync(join(app, 'package.json'), '{"name":"fixture"}\n')
  for (const name of readdirSync(join(REPO, 'scripts/lib'))) {
    const text = readFileSync(join(REPO, 'scripts/lib', name), 'utf8')
    writeFileSync(join(stage, 'lib', name), name === 'privileged-helpers.sh' ? libraryAt(root) : text)
  }
  const prelude = transform(lines.slice(0, end).join('\n'))
  writeFileSync(join(stage, rel.split('/')[1]), `${prelude}\necho "PRELUDE_REACHED_END"\n`)
  const out = spawnSync('bash', [join(stage, rel.split('/')[1]), ...flags], {
    encoding: 'utf8', env: { ...process.env, IMS_APP_DIR: app },
  })
  const published = existsSync(root) ? readdirSync(root) : []
  return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '', published }
}

test('[o3d-z5be] --dry-run and --print-fence-digest publish nothing under the driver root, in both entrypoints that have them', (t) => {
  for (const [rel, flags] of [
    ['scripts/update.sh', ['--dry-run']],
    ['scripts/update.sh', ['--print-fence-digest']],
    ['scripts/deploy.sh', ['--dry-run']],
  ] as const) {
    const out = runPrelude(t, rel, [...flags])
    // PRECONDITION: the prelude ran THROUGH the publication statement rather than dying before it.
    assert.match(out.stdout, /^PRELUDE_REACHED_END$/m, `${rel} ${flags}: the prelude must reach its end:\n${out.stdout}${out.stderr}`)
    assert.deepEqual(out.published, [], `${rel} ${flags} must publish nothing: ${JSON.stringify(out.published)}`)
  }

  // NOT VACUOUS: the same prelude with the write-nothing guard removed publishes — so this rig can see a
  // publication, and it is the guard, not the rig, that keeps the directory empty.
  for (const rel of ['scripts/update.sh', 'scripts/deploy.sh'] as const) {
    let replaced = 0
    const out = runPrelude(t, rel, ['--dry-run'], (text) => text.replace(
      /^if ! \$DRY_RUN( && ! \$PRINT_FENCE_DIGEST)?; then$/m, () => { replaced += 1; return 'if true; then' }))
    assert.equal(replaced, 1, `${rel}: the control must have removed exactly one guard`)
    assert.match(out.stdout, /^PRELUDE_REACHED_END$/m, `${rel}: ${out.stdout}${out.stderr}`)
    assert.ok(out.published.includes('helpers'), `${rel}: without the guard the prelude must publish: ${JSON.stringify(out.published)}`)
  }

  // install.sh has no write-nothing mode to guard: it declares DRY_RUN false and parses no --dry-run.
  const install = codeLines(ENTRYPOINT_SOURCE.get('scripts/install.sh')!).map((line) => line.text).join('\n')
  assert.match(install, /^DRY_RUN=false$/m)
  assert.doesNotMatch(install, /--dry-run\)|DRY_RUN=true/, 'install.sh must still have no write-nothing mode')
})

test('[o3d-z5be] a superseded publication something is still reading out of is NOT swept, and is once nothing is', (t) => {
  // THE INTERACTION THE PIN MAKES LOAD-BEARING. A pinned run reads its libraries out of ONE versioned
  // directory for its whole life, and the shell that PUBLISHED that directory exited releases ago — so
  // the sweep's two original questions ("is a pointer naming it?", "is its publisher alive?") both
  // answer "reapable" the moment a newer publication takes the pointer, while a run is still sourcing
  // out of it. r3's answer was bash's open descriptor, which covers the bytes already read and not the
  // next `source`.
  const dirs = scratch(t, ['chown-tree.mjs'])
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// release 0\n')
  const first = run(dirs, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(first.stdout, /^RC=0$/m, `${first.stdout}${first.stderr}`)
  const superseded = standingVersionDir(dirs.root, 'helpers')
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// release 1\n')
  const second = run(dirs, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(second.stdout, /^RC=0$/m, `${second.stdout}${second.stderr}`)
  const standing = standingVersionDir(dirs.root, 'helpers')
  // PRECONDITIONS: two distinct publications, the first superseded and its publisher gone.
  assert.notEqual(superseded, standing, 'the second publication must be its own directory')
  assert.ok(existsSync(superseded), 'and the first must still be there for the sweep to decide about')
  const publisher = Number(/\.version-helpers\.([0-9]+)\./.exec(superseded)![1])
  assert.equal(spawnSync('kill', ['-0', String(publisher)]).status !== 0, true,
    `the publisher of the superseded directory must be gone, or this test measures the liveness rule instead (pid ${publisher})`)

  // THE SWEEP, RUN FOR REAL, WITH A DESCRIPTOR OPEN ON A FILE INSIDE THE SUPERSEDED DIRECTORY — which is
  // exactly what bash holds on the script it is executing, and what a pinned run holds on a library it
  // has not sourced yet.
  const held = run(dirs, [
    `exec 9< ${JSON.stringify(join(superseded, 'helpers', 'chown-tree.mjs'))}`,
    'driver_sweep_orphans /nonexistent; echo "SWEEP1=$?"',
    `echo "WHILE_HELD=$( [[ -d ${JSON.stringify(superseded)} ]] && echo kept || echo gone )"`,
    'exec 9<&-',
    'driver_sweep_orphans /nonexistent; echo "SWEEP2=$?"',
    `echo "ONCE_RELEASED=$( [[ -d ${JSON.stringify(superseded)} ]] && echo kept || echo gone )"`,
    `echo "STANDING=$( [[ -d ${JSON.stringify(standing)} ]] && echo kept || echo gone )"`,
  ].join('\n'))
  assert.match(held.stdout, /^SWEEP1=0$/m, `${held.stdout}${held.stderr}`)
  assert.match(held.stdout, /^WHILE_HELD=kept$/m,
    `a versioned directory a process is reading out of must not be swept:\n${held.stdout}${held.stderr}`)
  // AND THE OTHER HALF, which is what proves the first is not a sweep that never deletes anything.
  assert.match(held.stdout, /^ONCE_RELEASED=gone$/m,
    `and it must be swept once nothing is reading it:\n${held.stdout}${held.stderr}`)
  assert.match(held.stdout, /^STANDING=kept$/m, 'and the standing publication is never swept')
})

test('[o3d-z5be] a migration killed before it committed is RESTORED by the sweep, and reaped once the name is back', (t) => {
  // THE RESIDUAL r3 LEFT (Codex MEDIUM 1). `mv -T ${target} ${retire_dir}` and the pointer flip are two
  // operations; a kill between them leaves the documented name ABSENT and the only copy on the box under
  // a `.retired-` name, which the sweep then deleted because its publisher was gone.
  const dirs = scratch(t, ['chown-tree.mjs'])
  // A pid that is certainly not running: this shell has already exited.
  const deadPid = execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()
  assert.match(deadPid, /^[1-9][0-9]*$/)
  const retired = join(dirs.root, `.retired-helpers.${deadPid}.aaaaaa`)
  mkdirSync(retired, { recursive: true })
  writeFileSync(join(retired, 'chown-tree.mjs'), '// THE ONLY COPY ON THE BOX\n')
  assert.equal(existsSync(join(dirs.root, 'helpers')), false, 'precondition: the documented name is absent')

  const restored = run(dirs, [
    'driver_sweep_orphans /nonexistent; echo "RC=$?"',
    `echo "RESTORED=$( [[ -d ${JSON.stringify(join(dirs.root, 'helpers'))} ]] && echo yes || echo no )"`,
    `echo "RESIDUE=$( [[ -e ${JSON.stringify(retired)} ]] && echo yes || echo no )"`,
  ].join('\n'))
  assert.match(restored.stdout, /^RC=0$/m, `${restored.stdout}${restored.stderr}`)
  assert.match(restored.stdout, /^RESTORED=yes$/m,
    `the only copy on the box must be put back, not reaped:\n${restored.stdout}${restored.stderr}`)
  assert.match(restored.stdout, /^RESIDUE=no$/m, 'and it must not be left under both names')
  assert.equal(readFileSync(join(dirs.root, 'helpers', 'chown-tree.mjs'), 'utf8'), '// THE ONLY COPY ON THE BOX\n')

  // AND IT ONLY EVER FILLS A HOLE. With the documented name occupied, the same residue is reaped and the
  // standing publication is untouched — a restore that could displace a committed publication would be
  // a worse bug than the one it fixes.
  rmSync(join(dirs.root, 'helpers'), { recursive: true, force: true })
  const published = run(dirs, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(published.stdout, /^RC=0$/m, `${published.stdout}${published.stderr}`)
  const standingLink = readlinkSync(join(dirs.root, 'helpers'))
  mkdirSync(retired, { recursive: true })
  writeFileSync(join(retired, 'chown-tree.mjs'), '// A SUPERSEDED LEGACY TREE\n')
  const reaped = run(dirs, [
    'driver_sweep_orphans /nonexistent; echo "RC=$?"',
    `echo "RESIDUE=$( [[ -e ${JSON.stringify(retired)} ]] && echo yes || echo no )"`,
  ].join('\n'))
  assert.match(reaped.stdout, /^RESIDUE=no$/m, `${reaped.stdout}${reaped.stderr}`)
  assert.equal(readlinkSync(join(dirs.root, 'helpers')), standingLink,
    'and the publication that is standing must be exactly the one that was standing before the sweep')
})

// ---------------------------------------------------------------------------
// 3i. TWO PUBLISHERS OVER A LEGACY DIRECTORY, AND A COMMIT THAT CANNOT BE MADE DURABLE
//     (o3d-z5be r4, Codex MEDIUM 1 and MEDIUM 2)
// ---------------------------------------------------------------------------

test('[o3d-z5be] a publisher that finds the legacy name already replaced puts back what it moved and publishes NOTHING', (t) => {
  // THE FINDING (Codex MEDIUM 1). "Is the documented name a real directory?" and `mv -T` are two
  // operations. Two publishers can both see the legacy directory; if the first COMMITS ITS POINTER in
  // between, the second's `mv -T` carries that fresh symbolic link off to a retirement name — which
  // reopens the absent-name interval the pointer scheme exists to remove, and leaves the documented name
  // missing altogether if the second run is killed before its own flip.
  //
  // THE COMPETITOR IS DRIVEN AT THE SHIPPED SEAM: `mv` is the command the migration moves with, so a
  // shadow puts the other publisher exactly in the window and nothing here re-implements the migration.
  const dirs = scratch(t, ['chown-tree.mjs'])
  const legacy = join(dirs.root, 'helpers')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'chown-tree.mjs'), '// THE LEGACY TREE\n')
  // THE RIVAL'S VERSIONED DIRECTORY IS NAMED FOR A LIVE SHELL — this program's own. A directory named
  // for a dead publisher that no pointer names yet is exactly what the sweep at the top of every
  // publication reaps, so a rival built beforehand would be gone before the race could happen: the
  // first version of this test measured that instead of the migration.
  const out = run(dirs, [
    'rival=".version-helpers.$$.rrrrrr"',
    'command mkdir -p "${IMS_DRIVER_ROOT}/${rival}/helpers"',
    'printf "// THE RIVAL PUBLICATION\\n" > "${IMS_DRIVER_ROOT}/${rival}/helpers/chown-tree.mjs"',
    'raced=0',
    'mv() {',
    // The migration's move is `mv -T -- NAME …` since r13 (driver_rename_owned), `mv -T NAME …` before.
    '  local from="$2"; [[ "$2" == "--" ]] && from="$3"',
    '  if [[ "$1" == "-T" ]] && [[ "${from}" == "${IMS_DRIVER_HELPER_DIR}" ]] && (( raced == 0 )); then',
    '    raced=1',
    // The competitor commits: the legacy directory goes to its own retirement name and one rename puts
    // its pointer at the documented name — which is what driver_publish_tree() itself does.
    `    command mv -T ${JSON.stringify(legacy)} "\${IMS_DRIVER_ROOT}/.retired-helpers.$$.rrrrrr"`,
    '    command ln -s -- "${rival}/helpers" "${IMS_DRIVER_ROOT}/.pointer-helpers.$$.rrrrrr"',
    `    command mv -T "\${IMS_DRIVER_ROOT}/.pointer-helpers.$$.rrrrrr" ${JSON.stringify(legacy)}`,
    '  fi',
    '  command mv "$@"',
    '}',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "RACED=${raced}"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))

  // PRECONDITION: the competitor really did commit inside the window.
  assert.match(out.stdout, /^RACED=1$/m, `${out.stdout}${out.stderr}`)
  // AND THE RIVAL'S PUBLICATION IS THE ONE STANDING, whole and at the documented name.
  assert.equal(lstatSync(legacy).isSymbolicLink(), true,
    `the rival's pointer must still be at the documented name, not in a retirement directory:\n${out.stdout}${out.stderr}`)
  assert.match(readlinkSync(legacy), /^\.version-helpers\.[1-9][0-9]*\.rrrrrr\/helpers$/,
    `and it must name the rival's own versioned publication: ${readlinkSync(legacy)}`)
  assert.equal(readFileSync(join(legacy, 'chown-tree.mjs'), 'utf8'), '// THE RIVAL PUBLICATION\n')
  // AND THIS RUN REPORTS NOTHING, because it published nothing.
  assert.match(out.stdout, /^DIGEST=$/m, out.stdout)
  assert.match(out.stderr, /was replaced between the instant this run inspected it/, out.stderr)

  // NOT VACUOUS: the same legacy shape with no competitor migrates once and publishes.
  const alone = scratch(t, ['chown-tree.mjs'])
  mkdirSync(join(alone.root, 'helpers'), { recursive: true })
  writeFileSync(join(alone.root, 'helpers', 'chown-tree.mjs'), '// THE LEGACY TREE\n')
  const migrated = run(alone, 'publish_privileged_helper_set; echo "RC=$?"')
  assert.match(migrated.stdout, /^RC=0$/m, `${migrated.stdout}${migrated.stderr}`)
  assert.equal(lstatSync(join(alone.root, 'helpers')).isSymbolicLink(), true,
    'a legacy directory with nobody racing must be migrated to a pointer')
})

test('[o3d-z5be] a commit that could not be made durable is reported as a refusal, and the reason says the tree IS standing', (t) => {
  // THE FINDING (Codex MEDIUM 2). The directory sync after the pointer rename was `|| true`, so a failed
  // flush still returned a digest and the caller announced a publication that a crash could undo.
  //
  // THE INJECTION IS AT THE SHIPPED SEAM: _fence_fsync_path() runs `sync "$target"` and then a bare
  // `sync`, so a shadow that fails BOTH on the SECOND call naming the publication root fails exactly the
  // flush that follows the flip — the first such call is the one after the versioned directory's rename,
  // and it must still succeed or the publication would be refused before it commits anything.
  const dirs = scratch(t, ['chown-tree.mjs'])
  writeFileSync(join(dirs.src, 'chown-tree.mjs'), '// THE PUBLICATION THAT LANDS\n')
  const out = run(dirs, [
    'rootsyncs=0',
    'failing=0',
    'sync() {',
    '  if (( $# > 0 )) && [[ "$1" == "${IMS_DRIVER_ROOT}" ]]; then',
    '    rootsyncs=$(( rootsyncs + 1 ))',
    '    if (( rootsyncs == 2 )); then failing=1; return 1; fi',
    '  elif (( failing == 1 )); then',
    '    failing=0',
    '    return 1',
    '  fi',
    '  command sync "$@"',
    '}',
    'publish_privileged_helper_set; echo "PUBLISH_RC=$?"',
    'echo "ROOTSYNCS=${rootsyncs}"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))

  // PRECONDITION: the flush after the flip was reached and refused, and only that one.
  assert.match(out.stdout, /^ROOTSYNCS=2$/m,
    `the flush after the pointer flip must have been reached:\n${out.stdout}${out.stderr}`)
  // NOTHING IS REPORTED AS PUBLISHED: this is what "reported as success" meant, and it is what changed.
  assert.match(out.stdout, /^DIGEST=$/m, `no digest may be announced for a commit that is not durable:\n${out.stdout}`)
  // AND THE SENTENCE IS TRUE ABOUT THE HOST. The flip is NOT rolled back — undoing a committed pointer
  // over a disk fault would replace a good publication with an older one — so the message has to say so,
  // and the state has to match it.
  assert.match(out.stderr, /IS STANDING at .*helpers/, out.stderr)
  assert.match(out.stderr, /THE COMMIT IS NOT DURABLE/, out.stderr)
  assert.equal(lstatSync(join(dirs.root, 'helpers')).isSymbolicLink(), true)
  assert.equal(readFileSync(join(dirs.root, 'helpers', 'chown-tree.mjs'), 'utf8'), '// THE PUBLICATION THAT LANDS\n',
    'the tree the message says is standing must be the tree that is standing')

  // NOT VACUOUS: the same publication with the flush working reports the digest.
  const clean = scratch(t, ['chown-tree.mjs'])
  const ok = run(clean, [
    'publish_privileged_helper_set; echo "RC=$?"',
    'echo "DIGEST=${IMS_DRIVER_HELPER_SHA256}"',
  ].join('\n'))
  assert.match(ok.stdout, /^RC=0$/m, `${ok.stdout}${ok.stderr}`)
  assert.match(ok.stdout, /^DIGEST=[0-9a-f]{64}$/m, ok.stdout)
})

// ---------------------------------------------------------------------------
// 3j. NO PRIVILEGED RUN HANDS THE TREE IT IS EXECUTING FROM TO ANOTHER ACCOUNT (o3d-z5be r6, Codex HIGH 2)
//
// THE FINDING. install.sh copied LOCAL_SOURCE_DIR into ${APP_DIR} and `chown -R`ed ${APP_DIR} to the
// application account, and nothing stopped the root-only release being executed from BEING ${APP_DIR}.
// Bash reads the entrypoint off its descriptor as it goes, so that `chown` gave the application account
// write access to the commands root had not read yet.
// ---------------------------------------------------------------------------

/** Source the shipped fence and privileged-helpers libraries (with the real root literal — these tests
 *  publish nothing) and run `program` with IMS_SCRIPT_LIB_DIR pinned at `runningLib`. */
function withGuardLibrary(runningLib: string, program: string, env: Record<string, string> = {}) {
  const out = spawnSync('bash', ['-c', [
    // `-e` LIKE PRODUCTION (o3d-z5be r9, review LOW 13): all three entrypoints run `set -euo pipefail`,
    // and a rig without `-e` measures a shell that differs from them in exactly the option this project
    // has twice been bitten by — a refusal path that only ends the run because of `-e` would look fine.
    'set -euo pipefail',
    `source ${JSON.stringify(join(REPO, FENCE_LIB_REL))}`,
    `source ${JSON.stringify(join(REPO, LIB_REL))}`,
    `IMS_SCRIPT_LIB_DIR=${JSON.stringify(runningLib)}`,
    program,
  ].join('\n')], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

test('[o3d-z5be] two trees are disjoint only when a walk of neither reaches the other — equal, nested, symlinked and not-yet-created targets overlap', (t) => {
  const base = createTempDirSync('trees-disjoint-', t)
  const app = join(base, 'app')
  const other = join(base, 'other')
  mkdirSync(join(app, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(app, 'sub'), { recursive: true })
  mkdirSync(other)
  symlinkSync(app, join(base, 'link-to-app'))
  const cases: Array<[string, string, 'OVERLAP' | 'DISJOINT']> = [
    [app, app, 'OVERLAP'],
    [join(app, 'sub'), app, 'OVERLAP'],
    [app, join(app, 'sub'), 'OVERLAP'],
    [join(base, 'link-to-app'), app, 'OVERLAP'],
    [join(base, 'link-to-app', 'sub'), app, 'OVERLAP'],
    [join(app, 'not-yet'), app, 'OVERLAP'],
    [join(base, 'link-to-app', 'not-yet'), join(app, 'scripts'), 'DISJOINT'],
    [join(other, 'not-yet'), app, 'DISJOINT'],
    [other, app, 'DISJOINT'],
  ]
  const program = cases.map(([a, b], i) =>
    `if privileged_trees_disjoint ${JSON.stringify(a)} ${JSON.stringify(b)} A B 2>/dev/null; then echo "CASE${i}=DISJOINT"; else echo "CASE${i}=OVERLAP"; fi`).join('\n')
  const out = withGuardLibrary(join(other, 'lib'), program)
  for (const [i, [a, b, expected]] of cases.entries()) {
    assert.match(out.stdout, new RegExp(`^CASE${i}=${expected}$`, 'm'), `${a} vs ${b} must be ${expected}:\n${out.stdout}${out.stderr}`)
  }
  // AN UNWALKABLE TREE IS NOT A DISJOINT ONE: a directory this account cannot read is a refusal.
  const locked = join(base, 'locked')
  mkdirSync(join(locked, 'inner'), { recursive: true })
  chmodSync(locked, 0o000)
  let unreadable: { status: number; stdout: string; stderr: string }
  try {
    unreadable = withGuardLibrary(join(other, 'lib'),
      `if privileged_trees_disjoint ${JSON.stringify(locked)} ${JSON.stringify(other)} A B; then echo R=DISJOINT; else echo R=REFUSED; fi`)
  } finally {
    // Restored HERE rather than in t.after: the temp-dir cleanup is registered first and would fail on it.
    chmodSync(locked, 0o755)
  }
  if (process.getuid!() === 0) {
    // review LOW 1: as root there is no EACCES, so this half cannot be constructed — said as a skip
    // rather than passed over in silence.
    t.skip('root can read the mode-000 directory, so an unwalkable tree cannot be built here')
  } else {
    assert.match(unreadable.stdout, /^R=REFUSED$/m, `${unreadable.stdout}${unreadable.stderr}`)
    assert.match(unreadable.stderr, /could not be walked/, unreadable.stderr)
  }
})

/** install.sh's section 9 — from its header to the statement after the section — lifted verbatim and
 *  run with every command that could change something replaced by a recorder. */
function runInstallDeploySection(t: TestContext, opts: { appDir: string; localSource: string; runningLib: string }) {
  const install = ENTRYPOINT_SOURCE.get('scripts/install.sh')!
  const start = install.indexOf('header "Deploying application"\n')
  const end = install.indexOf('readonly DEPLOY_META_FILE="${APP_DIR}/.deploy-meta"', start)
  assert.ok(start > 0 && end > start, 'install.sh section 9 must be liftable between its header and DEPLOY_META_FILE')
  const section = install.slice(start, end)
  assert.ok(section.includes('chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"') && section.includes('"${LOCAL_SOURCE_DIR%/}/" "${APP_DIR}/"'),
    'precondition: the lifted section must contain the local copy and its recursive chown')
  const log = join(createTempDirSync('install-section9-', t), 'calls.log')
  const program = [
    `CALLS=${JSON.stringify(log)}`,
    'header() { :; }; info() { :; }; success() { :; }; warn() { :; }',
    'die() { echo "DIED: $*"; exit 3; }',
    'rsync() { echo "rsync $*" >> "${CALLS}"; }',
    'chown() { echo "chown $*" >> "${CALLS}"; }',
    'copy_tree_into_new_dir() { echo "copy_tree_into_new_dir $*" >> "${CALLS}"; }',
    'run_git_as_user() { echo "git $*" >> "${CALLS}"; }',
    'APP_USER=imsapp',
    `APP_DIR=${JSON.stringify(opts.appDir)}`,
    `LOCAL_SOURCE_DIR=${JSON.stringify(opts.localSource)}`,
    'INSTALL_FROM_GIT=n',
    'GIT_DEPLOY_KEY_ENABLED=n',
    section,
    'echo "SECTION_COMPLETED"',
  ].join('\n')
  const out = withGuardLibrary(opts.runningLib, program)
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
  return { ...out, calls }
}

test('[o3d-z5be] install.sh refuses a local source equal to, inside, containing or symlinked to APP_DIR, and a running tree inside APP_DIR, BEFORE any copy or chown', (t) => {
  const base = createTempDirSync('install-local-source-', t)
  const mk = (...parts: string[]) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
  const release = mk('release')                     // the root-only release being executed, disjoint from everything
  mk('release', 'scripts', 'lib')
  const runningLib = join(release, 'scripts', 'lib')

  const shapes: Array<{ what: string; appDir: string; localSource: string; runningLib: string }> = []
  { const app = mk('same', 'app'); shapes.push({ what: 'LOCAL_SOURCE_DIR equal to APP_DIR', appDir: app, localSource: app, runningLib }) }
  { const app = mk('nested', 'app'); const src = mk('nested', 'app', 'sub'); shapes.push({ what: 'LOCAL_SOURCE_DIR inside APP_DIR', appDir: app, localSource: src, runningLib }) }
  { const src = mk('contains', 'src'); shapes.push({ what: 'APP_DIR inside LOCAL_SOURCE_DIR (not created yet)', appDir: join(src, 'app'), localSource: src, runningLib }) }
  { const app = mk('symlink', 'app'); symlinkSync(app, join(base, 'symlink', 'link')); shapes.push({ what: 'LOCAL_SOURCE_DIR a symbolic link to APP_DIR', appDir: app, localSource: join(base, 'symlink', 'link'), runningLib }) }
  // THE REVIEWER'S EXACT SHAPE: the release being executed IS APP_DIR, and it is also the local source.
  { const app = mk('self', 'app'); mk('self', 'app', 'scripts', 'lib'); shapes.push({ what: 'the running release is APP_DIR and the local source', appDir: app, localSource: app, runningLib: join(app, 'scripts', 'lib') }) }
  // And the running tree inside APP_DIR with a separate, disjoint source — only the running-tree guard stops it.
  { const app = mk('inside', 'app'); mk('inside', 'app', 'scripts', 'lib'); const src = mk('inside', 'src'); shapes.push({ what: 'the running release inside APP_DIR, source elsewhere', appDir: app, localSource: src, runningLib: join(app, 'scripts', 'lib') }) }

  for (const shape of shapes) {
    const out = runInstallDeploySection(t, shape)
    assert.match(out.stdout, /^DIED: /m, `${shape.what}: install.sh must refuse:\n${out.stdout}${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^SECTION_COMPLETED$/m, shape.what)
    assert.equal(out.calls, '', `${shape.what}: nothing may be copied or chowned before the refusal:\n${out.calls}`)
  }

  // NOT VACUOUS: a disjoint source, target and running release copy and chown — the recorder can see both.
  const app = mk('clean', 'app')
  const src = mk('clean', 'src')
  const clean = runInstallDeploySection(t, { appDir: app, localSource: src, runningLib })
  assert.match(clean.stdout, /^SECTION_COMPLETED$/m, `${clean.stdout}${clean.stderr}`)
  assert.match(clean.calls, /^rsync -a --delete /m, clean.calls)
  assert.match(clean.calls, new RegExp(`^chown -R imsapp:imsapp ${app}$`, 'm'), clean.calls)
})

test('[o3d-z5be] update.sh refuses to copy into or chown an APP_DIR that holds the tree it is running from', (t) => {
  const update = ENTRYPOINT_SOURCE.get('scripts/update.sh')!
  const start = update.indexOf('    TMP_CLONE_DIR="$(mktemp -d -t ims-update.XXXXXX)"\n')
  const endMarker = '    success "Repository synced into existing app directory."\n'
  const end = update.indexOf(endMarker, start)
  assert.ok(start > 0 && end > start, 'update.sh\'s copy block must be liftable')
  const block = update.slice(start, end + endMarker.length)
  assert.ok(block.includes('chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"'), 'precondition: the block holds the recursive chown')
  const base = createTempDirSync('update-copy-', t)
  const run = (appDir: string, runningLib: string) => {
    const log = join(base, `calls-${Math.random().toString(36).slice(2)}.log`)
    const out = withGuardLibrary(runningLib, [
      `CALLS=${JSON.stringify(log)}`,
      // The block's own `mktemp -d -t` lands inside this test's directory, so a refused run leaves nothing behind.
      `export TMPDIR=${JSON.stringify(base)}`,
      'info() { :; }; success() { :; }; die() { echo "DIED: $*"; exit 3; }',
      'rsync() { echo "rsync $*" >> "${CALLS}"; }',
      'chown() { echo "chown $*" >> "${CALLS}"; }',
      'copy_tree_into_new_dir() { echo "copy_tree_into_new_dir $*" >> "${CALLS}"; }',
      'run_git_as_user() { echo "git $*" >> "${CALLS}"; [[ "$*" == *rev-parse* ]] && echo 0123456789abcdef; return 0; }',
      'APP_USER=imsapp', 'GIT_REPO_URL=https://example.invalid/r.git', 'GIT_BRANCH=main',
      `APP_DIR=${JSON.stringify(appDir)}`,
      block,
      'echo "BLOCK_COMPLETED"',
    ].join('\n'))
    return { ...out, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }
  const app = join(base, 'app')
  mkdirSync(join(app, 'scripts', 'lib'), { recursive: true })
  const refused = run(app, join(app, 'scripts', 'lib'))
  assert.match(refused.stdout, /^DIED: .*REFUSING to change the ownership of, copy into, or delete from the application directory/m, `${refused.stdout}${refused.stderr}`)
  assert.doesNotMatch(refused.calls, /^(rsync|chown -R|copy_tree_into_new_dir) /m, `nothing may be copied or chowned:\n${refused.calls}`)

  const release = join(base, 'release')
  mkdirSync(join(release, 'scripts', 'lib'), { recursive: true })
  const clean = run(app, join(release, 'scripts', 'lib'))
  assert.match(clean.stdout, /^BLOCK_COMPLETED$/m, `${clean.stdout}${clean.stderr}`)
  assert.match(clean.calls, /^rsync -a --delete /m, clean.calls)
  assert.match(clean.calls, new RegExp(`^chown -R imsapp:imsapp ${app}$`, 'm'), clean.calls)
})

/**
 * A SHELL TOKENISER, BECAUSE STRIPPING QUOTED SPANS DELETED THE COMMAND NAME (o3d-z5be r8, review HIGH 1).
 *
 * r7 removed double-quoted spans with a regex before matching, and that regex is not nesting-aware: on
 * this codebase's commonest idiom — `out="$(cmd "${VAR}" …)"` — the assignment's opening quote pairs with
 * the first quote INSIDE the substitution and takes the command name with it. `rsync`, `find -exec` and
 * `chown -R` written that way were invisible, and those are exactly the shapes this net claims to see.
 *
 * So the line is TOKENISED instead. The scanner tracks single quotes, double quotes and backslash
 * escapes, treats `$( … )` and backticks as NESTED COMMAND CONTEXTS rather than as text, and splits on
 * the operators that start a new simple command (`;` `|` `&` `&&` `||` `(` `{` and the keywords). Each
 * simple command comes back as a list of WORDS with their quoting removed, so `chown "-R" …` and
 * `/bin/chown -R …` are the same command as `chown -R …` to the classifier below.
 */
/** The end of an ANSI-C quoted string `$'…'` that starts at `at` (the `$`), honouring its backslash
 *  escapes — `$'\''` is ONE quote character, not a closed string followed by a stray quote (o3d-z5be r12,
 *  review M3: reading it as closed desynchronised every reader after it). Returns the index after the
 *  closing quote and the decoded text (escapes other than \' and \\ are kept as written). */
function ansiCSpan(line: string, at: number): { text: string; next: number } {
  let i = at + 2
  let text = ''
  while (i < line.length && line[i] !== "'") {
    if (line[i] === '\\') {
      const n = line[i + 1] ?? ''
      text += n === "'" || n === '\\' ? n : `\\${n}`
      i += 2
      continue
    }
    text += line[i]; i += 1
  }
  return { text, next: Math.min(line.length, i + 1) }
}

function shellCommands(line: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  const endWord = () => { if (hasWord) { words.push(word); word = ''; hasWord = false } }
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = [] }
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') { word += line[i + 1] ?? ''; hasWord = true; i += 2; continue }
    if (c === '$' && line[i + 1] === "'") {
      const { text, next } = ansiCSpan(line, i)
      word += text; hasWord = true; i = next
      continue
    }
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      word += line.slice(i + 1, close === -1 ? line.length : close); hasWord = true
      i = close === -1 ? line.length : close + 1
      continue
    }
    if (c === '"' || c === '`' || (c === '$' && line[i + 1] === '(')
      || ((c === '<' || c === '>') && line[i + 1] === '(')) {
      // A quoted span, a backtick, or a substitution: scan it, and recurse into the parts of it that are
      // COMMANDS. Quoting is dropped from the word; a nested command becomes its own entry.
      const { text, inner, next } = scanSpan(line, i)
      word += text; hasWord = true
      for (const nested of inner) commands.push(...shellCommands(nested))
      i = next
      continue
    }
    if (c === ' ' || c === '\t') { endWord(); i += 1; continue }
    if (c === ';' || c === '\n') { endCommand(); i += 1; continue }
    if (c === '|' || c === '&') { endCommand(); i += line[i + 1] === c ? 2 : 1; continue }
    // `)` ENDS A COMMAND EVEN AFTER A WORD (review MEDIUM 1): in `APP_DIR) chown -R …` the pattern and
    // its `)` are not part of the command that follows, and r8 read `APP_DIR)` as the command name. The
    // three entrypoints hold 52 same-line case arms, including the one in the gate this test asserts.
    if (c === ')') { endCommand(); i += 1; continue }
    if ((c === '(' || c === '{' || c === '}') && !hasWord) { endCommand(); i += 1; continue }
    word += c; hasWord = true; i += 1
  }
  endCommand()
  // AND WHAT A SHELL RUNNER IS GIVEN IS SHELL. `su -c "chown -R …"`, `bash -c '…'`, `eval "…"`: the
  // argument is parsed as commands in its own right, which is what makes the indirection visible
  // without flagging every privilege-dropping `runuser -u imsapp -- npm ci` as a tree operation.
  for (const words of [...commands]) {
    const { name, args } = commandName(words)
    if (name === 'trap') {
      // `trap 'chown -R …' EXIT`: the handler is shell, quoted. Read it (review MEDIUM 6's list).
      for (const nested of shellCommands(args[0] ?? '')) commands.push(nested)
      continue
    }
    if (!SHELL_RUNNERS.has(name)) continue
    if (args.includes('-c') || name === 'eval') {
      const script = name === 'eval' ? args.join(' ') : args[args.findIndex((a) => a === '-c') + 1]
      for (const nested of shellCommands(script ?? '')) commands.push(nested)
      continue
    }
    // AND A RUNNER WITH NO `-c` STILL RUNS SOMETHING (review MEDIUM 2). `sudo chown -R …` and
    // `runuser -u root -- chown -R …` were invisible, and the negative control for
    // `runuser -u imsapp -- npm ci` passed because NOTHING was read — an adjacent property in the very
    // test that claims payloads are read. The options are skipped and the rest is the payload.
    if (name === 'su' || name === 'sudo' || name === 'runuser') {
      const payload = runnerPayload(name, args)
      // `su imsapp -c …` is handled above; `su imsapp` alone runs a login shell, which is not a payload.
      if (payload.length > 1 || (payload.length === 1 && /[/]/.test(payload[0]))) commands.push(payload)
    }
  }
  return commands
}

/** What `su`/`sudo`/`runuser` run, with their own options (and the account operand) skipped. Empty
 *  means a shell reading standard input. Redirection words are not operands. */
function runnerPayload(name: string, rawArgs: string[]): string[] {
  const args = rawArgs.filter((a) => !/^[0-9]*[<>]/.test(a))
  let k = 0
  let separated = false
  let named = false
  while (k < args.length) {
    const a = args[k]
    if (a === '--') { k += 1; separated = true; break }
    if (a === '-') { k += 1; continue }
    if (/^--[A-Za-z-]+=/.test(a)) { k += 1; continue }
    if (/^-[A-Za-z-]/.test(a)) {
      const takesValue = ['-u', '-g', '-G', '-s', '--user', '--group', '--shell'].includes(a)
      if (takesValue && ['-u', '--user'].includes(a)) named = true
      k += takesValue ? 2 : 1
      continue
    }
    break
  }
  let payload = args.slice(k)
  // `su`/`runuser` take the account as an operand unless `-u` named it; `sudo` does not.
  if (!separated && !named && (name === 'su' || name === 'runuser')) payload = payload.slice(1)
  if (payload[0] === '--') payload = payload.slice(1)
  return payload
}

/**
 * The here-documents a logical line opens, IN ORDER, found by SCANNING rather than by a regex (o3d-z5be
 * r10, review M2). r9's regex found `<<WORD` anywhere, so `warn "… bash install.sh <<EOF"` (a message),
 * `$(( 1 << BITS ))` (arithmetic), `<<<'text'` (a here-string) and `<<END-OF` (a delimiter with a dash,
 * read as `END`) each swallowed every line up to the next matching one — a chown hidden for 58 lines was
 * demonstrated. Quotes, backslashes, comments, `(( … ))` and `<<<` are skipped; the delimiter word
 * follows bash: quoting and backslashes are removed from it (`<<'EOF'`, `<<"EOF"`, `<<\EOF`), and it
 * ends at a blank or an operator character.
 */
function heredocDelimiters(line: string): Array<{ word: string; strip: boolean }> {
  const out: Array<{ word: string; strip: boolean }> = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') { i += 2; continue }
    if (c === '$' && line[i + 1] === "'") { i = ansiCSpan(line, i).next; continue }
    if (c === "'") { const close = line.indexOf("'", i + 1); i = close === -1 ? line.length : close + 1; continue }
    if (c === '"') {
      i += 1
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '#' && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) break
    if (c === '(' && line[i + 1] === '(') {
      let depth = 0
      while (i < line.length) {
        if (line[i] === '(') depth += 1
        else if (line[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break } }
        i += 1
      }
      continue
    }
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') { i += 3; continue }
      i += 2
      let strip = false
      if (line[i] === '-') { strip = true; i += 1 }
      while (line[i] === ' ' || line[i] === '\t') i += 1
      let word = ''
      while (i < line.length && !/[\s;|&<>()]/.test(line[i])) {
        if (line[i] === '\\') { word += line[i + 1] ?? ''; i += 2; continue }
        if (line[i] === "'" || line[i] === '"') {
          const q = line[i]
          const close = line.indexOf(q, i + 1)
          word += line.slice(i + 1, close === -1 ? line.length : close)
          i = close === -1 ? line.length : close + 1
          continue
        }
        word += line[i]; i += 1
      }
      if (word) out.push({ word, strip })
      continue
    }
    i += 1
  }
  return out
}

/** Is a here-document on this line FED TO A SHELL, so that its body is code (review M1)? `bash <<'EOF'`,
 *  `bash -s -- a b <<EOF`, `runuser -u root -- bash <<EOF`, `su root <<EOF` (a login shell reading its
 *  standard input), `source /dev/stdin <<EOF`. It over-approximates toward CODE: a false yes costs a
 *  census row that must be explained, a false no hides a statement. */
const SHELLS = new Set(['sh', 'bash', 'dash', 'ksh', 'zsh', 'busybox'])
function feedsShell(text: string): boolean {
  const readsStdin = (words: string[]): boolean => {
    const { name, args } = commandName(words.filter((w) => !/^[0-9]*[<>]/.test(w)))
    if (SHELLS.has(name) && !args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))) return true
    if (name === 'su' || name === 'sudo' || name === 'runuser') {
      const payload = runnerPayload(name, args)
      return payload.length === 0 || readsStdin(payload)
    }
    return (name === 'source' || name === '.') && args.some((a) => /^\/dev\/(stdin|fd\/0)$/.test(a))
  }
  return shellCommands(text).some(readsStdin)
}

/** The span starting at `line[at]` — a double-quoted string, a backtick, or `$( … )` — with its nested
 *  command texts collected. Nesting is counted, which is the whole point of not using a regex. */
function scanSpan(line: string, at: string | number): { text: string; inner: string[]; next: number } {
  const start = Number(at)
  const inner: string[] = []
  let text = ''
  if (line[start] === '"') {
    let i = start + 1
    while (i < line.length && line[i] !== '"') {
      if (line[i] === '\\') { text += line[i + 1] ?? ''; i += 2; continue }
      if (line[i] === '`' || (line[i] === '$' && line[i + 1] === '(')) {
        const span = scanSpan(line, i)
        inner.push(...span.inner)
        if (span.text) inner.push(span.text)
        i = span.next
        continue
      }
      text += line[i]; i += 1
    }
    return { text, inner, next: i + 1 }
  }
  if (line[start] === '`') {
    const close = line.indexOf('`', start + 1)
    const body = line.slice(start + 1, close === -1 ? line.length : close)
    return { text: '', inner: [body], next: close === -1 ? line.length : close + 1 }
  }
  // `$( … )`, counting parentheses so a nested substitution does not close it early.
  let depth = 0
  let i = start + 1
  let body = ''
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') { body += c + (line[i + 1] ?? ''); i += 2; continue }
    if (c === '(') { depth += 1; body += c; i += 1; continue }
    if (c === ')') { depth -= 1; if (depth === 0) { i += 1; break } body += c; i += 1; continue }
    body += c; i += 1
  }
  return { text: '', inner: [body.replace(/^\(/, '')], next: i }
}

/** Command-position noise: assignments, keywords, and wrappers that run the REST of the words. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'case', 'esac', 'for', 'in', 'function', '!', '[[', '[', 'time', 'local', 'declare', 'export', 'readonly'])
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'env', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'setsid'])

/** The command name a simple command actually runs, with assignments, keywords and wrappers peeled off,
 *  or '' when there is none. `/bin/chown` comes back as `chown`. */
function commandName(words: string[]): { name: string; args: string[] } {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue }
    if (SHELL_KEYWORDS.has(w)) { i += 1; continue }
    if (WRAPPERS.has(w.replace(/^.*\//, ''))) {
      i += 1
      // `timeout 5s cmd`, `env A=b cmd`: skip the wrapper's own operands that are not the command.
      while (i < words.length && (/^-/.test(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || /^[0-9]+[smhd]?$/.test(words[i]))) i += 1
      continue
    }
    break
  }
  if (i >= words.length) return { name: '', args: [] }
  return { name: words[i].replace(/^.*\//, ''), args: words.slice(i + 1) }
}

const hasFlag = (args: string[], short: RegExp, long: RegExp) =>
  args.some((a) => (/^-[^-]/.test(a) && short.test(a)) || long.test(a))

/** Commands whose `-c` argument (or, for `eval`, every argument) is itself shell to be read. Following
 *  them is how `su -s /bin/bash -c "chown -R …"` is seen, and it is also why a privilege-DROPPING
 *  `runuser -u imsapp -- npm ci` is NOT flagged: what it runs is read, and `npm ci` is not tree-wide. */
const SHELL_RUNNERS = new Set(['sh', 'bash', 'ksh', 'zsh', 'dash', 'su', 'sudo', 'runuser', 'eval'])

/**
 * Is this simple command one that can change ownership of, write over, move or delete a whole TREE?
 *
 * 'certain' — it takes a tree by construction, and a function whose body contains one is itself
 *             treated as tree-wide (so a call to a local `fix_ownership` helper is seen).
 * 'possible' — `mv`, which moves whatever it is given and is a single-file publisher everywhere in
 *             these files today. It is counted, so a new one has to be accounted for, but it does not
 *             make its enclosing function tree-wide: moving one file is not a tree operation.
 */
function treeWide(words: string[], extra: ReadonlySet<string>, aliases: ReadonlyMap<string, string> = new Map(),
  wrappers: ReadonlyMap<string, Wrapper> = new Map(), depth = 0):
  { name: string; kind: 'certain' | 'possible' } | null {
  const { name: raw, args } = commandName(words)
  if (!raw) return null
  const alias = aliases.get(raw.replace(/^[$]\{?/, '').replace(/\}$/, ''))
  const name = /^[$]/.test(raw) && alias ? alias : raw
  if (extra.has(name)) return { name: `${name} (a function in this file that does one)`, kind: 'certain' }
  const wrapper = wrappers.get(name)
  if (wrapper && depth < 4) {
    const passed = args.slice(wrapper.skip).map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(' ')
    const expanded = wrapper.body.replace(/"\$\{?@\}?"/g, () => passed)
    for (const line of logicalLines(expanded)) {
      for (const inner of shellCommands(line.text)) {
        const hit = treeWide(inner, extra, aliases, wrappers, depth + 1)
        if (hit) return { name: `${name} → ${hit.name}`, kind: hit.kind }
      }
    }
    return null
  }
  const certain = (n: string) => ({ name: n, kind: 'certain' as const })
  switch (name) {
    case 'chown': case 'chmod': case 'chgrp':
      return hasFlag(args, /R/, /^--recursive$/) ? certain(name) : null
    case 'rsync': case 'setfacl': case 'cpio': case 'unzip': case 'tar':
      return certain(name)
    case 'cp':
      return hasFlag(args, /[aRr]/, /^--(archive|recursive)$/) ? certain(name) : null
    case 'rm':
      return hasFlag(args, /[Rr]/, /^--recursive$/) ? certain(name) : null
    case 'install':
      return hasFlag(args, /[dDo]/, /^--(directory|owner|group)/) ? certain(name) : null
    case 'find':
      return args.some((a) => ['-exec', '-execdir', '-ok', '-okdir', '-delete'].includes(a)) ? certain(name) : null
    case 'xargs':
      return certain(name)
    case 'useradd': case 'usermod':
      return hasFlag(args, /[md]/, /^--(create-home|home-dir)$/) ? certain(name) : null
    case 'chown_state_tree': case 'copy_tree_into_new_dir':
      return certain(name)
    case 'mv':
      return { name, kind: 'possible' }
    default:
      return null
  }
}

/** `CH=chown` … `$CH -R …`: a variable assigned a tree-wide command NAME is resolved at its use. */
function commandAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>()
  // `declare -x CH=chown` and `readonly CH=chown` are assignments too (review LOW 12).
  for (const m of source.matchAll(/^\s*(?:(?:declare|readonly|export|local)\s+(?:-[A-Za-z]+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=["']?([A-Za-z0-9_./-]+)["']?\s*$/gm)) {
    const base = m[2].replace(/^.*\//, '')
    if (['chown', 'chmod', 'chgrp', 'rsync', 'cp', 'rm', 'mv', 'find', 'xargs', 'setfacl', 'tar', 'install', 'useradd'].includes(base)) {
      aliases.set(m[1], base)
    }
  }
  return aliases
}

/** Does this guard line's refusal END THE RUN? Only the two shipped shapes count. A predicate that
 *  merely FINDS `die` on the line is satisfied by `guard || warn "…" || die "…"` (which continues,
 *  because `warn` succeeds) and by `guard || { echo "die trying"; }` (the word, in a message), and it
 *  is defeated by a pipeline `guard | cat || die` unless `pipefail` is set (review MEDIUM 3). */
function refusalEndsRun(text: string): boolean {
  const call = /^privileged_spare_running_tree "[^"]*" "[^"]*" \|\| (.*)$/.exec(text.trim())
  if (!call) return false
  return /^die "[^"]*"$/.test(call[1])
    || /^\{ rm -rf "\$\{TMP_CLONE_DIR\}"; die "[^"]*"; \}$/.test(call[1])
}

/** The SHELL of a line, for the census: a bare definition HEAD contributes nothing, every other line —
 *  a one-line definition included — itself. r8 skipped any line that STARTED a definition, which threw
 *  the body of `fix() { chown -R … ; }` away (review HIGH 1); the tokeniser reads that body without help
 *  (measured by mutation: extracting it separately changed nothing). What is load-bearing is the HEAD:
 *  `fix_own () {`, `function fix_own {` or `fix_own ()` read as shell is a CALL to fix_own, a census row
 *  for a statement that does not exist (measured: 3 rows instead of 2). */
function functionBody(text: string): string {
  if (new RegExp(`^${DEFINITION_HEAD}\\s*\\{?\\s*$`).test(text)) return ''
  return text
}

/** The head of a bash function definition: `function NAME`, `function NAME ()` or `NAME ()`. A bare
 *  `NAME {` is NOT one (it runs a command called NAME with an argument `{`), so it is not accepted. */
const DEFINITION_HEAD = String.raw`\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))`

/**
 * WHICH LINES ARE COMMENTS — decided by LEXER STATE, not by the line's shape (o3d-z5be r11, review H1).
 * r10 exempted every line whose first non-blank character is `#`. Inside a multi-line double-quoted
 * string or an unquoted here-document body such a line is DATA, and a `$( … )` or a backtick on it
 * EXECUTES: `msg="synced` / `#$(chown -R … "${DATA_DIR}")"` ran a chown on a line both layers skipped.
 * So a line is a comment only if it starts in plain code (not inside a quote, a substitution, a
 * backtick or a here-document body) with `#` as its first word. With `strict` — the BACKSTOP's mode —
 * a line containing `$(` or a backtick is never exempt either, whatever the scanner concluded, so a
 * mistake in this scanner cannot hide an executing line from the word check. (That costs one allowlist
 * entry, class `comment`, per documentation comment that quotes a privileged command in backticks.)
 * The census, which classifies code, uses the scanner's answer alone: a real comment is not code.
 */
function commentLines(source: string, strict = false): Set<number> {
  const lines = source.split('\n')
  const out = new Set<number>()
  type Frame = { kind: 'code' | 'sub' | 'dq' | 'sq' | 'bt' | 'ansi'; depth: number }
  const stack: Frame[] = [{ kind: 'code', depth: 0 }]
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const startsInCode = stack.length === 1
    if (startsInCode && /^\s*#/.test(line)) {
      if (!strict || !/\$\(|`/.test(line)) out.add(i + 1)
      i += 1
      continue
    }
    let j = 0
    while (j < line.length) {
      const top = stack[stack.length - 1]
      const c = line[j]
      if (top.kind === 'sq') { if (c === "'") stack.pop(); j += 1; continue }
      // ANSI-C `$'…'`: a backslash escapes the next character, INCLUDING a quote (r12, review M3).
      if (top.kind === 'ansi') { if (c === '\\') { j += 2; continue } if (c === "'") stack.pop(); j += 1; continue }
      if (top.kind === 'dq') {
        if (c === '\\') { j += 2; continue }
        if (c === '"') { stack.pop(); j += 1; continue }
        if (c === '$' && line[j + 1] === '(') { stack.push({ kind: 'sub', depth: 0 }); j += 2; continue }
        if (c === '`') { stack.push({ kind: 'bt', depth: 0 }); j += 1; continue }
        j += 1; continue
      }
      if (top.kind === 'bt') {
        if (c === '\\') { j += 2; continue }
        if (c === '`') { stack.pop(); j += 1; continue }
        if (c === "'") { stack.push({ kind: 'sq', depth: 0 }); j += 1; continue }
        if (c === '"') { stack.push({ kind: 'dq', depth: 0 }); j += 1; continue }
        j += 1; continue
      }
      if (c === '\\') { j += 2; continue }
      if (c === '#' && (j === 0 || /[\s;&|(]/.test(line[j - 1]))) break
      if (c === '$' && line[j + 1] === "'") { stack.push({ kind: 'ansi', depth: 0 }); j += 2; continue }
      if (c === "'") { stack.push({ kind: 'sq', depth: 0 }); j += 1; continue }
      if (c === '"') { stack.push({ kind: 'dq', depth: 0 }); j += 1; continue }
      if (c === '`') { stack.push({ kind: 'bt', depth: 0 }); j += 1; continue }
      if (c === '$' && line[j + 1] === '(') { stack.push({ kind: 'sub', depth: 0 }); j += 2; continue }
      if (top.kind === 'sub') {
        if (c === '(') { top.depth += 1; j += 1; continue }
        if (c === ')') { if (top.depth === 0) stack.pop(); else top.depth -= 1; j += 1; continue }
      }
      j += 1
    }
    const documents = startsInCode && stack.length === 1 && !/\\$/.test(line) ? heredocDelimiters(line) : []
    i += 1
    // A HERE-DOCUMENT BODY IS NEVER A COMMENT, quoted delimiter or not: its lines are skipped here, so
    // none of them can be added to the exempt set.
    for (const doc of documents) {
      const ends = (text: string) => (doc.strip ? text.replace(/^\t+/, '') : text) === doc.word
      while (i < lines.length && !ends(lines[i])) i += 1
      i += 1
    }
  }
  return out
}

/**
 * THE STATEMENTS OF ONE LOGICAL LINE, split at the operators that separate them — `;`, `;;`, `&&`,
 * `||`, `|`, `&` — outside quotes, substitutions, backticks and `(( ))` (o3d-z5be r11, review H2). The
 * census classifies, and the backstop credits, a STATEMENT and not a line: r10 credited
 * `chown_state_tree "${DATA_DIR}" …; chown -R … /etc/…` wholly to the census row for its first half,
 * whose guard checks ${DATA_DIR} and not the appended target. Each statement comes back trimmed, with
 * leading grouping and keywords (`{` `(` `!` `if` `then` `do` `else` `elif` `while` `until` `time`) and
 * trailing closers (`}` `)` `fi` `done` `esac`) removed, so a table row can be anchored at both ends.
 */
function statementsOf(line: string, raw = false): string[] {
  const out: string[] = []
  let current = ''
  const push = () => {
    let text = current.trim()
    let previous
    if (raw) { if (text) out.push(text); current = ''; return }
    do {
      previous = text
      text = text.replace(/^(?:\{|\(|!|then|do|else|elif|if|while|until|time)(?=\s|$)\s*/, '')
        .replace(/\s*(?:\}|\)|fi|done|esac)$/, '').trim()
    } while (text !== previous)
    if (text) out.push(text)
    current = ''
  }
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '\\') { current += c + (line[i + 1] ?? ''); i += 2; continue }
    if (c === '$' && line[i + 1] === "'") {
      const { next } = ansiCSpan(line, i)
      current += line.slice(i, next); i = next; continue
    }
    if (c === "'") {
      const close = line.indexOf("'", i + 1)
      const end = close === -1 ? line.length : close + 1
      current += line.slice(i, end); i = end; continue
    }
    if (c === '"' || c === '`' || (c === '$' && line[i + 1] === '(') || ((c === '<' || c === '>') && line[i + 1] === '(')) {
      const { next } = scanSpan(line, i)
      current += line.slice(i, next); i = next; continue
    }
    if (c === '(' && line[i + 1] === '(') {
      let depth = 0
      const start = i
      while (i < line.length) {
        if (line[i] === '(') depth += 1
        else if (line[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break } }
        i += 1
      }
      current += line.slice(start, i); continue
    }
    if (c === ';') { push(); i += line[i + 1] === ';' ? 2 : 1; continue }
    if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) { current += c; i += 1; continue }
    if (c === '|' && line[i - 1] === '>') { current += c; i += 1; continue }
    if (c === '|' || c === '&') { push(); i += line[i + 1] === c ? 2 : 1; continue }
    current += c; i += 1
  }
  push()
  return out
}

/**
 * THE BLOCK EACH STATEMENT OF A FUNCTION BODY IS IN, by the shell's own structure rather than by
 * indentation (o3d-z5be r13, review MED-2: tabs, and unindented `if` bodies, fooled r12's indentation
 * rule). Walks RAW statements in order: `if`/`while`/`until`/`for`/`select`/`case`/`{`/`(` open a block,
 * `else`/`elif` start a new branch (a new block), `fi`/`done`/`esac`/`}`/`)` close one. Each block has a
 * unique id, so two sibling `if` bodies are different blocks. Returns, per statement, the path of block
 * ids enclosing it; the function body itself is the empty path.
 */
function blockPaths(texts: string[]): number[][] {
  const out: number[][] = []
  const stack: number[] = []
  let next = 1
  for (const raw of texts) {
    let t = raw.trim()
    for (;;) {
      const open = /^(if|while|until|for|select|case|\{|\()(?=\s|$)\s*/.exec(t)
      if (open) { stack.push(next++); t = t.slice(open[0].length); continue }
      const branch = /^(else|elif)(?=\s|$)\s*/.exec(t)
      if (branch) { stack.pop(); stack.push(next++); t = t.slice(branch[0].length); continue }
      const kw = /^(then|do|!|time)(?=\s|$)\s*/.exec(t)
      if (kw) { t = t.slice(kw[0].length); continue }
      break
    }
    out.push([...stack])
    for (;;) {
      const close = /(?:^|\s)(\}|\)|fi|done|esac)$/.exec(t)
      if (!close) break
      stack.pop(); t = t.slice(0, close.index).trimEnd()
    }
  }
  return out
}

/** Physical lines joined on backslash-continuations, keeping the number of the FIRST line (`n`) and the
 *  LAST (`last`): a matcher that reads one physical line at a time cannot see `chown \` + `  -R …`
 *  (review MEDIUM 1). A HERE-DOCUMENT BODY is skipped when it is data (r9, LOW 7) and READ AS CODE when
 *  it is fed to a shell (r10, review M1 — r9 skipped both, so `bash <<'EOF'` hid its whole body). */
function logicalLines(source: string): Array<{ n: number; last: number; text: string }> {
  const out: Array<{ n: number; last: number; text: string }> = []
  const lines = source.split('\n')
  const comments = commentLines(source)
  for (let i = 0; i < lines.length; i += 1) {
    if (comments.has(i + 1) || lines[i].trim() === '') continue
    let text = lines[i]
    const n = i + 1
    while (/\\$/.test(text) && i + 1 < lines.length) {
      i += 1
      text = `${text.replace(/\\$/, ' ')}${lines[i]}`
    }
    out.push({ n, last: i + 1, text })
    const documents = heredocDelimiters(text)
    if (documents.length === 0 || feedsShell(text)) continue
    for (const doc of documents) {
      const ends = (line: string) => (doc.strip ? line.replace(/^\t+/, '') : line) === doc.word
      while (i + 1 < lines.length && !ends(lines[i + 1])) i += 1
      i += 1
    }
  }
  return out
}

/** Functions defined in this file whose body runs a tree-wide command, to a fixpoint, so that a call to
 *  a local helper that chowns is itself tree-wide (review MEDIUM 4's `fix_ownership`). */
function functionBodies(source: string): Map<string, string[]> {
  const lines = source.split('\n')
  const bodies = new Map<string, string[]>()
  let current: string | null = null
  let depth = 0
  let pending: string | null = null
  for (const raw of lines) {
    // `NAME ()` ALONE, WITH THE BRACE ON THE NEXT LINE, is a definition too (found by r9's own call-site
    // assertion: the census counted that body's statements directly, so its COUNT was right, but the
    // function was never registered and a call to it was not followed).
    if (!current && pending && /^\s*\{\s*$/.test(raw)) { current = pending; pending = null; bodies.set(current, []); depth = 1; continue }
    pending = null
    const head = new RegExp(`^${DEFINITION_HEAD}\\s*$`).exec(raw)
    if (!current && head) { pending = head[1] ?? head[2]; continue }
    // A ONE-LINE DEFINITION IS A DEFINITION (o3d-z5be r9, review HIGH 1). `fix() { chown -R … ; }` is the
    // house idiom in these very files (17 of them across the three), and r8 registered a function only
    // when the brace was LAST on the line — so the body was never read and every call to it was
    // invisible, while the documentation said such calls were followed.
    const oneLine = new RegExp(`^${DEFINITION_HEAD}\\s*\\{(.*)\\}\\s*;?\\s*$`).exec(raw)
    if (!current && oneLine && oneLine[3].trim() !== '') {
      const name = oneLine[1] ?? oneLine[2]
      bodies.set(name, [...(bodies.get(name) ?? []), oneLine[3]])
      continue
    }
    const opening = new RegExp(`^${DEFINITION_HEAD}\\s*\\{\\s*$`).exec(raw)
    if (!current && opening) { current = opening[1] ?? opening[2]; bodies.set(current, []); depth = 1; continue }
    if (current) {
      bodies.get(current)!.push(raw)
      if (/^\}/.test(raw)) { depth -= 1; if (depth === 0) current = null }
    }
  }
  return bodies
}

/**
 * PASS-THROUGH WRAPPERS (o3d-z5be r10, review H1): same-file functions that EXECUTE their arguments —
 * `run() { … "$@"; }` (update.sh 12 call sites, deploy.sh 5), `capture VAR cmd …`, `run_as_user USER
 * cmd …`, `as_app_user cmd …`. `run chown -R …` was invisible because the command name is `run`. A
 * wrapper is a function whose body mentions `"$@"`/`"${@}"`; the operands it `shift`s away first are
 * its fixed leading operands; a call is read by substituting the rest of its words for `"$@"` in the
 * body and reading THAT as shell — so `run_as_user root chown …` reaches `runuser -u root -- chown …`.
 */
type Wrapper = { skip: number; body: string }
function passThroughWrappers(source: string): Map<string, Wrapper> {
  const wrappers = new Map<string, Wrapper>()
  for (const [name, body] of functionBodies(source)) {
    const at = body.findIndex((line) => !/^\s*#/.test(line) && /"\$\{?@\}?"/.test(line))
    if (at === -1) continue
    let skip = 0
    for (const line of body.slice(0, at)) {
      if (/^\s*#/.test(line)) continue
      for (const m of line.matchAll(/(?:^|[\s;])shift(?:\s+([0-9]+))?(?=\s|;|$)/g)) skip += Number(m[1] ?? 1)
    }
    wrappers.set(name, { skip, body: body.join('\n') })
  }
  return wrappers
}

/** Everything the classifier needs to know about one file. */
function censusContext(source: string) {
  const wrappers = passThroughWrappers(source)
  return { wrappers, functions: treeWideFunctions(source, wrappers), aliases: commandAliases(source) }
}

function treeWideFunctions(source: string, wrappers: ReadonlyMap<string, Wrapper> = new Map()): Set<string> {
  const bodies = functionBodies(source)
  const found = new Set<string>()
  for (let pass = 0; pass < 5; pass += 1) {
    const before = found.size
    for (const [name, body] of bodies) {
      if (found.has(name)) continue
      const text = body.filter((l) => !/^\s*#/.test(l)).join('\n')
      for (const line of logicalLines(text)) {
        if (shellCommands(line.text).some((words) => treeWide(words, found, new Map(), wrappers)?.kind === 'certain')) { found.add(name); break }
      }
    }
    if (found.size === before) break
  }
  return found
}

/**
 * THE LEXICAL BACKSTOP (o3d-z5be r10). Nine rounds each found a shape the tokeniser could not read, so the
 * census is no longer asked to be complete. This asks a question syntax cannot evade: does a line SPELL a
 * privileged command word at all? Every physical line of the entrypoints and the libraries they source —
 * heredoc bodies, strings and continuation lines included; only lines whose first non-blank character is
 * `#` are exempt — that does must be part of a census row or an EXACT entry in the reviewed allowlist.
 *
 * The words are whole words: `.` and `_` join a word on either side and `-` joins one on the RIGHT (so
 * `install.sh`, `rm_tree` and `install-root` are not hits) but not on the left, so `${CH:-chown}` and
 * `--chown` are. They are matched after deleting every backslash and quote character — bash removes
 * those, so `ch\own`, `c"h"own` and `'chown'` are the word `chown`. A backslash-continuation is also read
 * joined WITHOUT a space, so `ch\` + `own` is seen. What is NOT seen is a name that is never spelled out
 * in these files: assembled at run time from expansions or substitutions (`${c}own`, `ch$()own`,
 * `$'\x63hown'`, `printf -v c '%s' ch; ${c}own`), or written in another file (`. /etc/os-release`).
 */
const BACKSTOP_WORDS = ['chown', 'chgrp', 'chmod', 'setfacl', 'rsync', 'rm', 'cp', 'mv', 'install', 'tar', 'ln', 'find',
  'xargs', 'cpio', 'unzip', 'useradd', 'usermod', 'chown_state_tree', 'copy_tree_into_new_dir',
  // r11 (review M1): the gaps the reviewer measured green. `[A-Za-z]*tar` and `[A-Za-z]*cp` catch the
  // prefixed forms (`bsdtar`, `gtar`, `scp`, `rcp`); measured, the cp prefix adds only `tcp` (3 lines).
  'scp', 'read-tree', 'stash', 'chattr', 'chcon', '[A-Za-z]+tar', '[A-Za-z]+cp']
const BACKSTOP_WORD = new RegExp(`(?<![A-Za-z0-9_.])(${BACKSTOP_WORDS.join('|')})(?![A-Za-z0-9_.-])`, 'g')
/** THE HOUSE'S OWN TREE-CHANGING PROGRAMS (r11, review H4), matched with a right boundary that lets
 *  `.` and `-` through, because they are named as files: `chown-tree.mjs`. The test below enumerates
 *  every program in scripts/lib that calls a filesystem-changing API and requires it to be listed. */
const BACKSTOP_HELPERS = ['chown-tree']
/** Library calls, which follow a `.`: `shutil.rmtree`, `os.chown`, `fs.rmSync`. */
const BACKSTOP_CALL = /(?<![A-Za-z0-9_])(rmtree|rmSync|cpSync|chownSync|lchownSync|renameSync)(?![A-Za-z0-9_])/g
const BACKSTOP_HELPER = new RegExp(`(?<![A-Za-z0-9_.])(${BACKSTOP_HELPERS.join('|')})(?![A-Za-z0-9_])`, 'g')
const BACKSTOP_GIT = /(?<![A-Za-z0-9_.-])git(?![A-Za-z0-9_.-])/
const BACKSTOP_GIT_WRITE = /(?<![A-Za-z0-9_.-])(clean|checkout|reset|restore|switch)(?![A-Za-z0-9_.-])|(?<![A-Za-z0-9_-])(-f|--force)(?![A-Za-z0-9_-])/
function privilegedWords(line: string): string[] {
  const bare = line.replace(/[\\'"]/g, '')
  const found = new Set([...bare.matchAll(BACKSTOP_WORD), ...bare.matchAll(BACKSTOP_HELPER), ...bare.matchAll(BACKSTOP_CALL)].map((m) => m[1]))
  if (BACKSTOP_GIT.test(bare) && BACKSTOP_GIT_WRITE.test(bare)) found.add('git')
  return [...found].sort()
}
/** Every STATEMENT in `source` that spells a privileged word. A statement is one physical line, or a
 *  whole backslash-continuation group — so the key of `find … \` + `  -delete` is both lines, and an
 *  action added on a continuation line changes the key and fails the allowlist. The group is also read
 *  joined WITHOUT a space, so `ch\` + `own` is seen. Keyed by the exact text: each physical line trimmed,
 *  joined with a newline. `#`-first lines are exempt; nothing else is (heredoc bodies and strings are in). */
function backstopHits(source: string): Array<{ n: number; last: number; line: string; text: string; words: string[] }> {
  const lines = source.split('\n')
  const comments = commentLines(source, true)
  const hits: Array<{ n: number; last: number; line: string; text: string; words: string[] }> = []
  for (let i = 0; i < lines.length; i += 1) {
    if (comments.has(i + 1)) continue
    let j = i
    while (/\\$/.test(lines[j]) && j + 1 < lines.length) j += 1
    const group = lines.slice(i, j + 1)
    const words = new Set(group.flatMap((l) => privilegedWords(l)))
    if (j > i) for (const w of privilegedWords(group.map((l) => l.replace(/\\$/, '')).join(''))) words.add(w)
    if (words.size) {
      // `text` is the group joined exactly as logicalLines() joins it, so its statements are the
      // census's statements, character for character.
      const text = group.map((l, k) => (k < group.length - 1 ? l.replace(/\\$/, ' ') : l)).join('')
      hits.push({ n: i + 1, last: j + 1, line: group.map((l) => l.trim()).join('\n'), text, words: [...words].sort() })
    }
    i = j
  }
  return hits
}

/** The statements the census classifies as tree-wide in one file, as logical lines with their index. A
 *  DEFINITION LINE IS NOT SKIPPED, only a bare definition head is (review r9 HIGH 1). */
function censusOps(source: string) {
  const { functions, aliases, wrappers } = censusContext(source)
  return logicalLines(source).flatMap((line, index) => statementsOf(line.text)
    .filter((statement) => shellCommands(functionBody(statement)).some((words) => treeWide(words, functions, aliases, wrappers)))
    .map((statement) => ({ n: line.n, last: line.last, line: line.text, text: statement, index })))
}

test('[o3d-z5be] CENSUS: the tree-wide statements its tokeniser can classify are each accounted for, guarded, and end the run on refusal', () => {
  // WHAT THIS IS AND IS NOT (o3d-z5be r8–r10). It is a CLASSIFIER OVER THE SHAPES ITS TOKENISER CAN
  // PARSE, backed by the LEXICAL BACKSTOP test below. WHAT CARRIES THE PROPERTY is the guard made
  // immediately before a tree-wide statement; this test keeps those guards in place and fails on a new
  // statement it classifies until somebody decides which row it is. It is not complete — nine review
  // rounds each found a shape it could not parse, the ninth being this codebase's own `run chown -R …` —
  // which is why the backstop, and not this, answers "is anything spelled out that nobody accounted for".
  // THREAT MODEL (r11): this and the backstop guard against an EDITOR'S MISTAKE. They are a fixed word
  // list and a classifier over parseable shapes; they bind text, not variable values or context. What
  // they do not see — a name computed at run time or brace-built, a command not on the list, code outside
  // these files, a changed value reaching an allowlisted line — is what the RUN-TIME GUARDS tests below
  // exist for: the helpers refuse, when they run, a path that is not theirs.
  //
  // KNOWN GAPS OF THIS CLASSIFIER, LEFT TO THE BACKSTOP (review of c60997d8, L5/L6): a function whose name
  // has `-`, `:` or non-ASCII characters, or whose body is `( … )`, is read at its definition but calls to
  // it are not followed — the definition line spells the command, so it is still a census row or an
  // allowlist entry; and `git … clean -ffdx` / `checkout -f` are not classified as tree-wide here, while
  // the backstop's `git` rule makes any such statement an explicit decision.
  //
  // r7's version STRIPPED double-quoted spans before matching, with a regex that is not nesting-aware:
  // on `out="$(chown -R … )"` the opening quote paired with the first quote inside the substitution and
  // the command name went with it. That idiom appears throughout these files. It tokenises now.
  type Entry = { file: string; op: RegExp; line?: RegExp; guard: string | null; up?: number; why?: string }
  const PUB = /^mv -f (?:-T )?"\$\{?tmp\}?" "(?:\/proc\/self\/fd\/\$\{dest\}\/\$\{base\}|\$target|\$\{?CRON_BACKUP\}?)" 2>\/dev\/null$/
  const CLONE_RM = /^rm -rf "\$\{TMP_CLONE_DIR\}"$/
  const GUARD_CLEANUP_LINE = /^\s*privileged_spare_running_tree "[^"]+" "[^"]+" \|\| \{ rm -rf "\$\{TMP_CLONE_DIR\}"; die "\$\{IMS_DRIVER_OVERLAP_REASON\}"; \}$/
  const MKTEMP_LINE = /^\s*rm -rf "\$\{TMP_CLONE_DIR\}"$/
  const RSYNC_CLONE = /^rsync -a --delete(?:\s+--exclude='[^']+')+\s+"\$\{TMP_CLONE_WORKTREE%\/\}\/" "\$\{APP_DIR\}\/"$/
  const COPY_GIT = /^copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"$/
  const CHOWN_APP = /^chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}"$/
  const G = (target: string) => `privileged_spare_running_tree "${target}" `
  // `mktemp -d -t` honours TMPDIR, which the operator controls, so this says what is true: the run made
  // the directory itself, after its own entrypoint was already open (review LOW 11).
  const MKTEMP = 'the clone directory this run itself made with `mktemp -d -t`, after its entrypoint was open'
  const CLEANUP = 'the guard\'s own failure branch removes that same mktemp clone directory'
  const PUBLISH = 'publish_durable_file/crontab backup: a rename of ONE staged file onto ONE target, not a tree'
  const HELPER = 'migrate_uploads guards its own `find … -exec mv` immediately before it (install.sh)'
  const table: Entry[] = [
    // EVERY ROW IS ANCHORED AT BOTH ENDS OF ONE STATEMENT (r11, review H2): `chown_state_tree … ; chown -R
    // … /etc/x` is two statements now, and the second has no row. `line` pins the logical line where the
    // same statement means two different things (a guard's own cleanup vs the delete after a copy).
    ...Array.from({ length: 3 }, () => ({ file: 'scripts/install.sh', op: PUB, guard: null, why: PUBLISH })),
    { file: 'scripts/install.sh', op: /^useradd --system --shell \/bin\/bash --home-dir "\$\{APP_DIR\}" --create-home "\$\{APP_USER\}"$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: /^find "\$\{src\}" -mindepth 1 -maxdepth 1 -exec mv -n -t \. \{\} \+$/, guard: G('${src}'), up: 2 },
    ...Array.from({ length: 4 }, () => ({ file: 'scripts/install.sh', op: /^migrate_uploads "\$\{APP_DIR\}\/[a-z/]+" "\$\{(?:PUBLIC_)?UPLOAD_STORAGE_DIR\}\/[a-z/]+"$/, guard: null, why: HELPER })),
    { file: 'scripts/install.sh', op: /^chown_state_tree "\$\{DATA_DIR\}" "\$\{APP_USER\}" "\$\{CRONTAB_LOCK_DIRNAME\}" "the state directory"$/, guard: G('${DATA_DIR}') },
    { file: 'scripts/install.sh', op: /^chown -Rh "\$\{APP_USER\}:\$\{APP_USER\}" \.$/, guard: G('${LOG_DIR}'), up: 3 },
    ...Array.from({ length: 5 }, () => ({ file: 'scripts/install.sh', op: CLONE_RM, line: GUARD_CLEANUP_LINE, guard: null, why: CLEANUP })),
    { file: 'scripts/install.sh', op: RSYNC_CLONE, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: COPY_GIT, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: CHOWN_APP, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: CLONE_RM, line: MKTEMP_LINE, guard: null, why: MKTEMP },
    { file: 'scripts/install.sh', op: /^rsync -a --delete(?:\s+--exclude='[^']+')+\s+"\$\{LOCAL_SOURCE_DIR%\/\}\/" "\$\{APP_DIR\}\/"$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: CHOWN_APP, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: COPY_GIT, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: /^chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}\/\.git"$/, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: CLONE_RM, line: MKTEMP_LINE, guard: null, why: MKTEMP },
    ...Array.from({ length: 3 }, () => ({ file: 'scripts/update.sh', op: PUB, guard: null, why: PUBLISH })),
    ...Array.from({ length: 3 }, () => ({ file: 'scripts/update.sh', op: CLONE_RM, line: GUARD_CLEANUP_LINE, guard: null, why: CLEANUP })),
    { file: 'scripts/update.sh', op: RSYNC_CLONE, guard: G('${APP_DIR}') },
    { file: 'scripts/update.sh', op: COPY_GIT, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/update.sh', op: CHOWN_APP, guard: G('${APP_DIR}') },
    { file: 'scripts/update.sh', op: CLONE_RM, line: MKTEMP_LINE, guard: null, why: MKTEMP },
    // o3d-noka: both are now aimed at ${BACKUP_AT}, which is `/proc/self/fd/N` on the directory
    // open_root_owned_ancestry() walked to — renameat and unlinkat rather than a third and fourth
    // resolution of an operator-settable pathname. The guard before the prune still asks about
    // ${BACKUP_DIR}, because containment is a question about pathnames.
    { file: 'scripts/update.sh', op: /^mv -T "\$\{BACKUP_PARTIAL\}" "\$\{BACKUP_AT\}\/\$\{BACKUP_BASENAME\}"$/, guard: null, why: 'one finished dump file renamed onto its final name under the pinned descriptor, not a tree' },
    { file: 'scripts/update.sh', op: /^xargs -r rm --$/, line: /^\s*ls -t "\$\{BACKUP_AT\}"\/pre-update-\*\.sql\.gz 2>\/dev\/null \| tail -n \+11 \| xargs -r rm --$/, guard: G('${BACKUP_DIR}') },
    ...Array.from({ length: 3 }, () => ({ file: 'scripts/deploy.sh', op: PUB, guard: null, why: PUBLISH })),
  ]

  for (const rel of ENTRYPOINTS) {
    const source = ENTRYPOINT_SOURCE.get(rel)!
    const lines = logicalLines(source)
    const ops = censusOps(source)
    const expected = table.filter((entry) => entry.file === rel)
    assert.equal(ops.length, expected.length,
      `${rel}: the census must account for every classified statement, found ${ops.length} and the table has ${expected.length}:\n${ops.map((op) => `${op.n}: ${op.text.trim().slice(0, 110)}`).join('\n')}`)
    const used = new Set<number>()
    for (const op of ops) {
      const entryIndex = expected.findIndex((entry, i) => !used.has(i) && entry.op.test(op.text) && (!entry.line || entry.line.test(op.line)))
      assert.notEqual(entryIndex, -1, `${rel}:${op.n}: a tree-wide statement the census does not know: ${op.text.trim().slice(0, 140)}`)
      used.add(entryIndex)
      const entry = expected[entryIndex]
      if (entry.guard === null) {
        assert.ok(entry.why && entry.why.length > 20, `${rel}:${op.n}: an unguarded statement needs a written reason`)
        if (entry.why === MKTEMP) {
          const before = lines.slice(0, op.index).filter((line) => /(^|[\s;(])TMP_CLONE_DIR=/.test(line.text))
          assert.ok(before.length > 0, `${rel}:${op.n}: no assignment of TMP_CLONE_DIR precedes this delete`)
          assert.match(before[before.length - 1].text.trim(), /^TMP_CLONE_DIR="\$\(mktemp -d -t [A-Za-z.-]+XXXXXX\)"$/,
            `${rel}:${op.n}: the nearest preceding assignment must be the mktemp that justifies it: ${before[before.length - 1].text}`)
        }
        if (entry.why === PUBLISH) {
          // NOT WAVED THROUGH ON THE SHAPE OF THE LINE (review LOW 8): the exemption is that ONE staged
          // FILE is renamed, so the source's own nearest assignment must be a `mktemp` with no `-d`. A
          // future publish that staged a DIRECTORY fails here instead of inheriting the reason. It sits
          // INSIDE this branch, before its `continue`: r9's first draft put it after, where no PUBLISH row
          // (all unguarded) ever reached it, and its mutation — a publish staging a directory — stayed green.
          const source = /mv -f (?:-T )?"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/.exec(op.text)
          assert.ok(source, `${rel}:${op.n}: an exempt publish must move a named staging variable: ${op.text.trim()}`)
          const made = lines.slice(0, op.index).filter((line) => new RegExp(`(^|[\\s;(!])${source![1]}=`).test(line.text))
          assert.ok(made.length > 0, `${rel}:${op.n}: no assignment of ${source![1]} precedes this move`)
          const nearest = made[made.length - 1].text
          assert.match(nearest, new RegExp(`${source![1]}="\\$\\(mktemp (?!-d)`),
            `${rel}:${op.n}: ${source![1]} must be a single mktemp FILE for the publish exemption, and is: ${nearest.trim()}`)
        }
        continue
      }
      const previous = lines[op.index - (entry.up ?? 1)]
      assert.ok(previous?.text.trim().startsWith(entry.guard),
        `${rel}:${op.n} (${op.text.trim().slice(0, 80)}) must be immediately preceded by ${entry.guard}…, and is preceded by: ${previous?.text}`)
      // AND THE REFUSAL MUST END THE RUN (o3d-z5be r8/r9). r7 checked only that the call was there, so
      // `|| warn "…"` or `|| true` satisfied it while the chown ran anyway. r8's regex was still
      // satisfiable by a run that CONTINUES: `guard || warn "overlap" || die "…"` reaches `die` never
      // (warn succeeds), and `guard || { echo "die trying"; }` matched the word inside a message
      // (review MEDIUM 3, both executed). So the whole line must be one of the two shipped shapes.
      assert.ok(refusalEndsRun(previous.text),
        `${rel}:${previous.n}: the guard's refusal must end the run (|| die …), and the line is: ${previous.text.trim()}`)
    }
  }

  // AND `die` ITSELF ENDS THE RUN (r10/r11, review L1). refusalEndsRun() accepts `|| die "…"` on the
  // strength of the NAME, so each entrypoint must define `die` exactly once — in itself, before its
  // first guard, with a body whose last command is a non-zero `exit` — and NOTHING in it or its
  // libraries may undo that: no definition, anywhere in a statement, of `die` again or of a builtin
  // that `die` (or a guard) depends on (`exit() { return 0; }` made die return and the run continue),
  // and no `unset … die` or `alias die=` anywhere in a statement (r10's check was anchored at line start).
  const SHADOWED = new Set(['exit', 'return', 'builtin', 'command', 'set', 'trap', 'source', '.', 'die', 'unset', 'alias', 'eval'])
  const definedIn = (text: string) => logicalLines(text).flatMap((line) => statementsOf(line.text).flatMap((statement) => {
    const m = /^(?:function\s+([A-Za-z_][A-Za-z0-9_]*|\.)\s*(?:\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*|\.)\s*\(\s*\))/.exec(statement)
    return m ? [{ name: m[1] ?? m[2], n: line.n, text: line.text }] : []
  }))
  for (const rel of ENTRYPOINTS) {
    const source = ENTRYPOINT_SOURCE.get(rel)!
    const texts: Array<[string, string]> = [[rel, source], ...SOURCED_LIBS.map((lib) => [lib, readFileSync(join(REPO, lib), 'utf8')] as [string, string])]
    const all = texts.flatMap(([where, text]) => definedIn(text).map((d) => ({ where, ...d })))
    assert.ok(all.length > 50, `precondition: ${all.length} function definitions were read`)
    const definitions = all.filter((d) => d.name === 'die')
    assert.equal(definitions.length, 1, `${rel}: die must be defined exactly once across the entrypoint and its libraries: ${definitions.map((d) => `${d.where}:${d.n}`).join(', ')}`)
    assert.equal(definitions[0].where, rel, `${rel}: and in the entrypoint itself`)
    const shadows = all.filter((d) => SHADOWED.has(d.name) && d.name !== 'die')
    assert.deepEqual(shadows.map((d) => `${d.where}:${d.n} ${d.name}`), [], `${rel}: nothing may redefine a builtin die or a guard depends on`)
    const body = /\{(.*)\}\s*$/.exec(definitions[0].text)?.[1] ?? ''
    const commands = shellCommands(body)
    const last = commands[commands.length - 1] ?? []
    assert.ok(last[0] === 'exit' && /^[1-9][0-9]*$/.test(last[1] ?? ''), `${rel}:${definitions[0].n}: die's last command must be a non-zero exit: ${definitions[0].text.trim()}`)
    for (const [where, text] of texts) {
      for (const line of logicalLines(text)) {
        for (const words of shellCommands(line.text)) {
          const { name, args } = commandName(words)
          assert.ok(!(name === 'unset' && args.includes('die')), `${where}:${line.n}: must not unset die: ${line.text.trim()}`)
          assert.ok(!(name === 'alias' && args.some((a) => /^(die|exit)=/.test(a))), `${where}:${line.n}: must not alias die or exit: ${line.text.trim()}`)
        }
      }
    }
    const firstGuard = logicalLines(source).find((line) => /^\s*privileged_spare_running_tree /.test(line.text))
    if (firstGuard) assert.ok(definitions[0].n < firstGuard.n, `${rel}: die must be defined before the first guard`)
  }

  // THE FORMS THE NET MUST SEE, asserted on the tokeniser itself — an injection into a shipped file
  // would be a test that rewrites its own subject. The `"$( … )"` block is r8's finding; the rest are
  // r7's and the review's additions.
  const seen = (text: string) => shellCommands(text).some((w) => treeWide(w, new Set(['fix_ownership']), new Map([['CH', 'chown']])))
  for (const form of [
    // review HIGH 1 — the command substitution idiom this codebase uses everywhere
    'out="$(find "${APP_DIR}" -exec chown "${APP_USER}" {} +)"',
    'out="$(chown -R "${APP_USER}" "${APP_DIR}")"',
    'digest="$(rsync -a "${SRC}/" "${APP_DIR}/")"',
    'if ! out="$(rm -rf "${APP_DIR}" 2>&1)"; then :; fi',
    // r7's list, still seen
    'chown -h -R "${APP_USER}:${APP_USER}" "${APP_DIR}"',
    'rm -Rf "${APP_DIR}"',
    'find "${APP_DIR}" -print0 | xargs -0 chown "${APP_USER}"',
    'cp --archive "${SRC}" "${APP_DIR}"',
    'su -s /bin/bash -c "chown -R ${APP_USER} ${APP_DIR}" root',
    'eval "chown -R ${APP_USER} ${APP_DIR}"',
    'bash -c "chown -R ${APP_USER} ${APP_DIR}"',
    'mv -t "${APP_DIR}" "${SRC}"/*',
    'chmod --recursive go-w "${APP_DIR}"',
    'useradd --create-home --home-dir "${APP_DIR}" "${APP_USER}"',
    'chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"',
    // review MEDIUM 1/4/5
    'chown \\\n  -R "${APP_USER}" "${APP_DIR}"',
    '/bin/chown -R "${APP_USER}" "${APP_DIR}"',
    'chown "-R" imsapp "${APP_DIR}"',
    '$CH -R imsapp "${APP_DIR}"',
    'fix_ownership "${APP_DIR}"',
    'mv "${src}" "${APP_DIR}"',
    'tar -x --same-owner -f release.tar -C "${APP_DIR}"',
    'tar xzf release.tgz -C "${APP_DIR}"',
    'install -d -o "${APP_USER}" "${APP_DIR}/x"',
    'cpio -pdm "${APP_DIR}" < list',
    'unzip -d "${APP_DIR}" release.zip',
    'find "${APP_DIR}" -printf "%p\\n" | while read -r f; do chown -R "${APP_USER}" "$f"; done',
    'env chown -R "${APP_USER}" "${APP_DIR}"',
    'timeout 30 chown -R "${APP_USER}" "${APP_DIR}"',
    'nohup chown -R "${APP_USER}" "${APP_DIR}"',
    'command chown -R "${APP_USER}" "${APP_DIR}"',
    'setfacl -R -m u:imsapp:rwx "${APP_DIR}"',
    'chgrp --recursive imsapp "${APP_DIR}"',
    // r9 (review HIGH 1, MEDIUM 1/2/5): shapes r8 read as NOTHING. The first is the house idiom — the
    // three entrypoints hold 17 one-line definitions and 52 same-line case arms of their own.
    'fix_own() { chown -R "${APP_USER}" "${APP_DIR}"; }',
    'function fix_own() { chown -R "${APP_USER}" "${APP_DIR}"; }',
    // no parentheses: only functionBody() separates the body from `function NAME {` here, because a
    // `{` after a word is a word — this is the form that makes that helper load-bearing.
    'function fix_own { chown -R "${APP_USER}" "${APP_DIR}"; }',
    '  APP_DIR) chown -R imsapp "${APP_DIR}" ;;',
    'sudo chown -R "${APP_USER}" "${APP_DIR}"',
    'sudo -u root chown -R "${APP_USER}" "${APP_DIR}"',
    'runuser -u root -- chown -R "${APP_USER}" "${APP_DIR}"',
    'su - root -- chown -R "${APP_USER}" "${APP_DIR}"',
    'diff <(chown -R imsapp "${APP_DIR}") /dev/null',
    'tee >(chown -R imsapp "${APP_DIR}")',
    "trap 'chown -R imsapp \"${APP_DIR}\"' EXIT",
  ]) {
    assert.ok(seen(form.replace(/\\\n/g, ' ')), `the net must see: ${form}`)
  }
  // AND THE CALL, NOT ONLY THE BODY (review HIGH 1). Reading a one-line definition's body proves the
  // definition line is counted; the reviewer's finding was that its CALLS vanished too, because the
  // function was never registered. Each definition form is registered, and the bare call is tree-wide.
  for (const definition of [
    'fix_own() { chown -R "${APP_USER}" "${APP_DIR}"; }',
    'function fix_own { chown -R "${APP_USER}" "${APP_DIR}"; }',
    'fix_own() {\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
    'fix_own ()\n{\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
  ]) {
    const functions = treeWideFunctions(`${definition}\nfix_own\n`)
    assert.ok(functions.has('fix_own'), `the net must register: ${definition}`)
    assert.ok(shellCommands('fix_own').some((w) => treeWide(w, functions, new Map())),
      `and see a call to it: ${definition}`)
  }
  // AND A DEFINITION IS NOT A CALL OF ITSELF: body + call = exactly two rows in each form below, the way the
  // census counts them (functionBody, then the tokeniser). Without functionBody three of these are 3.
  for (const definition of [
    'fix_own() {\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
    'fix_own () {\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
    'function fix_own {\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
    'fix_own ()\n{\n  chown -R "${APP_USER}" "${APP_DIR}"\n}',
    'function fix_own { chown -R "${APP_USER}" "${APP_DIR}"; }',
  ]) {
    const source = `${definition}\nfix_own\n`
    const functions = treeWideFunctions(source)
    const rows = logicalLines(source).filter((line) => shellCommands(functionBody(line.text)).some((w) => treeWide(w, functions, new Map())))
    assert.equal(rows.length, 2, `body and call, not the head: ${definition} -> ${rows.map((r) => r.text).join(' | ')}`)
  }
  // A ONE-LINE HELPER THAT IS NOT TREE-WIDE stays unregistered, or every `die` call would be a row.
  assert.ok(!treeWideFunctions('die() { error "$*"; exit 1; }\ndie x\n').has('die'), 'die() is not tree-wide')

  // THE HOUSE PASS-THROUGH WRAPPERS, READ (r10, review H1). The wrapper definitions below are the
  // shipped ones' shapes: `run` (update.sh/deploy.sh), `capture VAR` and `run_as_user USER` (install.sh),
  // and a wrapper calling a wrapper. Each call is counted as a census row; without the wrapper reading,
  // `run chown -R …` was measured by the reviewer to leave the real test green.
  const wrapperFile = [
    'run() {', '  if $DRY_RUN; then', '    echo "would run: $*"', '    return 0', '  fi', '  "$@"', '}',
    'capture() {', '  local __capture_name="$1"', '  shift', '  __capture_raw="$(', '    "$@"', '  )" || true', '}',
    'run_as_user() {', '  local user="$1"', '  shift', '  runuser -u "$user" -- "$@"', '}',
    'run_git_as_user() {', '  local user="$1"', '  shift', '  run_as_user "${user}" env "GIT_SSH_COMMAND=ssh" "$@"', '}',
  ].join('\n')
  for (const call of [
    'run chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"',
    'capture out chown -R "${APP_USER}" "${APP_DIR}"',
    'run_as_user root chown -R "${APP_USER}" "${APP_DIR}"',
    'run_git_as_user root rm -rf "${APP_DIR}"',
    'if ! run rsync -a "${SRC}/" "${APP_DIR}/"; then die x; fi',
  ]) {
    const rows = censusOps(`${wrapperFile}\n${call}\n`)
    assert.deepEqual(rows.map((row) => row.line), [call], `the census must read the wrapper call: ${call}`)
  }
  for (const quiet of ['run npm ci', 'capture out git rev-parse HEAD', 'run_as_user imsapp npm ci', 'run rm -f "$tmp"']) {
    assert.deepEqual(censusOps(`${wrapperFile}\n${quiet}\n`).map((row) => row.text), [], `and must stay quiet on: ${quiet}`)
  }
  // The shipped files really define these as wrappers, with the fixed operands measured from their bodies.
  for (const [rel, name, skip] of [
    ['scripts/update.sh', 'run', 0], ['scripts/deploy.sh', 'run', 0], ['scripts/install.sh', 'capture', 1],
    ['scripts/install.sh', 'run_as_user', 1], ['scripts/update.sh', 'run_as_user', 1], ['scripts/deploy.sh', 'as_app_user', 0],
  ] as const) {
    assert.equal(passThroughWrappers(ENTRYPOINT_SOURCE.get(rel)!).get(name)?.skip, skip, `${rel}: ${name} must be a wrapper skipping ${skip}`)
  }

  // HERE-DOCUMENTS (r10, review M1/M2): a body fed to a shell is CODE, a body fed to anything else is
  // data, and what opens one is found by scanning, not by a regex over the raw line.
  for (const fed of [
    "bash <<'EOF'\nchown -R imsapp \"${APP_DIR}\"\nEOF",
    'bash -s -- a b <<EOF\nchown -R imsapp "${APP_DIR}"\nEOF',
    'runuser -u root -- bash <<EOF\nchown -R imsapp "${APP_DIR}"\nEOF',
    'su root <<EOF\nchown -R imsapp "${APP_DIR}"\nEOF',
    'sudo bash <<\\EOF\nchown -R imsapp "${APP_DIR}"\nEOF',
  ]) assert.equal(censusOps(fed).length, 1, `a here-document fed to a shell is code: ${fed}`)
  for (const data of [
    "cat <<'EOF'\nchown -R imsapp x\nEOF",
    'cat > f <<-EOF\n\tchown -R imsapp x\n\tEOF',
    'cat <<\\EOF\nchown -R imsapp x\nEOF',
    'cat <<END-OF\nchown -R imsapp x\nEND-OF',
  ]) assert.equal(censusOps(data).length, 0, `a here-document fed to cat is data: ${data}`)
  // …and NOT opened by a message, arithmetic, a here-string or a trailing comment: the chown after each
  // must still be counted (r9's regex swallowed it up to a line reading `EOF`).
  for (const opener of [
    'warn "run: bash install.sh <<EOF"',
    'x=$(( 1 << BITS ))',
    "grep -q x <<<'text'",
    'true # see <<EOF',
    "echo '<<EOF'",
  ]) {
    const source = `${opener}\nchown -R imsapp "\${APP_DIR}"\nEOF\n`
    assert.equal(censusOps(source).length, 1, `nothing on this line opens a here-document: ${opener}`)
  }

  // An alias needs both lines, so it is asserted over a two-line source (review LOW 12: r8 resolved
  // only a bare `NAME=value`, while `declare -x`/`readonly` are assignments of a command name too).
  for (const alias of ['readonly CH=chown', 'declare -x CH=chown', 'CH=chown']) {
    const source = `${alias}\n$CH -R "${'${APP_USER}'}" "${'${APP_DIR}'}"\n`
    const aliases = commandAliases(source)
    assert.ok(shellCommands('$CH -R "${APP_USER}" "${APP_DIR}"').some((w) => treeWide(w, new Set(), aliases)),
      `the net must resolve the alias in: ${alias}`)
  }

  // The continuation form goes through logicalLines() first, which is how the matcher sees it at all.
  assert.equal(logicalLines('chown \\\n  -R "${APP_USER}" "${APP_DIR}"').length, 1, 'continuations must be joined into one logical line')

  // AND WHAT IT MUST NOT FIRE ON: messages that quote a command, single-file operations, and a
  // privilege DROP whose payload is not tree-wide.
  for (const quiet of [
    'die "This script must be run as root. Try: sudo bash install.sh"',
    'ims_startup_refuse "Do NOT chown or chmod an existing tree to get past this"',
    'echo "chown -R imsapp /opt"',
    'rm -f "$tmp"',
    'chown root:root "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || true',
    'chmod 600 "$tmp"',
    // FOR THE RIGHT REASON NOW (review MEDIUM 2): r8 did not read a runner's payload unless it carried
    // `-c`, so this control passed while `npm ci` was never looked at — it would have passed identically
    // if the payload were `chown -R /`. The positive list above now contains that very shape.
    'runuser -u "$APP_USER" -- npm ci',
    'sudo -u "$user" "$@"',
    'run_as_user "${APP_USER}" git -C "${APP_DIR}" fetch origin',
  ]) {
    assert.ok(!seen(quiet), `the net must NOT fire on: ${quiet}`)
  }

  // AND THE REFUSAL PREDICATE ITSELF, on the shapes that defeated r8's regex. Both rejected shapes were
  // EXECUTED by the reviewer under `set -euo pipefail` and the run CONTINUED past the failing guard.
  const GUARD_CALL = 'privileged_spare_running_tree "${APP_DIR}" "the application directory"'
  for (const ends of [
    `${GUARD_CALL} || die "${'${IMS_DRIVER_OVERLAP_REASON}'}"`,
    `    ${GUARD_CALL} || { rm -rf "${'${TMP_CLONE_DIR}'}"; die "${'${IMS_DRIVER_OVERLAP_REASON}'}"; }`,
  ]) assert.ok(refusalEndsRun(ends), `this refusal does end the run: ${ends}`)
  for (const continues of [
    `${GUARD_CALL} || warn "overlap" || die "stop"`,
    `${GUARD_CALL} || { echo "die trying"; }`,
    `${GUARD_CALL} || true`,
    `${GUARD_CALL} || die_later "stop"`,
    `${GUARD_CALL} || ( die "stop" )`,
    `${GUARD_CALL} | cat || die "stop"`,
    `${GUARD_CALL}`,
  ]) assert.ok(!refusalEndsRun(continues), `this refusal does NOT end the run: ${continues}`)
})

// ---------------------------------------------------------------------------
// RUN-TIME GUARDS (o3d-z5be r11, review H3/H4/M2). The static net reads text; it cannot bind which
// path a helper is handed, or what a readonly name holds. These tests EXECUTE the shipped helpers with
// the paths an accident — or a retargeted constant — would hand them, and require each refusal to END
// the run (non-zero status, and the statement after it never runs) with the target untouched, while a
// legitimate path proceeds. Nothing here runs install.sh, update.sh or deploy.sh; the functions are the
// shipped text, sourced or lifted.
// ---------------------------------------------------------------------------

/** A directory standing in for ${APP_DIR}, with one file whose survival is the assertion. */
function appTree(t: TestContext): { app: string; victim: string } {
  const app = join(createTempDirSync('runtime-guard-app-', t), 'app')
  mkdirSync(app)
  const victim = join(app, 'keep.txt')
  writeFileSync(victim, 'the application tree\n')
  return { app, victim }
}

function assertRefusedAndEnded(out: Run, what: string, victim?: string): void {
  assert.notEqual(out.status, 0, `${what}: the refusal must end the run with a non-zero status:\n${out.stdout}${out.stderr}`)
  assert.doesNotMatch(out.stdout, /^AFTER$/m, `${what}: nothing after the refusal may run:\n${out.stdout}`)
  assert.match(out.stderr, /REFUSING/, `${what}: and it must say why:\n${out.stderr}`)
  if (victim) assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', `${what}: the target must be untouched`)
}

test('[o3d-z5be] RUN-TIME GUARD driver_require_owned_path: driver_publish_unwind refuses, and ENDS the run on, any path outside IMS_DRIVER_ROOT', (t) => {
  const dirs = scratch(t)
  const { app, victim } = appTree(t)
  const root = dirs.root
  symlinkSync(app, join(root, 'link-into-app'))
  const tail = `"${root}/.pointer-x" "${root}/.retire-x" "${root}/helpers" 0`
  for (const [label, first] of [
    ['${APP_DIR}', app],
    ['/', '/'],
    ['a path THROUGH a symlink under the root that points into ${APP_DIR}', `${root}/link-into-app/keep.txt`],
    ['the root itself', root],
    ['a `..` escape', `${root}/../escape`],
    ['a relative path', 'relative/x'],
  ] as const) {
    const out = run(dirs, `driver_publish_unwind ${JSON.stringify(first)} ${tail}\necho AFTER`)
    assertRefusedAndEnded(out, `driver_publish_unwind with ${label}`, victim)
  }
  // EVERY argument is checked, not only the first: the target, the retire and the pointer too.
  for (const args of [
    `"${root}/.version-x" "${root}/.pointer-x" "${root}/.retire-x" ${JSON.stringify(app)} 1`,
    `"${root}/.version-x" "${root}/.pointer-x" ${JSON.stringify(app)} "${root}/helpers" 0`,
    `"${root}/.version-x" ${JSON.stringify(app)} "${root}/.retire-x" "${root}/helpers" 0`,
  ]) {
    assertRefusedAndEnded(run(dirs, `driver_publish_unwind ${args}\necho AFTER`), `driver_publish_unwind ${args}`, victim)
  }
  // THE LINK ITSELF IS ACCEPTED (r12, review L2): unwind's operations act on NAMES (`rm -rf NAME`,
  // `mv -T NAME …` unlink or rename a final symlink, they do not follow it), so a pointer under the root
  // whose target lies elsewhere is removed, and what it pointed at is untouched.
  const linkRun = run(dirs, `driver_publish_unwind "${root}/link-into-app" ${tail}\necho AFTER`)
  assert.equal(linkRun.status, 0, `a link under the root must be removable:\n${linkRun.stderr}`)
  assert.equal(lstatSync(join(root, 'link-into-app'), { throwIfNoEntry: false }), undefined, 'the link is gone')
  assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', 'and what it pointed at is untouched')
  // AND A LEGITIMATE CALL PROCEEDS: the version directory it names is removed, and the run continues.
  mkdirSync(join(root, '.version-x'))
  writeFileSync(join(root, '.version-x', 'f'), 'x\n')
  const ok = run(dirs, `driver_publish_unwind "${root}/.version-x" ${tail}\necho AFTER`)
  assert.equal(ok.status, 0, `a path under the root must be accepted:\n${ok.stdout}${ok.stderr}`)
  assert.match(ok.stdout, /^AFTER$/m)
  assert.equal(existsSync(join(root, '.version-x')), false, 'and the unwind must have done its work')
})

/** The shipped fence library, its recovery root aimed at `recovery` (and, optionally, one more line
 *  replaced), sourced, then `program`. */
function withFenceLibrary(t: TestContext, recovery: string, program: string, replace?: [string, string], env: Record<string, string> = {}): Run {
  let text = protectedLibraryTextAt(recovery)
  if (replace) {
    assert.equal(text.split(replace[0]).length, 2, `the fence library must contain exactly one ${replace[0]}`)
    text = text.replace(replace[0], replace[1])
  }
  const work = createTempDirSync('runtime-guard-fence-', t)
  const lib = join(work, 'db-fence-protected.sh')
  writeFileSync(lib, text)
  const out = spawnSync('bash', ['-c', ['set -uo pipefail', `source ${JSON.stringify(lib)}`, program].join('\n')], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

test('[o3d-xi3w] privileged-helpers.sh REFUSES TO LOAD without the library whose decision its guards make', (t) => {
  // o3d-xi3w moved the ownership decision the run-time guards make, and the /proc walk the sweep needs,
  // into lib/db-fence-protected.sh, which all three entrypoints already source FIRST and whose
  // publication primitives this library already used. The hazard that creates is specific: a missing
  // function in bash is a command that is NOT FOUND, so `if _priv_name_inside_root …; then return 0; fi`
  // would print an error, take its failure branch, and — for a guard whose refusal is the else — the
  // operation it protects would run UNCHECKED. A claim about what callers source cannot close that, so
  // the order is enforced at load.
  const work = createTempDirSync('helpers-load-order-', t)
  // The shape is the entrypoints' own: `source … || { echo FATAL …; exit 1; }`, so what is asserted is
  // that the source RETURNS NON-ZERO — which is what those lines act on — and that the body is not run.
  const alone = spawnSync('bash', ['-c',
    `set -uo pipefail\nsource ${JSON.stringify(join(REPO, LIB_REL))} || { echo REFUSED; exit 9; }\necho REACHED`],
    { encoding: 'utf8', cwd: work })
  assert.equal(alone.status, 9, `sourcing it alone must refuse: ${alone.stdout}${alone.stderr}`)
  assert.match(alone.stdout ?? '', /^REFUSED$/m, 'and the caller\'s own failure branch must run')
  assert.doesNotMatch(alone.stdout ?? '', /^REACHED$/m, 'and nothing after the source may run')
  assert.match(alone.stderr ?? '', /FATAL: _priv_path_inside_root\(\) is not defined/, alone.stderr ?? '')
  assert.match(alone.stderr ?? '', /db-fence-protected\.sh has not been sourced before/, 'and say which order is wrong')

  // NOT VACUOUS: the same source, with the fence library first, loads and the guards are callable.
  const ordered = spawnSync('bash', ['-c',
    `set -uo pipefail\nsource ${JSON.stringify(join(REPO, FENCE_LIB_REL))}\nsource ${JSON.stringify(join(REPO, LIB_REL))}\ndeclare -F driver_require_owned_path >/dev/null && echo REACHED`],
    { encoding: 'utf8', cwd: work })
  assert.equal(ordered.status, 0, ordered.stderr ?? '')
  assert.match(ordered.stdout ?? '', /^REACHED$/m, 'the documented order must load')

  // AND THE LIST IS THE FUNCTIONS IT REALLY TAKES: every `_priv_`/`_fence_` name this library CALLS is
  // one the load-time check names, so a new borrowing cannot be added without extending the check.
  // Read from the COMMAND POSITION of every code line, not from the text: this file names several of
  // these functions in prose, and a comment is not a call.
  const called = new Set(codeLines(LIB_SOURCE)
    .flatMap((line) => shellCommands(line.text))
    .map((words) => commandName(words).name)
    // …less the check's own loop variable, which the tokeniser reads out of `for _priv_required in …`
    // as a command name and which is a variable, not a function.
    .filter((name) => /^_(?:priv|fence)_/.test(name) && name !== '_priv_required'))
  const checked = new Set((/^for _priv_required in ([\s\S]*?); do$/m.exec(LIB_SOURCE)?.[1] ?? '')
    .split(/[\s\\]+/).filter((word) => word.startsWith('_')))
  assert.ok(checked.size >= 8, `precondition: the load-time check names ${checked.size} functions`)
  const borrowed = [...called].filter((name) => !LIB_SOURCE.includes(`\n${name}() {`)).sort()
  assert.ok(borrowed.length > 0, 'precondition: this library really does borrow functions')
  assert.deepEqual(borrowed.filter((name) => !checked.has(name)), [],
    `every borrowed function must be named in the load-time check: ${borrowed.join(', ')}`)
})

test('[o3d-z5be] RUN-TIME GUARD _fence_require_owned_tree: the fence copies into, and deletes, nothing outside its recovery root — even with a readonly re-aimed', (t) => {
  const recovery = join(createTempDirSync('runtime-guard-recovery-', t), 'recovery')
  mkdirSync(recovery)
  const { app, victim } = appTree(t)
  symlinkSync(app, join(recovery, 'link-into-app'))
  for (const [label, dest] of [
    ['${APP_DIR}', app],
    ['/', '/'],
    ['a symlink under the recovery root that points into ${APP_DIR}', join(recovery, 'link-into-app')],
    ['a `..` escape', `${recovery}/../escape`],
    ['the recovery root itself', recovery],
  ] as const) {
    const out = withFenceLibrary(t, recovery, `_fence_vendor_into ${JSON.stringify(app)} ${JSON.stringify(dest)}\necho AFTER`)
    assertRefusedAndEnded(out, `_fence_vendor_into into ${label}`, victim)
  }
  // A LEGITIMATE DESTINATION PASSES THE GUARD: the function reaches its own `mkdir -p` of it.
  const staged = join(recovery, '.app.staged')
  const ok = withFenceLibrary(t, recovery, `_fence_vendor_into ${JSON.stringify(app)} ${JSON.stringify(staged)}; echo "RC=$?"\necho AFTER`)
  assert.doesNotMatch(ok.stderr, /REFUSING/, `a destination under the recovery root must not be refused:\n${ok.stderr}`)
  assert.match(ok.stdout, /^AFTER$/m)
  assert.equal(existsSync(staged), true, 'and the function must have proceeded to create it')

  // REVIEW M2: re-aiming a readonly needs no line that spells a privileged word. With the staging name
  // pointed at ${APP_DIR}, _fence_stage_and_publish must refuse before its `rm -rf` of it.
  const retargeted = withFenceLibrary(t, recovery, '_fence_stage_and_publish\necho AFTER',
    ['readonly DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"', `readonly DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(app)}`])
  assertRefusedAndEnded(retargeted, 'the protected artefact name re-aimed at ${APP_DIR}', victim)

  // THE PROBE DIRECTORY (r12, review H1): accepted only when the CALLER PASSES it as "$3" and it is what
  // `mktemp -d` makes — a real directory owned by this uid, named `tmp.` + ten characters, directly in
  // ${TMPDIR:-/tmp}. No global is read: r11's _FENCE_OWNED_TMP let an inherited value widen the check.
  const tmpdir = createTempDirSync('runtime-guard-tmpdir-', t)
  const probe = execFileSync('mktemp', ['-d'], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmpdir } }).trim()
  const inProbe = join(probe, 'scripts')
  const probeOk = withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(inProbe)} probe ${JSON.stringify(probe)}\necho AFTER`, undefined, { TMPDIR: tmpdir })
  assert.equal(probeOk.status, 0, probeOk.stderr)
  assert.match(probeOk.stdout, /^AFTER$/m)
  // the same path, not offered as the probe, is refused
  assertRefusedAndEnded(withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(inProbe)} probe\necho AFTER`, undefined, { TMPDIR: tmpdir }), 'a probe path without the probe named')
  // a directory that is not a mktemp directory, offered as the probe, is refused — ${APP_DIR} above all
  assertRefusedAndEnded(withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(app)} probe ${JSON.stringify(app)}\necho AFTER`, undefined, { TMPDIR: join(app, '..') }),
    '${APP_DIR} offered as the probe', victim)
  // LOW-2 (r13): the LOCATION condition — a mktemp-shaped directory not DIRECTLY in ${TMPDIR} is refused…
  const nested = execFileSync('mktemp', ['-d'], { encoding: 'utf8', env: { ...process.env, TMPDIR: join(tmpdir, '..') } }).trim()
  const deeper = join(tmpdir, 'sub')
  mkdirSync(deeper)
  const deep = execFileSync('mktemp', ['-d'], { encoding: 'utf8', env: { ...process.env, TMPDIR: deeper } }).trim()
  for (const [label, dir] of [['a probe one level below ${TMPDIR}', deep], ['a probe beside ${TMPDIR}', nested]] as const) {
    assertRefusedAndEnded(withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(dir)} probe ${JSON.stringify(dir)}\necho AFTER`, undefined, { TMPDIR: tmpdir }), label)
  }
  rmSync(nested, { recursive: true, force: true })
  // …and the OWNER condition: the same real probe, with `id -u` answering another account.
  const shim = createTempDirSync('runtime-guard-id-', t)
  writeFileSync(join(shim, 'id'), '#!/bin/sh\nif [ "$1" = "-u" ]; then echo 4242; else exec /usr/bin/id "$@"; fi\n', { mode: 0o755 })
  assertRefusedAndEnded(withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(inProbe)} probe ${JSON.stringify(probe)}\necho AFTER`, undefined, { TMPDIR: tmpdir, PATH: `${shim}:${process.env.PATH}` }),
    'a probe owned by an account other than this one')
  const linked = join(tmpdir, 'tmp.AAAAAAAAAA')
  symlinkSync(app, linked)
  assertRefusedAndEnded(withFenceLibrary(t, recovery, `_fence_require_owned_tree ${JSON.stringify(linked)} probe ${JSON.stringify(linked)}\necho AFTER`, undefined, { TMPDIR: tmpdir }),
    'a probe name that is a symlink into ${APP_DIR}', victim)
})

test('[o3d-z5be] RUN-TIME GUARD in copy_tree_into_new_dir: it refuses, and ends the run on, a destination that overlaps the running tree', (t) => {
  const base = createTempDirSync('runtime-guard-copy-', t)
  const release = join(base, 'release')
  const runningLib = join(release, 'scripts', 'lib')
  mkdirSync(runningLib, { recursive: true })
  writeFileSync(join(release, 'scripts', 'install.sh'), '# the running entrypoint\n')
  const src = join(base, 'clone', '.git')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'HEAD'), 'ref: refs/heads/main\n')
  const program = (dest: string) => [
    'die() { echo "DIE: $*" >&2; exit 1; }',
    `source ${JSON.stringify(join(REPO, 'scripts/lib/cutover-namespace.sh'))}`,
    `copy_tree_into_new_dir ${JSON.stringify(src)} ${JSON.stringify(dest)}`,
    'echo AFTER',
  ].join('\n')
  for (const [label, dest] of [['the release that holds the running tree', release], ['the running lib itself', runningLib], ['/', '/']] as const) {
    const out = withGuardLibrary(runningLib, program(dest))
    assert.notEqual(out.status, 0, `${label}: must end the run:\n${out.stdout}${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^AFTER$/m, `${label}: nothing after the refusal may run`)
    assert.equal(existsSync(join(release, 'scripts', 'install.sh')), true, `${label}: the running tree must be untouched`)
  }
  const dest = join(base, 'app', '.git')
  mkdirSync(join(base, 'app'))
  const ok = withGuardLibrary(runningLib, program(dest))
  assert.equal(ok.status, 0, `a separate destination must be accepted:\n${ok.stdout}${ok.stderr}`)
  assert.equal(readFileSync(join(dest, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n', 'and the copy must have happened')
})

test('[o3d-z5be] RUN-TIME GUARD in chown_state_tree: it re-owns ${DATA_DIR} and nothing else, and never a tree overlapping the running one', (t) => {
  const base = createTempDirSync('runtime-guard-state-', t)
  const release = join(base, 'release')
  const runningLib = join(release, 'scripts', 'lib')
  mkdirSync(runningLib, { recursive: true })
  const data = join(base, 'var-lib', 'ims')
  mkdirSync(data, { recursive: true })
  const { app, victim } = appTree(t)
  const fn = shellFunction(INSTALL_SOURCE, 'chown_state_tree', 'scripts/install.sh')
  const program = (root: string, dataDir: string) => [
    // A NEUTRAL die: r11's first version printed "REFUSING" from every die, so ANY later die satisfied
    // the refusal assertion and deleting a guard left this test green (mutations R5a/R5b). Each case
    // below now names the message of the guard it is about.
    'die() { echo "DIE: $*" >&2; exit 1; }',
    `DATA_DIR=${JSON.stringify(dataDir)}`,
    fn,
    `chown_state_tree ${JSON.stringify(root)} "$(id -un)" locks "the state directory"`,
    'echo AFTER',
  ].join('\n')
  const ended = (out: Run, what: string, message: RegExp) => {
    assert.notEqual(out.status, 0, `${what}: must end the run:\n${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^AFTER$/m, `${what}: nothing after the refusal may run`)
    assert.match(out.stderr, message, `${what}: and it must be THIS guard that refused:\n${out.stderr}`)
    assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', `${what}: the target must be untouched`)
  }
  ended(withGuardLibrary(runningLib, program(app, data)), 'chown_state_tree asked for ${APP_DIR}', /re-owns .* and nothing else, and was asked for/)
  ended(withGuardLibrary(runningLib, program('/', data)), 'chown_state_tree asked for /', /re-owns .* and nothing else, and was asked for \//)
  // ${DATA_DIR} itself, when ${DATA_DIR} holds the running tree, is refused by the running-tree check.
  ended(withGuardLibrary(runningLib, program(base, base)), 'a ${DATA_DIR} that contains the running tree', /REFUSING to change the ownership of/)
  // The accepted path reaches the helper resolution that follows the guard (the full walk is measured
  // by install-root-safe-writes' section-8 rig, which runs this function end to end).
  const ok = withGuardLibrary(runningLib, `IMS_CHOWN_TREE_HELPER=/nonexistent/chown-tree.mjs\n${program(data, data)}`)
  assert.match(ok.stderr, /\/nonexistent\/chown-tree\.mjs is missing/, `the guard must let ${'${DATA_DIR}'} through to the next step:\n${ok.stderr}`)
})

test('[o3d-z5be] RUN-TIME GUARD in chown-tree.mjs: the walk refuses a directory its caller did not vet, `/` or a top-level directory, and its own tree', (t) => {
  const helper = join(REPO, 'scripts/lib/chown-tree.mjs')
  const walk = (cwd: string, env: Record<string, string>) => {
    const out = spawnSync('node', [helper, '.', String(process.getuid!()), String(process.getgid!()), 'locks'],
      { cwd, encoding: 'utf8', env: { ...process.env, IMS_CHOWN_TREE_ROOT: '', ...env } })
    return { status: out.status ?? -1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
  }
  const { app } = appTree(t)
  const data = join(createTempDirSync('runtime-guard-walk-', t), 'data')
  mkdirSync(join(data, 'sub'), { recursive: true })
  for (const [label, cwd, env] of [
    ['no vetted root at all', app, {}],
    ['a vetted root that is not where it is', app, { IMS_CHOWN_TREE_ROOT: data }],
    ['a `..` walk away from the vetted root', join(data, 'sub'), { IMS_CHOWN_TREE_ROOT: data }],
    ['/', '/', { IMS_CHOWN_TREE_ROOT: '/' }],
    ['a top-level directory', '/tmp', { IMS_CHOWN_TREE_ROOT: '/tmp' }],
    ['the directory the walker runs from', join(REPO, 'scripts/lib'), { IMS_CHOWN_TREE_ROOT: join(REPO, 'scripts/lib') }],
    ['a directory that contains it', join(REPO, 'scripts'), { IMS_CHOWN_TREE_ROOT: join(REPO, 'scripts') }],
  ] as const) {
    const out = walk(cwd, env)
    assert.equal(out.status, 1, `${label}: the walk must refuse and exit non-zero:\n${out.stderr}`)
    assert.match(out.stderr, /REFUSING/, `${label}: and say why:\n${out.stderr}`)
  }
  const ok = walk(data, { IMS_CHOWN_TREE_ROOT: data })
  assert.equal(ok.status, 0, `a vetted state directory must be walked:\n${ok.stderr}`)
})

test('[o3d-z5be] RUN-TIME GUARDS end the RUN from a subshell, a command substitution, a pipeline or a background job (r12, review M1)', (t) => {
  // `exit` in any of those leaves only the subshell, and every fence publication runs inside `$( … )`
  // (resolve_fence_script → db_fence_script_in_use), where update.sh's `resolve_fence_script || true`
  // then carried on. Each context below must end the whole program: AFTER never printed, the target
  // untouched, the status non-zero (SIGTERM to the top-level shell, whose EXIT trap runs).
  const dirs = scratch(t)
  const { app, victim } = appTree(t)
  const root = dirs.root
  const unwind = `driver_publish_unwind ${JSON.stringify(app)} "${root}/.p" "${root}/.r" "${root}/helpers" 0`
  const recovery = join(createTempDirSync('runtime-guard-ctx-', t), 'recovery')
  mkdirSync(recovery)
  const reaim: [string, string] = ['readonly DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"', `readonly DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(app)}`]
  const contexts = (cmd: string) => [
    ['a command substitution', `: "$(${cmd})"`],
    ['the update.sh shape: x="$(f)" || true', `f() { ${cmd}; }; x="$(f)" || true`],
    ['a subshell', `( ${cmd} ) || true`],
    ['a pipeline', `${cmd} | cat || true`],
    ['a background job', `${cmd} & wait || true`],
  ] as const
  for (const [label, program] of contexts(unwind)) {
    const out = run(dirs, `trap 'echo EXIT-TRAP' EXIT\n${program}\necho AFTER`)
    assert.notEqual(out.status, 0, `driver guard in ${label}: the run must end:\n${out.stdout}${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^AFTER$/m, `driver guard in ${label}: nothing after it may run:\n${out.stdout}`)
    assert.match(out.stdout, /^EXIT-TRAP$/m, `driver guard in ${label}: and the top-level EXIT trap runs, as for an operator's kill`)
    assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', `driver guard in ${label}: target untouched`)
  }
  for (const [label, program] of contexts('_fence_stage_and_publish')) {
    const out = withFenceLibrary(t, recovery, `trap 'echo EXIT-TRAP' EXIT\n${program}\necho AFTER`, reaim)
    assert.notEqual(out.status, 0, `fence guard in ${label}: the run must end:\n${out.stdout}${out.stderr}`)
    assert.doesNotMatch(out.stdout, /^AFTER$/m, `fence guard in ${label}: nothing after it may run:\n${out.stdout}`)
    assert.match(out.stdout, /^EXIT-TRAP$/m, `fence guard in ${label}: and the EXIT trap runs`)
    assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', `fence guard in ${label}: target untouched`)
  }
})

test('[o3d-z5be] RUN-TIME: an operation on a NAME is performed by the helper that checked it, so nothing can be done THROUGH the name (r13, review MED-1)', (t) => {
  // r12's `link` mode let a caller check `root/.version-x` — a symlink to ${APP_DIR} — as a name and
  // then run `rm -rf "$e/"`, `rm -rf "$e"/*` or `chmod -R 700 "$e"`, all of which follow it. The name
  // check is private now: driver_unlink_owned / driver_rename_owned / driver_link_owned perform their one
  // operation on exactly the name they checked, and the public check takes no mode.
  const dirs = scratch(t)
  const { app, victim } = appTree(t)
  const root = dirs.root
  const e = join(root, '.version-x')
  const plant = () => { rmSync(e, { force: true, recursive: false }); symlinkSync(app, e) }
  plant()
  for (const [label, program] of [
    ['the public check given a mode', `driver_require_owned_path ${JSON.stringify(e)} w link`],
    // …and given a mode on a path it would otherwise ACCEPT, so the arity rule is what refuses (r13
    // mutation N2: with the arity check removed, the case above still refused on canonicalisation).
    ['the public check given a mode on a real directory under the root', `mkdir -p ${JSON.stringify(join(root, '.legit'))}; driver_require_owned_path ${JSON.stringify(join(root, '.legit'))} w link`],
    ['the public (following) check on a link that leads to ${APP_DIR}, as `chmod -R` would need', `driver_require_owned_path ${JSON.stringify(e)} w`],
    ['an unlink of the name with a trailing slash', `driver_unlink_owned ${JSON.stringify(`${e}/`)} w`],
    ['an unlink of a path through the name', `driver_unlink_owned ${JSON.stringify(join(e, 'keep.txt'))} w`],
    ['a rename of a path through the name', `driver_rename_owned ${JSON.stringify(join(e, 'keep.txt'))} ${JSON.stringify(join(root, 'moved'))} w`],
    ['a rename onto a path through the name', `driver_rename_owned ${JSON.stringify(join(root, 'x'))} ${JSON.stringify(join(e, 'x'))} w`],
    ['a link created through the name', `driver_link_owned target ${JSON.stringify(join(e, 'x'))} w`],
  ] as const) {
    plant()
    assertRefusedAndEnded(run(dirs, `${program}\necho AFTER`), label, victim)
  }
  // The name itself is unlinked, and what it pointed at is untouched.
  plant()
  const ok = run(dirs, `driver_unlink_owned ${JSON.stringify(e)} w\necho AFTER`)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(lstatSync(e, { throwIfNoEntry: false }), undefined, 'the link is gone')
  assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', 'and the tree it pointed at is untouched')
})

test('[o3d-z5be] RUN-TIME: a refusal inside the EXIT trap does not cut the trap short (r13, review LOW-1c)', (t) => {
  // on_exit → refence_db_connections → $(resolve_fence_script) → … → _fence_stage_and_publish. r12's
  // refusal signalled the top-level shell from inside that substitution, and the trap — already running
  // — ended before it reported. A refusal made with on_exit/on_cutover_exit on the call stack now ends
  // only its own subshell (the operation still never runs) and the handler reports and finishes.
  const recovery = join(createTempDirSync('runtime-guard-trap-', t), 'recovery')
  mkdirSync(recovery)
  const { app, victim } = appTree(t)
  const reaim: [string, string] = ['readonly DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"', `readonly DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(app)}`]
  const handler = [
    'on_exit() {',
    '  local status=$?',
    '  if ! x="$(_fence_stage_and_publish)"; then echo "REPORTED: the fence could not be re-established"; fi',
    '  echo BANNER',
    '  exit "${status}"',
    '}',
  ].join('\n')
  // CONTROL: the identical body under ANY OTHER NAME is not exempt — the refusal ends the run there.
  const other = withFenceLibrary(t, recovery, `${handler.replace('on_exit() {', 'not_the_handler() {')}\ntrap 'exit 143' TERM\nnot_the_handler\necho AFTER`, reaim)
  assert.doesNotMatch(other.stdout, /^(REPORTED|BANNER|AFTER)/m, `outside the handler the refusal must end the run:\n${other.stdout}`)
  assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n')
  // The DRIVER path too: privileged_end_run, from a substitution inside on_exit.
  const dirs = scratch(t)
  const driverHandler = handler.replace('_fence_stage_and_publish', `driver_publish_unwind ${JSON.stringify(app)} "${dirs.root}/.p" "${dirs.root}/.r" "${dirs.root}/helpers" 0`)
  for (const term of ["trap 'exit 143' TERM", '']) {
    const out = run(dirs, `${driverHandler}\n${term}\ntrap on_exit EXIT\nexit 3`)
    assert.match(out.stdout, /^REPORTED: the fence could not be re-established$/m, `driver, ${term || 'TERM untrapped'}: the handler must report:\n${out.stdout}${out.stderr}`)
    assert.match(out.stdout, /^BANNER$/m, `driver, ${term || 'TERM untrapped'}: and finish`)
    assert.equal(out.status, 3)
    assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n')
  }
  for (const term of ["trap 'exit 143' TERM", '']) {
    const out = withFenceLibrary(t, recovery, `${handler}\n${term}\ntrap on_exit EXIT\nexit 3`, reaim)
    assert.match(out.stdout, /^REPORTED: the fence could not be re-established$/m, `${term || 'TERM untrapped'}: the handler must report:\n${out.stdout}${out.stderr}`)
    assert.match(out.stdout, /^BANNER$/m, `${term || 'TERM untrapped'}: and finish`)
    assert.equal(out.status, 3, `${term || 'TERM untrapped'}: with the run's own status`)
    assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', 'and the refused operation never ran')
  }
})

/** Every global a run-time guard consults, or that feeds a guarded path (r12, review H1). Each is
 *  readonly at load (IMS_DRIVER_*, DB_FENCE_*), cleared at load (_FENCE_OWNED_TMP,
 *  IMS_DRIVER_OVERLAP_EXTRA_IDS), set by the caller on the same line (IMS_CHOWN_TREE_ROOT), or bounded by
 *  the check itself (TMPDIR only locates a `tmp.XXXXXXXXXX` probe directory). */
const HOSTILE_GLOBALS = ['_FENCE_OWNED_TMP', 'DB_FENCE_RECOVERY_DIR',
  'DB_FENCE_PROTECTED_APP_DIR', 'IMS_DRIVER_ROOT', 'IMS_DRIVER_HELPER_DIR', 'IMS_DRIVER_PROGRAM_DIR', 'IMS_DRIVER_OVERLAP_EXTRA_IDS',
  'IMS_CHOWN_TREE_ROOT', 'TMPDIR']

test('[o3d-z5be] RUN-TIME GUARDS hold with every global they consult pre-set in the environment to a hostile value (r12, review H1)', (t) => {
  // r11's fence guard read _FENCE_OWNED_TMP, which nothing initialised: `_FENCE_OWNED_TMP=<the app's
  // parent>` widened it to the application tree and the re-aimed `rm -rf` RAN. The hostile value here
  // is exactly that: the parent of the stand-in ${APP_DIR}, a real directory owned by this uid.
  const { app, victim } = appTree(t)
  const hostile = join(app, '..')
  const dirs = scratch(t)
  const recovery = join(createTempDirSync('runtime-guard-env-', t), 'recovery')
  mkdirSync(recovery)
  const release = join(createTempDirSync('runtime-guard-env-rel-', t), 'release')
  const runningLib = join(release, 'scripts', 'lib')
  mkdirSync(runningLib, { recursive: true })
  const fn = shellFunction(INSTALL_SOURCE, 'chown_state_tree', 'scripts/install.sh')
  const reaim: [string, string] = ['readonly DB_FENCE_PROTECTED_APP_DIR="${DB_FENCE_RECOVERY_DIR}/app"', `readonly DB_FENCE_PROTECTED_APP_DIR=${JSON.stringify(app)}`]
  let cases = 0
  for (const name of HOSTILE_GLOBALS) {
    const env = { [name]: hostile }
    const results: Array<[string, Run]> = [
      ['driver_publish_unwind ${APP_DIR}', run(dirs, `driver_publish_unwind ${JSON.stringify(app)} "${dirs.root}/.p" "${dirs.root}/.r" "${dirs.root}/helpers" 0\necho AFTER`, env)],
      ['_fence_vendor_into ${APP_DIR}', withFenceLibrary(t, recovery, `_fence_vendor_into ${JSON.stringify(app)} ${JSON.stringify(app)}\necho AFTER`, undefined, env)],
      ['_fence_vendor_into ${APP_DIR} with it offered as the probe', withFenceLibrary(t, recovery, `_fence_vendor_into ${JSON.stringify(app)} ${JSON.stringify(app)} ${JSON.stringify(app)}\necho AFTER`, undefined, env)],
      ['_fence_stage_and_publish re-aimed at ${APP_DIR}', withFenceLibrary(t, recovery, '_fence_stage_and_publish\necho AFTER', reaim, env)],
      ['copy_tree_into_new_dir onto the running release', withGuardLibrary(runningLib, ['die() { echo "DIE: $*" >&2; exit 1; }', `source ${JSON.stringify(join(REPO, 'scripts/lib/cutover-namespace.sh'))}`, `copy_tree_into_new_dir ${JSON.stringify(app)} ${JSON.stringify(release)}`, 'echo AFTER'].join('\n'), env)],
      ['chown_state_tree ${APP_DIR}', withGuardLibrary(runningLib, ['die() { echo "DIE: $*" >&2; exit 1; }', `DATA_DIR=${JSON.stringify(join(release, '..', 'data'))}`, fn, `chown_state_tree ${JSON.stringify(app)} "$(id -un)" locks "the state directory"`, 'echo AFTER'].join('\n'), env)],
    ]
    const walk = spawnSync('node', [join(REPO, 'scripts/lib/chown-tree.mjs'), '.', String(process.getuid!()), String(process.getgid!()), 'locks'],
      { cwd: app, encoding: 'utf8', env: { ...process.env, IMS_CHOWN_TREE_ROOT: '', ...env } })
    results.push(['chown-tree.mjs in ${APP_DIR}', { status: walk.status ?? -1, stdout: walk.stdout ?? '', stderr: walk.stderr ?? '' }])
    for (const [label, out] of results) {
      assert.notEqual(out.status, 0, `${name}=${hostile}: ${label} must still be refused:\n${out.stdout}${out.stderr}`)
      assert.doesNotMatch(out.stdout, /^AFTER$/m, `${name}=${hostile}: ${label}: nothing after the refusal may run`)
      assert.equal(readFileSync(victim, 'utf8'), 'the application tree\n', `${name}=${hostile}: ${label}: the target must be untouched`)
      cases += 1
    }
  }
  assert.equal(cases, HOSTILE_GLOBALS.length * 7, 'precondition: every case ran for every name')
  // And each library does clear or fix the names at load, so the list above is not merely what happened
  // to be tried: a name the guards read must be one of these forms.
  assert.match(readFileSync(join(REPO, FENCE_LIB_REL), 'utf8'), /^unset -v _FENCE_OWNED_TMP$/m, 'the fence library clears the name r11 read')
  // AND THE SHARED OWNERSHIP DECISION LEAVES NO SCRIPT-SCOPE NAME AT ALL (o3d-xi3w): _priv_path_inside_root
  // and _priv_name_inside_root PRINT `<fault>|<canonical path>|<canonical root>` and every caller takes
  // that into a `local` of the frame that refuses, so there is nothing here for an inherited value to
  // steer. A draft that reported through globals is what the declaration census in
  // install-root-safe-writes.test.ts rejected: a value a `case` branches on is a decision, not a report.
  for (const fn of ['_priv_path_inside_root', '_priv_name_inside_root']) {
    const body = shellFunction(readFileSync(join(REPO, FENCE_LIB_REL), 'utf8'), fn, FENCE_LIB_REL)
    assert.match(body, /^\s*printf '(?:inside|outside|absolute|dotdot|canon)\|/m, `${fn}() must print its answer`)
    const declared = new Set((/^\s*local ([^\n]*)$/m.exec(body)?.[1] ?? '').split(/\s+/).map((w) => w.split('=')[0]))
    assert.ok(declared.size > 2, `precondition: ${fn}() declares its locals on one line`)
    const assigned = [...body.matchAll(/(?:^|[\s;(])([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1])
      .filter((name) => !declared.has(name) && name !== 'local')
    assert.deepEqual(assigned, [], `${fn}() must assign nothing but its own locals, and assigns: ${assigned.join(', ')}`)
  }
  assert.match(LIB_SOURCE, /^IMS_DRIVER_OVERLAP_EXTRA_IDS=""$/m, 'privileged-helpers clears its one non-readonly input')
})

test('[o3d-z5be] the comment lexer agrees with BASH about which lines are comments (r12, review M3)', (t) => {
  // r11's lexer read `$'\''` as a closed single quote and fell out of step with bash for the rest of the
  // file, so a `#` line inside a `bash -c '…'` payload was exempted while bash executed it. ANSI-C quoting
  // is handled now, and this checks the whole lexer against bash itself: every line it calls a comment is
  // replaced by a marker comment, and `bash --pretty-print` (which drops comments and keeps strings and
  // here-documents) must print none of the markers — and must still parse the file. A marker that
  // survives, or a parse that breaks, is a line the lexer called a comment and bash did not.
  const probe = spawnSync('bash', ['--pretty-print', '/dev/null'], { encoding: 'utf8' })
  assert.equal(probe.status, 0, 'bash --pretty-print (bash 5.2+) is required for this check')
  const work = createTempDirSync('lexer-vs-bash-', t)
  const check = (label: string, src: string, strict: boolean) => {
    const set = commentLines(src, strict)
    const marked = src.split('\n').map((l, k) => (set.has(k + 1) ? `${(/^(\s*)/.exec(l) ?? ['', ''])[1]}# IMS_LEXER_COMMENT_${k + 1}` : l)).join('\n')
    const file = join(work, 'marked.sh')
    writeFileSync(file, marked)
    const out = spawnSync('bash', ['--pretty-print', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { set, status: out.status, leaked: [...(out.stdout ?? '').matchAll(/IMS_LEXER_COMMENT_(\d+)/g)].map((m) => Number(m[1])), label }
  }
  for (const rel of [...ENTRYPOINTS, ...SOURCED_LIBS]) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    for (const strict of [false, true]) {
      const r = check(rel, src, strict)
      assert.ok(r.set.size > 20, `precondition: ${rel} has ${r.set.size} comment lines`)
      assert.equal(r.status, 0, `${rel}: replacing the lexer's comment lines changed how bash parses the file`)
      assert.deepEqual(r.leaked, [], `${rel}: the lexer called these lines comments and bash keeps them: ${r.leaked.join(', ')}`)
    }
  }
  // THE REVIEWER'S SHAPE, and a control proving this check can fail: the same file with the line marked
  // as a comment BY HAND leaks the marker.
  const shape = ": $'\\'\"'\nbash -c 'x=\"\n#\"; chown -R imsapp /data'\n"
  assert.ok(!commentLines(shape).has(3) && !commentLines(shape, true).has(3), 'the executing line after $\'\\\'\' is not a comment')
  assert.deepEqual(backstopHits(shape).map((h) => h.n), [3], 'and the backstop reads it')
  // CONTROLS, proving both failure signals of this check can fire: a data line inside a string marked as
  // a comment by hand LEAKS the marker; the reviewer's executing line marked by hand BREAKS the parse.
  writeFileSync(join(work, 'leak.sh'), 'msg="a\n# IMS_LEXER_COMMENT_2\n"\n')
  const leak = spawnSync('bash', ['--pretty-print', join(work, 'leak.sh')], { encoding: 'utf8' })
  assert.match(leak.stdout ?? '', /IMS_LEXER_COMMENT_2/, 'control: a line wrongly called a comment leaks through bash')
  writeFileSync(join(work, 'forced.sh'), shape.split('\n').map((l, k) => (k === 2 ? '# IMS_LEXER_COMMENT_3' : l)).join('\n'))
  const forced = spawnSync('bash', ['--pretty-print', join(work, 'forced.sh')], { encoding: 'utf8' })
  assert.ok(forced.status !== 0 || /IMS_LEXER_COMMENT_3/.test(forced.stdout ?? ''), 'control: the reviewer\'s line marked as a comment is detected')
})

type AllowEntry = { file: string; line: string; count: number; class: string; reason: string; guard?: string }
const ALLOWLIST_REL = 'tests/scripts/privileged-word-allowlist.json'
const ALLOW_CLASSES = new Set(['text', 'comment', 'single-inode', 'read-only', 'code-owned-tree', 'census-helper', 'definition', 'app-user'])
/** THE RUN-TIME GUARDS an allowlist entry of a tree-changing class must be protected by (r11). The
 *  allowlist is text; it cannot bind a variable's VALUE (review M2). These functions check the value, at
 *  the operation, and exit on a path outside what the code owns. */
const RUNTIME_GUARDS = new Set(['driver_require_owned_path', '_driver_owned_name', '_fence_require_owned_tree', '_fence_owned_name', 'privileged_spare_running_tree'])
/** The guards that check a NAME and do not follow a final symbolic link (o3d-xi3w added the fence's, which
 *  the artefact's pointer flip needs). They cover the name ALONE — never a path under it — and only for an
 *  operation that acts on the name itself: rm, mv, ln. */
const NAME_GUARDS = new Set(['_driver_owned_name', '_fence_owned_name'])
/** The first variable a word refers to: `"${staged}/${relative}"` → `staged`. */
function firstVariable(word: string): string | null {
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/.exec(word)
  return m ? (m[1] ?? m[2]) : null
}
/** The operand WORDS naming what a tree-changing statement ACTS ON: every operand of rm and mv, the last
 *  operand of cp, rsync, chown, chmod, chgrp. Flags and a leading mode/owner are not operands. */
function operandWords(statement: string): string[] {
  const out: string[] = []
  for (const words of shellCommands(statement)) {
    const { name, args } = commandName(words.filter((w) => !/^[0-9]*[<>]/.test(w)))
    const operands = args.filter((a) => !/^-/.test(a))
    if (name === 'rm' || name === 'mv') out.push(...operands)
    else if (['cp', 'rsync', 'chown', 'chmod', 'chgrp', 'ln'].includes(name)) out.push(...operands.slice(-1))
  }
  return out
}
/** The function (by line range) that encloses physical line `n`, or null at top level. */
function enclosingFunction(source: string, n: number): { name: string; start: number; end: number } | null {
  const lines = source.split('\n')
  let found: { name: string; start: number; end: number } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const head = new RegExp(`^${DEFINITION_HEAD}\\s*\\{\\s*$`).exec(lines[i])
    if (!head) continue
    let end = i + 1
    while (end < lines.length && !/^\}/.test(lines[end])) end += 1
    if (i + 1 <= n && n <= end + 1) found = { name: head[1] ?? head[2], start: i + 1, end: end + 1 }
  }
  return found
}
/** The allowlist matches a WHOLE statement EXACTLY. A substring or prefix match would let
 *  `<an allowlisted line> ; chown imsapp "${APP_DIR}"/*` through on the strength of its first half. */
function allowlisted(entries: readonly AllowEntry[], file: string, line: string): AllowEntry | undefined {
  return entries.find((entry) => entry.file === file && entry.line === line)
}

test('[o3d-z5be] LEXICAL BACKSTOP: in the entrypoints and the libraries they source, a statement that spells a word on its fixed list is wholly census rows or an exact-text allowlist entry', () => {
  // WHY THIS EXISTS (o3d-z5be r10). Nine review rounds each found a shape the census tokeniser could not
  // read — the ninth was the house's own `run chown -R …`. The census is a classifier over the shapes it
  // can parse; THIS is what does not depend on parsing. A line that spells `chown` — in a heredoc, after
  // a redirect, behind `flock`, `doas`, `bash -ec`, an alias or a wrapper nobody taught the tokeniser —
  // is found because the word is there, and fails the test until somebody decides what it is. A false
  // positive fails loudly, which is the right way for this to fail. It is a FIXED WORD LIST keyed by TEXT:
  // it does not see a name never spelled out (computed or brace-built), a command not on the list, or a
  // variable whose value changes under an allowlisted line — so the tree-changing entries are bound to
  // run-time guards below, which check the value when it runs (r11, review M2/H3).
  const allow: AllowEntry[] = JSON.parse(readFileSync(join(REPO, ALLOWLIST_REL), 'utf8')).entries
  for (const entry of allow) {
    assert.ok(ALLOW_CLASSES.has(entry.class), `${entry.file}: unknown class ${entry.class} for: ${entry.line}`)
    assert.ok(entry.reason.trim().length >= 20, `${entry.file}: each entry needs a written reason: ${entry.line}`)
    assert.ok(Number.isInteger(entry.count) && entry.count >= 1, `${entry.file}: count must be a positive integer: ${entry.line}`)
  }
  assert.equal(new Set(allow.map((e) => `${e.file}\n${e.line}`)).size, allow.length, 'each statement is listed once, with its count')

  // THE FILES: the three entrypoints and EVERY library they source — asserted against their text, so a
  // new `source` is a decision here. The one other file read, `. /etc/os-release`, is the host's.
  // WHAT IS SOURCED IS READ FROM THE TOKENISER'S COMMANDS, not from a line-start regex (r11, review L2):
  // `builtin source …`, `command . …` and a `source` after `;` all count, in the libraries as well.
  for (const rel of [...ENTRYPOINTS, ...SOURCED_LIBS]) {
    const text = readFileSync(join(REPO, rel), 'utf8')
    const sourced: string[] = []
    for (const line of logicalLines(text)) {
      for (const words of shellCommands(line.text)) {
        const { name, args } = commandName(words)
        if (name === 'source' || name === '.') sourced.push(args[0] ?? '')
      }
    }
    const libs = sourced.filter((f) => f.startsWith('${IMS_SCRIPT_LIB_DIR}/')).map((f) => `scripts/lib/${f.slice('${IMS_SCRIPT_LIB_DIR}/'.length)}`)
    const others = sourced.filter((f) => !f.startsWith('${IMS_SCRIPT_LIB_DIR}/'))
    if ((ENTRYPOINTS as readonly string[]).includes(rel)) {
      assert.deepEqual([...libs].sort(), [...SOURCED_LIBS].sort(), `${rel} must source exactly the libraries this backstop reads`)
    } else {
      assert.deepEqual(libs, [], `${rel}: a library must not source another file this backstop does not read`)
    }
    assert.ok(others.every((f) => f === '/etc/os-release'), `${rel}: an unexpected sourced file: ${others.join(', ')}`)
  }
  const files = [...ENTRYPOINTS, ...SOURCED_LIBS]
  const unaccounted: string[] = []
  const occurrences = new Map<string, number>()
  let statements = 0
  let censusRows = 0
  for (const rel of files) {
    const source = readFileSync(join(REPO, rel), 'utf8')
    // CREDIT IS PER STATEMENT (r11, review H2): a group is the census's only when EVERY statement in it
    // that spells a privileged word is itself a census row. `chown_state_tree …; chown -R … /etc/x`
    // is a census row followed by a statement that stands on its own, and so needs its own decision.
    const censusStatements = new Set<string>()
    if ((ENTRYPOINTS as readonly string[]).includes(rel)) {
      for (const op of censusOps(source)) censusStatements.add(`${op.n}\n${op.text}`)
    }
    for (const hit of backstopHits(source)) {
      statements += 1
      const spelled = statementsOf(hit.text).filter((st) => privilegedWords(st).length > 0)
      if (spelled.length > 0 && spelled.every((st) => censusStatements.has(`${hit.n}\n${st}`))) { censusRows += 1; continue }
      const entry = allowlisted(allow, rel, hit.line)
      if (!entry) { unaccounted.push(`${rel}:${hit.n} [${hit.words.join(',')}] ${hit.line}`); continue }
      const key = `${entry.file}\n${entry.line}`
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
    }
  }
  assert.deepEqual(unaccounted, [], `these statements spell a privileged command word and are neither a census row nor an exact allowlist entry (${ALLOWLIST_REL}):\n${unaccounted.join('\n')}`)
  // A COPY OF AN ALLOWLISTED LINE IS A NEW STATEMENT: the counts must match, and an entry that matches
  // nothing any more is stale and fails too.
  for (const entry of allow) {
    assert.equal(occurrences.get(`${entry.file}\n${entry.line}`) ?? 0, entry.count, `${entry.file}: expected ${entry.count} occurrence(s) of: ${entry.line}`)
  }
  // A TREE-CHANGING ENTRY IS BOUND TO ITS RUN-TIME GUARD (r11, review H3/M2). Every `code-owned-tree`
  // and `census-helper` entry names the guard that checks its path's VALUE at the operation, and at
  // every occurrence that guard must be CALLED earlier in the same function (or on the same line). A
  // new such entry without a guard fails here, and so does deleting a guard call.
  let guardedOccurrences = 0
  let operandChecks = 0
  for (const entry of allow.filter((e) => e.class === 'code-owned-tree' || e.class === 'census-helper')) {
    assert.ok(entry.guard && RUNTIME_GUARDS.has(entry.guard), `${entry.file}: a ${entry.class} entry must name its run-time guard: ${entry.line}`)
    assert.match(entry.reason, new RegExp(`enforced at run time by ${entry.guard}`), `${entry.file}: and say so in its reason: ${entry.line}`)
    const source = readFileSync(join(REPO, entry.file), 'utf8')
    const lines = source.split('\n')
    for (const hit of backstopHits(source).filter((h) => h.line === entry.line)) {
      const fn = enclosingFunction(source, hit.n)
      assert.ok(fn, `${entry.file}:${hit.n}: a guarded operation must be inside a function: ${entry.line}`)
      // THE GUARD MUST CHECK *THIS* OPERATION'S OPERAND, AND BE A CALL THAT REALLY HAPPENS FIRST. A TEXTUAL
      // rule (r11 R15; r12 after X1–X7; r13 after the review of 6ae8c48a, MED-1/MED-2):
      //   1. the guard is a PLAIN statement: its line starts with the guard's name, or it opens a
      //      `{ guard …; op; }` group — not `( guard …)`, `: "$(guard …)"`, `x || guard`, or backgrounded;
      //   2. it is in the function body or in a block that ENCLOSES the operation, by the shell's own
      //      block structure (blockPaths), not by indentation;
      //   3. it is called with its own arity — driver_require_owned_path takes exactly (path, what): r12's
      //      third `link` argument let a caller check a name and act THROUGH it;
      //   4. its argument is exactly `${NAME}`; the operand is exactly `${NAME}`, or `${NAME}/…` only for
      //      a guard that canonicalises the whole path — a name check (_driver_owned_name) covers the
      //      name alone, and only for rm/mv/ln — and no parameter operator (`${NAME%/*}` is the PARENT);
      //   5. NAME is not reassigned between them (`=`, `+=`, `NAME[…]=`, `printf -v`, `read`, `mapfile`,
      //      `local/declare/typeset/readonly/export`, `for … in`, `unset`, any `eval`), and no nameref to
      //      NAME is declared anywhere in the function.
      // The run-time check is the guarantee; this keeps the calls to it where they do their job.
      const bodyText = lines.slice(fn!.start, hit.n).join('\n')
      const region = logicalLines(bodyText)
        .flatMap((l) => statementsOf(l.text, true).map((rawStatement) => ({ n: fn!.start + l.n, rawStatement, line: l.text })))
      const paths = blockPaths(region.map((r) => r.rawStatement))
      const statements = region.map((r, k) => ({ ...r, k, path: paths[k], statement: statementsOf(r.rawStatement)[0] ?? '' }))
      const opIndex = statements.filter((r) => r.n === hit.n && privilegedWords(r.statement).length > 0)
      const arity = entry.guard === 'driver_require_owned_path' || entry.guard === '_driver_owned_name' ? [2] : entry.guard === '_fence_require_owned_tree' ? [2, 3] : [2]
      const plainGuard = (r: { statement: string; line: string }) => {
        const words = shellCommands(r.statement)[0] ?? []
        if (commandName(words).name !== entry.guard || words[0] !== entry.guard) return false
        if (!arity.includes(words.length - 1)) return false
        const text = r.line.trim()
        if (/&\s*$/.test(text) || /[^&>|]&[^&>]/.test(text.replace(/"[^"]*"/g, '""'))) return false
        return text.startsWith(`${entry.guard} `) || new RegExp(`\\{ ${entry.guard} `).test(text)
      }
      const guardCalls = statements.filter(plainGuard)
      assert.ok(guardCalls.length > 0, `${entry.file}:${hit.n}: ${fn!.name} must call ${entry.guard}, as a plain statement with its own arity, before: ${entry.line}`)
      const fnText = lines.slice(fn!.start, fn!.end).join('\n')
      for (const op of opIndex) {
        const opName = commandName(shellCommands(op.statement)[0] ?? []).name
        if (NAME_GUARDS.has(entry.guard!)) {
          assert.ok(['rm', 'mv', 'ln'].includes(opName), `${entry.file}:${hit.n}: a name check covers only rm, mv and ln, not: ${op.statement}`)
        }
        for (const operand of operandWords(op.statement)) {
          const name = firstVariable(operand)
          if (!name) continue
          const suffix = NAME_GUARDS.has(entry.guard!) ? '' : '(?:/.*)?'
          assert.match(operand, new RegExp(`^\\$(?:\\{${name}\\}|${name})${suffix}$`),
            `${entry.file}:${hit.n}: the operand ${operand} is not exactly what ${entry.guard} checked (\${${name}}${suffix ? ' or a path under it' : ''}): ${op.statement}`)
          const checks = guardCalls.filter((g) => g.k < op.k
            && g.path.length <= op.path.length && g.path.every((id, i) => op.path[i] === id)
            && new RegExp(`^\\$(?:\\{${name}\\}|${name})$`).test(commandName(shellCommands(g.statement)[0] ?? []).args[0] ?? ''))
          assert.ok(checks.length > 0, `${entry.file}:${hit.n}: ${entry.guard} must be called on exactly \${${name}}, in a block enclosing the operation, before: ${op.statement}`)
          const last = checks[checks.length - 1]
          const reassign = new RegExp(`(^|[\\s;(])${name}(\\[[^\\]]*\\])?\\+?=|\\bprintf\\s+(?:-[A-Za-z]+\\s+)*-v\\s+${name}\\b|\\bread\\b[^;]*\\b${name}\\b|\\b(?:mapfile|readarray)\\b[^;]*\\b${name}\\b|\\b(?:local|declare|typeset|readonly|export)\\b[^;]*\\b${name}\\b|\\bfor\\s+${name}\\s+in\\b|\\bunset\\b[^;]*\\b${name}\\b|\\beval\\b`)
          const reassigned = statements.slice(last.k + 1, op.k).find((r) => reassign.test(r.rawStatement))
          assert.equal(reassigned, undefined, `${entry.file}:${hit.n}: \${${name}} may be reassigned (${reassigned?.rawStatement}) after its check and before: ${op.statement}`)
          const nameref = new RegExp(`\\b(?:local|declare|typeset)\\b[^;\\n]*\\s-[A-Za-z]*n[A-Za-z]*\\s+[^;\\n]*=\\s*["']?${name}\\b`)
          assert.ok(!nameref.test(fnText), `${entry.file}:${hit.n}: ${fn!.name} declares a nameref to \${${name}}, so no textual check can see its assignments`)
          operandChecks += 1
        }
      }
      guardedOccurrences += 1
    }
  }
  assert.ok(guardedOccurrences >= 30, `precondition: ${guardedOccurrences} guarded occurrences were checked`)
  assert.ok(operandChecks >= 30, `precondition: ${operandChecks} operands were bound to a guard call on themselves`)
  console.log(`# backstop: ${guardedOccurrences} guarded occurrences, ${operandChecks} operand bindings`)

  // AND EVERY HOUSE PROGRAM THAT CHANGES A FILESYSTEM IS A BACKSTOP WORD (r11, review H4): enumerated
  // from scripts/lib, not remembered.
  const programs = readdirSync(join(REPO, 'scripts/lib')).filter((f) => /\.(mjs|js|cjs|py)$/.test(f))
  assert.ok(programs.length >= 3, `precondition: ${programs.length} programs in scripts/lib`)
  for (const program of programs) {
    const text = readFileSync(join(REPO, 'scripts/lib', program), 'utf8')
    if (/\b(?:l?chownSync|fchownSync|rmSync|rmdirSync|unlinkSync|renameSync|cpSync|chmodSync|fchmodSync|lchmodSync)\b|shutil\.(?:rmtree|chown|move)/.test(text)) {
      const name = program.replace(/\.[^.]+$/, '')
      assert.ok(BACKSTOP_HELPERS.includes(name), `scripts/lib/${program} changes the filesystem and must be a backstop word`)
    }
  }

  // docs/installation.md says deploy.sh's own text makes no tree-wide change: that is enforced here.
  assert.deepEqual([...new Set(allow.filter((e) => e.file === 'scripts/deploy.sh').map((e) => e.class))].sort(), ['comment', 'read-only', 'single-inode', 'text'],
    'deploy.sh may carry only comment, single-inode, read-only and text entries')
  // NON-VACUITY: it read the files, and the census rows it credited are the census's.
  assert.ok(statements > 300, `precondition: the backstop found ${statements} statements`)
  assert.ok(censusRows >= 20, `precondition: ${censusRows} of them are credited wholly to census rows`)

  // THE MATCH IS EXACT (mutation (c)): the first half of a line being allowlisted is not enough.
  const sample = allow.find((e) => e.line === 'rm -f "${CRON_BACKUP}"')!
  assert.ok(sample, 'precondition: the sample entry exists')
  assert.ok(allowlisted(allow, sample.file, sample.line), 'the entry matches its own line')
  for (const extended of [`${sample.line} ; chown imsapp "\${APP_DIR}"/*`, ` ${sample.line}x`, sample.line.slice(0, -1)]) {
    assert.equal(allowlisted(allow, sample.file, extended), undefined, `a line that merely CONTAINS an allowlisted one is not allowlisted: ${extended}`)
  }

  // WHAT IT SEES THAT THE CENSUS DOES NOT (review of c60997d8: H1, M1, M3, M4): the shapes the reviewer
  // injected in which the word is spelled out, as listed in that review. The census does not classify
  // most of them; the backstop needs only the word.
  for (const shape of [
    'run chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"',
    'capture out chown -R "${APP_USER}" "${APP_DIR}"',
    'bash -ec \'chown -R imsapp "${APP_DIR}"\'',
    'sh -euc "chown -R imsapp ${APP_DIR}"',
    'su --command="chown -R imsapp ${APP_DIR}" root',
    'flock /run/x chown -R imsapp "${APP_DIR}"',
    'systemd-run chown -R imsapp "${APP_DIR}"',
    'doas chown -R imsapp "${APP_DIR}"',
    'timeout -s KILL 30 chown -R imsapp "${APP_DIR}"',
    'env -u HOME chown -R imsapp "${APP_DIR}"',
    '2>/dev/null chown -R imsapp "${APP_DIR}"',
    'alias co=chown',
    'find "${APP_DIR}" | while read -r f; do chown -h imsapp "$f"; done',
    'for f in "${APP_DIR}"/*; do chown -h imsapp "$f"; done',
    'chown imsapp "${APP_DIR}"/*',
    'CH=${CH:-chown}',
    'printf -v c \'%s\' chown',
    'ch\\own -R imsapp "${APP_DIR}"',
    'c"h"own -R imsapp "${APP_DIR}"',
    'git -C "${APP_DIR}" clean -ffdx',
    'git -C "${APP_DIR}" checkout -f main',
    'bash -xc "chown -R imsapp ${APP_DIR}"',
    'su --command "chown -R imsapp ${APP_DIR}" root',
    'nsenter -t 1 -m chown -R imsapp "${APP_DIR}"',
    'unshare -m chown -R imsapp "${APP_DIR}"',
    'chroot / chown -R imsapp "${APP_DIR}"',
    'setpriv --reuid=0 chown -R imsapp "${APP_DIR}"',
    'busybox chown -R imsapp "${APP_DIR}"',
    'parallel chown -R imsapp ::: "${APP_DIR}"',
    'watch -n1 chown -R imsapp "${APP_DIR}"',
    'coproc chown -R imsapp "${APP_DIR}"',
    'time -p chown -R imsapp "${APP_DIR}"',
    'exec -a x chown -R imsapp "${APP_DIR}"',
    'sudo -s chown -R imsapp "${APP_DIR}"',
    'timeout 1.5 chown -R imsapp "${APP_DIR}"',
    'sudo -C 3 -D / -r role -t type chown -R imsapp "${APP_DIR}"',
    'shopt -s expand_aliases; alias co="chown -R"; co imsapp "${APP_DIR}"',
    'source ./fix.sh && chown -R imsapp "${APP_DIR}"',
    'x="$(echo \')\'; chown -R imsapp "${APP_DIR}")"',
    'x="$(case a in a) chown -R imsapp "${APP_DIR}";; esac)"',
    'shopt -s globstar; chown imsapp "${APP_DIR}"/**',
    'as_app_user bash -c "chown -R imsapp ${APP_DIR}"',
    'run_as_user root chown -R imsapp "${APP_DIR}"',
  ]) assert.ok(privilegedWords(shape).length > 0, `the backstop must see: ${shape}`)
  // A here-document fed to a shell is seen line by line, because its body lines are physical lines.
  assert.deepEqual(backstopHits("bash <<'EOF'\nchown -R imsapp x\nEOF\n").map((h) => h.words), [['chown']], 'a here-document body is read')
  assert.deepEqual(backstopHits('ch\\\nown -R imsapp "${APP_DIR}"\n').map((h) => h.words), [['chown']], 'a name split across a continuation is seen')
  // r11 (review of fddd872c, M1/H4): the fixed list's measured gaps, and the house's own walker.
  for (const shape of [
    'bsdtar -xpf release.tar -C "${APP_DIR}"',
    'scp -rp src/. "${APP_DIR}/"',
    'python3 -c \'import shutil,sys; shutil.rmtree(sys.argv[1])\' "${APP_DIR}"',
    'git -C "${APP_DIR}" read-tree -u --reset HEAD',
    'git -C "${APP_DIR}" stash push --include-untracked',
    'chattr -R +i "${APP_DIR}"',
    'chcon -R -t x "${APP_DIR}"',
    '( cd "${APP_DIR}" && node "$(privileged_helper_path chown-tree.mjs)" . 1000 1000 "" )',
  ]) assert.ok(privilegedWords(shape).length > 0, `the backstop must see: ${shape}`)
  // H1: a `#` line is exempt only as a comment in CODE. Inside a multi-line string or an unquoted
  // here-document body it is data, and the `$( … )` on it runs; the strict rule never exempts a line
  // carrying `$(` or a backtick at all.
  const inString = 'msg="synced\n#$(chown -R "${APP_USER}" "${DATA_DIR}")"\n'
  const inHeredoc = 'cat >/dev/null <<EOF\n#$(rm -rf "${DATA_DIR}")\nEOF\n'
  const inBackticks = 'msg="synced\n#`chown -R imsapp x`"\n'
  for (const [label, src] of [['a string', inString], ['a here-document', inHeredoc], ['a string, with backticks', inBackticks]] as const) {
    assert.ok(!commentLines(src).has(2) && !commentLines(src, true).has(2), `a # line inside ${label} is not a comment`)
    assert.ok(backstopHits(src).some((h) => h.n === 2), `and the backstop reads it (${label})`)
  }
  assert.ok(commentLines('# a real comment about chown -R\n').has(1), 'a real comment is a comment')
  assert.ok(!commentLines('# quotes `chown -R` in backticks\n', true).has(1), 'but the strict rule reads it anyway')
  // H2: a statement appended to a census row is its own statement, classified and credited alone.
  assert.deepEqual(statementsOf('chown_state_tree "${DATA_DIR}" a b c; chown -R x /etc/x'), ['chown_state_tree "${DATA_DIR}" a b c', 'chown -R x /etc/x'])
  assert.deepEqual(statementsOf('if ! mv -f "$tmp" "$t" 2>/dev/null; then rm -f "$tmp"; exit 1; fi'), ['mv -f "$tmp" "$t" 2>/dev/null', 'rm -f "$tmp"', 'exit 1'])
  assert.deepEqual(statementsOf('a 2>&1 | b >&2 && c &>/dev/null || d'), ['a 2>&1', 'b >&2', 'c &>/dev/null', 'd'])
  assert.deepEqual(censusOps('migrate_uploads "a" "b"; chown -R imsapp /var/lib/postgresql\n').map((op) => op.text), ['chown -R imsapp /var/lib/postgresql'],
    'the appended chown is a census row of its own')
  // AND WHAT IT CANNOT: a name never spelled out. These are the concession, asserted so it stays exact.
  for (const unseen of ['c=ch; ${c}own -R imsapp "${APP_DIR}"', 'ch$()own -R imsapp "${APP_DIR}"', "$'\\x63hown' -R imsapp x", 'CMD=(ch own); "${CMD[0]}${CMD[1]}" -R x', 'r{m,m} -rf "${DATA_DIR}"', 'dd if=/dev/zero of="${APP_DIR}/x"']) {
    assert.deepEqual(privilegedWords(unseen), [], `stated as NOT seen — update the concession if this changes: ${unseen}`)
  }
})

test('[o3d-z5be] install.sh asks the same question at configuration time, before any package is installed and before the account exists', () => {
  // review HIGH 2.1: nothing tested this gate, while the documentation asserted its position. It is an
  // EARLY REFUSAL — the property is carried by the per-operation guards — but "runs before apt-get and
  // before useradd" is a claim about statement order, so it is asserted as one.
  // THIS IS TEXT ORDER, NOT EXECUTION ORDER (r9, review LOW 9), and deliberately so: it does not run the
  // gate, so a legitimate reordering that keeps the property would fail it and have to be re-argued
  // here. That direction is the safe one; the direction that matters — does the guard actually refuse —
  // is measured by execution in the withGuardLibrary tests above.
  const source = ENTRYPOINT_SOURCE.get('scripts/install.sh')!
  const code = codeLines(source).filter((line) => line.text.trim() !== '')
  const at = (re: RegExp) => {
    const hit = code.find((line) => re.test(line.text))
    assert.ok(hit, `scripts/install.sh must contain ${re}`)
    return hit!.n
  }
  const gate = at(/^for IMS_OVERLAP_NAME in APP_DIR DATA_DIR LOG_DIR; do$/)
  const call = at(/^  privileged_spare_running_tree "\$\{!IMS_OVERLAP_NAME\}" "\$\{IMS_OVERLAP_WHAT\}" \|\| die/)
  const localSource = at(/^  privileged_trees_disjoint "\$\{LOCAL_SOURCE_DIR\}" "\$\{APP_DIR\}" /)
  const apt = at(/^apt-get install -y -qq/)
  const useradd = at(/^  useradd --system --shell \/bin\/bash --home-dir/)
  assert.ok(gate < apt, `the configuration-time gate (line ${gate}) must precede apt-get install (line ${apt})`)
  assert.ok(gate < useradd, `and useradd --create-home (line ${useradd})`)
  assert.ok(localSource < apt, `and the LOCAL_SOURCE_DIR check (line ${localSource}) must precede apt-get install`)
  assert.ok(call > gate && call < gate + 10, 'the loop must call the guard')
  // ALL THREE DIRECTORIES, by name: dropping one from the list is the regression this test exists for.
  for (const name of ['APP_DIR', 'DATA_DIR', 'LOG_DIR']) {
    assert.match(code[code.findIndex((line) => line.n === gate)].text, new RegExp(`\\b${name}\\b`), `the gate must cover ${name}`)
    assert.ok(code.some((line) => line.n > gate && line.n < gate + 8 && line.text.includes(`${name})`)),
      `and describe ${name} in its case`)
  }
  // AND THE DOCUMENTATION MUST NOT PROMISE MORE THAN IT DOES (review HIGH 2.2): on a first install those
  // three directories do not exist, so the gate can only compare against their nearest existing ancestor.
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  assert.match(doc, /That is an \*\*early refusal\*\*/, 'the page must call it an early refusal')
  assert.match(doc, /nearest existing ancestor/, 'and say what it can compare against on a first install')
  assert.ok(!doc.includes('Because that gate covers the whole run, it holds for operations no list enumerates'),
    'and must not claim the gate covers the whole run')
  // AND NO FILE MAY STILL CLAIM THE CENSUS IS UNIVERSAL (review HIGH 2, third part). CASE-INSENSITIVE
  // AND OVER ALL SIX FILES THAT INSTRUCT AN OPERATOR (r9, review LOW 1/2): r8 read three of them and
  // compared case-sensitively, forty lines above the relabel sweep that is deliberately case-insensitive
  // BECAUSE one capital letter defeated r6's version — the same shape, repeated. r8 also carried a
  // phrase that appears in NO commit of this branch (review LOW 3): an entry that cannot fail, counted
  // in a report as a sentence fixed. Every entry below was the literal text of a shipped file at
  // b68706c4 or earlier, and the positive control underneath proves the sweep can still fail.
  const universality = [
    'THE CALL EVERY RECURSIVE OWNERSHIP CHANGE, COPY OR DELETE IN AN ENTRYPOINT IS PRECEDED BY',
    'asked before every recursive ownership change, recursive copy',
    'the census in tests/scripts/privileged-helper-set.test.ts holds\n# every recursive operation to',
    'MOVE OR DELETE THE CENSUS KNOWS ABOUT: it refuses when',
    'delete**, in all three entrypoints: the target and the directory the running script lives in',
    'AS WELL AS AT EACH OPERATION BELOW',
    'hold every such statement to the same rule',
  ]
  const sweptFiles: Array<[string, string]> = [
    [LIB_REL, LIB_SOURCE],
    [FENCE_LIB_REL, readFileSync(join(REPO, FENCE_LIB_REL), 'utf8')],
    ['docs/installation.md', doc],
    ...ENTRYPOINTS.map((rel) => [rel, ENTRYPOINT_SOURCE.get(rel)!] as [string, string]),
  ]
  assert.equal(sweptFiles.length, 6, 'precondition: every file that could carry such a claim was read')
  for (const [where, text] of sweptFiles) {
    const lowered = text.toLowerCase()
    for (const stale of universality) {
      assert.ok(!lowered.includes(stale.toLowerCase()), `${where} must no longer claim universality: "${stale}"`)
    }
  }
  // NON-VACUITY: the sweep fires on the sentence it is made of, including on its case.
  for (const stale of universality) {
    const planted = `prologue\n${stale.toUpperCase()}\nepilogue`
    assert.ok(planted.toLowerCase().includes(stale.toLowerCase()), `the sweep cannot detect: ${stale}`)
  }
})

test('[o3d-z5be] the bootstrap creates fresh inodes and nothing tells an operator that relabelling a tree makes it trusted', () => {
  // o3d-z5be r6, Codex HIGH 1: chown/chmod change an inode's owner and mode now and revoke no descriptor
  // already open for writing, so a relabelled tree is not a trusted one — and no check can tell them apart.
  const doc = readFileSync(join(REPO, 'docs/installation.md'), 'utf8')
  const texts: Array<[string, string]> = [
    ['docs/installation.md', doc],
    [LIB_REL, LIB_SOURCE],
    [FENCE_LIB_REL, readFileSync(join(REPO, FENCE_LIB_REL), 'utf8')],
    ...ENTRYPOINTS.map((rel) => [rel, ENTRYPOINT_SOURCE.get(rel)!] as [string, string]),
  ]
  assert.equal(texts.length, 6, 'precondition: every file that instructs an operator was read')
  // WHAT THIS SWEEP IS, AND WHAT IT IS NOT (o3d-z5be r7, review MEDIUM 1). It is a CASE-INSENSITIVE
  // BLACKLIST of the phrasings this branch has actually used to offer a relabel; it is not a proof that
  // no file offers one, because any rewording passes it. r6's version was case-SENSITIVE and its own
  // first forbidden phrase survived, capitalised, in scripts/lib/privileged-helpers.sh — "Take group and
  // other write off it". (That message was about the MODES OF A DIRECTORY above the publication root,
  // where a chmod does close the hole, so it was not a content regression; it is reworded now to say so
  // rather than to read like the bootstrap remedy.) The claim that no supported path relabels anything
  // is carried by the bootstrap section and the invocation table asserted below, not by this list.
  for (const [where, text] of texts) {
    const lowered = text.toLowerCase()
    for (const stale of [
      'take group and other write off it',
      '— or `chown -R root:root <tree> && chmod -R go-w <tree>` — before running it',
      'or: chown -R root:root <tree> && chmod -r go-w <tree>',
      'a release tree only root can write',
      'install the release tree as root',
    ]) {
      assert.ok(!lowered.includes(stale.toLowerCase()), `${where} must no longer say "${stale}" (in any case)`)
    }
  }
  // The procedure itself: a new directory, a fetch INTO it as root, and the installer run from there.
  const anchor = doc.indexOf('<a id="supported-bootstrap"></a>')
  assert.notEqual(anchor, -1, 'the supported bootstrap must be a linkable section')
  const bootstrap = doc.slice(anchor, doc.indexOf('**A tree another account can write is refused**', anchor))
  assert.ok(bootstrap.length > 1500 && bootstrap.length < 8000, `the bootstrap section must have been isolated (${bootstrap.length})`)
  const commands = bootstrap.slice(bootstrap.indexOf('```bash'), bootstrap.indexOf('```', bootstrap.indexOf('```bash') + 7))
    .split('\n').filter((line) => line.trim() && !line.trim().startsWith('#') && !line.startsWith('```'))
  assert.deepEqual(commands, [
    'umask 022',
    'RELEASE_DIR="$(mktemp -d /root/ims-release.XXXXXX)"',
    'git clone --branch <release-tag> --depth 1 <repository-url> "${RELEASE_DIR}/one-two-inventory"',
    'bash "${RELEASE_DIR}/one-two-inventory/scripts/install.sh"',
  ], 'the runnable bootstrap must be exactly: a umask, a new directory, a clone into it, the installer from there')
  // review LOW 6: the umask is stated (a permissive one makes the clone group-writable and the startup
  // check then refuses, with the relabel as its only apparent remedy), and the tarball variant says the
  // archive's top-level directory name is the release's to check, not one this page can assume.
  assert.match(bootstrap, /tar -tzf \| head -1/, 'the tarball variant must tell the operator to check the archive top-level name')
  assert.match(bootstrap, /revoke nothing that\s+was opened before/, 'and it must say why a relabel is not enough')
  assert.match(bootstrap, /cannot detect a\s+relabelled tree/, 'and that the installer cannot detect one')
  // The startup refusal's own remedy says the same, and the same way in all three entrypoints.
  for (const rel of ENTRYPOINTS) {
    const block = blockCode(pinBlock(rel))
    assert.ok(block.includes('Do NOT chown or chmod an existing tree to get past this'), `${rel}: the refusal must warn off a relabel`)
    assert.ok(block.includes('mktemp -d /root/ims-release.XXXXXX'), `${rel}: and name the fresh-directory bootstrap`)
  }
  // And the invocation table carries the relabel as unsupported and undetected.
  const row = doc.split('\n').find((line) => line.startsWith('| any tree made root-owned by **relabelling** it'))
  assert.ok(row, 'the invocation table must have a relabel row')
  assert.match(row, /\*\*NOT SUPPORTED — and NOT detected\*\*/, row)
})

// ---------------------------------------------------------------------------
// 3k. WHAT THE OVERLAP WALK ANSWERS WHEN IT CANNOT WALK, AND WHAT COUNTS AS THE RUNNING TREE
//     (o3d-z5be r7 — independent review MEDIUM 2, MEDIUM 3, LOW 1, LOW 2)
// ---------------------------------------------------------------------------

test('[o3d-z5be] a walk that cannot finish is "cannot tell" and refuses — even when a directory is NAMED after the errno', (t) => {
  // THE FINDING (review MEDIUM 2). The error test was `grep -qv 'No such file or directory'`: "is there a
  // line not CONTAINING this substring". A directory the attacker names `No such file or directory` makes
  // every `find` error line contain it, so the walk reported "not reached", the trees were declared
  // disjoint, and the recursive operation proceeded. The errno is now matched at the END of the line.
  //
  // THIS RUNS AS THE TEST ACCOUNT, which is what makes it reachable: root does not get EACCES. In
  // production the guards run as root, so the shapes below need an NFS root_squash or an idmapped mount
  // — the refusal is what must be right either way.
  if (process.getuid!() === 0) {
    // review LOW 1: a bare `return` counted as a PASS on a root run, so the shape this test is about
    // went unmeasured there without saying so.
    t.skip('root does not get EACCES, so the unwalkable-tree shapes cannot be constructed as root')
    return
  }
  const base = createTempDirSync('walk-errno-', t)
  const release = join(base, 'release', 'scripts', 'lib')
  mkdirSync(release, { recursive: true })
  const shapes = [['named-after-the-errno', 'No such file or directory'], ['plainly-named', 'plainlocked']] as const
  const results: Record<string, string> = {}
  for (const [what, name] of shapes) {
    const app = join(base, what)
    const locked = join(app, name)
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o000)
    try {
      const out = withGuardLibrary(release,
        `if privileged_spare_running_tree ${JSON.stringify(app)} "the application directory"; then echo "R=PASSED"; else echo "R=REFUSED"; fi`)
      results[what] = `${out.stdout}${out.stderr}`
    } finally {
      chmodSync(locked, 0o755)
    }
  }
  // PRECONDITION: the walk really did fail — both runs must have produced a `find` error about the locked
  // directory, or this test is measuring two clean walks.
  for (const [what] of shapes) {
    assert.match(results[what], /Permission denied|could not be walked/, `${what}: the walk must actually have failed:\n${results[what]}`)
    assert.match(results[what], /^R=REFUSED$/m, `${what}: an unwalkable tree must refuse, not pass as disjoint:\n${results[what]}`)
  }
})

test('[o3d-z5be] a HARD LINK to the entrypoint inside the target is caught: the walk asks about the running tree\'s inodes, not only its directory', (t) => {
  // THE FINDING (review MEDIUM 3). The guard asked `find <target> -samefile <running directory>`, and a
  // hard link to the ENTRYPOINT is not that directory: `ln <release>/scripts/install.sh ${APP_DIR}/x.sh`
  // left the guard passing, and `chown -R ${APP_USER} ${APP_DIR}` then changed the owner of the inode
  // bash was reading — the r6 HIGH through a link count instead of a path.
  const base = createTempDirSync('hardlink-', t)
  const scripts = join(base, 'release', 'scripts')
  const lib = join(scripts, 'lib')
  const app = join(base, 'app')
  mkdirSync(lib, { recursive: true })
  mkdirSync(app)
  writeFileSync(join(scripts, 'install.sh'), '# install.sh\n')
  writeFileSync(join(lib, 'privileged-helpers.sh'), '# lib\n')
  const ask = () => withGuardLibrary(lib,
    `if privileged_spare_running_tree ${JSON.stringify(app)} "the application directory"; then echo "R=PASSED"; else echo "R=REFUSED"; fi`)
  // PRECONDITION: with no link, these trees are disjoint and the guard passes — so a REFUSED below is
  // the link and not the rig.
  assert.match(`${ask().stdout}`, /^R=PASSED$/m, 'a disjoint target must pass before the link exists')

  linkSync(join(scripts, 'install.sh'), join(app, 'x.sh'))
  const linkedEntry = ask()
  assert.equal(statSync(join(app, 'x.sh')).ino, statSync(join(scripts, 'install.sh')).ino,
    'precondition: the two names really are one inode')
  assert.match(`${linkedEntry.stdout}`, /^R=REFUSED$/m, `a hard link to the entrypoint inside the target must be caught:\n${linkedEntry.stdout}${linkedEntry.stderr}`)

  // AND THE SAME FOR A LIBRARY, which is the other half of what root executes.
  rmSync(join(app, 'x.sh'))
  linkSync(join(lib, 'privileged-helpers.sh'), join(app, 'y.sh'))
  const linkedLib = ask()
  assert.match(`${linkedLib.stdout}`, /^R=REFUSED$/m, `a hard link to a library must be caught too:\n${linkedLib.stdout}${linkedLib.stderr}`)
})

test('[o3d-z5be] an empty path, and a path carrying a newline, are refused rather than resolved to something else', (t) => {
  // review LOW 1: `realpath -e ""` fails and `dirname -- ""` is `.`, so the helper answered about the
  // caller's working directory. review LOW 2: command substitution strips a trailing newline, so
  // "/srv/app\n" resolved to "/srv/app" — and LOCAL_SOURCE_DIR is operator-supplied.
  const base = createTempDirSync('path-shapes-', t)
  const lib = join(base, 'release', 'scripts', 'lib')
  const app = join(base, 'app')
  mkdirSync(lib, { recursive: true })
  mkdirSync(app)
  const out = withGuardLibrary(lib, [
    'if privileged_physical_or_nearest "" >/dev/null 2>&1; then echo "EMPTY=ANSWERED"; else echo "EMPTY=REFUSED"; fi',
    // A REAL newline: JSON.stringify writes the two characters `\` and `n`, which bash inside double
    // quotes leaves as two characters, so the first version of this case tested nothing. $'\n' is bash's.
    `nl=$'\\n'`,
    `if privileged_physical_or_nearest "${JSON.stringify(app).slice(1, -1)}\${nl}" >/dev/null 2>&1; then echo "NEWLINE=ANSWERED"; else echo "NEWLINE=REFUSED"; fi`,
    `if privileged_trees_disjoint "${JSON.stringify(app).slice(1, -1)}\${nl}" ${JSON.stringify(app)} A B >/dev/null 2>&1; then echo "DISJOINT_NEWLINE=PASSED"; else echo "DISJOINT_NEWLINE=REFUSED"; fi`,
    `if privileged_physical_or_nearest ${JSON.stringify(app)} >/dev/null 2>&1; then echo "PLAIN=ANSWERED"; else echo "PLAIN=REFUSED"; fi`,
    `if privileged_trees_disjoint "" ${JSON.stringify(app)} A B >/dev/null 2>&1; then echo "DISJOINT_EMPTY=PASSED"; else echo "DISJOINT_EMPTY=REFUSED"; fi`,
  ].join('\n'))
  assert.match(out.stdout, /^EMPTY=REFUSED$/m, out.stdout)
  assert.match(out.stdout, /^NEWLINE=REFUSED$/m, out.stdout)
  assert.match(out.stdout, /^DISJOINT_NEWLINE=REFUSED$/m, out.stdout)
  // NOT VACUOUS: the same helper answers for the same directory without the newline.
  assert.match(out.stdout, /^PLAIN=ANSWERED$/m, out.stdout)
  assert.match(out.stdout, /^DISJOINT_EMPTY=REFUSED$/m, out.stdout)
})

test('[o3d-z5be] the two guards added in r7 REFUSE when the target overlaps the running tree, and nothing runs (review LOW 7)', (t) => {
  // r7 added a guard before migrate_uploads' `find … -exec mv` and before update.sh's backup pruner, and
  // both were held only by the census's textual check. These EXECUTE the shipped text.
  //
  // NOTHING HERE STUBS `find`. The guard's own walk IS a `find`, so a shell function by that name makes
  // the guard measure the stub instead of the tree — which is exactly how the first version of this test
  // passed while the guard never refused. The move is allowed to happen for real, inside a scratch
  // directory, and what is asserted is whether the file moved.
  const base = createTempDirSync('r7-guards-', t)
  const scripts = join(base, 'release', 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  const preamble = (dataDir: string) => [
    'info() { :; }; success() { :; }; warn() { :; }',
    'die() { echo "DIED: $*"; exit 3; }',
    'rmdir() { :; }',
    // The real one walks by descriptor from a proved root; here it just becomes the destination, which is
    // all the `-exec mv -n -t .` below needs. It is not the subject.
    'enter_service_subdir() { mkdir -p "$3" && cd "$3"; }',
    `DATA_DIR=${JSON.stringify(dataDir)}`,
  ].join('\n')
  const migrate = shellFunction(ENTRYPOINT_SOURCE.get('scripts/install.sh')!, 'migrate_uploads', 'scripts/install.sh')
  assert.match(migrate, /privileged_spare_running_tree "\$\{src\}"/, 'precondition: the lifted function carries the guard')

  // 1. A source INSIDE the running tree: refused, and the file is still where it was.
  const inside = join(scripts, 'uploads')
  mkdirSync(inside)
  writeFileSync(join(inside, 'a.pdf'), 'x\n')
  const insideDest = join(base, 'data-inside', 'uploads')
  const refused = withGuardLibrary(join(scripts, 'lib'), [
    preamble(join(base, 'data-inside')), migrate,
    `migrate_uploads ${JSON.stringify(inside)} ${JSON.stringify(insideDest)}`,
    'echo "COMPLETED"',
  ].join('\n'))
  assert.match(refused.stdout, /^DIED: /m, `${refused.stdout}${refused.stderr}`)
  assert.doesNotMatch(refused.stdout, /^COMPLETED$/m, 'the run must stop')
  assert.equal(existsSync(join(inside, 'a.pdf')), true, 'and nothing may have been moved out of the running tree')
  assert.equal(existsSync(insideDest), false, 'nor a destination created')

  // NOT VACUOUS: the same shipped function, a source OUTSIDE the running tree, moves the file.
  const outside = join(base, 'legacy')
  mkdirSync(outside)
  writeFileSync(join(outside, 'b.pdf'), 'y\n')
  const outsideDest = join(base, 'data-outside', 'uploads')
  const allowed = withGuardLibrary(join(scripts, 'lib'), [
    preamble(join(base, 'data-outside')), migrate,
    `migrate_uploads ${JSON.stringify(outside)} ${JSON.stringify(outsideDest)}`,
    'echo "COMPLETED"',
  ].join('\n'))
  assert.match(allowed.stdout, /^COMPLETED$/m, `${allowed.stdout}${allowed.stderr}`)
  assert.equal(existsSync(join(outsideDest, 'b.pdf')), true, `the migration must actually have run:\n${allowed.stdout}${allowed.stderr}`)

  // 2. update.sh's backup pruner, lifted by its two shipped lines. `ls` and `xargs` are recorded — the
  // guard uses neither.
  const updateLines = ENTRYPOINT_SOURCE.get('scripts/update.sh')!.split('\n')
  const guardAt = updateLines.findIndex((line) => /^  privileged_spare_running_tree "\$\{BACKUP_DIR\}"/.test(line))
  assert.notEqual(guardAt, -1, 'update.sh must carry the pruner guard')
  const pruner = updateLines.slice(guardAt, guardAt + 2).join('\n')
  assert.match(pruner, /xargs -r rm --/, 'precondition: the lifted block is the pruner')
  const calls = join(base, 'calls.log')
  const prune = (backupDir: string) => {
    rmSync(calls, { force: true })
    const out = withGuardLibrary(join(scripts, 'lib'), [
      `CALLS=${JSON.stringify(calls)}`,
      'die() { echo "DIED: $*"; exit 3; }',
      'ls() { echo "ls $*" >> "${CALLS}"; }',
      'xargs() { echo "xargs $*" >> "${CALLS}"; }',
      `BACKUP_DIR=${JSON.stringify(backupDir)}`,
      // o3d-noka: the DELETE is aimed at ${BACKUP_AT} — `/proc/self/fd/N` on the directory the
      // ancestry walk pinned — while the guard is asked about the PATHNAME, because containment is a
      // question about pathnames. This rig measures the GUARD, so both name the same directory; the
      // descriptor itself is measured in tests/scripts/install-root-safe-writes.test.ts.
      `BACKUP_AT=${JSON.stringify(backupDir)}`,
      pruner,
      'echo "COMPLETED"',
    ].join('\n'))
    return { ...out, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
  }
  const refusedPrune = prune(join(scripts, 'backups'))
  assert.match(refusedPrune.stdout, /^DIED: /m, `${refusedPrune.stdout}${refusedPrune.stderr}`)
  assert.equal(refusedPrune.calls.includes('xargs'), false, `nothing may be deleted:\n${refusedPrune.calls}`)
  const okPrune = prune(join(base, 'backups'))
  assert.match(okPrune.stdout, /^COMPLETED$/m, `${okPrune.stdout}${okPrune.stderr}`)
  assert.match(okPrune.calls, /^ls /m, `and the pruner must have been reached:\n${okPrune.calls}`)
})

test('[o3d-z5be] an overlap hit says WHICH kind it is: containment in either direction, or a hard link (review LOW 5)', (t) => {
  const base = createTempDirSync('overlap-kind-', t)
  const scripts = join(base, 'release', 'scripts')
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  writeFileSync(join(scripts, 'install.sh'), '# install.sh\n')
  const nested = join(scripts, 'uploads')
  mkdirSync(nested)
  writeFileSync(join(nested, 'a.pdf'), 'x\n')
  const linked = join(base, 'app')
  mkdirSync(linked)
  linkSync(join(scripts, 'install.sh'), join(linked, 'x.sh'))
  const outer = join(base, 'outer')
  mkdirSync(join(outer, 'release', 'scripts', 'lib'), { recursive: true })

  const ask = (lib: string, target: string) => withGuardLibrary(lib,
    `privileged_spare_running_tree ${JSON.stringify(target)} "the target" 2>&1 | tail -1`)
  assert.match(ask(join(scripts, 'lib'), nested).stdout, /is, or lies inside,/,
    'a target inside the running tree is containment, not a link')
  assert.match(ask(join(outer, 'release', 'scripts', 'lib'), outer).stdout, /is, or lies inside,/,
    'and so is a running tree inside the target')
  const link = ask(join(scripts, 'lib'), linked).stdout
  assert.match(link, /holds a SECOND NAME — a hard link —/, `a hard link must be named as one:\n${link}`)
  assert.doesNotMatch(link, /lies inside/, 'and must not be described as containment')

  // AND THE SECOND ID LIST IS A FRESH FILE (o3d-z5be r9, review LOW 10). The first block removes its
  // mktemp; r8 left the VARIABLE set, so the second block's `[[ -n … ]]` short-circuited the mktemp that
  // is plainly written there and privileged_tree_inode_list re-created that unowned name AS ROOT. The
  // count of temp files this path asks for is exactly the claim, so `mktemp` is wrapped to count — it is
  // not stubbed: the wrapper calls the real one and returns its path, so the guard's own behaviour is
  // unchanged and the assertion below still requires the hard link to be reported.
  const counter = join(base, 'mktemp.log')
  const counted = withGuardLibrary(join(scripts, 'lib'), [
    `mktemp() { local p; p="$(command mktemp "$@")" || return 1; echo "$p" >> ${JSON.stringify(counter)}; echo "$p"; }`,
    `privileged_spare_running_tree ${JSON.stringify(linked)} "the target" 2>&1 | tail -1`,
  ].join('\n'))
  assert.match(counted.stdout, /holds a SECOND NAME — a hard link —/, 'precondition: the wrapped run takes the same path')
  const asked = readFileSync(counter, 'utf8').trim().split('\n').filter((line) => line !== '')
  assert.equal(new Set(asked).size, asked.length, `every temp file must be its own: ${asked.join(', ')}`)
  // NINE, MEASURED: the disjointness question walks both ways and asks the kind question twice. With the
  // variable left set it is EIGHT, because the second kind block reuses the name the first one removed.
  assert.equal(asked.length, 9, `every temp file this path uses must be asked for: ${asked.join(', ')}`)
  for (const path of asked) assert.ok(!existsSync(path), `and removes it: ${path}`)
})

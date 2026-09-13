import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { shellConstant, shellFunction } from './shell-symbol.ts'
import { createTempDirSync } from './temp-dir.ts'

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
    '  if [[ "$1" == "-T" ]] && [[ "$2" == "${IMS_DRIVER_HELPER_DIR}" ]] && (( raced == 0 )); then',
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
function withGuardLibrary(runningLib: string, program: string) {
  const out = spawnSync('bash', ['-c', [
    'set -uo pipefail',
    `source ${JSON.stringify(join(REPO, FENCE_LIB_REL))}`,
    `source ${JSON.stringify(join(REPO, LIB_REL))}`,
    `IMS_SCRIPT_LIB_DIR=${JSON.stringify(runningLib)}`,
    program,
  ].join('\n')], { encoding: 'utf8' })
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
  if (process.getuid!() !== 0) {
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

test('[o3d-z5be] CENSUS: every recursive ownership change, copy or delete in the three entrypoints is guarded against the running tree', () => {
  // THE AUDIT, AS A TEST THAT FAILS ON A NEW ONE. Every root-side statement in an entrypoint that can
  // change ownership or content recursively is enumerated by grammar; the table below must account for
  // each one exactly, and each guarded one must be IMMEDIATELY preceded — as the previous code statement,
  // not "somewhere nearby" — by privileged_spare_running_tree on the named target.
  const RECURSIVE = /(^|[\s;(])(chown|chmod|chgrp)\s+(-[A-Za-z]*R[A-Za-z]*|--recursive)\b|(^|[\s;(])setfacl\s|(^|[\s;(])rsync\s+-|(^|[\s;(])cp\s+-[A-Za-z]*[aRr]|(^|[\s;(])rm\s+-[A-Za-z]*r|^\s*(chown_state_tree|copy_tree_into_new_dir)\s/
  type Entry = { file: string; op: RegExp; guard: string | null; up?: number; why?: string }
  const G = (target: string) => `privileged_spare_running_tree "${target}" `
  const table: Entry[] = [
    { file: 'scripts/install.sh', op: /^chown_state_tree "\$\{DATA_DIR\}"/, guard: G('${DATA_DIR}') },
    { file: 'scripts/install.sh', op: /^  chown -Rh "\$\{APP_USER\}:\$\{APP_USER\}" \.$/, guard: G('${LOG_DIR}'), up: 3 },
    { file: 'scripts/install.sh', op: /^    rsync -a --delete \\$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: /^    copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"$/, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: /^    chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}"$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: /^    rm -rf "\$\{TMP_CLONE_DIR\}"$/, guard: null, why: 'TMP_CLONE_DIR is a `mktemp -d` this run created after the entrypoint was opened' },
    { file: 'scripts/install.sh', op: /^  rsync -a --delete \\$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: /^  chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}"$/, guard: G('${APP_DIR}') },
    { file: 'scripts/install.sh', op: /^    copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"$/, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: /^    chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}\/\.git"$/, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/install.sh', op: /^    rm -rf "\$\{TMP_CLONE_DIR\}"$/, guard: null, why: 'mktemp -d' },
    { file: 'scripts/update.sh', op: /^    rsync -a --delete \\$/, guard: G('${APP_DIR}') },
    { file: 'scripts/update.sh', op: /^    copy_tree_into_new_dir "\$\{TMP_CLONE_WORKTREE\}\/\.git" "\$\{APP_DIR\}\/\.git"$/, guard: G('${APP_DIR}/.git') },
    { file: 'scripts/update.sh', op: /^    chown -R "\$\{APP_USER\}:\$\{APP_USER\}" "\$\{APP_DIR\}"$/, guard: G('${APP_DIR}') },
    { file: 'scripts/update.sh', op: /^    rm -rf "\$\{TMP_CLONE_DIR\}"$/, guard: null, why: 'mktemp -d' },
  ]
  for (const rel of ENTRYPOINTS) {
    const code = codeLines(ENTRYPOINT_SOURCE.get(rel)!).filter((line) => line.text.trim() !== '')
    // Messages quote commands; a statement is a line that does not begin inside a string.
    const ops = code.map((line, index) => ({ ...line, index }))
      .filter((line) => RECURSIVE.test(line.text) && !/^\s*(echo|printf|info|warn|die|error|ims_startup_refuse|"|')/.test(line.text) && !/^\s*"/.test(line.text))
    const expected = table.filter((entry) => entry.file === rel)
    assert.equal(ops.length, expected.length,
      `${rel}: the census must account for every recursive operation, found ${ops.length}:\n${ops.map((op) => `${op.n}: ${op.text}`).join('\n')}`)
    const used = new Set<number>()
    for (const op of ops) {
      const entryIndex = expected.findIndex((entry, i) => !used.has(i) && entry.op.test(op.text))
      assert.notEqual(entryIndex, -1, `${rel}:${op.n}: a recursive operation the census does not know: ${op.text}`)
      used.add(entryIndex)
      const entry = expected[entryIndex]
      if (entry.guard === null) {
        assert.ok(entry.why && ENTRYPOINT_SOURCE.get(rel)!.includes('TMP_CLONE_DIR="$(mktemp -d -t '), `${rel}:${op.n}: an unguarded operation must be on a fresh mktemp directory`)
        continue
      }
      const previous = code[op.index - (entry.up ?? 1)]
      assert.ok(previous?.text.trim().startsWith(entry.guard),
        `${rel}:${op.n} (${op.text.trim()}) must be immediately preceded by ${entry.guard}…, and is preceded by: ${previous?.text}`)
    }
  }
  // deploy.sh makes no recursive ownership change, copy or delete at all — asserted by the census above
  // (the table holds none for it), so one added there fails this test until it is guarded.
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
  // ABSENCE, universal: no file offers a relabel as the way to a supported tree.
  for (const [where, text] of texts) {
    for (const stale of [
      'take group and other write off it',
      '— or `chown -R root:root <tree> && chmod -R go-w <tree>` — before running it',
      'or: chown -R root:root <tree> && chmod -R go-w <tree>',
      'a release tree only root can write',
      'install the release tree as root',
    ]) {
      assert.ok(!text.includes(stale), `${where} must no longer say "${stale}"`)
    }
  }
  // The procedure itself: a new directory, a fetch INTO it as root, and the installer run from there.
  const anchor = doc.indexOf('<a id="supported-bootstrap"></a>')
  assert.notEqual(anchor, -1, 'the supported bootstrap must be a linkable section')
  const bootstrap = doc.slice(anchor, doc.indexOf('**A tree another account can write is refused**', anchor))
  assert.ok(bootstrap.length > 1500 && bootstrap.length < 6000, `the bootstrap section must have been isolated (${bootstrap.length})`)
  const commands = bootstrap.slice(bootstrap.indexOf('```bash'), bootstrap.indexOf('```', bootstrap.indexOf('```bash') + 7))
    .split('\n').filter((line) => line.trim() && !line.trim().startsWith('#') && !line.startsWith('```'))
  assert.deepEqual(commands, [
    'RELEASE_DIR="$(mktemp -d /root/ims-release.XXXXXX)"',
    'git clone --branch <release-tag> --depth 1 <repository-url> "${RELEASE_DIR}/one-two-inventory"',
    'bash "${RELEASE_DIR}/one-two-inventory/scripts/install.sh"',
  ], 'the runnable bootstrap must be exactly: a new directory, a clone into it, the installer from there')
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

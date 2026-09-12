import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  assert.equal(existsSync(join(root, 'helper-set.sha256')), false, `${what}: and no record either`)
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
    assert.match(after[0].text, /^publish_privileged_helper_set \|\| \{$/,
      `${rel}: the snapshot must be taken in the same instant as the libraries are read — the next `
      + `script-scope statement after sourcing ${LIB_REL} must be the publication, and it is `
      + `"${after[0].text.trim()}" at line ${after[0].n}`)

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
  assert.match(out.stdout, new RegExp(`^RESOLVED=${dirs.root}/helpers/chown-tree\\.mjs$`, 'm'), out.stdout)
  assert.doesNotMatch(out.stdout, /^REASSIGN_RC=0$/m,
    `the published digest must be readonly for the rest of the run:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, new RegExp(`^AFTER=${digest[1]}$`, 'm'), out.stdout)

  // THE SEAL, MEASURED ON DISK rather than taken from the function that asserted it: every entry
  // owned by this account, nothing writable by group or other, and no symlinks.
  const uid = process.getuid!()
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    const st = lstatSync(path)
    assert.ok(st.isFile() || st.isDirectory(), `${path} must be a regular file or a directory`)
    assert.equal(st.uid, uid, `${path} must be owned by the publishing account`)
    assert.equal(st.mode & 0o022, 0, `${path} must not be writable by group or other (mode ${(st.mode & 0o7777).toString(8)})`)
    return st.isDirectory() ? walk(path) : [path]
  })
  const files = walk(dirs.root)
  assert.ok(files.length >= 4, `the publication must have produced the tree, the record and the manifest: ${files.join(', ')}`)
  const record = readFileSync(join(dirs.root, 'helper-set.sha256'), 'utf8')
  assert.match(record, new RegExp(`^tree_sha256=${digest[1]}$`, 'm'), record)
  assert.match(record, /^tree_complete=1$/m, 'the record must carry its completion sentinel last')
  assert.match(readFileSync(join(dirs.root, 'helper-set.manifest'), 'utf8'), /\bchown-tree\.mjs$/m)
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
  assert.match(out.stdout, new RegExp(`^BEFORE=${dirs.root}/helpers/chown-tree\\.mjs$`, 'm'), out.stdout)
  assert.match(out.stdout, /^SECOND_RC=0$/m, `the second publication must succeed:\n${out.stdout}${out.stderr}`)
  assert.doesNotMatch(out.stdout, /^AFTER_RC=0$/m,
    `the resolution must refuse a tree this run did not publish:\n${out.stdout}${out.stderr}`)
  assert.match(out.stdout, /^AFTER=$/m, out.stdout)
  // AND THE REFUSAL REACHES THE OPERATOR. The callers read this function through a command
  // substitution, so a reason kept only in a variable dies with the subshell.
  assert.match(out.stderr, /refusing to execute bytes this run did not publish/, out.stderr)
  assert.match(out.stderr, /sha256sum -c .*helper-set\.manifest/, out.stderr)
  // The RECORD on disk now matches the tampered tree, which is the point of the in-memory digest.
  const record = readFileSync(join(dirs.root, 'helper-set.sha256'), 'utf8')
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
    const digest = /^tree_sha256=([0-9a-f]{64})$/m.exec(readFileSync(join(dirs.root, 'helper-set.sha256'), 'utf8'))![1]
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
  rmSync(join(dirs.root, 'helpers'), { recursive: true })
  rmSync(join(dirs.root, 'helper-set.sha256'))
  rmSync(join(dirs.root, 'helper-set.manifest'))

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
  for (const rel of ['driver/install.sh', 'driver/update.sh', 'driver/deploy.sh', 'driver/lib/chown-tree.mjs', 'driver.sha256', 'driver.manifest']) {
    assert.ok(existsSync(join(root, rel)), `${rel} must be published`)
    const st = statSync(join(root, rel))
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

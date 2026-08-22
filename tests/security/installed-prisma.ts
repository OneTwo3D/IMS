/**
 * Facts about Prisma read from the INSTALLED generated client, not written down.
 *
 * o3d-512h round 9, Codex finding 3.
 *
 * Two of the security rules in this directory turn on "what vocabulary does
 * Prisma have": the self-scoping predicate (./recording-db.ts) must know which
 * `where` keys are OPERATORS, because everything else it reads as a field name
 * and descends into; and the write-position rule (./server-action-guard-scan.ts)
 * must know which model methods MUTATE, because everything else it treats as a
 * read that a later guard may still gate.
 *
 * Both were maintained as literals, and both were exactly one Prisma feature away
 * from being wrong in the direction that grants credit. `string_contains`,
 * `array_contains`, `string_starts_with`, `array_starts_with` and `path` — the
 * Json filter family, in every Prisma client this repo has ever had — were on
 * neither list, so `where: { metadata: { string_contains: 'u1' } }` was read as a
 * relation shorthand and credited as scoping. That is `contains`, which round 7
 * refused explicitly, waved through because Json spells it differently.
 *
 * Round 8's own verdict on the operator list was that it "is still a list, and
 * lists in this file have lost every round they have been in". So the lists that
 * enumerate what EXISTS are derived here from the generated client on disk, and
 * the lists that record a JUDGEMENT — which operators scope, which methods
 * mutate — stay where a reviewer can read them, checked against this.
 *
 * Everything here REFUSES rather than falling back. A client that cannot be found
 * or parsed throws, naming what to do about it, because the alternative is the
 * silent staleness this exists to remove.
 *
 * Not named *.test.ts on purpose — `npm run test:unit` globs tests/**\/*.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The TypeScript sources of the installed Prisma client, whichever layout it is
 * generated in.
 *
 * Prisma 7 with `provider = "prisma-client"` — what this repo uses — emits a
 * DIRECTORY of `.ts` at the generator's `output`, so the path is read from
 * prisma/schema.prisma rather than assumed. The classic `prisma-client-js`
 * provider emits `node_modules/.prisma/client/index.d.ts`, and `@prisma/client`
 * re-exports it. All three are checked; there is no fourth answer and no default.
 */
export function installedPrismaClientFiles(): string[] {
  const out: string[] = []

  const schema = path.join(repoRoot, 'prisma', 'schema.prisma')
  if (fs.existsSync(schema)) {
    const declared = /generator\s+\w+\s*\{[^}]*?\boutput\s*=\s*"([^"]+)"/.exec(fs.readFileSync(schema, 'utf8'))
    if (declared) {
      const walk = (at: string) => {
        if (!fs.existsSync(at)) return
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
          const full = path.join(at, entry.name)
          if (entry.isDirectory()) {
            // `internal/` holds the serialized schema — megabytes of JSON with
            // every column name in the database in it, and no type declarations.
            if (entry.name !== 'internal') walk(full)
          } else if (entry.name.endsWith('.ts')) {
            out.push(full)
          }
        }
      }
      walk(path.resolve(path.dirname(schema), declared[1]))
    }
  }

  for (const classic of [
    path.join(repoRoot, 'node_modules', '.prisma', 'client', 'index.d.ts'),
    path.join(repoRoot, 'node_modules', '@prisma', 'client', 'index.d.ts'),
  ]) {
    if (fs.existsSync(classic)) out.push(classic)
  }

  return out
}

/** One `export type|interface Name … = { … }` block per match: [name, members]. */
function declarationBlocks(source: string, re: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = []
  re.lastIndex = 0
  for (;;) {
    const m = re.exec(source)
    if (!m) break
    out.push([m[1], m[2]])
  }
  return out
}

const MEMBER_RE = /^\s{2}([A-Za-z_$][A-Za-z0-9_]*)\s*\??\s*[<(:]/

function membersOf(block: string): string[] {
  const names: string[] = []
  for (const line of block.split('\n')) {
    const m = MEMBER_RE.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

function refuse(what: string, missing: string[], read: number, files: number): never {
  throw new Error(
    `tests/security/installed-prisma.ts: could not derive ${what} from the installed Prisma client `
    + `(read ${read} declaration(s) from ${files} generated file(s); missing ${missing.join(', ')}). `
    + 'Run `npm run db:generate` (or `prisma generate`) so the client exists; if it does, the '
    + 'generated layout has changed and the extractors in this file must be updated. This REFUSES '
    + 'rather than falling back to a hand-written list, because every rule that consumes it treats '
    + 'an unrecognised name as harmless.',
  )
}

// ---------------------------------------------------------------------------
// Filter operators — the vocabulary ./recording-db.ts matches `where` keys against
// ---------------------------------------------------------------------------

/**
 * Present in every generated client, across all three families of filter. If one
 * of these is missing, the extractor is reading something other than a Prisma
 * client and its silence means nothing.
 */
const FILTER_ANCHORS = [
  // Scalar.
  'equals', 'in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte',
  'contains', 'startsWith', 'endsWith', 'mode',
  // Relation, generated per model.
  'is', 'isNot', 'some', 'none', 'every',
  // Json — the family that got past round 8.
  'path', 'string_contains', 'string_starts_with', 'array_contains',
]

const FILTER_TYPE_RE = /^export type ([A-Za-z0-9_]*Filter[A-Za-z0-9_]*)[^\n]* = \{$([\s\S]*?)^\}$/gm

let filterOperators: Set<string> | undefined

/** Every key of every `…Filter…` type the installed client declares. */
export function installedPrismaFilterOperators(): Set<string> {
  if (filterOperators) return filterOperators
  const files = installedPrismaClientFiles()
  const ops = new Set<string>()
  let types = 0
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes('Filter')) continue
    for (const [, block] of declarationBlocks(src, FILTER_TYPE_RE)) {
      types += 1
      for (const key of membersOf(block)) ops.add(key)
    }
  }
  const missing = FILTER_ANCHORS.filter((a) => !ops.has(a))
  if (missing.length > 0) refuse('the Prisma filter-operator vocabulary', missing, types, files.length)
  filterOperators = ops
  return ops
}

// ---------------------------------------------------------------------------
// Model operations — what ./server-action-guard-scan.ts classifies as write/read
// ---------------------------------------------------------------------------

const DELEGATE_ANCHORS = [
  'findMany', 'findUnique', 'findFirst', 'count', 'aggregate', 'groupBy',
  'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
]

const DELEGATE_RE = /^export interface ([A-Za-z0-9_]*Delegate)[^\n]*\{$([\s\S]*?)^\}$/gm

let modelOperations: Set<string> | undefined

/**
 * Every method the installed client declares on a MODEL delegate — `db.user.<op>`.
 *
 * The write-position rule classifies these into mutating and non-mutating, and
 * this is what makes "and nothing else exists" a fact rather than a belief.
 */
export function installedPrismaModelOperations(): Set<string> {
  if (modelOperations) return modelOperations
  const files = installedPrismaClientFiles()
  const ops = new Set<string>()
  let delegates = 0
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes('Delegate')) continue
    for (const [, block] of declarationBlocks(src, DELEGATE_RE)) {
      delegates += 1
      for (const op of membersOf(block)) ops.add(op)
    }
  }
  const missing = DELEGATE_ANCHORS.filter((a) => !ops.has(a))
  if (missing.length > 0) refuse('the Prisma model-operation set', missing, delegates, files.length)
  modelOperations = ops
  return ops
}

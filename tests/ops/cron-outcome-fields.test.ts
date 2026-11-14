import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import ts from 'typescript'

import { cronOutcomes, type CronOutcomeSlug } from '../../lib/ops/cron-outcomes.ts'
import { outboundHeldMessage } from '../../lib/security/outbound-write-hold-constants.ts'
import { cronFailureFields, type CronFieldDeclaration } from '../../lib/ops/cron-outcome-fields.ts'

/**
 * A NEW FAILURE FIELD IN A PRODUCER FAILS CI UNTIL IT IS MAPPED OR JUSTIFIED.
 *
 * The type of every route's result (the parameter of its entry in cronOutcomes) is read with the TypeScript compiler, every property at any depth whose
 * name looks like a failure is listed, and each must be declared in lib/ops/cron-outcome-fields.ts as consumed (and the test probes that it really is:
 * the mapping must not answer ok when only that field is set), a breakdown of a parent count (and the test checks it alone does not fail the run), or
 * ignored with a reason.
 */

const FAILURE_LIKE = /fail|error|dead|conflict|park|unresolved|reject|quarantin|incomplete|orphan|stuck|blocked|refus|unrecorded|unwritten|lost|missing|abandon|stale|skippedWithError|mismatch|drift|invalid|denied|timeout|unavailable|stoppedEarly|aborted|halted|interrupted|truncated|capped/i
/** Names of counters that say a run made progress: a failure field must still be read when every one of these is above zero. */
const PROGRESS_LIKE = /stored|synced|processed|pushed|imported|updated|sent|created|succeeded|released|registered|verified|dispatched|delivered|archived|written|claimed|attempted|scanned|considered|checked|paid|reversed|revalued|persisted|fetched|corrected|matched|cleared|completed|reconciled|enqueued|queued/i
const LEAF = { number: 'number', string: 'string', stringArray: 'string[]', boolean: 'boolean', other: 'other' } as const
type Leaf = (typeof LEAF)[keyof typeof LEAF]

type Enumerated = Map<string, Leaf>
type Progress = Map<string, Leaf>

function buildEnumerator() {
  const configPath = path.resolve('tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  const file = path.resolve('lib/ops/cron-outcomes.ts')
  const program = ts.createProgram({ rootNames: [file], options: { ...parsed.options, noEmit: true, incremental: false, skipLibCheck: true } })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(file)
  assert.ok(source, 'cron-outcomes.ts is in the program')
  const moduleSymbol = checker.getSymbolAtLocation(source)
  assert.ok(moduleSymbol)
  const exported = checker.getExportsOfModule(moduleSymbol).find((entry) => entry.name === 'cronOutcomes')
  assert.ok(exported, 'cronOutcomes is exported')
  const registryType = checker.getTypeOfSymbolAtLocation(exported, source)
  const BUILT_INS = new Set(['Date', 'Map', 'Set', 'Promise', 'Error', 'RegExp', 'Buffer', 'Uint8Array'])

  const leafOf = (type: ts.Type): Leaf => {
    const parts = type.isUnion() ? type.types.filter((part) => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) : [type]
    if (parts.some((part) => part.flags & ts.TypeFlags.NumberLike)) return LEAF.number
    if (parts.some((part) => checker.isArrayType(part))) return LEAF.stringArray
    if (parts.some((part) => part.flags & ts.TypeFlags.StringLike)) return LEAF.string
    if (parts.some((part) => part.flags & ts.TypeFlags.BooleanLike)) return LEAF.boolean
    return LEAF.other
  }

  function walk(type: ts.Type, prefix: string, out: Enumerated, seen: Set<ts.Type>, depth: number, progress?: Progress): void {
    if (depth > 7) return
    const members = type.isUnion() ? type.types : [type]
    for (const member of members) {
      if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue
      if (checker.isArrayType(member)) {
        const element = checker.getTypeArguments(member as ts.TypeReference)[0]
        if (element) walk(element, `${prefix}[]`, out, seen, depth + 1, progress)
        continue
      }
      if (!(member.flags & ts.TypeFlags.Object) && !member.isIntersection()) continue
      if (seen.has(member)) continue
      if (BUILT_INS.has(member.symbol?.name ?? '')) continue
      if ((member.symbol?.declarations?.[0]?.getSourceFile().fileName ?? '').includes('node_modules')) continue
      const nextSeen = new Set(seen)
      nextSeen.add(member)
      for (const property of member.getProperties()) {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, source!)
        const propertyPath = prefix ? `${prefix}.${property.name}` : property.name
        if (FAILURE_LIKE.test(property.name)) out.set(propertyPath, leafOf(propertyType))
        else if (progress && PROGRESS_LIKE.test(property.name) && leafOf(propertyType) === LEAF.number) progress.set(propertyPath, LEAF.number)
        walk(propertyType, propertyPath, out, nextSeen, depth + 1, progress)
      }
    }
  }

  const bySlug = new Map<string, { fields: Enumerated; progress: Progress; topLevelProperties: number; typeText: string }>()
  for (const property of registryType.getProperties()) {
    const mapperType = checker.getTypeOfSymbolAtLocation(property, source)
    const parameter = mapperType.getCallSignatures()[0]?.getParameters()[0]
    assert.ok(parameter, `${property.name}: the mapping takes a result`)
    const parameterType = checker.getTypeOfSymbolAtLocation(parameter, source)
    const fields: Enumerated = new Map()
    const progress: Progress = new Map()
    walk(parameterType, '', fields, new Set(), 0, progress)
    const members = parameterType.isUnion() ? parameterType.types : [parameterType]
    bySlug.set(property.name, {
      fields,
      progress,
      topLevelProperties: members.reduce((total, member) => total + member.getProperties().length, 0),
      typeText: checker.typeToString(parameterType).slice(0, 80),
    })
  }
  return bySlug
}

/** The comparison itself, on plain data so it can be shown to fail. */
export function diffFieldDeclaration(enumerated: Enumerated, declaration: CronFieldDeclaration): string[] {
  const problems: string[] = []
  const consumed = new Set(declaration.consumed ?? [])
  const breakdown = new Set(Object.keys(declaration.breakdownOf ?? {}))
  const ignored = new Set(Object.keys(declaration.ignored ?? {}))
  const declared = [...consumed, ...breakdown, ...ignored]
  for (const field of enumerated.keys()) if (!declared.includes(field)) problems.push(`${field}: a failure-like field with no declaration (consume it in the mapping, or list it as breakdownOf/ignored with a reason)`)
  for (const field of declared) if (!enumerated.has(field)) problems.push(`${field}: declared but not in the result type (stale)`)
  const seenOnce = new Set<string>()
  for (const field of declared) { if (seenOnce.has(field)) problems.push(`${field}: declared in more than one category`); seenOnce.add(field) }
  for (const [field, parent] of Object.entries(declaration.breakdownOf ?? {})) if (!consumed.has(parent)) problems.push(`${field}: breakdownOf '${parent}', which is not a consumed field`)
  for (const [field, reason] of Object.entries(declaration.ignored ?? {})) if (reason.trim().length < 15) problems.push(`${field}: the ignore reason is too short to be a reason`)
  return problems
}

const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Deep merge in which the first element of two arrays of objects is merged too, so `details[].processed` and `details[].errors` land in one item. */
function merge(target: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  for (const [key, extraValue] of Object.entries(extra)) {
    const existing = target[key]
    if (isPlain(existing) && isPlain(extraValue)) target[key] = merge({ ...existing }, extraValue)
    else if (Array.isArray(existing) && Array.isArray(extraValue) && isPlain(existing[0]) && isPlain(extraValue[0])) target[key] = [merge({ ...existing[0] }, extraValue[0]), ...extraValue.slice(1)]
    else target[key] = extraValue
  }
  return target
}

function valueFor(leaf: Leaf): unknown {
  return leaf === LEAF.number ? 1 : leaf === LEAF.stringArray ? ['x'] : leaf === LEAF.boolean ? true : 'x'
}

function objectAt(fieldPath: string, value: unknown): Record<string, unknown> {
  const segments = fieldPath.split('.')
  const build = (index: number): unknown => {
    const segment = segments[index]!
    const isArray = segment.endsWith('[]')
    const key = isArray ? segment.slice(0, -2) : segment
    const inner = index === segments.length - 1 ? value : build(index + 1)
    return { [key]: isArray ? [inner] : inner }
  }
  return build(0) as Record<string, unknown>
}

/** A result with only `path` set to a failing value, over any base the declaration gives. */
function sampleFor(fieldPath: string, leaf: Leaf, base: Record<string, unknown> = {}): Record<string, unknown> {
  return merge({ ...base }, objectAt(fieldPath, valueFor(leaf)))
}

/** A busy, successful run: every progress counter of the result, at any depth, is above zero. */
function busyBaseline(progress: Progress): Record<string, unknown> {
  let result: Record<string, unknown> = {}
  for (const progressPath of progress.keys()) result = merge(result, objectAt(progressPath, 1))
  return result
}

const mapper = (slug: string): ((result: unknown) => string) => (result) => (cronOutcomes as Record<string, (r: never) => string>)[slug]!(result as never)

const enumerated = buildEnumerator()

test('the census sees every route, and every route has a typed result (not vacuous)', () => {
  const slugs = Object.keys(cronOutcomes)
  assert.equal(enumerated.size, slugs.length)
  assert.deepEqual(Object.keys(cronFailureFields).sort(), [...slugs].sort(), 'cronFailureFields must have one entry per route')
  let total = 0
  for (const [slug, entry] of enumerated) {
    total += entry.fields.size
    assert.ok(entry.topLevelProperties > 0, `${slug}: the mapping's parameter is typed ${entry.typeText}, which has no properties, so its failure fields cannot be seen; type it from the producer`)
  }
  console.log(`# failure-like fields found across ${slugs.length} routes: ${total}`)
  assert.ok(total >= 80)
})

test('every failure-like field of every result is consumed, a declared breakdown, or ignored with a reason', () => {
  const all: string[] = []
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    for (const problem of diffFieldDeclaration(enumerated.get(slug)!.fields, cronFailureFields[slug])) all.push(`${slug}: ${problem}`)
  }
  assert.deepEqual(all, [], `\n${all.join('\n')}`)
})

test('every consumed field really is consumed: the mapping does not answer ok when only that field is set', () => {
  let probed = 0
  let probedWithSkip = 0
  let probedWithProgress = 0
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    const declaration = cronFailureFields[slug]
    for (const field of declaration.consumed ?? []) {
      const leaf = enumerated.get(slug)!.fields.get(field)!
      const sample = sampleFor(field, leaf, { ...declaration.probes?.['*'], ...declaration.probes?.[field] })
      const outcome = mapper(slug)(sample)
      assert.notEqual(outcome, 'ok', `${slug}: '${field}' is declared consumed but a result with it set maps to ok`)
      probed++
      // And against a busy, successful run: partial progress must not make a failure read as ok.
      const busy = enumerated.get(slug)!.progress
      if (busy.size > 0) {
        const withProgress = mapper(slug)(merge(busyBaseline(busy), sample))
        assert.notEqual(withProgress, 'ok', `${slug}: '${field}' is masked by progress counters (${[...busy.keys()].join(', ')}): a run that made progress still failed`)
        probedWithProgress++
      }
      // The same field with the route's skip state set: a top-level skip must never mask the failure of a sweep that ran.
      if (declaration.skipState) {
        const skipped = mapper(slug)({ ...sample, ...declaration.skipState })
        assert.notEqual(skipped, 'ok', `${slug}: '${field}' is masked by the skip state ${JSON.stringify(declaration.skipState)} (maps to ${skipped})`)
        assert.notEqual(skipped, 'skipped', `${slug}: '${field}' is masked by the skip state ${JSON.stringify(declaration.skipState)} (maps to ${skipped})`)
        probedWithSkip++
      }
    }
  }
  assert.ok(probed >= 60, `probed ${probed}`)
  assert.ok(probedWithSkip >= 20, `probed with a skip state: ${probedWithSkip}`)
  assert.ok(probedWithProgress >= 40, `probed against a busy successful run: ${probedWithProgress}`)
})

/** More held texts than any display cap (the sweeps cut their lists at 20 or fewer), then one genuine failure, last. */
const HELD_THEN_GENUINE = [
  ...Array.from({ length: 120 }, (_, index) => outboundHeldMessage({ connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: `https://shop.example.test/p/${index}`, hop: 0 })),
  'Storefront WMS-status push failed: HTTP 500',
]

test('every error list a mapping reads: a long run of held errors followed by one genuine failure is still failed (a list cut for display must not decide held)', () => {
  let probed = 0
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    const declaration = cronFailureFields[slug]
    for (const field of declaration.consumed ?? []) {
      if (enumerated.get(slug)!.fields.get(field) !== LEAF.stringArray) continue
      const base = { ...declaration.probes?.['*'], ...declaration.probes?.[field] }
      const sample = merge({ ...base }, objectAt(field, HELD_THEN_GENUINE))
      assert.equal(mapper(slug)(sample), 'failed', `${slug}: '${field}' holding ${HELD_THEN_GENUINE.length - 1} held errors then a genuine one must be failed`)
      // The producer cuts the list: the genuine one is NOT in what the mapping sees, so the mapping needs its own whole-batch count (declared as a consumed count beside the list).
      probed++
    }
  }
  assert.ok(probed >= 10, `probed ${probed} error lists`)
})

test('a busy, successful run on its own is ok (the progress baseline is not itself failing)', () => {
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    const busy = enumerated.get(slug)!.progress
    if (busy.size === 0) continue
    const declaration = cronFailureFields[slug]
    assert.equal(mapper(slug)(merge(busyBaseline(busy), declaration.probes?.['*'] ?? {})), 'ok', `${slug}: a run with every progress counter above zero and nothing failing must be ok`)
  }
})

test('a skip with no failing field is still skipped, and the skip states themselves are skips', () => {
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    const { skipState } = cronFailureFields[slug]
    if (skipState) assert.equal(mapper(slug)(skipState), 'skipped', `${slug}: its declared skip state does not map to skipped`)
  }
})

test('a declared breakdown alone does not fail the run, so it is not counted twice', () => {
  for (const slug of Object.keys(cronOutcomes) as CronOutcomeSlug[]) {
    const declaration = cronFailureFields[slug]
    for (const field of Object.keys(declaration.breakdownOf ?? {})) {
      const leaf = enumerated.get(slug)!.fields.get(field)!
      assert.equal(mapper(slug)(sampleFor(field, leaf)), 'ok', `${slug}: breakdown '${field}' fails the run on its own`)
    }
  }
})

test('a breakdown beside held parents stays held: the real Mintsoft content failure shape', () => {
  const result = { jobId: 'j', status: 'PARTIAL', totalChecked: 1, matched: 0, mismatched: 0, corrected: 0, skipped: 0, errors: 1, outboundHeld: 1, content: { sent: 0, shadowed: 0, held: 0, errors: 1 } }
  assert.equal(mapper('mintsoft-product-verify')(result), 'held')
  assert.equal(mapper('mintsoft-product-verify')({ ...result, errors: 2 }), 'failed')
})

test('the comparison can fail: a new field, a stale entry, a missing reason and a bad breakdown are each reported', () => {
  const fields: Enumerated = new Map([['errors', LEAF.number], ['newFailureCount', LEAF.number]])
  assert.match(diffFieldDeclaration(fields, { consumed: ['errors'] }).join('\n'), /newFailureCount: a failure-like field with no declaration/)
  assert.match(diffFieldDeclaration(fields, { consumed: ['errors', 'newFailureCount', 'gone'] }).join('\n'), /gone: declared but not in the result type/)
  assert.match(diffFieldDeclaration(fields, { consumed: ['errors'], ignored: { newFailureCount: 'x' } }).join('\n'), /reason is too short/)
  assert.match(diffFieldDeclaration(fields, { consumed: ['errors'], breakdownOf: { newFailureCount: 'nothing' } }).join('\n'), /not a consumed field/)
  assert.deepEqual(diffFieldDeclaration(fields, { consumed: ['errors'], breakdownOf: { newFailureCount: 'errors' } }), [])
})

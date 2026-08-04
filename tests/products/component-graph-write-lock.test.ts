import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-t0zq: a component cycle is a property of the GRAPH, not of any one product, so no
 * per-product lock can serialize the writers that form one.
 *
 * Concretely: writer 1 adds B→C and locks {B,C}; writer 2 adds D→A and locks {D,A}. The lock
 * sets are DISJOINT, so neither blocks. Writer 1's walk from C reaches D, which has no
 * children yet; writer 2's walk from A reaches B, which has no children yet. Both cycle checks
 * pass, both commit, and the graph now contains A→B→C→D→A. Locking the named endpoints is not
 * a correctness argument — only a lock covering every component write is.
 *
 * Hence one coarse COMPONENT_GRAPH_WRITE_LOCK_KEY, which is affordable because component edits
 * are rare: a kit or BOM definition changes when a human edits it or a CSV carries a components
 * column, never on a hot path.
 *
 * The behavioural half of this file drives detectComponentCycle for real. The source-level half
 * pins WHERE the lock and the re-check sit, which is the part that rots invisibly — and which a
 * shape-only assertion cannot establish on its own.
 */

type Row = { productId: string; componentId: string }

const state = { edges: [] as Row[], reads: [] as unknown[] }

/**
 * Stands in for the recursive CTE: reachability over `state.edges` from the roots the query was
 * given. Deliberately deduplicates its frontier, exactly as `UNION` does — a mock using an
 * unbounded worklist would hang on the pre-existing-cycle fixture below, which is the same trap
 * `UNION ALL` would be in the real query.
 */
function reachabilityMock(_strings: TemplateStringsArray, ...values: unknown[]) {
  state.reads.push('queryRaw')
  const roots = values[0] as string[]
  const target = values[1] as string
  const seen = new Set<string>()
  const frontier = [...roots]
  while (frontier.length > 0) {
    const current = frontier.shift()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of state.edges) {
      if (edge.productId === current) frontier.push(edge.componentId)
    }
  }
  return seen.has(target) ? [{ reached: true }] : []
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $queryRaw: async (...args: [TemplateStringsArray, ...unknown[]]) => reachabilityMock(...args),
    },
  },
})

async function loadCycle() {
  return (await import('@/lib/products/component-cycle')).detectComponentCycle
}

function reset() {
  state.edges.length = 0
  state.reads.length = 0
}

test('the cycle check walks TRANSITIVELY, so a cycle can close through a third product (o3d-t0zq)', async () => {
  // This is why endpoint locking is insufficient: the check depends on edges belonging to
  // products neither writer names.
  const detectComponentCycle = await loadCycle()
  reset()
  state.edges.push({ productId: 'A', componentId: 'B' }, { productId: 'B', componentId: 'C' })

  // Closing C→A makes A→B→C→A. The walk from A must reach C to see it.
  assert.deepEqual(await detectComponentCycle('C', ['A']), { kind: 'cycle' })
  // An unrelated edge is fine.
  assert.deepEqual(await detectComponentCycle('Z', ['A']), { kind: 'ok' })
})

test('the cycle check reads through the CLIENT it is given (o3d-t0zq)', async () => {
  // Walking through the module-level db from inside a transaction reads on a different
  // connection — outside that transaction's snapshot AND outside the advisory lock it holds —
  // so the check would prove nothing about the graph it is about to commit into.
  const detectComponentCycle = await loadCycle()
  reset()
  state.edges.push({ productId: 'A', componentId: 'B' })

  let txQueries = 0
  const tx = {
    $queryRaw: async (...args: [TemplateStringsArray, ...unknown[]]) => {
      txQueries += 1
      return reachabilityMock(...args)
    },
  }

  state.reads.length = 0
  await detectComponentCycle('B', ['A'], tx as never)
  assert.equal(txQueries, 1, 'the whole walk must be ONE query on the supplied client')
  assert.deepEqual(state.reads, ['queryRaw'], 'and it must not go through the module-level db')
})

test('self-reference is caught before any read (o3d-t0zq)', async () => {
  const detectComponentCycle = await loadCycle()
  reset()
  assert.deepEqual(await detectComponentCycle('A', ['A']), { kind: 'self' })
  assert.deepEqual(state.reads, [], 'a self-reference needs no graph query at all')
})

// --- Where the lock and the re-check sit ---

const PRODUCTS_ACTIONS = path.join(process.cwd(), 'app/actions/products.ts')
const IMPORT_ACTIONS = path.join(process.cwd(), 'app/actions/import.ts')

/**
 * The re-check call, matched with a balanced-paren group. A plain `[^)]*` stops at the INNER
 * paren of `components.map((c) => c.componentId)` and matches nothing — which would make both
 * "runs against tx" assertions pass vacuously.
 */
const CYCLE_CALL_AGAINST_TX = /detectComponentCycle\((?:[^()]|\([^()]*\)|\((?:[^()]|\([^()]*\))*\))*,\s*tx\)/

async function componentWriteBody(file: string, anchor: string): Promise<string> {
  const source = await readFile(file, 'utf8')
  const at = source.indexOf(anchor)
  assert.notEqual(at, -1, `${path.basename(file)} must still contain ${anchor}`)
  return source.slice(at, at + 2200)
}

test('saveProductComponents writes atomically, under the graph lock (o3d-t0zq)', async () => {
  // Its deleteMany and createMany were separate TOP-LEVEL statements — a reader landing
  // between them saw a KIT with no components, and a failure between them left it that way.
  const body = await componentWriteBody(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction')

  assert.match(body, /pg_advisory_xact_lock\(\$\{COMPONENT_GRAPH_WRITE_LOCK_KEY\}\)/, 'it must take the graph lock')
  const lockAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const cycleAt = body.indexOf('detectComponentCycle')
  const deleteAt = body.indexOf('tx.productComponent.deleteMany')
  const createAt = body.indexOf('tx.productComponent.createMany')
  assert.ok([lockAt, cycleAt, deleteAt, createAt].every((i) => i !== -1), 'lock, re-check, delete and create must all be present')
  assert.ok(lockAt < cycleAt, 'the lock must precede the re-check, or the re-check proves nothing')
  assert.ok(cycleAt < deleteAt && deleteAt < createAt, 'the re-check must precede the write, and the write must be one transaction')
  assert.match(body, CYCLE_CALL_AGAINST_TX, 'the re-check must run against tx')
})

test('saveProductComponents refuses a product that is not a kit or BOM (o3d-t0zq)', async () => {
  // It never checked the product's own type at all, so it would write components onto a
  // SIMPLE product — the state o3d-w998 stops the CSV import creating.
  const body = await componentWriteBody(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction')
  assert.match(body, /current\.type !== 'KIT' && current\.type !== 'BOM'/, 'the type must be checked under the lock')
  const source = await readFile(PRODUCTS_ACTIONS, 'utf8')
  assert.match(source, /no longer a kit or BOM/, 'the refusal must be reported to the caller')
})

test('the CSV component pass takes the graph lock BEFORE the per-SKU lock (o3d-t0zq)', async () => {
  // Two lock families in one transaction: a fixed order between them is the deadlock-freedom
  // argument, exactly as the per-SKU family needs internally.
  const body = await componentWriteBody(IMPORT_ACTIONS, 'const wrote = await db.$transaction')
  const graphAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const skuAt = body.indexOf('lockProductSkusForWrite')
  const cycleAt = body.indexOf('detectComponentCycle')
  assert.ok([graphAt, skuAt, cycleAt].every((i) => i !== -1), 'both locks and the re-check must be present')
  assert.ok(graphAt < skuAt, 'the graph lock must be taken first, in one fixed order')
  assert.ok(skuAt < cycleAt, 'the re-check must run once both locks are held')
  assert.match(body, CYCLE_CALL_AGAINST_TX, 'the re-check must run against tx')
})

test('the pre-transaction cycle checks are labelled as preflights (o3d-t0zq)', async () => {
  // Both writers keep a cheap unlocked check so the common rejection returns a clean message.
  // It must be unmistakable that it is NOT the check the write relies on.
  for (const file of [PRODUCTS_ACTIONS, IMPORT_ACTIONS]) {
    const source = await readFile(file, 'utf8')
    assert.match(source, /const preflight = await detectComponentCycle\(/, `${path.basename(file)} must name its unlocked check a preflight`)
  }
})

test('saveProductComponents takes BOTH lock families, graph first (o3d-t0zq)', async () => {
  // The graph lock alone serializes it against other COMPONENT writers, but the editor and the
  // CSV conversion paths take only the PER-SKU lock and so never contend with it. An editor
  // could commit type=SIMPLE and delete the components between the type read and the create,
  // leaving a SIMPLE product with components (Codex review).
  const body = await componentWriteBody(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction')

  const graphAt = body.indexOf('COMPONENT_GRAPH_WRITE_LOCK_KEY')
  const skuAt = body.indexOf('lockProductSkusForWrite')
  const typeAt = body.indexOf("current.type !== 'KIT'")
  assert.ok([graphAt, skuAt, typeAt].every((i) => i !== -1), 'both locks and the type check must be present')
  assert.ok(graphAt < skuAt, 'graph lock first — the same order the CSV pass uses, which is what keeps them deadlock-free')
  assert.ok(skuAt < typeAt, 'the type must be read once BOTH locks are held, or it is still a TOCTOU')
})

test('saveProductComponents verifies the sku its lock set was chosen for (o3d-t0zq)', async () => {
  // `_sku` is read before the transaction. A rename since then means the per-SKU lock is held
  // for a sku this product no longer has — the same lock-set verification every other writer
  // in this protocol needs.
  const body = await componentWriteBody(PRODUCTS_ACTIONS, 'const conflict = await db.$transaction')
  assert.match(body, /current\.sku !== _sku/, 'the chosen lock set must be verified under the lock')
  const source = await readFile(PRODUCTS_ACTIONS, 'utf8')
  assert.match(source, /renamed while saving/, 'a lost lock set must be reported, not silently written through')
})

test('delete-only writers deliberately do NOT take the graph lock (o3d-t0zq)', async () => {
  // Not an oversight: removing edges cannot create a cycle, and taking the graph lock AFTER
  // their per-SKU lock would invert the order and create a deadlock against the writers above.
  // Pinned so a later "consistency" change cannot quietly introduce that inversion.
  const [products, importActions] = await Promise.all([
    readFile(PRODUCTS_ACTIONS, 'utf8'),
    readFile(IMPORT_ACTIONS, 'utf8'),
  ])

  // The editor's clearComponents, inside the per-SKU-locked update transaction.
  const editorAt = products.indexOf('updatedCategoryChange = await db.$transaction')
  const editorBody = products.slice(editorAt, products.indexOf('await logActivity', editorAt))
  assert.match(editorBody, /tx\.productComponent\.deleteMany/, 'the editor must still clear components')
  assert.ok(
    !editorBody.includes('COMPONENT_GRAPH_WRITE_LOCK_KEY'),
    'the editor must NOT take the graph lock after its per-SKU lock — that inverts the order',
  )

  // The CSV rename branch's clearComponents.
  const renameAt = importActions.indexOf('lockProductSkusForWrite(tx, [sku, existingProduct.sku])')
  const renameBody = importActions.slice(renameAt, renameAt + 3400)
  assert.ok(
    !renameBody.includes('COMPONENT_GRAPH_WRITE_LOCK_KEY'),
    'the CSV rename must NOT take the graph lock after its per-SKU lock',
  )
})

test('an empty-string component id is a vertex, not something to filter away (o3d-quia)', async () => {
  // Product.id has no non-empty constraint, and the BFS this replaced treated "" as an
  // ordinary vertex. Dropping it with filter(Boolean) meant an empty-id product with a path
  // back to the parent answered `ok` — a cycle hidden, which is the unsafe direction, and it
  // disproved the "fails closed by construction" claim (Codex review).
  const detectComponentCycle = await loadCycle()
  reset()
  state.edges.push({ productId: '', componentId: 'P' })

  // Adding P -> "" would close P -> "" -> P.
  assert.deepEqual(await detectComponentCycle('P', ['']), { kind: 'cycle' })

  // A genuinely empty request is still a no-op.
  reset()
  assert.deepEqual(await detectComponentCycle('P', []), { kind: 'ok' })
  assert.deepEqual(state.reads, [], 'no roots means no query')
})

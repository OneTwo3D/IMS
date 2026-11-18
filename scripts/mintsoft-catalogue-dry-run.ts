/**
 * MINTSOFT CATALOGUE DRY RUN (o3d-zvec.20): what IMS would send for every eligible product, diffed against the Mintsoft record IMS
 * last stored on each product link.
 *
 *   npx tsx scripts/mintsoft-catalogue-dry-run.ts [--max-lines N] [--show-cost]
 *
 * READ-ONLY: it performs SELECTs only and makes NO call to Mintsoft, so it is safe against any database. It shows the product
 * payload as sent today and with the parity behaviour on, so the owner can see the unexpected diffs before turning
 * `mintsoft_product_parity_enabled` on. Costs are hidden unless `--show-cost` is given (cost is business-sensitive).
 */
import { db } from '@/lib/db'
import { readProductIdentifierSplitEnabled } from '@/lib/domain/products/identifier-split-flag'
import { ELIGIBLE_PRODUCT_WHERE, PRODUCT_SYNC_CANDIDATE_SELECT } from '@/lib/connectors/mintsoft/sync/product-sync'
import { readMintsoftProductCost } from '@/lib/connectors/mintsoft/sync/product-parity'
import { compareProductToStored, renderDryRun, type DryRunProductResult } from '@/lib/connectors/mintsoft/sync/catalogue-dry-run'

async function main() {
  const args = process.argv.slice(2)
  const maxIndex = args.indexOf('--max-lines')
  const maxLines = maxIndex >= 0 ? Number(args[maxIndex + 1]) : 200
  const showCost = args.includes('--show-cost')
  const split = await readProductIdentifierSplitEnabled()
  const results: DryRunProductResult[] = []
  let cursor: string | undefined
  for (;;) {
    const batch = await db.product.findMany({
      where: ELIGIBLE_PRODUCT_WHERE,
      orderBy: { id: 'asc' },
      take: 200,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: PRODUCT_SYNC_CANDIDATE_SELECT,
    })
    if (batch.length === 0) break
    for (const product of batch) {
      const link = product.wmsProductLinks[0]
      const metadata = link ? await db.wmsProductLink.findUnique({ where: { id: link.id }, select: { metadata: true } }) : null
      const costPrice = await readMintsoftProductCost(product.id, product.type)
      results.push(compareProductToStored({ product, storedRecord: metadata?.metadata ?? null, costPrice }, { split, showCost }))
    }
    cursor = batch[batch.length - 1]!.id
  }
  console.log(renderDryRun(results, { maxLines }))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())

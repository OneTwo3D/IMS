/**
 * Rendering of the validation report: JSON for machines, Markdown for people, and the plain accounting table for the terminal.
 * Pure and deterministic: the text depends only on the report (and the explicit `mode`), never on a clock.
 */
import type { PrepareReport } from './transform'

export function renderJson(report: PrepareReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

function cell(value: string | number): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function table(header: string[], rows: Array<Array<string | number>>): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ]
}

const MAX_LISTED = 200
const MAX_SKUS_PER_PATTERN = 25

export function renderAccountingTable(report: PrepareReport): string {
  const rows = report.accounting
  const widths = [
    Math.max('Dataset'.length, ...rows.map((r) => r.dataset.length)),
    ...['Read', 'Emitted', 'Excluded', 'Rejected', 'Unaccounted'].map((h) => h.length),
  ]
  const line = (cols: Array<string | number>) => cols.map((c, i) => (i === 0 ? String(c).padEnd(widths[0]) : String(c).padStart(widths[i]))).join('  ')
  const total = rows.reduce(
    (t, r) => ({ read: t.read + r.recordsRead, emitted: t.emitted + r.emitted, excluded: t.excluded + r.excluded, rejected: t.rejected + r.rejected, unaccounted: t.unaccounted + r.unaccounted }),
    { read: 0, emitted: 0, excluded: 0, rejected: 0, unaccounted: 0 },
  )
  return [
    line(['Dataset', 'Read', 'Emitted', 'Excluded', 'Rejected', 'Unaccounted']),
    ...rows.map((r) => line([r.dataset, r.recordsRead, r.emitted, r.excluded, r.rejected, r.unaccounted])),
    line(['TOTAL', total.read, total.emitted, total.excluded, total.rejected, total.unaccounted]),
    report.accountingBalanced ? 'Row accounting balances: every record read is emitted, excluded or rejected exactly once.' : 'ROW ACCOUNTING DOES NOT BALANCE (a defect in the tool; nothing was written).',
  ].join('\n')
}

export function renderMarkdown(report: PrepareReport, mode: { dryRun: boolean }): string {
  const out: string[] = []
  const blocked = report.verdict === 'BLOCKED'
  out.push('# First-load validation report', '')
  out.push(`- Run id: ${report.runId ?? '(none given)'}`)
  out.push(`- Mode: ${mode.dryRun ? 'dry run (no file was written)' : 'write'}`)
  out.push(`- Verdict: **${report.verdict}**`)
  out.push(`- Base currency: ${report.config.baseCurrency}; as-of date: ${report.config.asOf ?? '(none)'}; in-transit convention: ${report.config.inTransitConvention ?? '(none)'}`)
  out.push(`- Limits applied per import file: at most ${report.config.maxRowsPerFile} data rows and ${report.config.maxBytesPerFile} bytes (the importers accept 10,000 rows and 10 MiB)`)
  out.push('')
  if (blocked) {
    out.push('**No import file is produced for a BLOCKED run.** Fix the rejected records and errors below and run again; nothing in this report has been loaded anywhere.', '')
  } else {
    out.push(
      mode.dryRun
        ? 'No blocking finding was found in the datasets supplied. This is a dry run, so no import file was written.'
        : 'No blocking finding was found in the datasets supplied. The import files listed below were written.',
      'That statement covers ONLY the datasets listed under "Inputs"; see "Not supplied" and "Checks" for what was not examined.',
      '',
    )
  }

  out.push('## Inputs', '')
  out.push(...table(['Dataset', 'File', 'SHA-256', 'Bytes', 'Records read', 'Blank lines', 'BOM', 'Source columns not read'], report.inputs.map((i) => [i.dataset, i.file, i.sha256, i.bytes, i.recordsRead, i.blankRows, i.hadBom ? 'yes (stripped)' : 'no', i.unmappedHeaders.join(', ') || '-'])), '')
  out.push('## Not supplied', '')
  out.push(report.notSupplied.length === 0 ? 'Every dataset was supplied.' : `These datasets were NOT supplied, so nothing about them was checked: ${report.notSupplied.join(', ')}.`, '')
  out.push('## Checks', '', ...table(['Check', 'Status', 'Note'], report.checks.map((c) => [c.check, c.status, c.note])), '')

  out.push('## Row accounting', '')
  out.push('Every record read ends in exactly one of: emitted (in an import file, or, for datasets that only feed checks, used), excluded with a reason, or rejected with a reason.', '')
  out.push(...table(['Dataset', 'Read', 'Emitted', 'Excluded', 'Rejected', 'Unaccounted'], report.accounting.map((r) => [r.dataset, r.recordsRead, r.emitted, r.excluded, r.rejected, r.unaccounted])), '')
  out.push(report.accountingBalanced ? 'The identity read = emitted + excluded + rejected holds for every dataset.' : '**The row-accounting identity FAILED.** This is a defect in the tool.', '')
  out.push('### By reason', '', ...table(['Dataset', 'Outcome', 'Code', 'Count'], report.accountingByCode.map((r) => [r.dataset, r.outcome, r.code, r.count])), '')

  out.push('## Findings', '')
  if (report.findings.length === 0) out.push('None.', '')
  for (const finding of report.findings) {
    out.push(`- **${finding.severity}** \`${finding.code}\`${finding.dataset ? ` (${finding.dataset})` : ''}: ${finding.message}`)
    if (finding.keys && finding.keys.length > 0) {
      out.push(`  - ${finding.keys.slice(0, MAX_LISTED).join(', ')}${finding.keys.length > MAX_LISTED ? `, and ${finding.keys.length - MAX_LISTED} more (see the JSON report)` : ''}`)
    }
  }
  out.push('')
  if (report.selfCheckFailures.length > 0) {
    out.push('### Self-check failures (a defect in the tool)', '', ...report.selfCheckFailures.map((f) => `- ${f}`), '')
  }

  const rejected = report.dispositions.filter((d) => d.outcome === 'REJECTED')
  const excluded = report.dispositions.filter((d) => d.outcome === 'EXCLUDED')
  out.push('## Rejected records', '')
  if (rejected.length === 0) out.push('None.', '')
  else out.push(...table(['Dataset', 'Line', 'Key', 'Code', 'Reason'], rejected.slice(0, MAX_LISTED).map((d) => [d.dataset, d.line, d.key, d.code, d.reason])), '', ...(rejected.length > MAX_LISTED ? [`${rejected.length - MAX_LISTED} more rejected record(s): see the JSON report.`, ''] : []))
  out.push('## Excluded records', '')
  if (excluded.length === 0) out.push('None.', '')
  else out.push(...table(['Dataset', 'Line', 'Key', 'Code', 'Reason'], excluded.slice(0, MAX_LISTED).map((d) => [d.dataset, d.line, d.key, d.code, d.reason])), '', ...(excluded.length > MAX_LISTED ? [`${excluded.length - MAX_LISTED} more excluded record(s): see the JSON report.`, ''] : []))

  const s = report.stock
  out.push('## Opening stock: lots collapsed to one weighted average per SKU and warehouse', '')
  out.push(...table(['Measure', 'Value (base currency)'], [
    ['Lot quantity read (positive lots)', s.totals.lotQty],
    ['Lot total (sum of quantity x unit cost, exact)', s.totals.lotTotalBase],
    ['Collapsed total (average rounded to 6 dp x quantity)', s.totals.collapsedTotalBase],
    ['Rounding residual (collapsed minus lot)', s.totals.roundingResidualBase],
    ['Opening quantity emitted (after the in-transit rule)', s.totals.openingQty],
    ['Opening value emitted', s.totals.openingValueBase],
  ]), '')
  const interesting = s.groups.filter((g) => g.lots > 1 || g.roundingResidualBase !== '0' || g.inTransitQty !== '0')
  if (interesting.length > 0) {
    out.push('Groups that merged several lots, carry a rounding residual or carry in-transit stock:', '')
    out.push(...table(['SKU', 'Warehouse', 'Lots', 'Lot qty', 'Lot total', 'Average (6 dp)', 'Collapsed total', 'Residual', 'In transit', 'Opening qty'], interesting.slice(0, MAX_LISTED).map((g) => [g.sku, g.warehouseCode, g.lots, g.lotQty, g.lotTotalBase, g.averageUnitCostBase, g.collapsedTotalBase, g.roundingResidualBase, g.inTransitQty, g.openingQty])), '')
    if (interesting.length > MAX_LISTED) out.push(`${interesting.length - MAX_LISTED} more group(s): see the JSON report.`, '')
  }
  out.push('### Zero on hand (the extract has a row and it says zero)', '', s.zeroOnHand.length === 0 ? 'None.' : `${s.zeroOnHand.length} SKU(s): ${s.zeroOnHand.slice(0, MAX_LISTED).join(', ')}${s.zeroOnHand.length > MAX_LISTED ? ', ...' : ''}`, '')
  out.push('### Missing from the extract (no row at all)', '')
  if (s.missingFromExtract.length === 0) out.push('None.', '')
  else out.push(...table(['SKU', 'Holds stock in the 3PL', '3PL quantity'], s.missingFromExtract.slice(0, MAX_LISTED).map((m) => [m.sku, m.holdsStockElsewhere === null ? 'unknown (3PL stock not supplied)' : m.holdsStockElsewhere ? 'YES' : 'no', m.wmsQty ?? '-'])), '')

  out.push('## R14 four-way SKU coverage', '', 'Q = Qoblex products, L = the 3PL (WMS), W = WooCommerce, I = SKUs already in IMS.', '')
  if (report.coverage.patterns.length === 0) out.push('Not run.', '')
  else {
    out.push(...table(['Present in', 'SKUs', 'First SKUs'], report.coverage.patterns.map((p) => [p.pattern, p.count, `${p.skus.slice(0, MAX_SKUS_PER_PATTERN).join(', ')}${p.skus.length > MAX_SKUS_PER_PATTERN ? ', ...' : ''}`])), '')
    out.push(`SKUs in Q, M or W that will not exist in IMS and are not excluded: ${report.coverage.notLoadedAndNotExcluded.length}`, `SKUs on the accepted exclusion list that were found in an input: ${report.coverage.excludedAccepted.length}`, '')
  }

  out.push('## Recipes', '', report.recipes.cycles.length === 0 ? 'No cycle found.' : `${report.recipes.cycles.length} cycle(s) found: ${report.recipes.cycles.map((c) => c.join(' -> ')).join('; ')}`, '')
  out.push('## Purchase orders and transfers', '')
  out.push(`- Purchase orders emitted: ${report.purchaseOrders.orders} (${report.purchaseOrders.linesEmitted} line(s)); orders with nothing outstanding: ${report.purchaseOrders.ordersNothingOutstanding}`)
  out.push(`- Transfers emitted: ${report.transfers.transfers} (${report.transfers.linesEmitted} line(s))`, '')

  out.push('## Import files', '')
  out.push(`Rows each importer file set would contain: ${Object.entries(report.plannedOutputRows).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '')
  out.push(`Warehouse codes the files use (each must already exist in IMS; the tool cannot check): ${report.warehouseCodesUsed.join(', ') || '(none)'}.`, '')
  out.push(report.outputs.length === 0 ? 'No import file was produced by this run.' : 'Load them in the order of the numeric prefix; wait for each file\'s dry-run preview to be clean before the real import.', '')
  if (report.outputs.length > 0) out.push(...table(['File', 'Importer', 'Rows', 'Bytes', 'SHA-256'], report.outputs.map((f) => [f.name, f.target, f.rows, f.bytes, f.sha256])), '')
  return `${out.join('\n')}\n`
}

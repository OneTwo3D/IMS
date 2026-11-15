/**
 * THE COMMAND LINE OF `npm run eu-vat:shadow`, WITHOUT ITS SIDE EFFECTS: argument parsing, usage, the exit codes and the rendering. Pure. Same style as lib/tax/eu-vat-cli.ts: the account is judged by uid,
 * the environment is a short whitelist, an argument that looks like a credential is refused unseen, and everything printed about a refusal is a closed code.
 *
 * What is printed about an order: its number, a status, and the compared figures (account code, TaxType, line amount, tax amount, the VAT line, the total). Never a name, email, address, description,
 * response object or credential.
 */
import { accountAllowed, buildPackEnv } from '@/lib/reconciliation-pack/cli'
import { SHADOW_NOTHING_COMPARED_MESSAGE, SHADOW_DEFAULT_MAX_ORDERS, SHADOW_HARD_MAX_ORDERS, shadowExitCode, type ShadowOrderResult, type ShadowReport, type ShadowSelection } from '@/lib/tax/eu-vat-shadow-run'
import type { LineRow } from '@/lib/domain/accounting/eu-vat-shadow-compare'

export { accountAllowed }

/** The whitelist of the reconciliation pack for a run that reads vendors: the base set, the key that decrypts the stored credentials and the variables the Xero tenant guard judges the connection by. */
export const buildEuVatShadowEnv = (parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> => buildPackEnv(parent, home, true)

export const EU_VAT_SHADOW_COMMAND = 'npm run eu-vat:shadow'

export const EU_VAT_SHADOW_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not the ones this command takes (run with --help)',
  LIVE_READ_REQUIRED: 'this command reads the real Xero invoices and WooCommerce orders; it refuses to run without the explicit --live-read flag',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the report failed before it reached an outcome; nothing was written (this command never writes)',
} as const
export type EuVatShadowCliCode = keyof typeof EU_VAT_SHADOW_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ORDER_REF = /^[A-Za-z0-9._-]{1,64}$/

export type EuVatShadowArgs = { selection: ShadowSelection | null; maxOrders: number; json: boolean; help: boolean; liveRead: boolean }

export function parseEuVatShadowArgs(argv: readonly string[]): EuVatShadowArgs | { code: EuVatShadowCliCode } {
  const bad = (arg: string | undefined): { code: EuVatShadowCliCode } => ({ code: arg !== undefined && CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' })
  const flags = new Set<string>()
  let orders: string[] | null = null
  let from: string | null = null
  let to: string | null = null
  let max: number | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--orders' || arg === '--from' || arg === '--to' || arg === '--max') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return bad(value)
      if (CREDENTIAL_SHAPE.test(value)) return { code: 'CREDENTIAL_ARGUMENT' }
      if (arg === '--orders') {
        const refs = value.split(',').map((ref) => ref.trim())
        if (orders !== null || refs.length === 0 || refs.some((ref) => !ORDER_REF.test(ref))) return bad(undefined)
        orders = refs
      } else if (arg === '--from' || arg === '--to') {
        if (!ISO_DATE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) return bad(undefined)
        if (arg === '--from') { if (from !== null) return bad(undefined); from = value } else { if (to !== null) return bad(undefined); to = value }
      } else {
        if (max !== null || !/^\d{1,4}$/.test(value)) return bad(undefined)
        const n = Number(value)
        if (n < 1 || n > SHADOW_HARD_MAX_ORDERS) return bad(undefined)
        max = n
      }
      i += 1
      continue
    }
    if (arg !== '--json' && arg !== '--help' && arg !== '--live-read') return bad(arg)
    if (flags.has(arg)) return bad(undefined)
    flags.add(arg)
  }
  const help = flags.has('--help')
  let selection: ShadowSelection | null = null
  if (orders !== null && (from !== null || to !== null)) return bad(undefined)
  if (orders !== null) selection = { kind: 'orders', refs: orders }
  else if (from !== null || to !== null) {
    if (from === null || to === null || from > to) return bad(undefined)
    selection = { kind: 'range', from, to }
  }
  if (!help && selection === null) return bad(undefined)
  const maxOrders = max ?? SHADOW_DEFAULT_MAX_ORDERS
  if (selection?.kind === 'orders' && selection.refs.length > maxOrders) return bad(undefined)
  return { selection, maxOrders, json: flags.has('--json'), help, liveRead: flags.has('--live-read') }
}

export const EU_VAT_SHADOW_EXIT_CODES = [
  { code: 0, name: 'all-match', meaning: 'Every chosen EU order matched the Xero invoice exactly.' },
  { code: 1, name: 'not-all-match', meaning: 'At least one order differs, needs review (a boundary-FX order that differs), was refused by IMS, has no Xero invoice or could not be compared, or the selection was cut short. A review order is accepted by a person, not by this code.' },
  { code: 4, name: 'nothing-compared', meaning: 'No EU order was compared (every selected order was non-EU, or none was found). An empty comparison is not an acceptance pass.' },
  { code: 3, name: 'refused-or-internal', meaning: 'The command did not start or failed (bad argument, --live-read missing, account not allowed, database not given). Nothing was compared.' },
] as const

export function renderEuVatShadowUsage(): string {
  return [
    `Usage: ${EU_VAT_SHADOW_COMMAND} -- --live-read (--orders <id-or-number>[,<id-or-number>...] | --from YYYY-MM-DD --to YYYY-MM-DD) [--max N] [--json]`,
    '',
    'THE SHADOW COMPARISON. For the chosen EU orders it builds, in memory, the sales invoice IMS WOULD post (the real payload builder, the EU IOSS/VOEC/DDP treatment forced on for this build only) and compares it with the',
    'invoice Xero actually holds, per line (account code, TaxType, line amount, tax amount), the VAT line and the total. It is built, switched off: it never changes the Sales Invoices switch or any setting.',
    '',
    'READ ONLY. It performs GET requests only (Xero: the invoice by number and by id; WooCommerce: the order by id) and reads the IMS database. It never enqueues, writes, posts, stamps, logs or settles anything.',
    '--live-read is REQUIRED: it is the operator\'s statement that reading the live Xero organisation and the live store is intended. Run it only when the owner has said to.',
    '',
    '--orders   IMS order ids or storefront order numbers, comma separated.',
    '--from/--to  IMS orders created in the range (inclusive, UTC dates).',
    `--max      the most orders read (default ${SHADOW_DEFAULT_MAX_ORDERS}, hard ceiling ${SHADOW_HARD_MAX_ORDERS}). A selection larger than this is cut and reported as truncated.`,
    '',
    'Only the order number and the compared figures are printed: no customer name, email, address, description or response body.',
    '',
    'Statuses: match | differs | review (a boundary-FX order that differs: reviewed, not auto-corrected) | no Xero doc | IMS refused (with the reason) | not comparable.',
    '',
    'Exit codes:',
    ...EU_VAT_SHADOW_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
  ].join('\n')
}

export const euVatShadowExitCode = shadowExitCode

const STATUS_LABEL: Record<ShadowOrderResult['status'], string> = {
  match: 'MATCH', differs: 'DIFFERS', review: 'REVIEW', no_xero_doc: 'NO XERO DOC', ims_refused: 'IMS REFUSED', not_comparable: 'NOT COMPARABLE',
}

const cell = (side: LineRow['ims']): string => (side === null ? '-' : `${side.accountCode} ${side.taxType} ${side.lineAmount} tax ${side.taxAmount ?? '?'}`)

function renderOrder(result: ShadowOrderResult): string[] {
  const head = `Order ${result.orderNumber}: ${STATUS_LABEL[result.status]}${result.boundary ? ' (boundary FX order)' : ''}`
  const lines = [head]
  if (result.detail !== null) lines.push(`  ${result.detail}`)
  if (result.route !== null) lines.push(`  route ${result.route}${result.regime ? ` ${result.regime}` : ''}; stamp ${result.stampSource === 'stored' ? 'already on the order' : result.stampSource === 'provisional' ? 'decided in memory (nothing stamped)' : 'none needed'}${result.warningCodes.length > 0 ? `; warnings: ${result.warningCodes.join(', ')}` : ''}`)
  const comparison = result.comparison
  if (comparison !== null) {
    lines.push(`  Xero status ${result.xeroStatus ?? '?'}; currency ${comparison.currencyMatch ? 'matches' : 'DIFFERS'}`)
    lines.push('  #  kind      IMS (account type net tax)                    Xero (account type net tax)                   verdict')
    comparison.lines.forEach((row, index) => {
      lines.push(`  ${String(index + 1).padEnd(2)} ${(row.kind ?? '').padEnd(9)} ${cell(row.ims).padEnd(45)} ${cell(row.xero).padEnd(45)} ${row.verdict}${row.fields.length > 0 ? ` (${row.fields.join(', ')})` : ''}${row.taxNotCompared ? ' [tax not compared]' : ''}`)
    })
    if (comparison.vatLine.present) lines.push(`  VAT line on ${comparison.vatLine.account}: IMS ${comparison.vatLine.ims}, Xero ${comparison.vatLine.xero ?? 'none'} (${comparison.vatLine.match ? 'match' : 'DIFFERS'})`)
    lines.push(`  Total: IMS ${comparison.total.ims ?? 'not stated'}, Xero ${comparison.total.xero ?? 'not stated'} (${comparison.total.compared ? (comparison.total.match ? 'match' : 'DIFFERS') : 'not compared'})`)
  }
  return lines
}

export function renderEuVatShadowText(report: ShadowReport): string {
  const c = report.counts
  const out: string[] = [
    'EU VAT shadow report. Read only: GET requests and IMS reads; nothing was enqueued, written, posted or stamped.',
    '',
  ]
  for (const result of report.results) out.push(...renderOrder(result), '')
  out.push(
    `Summary (${report.results.length} compared): match ${c.match}, differs ${c.differs}, review ${c.review}, no Xero doc ${c.no_xero_doc}, IMS refused ${c.ims_refused}, not comparable ${c.not_comparable}.`,
  )
  if (c.ims_refused > 0) {
    out.push('IMS refusals:')
    for (const result of report.results) if (result.status === 'ims_refused') out.push(`  ${result.orderNumber}: ${result.detail ?? ''}`)
  }
  if (report.skippedNotEu > 0) out.push(`Skipped, not an EU destination: ${report.skippedNotEu}.`)
  if (report.unresolved.length > 0) out.push(`Not found in IMS (or without a WooCommerce link): ${report.unresolved.join(', ')}.`)
  if (report.results.length === 0) out.push(SHADOW_NOTHING_COMPARED_MESSAGE + '.')
  if (report.truncated) out.push(`The selection was larger than --max ${report.maxOrders}: only the first ${report.maxOrders} were read.`)
  return out.join('\n')
}

/** The JSON a run prints: the same fields, nothing else. */
export function euVatShadowJson(report: ShadowReport): unknown {
  return { maxOrders: report.maxOrders, truncated: report.truncated, unresolved: report.unresolved, skippedNotEu: report.skippedNotEu, counts: report.counts, results: report.results }
}

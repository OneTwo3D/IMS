/**
 * THE COMMAND LINE OF `npm run vat:diff`, WITHOUT ITS SIDE EFFECTS: argument parsing, the environment a run keeps, the exit codes and the
 * rendering. Pure. Same style as lib/reconciliation-pack/cli.ts: the account is judged by uid, the environment is a short whitelist, an
 * argument that looks like a credential is refused unseen, and everything printed about a refusal is a closed code.
 */

import { accountAllowed, KEPT_ENV } from '@/lib/reconciliation-pack/cli'
import { VAT_DIFFERENCE_REASONS, VAT_DIFFERENCE_REASON_LIST, type VatDifference, type VatDifferenceReport } from '@/lib/tax/vat-difference-report'
import { VAT_SCHEMES, VAT_SCHEME_TITLES, type VatScheme, type VatSchemeBucket } from '@/lib/tax/vat-scheme'

export const VAT_DIFF_COMMAND = 'npm run vat:diff'

export const VAT_DIFF_EXIT_CODES = [
  { code: 0, name: 'no-differences', meaning: 'All three systems were read and proven, and they use the same set of VAT rates.' },
  { code: 1, name: 'differences', meaning: 'All three systems were read and proven, and a scheme report (or the unclassified section) lists a difference. ANY difference anywhere gives 1.' },
  { code: 2, name: 'refused', meaning: 'A side could not be read or proven (the stored Xero list, the IMS data or WooCommerce). Nothing was compared: this is NOT "no differences".' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed (bad argument, account not allowed, database not given). Nothing was compared.' },
] as const

export const VAT_DIFF_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not exactly "--json", "--help" and/or "--scheme uk|ioss|voec|other|all" (no other argument is accepted)',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the report failed before it reached an outcome; treat as not compared',
} as const
export type VatDiffCliCode = keyof typeof VAT_DIFF_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i

export type VatSchemeSelection = VatScheme | 'all'
export type VatDiffArgs = { json: boolean; help: boolean; scheme: VatSchemeSelection }

export function parseVatDiffArgs(argv: readonly string[]): VatDiffArgs | { code: VatDiffCliCode } {
  const flags = new Set<string>()
  let scheme: VatSchemeSelection | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--scheme') {
      const value = argv[i + 1]
      if (scheme !== null || value === undefined || !([...VAT_SCHEMES, 'all'] as readonly string[]).includes(value)) return { code: value !== undefined && CREDENTIAL_SHAPE.test(value) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
      scheme = value as VatSchemeSelection
      i += 1
      continue
    }
    if (arg !== '--json' && arg !== '--help') return { code: CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
    if (flags.has(arg)) return { code: 'BAD_ARGUMENTS' }
    flags.add(arg)
  }
  return { json: flags.has('--json'), help: flags.has('--help'), scheme: scheme ?? 'all' }
}

/** The scheme sections a selection shows. The unclassified section is ALWAYS included: a rate nobody could classify might belong to the scheme asked for. */
export function selectedBuckets(selection: VatSchemeSelection): VatSchemeBucket[] {
  return selection === 'all' ? [...VAT_SCHEMES, 'unclassified'] : [selection, 'unclassified']
}

/** The only variables a run keeps: the pack's base set, plus the keys that decrypt the stored storefront credentials. Never a PG variable, a grant or a loader variable. */
export const VAT_DIFF_KEPT_ENV = [...KEPT_ENV, 'SETTINGS_ENCRYPTION_KEY', 'ENCRYPTION_KEY'] as const

export function buildVatDiffEnv(parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home }
  for (const name of VAT_DIFF_KEPT_ENV) {
    const value = parent[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

export { accountAllowed }

/** Each shown scheme report contributes its own status; any difference in any of them gives 1. */
export function vatDiffExitCode(report: VatDifferenceReport, selection: VatSchemeSelection = 'all'): 0 | 1 | 2 {
  if (report.status === 'refused') return 2
  return selectedBuckets(selection).some((bucket) => report.schemes[bucket].differences.length > 0) ? 1 : 0
}

/** The JSON a run prints: keyed by scheme (only the selected ones and unclassified), no flat duplicate of the rows. */
export function vatDiffJson(report: VatDifferenceReport, selection: VatSchemeSelection = 'all'): unknown {
  if (report.status === 'refused') return report
  const schemes = Object.fromEntries(selectedBuckets(selection).map((bucket) => [bucket, { title: VAT_SCHEME_TITLES[bucket], exitStatus: report.schemes[bucket].differences.length === 0 ? 0 : 1, ...report.schemes[bucket] }]))
  return { status: report.status, xero: report.xero, ims: report.ims, woo: report.woo, schemes }
}

export function renderVatDiffUsage(): string {
  return [
    `Usage: ${VAT_DIFF_COMMAND} [-- --scheme uk|ioss|voec|other|all] [--json]`,
    '',
    'Read-only. Compares the VAT rates in Xero (the stored, proven copy of its list), IMS (tax rates, components, storefront mappings) and WooCommerce',
    '(GET /wp-json/wc/v3/taxes, every page, with the stored credentials) and lists every difference with a reason code, as four reports, one per VAT scheme (UK, IOSS, VOEC, other foreign),',
    'plus an unclassified section for any rate whose scheme cannot be told (shown with every selection). --scheme limits the output to one scheme (default all). It writes nothing anywhere.',
    '',
    'Exit codes:',
    ...VAT_DIFF_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
    'Reason codes:',
    ...VAT_DIFFERENCE_REASON_LIST.map((reason) => `  ${reason}: ${VAT_DIFFERENCE_REASONS[reason]}`),
  ].join('\n')
}

function renderRow(difference: VatDifference): string {
  const values = [['xero', difference.xero], ['ims', difference.ims], ['woo', difference.woo]].filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`).join(' ')
  const ids = [difference.xeroTaxType && `xero:${difference.xeroTaxType}`, difference.imsRateId && `ims:${difference.imsRateId}`, difference.wooRateId && `woo:${difference.wooRateId}`].filter(Boolean).join(' ')
  const region = difference.region === null ? '' : `  (region, information only: ${difference.region})`
  return `  ${difference.reason}  ${difference.label}  [${ids}]${values ? `  ${values}` : ''}${region}  <${difference.schemeSource}>`
}

export function renderVatDiffText(report: VatDifferenceReport, selection: VatSchemeSelection = 'all'): string {
  if (report.status === 'refused') {
    return [`REFUSED: ${report.code}${report.wooReason ? ` (${report.wooReason})` : ''}`, report.detail, 'Nothing was compared. This is not "no differences".'].join('\n')
  }
  const lines = [
    `Xero: ${report.xero.types} tax types (${report.xero.active} active), read ${report.xero.fetchedAt}`,
    `IMS: ${report.ims.activeRates} active tax rates, ${report.ims.mappings} WooCommerce mappings`,
    `WooCommerce: ${report.woo.rates} tax rates`,
  ]
  for (const bucket of selectedBuckets(selection)) {
    const section = report.schemes[bucket]
    if (bucket === 'unclassified' && section.differences.length === 0) continue
    lines.push('', `== ${VAT_SCHEME_TITLES[bucket]}: ${section.differences.length === 0 ? 'no differences' : `${section.differences.length} difference(s)`}`)
    for (const difference of section.differences) lines.push(renderRow(difference))
  }
  if (selectedBuckets(selection).every((bucket) => report.schemes[bucket].differences.length === 0)) lines.push('', 'No differences: the selected schemes use the same set of VAT rates in all three systems.')
  return lines.join('\n')
}

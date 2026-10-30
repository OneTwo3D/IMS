/**
 * THE COMMAND LINE OF `npm run woo:tax-plan`, WITHOUT ITS SIDE EFFECTS: argument parsing, the environment a run keeps, exit codes and rendering. Pure. Same shape as `npm run tax:rekey`
 * (lib/tax/tax-rekey-cli.ts): the account is judged by uid, the environment is a short whitelist, an argument that looks like a credential is refused unseen, and what is printed about a
 * refusal is a closed code.
 */
import { PRODUCER_CUTOFF_ENV, PRODUCER_HOLD_ENFORCED_ENV } from '@/lib/security/producer-disposition-constants'
import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'
import { accountAllowed, buildVatDiffEnv } from '@/lib/tax/vat-difference-cli'
import { DELETE_REASONS, WOO_TAX_BLOCKER_CODES, WOO_TAX_FINDING_CODES, type WooTaxChange, type WooTaxPlan } from './tax-rate-plan'
import { WOO_TAX_REFUSALS, type WooTaxApplyResult, type WooTaxHold, type WooTaxPreview } from './tax-rate-writer'

export const WOO_TAX_PLAN_COMMAND = 'npm run woo:tax-plan'
export { accountAllowed }

export const WOO_TAX_PLAN_EXIT_CODES = [
  { code: 0, name: 'nothing-to-do', meaning: 'The store already matches IMS (nothing to change), or an apply finished (with the hold on, it recorded shadows and sent nothing).' },
  { code: 1, name: 'plan-lists-work', meaning: 'A preview, and the plan lists changes, blockers or findings. Nothing was written and nothing was sent.' },
  { code: 2, name: 'refused', meaning: 'A side could not be read, or the apply was refused (missing or wrong digest, hold not enforced, blocker, busy), or the store refused a change. Nothing further was sent.' },
  { code: 3, name: 'internal', meaning: 'The command could not start or failed (bad argument, account not allowed, database not given).' },
] as const

export const WOO_TAX_PLAN_CLI_CODES = {
  BAD_ARGUMENTS: 'the arguments are not exactly "--apply --confirm <64-hex digest>", "--json" and/or "--help" (--confirm needs --apply and --apply needs --confirm)',
  CREDENTIAL_ARGUMENT: 'an argument looks like it carries a credential; no credential is ever taken from the command line',
  ACCOUNT_NOT_ALLOWED: 'the account running the command is neither root nor the owner of the checkout',
  DATABASE_URL_MISSING: 'DATABASE_URL is not set',
  INTERNAL: 'the command failed before it reached an outcome; nothing is known to have been written unless the output says so',
} as const
export type WooTaxPlanCliCode = keyof typeof WOO_TAX_PLAN_CLI_CODES

const CREDENTIAL_SHAPE = /[a-z][a-z0-9+.-]*:\/\/|[?&=](?:password|passwd|pwd|secret|token|key)|(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]/i

export type WooTaxPlanArgs = { apply: boolean; confirm: string | null; json: boolean; help: boolean }

export function parseWooTaxPlanArgs(argv: readonly string[]): WooTaxPlanArgs | { code: WooTaxPlanCliCode } {
  const flags = new Set<string>()
  let confirm: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--confirm') {
      const value = argv[i + 1]
      if (confirm !== null || value === undefined || !/^[0-9a-f]{64}$/.test(value)) return { code: value !== undefined && CREDENTIAL_SHAPE.test(value) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
      confirm = value
      i += 1
      continue
    }
    if (arg !== '--apply' && arg !== '--json' && arg !== '--help') return { code: CREDENTIAL_SHAPE.test(arg) ? 'CREDENTIAL_ARGUMENT' : 'BAD_ARGUMENTS' }
    if (flags.has(arg)) return { code: 'BAD_ARGUMENTS' }
    flags.add(arg)
  }
  const apply = flags.has('--apply')
  if (apply !== (confirm !== null)) return { code: 'BAD_ARGUMENTS' }
  return { apply, confirm, json: flags.has('--json'), help: flags.has('--help') }
}

/** The variables the producer hold is read from. The run replaces the rest of its environment, so these are handed over explicitly, and ONLY these. */
export const WOO_HOLD_ENV_NAMES = [PRODUCER_HOLD_ENFORCED_ENV, OUTBOUND_GRANT_ENV.woocommerce, PRODUCER_CUTOFF_ENV.woocommerce] as const

export function pickWooHoldEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of WOO_HOLD_ENV_NAMES) {
    const value = Object.prototype.hasOwnProperty.call(source, name) ? source[name] : undefined
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** The environment a run keeps: the VAT report's whitelist plus the hold variables, so the application's own barriers read the same hold as the command. */
export function buildWooTaxPlanEnv(parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  return { ...buildVatDiffEnv(parent, home), ...pickWooHoldEnv(parent) }
}

export type WooTaxPlanRun = { args: WooTaxPlanArgs; preview: WooTaxPreview | null; applied: WooTaxApplyResult | null }

export function wooTaxPlanExitCode(run: WooTaxPlanRun): 0 | 1 | 2 {
  if (run.applied !== null) {
    const result = run.applied
    if (result.outcome === 'REFUSED') return 2
    if (result.outcome === 'NOTHING_TO_DO') return 0
    return result.failed !== null || result.sentButUnrecorded !== null ? 2 : 0
  }
  const preview = run.preview
  if (preview === null || preview.plan === null) return 2
  const plan = preview.plan
  return plan.changes.length === 0 && plan.blockers.length === 0 && plan.findings.length === 0 ? 0 : 1
}

export function renderWooTaxPlanUsage(): string {
  return [
    `Usage: ${WOO_TAX_PLAN_COMMAND} -- [--apply --confirm <digest>] [--json]`,
    'Plans (and, on request, applies) the changes WooCommerce needs so that its tax rates are the same set as the IMS sales rates (R13, the VAT set-identity check): create a missing rate,',
    'update one whose name, percent, country, region, class, compound or shipping differs, delete one mapped to an inactive, purchase-only or reverse-charge IMS rate (or a second counterpart).',
    'Shipping carries the goods\' VAT rate: always on for a positive rate. A WooCommerce rate that IMS does not own (not mapped in the tax-rate mapping and not created by this command) is never touched.',
    '',
    'Without --apply it is a read-only PREVIEW: it prints the plan and its digest, reads IMS and WooCommerce (GET only) and writes nothing. With --apply --confirm <digest> (the digest the preview',
    'printed) it applies exactly that plan, behind the producer hold: while WooCommerce is held (the producer-side hold enforced, no outbound grant, no live-from instant) it records SHADOWS and sends',
    'NOTHING; it is refused outright when the hold is not enforced. Only when the hold is released and IMS owns the operation (P2) does it send, one change at a time, recording each with its',
    'mapping row in one transaction. A re-run after success has nothing to do.',
    '',
    'Exit codes:',
    ...WOO_TAX_PLAN_EXIT_CODES.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
  ].join('\n')
}

function describeChange(change: WooTaxChange): string {
  const rate = `"${change.imsRateName}"`
  switch (change.kind) {
    case 'CREATE': {
      const a = change.after
      return `  CREATE  ${rate}: ${a.name} ${a.rate}% country ${a.country || '(any)'} state ${a.state || '(any)'} class ${a.class} compound ${a.compound} shipping ${a.shipping}${change.staleWooIds.length > 0 ? `  [mapping rows to ids the store no longer has: ${change.staleWooIds.join(', ')}]` : ''}`
    }
    case 'UPDATE':
      return `  UPDATE  ${rate} (store rate ${change.wooId}): ${change.fields.map((f) => `${f.field} ${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`).join('; ')}`
    case 'DELETE': {
      const b = change.before
      return `  DELETE  ${rate} (store rate ${change.wooId}: ${b.name} ${b.rate}% ${b.country || '(any)'}): ${DELETE_REASONS[change.reason]}`
    }
    case 'REFRESH_MAPPING':
      return `  REFRESH_MAPPING  ${rate} (store rate ${change.wooId}): the stored mapping row is stale; IMS bookkeeping only, nothing is sent`
  }
}

function renderPlan(plan: WooTaxPlan): string[] {
  const lines = [
    `IMS: ${plan.inScopeRates} in-scope sales rate(s). WooCommerce: ${plan.wooRates} rate(s) read, ${plan.unownedLeftAlone} not owned (never touched).`,
    `Changes: ${(['CREATE', 'UPDATE', 'DELETE', 'REFRESH_MAPPING'] as const).map((kind) => `${kind}=${plan.counts[kind]}`).join(' ')}`,
  ]
  if (plan.changes.length > 0) lines.push('', ...plan.changes.map(describeChange))
  for (const blocker of plan.blockers) lines.push('', `BLOCKER ${blocker.code}: IMS rate ${blocker.imsRateId}, store rate ${blocker.wooId}: ${WOO_TAX_BLOCKER_CODES[blocker.code]}`)
  for (const finding of plan.findings) lines.push(`FINDING ${finding.code}${finding.wooId ? ` store rate ${finding.wooId}` : ''}${finding.imsRateId ? ` IMS rate ${finding.imsRateId}` : ''}: ${WOO_TAX_FINDING_CODES[finding.code]}`)
  lines.push('', `Plan digest: ${plan.digest}`)
  return lines
}

export function renderWooTaxPlanText(run: WooTaxPlanRun, hold: WooTaxHold): string {
  const lines: string[] = []
  const plan = run.applied !== null ? run.applied.plan : run.preview?.plan ?? null
  if (run.preview !== null && run.preview.refused !== null) lines.push(`REFUSED: ${run.preview.refused}`, WOO_TAX_REFUSALS[run.preview.refused], 'Nothing was compared.')
  if (run.applied !== null && run.applied.outcome === 'REFUSED') lines.push(`REFUSED: ${run.applied.code}`, WOO_TAX_REFUSALS[run.applied.code], 'Nothing was sent.')
  if (plan !== null) lines.push(...(lines.length > 0 ? [''] : []), ...renderPlan(plan))
  lines.push('', `WooCommerce hold: ${hold.mode.toUpperCase()} - ${hold.detail}`)
  const applied = run.applied
  if (applied !== null && applied.outcome === 'NOTHING_TO_DO') lines.push('', 'Applied: nothing to change (a re-run changes nothing).')
  if (applied !== null && applied.outcome === 'DONE') {
    lines.push('')
    if (applied.shadowed.length > 0) lines.push(`SHADOW: ${applied.shadowed.length} change(s) recorded as outbound shadows; NOTHING was sent to WooCommerce and no rate or mapping row was written.${applied.shadowUnrecorded > 0 ? ` ${applied.shadowUnrecorded} shadow record(s) could not be written.` : ''}`)
    if (applied.applied.length > 0) lines.push(`Applied: ${applied.applied.length} change(s) sent and recorded.`)
    if (applied.failed !== null) lines.push(`STOPPED at ${applied.failed.key}: WooCommerce refused it (${applied.failed.error}). Earlier changes stay applied; preview again for the rest.`)
    if (applied.sentButUnrecorded !== null) lines.push(`STOPPED at ${applied.sentButUnrecorded}: the change was sent but could not be recorded. Preview again: a rate created this way shows as an UNMAPPED_TWIN blocker until it is mapped.`)
    if (applied.applied.length > 0) lines.push('Run npm run vat:diff to confirm the differences are gone.')
  }
  return lines.join('\n')
}

export function wooTaxPlanJson(run: WooTaxPlanRun, hold: WooTaxHold): unknown {
  return { hold, preview: run.preview, applied: run.applied }
}

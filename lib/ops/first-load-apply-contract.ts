/**
 * WHAT THE READINESS GATE EXPECTS OF A PUBLISHED FIRST-LOAD APPLY REPORT, written down on the gate's side.
 *
 * The apply runner's own constants live in lib/first-load/apply/, a tree the system-import census treats as the system-actor capability: nothing outside the runner
 * may import from it (scripts/check-system-import-capability.mjs). The gate therefore carries the CONTRACT as data of its own, and
 * tests/ops/readiness-gate-first-load.test.ts proves it equal to the runner's constants in both directions, so a change to the runner's report that is not made here
 * turns that test red instead of silently loosening or breaking the gate.
 *
 * Constants only, no imports.
 */

/** The apply report format the gate reads (lib/first-load/apply/constants.ts APPLY_REPORT_FORMAT_VERSION). */
export const APPLY_REPORT_CONTRACT_FORMAT_VERSION = 2

/** The exit a successful apply reports (APPLY_EXIT_CODES.OK). */
export const APPLY_REPORT_CONTRACT_EXIT_OK = { name: 'OK', code: 0 } as const

/** The run record's statuses (RUN_STATUSES) and the only one that speaks for a finished, verified load. */
export const APPLY_RUN_STATUSES = [
  'RUNNING',
  'STEP_FAILED',
  'CONFLICT',
  'APPLIED',
  'VERIFIED',
  'VERIFY_FAILED',
] as const
export const APPLY_RUN_STATUS_VERIFIED = 'VERIFIED'

/** The verification items every apply report carries, each once (VERIFICATION_IDS in lib/first-load/apply/verify-core.ts). */
export const APPLY_VERIFICATION_IDS = [
  'accounting-identity',
  'row-chain-to-prepared-report',
  'final-readback',
  'rails-after-load',
  'stock-totals',
  'opening-movements',
  'stock-levels-equal-layers',
  'invariants',
  'bom-recipe-drift',
  'purchase-orders-draft',
  'base-currency',
  'migrations-applied',
  'outbound-held',
  'no-held-writes',
  'no-queue-growth',
  'census-baseline',
  'write-census',
] as const

/** The ids of `preconditions[]`, in order (PRECONDITION_IDS): every rail, then every apply-time check. */
export const APPLY_PRECONDITION_IDS = [
  'rail:quiesce',
  'rail:data-classes',
  'rail:base-currency',
  'rail:forbidden-skus',
  'rail:currency-lock',
  'rail:warehouses',
  'rail:fx-rates',
  'rail:tax-rates',
  'rail:outbound-grants',
  'rail:producer-hold',
  'rail:connectors',
  'rail:crons',
  'check:barcode-free',
  'check:base-currency',
  'check:lookup-keys-unique-in-ims',
  'check:opening-stock-empty',
  'check:po-fx-rate',
  'check:po-product-lifecycle',
  'check:po-reference-free',
  'check:po-supplier-exists',
  'check:po-tax-rate',
  'check:product-parent-exists',
  'check:transfer-reference-free',
  'check:transfer-source-stock',
  'check:warehouse-exists',
] as const

/** The preconditions that are evaluated in every apply and so must read `pass`, never `not-applicable`. */
export const APPLY_ALWAYS_PASS_PRECONDITIONS = [
  'rail:quiesce',
  'rail:data-classes',
  'rail:base-currency',
  'rail:outbound-grants',
  'rail:producer-hold',
  'rail:connectors',
  'rail:crons',
] as const

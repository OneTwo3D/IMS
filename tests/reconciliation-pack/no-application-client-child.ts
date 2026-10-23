// A child process that loads the pack's runtime modules (the command included) and reports whether the application's database client exists.
const modules = [
  '../../scripts/reconciliation-pack.ts',
  '../../lib/reconciliation-pack/basis.ts',
  '../../lib/reconciliation-pack/default-ports.ts',
  '../../lib/reconciliation-pack/ledger-items.ts',
  '../../lib/reconciliation-pack/run.ts',
  '../../lib/reconciliation-pack/ims-readers.ts',
  '../../lib/reconciliation-pack/liveness.ts',
  '../../lib/reconciliation-pack/vendor-items.ts',
  '../../lib/reconciliation-pack/woo-source.ts',
  '../../lib/reconciliation-pack/woo-transport.ts',
  '../../lib/reconciliation-pack/woo-credentials.ts',
  '../../lib/reconciliation-pack/xero-source.ts',
  '../../lib/reconciliation-pack/xero-transport.ts',
  '../../lib/reconciliation-pack/xero-credentials.ts',
  '../../lib/reconciliation-pack/vat-item.ts',
  '../../lib/reconciliation-pack/trend.ts',
  '../../lib/ops/readiness-gate-pack.ts',
]
async function main(): Promise<void> {
  for (const specifier of modules) await import(specifier)
  const holder = globalThis as unknown as { prisma?: unknown }
  console.log(JSON.stringify({ modules: modules.length, applicationClient: holder.prisma !== undefined }))
  process.exit(0)
}
void main()

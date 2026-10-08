/**
 * The in-application half of the fresh-install rehearsal (scripts/rehearse-first-install.ts).
 *
 * It asks the application's OWN code, through the application's own database client, whether the
 * base currency is locked, which a SQL query written beside the rehearsal could not: the rule lives
 * in lib/base-currency.ts and a second copy of it would be a second answer. Run as a child process
 * so it reads the rehearsal's DATABASE_URL from its environment, exactly as the application would.
 *
 * Prints one line, `REHEARSAL_PROBE {json}`, and exits 0; any failure is a thrown error and exit 1.
 */
import { getBaseCurrencyCode, isBaseCurrencyLocked } from '@/lib/base-currency'
import { db } from '@/lib/db'

async function main(): Promise<void> {
  try {
    const locked = await isBaseCurrencyLocked()
    const baseCurrencyCode = await getBaseCurrencyCode()
    console.log(`REHEARSAL_PROBE ${JSON.stringify({ locked, baseCurrencyCode })}`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

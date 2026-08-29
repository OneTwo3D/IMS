export async function register() {
  const { assertProductionCronSecretConfigured } = await import('./lib/cron-secret-validation')
  assertProductionCronSecretConfigured()

  // o3d-2k5r r19 — ASK THIS DEPLOYMENT WHETHER IT CAN CARRY A NON-ASCII SCHEMA NAME, here, because
  // this is the only asynchronous point that exists before anything imports `lib/db` (whose
  // adapter and pool config are composed at module scope, synchronously). Next.js runs `register()`
  // once, before the server handles a request.
  //
  // Nothing is opened for the ordinary URL: `nonAsciiStartupOptionCharacters()` reads the raw
  // `?schema=`/`?options=` values and returns '' for every ASCII one, so a deployment that has
  // never used such a name pays nothing. Where there IS one, the probe measures whether this
  // server's tokenizer carries those bytes and the refusal in `lib/db/database-url-schema.mjs`
  // either lifts or names the rename procedure — see the block above
  // `establishStartupOptionByteSafety()` for why a measurement is the only thing that can settle it.
  const { establishStartupOptionByteSafety, nonAsciiStartupOptionCharacters } = await import('./lib/db/database-url-schema.mjs')
  if (nonAsciiStartupOptionCharacters(process.env.DATABASE_URL) !== '') {
    await establishStartupOptionByteSafety(process.env.DATABASE_URL)
  }
}

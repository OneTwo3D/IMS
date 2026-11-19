// Reports whether the database DATABASE_URL names is encoded UTF8 (o3d-rb9l4).
//
// Run by scripts/update.sh as the application user, with the connection string the migration will
// use. It is ADVISORY: update.sh warns on a non-UTF8 database and carries on, because an existing
// SQL_ASCII installation is live data and the migrations that need UTF8 name themselves when they
// fail. So it EXITS 0 WHATEVER IT FINDS and prints one verdict line: `UTF8`, `NOT_UTF8 <encoding>`
// or `UNKNOWN <why>`. Only a crash of the script itself is a non-zero exit.
import pg from 'pg'

const verdict = async () => {
  const url = process.env.DATABASE_URL
  if (!url) return 'UNKNOWN DATABASE_URL is not set'
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000 })
  try {
    await client.connect()
    const { rows } = await client.query('SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = current_database()')
    const encoding = rows[0]?.encoding
    if (!encoding) return 'UNKNOWN the encoding of the current database could not be read'
    return encoding === 'UTF8' ? 'UTF8' : `NOT_UTF8 ${encoding}`
  } catch (error) {
    return `UNKNOWN ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`
  } finally {
    await client.end().catch(() => {})
  }
}

console.log(await verdict())

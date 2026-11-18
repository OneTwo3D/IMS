import { db } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth/server'
import { handleProductCsvDownload } from '@/lib/products/csv-roundtrip/download-handler'

/** POST: the pre-filled "Edit by CSV" file for a selection and a set of columns. See the handler. */
export async function POST(req: Request) {
  return handleProductCsvDownload(req, { requireApiAuth, client: db })
}

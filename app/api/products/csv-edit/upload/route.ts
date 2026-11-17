import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireApiAuth } from '@/lib/auth/server'
import { handleProductCsvUpload } from '@/lib/products/csv-roundtrip/upload-handler'

/** POST (multipart: file, mode = preview | apply): the upload half of "Edit by CSV". See the handler. */
export async function POST(req: Request) {
  return handleProductCsvUpload(req, {
    requireApiAuth,
    client: db,
    logActivity,
    revalidateInventory: () => revalidatePath('/inventory'),
  })
}

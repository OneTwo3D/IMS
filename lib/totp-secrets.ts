import { db } from '@/lib/db'
import { decryptSecret, encryptSecret, hasEncryptionKey, isEncryptedValue } from '@/lib/secrets'

type TotpRow = {
  id: string
  totpSecret: string | null
  pendingTotpSecret: string | null
}

async function migrateIfNeeded(row: TotpRow, field: 'totpSecret' | 'pendingTotpSecret', value: string) {
  if (!hasEncryptionKey() || isEncryptedValue(value)) return
  try {
    await db.user.update({
      where: { id: row.id },
      data: { [field]: encryptSecret(value) },
    })
  } catch {
    // Best-effort migration only.
  }
}

export async function readTotpSecrets(userId: string): Promise<{ totpSecret: string | null; pendingTotpSecret: string | null } | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, totpSecret: true, pendingTotpSecret: true },
  })
  if (!row) return null

  const totpSecret = row.totpSecret ? decryptSecret(row.totpSecret) : null
  const pendingTotpSecret = row.pendingTotpSecret ? decryptSecret(row.pendingTotpSecret) : null

  if (row.totpSecret && totpSecret) await migrateIfNeeded(row, 'totpSecret', totpSecret)
  if (row.pendingTotpSecret && pendingTotpSecret) await migrateIfNeeded(row, 'pendingTotpSecret', pendingTotpSecret)

  return { totpSecret, pendingTotpSecret }
}

export function serializeTotpSecret(secret: string | null): string | null {
  if (!secret) return null
  return encryptSecret(secret)
}

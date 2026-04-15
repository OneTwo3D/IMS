import { randomBytes } from 'crypto'
import { consumeAuthToken, setAuthToken } from '@/lib/auth/token-store'
import { sendEmail } from '@/lib/mailer'

const DESTRUCTIVE_ACTION_TOKEN_TTL_MS = 5 * 60_000

type ConfirmPurpose = 'backup_restore' | 'backup_delete' | 'database_reset'

function makeTokenKey(purpose: ConfirmPurpose, token: string) {
  return `destructive:${purpose}:${token}`
}

export async function issueDestructiveActionCode(params: {
  purpose: ConfirmPurpose
  userId: string
  email: string
  subject: string
  intro: string
}): Promise<{ success: true; email: string; expiresInSec: number } | { success: false; error: string }> {
  const token = randomBytes(4).toString('hex').toUpperCase()
  await setAuthToken(makeTokenKey(params.purpose, token), params.userId, DESTRUCTIVE_ACTION_TOKEN_TTL_MS)

  const mail = await sendEmail({
    to: params.email,
    subject: params.subject,
    html: `
      <p>${params.intro}</p>
      <p>Use this confirmation code to continue:</p>
      <p style="font-size:24px;font-weight:700;letter-spacing:0.2em;"><code>${token}</code></p>
      <p>This code expires in 5 minutes and can be used only once.</p>
      <p>If you did not request this, review admin access immediately.</p>
    `,
  })

  if (!mail.success) {
    return { success: false, error: mail.error ?? 'Failed to send confirmation email.' }
  }

  return { success: true, email: params.email, expiresInSec: DESTRUCTIVE_ACTION_TOKEN_TTL_MS / 1000 }
}

export async function consumeDestructiveActionCode(params: {
  purpose: ConfirmPurpose
  token: string
  userId: string
}): Promise<boolean> {
  const consumed = await consumeAuthToken(makeTokenKey(params.purpose, params.token.trim().toUpperCase()))
  return consumed === params.userId
}

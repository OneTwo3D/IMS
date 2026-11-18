'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { freshAuthFailureResult, requireFreshAdmin } from '@/lib/auth/server'
import type { FreshAuthFailureResult } from '@/lib/auth/session-gates'
import { assertPaymentRegistrationNeverExisted, PaymentRegistrationAssertionRefused, type PaymentRegistrationAssertionRefusalCode } from '@/lib/domain/accounting/payment-registration-assertion'

export type AssertRegistrationNeverExistedResult =
  | { success: true }
  | { success: false; error: string; code: PaymentRegistrationAssertionRefusalCode }
  | FreshAuthFailureResult

/**
 * o3d-5fx28: an ADMIN (fresh session) asserts that a retired payment registration never existed in the accounting system. The audit row
 * and the stamp are one transaction; see lib/domain/accounting/payment-registration-assertion.ts for the row class and what it clears.
 */
export async function assertPaymentRegistrationNeverExistedAction(
  syncLogId: string,
  orderId: string,
  reason: string,
): Promise<AssertRegistrationNeverExistedResult> {
  try {
    const session = await requireFreshAdmin()
    await db.$transaction(
      (tx) => assertPaymentRegistrationNeverExisted(tx, { syncLogId, orderId, reason, actorUserId: session.user.id }),
      { maxWait: 5000, timeout: 30000 },
    )
    revalidatePath(`/sales/${orderId}`)
    return { success: true }
  } catch (error) {
    if (error instanceof PaymentRegistrationAssertionRefused) return { success: false, error: error.message, code: error.code }
    const freshAuthFailure = freshAuthFailureResult(error)
    if (freshAuthFailure) return freshAuthFailure
    throw error
  }
}

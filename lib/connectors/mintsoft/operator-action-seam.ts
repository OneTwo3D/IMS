/**
 * THE WORDS OF THE MINTSOFT OPERATOR ACTIONS FOR WORK THE PRODUCER-SIDE HOLD KEPT AS A SHADOW.
 *
 * They live here and not in app/actions/mintsoft-sync.ts because a 'use server' file may export only async server actions, and a
 * helper exported from it would become a callable endpoint. Both return an empty string when nothing was shadowed, so a run on
 * an installation that does not enforce the hold reads exactly as it always did.
 */

/** A shadowed product upsert is NOT an update: the verify run says so, and does not count it as one. */
export function describeShadowedProducts(shadowed: number | undefined): string {
  if (!shadowed || shadowed <= 0) return ''
  return ` ${shadowed} product${shadowed === 1 ? '' : 's'} NOT sent to Mintsoft: writes are held on this installation, so IMS recorded what it would have written and sent nothing.`
}

export function describeShadowedBundles(shadowed: number | undefined): string {
  if (!shadowed || shadowed <= 0) return ''
  return ` ${shadowed} bundle${shadowed === 1 ? '' : 's'} NOT created in Mintsoft: writes are held on this installation, so IMS recorded what it would have written and sent nothing.`
}

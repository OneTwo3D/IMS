import { runWmsDispatchSweep } from '@/lib/domain/wms/dispatch-sweep'
import { getMintsoftPollAuthStatus } from '@/lib/connectors/mintsoft/api/auth'
import { withMintsoftNoLogin } from '@/lib/connectors/mintsoft/api/auth-no-login'

/**
 * The scheduled Mintsoft despatch poll, with its authentication made READ-ONLY.
 *
 * The poll is on by default and runs unattended, so it must be unable to do the one thing about Mintsoft
 * authentication that is a write: logging in with a username and password replaces the tenant's API key for
 * every integration that shares it. With a fixed key (or an unexpired stored key) it runs. Otherwise it declines
 * BEFORE any request and says why, and inside the sweep a 401 never triggers a login either.
 */
export async function runMintsoftDispatchPoll(): Promise<unknown> {
  const status = await getMintsoftPollAuthStatus()
  if (!status.ok) return { skipped: true, reason: status.reason }
  return withMintsoftNoLogin(() => runWmsDispatchSweep('cron'))
}

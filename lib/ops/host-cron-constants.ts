/**
 * The wording of the container-mode pending state. Dependency-free on purpose: the save-outcome text is reachable from client
 * components, so this file imports nothing.
 */
export const HOST_CRON_INSTALL_PATH = '/etc/cron.d/onetwo3d-ims'

export const HOST_CRON_PENDING_PREFIX = 'Host cron update pending:'

/** What a save reports in container mode: a pending state, never a success. */
export const HOST_CRON_PENDING_MESSAGE =
  `${HOST_CRON_PENDING_PREFIX} the host must re-render and install ${HOST_CRON_INSTALL_PATH}. The container cannot change host cron. `
  + 'Run render-managed-crontab.mjs --format cron.d from the image and install its output as that file, root:root, mode 0644 '
  + '(the exact command is in deploy/README.md, "Cron runs on the host, not in the container"). Until then host cron keeps the previous schedule.'

export function isHostCronPendingError(error: string): boolean {
  return error.startsWith(HOST_CRON_PENDING_PREFIX)
}


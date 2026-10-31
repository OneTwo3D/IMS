/**
 * What the Sentry SDK (v11) may collect on its own, shared by the server, edge and browser init.
 * This is the v11 replacement for `sendDefaultPii: false`: no user info, cookies, request/response
 * bodies, DB query data, queue arguments or stack-frame variables, and an allowlist of harmless headers. Whatever
 * is still collected goes through `scrubEvent` before it leaves the process.
 */
export const dataCollection = {
  userInfo: false,
  cookies: false,
  // OAuth callbacks carry code/state in the query string; never collect it (scrub strips it as well).
  urlQueryParams: false,
  httpBodies: [] as Array<'incomingRequest' | 'outgoingRequest' | 'incomingResponse' | 'outgoingResponse'>,
  // Explicit ALLOWLIST: only these harmless headers are ever collected (webhook signatures, auth and
  // anything custom are never listed). Referer is deliberately absent (its query string is not safe).
  httpHeaders: {
    request: { allow: ['user-agent', 'content-type', 'content-length', 'accept', 'accept-language', 'x-request-id'] },
    response: { allow: ['content-type', 'content-length'] },
  },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

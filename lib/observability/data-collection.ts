/**
 * What the Sentry SDK (v11) may collect on its own, shared by the server, edge and browser init.
 * This is the v11 replacement for `sendDefaultPii: false`: no user info, cookies, request/response
 * bodies, DB query data, queue arguments or stack-frame variables, and no client-IP headers. Whatever
 * is still collected goes through `scrubEvent` before it leaves the process.
 */
export const dataCollection = {
  userInfo: false,
  cookies: false,
  httpBodies: [] as Array<'incomingRequest' | 'outgoingRequest' | 'incomingResponse' | 'outgoingResponse'>,
  httpHeaders: {
    request: { deny: ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded'] },
    response: true,
  },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

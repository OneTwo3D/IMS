/**
 * What the Sentry SDK (v11) may collect on its own, shared by the server, edge and browser init.
 * This is the v11 replacement for `sendDefaultPii: false`. EVERY option of the SDK's `DataCollection`
 * type is set explicitly to its most restrictive useful value, so no present or future default can
 * silently open a collection path. Whatever is still collected goes through the scrubbers first.
 */
export const dataCollection = {
  // No user.* fields from instrumentation.
  userInfo: false,
  cookies: false,
  // OAuth callbacks carry code/state in the query string; never collect it (scrub strips it as well).
  urlQueryParams: false,
  // Explicit ALLOWLIST: only these harmless headers are ever collected (webhook signatures, auth and
  // anything custom are never listed). Referer is deliberately absent (its query string is not safe).
  httpHeaders: {
    request: { allow: ['user-agent', 'content-type', 'content-length', 'accept', 'accept-language', 'x-request-id'] },
    response: { allow: ['content-type', 'content-length'] },
  },
  // No request/response bodies of any kind.
  httpBodies: [] as Array<'incomingRequest' | 'outgoingRequest' | 'incomingResponse' | 'outgoingResponse'>,
  graphQL: { document: false, variables: false },
  // IMS sends product text to an LLM: never record prompts or completions (the v11 default is true).
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  // Source lines around each frame are code, not data; kept at the SDK default so stack traces stay readable.
  frameContextLines: 5,
}

export type LimitedRequestBodyResult =
  | { ok: true; body: string; byteLength: number }
  | { ok: false; response: Response }

export type ReadLimitedRequestBodyOptions = {
  maxBytes: number
  timeoutMs?: number
  emptyBodyAllowed?: boolean
  tooLargeMessage?: string
  emptyBodyMessage?: string
  invalidContentLengthMessage?: string
  timeoutMessage?: string
}

const DEFAULT_TOO_LARGE_MESSAGE = 'Request body is too large.'
const DEFAULT_EMPTY_BODY_MESSAGE = 'Request body is required.'
const DEFAULT_INVALID_CONTENT_LENGTH_MESSAGE = 'Invalid Content-Length header.'
const DEFAULT_TIMEOUT_MESSAGE = 'Request body read timed out.'

type DeclaredContentLength =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'too-large' }
  | { kind: 'value'; value: number }

function declaredContentLength(headers: Headers): DeclaredContentLength {
  const raw = headers.get('content-length')?.trim()
  if (!raw) return { kind: 'absent' }

  const values = raw.split(',').map((value) => value.trim())
  if (values.some((value) => !/^\d+$/.test(value))) return { kind: 'invalid' }
  if (values.some((value) => !Number.isSafeInteger(Number(value)))) return { kind: 'too-large' }

  const [first, ...rest] = values
  if (!first || rest.some((value) => value !== first)) return { kind: 'invalid' }
  return { kind: 'value', value: Number(first) }
}

export async function readLimitedRequestBody(
  request: Request,
  options: ReadLimitedRequestBodyOptions,
): Promise<LimitedRequestBodyResult> {
  const maxBytes = options.maxBytes
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('readLimitedRequestBody: maxBytes must be a positive integer.')
  }

  const declaredLength = declaredContentLength(request.headers)
  if (declaredLength.kind === 'invalid') {
    return {
      ok: false,
      response: Response.json(
        { error: options.invalidContentLengthMessage ?? DEFAULT_INVALID_CONTENT_LENGTH_MESSAGE },
        { status: 400 },
      ),
    }
  }
  if (declaredLength.kind === 'too-large' || (declaredLength.kind === 'value' && declaredLength.value > maxBytes)) {
    return {
      ok: false,
      response: Response.json(
        { error: options.tooLargeMessage ?? DEFAULT_TOO_LARGE_MESSAGE },
        { status: 413 },
      ),
    }
  }

  if (!request.body) {
    if (options.emptyBodyAllowed) return { ok: true, body: '', byteLength: 0 }
    return {
      ok: false,
      response: Response.json(
        { error: options.emptyBodyMessage ?? DEFAULT_EMPTY_BODY_MESSAGE },
        { status: 400 },
      ),
    }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let cancelled = false

  try {
    while (true) {
      const readResult = await readWithTimeout(reader, options.timeoutMs)
      if (!readResult.ok) {
        cancelled = true
        await reader.cancel().catch(() => undefined)
        return {
          ok: false,
          response: Response.json(
            { error: options.timeoutMessage ?? DEFAULT_TIMEOUT_MESSAGE },
            { status: 408 },
          ),
        }
      }

      const { done, value } = readResult.value
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        cancelled = true
        await reader.cancel().catch(() => undefined)
        return {
          ok: false,
          response: Response.json(
            { error: options.tooLargeMessage ?? DEFAULT_TOO_LARGE_MESSAGE },
            { status: 413 },
          ),
        }
      }
      chunks.push(value)
    }
  } finally {
    if (!cancelled) {
      try {
        reader.releaseLock()
      } catch {
        // Some stream implementations release the lock during teardown.
      }
    }
  }

  if (totalBytes === 0 && !options.emptyBodyAllowed) {
    return {
      ok: false,
      response: Response.json(
        { error: options.emptyBodyMessage ?? DEFAULT_EMPTY_BODY_MESSAGE },
        { status: 400 },
      ),
    }
  }

  // Decode with replacement semantics: malformed UTF-8 is rejected later by
  // HMAC mismatch after verifier re-encodes the substituted string.
  const body = new TextDecoder().decode(concatChunks(chunks, totalBytes))
  return { ok: true, body, byteLength: totalBytes }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number | undefined,
): Promise<
  | { ok: true; value: ReadableStreamReadResult<Uint8Array> }
  | { ok: false }
> {
  if (!timeoutMs) return { ok: true, value: await reader.read() }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('readLimitedRequestBody: timeoutMs must be a positive integer.')
  }

  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read().then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false }), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

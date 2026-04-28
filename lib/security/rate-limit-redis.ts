import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import type { RateLimitBackend, RateLimitResult } from './rate-limit'

type RedisValue = string | number | null | RedisValue[]

type ParsedRedisValue = {
  value: RedisValue
  nextOffset: number
}

function encodeRedisCommand(parts: string[]): Buffer {
  return Buffer.from(`*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`)
}

function findLineEnd(buffer: Buffer, offset: number): number {
  return buffer.indexOf('\r\n', offset, 'utf8')
}

function parseRedisValue(buffer: Buffer, offset = 0): ParsedRedisValue | null {
  if (offset >= buffer.length) return null
  const type = String.fromCharCode(buffer[offset])
  const lineEnd = findLineEnd(buffer, offset + 1)
  if (lineEnd === -1) return null
  const line = buffer.toString('utf8', offset + 1, lineEnd)
  const payloadOffset = lineEnd + 2

  if (type === '+') return { value: line, nextOffset: payloadOffset }
  if (type === ':') return { value: Number(line), nextOffset: payloadOffset }
  if (type === '-') throw new Error(`Redis error: ${line}`)

  if (type === '$') {
    const length = Number(line)
    if (length === -1) return { value: null, nextOffset: payloadOffset }
    const end = payloadOffset + length
    if (buffer.length < end + 2) return null
    return { value: buffer.toString('utf8', payloadOffset, end), nextOffset: end + 2 }
  }

  if (type === '*') {
    const length = Number(line)
    if (length === -1) return { value: null, nextOffset: payloadOffset }
    const values: RedisValue[] = []
    let currentOffset = payloadOffset
    for (let i = 0; i < length; i += 1) {
      const parsed = parseRedisValue(buffer, currentOffset)
      if (!parsed) return null
      values.push(parsed.value)
      currentOffset = parsed.nextOffset
    }
    return { value: values, nextOffset: currentOffset }
  }

  throw new Error(`Unsupported Redis response type "${type}"`)
}

function redisConnectionOptions(redisUrl: string) {
  const url = new URL(redisUrl)
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://')
  }

  return {
    url,
    tls: url.protocol === 'rediss:',
    host: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'rediss:' ? 6380 : 6379),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    db: url.pathname.length > 1 ? url.pathname.slice(1) : '',
  }
}

async function runRedisCommands(redisUrl: string, commands: string[][]): Promise<RedisValue[]> {
  const options = redisConnectionOptions(redisUrl)
  const setupCommands: string[][] = []

  if (options.password) {
    setupCommands.push(options.username
      ? ['AUTH', options.username, options.password]
      : ['AUTH', options.password])
  }
  if (options.db) setupCommands.push(['SELECT', options.db])

  const allCommands = [...setupCommands, ...commands]
  const expectedResponses = allCommands.length

  return await new Promise((resolve, reject) => {
    const socket = options.tls
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port })

    let buffer = Buffer.alloc(0)
    const responses: RedisValue[] = []
    let settled = false

    const timeout = setTimeout(() => {
      finish(new Error('Redis rate-limit command timed out'))
    }, 5_000)

    function finish(error?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve(responses.slice(setupCommands.length))
    }

    function writeCommands() {
      for (const command of allCommands) socket.write(encodeRedisCommand(command))
    }

    socket.once(options.tls ? 'secureConnect' : 'connect', writeCommands)
    socket.on('error', (error) => finish(error))
    socket.on('data', (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk])
        let offset = 0
        while (responses.length < expectedResponses) {
          const parsed = parseRedisValue(buffer, offset)
          if (!parsed) break
          responses.push(parsed.value)
          offset = parsed.nextOffset
        }
        if (offset > 0) buffer = buffer.subarray(offset)
        if (responses.length === expectedResponses) finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function redisKey(key: string): string {
  return `rate-limit:${key}`
}

function numberValue(value: RedisValue): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

export class RedisRateLimitBackend implements RateLimitBackend {
  constructor(private readonly redisUrl: string) {}

  async check(key: string, max = 5, windowMs = 5 * 60_000): Promise<RateLimitResult> {
    const now = Date.now()
    const cutoff = now - windowMs
    const bucketKey = redisKey(key)

    const [, countRaw] = await runRedisCommands(this.redisUrl, [
      ['ZREMRANGEBYSCORE', bucketKey, '-inf', String(cutoff)],
      ['ZCARD', bucketKey],
    ])
    const count = numberValue(countRaw)

    if (count >= max) {
      const [oldestRaw, ttlRaw] = await runRedisCommands(this.redisUrl, [
        ['ZRANGE', bucketKey, '0', '0', 'WITHSCORES'],
        ['PTTL', bucketKey],
      ])
      const oldestScore = Array.isArray(oldestRaw) ? numberValue(oldestRaw[1] ?? now) : now
      const retryFromScore = Math.max(1, Math.ceil((oldestScore + windowMs - now) / 1000))
      const ttl = numberValue(ttlRaw)
      const retryAfterSec = ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : retryFromScore
      return { allowed: false, retryAfterSec, remaining: 0 }
    }

    const member = `${now}:${randomUUID()}`
    const [, , updatedCountRaw] = await runRedisCommands(this.redisUrl, [
      ['ZADD', bucketKey, String(now), member],
      ['PEXPIRE', bucketKey, String(windowMs)],
      ['ZCARD', bucketKey],
    ])
    const updatedCount = numberValue(updatedCountRaw)
    return { allowed: true, retryAfterSec: 0, remaining: Math.max(0, max - updatedCount) }
  }

  async clear(key: string): Promise<void> {
    await runRedisCommands(this.redisUrl, [['DEL', redisKey(key)]])
  }
}

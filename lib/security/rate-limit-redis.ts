import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import type { RateLimitBackend, RateLimitResult } from './rate-limit'

type RedisValue = string | number | null | RedisValue[]

type ParsedRedisValue = {
  value: RedisValue
  nextOffset: number
}

export type RedisCommandRunner = (commands: string[][]) => Promise<RedisValue[]>

const RATE_LIMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retryAfterMs = tonumber(ARGV[5])
  if oldest[2] then
    retryAfterMs = math.max(1, tonumber(oldest[2]) + tonumber(ARGV[5]) - tonumber(ARGV[3]))
  end
  return {0, count, retryAfterMs}
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return {1, count + 1, 0}
`

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

type PendingRedisBatch = {
  expectedResponses: number
  responses: RedisValue[]
  resolve(value: RedisValue[]): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

class RedisCommandClient {
  private socket: net.Socket | tls.TLSSocket | null = null
  private buffer = Buffer.alloc(0)
  private pending: PendingRedisBatch | null = null
  private setupComplete = false
  private connectPromise: Promise<void> | null = null
  private queue: Promise<RedisValue[]> = Promise.resolve([])
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly redisUrl: string,
    private readonly idleTimeoutMs = 30_000,
  ) {}

  run(commands: string[][]): Promise<RedisValue[]> {
    const run = this.queue.catch(() => []).then(() => this.runExclusive(commands))
    this.queue = run
    return run
  }

  private async runExclusive(commands: string[][]): Promise<RedisValue[]> {
    this.clearIdleClose()
    await this.connect()
    const setupCommands = this.setupComplete ? [] : this.setupCommands()
    const responses = await this.writeAndRead([...setupCommands, ...commands])
    this.setupComplete = true
    this.scheduleIdleClose()
    return responses.slice(setupCommands.length)
  }

  private setupCommands(): string[][] {
    const options = redisConnectionOptions(this.redisUrl)
    const commands: string[][] = []
    if (options.password) {
      commands.push(options.username
        ? ['AUTH', options.username, options.password]
        : ['AUTH', options.password])
    }
    if (options.db) commands.push(['SELECT', options.db])
    return commands
  }

  private async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return
    if (this.connectPromise) return this.connectPromise

    const options = redisConnectionOptions(this.redisUrl)
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = options.tls
        ? tls.connect({ host: options.host, port: options.port, servername: options.host })
        : net.connect({ host: options.host, port: options.port })
      this.socket = socket
      this.buffer = Buffer.alloc(0)
      this.setupComplete = false

      const connectEvent = options.tls ? 'secureConnect' : 'connect'
      const onConnect = () => {
        socket.off('error', onInitialError)
        socket.on('error', (error) => this.handleSocketError(error))
        socket.on('close', () => this.handleSocketClose())
        socket.on('data', (chunk) => this.handleData(chunk))
        this.connectPromise = null
        resolve()
      }
      const onInitialError = (error: Error) => {
        this.connectPromise = null
        this.resetSocket()
        reject(error)
      }

      socket.once(connectEvent, onConnect)
      socket.once('error', onInitialError)
    })
    return this.connectPromise
  }

  private writeAndRead(commands: string[][]): Promise<RedisValue[]> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('Redis socket is not connected'))
    if (this.pending) return Promise.reject(new Error('Redis command batch already pending'))

    return new Promise((resolve, reject) => {
      const pending: PendingRedisBatch = {
        expectedResponses: commands.length,
        responses: [],
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.failPending(new Error('Redis rate-limit command timed out'))
          this.destroy()
        }, 5_000),
      }
      this.pending = pending
      for (const command of commands) socket.write(encodeRedisCommand(command))
    })
  }

  private handleData(chunk: Buffer): void {
    const pending = this.pending
    if (!pending) return

    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      let offset = 0
      while (pending.responses.length < pending.expectedResponses) {
        const parsed = parseRedisValue(this.buffer, offset)
        if (!parsed) break
        pending.responses.push(parsed.value)
        offset = parsed.nextOffset
      }
      if (offset > 0) this.buffer = this.buffer.subarray(offset)
      if (pending.responses.length === pending.expectedResponses) {
        this.pending = null
        clearTimeout(pending.timeout)
        pending.resolve(pending.responses)
      }
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)))
      this.destroy()
    }
  }

  private handleSocketError(error: Error): void {
    this.failPending(error)
    this.destroy()
  }

  private handleSocketClose(): void {
    this.failPending(new Error('Redis socket closed'))
    this.resetSocket()
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timeout)
    pending.reject(error)
  }

  private scheduleIdleClose(): void {
    this.clearIdleClose()
    this.idleTimer = setTimeout(() => this.destroy(), this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private clearIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private resetSocket(): void {
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.setupComplete = false
  }

  private destroy(): void {
    this.clearIdleClose()
    this.socket?.destroy()
    this.resetSocket()
  }
}

function redisKey(key: string): string {
  return `rate-limit:${key}`
}

function numberValue(value: RedisValue): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

export class RedisRateLimitBackend implements RateLimitBackend {
  private readonly runCommands: RedisCommandRunner

  constructor(redisUrl: string, runner?: RedisCommandRunner) {
    if (runner) {
      this.runCommands = runner
      return
    }

    const client = new RedisCommandClient(redisUrl)
    this.runCommands = (commands) => client.run(commands)
  }

  async check(key: string, max = 5, windowMs = 5 * 60_000): Promise<RateLimitResult> {
    const now = Date.now()
    const cutoff = now - windowMs
    const bucketKey = redisKey(key)
    const member = `${now}:${randomUUID()}`

    const [resultRaw] = await this.runCommands([
      ['EVAL', RATE_LIMIT_SCRIPT, '1', bucketKey, String(cutoff), String(max), String(now), member, String(windowMs)],
    ])
    const result = Array.isArray(resultRaw) ? resultRaw : []
    const allowed = numberValue(result[0] ?? 0) === 1
    const count = numberValue(result[1] ?? 0)
    const retryAfterMs = numberValue(result[2] ?? 0)

    return {
      allowed,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
      remaining: allowed ? Math.max(0, max - count) : 0,
    }
  }

  async clear(key: string): Promise<void> {
    await this.runCommands([['DEL', redisKey(key)]])
  }
}

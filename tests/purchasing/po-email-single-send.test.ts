import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test, { mock } from 'node:test'

// nodemailer is a double: no socket is opened, no network is reached. `behave` decides what each sendMail does and may drive the
// transport's own logger the way nodemailer does (a `{ tnx: 'client' }` entry per command it writes).
type Options = { logger: { debug(entry: unknown, message: string): void } } & Record<string, unknown>
let behave: (o: Options) => Promise<unknown> = async () => ({})
let lastOptions: Record<string, unknown> | null = null
let sendMailCalls = 0
// nodemailer 10 ships separate ESM and CJS entries; lib/mailer.ts is loaded through whichever one the loader picks, so the double is installed on both.
const nodemailerDouble = {
  defaultExport: {
    createTransport: (o: Options) => {
      lastOptions = o
      return { sendMail: () => { sendMailCalls++; return behave(o) }, close: () => undefined }
    },
  },
}
mock.module('nodemailer', nodemailerDouble)
mock.module(pathToFileURL(createRequire(import.meta.url).resolve('nodemailer')).href, nodemailerDouble)

const SMTP = { host: 'smtp.invalid', port: 587, user: '', pass: '', secure: 'none', fromName: 'X', fromEmail: 'from@example.test', replyTo: '' }
const mail = { to: 'to@example.test', subject: 's', html: 'h' }
const reject = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, command: 'CONN', ...extra })
// The tracker matches server replies to client commands in order, starting at MAIL FROM, so the envelope commands are logged the way nodemailer logs them.
const envelope = (o: Options) => {
  for (const [client, server] of [['MAIL FROM:<a@b>', '250 2.1.0 Ok'], ['RCPT TO:<c@d>', '250 2.1.5 Ok']]) {
    o.logger.debug({ tnx: 'client' }, client)
    o.logger.debug({ tnx: 'server' }, server)
  }
}
const sendCommand = (o: Options, command: string) => {
  if (command === 'DATA') envelope(o)
  o.logger.debug({ tnx: 'client' }, command)
  // The server's reply to DATA (nodemailer logs it with tnx 'server' before acting on it): delivery has begun only from here.
  if (command === 'DATA') o.logger.debug({ tnx: 'server' }, '354 End data with <CR><LF>.<CR><LF>')
}
const sendDataCommandOnly = (o: Options) => { envelope(o); o.logger.debug({ tnx: 'client' }, 'DATA') }

test('mailer: a sendMail rejection exactly at the deadline, after DATA, is the same terminal unknown outcome as the deadline timer', async () => {
  const { sendEmailWithSmtpSettings, SEND_DEADLINE_UNKNOWN_OUTCOME } = await import('../../lib/mailer.ts')
  // The transport's own socket timeout fires on the same tick as our timer and rejects first.
  behave = (o) => { sendCommand(o, 'DATA'); return new Promise((_, rej) => setTimeout(() => rej(reject('ETIMEDOUT', 'Timeout')), 20)) }
  const r = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20, singleSend: true })
  assert.deepEqual(r, { success: false, permanent: true, unknownOutcome: true, error: SEND_DEADLINE_UNKNOWN_OUTCOME })
  // ... and the timer winning gives the identical answer.
  behave = (o) => { sendCommand(o, 'DATA'); return new Promise<never>(() => undefined) }
  const t = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20, singleSend: true })
  assert.deepEqual(t, r)
})

test('mailer: the deadline timer firing BEFORE the message was handed over (no connection, greeting or DATA) is a retryable failure, not an unknown outcome', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = () => new Promise<never>(() => undefined)
  const r = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20, singleSend: true })
  assert.equal(r.success, false)
  assert.equal(r.permanent, false)
  assert.equal(r.unknownOutcome, undefined)
  // DATA command written but no 354 yet: still nothing handed over.
  behave = (o) => { sendDataCommandOnly(o); return new Promise<never>(() => undefined) }
  const early = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20, singleSend: true })
  assert.equal(early.permanent, false)
  assert.equal(early.unknownOutcome, undefined)
})

test('mailer: a pre-delivery rejection just before the deadline (no DATA seen) stays retryable', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  for (const failure of [reject('EDNS', 'getaddrinfo ENOTFOUND smtp.invalid'), reject('ECONNECTION', 'connect ECONNREFUSED 127.0.0.1:587')]) {
    behave = () => new Promise((_, rej) => setTimeout(() => rej(failure), 480))
    const r = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 500, singleSend: true })
    assert.equal(r.permanent, false)
    assert.equal(r.unknownOutcome, undefined)
  }
})

test('mailer: a disconnect after DATA is written but before the 354 reply is retryable; after the 354 it is terminal', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = async (o) => { sendDataCommandOnly(o); throw reject('ECONNECTION', 'Connection closed unexpectedly') }
  const early = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(early.permanent, false)
  assert.equal(early.unknownOutcome, undefined)
  // A refusal of DATA (4xx/5xx reply, logged as the server line) is not delivery either.
  behave = async (o) => { sendDataCommandOnly(o); o.logger.debug({ tnx: 'server' }, '451 try later'); throw reject('ECONNECTION', 'Connection closed unexpectedly') }
  assert.equal((await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })).permanent, false)
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ECONNECTION', 'Connection closed unexpectedly') }
  const late = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(late.permanent, true)
  assert.equal(late.unknownOutcome, true)
  // The wording says what happened: the connection failed after the hand-over, NOT that a deadline passed (customer kinds also carry a deadline now, but this is a lost reply).
  const { SEND_FINAL_REPLY_UNKNOWN_OUTCOME, SEND_DEADLINE_UNKNOWN_OUTCOME } = await import('../../lib/mailer.ts')
  assert.equal(late.error, SEND_FINAL_REPLY_UNKNOWN_OUTCOME)
  assert.notEqual(late.error, SEND_DEADLINE_UNKNOWN_OUTCOME)
  assert.match(late.error ?? '', /connection failed after the message was handed to the mail server/)
})

test('mailer: a truncated final 2xx reply followed by a disconnect is unknown; a final 451 stays retryable and a final 550 permanent', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ECONNECTION', 'Connection closed unexpectedly', { responseCode: 250 }) }
  const partial = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(partial.permanent, true)
  assert.equal(partial.unknownOutcome, true)
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ECONNECTION', 'Connection closed unexpectedly', { responseCode: 354 }) }
  assert.equal((await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })).unknownOutcome, true)
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('EMESSAGE', 'Message failed', { responseCode: 451 }) }
  const soft = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(soft.permanent, false)
  assert.equal(soft.unknownOutcome, undefined)
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('EMESSAGE', 'Message failed', { responseCode: 550 }) }
  const hard = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(hard.permanent, true)
  assert.equal(hard.unknownOutcome, undefined)
  // Before the 354 a code on the error never makes it unknown.
  behave = async (o) => { sendDataCommandOnly(o); throw reject('ECONNECTION', 'Connection closed unexpectedly', { responseCode: 250 }) }
  assert.equal((await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })).permanent, false)
})

test('mailer: the installed nodemailer logs the DATA command and the server reply the way the phase tracker reads them (version pin)', async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  const dir = req.resolve('nodemailer/package.json').replace(/package\.json$/, '')
  // nodemailer 10 ships dist/esm and dist/cjs builds; the two are generated from one source, so both must carry the behaviour the phase tracker reads.
  for (const build of ['esm', 'cjs']) {
    const src = readFileSync(`${dir}dist/${build}/smtp-connection/index.js`, 'utf8')
    assert.match(src, /this\._sendCommand\('DATA'\)/, `${build}: nodemailer writes DATA itself`)
    assert.match(src, /tnx: 'client'/, `${build}: client commands are logged with tnx 'client' when transactionLog is on`)
    assert.match(src, /tnx: 'server'/, `${build}: server replies are logged with tnx 'server' before the response action runs`)
    assert.match(src, /new Error\('Connection closed unexpectedly'\), 'ECONNECTION', failureResponse, 'CONN'/, `${build}: a mid-reply close attaches the partial response (and so a responseCode) to the ECONNECTION error`)
    assert.match(src, /_actionDATA\(str, callback\) \{[\s\S]*?if \(!\/\^\[23\]\/\.test\(str\)\)/, `${build}: DATA accepts a 2xx/3xx reply, then streams`)
    // Replies are answered in command order (an action queue), with or without PIPELINING: the tracker matches them the same way.
    assert.match(src, /this\._responseActions\.push\(str => \{\s*this\._actionDATA\(str, callback\)/, `${build}: DATA queues its response action like every other command`)
    assert.match(src, /_sendMailFrom|MAIL FROM:</, `${build}: MAIL FROM is the first envelope command`)
  }
})

test('mailer: a socket failure after DATA started is terminal, however early it comes', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  for (const failure of [reject('ESOCKET', 'read ECONNRESET'), reject('ETIMEDOUT', 'Timeout'), reject('ECONNECTION', 'Connection closed unexpectedly')]) {
    behave = async (o) => { sendCommand(o, 'DATA'); throw failure }
    const r = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
    assert.equal(r.success, false)
    assert.equal(r.permanent, true, `${failure.code}: never requeued`)
    assert.equal(r.unknownOutcome, true)
  }
})

test('mailer: a failure before delivery began stays retryable, and a server answer keeps its ordinary class', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = async () => { throw reject('ECONNECTION', 'connect ECONNREFUSED 127.0.0.1:587') }
  const refused = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(refused.success, false)
  assert.equal(refused.permanent, false)
  assert.equal(refused.unknownOutcome, undefined)

  behave = async (o) => { sendCommand(o, 'EHLO x'); sendCommand(o, 'MAIL FROM:<a@b>'); throw reject('EDNS', 'getaddrinfo ENOTFOUND') }
  assert.equal((await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })).permanent, false)

  // The server answered after DATA: a definite 4xx is not an unknown outcome (retry is safe), a 5xx is permanent as before.
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('EMESSAGE', 'Message failed', { responseCode: 451 }) }
  const soft = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(soft.permanent, false)
  assert.equal(soft.unknownOutcome, undefined)
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('EMESSAGE', 'Message failed', { responseCode: 554 }) }
  const hard = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(hard.permanent, true)
  assert.equal(hard.unknownOutcome, undefined)
})

test('mailer: other email kinds (no singleSend) are unchanged, and the transport gets no logger', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = async () => { throw reject('ESOCKET', 'read ECONNRESET') }
  const r = await sendEmailWithSmtpSettings(SMTP, mail)
  assert.deepEqual(r, { success: false, error: 'Error: read ECONNRESET', permanent: false, invalidRecipient: false })
  assert.equal(lastOptions?.logger, undefined)
  assert.equal(lastOptions?.transactionLog, undefined)
  behave = () => new Promise((_, rej) => setTimeout(() => rej(reject('ETIMEDOUT', 'Timeout')), 20))
  const withDeadline = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20 })
  assert.equal(withDeadline.permanent, false, 'a deadline alone does not change classification of a rejection')
  assert.equal(withDeadline.unknownOutcome, undefined)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Through the outbox drain: the row settles FAILED (never requeued) and the operator sees it on the purchase order.
// ---------------------------------------------------------------------------------------------------------------------------------------

// email-outbox imports the mailer, so it is loaded AFTER the nodemailer double is registered (a static import would hoist above it).
import type { EmailOutboxRow, InMemoryEmailOutboxDelegates } from '@/lib/email-outbox'

type Where = Record<string, unknown>

type StoredRow = EmailOutboxRow & { lastError?: string | null }

function sameInstant(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

/** Only the operators `lib/email-outbox.ts` actually builds. An unknown one throws rather than matching. */
function matchesClause(value: unknown, clause: unknown): boolean {
  if (clause !== null && typeof clause === 'object' && !(clause instanceof Date)) {
    for (const [operator, operand] of Object.entries(clause as Record<string, unknown>)) {
      const left = value instanceof Date ? value.getTime() : value
      const right = operand instanceof Date ? operand.getTime() : operand
      if (operator === 'lt') {
        if (!(left !== null && right !== null && (left as number) < (right as number))) return false
      } else if (operator === 'lte') {
        if (!(left !== null && right !== null && (left as number) <= (right as number))) return false
      } else if (operator === 'gte') {
        // o3d-hpeg: the park's `staleReclaimCount >= cap`.
        if (!(left !== null && right !== null && (left as number) >= (right as number))) return false
      } else {
        throw new Error(`test double does not implement operator ${operator}`)
      }
    }
    return true
  }
  return sameInstant(value, clause)
}

/**
 * Apply an updateMany's `data` the way Prisma does, for the one non-literal it uses: o3d-hpeg's
 * `staleReclaimCount: { increment: 1 }`. Any other object-valued field is a literal (a Date).
 */
function applyData(row: StoredRow, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const operators = Object.keys(value as Record<string, unknown>)
      if (operators.length !== 1 || operators[0] !== 'increment') {
        throw new Error(`test double does not implement data operator(s) ${operators.join(', ')}`)
      }
      const record = row as unknown as Record<string, number>
      record[field] = (record[field] ?? 0) + ((value as { increment: number }).increment)
      continue
    }
    (row as unknown as Record<string, unknown>)[field] = value
  }
}

function matchesWhere(row: StoredRow, where: Where): boolean {
  for (const [field, clause] of Object.entries(where)) {
    if (field === 'OR') {
      const branches = clause as Where[]
      if (!branches.some((branch) => matchesWhere(row, branch))) return false
      continue
    }
    if (!matchesClause((row as unknown as Record<string, unknown>)[field], clause)) return false
  }
  return true
}


async function makeClient(rows: EmailOutboxRow[], failFirstSettlement: boolean | 'SENT' = false) {
  let settlementFailed = false
  const { EMAIL_OUTBOX_IN_MEMORY_ROWS, createEmailOutboxHarnessClient } = await import('@/lib/email-outbox')
  const store: StoredRow[] = rows.map((row) => ({ ...row }))
  const suppressionStore: Record<string, unknown>[] = []
  // The witness key is a unique symbol that a dynamic import does not carry as a type, hence the cast.
  const delegates = {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where, take } = args as { where: Where; take?: number }
        const matched = store.filter((row) => matchesWhere(row, where))
        return matched.slice(0, take ?? matched.length).map((row) => ({ ...row }))
      },
      async updateMany(args: unknown) {
        const { where, data } = args as { where: Where; data: Record<string, unknown> }
        if (failFirstSettlement && !settlementFailed && (failFirstSettlement === 'SENT' ? data.status === 'SENT' : (data.status === 'FAILED' || data.status === 'PENDING'))) {
          settlementFailed = true
          throw new Error('the settlement write did not commit')
        }
        let count = 0
        for (const row of store) {
          if (!matchesWhere(row, where)) continue
          applyData(row, data)
          count += 1
        }
        return { count }
      },
      async create(args: unknown) { return (args as { data: unknown }).data },
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => store,
    },
    emailSuppression: {
      async findUnique(args: unknown) {
        const { where } = args as { where: { email: string } }
        return (suppressionStore.find((row) => row.email === where.email) ?? null) as never
      },
      async upsert() { return {} },
      [EMAIL_OUTBOX_IN_MEMORY_ROWS]: () => suppressionStore,
    },
  } as unknown as InMemoryEmailOutboxDelegates
  const client = await createEmailOutboxHarnessClient({ emailOutbox: delegates.emailOutbox, emailSuppression: delegates.emailSuppression })
  return { client, rows: store }
}

function makeRow(overrides: Partial<EmailOutboxRow>): EmailOutboxRow {
  return {
    id: 'email-1', kind: 'PURCHASE_ORDER', toEmail: 'supplier@example.test', subject: 'Purchase Order PO-1', html: 'queued', attachments: null,
    referenceType: 'PurchaseOrder', referenceId: 'po-1', status: 'PENDING', attempts: 0, availableAt: new Date('2026-09-10T09:00:00.000Z'),
    processingStartedAt: null, lockedBy: null, staleReclaimCount: 0, ...overrides,
  }
}

const T0 = new Date('2026-09-10T10:00:00.000Z')

async function drainWith(row: EmailOutboxRow, prepared: Record<string, unknown> | null, failFirstSettlement: boolean | 'SENT' = false, logEntity = 'PURCHASE_ORDER') {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const { client, rows } = await makeClient([row], failFirstSettlement)
  const logs: { entityType: string; entityId: string; action: string; level: string }[] = []
  const result = await processPendingEmailOutbox({
    harness: {
      client,
      now: () => T0,
      prepareQueuedEmail: async () => (prepared ? { to: 'supplier@example.test', subject: 's', html: 'h', ...prepared } as never : null),
      logActivity: (async (entry: (typeof logs)[number]) => { logs.push(entry) }) as never,
      sendEmail: ((m: Parameters<typeof sendEmailWithSmtpSettings>[1]) => sendEmailWithSmtpSettings(SMTP, m)) as never,
    },
  })
  return { result, row: rows[0], logs: logs.filter((l) => l.entityType === logEntity) }
}

test('outbox: a PO send rejected exactly at the deadline ends FAILED, is not requeued, and is logged on the PO at WARNING', async () => {
  sendMailCalls = 0
  behave = (o) => { sendCommand(o, 'DATA'); return new Promise((_, rej) => setTimeout(() => rej(reject('ETIMEDOUT', 'Timeout')), 20)) }
  const { result, row, logs } = await drainWith(makeRow({}), { sendDeadlineMs: 20, singleSend: true })
  assert.equal(result.failed, 1)
  assert.equal(row.status, 'FAILED')
  assert.equal(row.attempts, 1)
  assert.match(String(row.lastError ?? ''), /Outcome unknown/)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].action, 'email_outcome_unknown')
  assert.equal(logs[0].entityId, 'po-1')
  assert.equal(logs[0].level, 'WARNING')
  // A later tick sends nothing more.
  const again = await drainWith(row, { sendDeadlineMs: 20, singleSend: true })
  assert.equal(again.result.processed, 0)
  assert.equal(sendMailCalls, 1)
})

test('outbox: a PO socket timeout after DATA is not requeued; a refusal before connect is', async () => {
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ETIMEDOUT', 'Timeout') }
  const afterData = await drainWith(makeRow({}), { sendDeadlineMs: 60_000, singleSend: true })
  assert.equal(afterData.row.status, 'FAILED')
  assert.equal(afterData.logs.length, 1)

  behave = async () => { throw reject('ECONNECTION', 'connect ECONNREFUSED 127.0.0.1:587') }
  const refused = await drainWith(makeRow({}), { sendDeadlineMs: 60_000, singleSend: true })
  assert.equal(refused.row.status, 'PENDING', 'retryable: requeued with backoff')
  assert.equal(refused.row.attempts, 1)
  assert.equal(refused.logs.length, 0)
})

test('outbox: a guard-level unknown outcome on a PO is also logged on the PO', async () => {
  behave = async () => ({})
  const { row, logs } = await drainWith(makeRow({}), { sendGuard: async () => ({ unknown: 'Outcome unknown: guard backstop.' }), singleSend: true })
  assert.equal(row.status, 'FAILED')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].action, 'email_outcome_unknown')
})

test('outbox: a customer kind with a socket failure after DATA is single-send too: FAILED, not requeued, "may not have been delivered" notice on the order', async () => {
  sendMailCalls = 0
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ESOCKET', 'read ECONNRESET') }
  const row0 = makeRow({ kind: 'ACCOUNTING_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1', toEmail: 'supplier@example.test' })
  const { row, logs } = await drainWith(row0, null, false, 'SALES_ORDER')
  assert.equal(row.status, 'FAILED')
  assert.equal(row.attempts, 1)
  assert.match(String(row.lastError ?? ''), /Outcome unknown/)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].action, 'email_outcome_unknown')
  assert.equal(logs[0].entityId, 'order-1')
  assert.equal(logs[0].level, 'WARNING')
  assert.match((logs[0] as unknown as { description: string }).description, /may not have been delivered/)
  const again = await drainWith(row, null, false, 'SALES_ORDER')
  assert.equal(again.result.processed, 0)
  assert.equal(sendMailCalls, 1, 'no second send, so no duplicate')
})

test('outbox: a customer kind refused before DATA is still retryable', async () => {
  behave = async () => { throw reject('ECONNECTION', 'connect ECONNREFUSED 127.0.0.1:587') }
  const { row, logs } = await drainWith(makeRow({ kind: 'ACCOUNTING_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1' }), null, false, 'SALES_ORDER')
  assert.equal(row.status, 'PENDING')
  assert.equal(logs.length, 0)
})

test('outbox: a customer kind whose deadline fires before DATA is retried with backoff, not parked as unknown', async () => {
  behave = () => new Promise<never>(() => undefined)
  const { row, logs } = await drainWith(makeRow({ kind: 'ACCOUNTING_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1' }), { sendDeadlineMs: 20, singleSend: true }, false, 'SALES_ORDER')
  assert.equal(row.status, 'PENDING')
  assert.equal(row.attempts, 1)
  assert.equal(logs.length, 0)
  assert.doesNotMatch(String(row.lastError ?? ''), /Outcome unknown/)
})

test('outbox: a settlement write that fails after an unknown outcome still ends FAILED, and nothing is sent on the next tick', async () => {
  sendMailCalls = 0
  behave = async (o) => { sendCommand(o, 'DATA'); throw reject('ESOCKET', 'read ECONNRESET') }
  const first = await drainWith(makeRow({}), { sendDeadlineMs: 60_000, singleSend: true }, true)
  assert.equal(first.row.status, 'FAILED', 'the catch settles terminal, never PENDING')
  assert.match(String(first.row.lastError ?? ''), /Outcome unknown/)
  assert.equal(first.logs.length, 1)
  const again = await drainWith(first.row, { sendDeadlineMs: 60_000, singleSend: true })
  assert.equal(again.result.processed, 0)
  assert.equal(sendMailCalls, 1)

  // The guard's unknown-outcome branch has the same protection.
  const guarded = await drainWith(makeRow({}), { sendGuard: async () => ({ unknown: 'Outcome unknown: guard backstop.' }), singleSend: true }, true)
  assert.equal(guarded.row.status, 'FAILED')
})

test('outbox: a SENT write that throws once after a delivered send settles SENT (never PENDING), and the next drain sends nothing', async () => {
  // Owner decision o3d-hqvrp.388: a customer email is never sent twice. Every kind, PO included.
  for (const kind of ['PURCHASE_ORDER', 'SALES_ORDER_CONFIRMATION']) {
    sendMailCalls = 0
    behave = async () => ({ accepted: ['supplier@example.test'] })
    const row = makeRow(kind === 'PURCHASE_ORDER' ? {} : { kind, referenceType: 'SalesOrder', referenceId: 'so-1' })
    const first = await drainWith(row, { sendDeadlineMs: 60_000, singleSend: true }, 'SENT', kind === 'PURCHASE_ORDER' ? 'PURCHASE_ORDER' : 'SALES_ORDER')
    assert.equal(sendMailCalls, 1, kind)
    assert.equal(first.row.status, 'SENT', `${kind}: the delivered message is recorded as SENT, not requeued`)
    assert.equal(first.result.sent, 1)
    const again = await drainWith(first.row, { sendDeadlineMs: 60_000, singleSend: true })
    assert.equal(again.result.processed, 0, kind)
    assert.equal(sendMailCalls, 1, `${kind}: the next drain sends nothing`)
  }
})

test('outbox: a sender that THROWS settles FAILED with the unknown-outcome notice, never PENDING', async () => {
  sendMailCalls = 0
  const row = makeRow({})
  const { processPendingEmailOutbox } = await import('@/lib/email-outbox')
  const { client, rows } = await makeClient([row])
  const logs: { action: string }[] = []
  await processPendingEmailOutbox({
    harness: {
      client, now: () => T0,
      prepareQueuedEmail: async () => ({ to: 'supplier@example.test', subject: 's', html: 'h', singleSend: true }) as never,
      logActivity: (async (entry: { action: string }) => { logs.push(entry) }) as never,
      sendEmail: (async () => { sendMailCalls++; throw new Error('sender blew up') }) as never,
    },
  })
  assert.equal(rows[0].status, 'FAILED')
  assert.match(String(rows[0].lastError ?? ''), /Outcome unknown/)
  assert.ok(logs.some((l) => l.action === 'email_outcome_unknown'))
  assert.equal(sendMailCalls, 1)
})

test('guard backstop: a send still reading its SMTP settings when the backstop fires sends nothing afterwards', async () => {
  const { runUnderPoEmailSendLock, PO_SEND_UNKNOWN_OUTCOME } = await import('../../lib/purchase-order-email.ts')
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  sendMailCalls = 0
  behave = async () => ({ accepted: ['to@example.test'] })
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: async () => undefined, setting: { findUnique: async () => ({ value: 'true' }) } }),
  }
  const slowSettingsRead = new Promise((resolve) => setTimeout(resolve, 100))
  const out = await runUnderPoEmailSendLock(
    client,
    async (signal) => { await slowSettingsRead; return sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true, signal }) },
    { backstopMs: 20 },
  )
  assert.deepEqual(out, { unknown: PO_SEND_UNKNOWN_OUTCOME })
  await slowSettingsRead
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(sendMailCalls, 0, 'the mailer saw the aborted signal and never opened a transaction with the server')
})

test('mailer: with a deadline the socket is destroyed on close (socketCloseTimeout 0), and a signal already aborted sends nothing', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  behave = (o) => { sendCommand(o, 'DATA'); return new Promise<never>(() => undefined) }
  await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 20, singleSend: true })
  assert.equal(lastOptions?.socketCloseTimeout, 0, 'nodemailer 10.6: 0 destroys the socket on close')
  sendMailCalls = 0
  const ac = new AbortController()
  ac.abort()
  const r = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true, signal: ac.signal })
  assert.equal(r.success, false)
  assert.equal(r.permanent, false)
  assert.equal(sendMailCalls, 0)
})

test('mailer: replies are matched to commands in order, with and without PIPELINING; the reply that answers DATA (2xx or 3xx) starts the DATA phase', async () => {
  const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
  const c = (o: Options, line: string) => o.logger.debug({ tnx: 'client' }, line)
  const sv = (o: Options, line: string) => o.logger.debug({ tnx: 'server' }, line)
  // PIPELINING: MAIL, RCPT and DATA are all written before any reply; non-pipelining: each is answered before the next is sent.
  const conversation = (o: Options, pipelined: boolean, dataReply: string | null, mailReply = '250 2.1.0 Ok', rcptReply = '250 2.1.5 Ok') => {
    sv(o, '250-PIPELINING')
    if (pipelined) {
      c(o, 'MAIL FROM:<a@b>'); c(o, 'RCPT TO:<c@d>'); c(o, 'DATA')
      sv(o, mailReply); sv(o, rcptReply)
    } else {
      c(o, 'MAIL FROM:<a@b>'); sv(o, mailReply)
      c(o, 'RCPT TO:<c@d>'); sv(o, rcptReply)
      c(o, 'DATA')
    }
    if (dataReply) sv(o, dataReply)
  }
  for (const pipelined of [true, false]) {
    const label = pipelined ? 'pipelined' : 'sequential'
    const run = async (dataReply: string | null, mailReply?: string, rcptReply?: string, code?: number) => {
      behave = async (o) => { conversation(o, pipelined, dataReply, mailReply, rcptReply); throw reject('ECONNECTION', 'Connection closed unexpectedly', code ? { responseCode: code } : {}) }
      return sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
    }
    // Dropped after the MAIL/RCPT replies, before the DATA reply: nothing was handed over, so the failure stays retryable.
    const early = await run(null)
    assert.equal(early.permanent, false, label)
    assert.equal(early.unknownOutcome, undefined, label)
    // Dropped after a standard 354: terminal unknown outcome.
    const late = await run('354 End data with <CR><LF>.<CR><LF>')
    assert.equal(late.permanent, true, label)
    assert.equal(late.unknownOutcome, true, label)
    // The non-standard 250 reply to DATA (emailjs#24) is accepted by nodemailer, which then streams: also an unknown outcome.
    const odd = await run('250 Ok')
    assert.equal(odd.permanent, true, label)
    assert.equal(odd.unknownOutcome, true, label)
    // A 4xx/5xx reply to DATA is a refusal: nothing handed over.
    assert.equal((await run('451 try later')).permanent, false, label)
    assert.equal((await run('554 no valid recipients')).unknownOutcome, undefined, label)
    // A MAIL or RCPT failure (4xx/5xx answers carried on the error) stays an ordinary failure, never an unknown outcome.
    for (const [mailReply, rcptReply, code] of [['451 try later', '503 bad sequence', 451], ['250 Ok', '451 busy', 451], ['250 Ok', '550 no such user', 550]] as const) {
      const r = await run(null, mailReply, rcptReply, code)
      assert.equal(r.unknownOutcome, undefined, `${label} ${mailReply} / ${rcptReply}`)
    }
    // ... even when a pipelining server answers DATA with a 3xx after refusing MAIL/RCPT: the error carries the 4xx/5xx code.
    const refusedButDataAnswered = await run('354 go ahead', '451 try later', '503 bad sequence', 451)
    assert.equal(refusedButDataAnswered.unknownOutcome, undefined, label)
  }
  // A banner or reply text mentioning PIPELINING changes nothing: there is no PIPELINING detection to fool.
  behave = async (o) => {
    o.logger.debug({ tnx: 'server' }, '220 mail.example PIPELINING ESMTP')
    o.logger.debug({ tnx: 'client' }, 'MAIL FROM:<a@b>'); o.logger.debug({ tnx: 'server' }, '250 2.1.0 Ok PIPELINING')
    o.logger.debug({ tnx: 'client' }, 'RCPT TO:<c@d>'); o.logger.debug({ tnx: 'server' }, '250 2.1.5 Ok')
    o.logger.debug({ tnx: 'client' }, 'DATA'); o.logger.debug({ tnx: 'server' }, '250 Ok')
    throw reject('ECONNECTION', 'Connection closed unexpectedly')
  }
  const banner = await sendEmailWithSmtpSettings(SMTP, { ...mail, deadlineMs: 60_000, singleSend: true })
  assert.equal(banner.unknownOutcome, true)
})

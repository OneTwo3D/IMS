import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test, { mock } from 'node:test'

// nodemailer is a double: no socket is opened.
const closes: number[] = []
let sendMailCalls = 0
let transportOptions: Record<string, unknown> | null = null
let sentSignal: AbortSignal | undefined
// nodemailer 10 ships separate ESM and CJS entries; lib/mailer.ts is loaded through whichever one the loader picks, so the double is installed on both.
const nodemailerDouble = {
  defaultExport: {
    createTransport: (o: Record<string, unknown>) => {
      transportOptions = o
      return { sendMail: (m: { signal?: AbortSignal }) => { sendMailCalls++; sentSignal = m.signal; return new Promise<never>(() => undefined) }, close: () => { closes.push(1) } }
    },
  },
}
mock.module('nodemailer', nodemailerDouble)
mock.module(pathToFileURL(createRequire(import.meta.url).resolve('nodemailer')).href, nodemailerDouble)

test('a send past its deadline closes the connection and reports a PERMANENT unknown-outcome failure', async () => {
  const { sendEmailWithSmtpSettings, SEND_DEADLINE_UNKNOWN_OUTCOME } = await import('../../lib/mailer.ts')
  const r = await sendEmailWithSmtpSettings(
    { host: 'smtp.invalid', port: 587, user: '', pass: '', secure: 'none', fromName: 'X', fromEmail: 'from@example.test', replyTo: '' },
    { to: 'to@example.test', subject: 's', html: 'h', deadlineMs: 20 },
  )
  assert.equal(r.success, false)
  assert.equal(r.permanent, true, 'permanent, so the drain never retries it')
  assert.equal(r.invalidRecipient, undefined)
  assert.equal(r.error, SEND_DEADLINE_UNKNOWN_OUTCOME)
  assert.equal(sendMailCalls, 1)
  assert.equal(closes.length, 1)
  assert.equal(sentSignal?.aborted, true, 'the deadline aborts the send through its AbortSignal')
  assert.equal(transportOptions?.connectionTimeout, 10, 'connect and greeting end at half the deadline, before the race timer')
  assert.equal(transportOptions?.greetingTimeout, 10)
  assert.equal(transportOptions?.socketTimeout, 20)
})

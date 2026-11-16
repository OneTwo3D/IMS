import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// nodemailer is a double: no socket is opened.
const closes: number[] = []
let sendMailCalls = 0
let transportOptions: Record<string, unknown> | null = null
mock.module('nodemailer', {
  defaultExport: {
    createTransport: (o: Record<string, unknown>) => {
      transportOptions = o
      return { sendMail: () => { sendMailCalls++; return new Promise<never>(() => undefined) }, close: () => { closes.push(1) } }
    },
  },
})

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
  assert.equal(transportOptions?.connectionTimeout, 20)
  assert.equal(transportOptions?.greetingTimeout, 20)
  assert.equal(transportOptions?.socketTimeout, 20)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { startFakeSmtpServer, type FakeSmtpOptions } from '../helpers/fake-smtp-server.ts'

// REAL nodemailer (no double) talking to a fake SMTP server on 127.0.0.1 (tests/helpers/fake-smtp-server.ts). No external network is used.
// Every test runs against a pipelining and a non-pipelining server: nodemailer 10 writes MAIL FROM / RCPT TO / DATA in one go only when
// the server offers PIPELINING, and the phase tracker in lib/mailer.ts must classify both the same way.

const smtpFor = (port: number) => ({ host: '127.0.0.1', port, user: '', pass: '', secure: 'none', fromName: 'X', fromEmail: 'from@example.test', replyTo: '' })
const mail = { to: 'to@example.test', subject: 's', html: 'h', singleSend: true, deadlineMs: 5000 }

async function run(options: FakeSmtpOptions, deadlineMs = 5000) {
  const server = await startFakeSmtpServer(options)
  try {
    const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
    const result = await sendEmailWithSmtpSettings(smtpFor(server.port), { ...mail, deadlineMs })
    return { result, server }
  } catch (e) {
    await server.close()
    throw e
  }
}

for (const pipelining of [true, false]) {
  const mode = pipelining ? 'PIPELINING server' : 'non-pipelining server'

  test(`real transport (${mode}): a normal send succeeds`, async () => {
    const { result, server } = await run({ pipelining })
    try {
      assert.deepEqual(result, { success: true })
      assert.ok(server.commands().some((c) => /^DATA$/i.test(c)))
    } finally { await server.close() }
  })

  test(`real transport (${mode}): a drop after the standard 354 and the body started is an unknown outcome`, async () => {
    const { result, server } = await run({ pipelining, dropOn: 'BODY' })
    try {
      assert.equal(result.success, false)
      assert.equal(result.permanent, true)
      assert.equal(result.unknownOutcome, true)
    } finally { await server.close() }
  })

  test(`real transport (${mode}): a non-standard 250 reply to DATA still starts the body, and a drop after it is an unknown outcome`, async () => {
    const { result, server } = await run({ pipelining, replies: { DATA: '250 Ok go ahead' }, dropOn: 'BODY' })
    try {
      assert.ok(server.events.some((e) => e.kind === 'body-start'), 'nodemailer streamed the body after the 250')
      assert.equal(result.success, false)
      assert.equal(result.permanent, true)
      assert.equal(result.unknownOutcome, true)
    } finally { await server.close() }
  })

  test(`real transport (${mode}): a banner that mentions PIPELINING does not change the classification`, async () => {
    const { result, server } = await run({ pipelining, banner: 'PIPELINING', replies: { DATA: '250 Ok go ahead' }, dropOn: 'BODY' })
    try {
      assert.equal(result.unknownOutcome, true)
    } finally { await server.close() }
  })

  // A MAIL FROM / RCPT TO REFUSAL is an EENVELOPE error, which classifySendFailure has always treated as invalidRecipient (permanent) whatever the 4xx/5xx;
  // what matters here is that the tracker never calls it an unknown outcome: the server refused, nothing was handed over.
  test(`real transport (${mode}): a MAIL FROM or RCPT TO refusal is an ordinary failure (no body sent), never an unknown outcome`, async () => {
    for (const replies of [
      { MAIL: '451 4.3.0 try again later', RCPT: '503 5.5.1 need MAIL first', DATA: '503 5.5.1 need MAIL first' },
      { MAIL: '550 5.7.1 sender refused', RCPT: '503 5.5.1 need MAIL first', DATA: '503 5.5.1 need MAIL first' },
      { RCPT: '451 4.2.0 mailbox busy' },
      { RCPT: '550 5.1.1 no such user' },
    ]) {
      const { result, server } = await run({ pipelining, replies })
      try {
        assert.equal(result.success, false, JSON.stringify(replies))
        assert.equal(result.unknownOutcome, undefined, JSON.stringify(replies))
        assert.ok(!server.events.some((e) => e.kind === 'body-start'), 'no body was sent')
      } finally { await server.close() }
    }
  })

  test(`real transport (${mode}): a drop before the MAIL FROM or RCPT TO reply is retryable`, async () => {
    for (const dropOn of ['MAIL', 'RCPT'] as const) {
      const { result, server } = await run({ pipelining, dropOn })
      try {
        assert.equal(result.success, false, dropOn)
        assert.equal(result.permanent, false, dropOn)
        assert.equal(result.unknownOutcome, undefined, dropOn)
      } finally { await server.close() }
    }
  })

  test(`real transport (${mode}): a drop before the DATA reply is retryable`, async () => {
    const { result, server } = await run({ pipelining, dropOn: 'DATA' })
    try {
      assert.equal(result.success, false)
      assert.equal(result.permanent, false)
      assert.equal(result.unknownOutcome, undefined)
    } finally { await server.close() }
  })

  test(`real transport (${mode}): a server that stalls before the DATA reply hits the deadline: terminal unknown outcome, and the connection is closed`, async () => {
    const { result, server } = await run({ pipelining, stallOn: 'DATA' }, 400)
    try {
      assert.equal(result.success, false)
      assert.equal(result.permanent, true)
      assert.equal(result.unknownOutcome, true)
      // What this branch does at the deadline: transport.close() on nodemailer 10.6. The assertion states the observed behaviour so a change in
      // either lib/mailer.ts or nodemailer (PR #1052 moves to an AbortController) is caught here.
      await server.allSocketsClosed(3000)
      assert.equal(server.openSockets(), 0)
    } finally { await server.close() }
  })
}

// The deadline TIMER (not nodemailer's own socket timeout) is what fires here: every reply arrives well inside socketTimeout (= deadlineMs), but
// the conversation as a whole outlasts the deadline. This is the case PR #1052's AbortController has to close; this branch only calls transport.close().
test('real transport: the overall deadline firing while replies keep arriving is a terminal unknown outcome (classification), whatever happens to the socket', async () => {
  const server = await startFakeSmtpServer({ pipelining: false, replyDelayMs: 150 })
  try {
    const { sendEmailWithSmtpSettings } = await import('../../lib/mailer.ts')
    const started = Date.now()
    const result = await sendEmailWithSmtpSettings(smtpFor(server.port), { ...mail, deadlineMs: 500 })
    assert.ok(Date.now() - started < 900, 'the deadline answered, not the end of the conversation')
    assert.equal(result.success, false)
    assert.equal(result.permanent, true)
    assert.equal(result.unknownOutcome, true)
    // CHARACTERISATION of this branch: transport.close() does not end a live SMTPConnection, so the in-flight send keeps going and the server still
    // receives the whole message after we answered. That is why the deadline answer must be a TERMINAL unknown outcome and never retryable.
    // PR #1052 (AbortController: ac.abort() closes the connection) must flip the assertion below to: no body-end event, and the socket closed early.
    await server.allSocketsClosed(5000)
    assert.ok(server.events.some((e) => e.kind === 'body-end'), 'the message was still delivered after the deadline answer')
  } finally { await server.close() }
})

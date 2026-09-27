import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createLedger,
  memoryStore,
  sendKey,
  UncertainSendError,
  SendOnceError,
} from '../src/index.js'

const T0 = Date.parse('2026-09-27T12:00:00.000Z')

/** A clock the test moves by hand. */
function clock(start = T0) {
  let t = start
  return {
    now: () => t,
    /** @param {number} ms */
    advance: (ms) => {
      t += ms
    },
  }
}

const key = sendKey({ channel: 'email', to: 'ana@example.com', intent: 'welcome' })

/** A send function that counts its calls. */
function counter(/** @type {unknown} */ result = { id: 'msg_1' }) {
  const fn = async () => {
    fn.calls++
    return result
  }
  fn.calls = 0
  return fn
}

test('once sends, then reports a duplicate without sending again', async () => {
  const c = clock()
  const ledger = createLedger(memoryStore(), { now: c.now })
  const send = counter({ id: 'msg_1' })

  const first = await ledger.once(key, send, { to: 'ana@example.com' })
  assert.equal(first.outcome, 'sent')
  assert.deepEqual(first.outcome === 'sent' && first.result, { id: 'msg_1' })
  assert.equal(first.entry.status, 'sent')
  assert.equal(first.entry.providerId, 'msg_1')
  assert.equal(first.entry.claimedAt, '2026-09-27T12:00:00.000Z')
  assert.deepEqual(first.entry.meta, { to: 'ana@example.com' })

  c.advance(60_000)
  const second = await ledger.once(key, send)
  assert.equal(second.outcome, 'duplicate')
  assert.equal(second.entry.sentAt, '2026-09-27T12:00:00.000Z')
  assert.equal(send.calls, 1)
})

test('providerId comes from a string or a known field; the send gets key and attempt', async () => {
  const ledger = createLedger(memoryStore(), { now: clock().now })
  /** @type {unknown[]} */
  const seen = []
  const a = await ledger.once('a', async (ctx) => {
    seen.push(ctx)
    return 'plain-id'
  })
  const b = await ledger.once('b', async () => ({ messageId: '<m@x>' }))
  const c = await ledger.once('c', async () => ({ sid: 'SM1' }))
  const d = await ledger.once('d', async () => undefined)
  assert.equal(a.entry.providerId, 'plain-id')
  assert.equal(b.entry.providerId, '<m@x>')
  assert.equal(c.entry.providerId, 'SM1')
  assert.equal(d.entry.providerId, null)
  assert.deepEqual(seen, [{ key: 'a', attempt: 1 }])
})

test('parallel once() calls on one key send exactly once (memory store)', async () => {
  const ledger = createLedger(memoryStore())
  let calls = 0
  const send = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 10))
    return 'id'
  }
  const results = await Promise.all(Array.from({ length: 25 }, () => ledger.once(key, send)))
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.outcome === 'sent').length, 1)
  assert.ok(results.every((r) => r.outcome === 'sent' || r.outcome === 'unknown'))
  assert.equal((await ledger.once(key, send)).outcome, 'duplicate')
})

test('crash window: a claim with no outcome is unknown, and is never sent again', async () => {
  const store = memoryStore()
  // A previous process claimed the key and died before it could record anything.
  await store.claim(key, {
    key,
    status: 'pending',
    attempts: 1,
    claimedAt: '2026-09-27T11:00:00.000Z',
    updatedAt: '2026-09-27T11:00:00.000Z',
    meta: { job: 'nightly' },
  })
  const ledger = createLedger(store, { now: clock().now })
  const send = counter()
  for (let i = 0; i < 3; i++) {
    const r = await ledger.once(key, send)
    assert.equal(r.outcome, 'unknown')
    assert.equal(r.entry.status, 'pending')
  }
  assert.equal(send.calls, 0)
  assert.equal((await ledger.pending()).length, 1)
})

test('a failed write after the send leaves it pending, so the next run does not resend', async () => {
  const inner = memoryStore()
  let failNextWrite = true
  /** @type {import('../src/index.js').Store} */
  const store = {
    ...inner,
    async transition(k, from, entry) {
      if (failNextWrite && entry.status === 'sent') {
        failNextWrite = false
        throw new Error('connection terminated')
      }
      return inner.transition(k, from, entry)
    },
  }
  const ledger = createLedger(store, { now: clock().now })
  const send = counter()

  await assert.rejects(ledger.once(key, send), /connection terminated/)
  assert.equal(send.calls, 1)
  const again = await ledger.once(key, send)
  assert.equal(again.outcome, 'unknown')
  assert.equal(send.calls, 1, 'the provider already has it; sending again would be the duplicate')
})

test('UncertainSendError leaves the entry pending and the outcome unknown', async () => {
  const ledger = createLedger(memoryStore(), { now: clock().now })
  const timeout = new Error('ETIMEDOUT')
  const result = await ledger.once(key, async () => {
    throw new UncertainSendError(timeout)
  })
  assert.equal(result.outcome, 'unknown')
  assert.ok(result.outcome === 'unknown' && result.error instanceof UncertainSendError)
  assert.equal(/** @type {any} */ (result).error.cause, timeout)
  assert.equal(result.entry.status, 'pending')
  assert.equal(result.entry.uncertain, true)
  assert.equal(result.entry.error, 'Delivery is unknown: ETIMEDOUT')

  const send = counter()
  assert.equal((await ledger.once(key, send)).outcome, 'unknown')
  assert.equal(send.calls, 0)
})

test('an ordinary error is recorded as failed, not thrown, and may be retried', async () => {
  const c = clock()
  const ledger = createLedger(memoryStore(), { now: c.now })
  const rejected = new Error('422 invalid recipient')
  const failed = await ledger.once(key, async () => {
    throw rejected
  })
  assert.equal(failed.outcome, 'failed')
  assert.ok(failed.outcome === 'failed' && failed.error === rejected)
  assert.equal(failed.entry.status, 'failed')
  assert.equal(failed.entry.error, '422 invalid recipient')

  c.advance(5 * 60_000)
  /** @type {number[]} */
  const attempts = []
  const retried = await ledger.once(key, async (ctx) => {
    attempts.push(ctx.attempt)
    return 'id-2'
  }, { run: 2 })
  assert.equal(retried.outcome, 'sent')
  assert.equal(retried.entry.attempts, 2)
  assert.equal(retried.entry.claimedAt, '2026-09-27T12:05:00.000Z')
  assert.deepEqual(retried.entry.meta, { run: 2 })
  assert.equal(retried.entry.error, undefined)
  assert.deepEqual(attempts, [2])
})

test('parallel retries of a failed send still send exactly once', async () => {
  const ledger = createLedger(memoryStore())
  await ledger.once(key, async () => {
    throw new Error('rejected')
  })
  let calls = 0
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      ledger.once(key, async () => {
        calls++
        await new Promise((r) => setTimeout(r, 5))
      }),
    ),
  )
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.outcome === 'sent').length, 1)
})

test('resolve settles an unknown entry, and the ledger follows it', async () => {
  const c = clock()
  const ledger = createLedger(memoryStore(), { now: c.now })
  const uncertain = async () => {
    throw new UncertainSendError(new Error('socket hang up'))
  }

  await ledger.once('k1', uncertain)
  c.advance(3_600_000)
  const sent = await ledger.resolve('k1', 'sent', { by: 'ops', note: 'found in provider log', providerId: 'p-9' })
  assert.equal(sent.status, 'sent')
  assert.equal(sent.providerId, 'p-9')
  assert.deepEqual(sent.resolution, {
    status: 'sent',
    from: 'pending',
    by: 'ops',
    note: 'found in provider log',
    at: '2026-09-27T13:00:00.000Z',
  })
  const send = counter()
  assert.equal((await ledger.once('k1', send)).outcome, 'duplicate')

  await ledger.once('k2', uncertain)
  const failed = await ledger.resolve('k2', 'failed')
  assert.equal(failed.resolution?.by, null)
  assert.equal((await ledger.once('k2', send)).outcome, 'sent')
  assert.equal(send.calls, 1)
  assert.deepEqual(await ledger.pending(), [])
})

test('resolve refuses what would allow a second send', async () => {
  const ledger = createLedger(memoryStore(), { now: clock().now })
  await ledger.once(key, counter())
  await assert.rejects(ledger.resolve(key, 'failed'), (e) => e instanceof SendOnceError && e.code === 'already_sent')
  await assert.rejects(ledger.resolve('nope', 'sent'), (e) => e instanceof SendOnceError && e.code === 'not_found')
  await assert.rejects(ledger.resolve(key, /** @type {any} */ ('pending')), TypeError)

  const unchanged = await ledger.resolve(key, 'sent')
  assert.equal(unchanged.resolution, undefined, 'already sent: returned as it was')

  await ledger.once('f', async () => {
    throw new Error('rejected')
  })
  assert.equal((await ledger.resolve('f', 'sent')).status, 'sent', 'failed to sent is allowed')
})

test('a send that finishes after someone marked it failed is corrected to sent', async () => {
  const ledger = createLedger(memoryStore())
  /** @type {() => void} */
  let finish = () => {}
  const inFlight = ledger.once(key, () => new Promise((r) => (finish = () => r('late-id'))))
  await new Promise((r) => setTimeout(r, 5))
  await ledger.resolve(key, 'failed', { note: 'gave up on it' })
  finish()
  assert.equal((await inFlight).outcome, 'sent')
  const entry = await ledger.get(key)
  assert.equal(entry?.status, 'sent')
  assert.equal(entry?.providerId, 'late-id')
})

test('pending() lists unknown entries oldest first, and skips recent ones on request', async () => {
  const c = clock()
  const ledger = createLedger(memoryStore(), { now: c.now })
  const uncertain = async () => {
    throw new UncertainSendError('timeout')
  }
  await ledger.once('old', uncertain)
  c.advance(20 * 60_000)
  await ledger.once('new', uncertain)
  await ledger.once('done', counter())
  c.advance(5 * 60_000)

  assert.deepEqual((await ledger.pending()).map((e) => e.key), ['old', 'new'])
  assert.deepEqual((await ledger.pending({ olderThan: '10m' })).map((e) => e.key), ['old'])
  assert.deepEqual((await ledger.pending({ olderThan: '1h' })).map((e) => e.key), [])
})

test('createLedger and once reject bad arguments', async () => {
  assert.throws(() => createLedger(/** @type {any} */ ({ claim() {} })), /missing transition, get, list/)
  const ledger = createLedger(memoryStore())
  await assert.rejects(ledger.once('', counter()), TypeError)
  await assert.rejects(ledger.once('k', /** @type {any} */ ('send')), TypeError)
  assert.equal(await ledger.get('k'), null, 'a refused call claims nothing')
})

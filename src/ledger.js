import { SendOnceError, UncertainSendError, errorMessage } from './errors.js'
import { clockFrom, parseDuration } from './duration.js'

/**
 * @typedef {import('./duration.js').Clock} Clock
 * @typedef {import('./duration.js').Duration} Duration
 * @typedef {import('./stores.js').Store} Store
 *
 * pending: claimed, and the send has not been confirmed either way. Either it is in
 *   flight right now, or a previous attempt died, timed out or could not record its
 *   result. It may or may not have reached the provider, so it is never sent again
 *   automatically.
 * sent: the send function returned.
 * failed: the send function threw an ordinary error, meaning it is known not to have
 *   gone out. The next `once()` for the key may try again.
 * @typedef {'pending'|'sent'|'failed'} Status
 *
 * @typedef {object} Resolution
 * @property {'sent'|'failed'} status What it was settled as.
 * @property {Status} from What it was before.
 * @property {string | null} by Who settled it.
 * @property {string | null} note
 * @property {string} at ISO 8601.
 *
 * One line in the ledger: the latest known state of one key. Plain JSON.
 * @typedef {object} Entry
 * @property {string} key
 * @property {Status} status
 * @property {number} attempts How many times a send has been started for this key.
 * @property {string} claimedAt ISO 8601. When the current attempt claimed the key.
 * @property {string} updatedAt ISO 8601.
 * @property {Record<string, unknown> | null} meta Whatever the caller passed to `once()`,
 *   for the audit: who it was to, what it was, which job sent it. Must be JSON.
 * @property {string} [sentAt] ISO 8601. When the send function returned.
 * @property {string | null} [providerId] The provider's id for the message, taken from
 *   the send function's return value (see `once()`).
 * @property {string} [error] The last error's message.
 * @property {boolean} [uncertain] Set when the send threw an UncertainSendError.
 * @property {Resolution} [resolution] Set when `resolve()` settled it.
 *
 * Passed to the send function. Forward `key` to any provider that accepts an
 * idempotency key of its own; it is stable across retries, which is what those
 * headers want.
 * @typedef {object} SendContext
 * @property {string} key
 * @property {number} attempt 1 on the first attempt, 2 after one failure, and so on.
 *
 * @typedef {{ outcome: 'sent', key: string, entry: Entry, result: unknown }} SentOutcome
 *   The send ran and returned. `result` is what it returned.
 * @typedef {{ outcome: 'duplicate', key: string, entry: Entry }} DuplicateOutcome
 *   Already sent. The send function was not called.
 * @typedef {{ outcome: 'unknown', key: string, entry: Entry, error?: unknown }} UnknownOutcome
 *   A previous attempt may have reached the provider, or this one threw an
 *   UncertainSendError (then `error` is set). The send function was not called (or its
 *   result is unknown), and will not be until someone calls `resolve()`.
 * @typedef {{ outcome: 'failed', key: string, entry: Entry, error: unknown }} FailedOutcome
 *   The send threw an ordinary error. It is recorded as failed and may be retried.
 *
 * @typedef {SentOutcome | DuplicateOutcome | UnknownOutcome | FailedOutcome} OnceResult
 *
 * @typedef {object} ResolveDetails
 * @property {string} [by] Who is settling it. Recorded.
 * @property {string} [note] Why, for the next person to read the ledger.
 * @property {string} [providerId] The provider's id, if the person found the message.
 *
 * @typedef {object} Ledger
 * @property {<T>(key: string, send: (context: SendContext) => Promise<T> | T, meta?: Record<string, unknown>) => Promise<OnceResult>} once
 *   Runs `send` only if nothing has claimed `key` yet (or the last attempt is known to
 *   have failed). The claim is written before `send` is called.
 * @property {(key: string, status: 'sent'|'failed', details?: ResolveDetails) => Promise<Entry>} resolve
 *   Settles an entry by hand, usually one left pending. See `resolve()` below.
 * @property {(key: string) => Promise<Entry | null>} get
 * @property {(options?: { olderThan?: Duration }) => Promise<Entry[]>} pending
 *   Entries whose outcome is unknown, oldest first. `olderThan` skips ones claimed more
 *   recently than that, which are probably still in flight.
 *
 * @typedef {object} LedgerOptions
 * @property {Clock} [now] Where timestamps come from. Defaults to the system clock.
 */

/** Rounds of "someone else changed it first, look again" before giving up. */
const MAX_ROUNDS = 5

/**
 * Creates a ledger over a store. The ledger holds no state of its own, so any number of
 * ledgers, in any number of processes, can share one store.
 *
 * @param {Store} store
 * @param {LedgerOptions} [options]
 * @returns {Ledger}
 */
export function createLedger(store, options = {}) {
  assertStore(store)
  const clock = clockFrom(options.now)
  const iso = () => new Date(clock()).toISOString()

  /**
   * Claims the key, or reports the entry that already holds it.
   *
   * @param {string} key
   * @param {Record<string, unknown> | null} meta
   * @returns {Promise<{ claimed: Entry } | { existing: Entry }>}
   */
  async function acquire(key, meta) {
    const at = iso()
    /** @type {Entry} */
    const fresh = { key, status: 'pending', attempts: 1, claimedAt: at, updatedAt: at, meta }
    if (await store.claim(key, fresh)) return { claimed: fresh }

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const existing = await store.get(key)
      if (!existing) {
        throw new SendOnceError(
          'store_inconsistent',
          `The store refused to claim ${key} but has no entry for it. Check the store's claim().`,
        )
      }
      if (existing.status !== 'failed') return { existing }

      // Known not to have gone out, so it may go again. Compare-and-set from failed, so
      // two processes retrying at once cannot both win.
      const retryAt = iso()
      /** @type {Entry} */
      const retry = {
        key,
        status: 'pending',
        attempts: existing.attempts + 1,
        claimedAt: retryAt,
        updatedAt: retryAt,
        meta: meta ?? existing.meta,
      }
      if (await store.transition(key, 'failed', retry)) return { claimed: retry }
    }
    throw new SendOnceError('contended', `Gave up claiming ${key}: it kept changing underneath.`)
  }

  /**
   * Runs `send` at most once per key.
   *
   * 1. The key is claimed as pending, durably, before `send` is called.
   * 2. If the key is already sent, the result is 'duplicate' and `send` is not called.
   * 3. If it is already pending, the result is 'unknown' and `send` is not called: a
   *    previous attempt may have reached the provider. It stays that way until
   *    `resolve()`.
   * 4. If it failed last time, it is claimed again and `send` is called.
   * 5. If `send` returns, the entry becomes sent. A string return value, or the first
   *    string among `providerId`, `messageId`, `id` and `sid` on a returned object, is
   *    kept as `providerId`. The full value is returned to you as `result` but not
   *    stored, because it may not be JSON.
   * 6. If `send` throws, `once()` does not throw. It returns 'failed' and records it,
   *    or 'unknown' and leaves it pending if what was thrown is an UncertainSendError.
   *
   * If the store itself fails, `once()` rejects with the store's error. After a send has
   * run, that leaves the entry pending, so the next `once()` for the key returns
   * 'unknown' instead of sending a second time.
   *
   * @template T
   * @param {string} key From `sendKey()`, or any stable string of your own.
   * @param {(context: SendContext) => Promise<T> | T} send
   * @param {Record<string, unknown>} [meta] Stored with the entry. Must be JSON.
   * @returns {Promise<OnceResult>}
   */
  async function once(key, send, meta) {
    assertKey(key)
    if (typeof send !== 'function') throw new TypeError('once: send must be a function.')

    const got = await acquire(key, meta ?? null)
    if ('existing' in got) {
      const entry = got.existing
      return entry.status === 'sent'
        ? { outcome: 'duplicate', key, entry }
        : { outcome: 'unknown', key, entry }
    }

    const entry = got.claimed
    /** @type {T} */
    let result
    try {
      result = await send({ key, attempt: entry.attempts })
    } catch (error) {
      const uncertain = error instanceof UncertainSendError
      /** @type {Entry} */
      const next = uncertain
        ? { ...entry, updatedAt: iso(), error: errorMessage(error), uncertain: true }
        : { ...entry, status: 'failed', updatedAt: iso(), error: errorMessage(error) }
      const written = await store.transition(key, 'pending', next)
      const current = written ? next : ((await store.get(key)) ?? next)
      return uncertain
        ? { outcome: 'unknown', key, entry: current, error }
        : { outcome: 'failed', key, entry: current, error }
    }

    const at = iso()
    /** @type {Entry} */
    const sent = { ...entry, status: 'sent', updatedAt: at, sentAt: at, providerId: providerIdOf(result) }
    if (!(await store.transition(key, 'pending', sent))) {
      // Someone settled it while the send was in flight. The send did happen, so a
      // 'failed' verdict is corrected rather than left standing to invite a retry.
      await store.transition(key, 'failed', sent)
    }
    return { outcome: 'sent', key, entry: sent, result }
  }

  /**
   * Settles an entry by hand. For a person, or a reconciler that checked the provider,
   * to say what happened to a send the ledger could not confirm.
   *
   * Allowed: pending to sent, pending to failed, failed to sent. Settling an entry as
   * the status it already has returns it unchanged. A sent entry can never be marked
   * failed, because failed means "may be sent again".
   *
   * @param {string} key
   * @param {'sent'|'failed'} status
   * @param {ResolveDetails} [details]
   * @returns {Promise<Entry>}
   */
  async function resolve(key, status, details = {}) {
    assertKey(key)
    if (status !== 'sent' && status !== 'failed') {
      throw new TypeError(`resolve: status must be 'sent' or 'failed', got ${String(status)}.`)
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const current = await store.get(key)
      if (!current) throw new SendOnceError('not_found', `No entry for ${key}.`)
      if (current.status === status) return current
      if (current.status === 'sent') {
        throw new SendOnceError(
          'already_sent',
          `${key} is recorded as sent. It cannot be marked failed, because a failed entry may be sent again.`,
        )
      }
      const at = iso()
      /** @type {Entry} */
      const next = {
        ...current,
        status,
        updatedAt: at,
        resolution: {
          status,
          from: current.status,
          by: details.by ?? null,
          note: details.note ?? null,
          at,
        },
      }
      if (details.providerId) next.providerId = details.providerId
      if (await store.transition(key, current.status, next)) return next
    }
    throw new SendOnceError('contended', `Gave up resolving ${key}: it kept changing underneath.`)
  }

  /**
   * @param {string} key
   * @returns {Promise<Entry | null>}
   */
  async function get(key) {
    assertKey(key)
    return store.get(key)
  }

  /**
   * @param {{ olderThan?: Duration }} [options]
   * @returns {Promise<Entry[]>}
   */
  async function pending(options = {}) {
    const cutoff = clock() - (options.olderThan === undefined ? 0 : parseDuration(options.olderThan))
    const entries = await store.list({ status: 'pending' })
    return entries
      .filter((e) => e.status === 'pending' && Date.parse(e.claimedAt) <= cutoff)
      .sort((a, b) => Date.parse(a.claimedAt) - Date.parse(b.claimedAt))
  }

  return { once, resolve, get, pending }
}

/**
 * @param {unknown} result
 * @returns {string | null}
 */
function providerIdOf(result) {
  if (typeof result === 'string') return result || null
  if (result && typeof result === 'object') {
    const record = /** @type {Record<string, unknown>} */ (result)
    for (const field of ['providerId', 'messageId', 'id', 'sid']) {
      const value = record[field]
      if (typeof value === 'string' && value) return value
    }
  }
  return null
}

/**
 * @param {unknown} key
 * @returns {asserts key is string}
 */
function assertKey(key) {
  if (typeof key !== 'string' || key === '') throw new TypeError('A key must be a non-empty string.')
}

/**
 * @param {unknown} store
 */
function assertStore(store) {
  const methods = ['claim', 'transition', 'get', 'list']
  const missing = methods.filter(
    (m) => !store || typeof (/** @type {Record<string, unknown>} */ (store))[m] !== 'function',
  )
  if (missing.length) {
    throw new TypeError(`createLedger: the store is missing ${missing.join(', ')}.`)
  }
}

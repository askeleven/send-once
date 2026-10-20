/**
 * @typedef {'not_found'|'already_sent'|'contended'|'store_inconsistent'|'lock_timeout'
 *   |'bad_query_result'} SendOnceErrorCode
 */

/** Something send-once refused to do, or could not do safely. Match on `code`. */
export class SendOnceError extends Error {
  /**
   * @param {SendOnceErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'SendOnceError'
    /** @type {SendOnceErrorCode} */
    this.code = code
  }
}

/**
 * Throw this from a send function when the attempt failed in a way that does not tell
 * you whether the message went out: a timeout, a connection reset after the request was
 * written, a 5xx from a provider that may already have accepted it.
 *
 * The ledger then leaves the entry pending instead of marking it failed, so it is never
 * retried automatically. A person or a reconciler settles it with `resolve()`.
 *
 * Throw an ordinary error only when you know the message was not delivered, such as a
 * validation error the provider returned before accepting anything. Those are marked
 * failed and may be retried.
 */
export class UncertainSendError extends Error {
  /**
   * @param {unknown} cause The error the send actually failed with.
   * @param {string} [message] Defaults to "Delivery is unknown: " plus the cause's message.
   */
  constructor(cause, message) {
    super(message ?? `Delivery is unknown: ${errorMessage(cause)}`, { cause })
    this.name = 'UncertainSendError'
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The `code` of a Node system error, if it has one.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function errorCode(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}

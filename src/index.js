// send-once: a send happens once, and only while the approval behind it is still true.

/**
 * @typedef {import('./key.js').SendKeyInput} SendKeyInput
 * @typedef {import('./ledger.js').Ledger} Ledger
 * @typedef {import('./ledger.js').LedgerOptions} LedgerOptions
 * @typedef {import('./ledger.js').Entry} Entry
 * @typedef {import('./ledger.js').Status} Status
 * @typedef {import('./ledger.js').Resolution} Resolution
 * @typedef {import('./ledger.js').ResolveDetails} ResolveDetails
 * @typedef {import('./ledger.js').SendContext} SendContext
 * @typedef {import('./ledger.js').OnceResult} OnceResult
 * @typedef {import('./ledger.js').SentOutcome} SentOutcome
 * @typedef {import('./ledger.js').DuplicateOutcome} DuplicateOutcome
 * @typedef {import('./ledger.js').UnknownOutcome} UnknownOutcome
 * @typedef {import('./ledger.js').FailedOutcome} FailedOutcome
 * @typedef {import('./stores.js').Store} Store
 * @typedef {import('./stores.js').FileStoreOptions} FileStoreOptions
 * @typedef {import('./stores.js').SqlQuery} SqlQuery
 * @typedef {import('./stores.js').SqlResult} SqlResult
 * @typedef {import('./stores.js').SqlStoreOptions} SqlStoreOptions
 * @typedef {import('./approval.js').Approval} Approval
 * @typedef {import('./approval.js').ApproveOptions} ApproveOptions
 * @typedef {import('./approval.js').DispatchResult} DispatchResult
 * @typedef {import('./approval.js').Refusal} Refusal
 * @typedef {import('./approval.js').FactChange} FactChange
 * @typedef {import('./duration.js').Duration} Duration
 * @typedef {import('./duration.js').Moment} Moment
 * @typedef {import('./duration.js').Clock} Clock
 * @typedef {import('./errors.js').SendOnceErrorCode} SendOnceErrorCode
 */

export { sendKey, normaliseRecipient } from './key.js'
export { createLedger } from './ledger.js'
export { memoryStore, fileStore, sqlStore } from './stores.js'
export { approve, dispatch, hashPayload } from './approval.js'
export { parseDuration } from './duration.js'
export { SendOnceError, UncertainSendError } from './errors.js'

import { open, readFile, rename, link, unlink, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SendOnceError, errorCode } from './errors.js'

/**
 * @typedef {import('./ledger.js').Entry} Entry
 * @typedef {import('./ledger.js').Status} Status
 *
 * Where the ledger keeps its entries. Four async methods; write your own for any
 * database that can do an atomic insert-if-absent and a compare-and-set.
 *
 * Entries are plain JSON. Store them whole and hand them back unchanged.
 *
 * @typedef {object} Store
 * @property {(key: string, entry: Entry) => Promise<boolean>} claim
 *   Inserts the entry only if no entry exists for the key. Resolves true only if this
 *   call inserted it. Must be atomic: when two callers race, exactly one gets true.
 *   Must be durable before it resolves true, because the send happens next.
 * @property {(key: string, from: Status, entry: Entry) => Promise<boolean>} transition
 *   Replaces the entry only if the stored one's status is `from`. Resolves true only if
 *   it replaced it. Must be atomic (compare-and-set).
 * @property {(key: string) => Promise<Entry | null>} get
 * @property {(filter?: { status?: Status }) => Promise<Entry[]>} list
 *   Every entry, or only those with the given status. Returning more than asked for is
 *   allowed; the ledger filters again.
 */

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

/**
 * Keeps entries in a Map. For tests, and for a single process that never restarts:
 * everything is forgotten on exit, so a rerun after a crash will send again.
 *
 * Entries are copied through JSON on the way in and out, so it behaves like the stores
 * that persist (a Date in `meta` comes back as a string, as it would from a file).
 *
 * @returns {Store}
 */
export function memoryStore() {
  /** @type {Map<string, string>} */
  const entries = new Map()
  const load = (/** @type {string} */ json) => /** @type {Entry} */ (JSON.parse(json))

  return {
    async claim(key, entry) {
      if (entries.has(key)) return false
      entries.set(key, JSON.stringify({ ...entry, key }))
      return true
    },
    async transition(key, from, entry) {
      const current = entries.get(key)
      if (current === undefined || load(current).status !== from) return false
      entries.set(key, JSON.stringify({ ...entry, key }))
      return true
    },
    async get(key) {
      const current = entries.get(key)
      return current === undefined ? null : load(current)
    },
    async list(filter = {}) {
      return [...entries.values()].map(load).filter((e) => !filter.status || e.status === filter.status)
    },
  }
}

// ---------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------

/**
 * @typedef {object} FileStoreOptions
 * @property {number} [lockTimeoutMs] How long to wait for the lock before giving up with
 *   a `lock_timeout` error. Default 10000.
 * @property {number} [staleLockMs] A lock older than this whose process is gone is
 *   removed. Default 30000.
 */

/**
 * An append-only JSON Lines file: one entry per line, and the last line for a key is
 * its current state. Nothing is ever rewritten, so the file is also the history.
 *
 * Claims and transitions take a lock file next to it (`<path>.lock`, created with
 * O_EXCL), read the file, check, append, and fsync before releasing the lock. That makes
 * them atomic across every process on the machine, and durable before `once()` calls
 * your send.
 *
 * A lock whose process has died is removed once it is older than `staleLockMs`. A lock
 * held by a process that is still running, or by another host, is never taken over:
 * after `lockTimeoutMs` the call fails with `lock_timeout` and names the file.
 *
 * Limits: one machine, local disk. The lock is not safe on network filesystems. Every
 * operation reads the whole file, which is fine for tens of thousands of entries; use
 * `sqlStore` beyond that.
 *
 * @param {string} path
 * @param {FileStoreOptions} [options]
 * @returns {Store}
 */
export function fileStore(path, options = {}) {
  if (typeof path !== 'string' || path === '') throw new TypeError('fileStore needs a file path.')
  const { lockTimeoutMs = 10_000, staleLockMs = 30_000 } = options
  const lockPath = `${path}.lock`

  /** @returns {Promise<string>} */
  async function readText() {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * @param {Entry} entry
   * @param {string} text The file as it was read under the lock.
   */
  async function append(entry, text) {
    // A crash mid-write can leave a last line with no newline. Start on a fresh line so
    // the torn one stays torn instead of swallowing this entry.
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
    const handle = await open(path, 'a')
    try {
      await handle.write(`${lead}${JSON.stringify(entry)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withLock(fn) {
    const token = await acquireLock()
    try {
      return await fn()
    } finally {
      await releaseLock(token)
    }
  }

  /** @returns {Promise<string>} */
  async function acquireLock() {
    const token = randomBytes(8).toString('hex')
    const body = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() })
    const deadline = Date.now() + lockTimeoutMs
    let delay = 2
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx')
        try {
          await handle.writeFile(body)
        } finally {
          await handle.close()
        }
        return token
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      if (await breakIfStale()) continue
      if (Date.now() >= deadline) {
        throw new SendOnceError(
          'lock_timeout',
          `Could not lock ${path} within ${lockTimeoutMs}ms: ${lockPath} is held. ` +
            'If no process using this ledger is running, delete the lock file.',
        )
      }
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay))
      delay = Math.min(delay * 2, 50)
    }
  }

  /** @param {string} token */
  async function releaseLock(token) {
    try {
      const held = parseLock(await readFile(lockPath, 'utf8'))
      if (held?.token === token) await unlink(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  /**
   * Removes the lock if its holder is gone. True when the caller should try again at
   * once (the lock was removed, or had already vanished).
   *
   * @returns {Promise<boolean>}
   */
  async function breakIfStale() {
    let text
    let modified
    try {
      text = await readFile(lockPath, 'utf8')
      modified = (await stat(lockPath)).mtimeMs
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      throw error
    }
    const held = parseLock(text)
    const age = Date.now() - (held?.at ?? modified)
    if (age < staleLockMs) return false
    // An unreadable lock this old was left by a process that died between creating it
    // and writing to it. A readable one is only stale if its process is gone, which can
    // only be checked on the same host.
    if (held && (held.host !== hostname() || isAlive(held.pid))) return false

    // Move it aside under a unique name, then confirm it is the lock that was judged
    // stale. Another process may have removed that one and locked again in between.
    const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      await rename(lockPath, aside)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      throw error
    }
    const moved = await readFile(aside, 'utf8').catch(() => '')
    if (moved !== text) {
      // That was a live lock. Put it back, unless someone has locked again since.
      await link(aside, lockPath).catch(() => {})
    }
    await unlink(aside).catch(() => {})
    return true
  }

  return {
    async claim(key, entry) {
      return withLock(async () => {
        const text = await readText()
        if (parseLedger(text).entries.has(key)) return false
        await append({ ...entry, key }, text)
        return true
      })
    },
    async transition(key, from, entry) {
      return withLock(async () => {
        const text = await readText()
        const current = parseLedger(text).entries.get(key)
        if (!current || current.status !== from) return false
        await append({ ...entry, key }, text)
        return true
      })
    },
    // Reads take no lock. A line still being written is skipped, which shows the
    // previous state; the ledger never decides anything from a read alone.
    async get(key) {
      return parseLedger(await readText()).entries.get(key) ?? null
    },
    async list(filter = {}) {
      const all = [...parseLedger(await readText()).entries.values()]
      return all.filter((e) => !filter.status || e.status === filter.status)
    },
  }
}

/**
 * Reads a ledger file's text into the current state of each key.
 *
 * Lines that are not JSON entries are skipped and counted. A torn line is a write that
 * did not finish, from a crash or a write in flight. The claim it belonged to never
 * returned true, so nothing was sent on the strength of it.
 *
 * @param {string} text
 * @returns {{ entries: Map<string, Entry>, skipped: number }}
 */
export function parseLedger(text) {
  /** @type {Map<string, Entry>} */
  const entries = new Map()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (isEntry(parsed)) entries.set(parsed.key, parsed)
    else skipped++
  }
  return { entries, skipped }
}

/**
 * @param {unknown} value
 * @returns {value is Entry}
 */
function isEntry(value) {
  if (!value || typeof value !== 'object') return false
  const v = /** @type {Record<string, unknown>} */ (value)
  return (
    typeof v.key === 'string' &&
    (v.status === 'pending' || v.status === 'sent' || v.status === 'failed') &&
    typeof v.claimedAt === 'string'
  )
}

/**
 * @param {string} text
 * @returns {{ pid: number, host: string, token: string, at: number } | null}
 */
function parseLock(text) {
  try {
    const v = JSON.parse(text)
    if (
      v && typeof v.pid === 'number' && typeof v.host === 'string' &&
      typeof v.token === 'string' && typeof v.at === 'number'
    ) {
      return v
    }
  } catch {
    // Empty or half-written: treated as unreadable.
  }
  return null
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return errorCode(error) === 'EPERM'
  }
}

// ---------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------

/**
 * What your driver returns. Any of these shapes works: node-postgres' `{ rows, rowCount }`,
 * SQLite's `{ changes }`, or a plain array of rows.
 *
 * @typedef {Array<Record<string, unknown>>
 *   | { rows?: Array<Record<string, unknown>>, rowCount?: number | null, changes?: number | bigint, affectedRows?: number }} SqlResult
 *
 * Runs one statement with positional parameters on your own driver and connection.
 * @typedef {(sql: string, params: unknown[]) => Promise<SqlResult> | SqlResult} SqlQuery
 *
 * @typedef {object} SqlStoreOptions
 * @property {string} [table] Default 'send_once'. Letters, digits and underscores, with
 *   an optional schema prefix ('ops.send_once').
 * @property {'dollar'|'question'} [placeholder] '$1, $2' for Postgres (the default),
 *   '?' for SQLite.
 */

/**
 * A store in your own SQL database, through your own driver. Claims are
 * `INSERT ... ON CONFLICT (key) DO NOTHING`, transitions are
 * `UPDATE ... WHERE key = $1 AND status = $2`, and the affected row count decides who won,
 * so the database does the locking.
 *
 * Works with Postgres and SQLite 3.35 or newer (for RETURNING). Create the table first
 * with `sqlStore.schema()`.
 *
 * Do not run these statements inside a transaction that also wraps the send. If that
 * transaction rolls back, the claim goes with it and the record of the send is lost.
 *
 * @param {SqlQuery} query
 * @param {SqlStoreOptions} [options]
 * @returns {Store}
 */
export function sqlStore(query, options = {}) {
  if (typeof query !== 'function') throw new TypeError('sqlStore needs a query(sql, params) function.')
  const table = tableName(options.table ?? 'send_once')
  const placeholder = options.placeholder ?? 'dollar'
  if (placeholder !== 'dollar' && placeholder !== 'question') {
    throw new TypeError(`sqlStore: placeholder must be 'dollar' or 'question', got ${String(placeholder)}.`)
  }

  /**
   * @param {string} sql Written with $1, $2 placeholders.
   * @param {unknown[]} params
   * @returns {Promise<SqlResult>}
   */
  async function run(sql, params) {
    if (placeholder === 'dollar') return query(sql, params)
    /** @type {unknown[]} */
    const ordered = []
    const text = sql.replace(/\$(\d+)/g, (_, n) => {
      ordered.push(params[Number(n) - 1])
      return '?'
    })
    return query(text, ordered)
  }

  return {
    async claim(key, entry) {
      const result = await run(
        `INSERT INTO ${table} (key, status, entry, claimed_at, updated_at) ` +
          'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING key',
        [key, entry.status, JSON.stringify({ ...entry, key }), entry.claimedAt, entry.updatedAt],
      )
      return affected(result) > 0
    },
    async transition(key, from, entry) {
      const result = await run(
        `UPDATE ${table} SET status = $3, entry = $4, claimed_at = $5, updated_at = $6 ` +
          'WHERE key = $1 AND status = $2 RETURNING key',
        [key, from, entry.status, JSON.stringify({ ...entry, key }), entry.claimedAt, entry.updatedAt],
      )
      return affected(result) > 0
    },
    async get(key) {
      const found = rowsOf(await run(`SELECT entry FROM ${table} WHERE key = $1`, [key]))
      return found.length ? entryOf(found[0]) : null
    },
    async list(filter = {}) {
      const result = filter.status
        ? await run(`SELECT entry FROM ${table} WHERE status = $1 ORDER BY claimed_at`, [filter.status])
        : await run(`SELECT entry FROM ${table} ORDER BY claimed_at`, [])
      return rowsOf(result).map(entryOf)
    },
  }
}

/**
 * The CREATE TABLE statement for `sqlStore`, valid in Postgres and SQLite. The entry is
 * kept whole as JSON text; `status` and the timestamps are copied out so they can be
 * queried.
 *
 * @param {string} [table] Default 'send_once'.
 * @returns {string}
 */
sqlStore.schema = function schema(table = 'send_once') {
  return (
    `CREATE TABLE IF NOT EXISTS ${tableName(table)} (\n` +
    '  key TEXT PRIMARY KEY,\n' +
    '  status TEXT NOT NULL,\n' +
    '  entry TEXT NOT NULL,\n' +
    '  claimed_at TEXT NOT NULL,\n' +
    '  updated_at TEXT NOT NULL\n' +
    ')'
  )
}

/**
 * @param {string} name
 * @returns {string}
 */
function tableName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) {
    throw new TypeError(`sqlStore: not a safe table name: ${String(name)}`)
  }
  return name
}

/**
 * @param {SqlResult} result
 * @returns {number}
 */
function affected(result) {
  if (Array.isArray(result)) return result.length
  if (result && typeof result === 'object') {
    for (const field of /** @type {const} */ (['rowCount', 'changes', 'affectedRows'])) {
      const n = result[field]
      if (typeof n === 'number') return n
      if (typeof n === 'bigint') return Number(n)
    }
    if (Array.isArray(result.rows)) return result.rows.length
  }
  throw new SendOnceError(
    'bad_query_result',
    'sqlStore: query() returned no row count and no rows. Return the driver result, or an array of rows.',
  )
}

/**
 * @param {SqlResult} result
 * @returns {Array<Record<string, unknown>>}
 */
function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray(result.rows)) return result.rows
  throw new SendOnceError(
    'bad_query_result',
    'sqlStore: query() returned no rows for a SELECT. Return the driver result, or an array of rows.',
  )
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Entry}
 */
function entryOf(row) {
  const value = row.entry
  // TEXT comes back as a string; a JSON or JSONB column comes back already parsed.
  return /** @type {Entry} */ (typeof value === 'string' ? JSON.parse(value) : value)
}

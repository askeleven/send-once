import test from 'node:test'
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, readFile, utimes, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'

import { createLedger, fileStore, sqlStore, memoryStore, SendOnceError } from '../src/index.js'

const INDEX_URL = new URL('../src/index.js', import.meta.url).href

/**
 * A worker process: builds a ledger over a file, waits for "go", then fires `parallel`
 * once() calls at the same key. Its send appends its pid to a file, so the test can count
 * real sends across processes. In "crash" mode the send kills the process after the
 * claim, before anything is recorded.
 */
const CHILD = `
import { appendFileSync } from 'node:fs'
import { createLedger, fileStore } from ${JSON.stringify(INDEX_URL)}
const [ledgerPath, sendsPath, key, parallel, mode] = process.argv.slice(2)
const ledger = createLedger(fileStore(ledgerPath))
const send = async () => {
  appendFileSync(sendsPath, process.pid + '\\n')
  if (mode === 'crash') process.kill(process.pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 30))
  return { id: 'm-' + process.pid }
}
process.on('message', async (message) => {
  if (message !== 'go') return
  const results = await Promise.all(Array.from({ length: Number(parallel) }, () => ledger.once(key, send)))
  process.send(results.map((r) => r.outcome), () => process.exit(0))
})
process.send('ready')
`

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'send-once-'))
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
async function startChild(dir, args) {
  const script = join(dir, 'child.mjs')
  if (!existsSync(script)) await writeFile(script, CHILD)
  const child = fork(script, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  /** @type {Promise<string[] | null>} */
  const done = new Promise((resolve, reject) => {
    /** @type {string[] | null} */
    let outcomes = null
    child.on('message', (m) => {
      if (Array.isArray(m)) outcomes = /** @type {string[]} */ (m)
    })
    child.on('error', reject)
    child.on('exit', () => resolve(outcomes))
  })
  await new Promise((resolve) => child.once('message', resolve))
  return { child, done }
}

/** @param {string} path */
async function lines(path) {
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
}

test('fileStore: racing processes and parallel calls send exactly once', async () => {
  const dir = await tempDir()
  const ledgerPath = join(dir, 'ledger.jsonl')
  const sendsPath = join(dir, 'sends.log')
  const key = 'race-key'

  const workers = await Promise.all([1, 2, 3].map(() => startChild(dir, [ledgerPath, sendsPath, key, '5'])))
  const ledger = createLedger(fileStore(ledgerPath))
  const local = async () => {
    await new Promise((r) => setTimeout(r, 30))
    await writeFile(sendsPath, `${process.pid}\n`, { flag: 'a' })
    return 'local'
  }

  for (const w of workers) w.child.send('go')
  const [childOutcomes, ownOutcomes] = await Promise.all([
    Promise.all(workers.map((w) => w.done)),
    Promise.all(Array.from({ length: 5 }, () => ledger.once(key, local))),
  ])

  const outcomes = [...childOutcomes.flatMap((o) => o ?? []), ...ownOutcomes.map((r) => r.outcome)]
  assert.equal(outcomes.length, 20)
  assert.equal((await lines(sendsPath)).length, 1, 'one real send across four processes')
  assert.equal(outcomes.filter((o) => o === 'sent').length, 1)
  assert.ok(outcomes.every((o) => ['sent', 'unknown', 'duplicate'].includes(o)), outcomes.join(','))
  assert.equal((await ledger.get(key))?.status, 'sent')
  assert.equal(existsSync(`${ledgerPath}.lock`), false, 'the lock is released')
})

test('fileStore: a process killed mid-send leaves the key unknown, never resent', async () => {
  const dir = await tempDir()
  const ledgerPath = join(dir, 'ledger.jsonl')
  const sendsPath = join(dir, 'sends.log')

  const worker = await startChild(dir, [ledgerPath, sendsPath, 'crash-key', '1', 'crash'])
  worker.child.send('go')
  assert.equal(await worker.done, null, 'the worker died before reporting')
  assert.equal((await lines(sendsPath)).length, 1, 'the send had started')

  const ledger = createLedger(fileStore(ledgerPath))
  let calls = 0
  const result = await ledger.once('crash-key', async () => {
    calls++
  })
  assert.equal(result.outcome, 'unknown')
  assert.equal(calls, 0)
  assert.equal((await ledger.pending()).length, 1)
})

test('fileStore: a stale lock from a dead process is removed', async () => {
  const dir = await tempDir()
  const path = join(dir, 'ledger.jsonl')
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  await writeFile(`${path}.lock`, JSON.stringify({ pid: dead, host: hostname(), token: 't', at: Date.now() - 60_000 }))

  const ledger = createLedger(fileStore(path))
  assert.equal((await ledger.once('k', async () => 'id')).outcome, 'sent')
  assert.equal(existsSync(`${path}.lock`), false)
})

test('fileStore: an unreadable lock is judged by its age', async () => {
  const dir = await tempDir()
  const path = join(dir, 'ledger.jsonl')
  await writeFile(`${path}.lock`, '')
  const past = new Date(Date.now() - 60_000)
  await utimes(`${path}.lock`, past, past)
  const ledger = createLedger(fileStore(path))
  assert.equal((await ledger.once('k', async () => 'id')).outcome, 'sent')
})

test('fileStore: a lock held by a live process, or another host, is never taken over', async () => {
  const dir = await tempDir()
  const path = join(dir, 'ledger.jsonl')
  const store = fileStore(path, { lockTimeoutMs: 150 })
  const ledger = createLedger(store)

  for (const holder of [
    { pid: process.pid, host: hostname() },
    { pid: 999_999, host: 'some-other-host' },
  ]) {
    await writeFile(`${path}.lock`, JSON.stringify({ ...holder, token: 't', at: Date.now() - 3_600_000 }))
    let calls = 0
    await assert.rejects(
      ledger.once('k', async () => {
        calls++
      }),
      (e) => e instanceof SendOnceError && e.code === 'lock_timeout' && e.message.includes('.lock'),
    )
    assert.equal(calls, 0)
    assert.equal(existsSync(`${path}.lock`), true)
  }
  assert.equal(await store.get('k'), null)
})

test('fileStore: a torn last line is skipped and cannot swallow the next entry', async () => {
  const dir = await tempDir()
  const path = join(dir, 'ledger.jsonl')
  const good = { key: 'a', status: 'sent', attempts: 1, claimedAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', meta: null }
  await writeFile(path, `${JSON.stringify(good)}\n{"key":"b","status":"pend`)

  const store = fileStore(path)
  assert.equal((await store.get('a'))?.status, 'sent')
  assert.equal(await store.get('b'), null, 'the torn claim never completed')

  const ledger = createLedger(store)
  assert.equal((await ledger.once('b', async () => 'id')).outcome, 'sent')
  assert.equal((await ledger.once('c', async () => 'id')).outcome, 'sent')
  const text = await readFile(path, 'utf8')
  assert.equal(text.split('\n').filter(Boolean).length, 6, 'append-only: a, torn, b pending, b sent, c pending, c sent')
  assert.equal((await store.list()).length, 3)
})

test('fileStore: history is kept, state is the last line per key', async () => {
  const dir = await tempDir()
  const path = join(dir, 'ledger.jsonl')
  const store = fileStore(path)
  const ledger = createLedger(store)
  await ledger.once('k', async () => {
    throw new Error('rejected')
  })
  await ledger.once('k', async () => 'id')
  const history = (await lines(path)).map((l) => JSON.parse(l).status)
  assert.deepEqual(history, ['pending', 'failed', 'pending', 'sent'])
  assert.equal((await store.list({ status: 'sent' })).length, 1)
  assert.equal((await store.list({ status: 'failed' })).length, 0)
  assert.ok((await stat(path)).size > 0)
})

// -------------------------------------------------------------------------------------
// sqlStore against a fake driver that implements exactly the statements it is sent,
// with the same conflict and compare-and-set rules a real database applies.
// -------------------------------------------------------------------------------------

/**
 * @param {{ shape?: 'pg' | 'rows' }} [options] pg: { rows, rowCount }; rows: a bare array.
 */
function fakeDb(options = {}) {
  /** @type {Map<string, Record<string, unknown>>} */
  const rows = new Map()
  /** @type {Array<{ sql: string, params: unknown[] }>} */
  const log = []

  /**
   * @param {Array<Record<string, unknown>>} out
   * @param {number} [count]
   */
  const reply = (out, count = out.length) => (options.shape === 'rows' ? out : { rows: out, rowCount: count })

  /**
   * @param {string} sql
   * @param {unknown[]} params
   */
  async function query(sql, params) {
    log.push({ sql, params })
    // '?' placeholders bind in order of appearance; number them so both styles parse alike.
    let n = 0
    const text = sql.replace(/\?/g, () => `$${++n}`)
    /** @param {string} ref */
    const val = (ref) => params[Number(ref.slice(1)) - 1]
    let m

    if ((m = /^INSERT INTO (\w+) \(([\w, ]+)\) VALUES \(([$\d, ]+)\) ON CONFLICT \(key\) DO NOTHING RETURNING key$/.exec(text))) {
      const cols = m[2].split(', ')
      const refs = m[3].split(', ')
      /** @type {Record<string, unknown>} */
      const row = {}
      cols.forEach((c, i) => (row[c] = val(refs[i])))
      const k = /** @type {string} */ (row.key)
      if (rows.has(k)) return reply([])
      rows.set(k, row)
      return reply([{ key: k }])
    }
    if ((m = /^UPDATE (\w+) SET (.+) WHERE key = (\$\d+) AND status = (\$\d+) RETURNING key$/.exec(text))) {
      const k = /** @type {string} */ (val(m[3]))
      const row = rows.get(k)
      if (!row || row.status !== val(m[4])) return reply([])
      for (const assignment of m[2].split(', ')) {
        const [col, ref] = assignment.split(' = ')
        row[col] = val(ref)
      }
      return reply([{ key: k }])
    }
    if ((m = /^SELECT entry FROM (\w+) WHERE key = (\$\d+)$/.exec(text))) {
      const row = rows.get(/** @type {string} */ (val(m[2])))
      return reply(row ? [{ entry: row.entry }] : [])
    }
    if ((m = /^SELECT entry FROM (\w+)( WHERE status = (\$\d+))? ORDER BY claimed_at$/.exec(text))) {
      const status = m[3] ? val(m[3]) : null
      const out = [...rows.values()]
        .filter((r) => !status || r.status === status)
        .sort((a, b) => String(a.claimed_at).localeCompare(String(b.claimed_at)))
        .map((r) => ({ entry: r.entry }))
      return reply(out)
    }
    throw new Error(`fake db: unexpected statement: ${sql}`)
  }
  return { query, rows, log }
}

test('sqlStore: claim is insert-if-absent and transition is compare-and-set', async () => {
  const db = fakeDb()
  const ledger = createLedger(sqlStore(db.query))
  let calls = 0
  const send = async () => {
    calls++
    return { id: 'pg-1' }
  }

  const results = await Promise.all(Array.from({ length: 10 }, () => ledger.once('k', send, { to: 'a@b.co' })))
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.outcome === 'sent').length, 1)
  assert.equal((await ledger.once('k', send)).outcome, 'duplicate')

  const row = db.rows.get('k')
  assert.equal(row?.status, 'sent', 'the status column follows the entry')
  assert.equal(JSON.parse(String(row?.entry)).providerId, 'pg-1')
  assert.match(db.log[0].sql, /^INSERT INTO send_once .* ON CONFLICT \(key\) DO NOTHING RETURNING key$/)
  assert.ok(db.log.some((l) => /^UPDATE send_once SET .* WHERE key = \$1 AND status = \$2 RETURNING key$/.test(l.sql)))
})

test('sqlStore: failure, retry, resolve and pending all work through SQL', async () => {
  const db = fakeDb()
  const ledger = createLedger(sqlStore(db.query, { table: 'ops_sends' }))
  await ledger.once('f', async () => {
    throw new Error('rejected')
  })
  assert.equal(db.rows.get('f')?.status, 'failed')
  assert.equal((await ledger.once('f', async () => 'ok')).entry.attempts, 2)

  await ledger.once('u', async () => {
    throw new (await import('../src/index.js')).UncertainSendError('timeout')
  })
  assert.deepEqual((await ledger.pending()).map((e) => e.key), ['u'])
  await ledger.resolve('u', 'failed', { by: 'ops' })
  assert.deepEqual(await ledger.pending(), [])
  assert.ok(db.log.every((l) => l.sql.includes('ops_sends')))
})

test('sqlStore: question placeholders bind in order, and bare row arrays work', async () => {
  const db = fakeDb({ shape: 'rows' })
  const ledger = createLedger(sqlStore(db.query, { placeholder: 'question' }))
  assert.equal((await ledger.once('k', async () => 'id')).outcome, 'sent')
  assert.equal((await ledger.once('k', async () => 'id')).outcome, 'duplicate')

  const update = db.log.find((l) => l.sql.startsWith('UPDATE'))
  assert.ok(update)
  assert.equal(update.sql.includes('$'), false)
  assert.equal(update.sql, 'UPDATE send_once SET status = ?, entry = ?, claimed_at = ?, updated_at = ? WHERE key = ? AND status = ? RETURNING key')
  assert.deepEqual([update.params[0], update.params[4], update.params[5]], ['sent', 'k', 'pending'])
})

test('sqlStore: schema, table names and driver results are checked', async () => {
  assert.match(sqlStore.schema(), /^CREATE TABLE IF NOT EXISTS send_once \(\n {2}key TEXT PRIMARY KEY,/)
  assert.match(sqlStore.schema('ops.sends'), /ops\.sends/)
  assert.throws(() => sqlStore.schema('sends; DROP TABLE users'), TypeError)
  assert.throws(() => sqlStore(async () => [], { table: 'x y' }), TypeError)
  assert.throws(() => sqlStore(async () => [], { placeholder: /** @type {any} */ ('colon') }), TypeError)

  const store = sqlStore(async () => /** @type {any} */ ({}))
  await assert.rejects(store.get('k'), (e) => e instanceof SendOnceError && e.code === 'bad_query_result')

  // A driver that returns SQLite-style { changes } for writes.
  const sqlite = sqlStore(async (sql) => (sql.startsWith('INSERT') ? { changes: 1 } : { rows: [] }))
  assert.equal(await sqlite.claim('k', { key: 'k', status: 'pending', attempts: 1, claimedAt: 'x', updatedAt: 'x', meta: null }), true)
})

/** @type {any} */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  // Not in this Node version.
}

test('sqlStore on a real SQLite database (node:sqlite)', { skip: !sqlite && 'node:sqlite is not available' }, async () => {
  const db = new sqlite.DatabaseSync(':memory:')
  db.exec(sqlStore.schema())
  const store = sqlStore((sql, params) => db.prepare(sql).all(...params), { placeholder: 'question' })
  const ledger = createLedger(store)

  let calls = 0
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      ledger.once('k', async () => {
        calls++
        return 'id'
      }),
    ),
  )
  assert.equal(calls, 1)
  assert.equal(results.filter((r) => r.outcome === 'sent').length, 1)
  assert.equal((await ledger.once('k', async () => 'id')).outcome, 'duplicate')
  assert.equal(db.prepare('SELECT status FROM send_once WHERE key = ?').get('k').status, 'sent')
})

test('memoryStore copies entries, like a store that persists', async () => {
  const store = memoryStore()
  const meta = { when: new Date('2026-09-27T00:00:00Z') }
  await createLedger(store).once('k', async () => 'id', meta)
  const entry = await store.get('k')
  assert.equal(entry?.meta?.when, '2026-09-27T00:00:00.000Z')
  if (entry) entry.status = 'failed'
  assert.equal((await store.get('k'))?.status, 'sent')
})

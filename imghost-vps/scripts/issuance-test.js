'use strict';

// Exercise the real store and transaction helper without connecting to MySQL.
// The fake connection models named-lock ownership and transactional snapshots.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const db = require('../src/db');
const store = require('../src/store');
const { sha256 } = require('../src/security');

const REQUEST_ONE = '12345678-1234-4123-8123-123456789abc';
const REQUEST_TWO = '23456789-2345-4234-9234-23456789abcd';
const timestamp = (offset = 0) => new Date(Date.now() + offset).toISOString().slice(0, 19).replace('T', ' ');
const duplicateError = () => Object.assign(new Error('Duplicate key'), { code: 'ER_DUP_ENTRY', errno: 1062 });

function createPoolFixture() {
  let state = { tokens: [], requests: [], nextId: 1 };
  let nextConnectionId = 1;
  const locks = new Map();
  const events = [];
  const flags = {};
  const connections = [];

  function releaseLock(connection, type) {
    const lock = locks.get(type);
    if (!lock || lock.owner !== connection) return false;
    const next = lock.waiters.shift();
    if (next) {
      lock.owner = next.connection;
      next.resolve();
    } else {
      locks.delete(type);
    }
    return true;
  }

  function executeData(transaction, sql, params) {
    if (sql.startsWith('INSERT INTO `code_requests`')) {
      if (transaction.requests.some((row) => row.request_id === params[0])) throw duplicateError();
      transaction.requests.push({ request_id: params[0], type: params[1], created_at: timestamp() });
      return { affectedRows: 1 };
    }
    if (sql.startsWith('SELECT `created_at` FROM `tokens`')) {
      const latest = transaction.tokens.filter((row) => row.type === params[0]).sort((a, b) => b.id - a.id)[0];
      return latest ? [{ created_at: latest.created_at }] : [];
    }
    if (sql.startsWith('UPDATE `tokens` SET `revoked_at`')) {
      let affectedRows = 0;
      for (const row of transaction.tokens) {
        if (row.type === params[0] && row.revoked_at === null) {
          row.revoked_at = timestamp();
          affectedRows++;
        }
      }
      return { affectedRows };
    }
    if (sql.startsWith('INSERT INTO `tokens`')) {
      if (flags.failInsert) throw new Error('Simulated token insert failure');
      if (transaction.tokens.some((row) => row.token_hash === params[0])) throw duplicateError();
      const id = transaction.nextId++;
      transaction.tokens.push({
        id, token_hash: params[0], type: params[1], expires_at: params[2] || null,
        created_at: timestamp(), revoked_at: null, consumed_at: null, last_used_at: null
      });
      return { insertId: id, affectedRows: 1 };
    }
    throw new Error('Unhandled fake SQL: ' + sql);
  }

  const pool = {
    pool: { on() {} },
    async getConnection() {
      const id = nextConnectionId++;
      let transaction = null;
      const connection = {
        id,
        async query(sql) {
          events.push({ id, action: 'query', sql });
          assert.equal(sql, 'SELECT 1');
          return [[], []];
        },
        async execute(sql, params = []) {
          events.push({ id, action: 'execute', sql, params });
          if (sql.startsWith('SELECT GET_LOCK(')) {
            if (flags.lockTimeout) return [[{ acquired: 0 }], []];
            const type = params[0];
            const lock = locks.get(type);
            if (lock) {
              await new Promise((resolve) => lock.waiters.push({ connection, resolve }));
            } else {
              locks.set(type, { owner: connection, waiters: [] });
            }
            events.push({ id, action: 'lock-acquired', type });
            return [[{ acquired: 1 }], []];
          }
          if (sql.startsWith('SELECT RELEASE_LOCK(')) {
            if (flags.failRelease) throw new Error('Simulated release failure');
            return [[{ released: releaseLock(connection, params[0]) ? 1 : 0 }], []];
          }
          assert.ok(transaction, 'All token statements run inside the same active transaction');
          return [executeData(transaction, sql, params), []];
        },
        async beginTransaction() {
          events.push({ id, action: 'begin' });
          assert.ok([...locks.values()].some((lock) => lock.owner === connection), 'Named lock precedes transaction');
          transaction = structuredClone(state);
          if (flags.failBegin) throw new Error('Simulated begin failure');
        },
        async commit() {
          events.push({ id, action: 'commit' });
          if (flags.failCommit) throw new Error('Simulated commit failure');
          assert.ok(transaction);
          state = transaction;
          transaction = null;
        },
        async rollback() {
          events.push({ id, action: 'rollback' });
          if (flags.failRollback) throw new Error('Simulated rollback failure');
          transaction = null;
        },
        release() {
          events.push({ id, action: 'release' });
          assert.equal(transaction, null, 'A connection with an open transaction is never returned to the pool');
        },
        destroy() {
          events.push({ id, action: 'destroy' });
          transaction = null;
          for (const type of [...locks.keys()]) releaseLock(connection, type);
        }
      };
      connections.push(connection);
      return connection;
    },
    async execute() {
      throw new Error('Transactions must execute on their reserved connection, not on the pool');
    },
    async end() {
      assert.equal(locks.size, 0, 'No named lock is leaked');
    }
  };
  return { pool, events, flags, connections, get state() { return state; } };
}

test('code issuance transactions and request replay protection', async (t) => {
  const originalCreatePool = mysql.createPool;
  const logger = require('../src/logger');
  const originalInfo = logger.info;
  let fixture;
  mysql.createPool = (options) => { fixture.poolOptions = options; return fixture.pool; };
  logger.info = () => {};
  async function fresh() {
    await db.close();
    fixture = createPoolFixture();
    await db.connect({ host: '127.0.0.1', port: 3306, database: 'test', user: 'test', password: 'test' });
    fixture.events.length = 0;
    return fixture;
  }
  try {
    await t.test('uninitialized transaction helper fails without running an operation', async () => {
      let invoked = false;
      await assert.rejects(db.withTokenTransaction('upload', async () => { invoked = true; }), /not initialised/);
      assert.equal(invoked, false);
    });

    await t.test('database decoding preserves large imported IDs without changing ordinary numeric IDs', async () => {
      const f = await fresh();
      assert.equal(f.poolOptions.supportBigNumbers, true);
      assert.equal(f.poolOptions.bigNumberStrings, false);
      assert.equal(f.poolOptions.dateStrings, true);
      assert.equal(f.poolOptions.timezone, 'Z');
    });

    await t.test('CLI issuance returns a string and holds the lock through commit', async () => {
      const f = await fresh();
      const code = await store.issueToken('upload', 0);
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.equal(f.state.tokens.length, 1);
      assert.equal(f.state.tokens[0].token_hash, sha256(code));
      assert.equal(f.state.tokens[0].expires_at, null);
      assert.deepEqual(f.state.requests, []);
      assert.equal(new Set(f.events.map((event) => event.id)).size, 1);
      assert.deepEqual(f.events.map((event) => event.action), [
        'execute', 'lock-acquired', 'begin', 'execute', 'execute', 'commit', 'execute', 'release'
      ]);
      assert.match(f.events[0].sql, /GET_LOCK\(SHA2\(CONCAT\(DATABASE\(\)/);
      assert.match(f.events.at(-2).sql, /RELEASE_LOCK/);
    });

    await t.test('management issuance retains a 20 minute expiry and stores only hashes', async () => {
      const f = await fresh();
      const before = Date.now();
      const result = await store.issueTokenDetails('management', 20, REQUEST_ONE);
      const after = Date.now();
      const expiry = Date.parse(result.expiresAt);
      assert.ok(expiry >= before + 20 * 60000 - 1000 && expiry <= after + 20 * 60000);
      assert.equal(f.state.tokens[0].expires_at, result.expiresAt.slice(0, 19).replace('T', ' '));
      assert.equal(f.state.tokens[0].token_hash, sha256(result.code));
      assert.equal(f.state.requests.length, 1);
      assert.deepEqual(Object.keys(f.state.requests[0]).sort(), ['created_at', 'request_id', 'type']);
      assert.ok(!JSON.stringify(f.state).includes(result.code));
    });

    await t.test('invalid or overflowing TTLs fail before any database operation', async () => {
      const f = await fresh();
      const now = Date.now();
      const beyondMysqlTtl = (Date.parse('+010000-01-01T00:00:00Z') - now) / 60000 + 1;
      assert.ok(Number.isFinite(beyondMysqlTtl));
      assert.equal(new Date(now + Math.round(beyondMysqlTtl) * 60000).getUTCFullYear(), 10000);
      for (const ttl of [Infinity, -Infinity, NaN, Number.MAX_VALUE, beyondMysqlTtl, 'Infinity', 'not-a-number', true, {}, '']) {
        for (const type of ['upload', 'management']) {
          await assert.rejects(store.issueTokenDetails(type, ttl, REQUEST_ONE), (error) => {
            assert.equal(error.status, 503);
            assert.match(error.message, /Token expiry configuration.*9999-12-31/);
            return true;
          });
        }
      }
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.state.tokens, []);
      assert.deepEqual(f.state.requests, []);
    });

    await t.test('null upload TTL preserves the existing non-expiring SQL shape', async () => {
      const f = await fresh();
      const result = await store.issueTokenDetails('upload', null);
      assert.equal(result.expiresAt, null);
      assert.equal(f.state.tokens[0].expires_at, null);
      const insertion = f.events.find((event) => event.sql?.startsWith('INSERT INTO `tokens`'));
      assert.equal(insertion.params.length, 2);
      assert.doesNotMatch(insertion.sql, /expires_at/);
    });

    await t.test('valid expiry is computed after the issuance lock and keeps minute rounding', async (t) => {
      await fresh();
      let now = Date.parse('2026-11-26T00:00:00Z');
      t.mock.method(Date, 'now', () => now);
      const withTokenTransaction = db.withTokenTransaction;
      t.mock.method(db, 'withTokenTransaction', (type, operation) => withTokenTransaction(type, async (query) => {
        now += 5000;
        return operation(query);
      }));
      const result = await store.issueTokenDetails('management', 1.6);
      assert.equal(result.expiresAt, '2026-11-26T00:02:05Z');
    });

    await t.test('the last MySQL DATETIME second remains a valid expiry', async (t) => {
      const f = await fresh();
      const now = Date.parse('2026-11-26T00:00:59Z');
      t.mock.method(Date, 'now', () => now);
      const ttl = (Date.parse('9999-12-31T23:59:59Z') - now) / 60000;
      const result = await store.issueTokenDetails('management', ttl);
      assert.equal(result.expiresAt, '9999-12-31T23:59:59Z');
      assert.equal(f.state.tokens[0].expires_at, '9999-12-31 23:59:59');
    });

    await t.test('duplicate remote request cannot issue or revoke another code', async () => {
      const f = await fresh();
      const first = await store.issueTokenDetails('upload', 0, REQUEST_ONE);
      const before = structuredClone(f.state);
      await assert.rejects(store.issueTokenDetails('upload', 0, REQUEST_ONE.toUpperCase()), (err) => err.status === 409);
      assert.deepEqual(f.state, before);
      assert.equal(f.state.tokens[0].token_hash, sha256(first.code));
      assert.equal(f.state.tokens[0].revoked_at, null);
    });

    await t.test('request IDs cannot be replayed for the other token type', async () => {
      const f = await fresh();
      await store.issueTokenDetails('upload', 0, REQUEST_ONE);
      const before = structuredClone(f.state);
      await assert.rejects(store.issueTokenDetails('management', 20, REQUEST_ONE), (err) => err.status === 409);
      assert.deepEqual(f.state, before);
    });

    await t.test('cooldown rolls back request reservation and leaves the current token valid', async () => {
      const f = await fresh();
      const code = await store.issueToken('upload', 0);
      const before = structuredClone(f.state);
      await assert.rejects(store.issueTokenDetails('upload', 0, REQUEST_TWO), (err) => err.status === 429 && err.retryAfterSeconds >= 1);
      assert.deepEqual(f.state, before);
      assert.equal(f.state.tokens[0].token_hash, sha256(code));
      // Retry the same uncommitted request ID after the cooldown has elapsed.
      f.state.tokens[0].created_at = timestamp(-10000);
      await store.issueTokenDetails('upload', 0, REQUEST_TWO);
      assert.equal(f.state.requests.length, 1);
      assert.equal(f.state.tokens.filter((row) => row.revoked_at === null).length, 1);
    });

    await t.test('a failed insert restores the previous token and discards the request ID', async () => {
      const f = await fresh();
      await store.issueToken('management', 20);
      f.state.tokens[0].created_at = timestamp(-10000);
      const before = structuredClone(f.state);
      f.flags.failInsert = true;
      await assert.rejects(store.issueTokenDetails('management', 20, REQUEST_ONE), /insert failure/);
      assert.deepEqual(f.state, before);
      assert.ok(f.events.some((event) => event.action === 'rollback'));
    });

    await t.test('future timestamps in imported tokens do not create an extended remote issuance lockout', async () => {
      const f = await fresh();
      const oldCode = await store.issueToken('upload', 0);
      f.state.tokens[0].created_at = timestamp(24 * 60 * 60000);
      const details = await store.issueTokenDetails('upload', 0, REQUEST_ONE);
      assert.notEqual(details.code, oldCode);
      assert.equal(f.state.tokens.filter((row) => row.revoked_at === null).length, 1);
      assert.equal(f.state.tokens.at(-1).token_hash, sha256(details.code));
      assert.equal(f.state.requests.length, 1);
    });

    await t.test('a failed commit rolls back the replacement and request reservation', async () => {
      const f = await fresh();
      await store.issueToken('upload', 0);
      f.state.tokens[0].created_at = timestamp(-10000);
      const before = structuredClone(f.state);
      f.flags.failCommit = true;
      await assert.rejects(store.issueTokenDetails('upload', 0, REQUEST_ONE), /commit failure/);
      assert.deepEqual(f.state, before);
      assert.ok(f.events.some((event) => event.action === 'rollback'));
    });

    await t.test('concurrent SSH issuances serialize and leave exactly one unrevoked code', async () => {
      const f = await fresh();
      const [first, second] = await Promise.all([store.issueToken('upload', 0), store.issueToken('upload', 0)]);
      assert.notEqual(first, second);
      assert.equal(f.state.tokens.length, 2);
      const active = f.state.tokens.filter((row) => row.revoked_at === null);
      assert.equal(active.length, 1);
      assert.equal(active[0].token_hash, sha256(second));
      const commits = f.events.filter((event) => event.action === 'commit');
      const begins = f.events.filter((event) => event.action === 'begin');
      assert.equal(commits.length, 2);
      assert.ok(f.events.indexOf(commits[0]) < f.events.indexOf(begins[1]));
    });

    await t.test('concurrent issue and revoke share the same lock', async () => {
      const f = await fresh();
      const [code, revoked] = await Promise.all([store.issueToken('management', 20), store.revokeToken('management')]);
      assert.equal(typeof code, 'string');
      assert.equal(revoked, 1);
      assert.equal(f.state.tokens.filter((row) => row.revoked_at === null).length, 0);
      const acquisitions = f.events.filter((event) => event.action === 'lock-acquired');
      assert.deepEqual(acquisitions.map((event) => event.type), ['management', 'management']);
    });

    await t.test('concurrent duplicate remote requests yield one code and one conflict', async () => {
      const f = await fresh();
      const results = await Promise.allSettled([
        store.issueTokenDetails('upload', 0, REQUEST_ONE),
        store.issueTokenDetails('upload', 0, REQUEST_ONE)
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
      assert.equal(f.state.tokens.length, 1);
      assert.equal(f.state.requests.length, 1);
    });

    await t.test('a lock timeout fails closed and releases the unused connection', async () => {
      const f = await fresh();
      f.flags.lockTimeout = true;
      let invoked = false;
      await assert.rejects(db.withTokenTransaction('upload', async () => { invoked = true; }), (err) => err.status === 503);
      assert.equal(invoked, false);
      assert.deepEqual(f.events.map((event) => event.action), ['execute', 'release']);
    });

    await t.test('rollback failure destroys the connection rather than returning it to the pool', async () => {
      const f = await fresh();
      f.flags.failRollback = true;
      await assert.rejects(db.withTokenTransaction('upload', async () => { throw new Error('Original operation failure'); }), /Original operation failure/);
      assert.equal(f.events.at(-1).action, 'destroy');
      assert.ok(!f.events.some((event) => event.action === 'release'));
    });

    await t.test('an uncertain transaction start destroys the connection without running the operation', async () => {
      const f = await fresh();
      f.flags.failBegin = true;
      let invoked = false;
      await assert.rejects(db.withTokenTransaction('upload', async () => { invoked = true; }), /begin failure/);
      assert.equal(invoked, false);
      assert.equal(f.events.at(-1).action, 'destroy');
      assert.ok(!f.events.some((event) => event.action === 'release'));
      assert.deepEqual(f.state.tokens, []);
    });

    await t.test('lock-release failure destroys a committed connection', async () => {
      const f = await fresh();
      f.flags.failRelease = true;
      const code = await store.issueToken('upload', 0);
      assert.equal(f.state.tokens[0].token_hash, sha256(code));
      assert.equal(f.events.at(-1).action, 'destroy');
    });

    await t.test('invalid issuance input performs no database operation', async () => {
      const f = await fresh();
      await assert.rejects(store.issueTokenDetails('admin', 20, REQUEST_ONE), /Invalid token type/);
      await assert.rejects(store.issueTokenDetails('upload', 0, 'not-a-request-id'), /Invalid code request ID/);
      assert.deepEqual(f.events, []);
    });
  } finally {
    await db.close();
    mysql.createPool = originalCreatePool;
    logger.info = originalInfo;
  }
});

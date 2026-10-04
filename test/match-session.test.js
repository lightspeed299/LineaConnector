'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MatchSession } = require('../match-session');

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const preparation = { sessionId: 'session1', epoch: 1, engineUri: 'le://engine/test', protocolVersion: 1 };
const request = { sessionId: 'session1', epoch: 1, requestId: 'r1', ply: 0, positionHash: 'hash1',
  rootInitialSfen: SFEN, moves: [], clock: { btime: 1000, wtime: 1000, byoyomi: 0 }, timeoutMs: 1000 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(overrides = {}) {
  const events = [];
  let resolveSearch;
  let searches = 0;
  let restores = 0;
  const engine = { running: true, id: { name: 'Test Engine' },
    setOptions: async (options) => { assert.deepEqual(options, { MultiPV: 1, USI_Ponder: false }); },
    newGame: async () => {},
    search: () => { searches++; return new Promise((resolve) => { resolveSearch = resolve; }); },
    stopAndWait: async () => { resolveSearch?.({ status: 'preempted' }); },
    gameOver: async () => { resolveSearch?.({ status: 'preempted' }); },
  };
  const session = new MatchSession({ engine: () => engine, deviceId: () => 'device1',
    drain: async () => {}, prepare: async () => engine, restore: async () => { restores++; },
    status: () => {}, emit: (event, payload) => events.push({ event, payload }), ...overrides });
  return { session, engine, events, resolve: (value) => resolveSearch(value),
    searches: () => searches, restores: () => restores };
}

test('prepare reserves lease immediately and matching search is idempotent', async () => {
  const f = fixture();
  const pending = f.session.prepare(preparation);
  assert.equal(f.session.busy, true);
  await assert.rejects(f.session.prepare({ ...preparation, sessionId: 'another' }), /busy/);
  const ready = await pending;
  assert.equal(ready.deviceId, 'device1');
  assert.equal(ready.engineName, 'Test Engine');
  f.session.search(request);
  f.session.search(request);
  assert.equal(f.searches(), 1);
  assert.throws(() => f.session.search({ ...request, positionHash: 'other' }), /different content/);
  f.resolve({ status: 'done', bestmove: '7g7f' });
  await tick();
  assert.deepEqual(f.events[0].payload, { sessionId: 'session1', epoch: 1, requestId: 'r1', ply: 0,
    positionHash: 'hash1', bestmove: '7g7f' });
  f.session.search(request);
  assert.equal(f.events.length, 2);
  assert.equal(f.searches(), 1);
  await f.session.finish({ ...preparation, result: 'win' });
  assert.equal(f.session.busy, false);
  assert.equal(f.restores(), 1);
});

test('cancel rejects stale epoch/request and suppresses a bestmove already in flight', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  f.session.search(request);
  await assert.rejects(f.session.cancel({ ...request, epoch: 0 }), /Stale/);
  await assert.rejects(f.session.cancel({ ...request, requestId: 'old' }), /Stale/);
  const cancellation = f.session.cancel(request);
  f.resolve({ status: 'done', bestmove: '7g7f' });
  await cancellation;
  await tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.session.busy, true);
  assert.throws(() => f.session.search({ ...request, requestId: 'r2' }), /not ready/);
  await f.session.prepare({ ...preparation, epoch: 2 });
  assert.throws(() => f.session.search(request), /not ready/);
  f.session.search({ ...request, epoch: 2, requestId: 'r2' });
  await f.session.finish({ ...preparation, epoch: 2, result: null });
  await tick();
  assert.equal(f.events.length, 0);
});

test('cancel during preparation cannot reactivate the cancelled lease', async () => {
  let drain;
  const f = fixture({ drain: () => new Promise((resolve) => { drain = resolve; }) });
  const preparationPromise = f.session.prepare(preparation);
  await tick();
  const rejected = assert.rejects(preparationPromise, /cancelled/);
  const cancelled = f.session.cancel(preparation);
  drain();
  await rejected;
  await cancelled;
  assert.equal(f.session.session.ready, false);
  await f.session.finish({ ...preparation, result: null });
});

test('disconnect and engine failure never continue or emit stale moves', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  f.session.search(request);
  const disconnected = f.session.disconnected();
  f.resolve({ status: 'done', bestmove: 'win' });
  await disconnected;
  await tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.session.busy, false);
  await f.session.prepare(preparation);
  f.session.search(request);
  f.session.engineFailed('crashed');
  f.resolve({ status: 'done', bestmove: '7g7f' });
  await tick();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event, 'connector:match_error');
  assert.equal(f.session.session.ready, false);
});

test('invalid search protocol cannot reach the engine', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  for (const invalid of [{ ...request, epoch: 2 }, { ...request, timeoutMs: Infinity },
    { ...request, moves: ['7g7f\nquit'] }, { ...request, clock: { btime: -1, wtime: 0 } }]) {
    assert.throws(() => f.session.search(invalid));
  }
  assert.equal(f.searches(), 0);
});

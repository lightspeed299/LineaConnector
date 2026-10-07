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
  let resolvePonder;
  let searches = 0;
  let restores = 0;
  const ponders = [];
  let ponderInfo = null;
  const engine = { running: true, id: { name: 'Test Engine' },
    setOptions: async (options) => { assert.deepEqual(options, { MultiPV: 1, USI_Ponder: false }); },
    newGame: async () => {},
    search: (sfen, limit) => {
      if (limit.type === 'infinite') {
        ponders.push(limit.moves);
        return new Promise((resolve) => { resolvePonder = resolve; });
      }
      searches++;
      return new Promise((resolve) => { resolveSearch = resolve; });
    },
    // A stopped analysis answers with its last principal variation, like a real engine.
    stop: () => { resolvePonder?.(ponderInfo ? { status: 'done', bestmove: '2g2f', lastParsed: ponderInfo } : { status: 'preempted' }); },
    stopAndWait: async () => { resolveSearch?.({ status: 'preempted' }); resolvePonder?.({ status: 'preempted' }); },
    gameOver: async () => { resolveSearch?.({ status: 'preempted' }); resolvePonder?.({ status: 'preempted' }); },
  };
  const session = new MatchSession({ engine: () => engine, deviceId: () => 'device1',
    drain: async () => {}, prepare: async () => engine, restore: async () => { restores++; },
    status: () => {}, emit: (event, payload) => events.push({ event, payload }), ...overrides });
  return { session, engine, events, resolve: (value) => resolveSearch(value),
    searches: () => searches, restores: () => restores, ponders, setPonderInfo: (info) => { ponderInfo = info; } };
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

test('a reply reports the engine thinking, capped to the recorded PV length', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  f.session.search(request);
  const pv = ['7g7f', '3c3d', '2g2f', '8c8d', '2f2e', '8d8e', '6i7h', '4a3b', '2e2d', '2c2d', '2h2d', 'P*2c', '2d2h', '9c9d'];
  f.resolve({ status: 'done', bestmove: '7g7f', lastParsed: { scoreCP: 52, depth: 18, seldepth: 24, nodes: 1200000, timeMs: 950, pv } });
  await tick();
  assert.deepEqual(f.events[0].payload.think, { scoreCp: 52, depth: 18, seldepth: 24, nodes: 1200000, timeMs: 950, pv: pv.slice(0, 12) });
  const mate = fixture();
  await mate.session.prepare(preparation);
  mate.session.search(request);
  mate.resolve({ status: 'done', bestmove: '7g7f', lastParsed: { scoreMate: -7, upperbound: true, pv: ['7g7f', 'bad move'] } });
  await tick();
  assert.deepEqual(mate.events[0].payload.think, { scoreMate: -7, bound: 'upper', pv: ['7g7f'] });
});

test('the human turn is analyzed after a reply and reported with the next one', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  f.session.search({ ...request, moves: ['7g7f'], ply: 1 });
  f.resolve({ status: 'done', bestmove: '3c3d' });
  await tick();
  assert.deepEqual(f.ponders, [['7g7f', '3c3d']], 'the position after our reply is analyzed while the human thinks');
  f.setPonderInfo({ scoreCP: -40, depth: 22, nodes: 9000000, pv: ['2g2f', '8c8d'] });
  f.session.search({ ...request, requestId: 'r2', moves: ['7g7f', '3c3d', '6g6f'], ply: 3 });
  await tick();
  assert.equal(f.searches(), 2, 'the reply search starts once the analysis has stopped');
  f.resolve({ status: 'done', bestmove: '8c8d' });
  await tick();
  assert.deepEqual(f.events[1].payload.opponentThink, { ply: 2, scoreCp: -40, depth: 22, nodes: 9000000, pv: ['2g2f', '8c8d'] });
  assert.deepEqual(f.ponders.at(-1), ['7g7f', '3c3d', '6g6f', '8c8d']);
  // A request that does not continue the analyzed line (待った) carries no analysis.
  f.session.search({ ...request, requestId: 'r3', moves: ['7g7f'], ply: 1 });
  await tick();
  f.resolve({ status: 'done', bestmove: '3c3d' });
  await tick();
  assert.equal(f.events[2].payload.opponentThink, undefined);
});

test('no analysis after resign or win, and none survives cancel, finish or disconnect', async () => {
  const f = fixture();
  await f.session.prepare(preparation);
  f.session.search(request);
  f.resolve({ status: 'done', bestmove: 'resign' });
  await tick();
  assert.equal(f.ponders.length, 0);
  f.session.ponder({ ...preparation, rootInitialSfen: SFEN, moves: ['7g7f'] });
  assert.equal(f.ponders.length, 1, 'Linea can ask for the human turn to be analyzed');
  f.session.ponder({ ...preparation, rootInitialSfen: SFEN, moves: ['7g7f'] });
  assert.equal(f.ponders.length, 1, 'the same position is not restarted');
  await f.session.cancel(preparation);
  assert.equal(f.session.session.ponder, null);
  f.session.ponder({ ...preparation, epoch: 0, rootInitialSfen: SFEN, moves: [] });
  assert.equal(f.ponders.length, 1, 'a stale epoch is ignored');
  assert.throws(() => { f.session.session.ready = true; f.session.ponder({ ...preparation, rootInitialSfen: SFEN, moves: ['7g7f\nquit'] }); });
  await f.session.finish({ ...preparation, result: null });
  assert.equal(f.session.busy, false);
  await f.session.prepare({ ...preparation, epoch: 2 });
  f.session.ponder({ ...preparation, epoch: 2, rootInitialSfen: SFEN, moves: [] });
  assert(f.session.session.ponder);
  const session = f.session.session;
  await f.session.disconnected();
  assert.equal(session.ponder, null);
});

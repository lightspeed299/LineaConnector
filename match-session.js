'use strict';

// One local engine lease. Transport ids are retained verbatim; no result survives
// cancellation, a new preparation, or a disconnected Socket.IO connection.
const { clockCommand, matchPosition } = require('./usi-engine');

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validEpoch(value) {
  return (Number.isSafeInteger(value) && value >= 0) || validId(value);
}

function envelope(data) {
  return { sessionId: data.sessionId, epoch: data.epoch, requestId: data.requestId,
    ply: data.ply, positionHash: data.positionHash };
}

// Linea keeps the same reading length as its game-room analysis.
const PV_LIMIT = 12;
const USI_MOVE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

/** The last principal-variation info of a search, as Linea records it (score from the side to move). */
function thinking(parsed) {
  if (!parsed) return undefined;
  const out = {};
  if (Number.isFinite(parsed.scoreCP)) out.scoreCp = Math.trunc(parsed.scoreCP);
  else if (Number.isFinite(parsed.scoreMate)) out.scoreMate = Math.trunc(parsed.scoreMate);
  else return undefined;
  if (parsed.lowerbound) out.bound = 'lower';
  else if (parsed.upperbound) out.bound = 'upper';
  for (const key of ['depth', 'seldepth', 'nodes', 'timeMs']) {
    if (Number.isSafeInteger(parsed[key]) && parsed[key] >= 0) out[key] = parsed[key];
  }
  if (Array.isArray(parsed.pv)) {
    const pv = [];
    for (const move of parsed.pv) { if (!USI_MOVE.test(move) || pv.length >= PV_LIMIT) break; pv.push(move); }
    if (pv.length) out.pv = pv;
  }
  return out;
}

class MatchSession {
  constructor(hooks) {
    this.hooks = hooks;
    this.session = null;
    this.transition = Promise.resolve();
    this.finished = new Map();
  }

  get busy() { return this.session !== null; }

  _queue(action) {
    const next = this.transition.then(action);
    this.transition = next.catch(() => {});
    return next;
  }

  _matches(data) {
    return this.session && data?.sessionId === this.session.sessionId && data?.epoch === this.session.epoch;
  }

  prepare(data) {
    if (!validId(data?.sessionId) || !validEpoch(data?.epoch) || data?.protocolVersion !== 1 ||
        typeof data?.engineUri !== 'string' || data.engineUri.length > 256) {
      return Promise.reject(new Error('Invalid match preparation'));
    }
    if (this.finished.has(`${data.sessionId}:${data.epoch}`)) return Promise.reject(new Error('Match already finished'));
    if (this.session && this.session.sessionId !== data.sessionId) return Promise.reject(new Error('Connector is busy'));
    if (this.session && typeof data.epoch === 'number' && typeof this.session.epoch === 'number' && data.epoch < this.session.epoch) {
      return Promise.reject(new Error('Stale match preparation'));
    }
    if (this._matches(data)) {
      if (this.session.engineUri !== data.engineUri) return Promise.reject(new Error('Engine changed within match epoch'));
      if (this.session.preparePromise) return this.session.preparePromise;
    }
    const session = { sessionId: data.sessionId, epoch: data.epoch, engineUri: data.engineUri,
      ready: false, request: null, usedRequests: new Map(), finished: false };
    if (this.session) this.session.request = null;
    this.session = session; // block every local competing entry before the first await
    this.hooks.status();
    session.preparePromise = this._queue(async () => {
      try {
        await this.hooks.drain();
        if (this.session !== session || session.finished || session.cancelled) throw new Error('Preparation cancelled');
        const engine = await this.hooks.prepare(session.engineUri);
        if (this.session !== session || session.finished || session.cancelled) throw new Error('Preparation cancelled');
        if (!engine?.running) throw new Error('Engine unavailable');
        await engine.setOptions({ MultiPV: 1, USI_Ponder: false });
        await engine.newGame();
        if (this.session !== session || session.finished || session.cancelled || !engine.running) throw new Error('Preparation cancelled');
        session.ready = true;
        const result = { sessionId: session.sessionId, epoch: session.epoch, engineUri: session.engineUri,
          deviceId: this.hooks.deviceId(), engineName: engine.id?.name || '', ok: true };
        this.hooks.status();
        return result;
      } catch (error) {
        session.ready = false;
        throw error;
      }
    });
    return session.preparePromise;
  }

  search(data) {
    const session = this.session;
    if (!this._matches(data) || !session.ready || session.finished) throw new Error('Match is not ready');
    if (!validId(data?.requestId) || !Number.isSafeInteger(data?.ply) || data.ply < 0 || data.ply > 4096 ||
        !validId(data?.positionHash) || !Number.isSafeInteger(data?.timeoutMs) || data.timeoutMs < 1 || data.timeoutMs > 250_000_000) {
      throw new Error('Invalid search request');
    }
    matchPosition(data.rootInitialSfen, data.moves);
    clockCommand(data.clock);
    const fingerprint = JSON.stringify([data.ply, data.positionHash, data.rootInitialSfen, data.moves, data.clock, data.timeoutMs]);
    const previous = session.usedRequests.get(data.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request id reused with different content');
      if (previous.result) this.hooks.emit('connector:match_result', previous.result);
      return; // an in-flight duplicate never starts a second go
    }
    if (session.request) throw new Error('A match search is already running');
    if (session.usedRequests.size >= 8192) throw new Error('Too many search requests');
    const request = { ...envelope(data), fingerprint, result: null };
    session.request = request;
    session.usedRequests.set(data.requestId, request);
    // Each match is bounded to 4096 plies, including cancelled/retried requests.
    const engine = this.hooks.engine();
    if (!engine?.running) { session.request = null; throw new Error('Engine unavailable'); }
    const run = () => engine.search(data.rootInitialSfen, { type: 'clock', moves: data.moves, clock: data.clock, timeoutMs: data.timeoutMs });
    // The human's turn was analyzed in the meantime; stop it and report it with this reply.
    const ponder = session.ponder;
    session.ponder = null;
    let opponentThink;
    const searched = !ponder ? run() : this._finishPonder(engine, ponder, data).then((result) => {
      opponentThink = result;
      if (this.session !== session || session.request !== request || session.finished) return { status: 'stale' };
      return run();
    });
    void searched
      .then((result) => {
        if (result.status === 'stale' || this.session !== session || session.request !== request || session.finished) return;
        session.request = null;
        if (result.status !== 'done') {
          session.ready = false;
          this.hooks.emit('connector:match_error', { ...envelope(data), error: 'Engine search interrupted' });
          return;
        }
        const think = thinking(result.lastParsed);
        request.result = { ...envelope(data), bestmove: result.bestmove,
          ...(think ? { think } : {}), ...(opponentThink ? { opponentThink } : {}) };
        this.hooks.emit('connector:match_result', request.result);
        this._startPonder(session, engine, data.rootInitialSfen, [...data.moves, result.bestmove]);
      }).catch((error) => {
        if (this.session !== session || session.request !== request || session.finished) return;
        session.request = null;
        session.ready = false;
        this.hooks.emit('connector:match_error', { ...envelope(data), error: error.message });
      });
  }

  /**
   * Analyze the human's position while they think. Linea asks for this when a human turn starts without a
   * reply of ours before it (the first move, a resume); after our own replies it starts by itself.
   */
  ponder(data) {
    const session = this.session;
    if (!this._matches(data) || !session.ready || session.finished || session.request) return;
    matchPosition(data.rootInitialSfen, data.moves);
    const current = session.ponder;
    if (current && current.root === data.rootInitialSfen && current.moves.length === data.moves.length
      && current.moves.every((move, index) => move === data.moves[index])) return;
    session.ponder = null;
    this._startPonder(session, this.hooks.engine(), data.rootInitialSfen, [...data.moves]);
  }

  _startPonder(session, engine, root, moves) {
    if (this.session !== session || session.finished || !session.ready || session.request || !engine?.running) return;
    if (moves.length > 4096 || (moves.length && !USI_MOVE.test(moves[moves.length - 1]))) return;
    let promise;
    try { promise = engine.search(root, { type: 'infinite', moves }); } catch { return; }
    session.ponder = { root, moves, promise };
  }

  /** Stops the human-turn analysis; it is reported only if the request continues from that position. */
  _finishPonder(engine, ponder, data) {
    const sameLine = data.rootInitialSfen === ponder.root && data.moves.length === ponder.moves.length + 1
      && ponder.moves.every((move, index) => move === data.moves[index]);
    engine.stop();
    return ponder.promise.then((result) => {
      const think = sameLine && result.status === 'done' ? thinking(result.lastParsed) : undefined;
      return think ? { ply: ponder.moves.length, ...think } : undefined;
    }, () => undefined);
  }

  cancel(data) {
    if (!this._matches(data)) return Promise.reject(new Error('Stale match cancellation'));
    const session = this.session;
    if (data.requestId && session.request && session.request.requestId !== data.requestId) {
      return Promise.reject(new Error('Stale search cancellation'));
    }
    session.request = null;
    session.ponder = null;
    session.ready = false;
    session.cancelled = true;
    session.preparePromise = null;
    return this._queue(async () => {
      await this.hooks.engine()?.stopAndWait();
      return { ok: true };
    });
  }

  finish(data) {
    const key = `${data?.sessionId}:${data?.epoch}`;
    if (this.finished.has(key)) return Promise.resolve(this.finished.get(key));
    if (!this._matches(data)) return Promise.reject(new Error('Stale match finish'));
    const session = this.session;
    if (session.finishPromise) return session.finishPromise;
    if (![null, undefined, 'win', 'lose', 'draw'].includes(data.result)) return Promise.reject(new Error('Invalid result'));
    session.finished = true;
    session.ready = false;
    session.request = null;
    session.ponder = null;
    session.finishPromise = this._queue(async () => {
      try {
        await this.hooks.engine()?.gameOver(data.result ?? null);
      } finally {
        await this.hooks.restore();
        if (this.session === session) this.session = null;
        this.hooks.status();
      }
      const result = { ok: true };
      this.finished.set(key, result);
      if (this.finished.size > 32) this.finished.delete(this.finished.keys().next().value);
      return result;
    });
    return session.finishPromise;
  }

  disconnected() {
    if (!this.session) return this.transition;
    const session = this.session;
    session.finished = true;
    session.request = null;
    session.ponder = null;
    session.ready = false;
    return this._queue(async () => {
      await this.hooks.restore();
      if (this.session === session) this.session = null;
      this.hooks.status();
    });
  }

  engineFailed(error) {
    if (!this.session) return;
    const session = this.session;
    const data = session.request || { sessionId: session.sessionId, epoch: session.epoch };
    session.ready = false;
    session.request = null;
    session.ponder = null;
    session.preparePromise = null;
    this.hooks.emit('connector:match_error', { ...data, fingerprint: undefined, result: undefined, error });
    this.hooks.status();
  }
}

module.exports = { MatchSession, thinking, PV_LIMIT };

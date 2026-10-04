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
    void engine.search(data.rootInitialSfen, { type: 'clock', moves: data.moves, clock: data.clock, timeoutMs: data.timeoutMs })
      .then((result) => {
        if (this.session !== session || session.request !== request || session.finished) return;
        session.request = null;
        if (result.status !== 'done') {
          session.ready = false;
          this.hooks.emit('connector:match_error', { ...envelope(data), error: 'Engine search interrupted' });
          return;
        }
        request.result = { ...envelope(data), bestmove: result.bestmove };
        this.hooks.emit('connector:match_result', request.result);
      }).catch((error) => {
        if (this.session !== session || session.request !== request || session.finished) return;
        session.request = null;
        session.ready = false;
        this.hooks.emit('connector:match_error', { ...envelope(data), error: error.message });
      });
  }

  cancel(data) {
    if (!this._matches(data)) return Promise.reject(new Error('Stale match cancellation'));
    const session = this.session;
    if (data.requestId && session.request && session.request.requestId !== data.requestId) {
      return Promise.reject(new Error('Stale search cancellation'));
    }
    session.request = null;
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
    session.preparePromise = null;
    this.hooks.emit('connector:match_error', { ...data, fingerprint: undefined, result: undefined, error });
    this.hooks.status();
  }
}

module.exports = { MatchSession };

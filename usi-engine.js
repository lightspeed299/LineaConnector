// Linea Connector — USI Engine Controller
//
// USIプロトコルの正しさをこのモジュール単独で保証する(Electron非依存・単体テスト可能)。
// 設計の出典: docs/research/shogihome.md 第2章(ShogiHome src/background/usi/engine.ts の
// 状態機械+予約キュー方式を、検討/バッチ用途に最小化して移植したもの)。
//
// 保証すること:
//  - stdout は readline で行単位処理(chunk 境界の行分断が起きない)
//  - usiok を待ってから setoption、readyok を待ってから usinewgame/go
//  - option 宣言をパースし「宣言されたものだけ」を型検証+clampして送る
//  - 探索中の go は予約+暗黙 stop(bestmove を待ってから次の position/go)
//  - 探索中の setoption は予約し、bestmove 後に flush → isready で適用
//  - stop の重複送信抑止・破棄済み探索の bestmove を誤帰属しない
//  - タイムアウト: usiok 10s / readyok 60s / stop→bestmove 8s(超過は wedge 扱いで段階破棄)
//  - quit → 1s SIGTERM → 4s SIGKILL の段階終了
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const STATE = Object.freeze({
  LAUNCHING: 'launching',       // spawn 済み・usiok 待ち
  INITIALIZING: 'initializing', // isready 送信済み・readyok 待ち(起動時と適用サイクル共用)
  READY: 'ready',
  SEARCHING: 'searching',       // go 送信済み・bestmove 待ち(infinite / movetime 共用)
  QUITTING: 'quitting',
  CLOSED: 'closed',
});

// 手数未確定の詰み(score mate +/-)を表す値。ShogiHome の SCORE_MATE_INFINITE と同じ。
const SCORE_MATE_UNKNOWN = 10000;

const DEFAULT_TIMEOUTS = Object.freeze({
  usiokMs: 10000,
  readyokMs: 60000,
  stopBestmoveMs: 8000,
  quitTermMs: 1000,
  quitKillMs: 4000,
});

const HISTORY_LIMIT = 100;
const HISTORY_DROP = 10;

function sanitizeUSI(str) {
  return String(str).replace(/[\r\n\x00-\x1f]/g, '');
}

// "score mate +" / "-" / "+0" / "0" / "-0" → ±SCORE_MATE_UNKNOWN(手数未確定)
function parseScoreMate(arg) {
  switch (arg) {
    case '+': case '+0': case '0':
      return SCORE_MATE_UNKNOWN;
    case '-': case '-0':
      return -SCORE_MATE_UNKNOWN;
    default: {
      const n = Number(arg);
      return Number.isFinite(n) ? n : undefined;
    }
  }
}

// info 行の全トークンを構造化する。未知トークンは無視。
function parseUsiInfo(line) {
  const s = line.trim().split(/\s+/);
  if (s[0] !== 'info') return null;
  const r = {};
  for (let i = 1; i < s.length; i++) {
    switch (s[i]) {
      case 'depth': r.depth = Number(s[++i]); break;
      case 'seldepth': r.seldepth = Number(s[++i]); break;
      case 'time': r.timeMs = Number(s[++i]); break;
      case 'nodes': r.nodes = Number(s[++i]); break;
      case 'nps': r.nps = Number(s[++i]); break;
      case 'hashfull': r.hashfullPerMill = Number(s[++i]); break;
      case 'currmove': r.currmove = s[++i]; break;
      case 'multipv': r.multipv = Number(s[++i]); break;
      case 'score':
        if (s[i + 1] === 'cp') { r.scoreCP = Number(s[i + 2]); i += 2; }
        else if (s[i + 1] === 'mate') { r.scoreMate = parseScoreMate(s[i + 2]); i += 2; }
        break;
      case 'lowerbound': r.lowerbound = true; break;
      case 'upperbound': r.upperbound = true; break;
      case 'pv': r.pv = s.slice(i + 1); i = s.length; break;
      case 'string': r.string = s.slice(i + 1).join(' '); i = s.length; break;
      default: break;
    }
  }
  return r;
}

class UsiEngine {
  /**
   * @param {object} opts
   * @param {string} opts.cmd 実行ファイルパス
   * @param {string[]} [opts.args]
   * @param {Object<string,string|number>} [opts.engineOptions] 適用するオプション(宣言と突き合わせて送信)
   * @param {(msg:string)=>void} [opts.log] 人間向けログ
   * @param {object} [opts.timeouts] DEFAULT_TIMEOUTS の部分上書き
   * @param {string} [opts.cwd] 省略時は cmd のディレクトリ
   */
  constructor(opts) {
    this.cmd = opts.cmd;
    this.args = opts.args || [];
    this.cwd = opts.cwd || path.dirname(opts.cmd);
    this.engineOptions = { ...(opts.engineOptions || {}) };
    // 評価関数ファイルのパス。エンジンが宣言するオプション名に合わせて
    // EvalDir(親ディレクトリ) / EvalFile / DNN_Model のいずれかで適用する
    this.evalPath = String(opts.evalPath || '');
    this.log = opts.log || (() => {});
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) };

    this.state = STATE.CLOSED;
    this.proc = null;
    this.rl = null;
    this.id = { name: null, author: null };
    this.declaredOptions = {}; // name → {name,type,default,min,max,vars[]}
    this.launchReport = null;  // {applied,skipped,clamped}

    // 予約キュー(状態機械の核)
    this.reservedGo = null;      // {sfen, spec:{infinite?|movetimeMs?}}
    this.reservedOptions = [];   // [ [name, value], ... ] 探索/初期化中に受けた変更
    this.newGamePending = false;
    this.readyWaiters = [];      // 適用サイクル完了(チェーン全消化)を待つ resolve 群

    // 実行中の movetime 探索(バッチ用)。infinite 解析はここに載せない。
    this.currentSearch = null;   // {sfen, resolve, guardTimer, lastParsed}
    this.currentGoSfen = null;   // 直近の go 対象局面(info のタグ付け用)
    this._stopSent = false;      // 現在の go に対して stop 送信済みか(重複抑止)

    this._timers = {};           // usiok / readyok / stopGuard / quitTerm / quitKill
    this.history = [];           // {d:'>'|'<'|'*', line, t}
    this.stderrTail = [];        // 直近の stderr(診断用)

    // コールバック(利用側が差し込む)
    this.onInfo = null;            // ({sfen, raw, parsed}) => void
    this.onUnexpectedClose = null; // ({code, signal, reason}) => void

    this._launchResolve = null;
    this._launchReject = null;
    this._launched = false;
    this._closeWaiters = [];
  }

  get pid() { return this.proc ? this.proc.pid : null; }
  get running() { return this.state !== STATE.CLOSED && this.state !== STATE.QUITTING && !!this.proc; }

  _hist(d, line) {
    this.history.push({ d, line, t: Date.now() });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, HISTORY_DROP);
  }

  getHistoryText() {
    return this.history
      .map((h) => `${new Date(h.t).toLocaleTimeString('ja-JP', { hour12: false })} ${h.d} ${h.line}`)
      .join('\n');
  }

  _setTimer(name, ms, fn) {
    this._clearTimer(name);
    this._timers[name] = setTimeout(fn, ms);
  }

  _clearTimer(name) {
    if (this._timers[name]) { clearTimeout(this._timers[name]); this._timers[name] = null; }
  }

  _clearAllTimers() {
    for (const k of Object.keys(this._timers)) this._clearTimer(k);
  }

  _write(line) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false;
    try {
      this.proc.stdin.write(line + '\n');
      this._hist('>', line);
      return true;
    } catch (e) {
      this.log(`stdin書き込みエラー: ${e.message}`);
      return false;
    }
  }

  // ---- 起動 ----

  launch() {
    if (this.proc) return Promise.reject(new Error('already launched'));
    return new Promise((resolve, reject) => {
      this._launchResolve = resolve;
      this._launchReject = reject;

      const isWin = process.platform === 'win32';
      const lower = this.cmd.toLowerCase();
      const spawnOpts = { cwd: this.cwd, windowsHide: true };
      let proc;
      try {
        if (isWin && (lower.endsWith('.bat') || lower.endsWith('.cmd'))) {
          // Node は Windows で .bat/.cmd を直接 spawn できない(shell なしは EINVAL)
          proc = spawn('cmd.exe', ['/c', this.cmd, ...this.args], spawnOpts);
        } else {
          proc = spawn(this.cmd, this.args, spawnOpts);
        }
      } catch (e) {
        this._launchReject = null; this._launchResolve = null;
        reject(e);
        return;
      }
      this.proc = proc;
      this.state = STATE.LAUNCHING;
      this._hist('*', `launch: ${this.cmd} (pid=${proc.pid ?? '?'})`);

      proc.on('error', (err) => {
        // ENOENT / EACCES 等。リスナが無いと Node プロセス例外になる
        if (this.proc !== proc) return;
        this._hist('*', `spawn error: ${err.message}`);
        this._failLaunch(err);
        this._finalizeClose(null, null, `spawn error: ${err.message}`);
      });

      proc.on('close', (code, signal) => {
        if (this.proc !== proc) return;
        this._finalizeClose(code, signal, null);
      });

      // stderr は読み捨てつつ末尾だけ保持(パイプ詰まりによるエンジン側 write ブロックの防止)
      if (proc.stderr) {
        proc.stderr.on('data', (d) => {
          const text = d.toString();
          for (const l of text.split('\n')) {
            const t = l.trim();
            if (!t) continue;
            this.stderrTail.push(t);
            if (this.stderrTail.length > 20) this.stderrTail.shift();
            if (/error|failed|cannot open|not found/i.test(t)) this.log(`エンジンstderr: ${t}`);
          }
        });
      }

      this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      this.rl.on('line', (line) => {
        if (this.proc !== proc) return;
        this._onLine(line);
      });

      this._write('usi');
      this._setTimer('usiok', this.timeouts.usiokMs, () => {
        this.log(`usiok タイムアウト(${this.timeouts.usiokMs}ms)`);
        this._failLaunch(new Error('usiok timeout'));
        this.quit();
      });
    });
  }

  _failLaunch(err) {
    if (this._launchReject) {
      const rej = this._launchReject;
      this._launchReject = null; this._launchResolve = null;
      rej(err);
    }
  }

  // ---- 受信処理 ----

  _onLine(raw) {
    const line = raw.trim();
    if (!line) return;
    this._hist('<', line);
    if (this.state === STATE.QUITTING || this.state === STATE.CLOSED) return;

    if (line === 'usiok') { this._onUsiOk(); return; }
    if (line === 'readyok') { this._onReadyOk(); return; }
    if (line.startsWith('bestmove')) { this._onBestMove(line); return; }
    if (line.startsWith('info')) { this._onInfoLine(line); return; }
    if (line.startsWith('id name ')) { this.id.name = line.slice(8).trim(); return; }
    if (line.startsWith('id author ')) { this.id.author = line.slice(10).trim(); return; }
    if (line.startsWith('option ')) { this._onOptionDecl(line.slice(7)); return; }
    // checkmate 等の未対応応答・未知行は履歴に残して無視
  }

  // "name <NAME> type <TYPE> [default X] [min N] [max N] [var A]..."
  _onOptionDecl(args) {
    const s = args.split(/\s+/);
    if (s.length < 4 || s[0] !== 'name' || s[2] !== 'type') {
      this.log(`不正な option 宣言を無視: option ${args}`);
      return;
    }
    const name = s[1];
    const type = s[3];
    const opt = { name, type };
    if (type === 'combo') opt.vars = [];
    if (type !== 'button') {
      for (let i = 4; i + 1 < s.length; i += 2) {
        switch (s[i]) {
          case 'default': opt.default = type === 'spin' ? Number(s[i + 1]) : s[i + 1]; break;
          case 'min': if (type === 'spin') opt.min = Number(s[i + 1]); break;
          case 'max': if (type === 'spin') opt.max = Number(s[i + 1]); break;
          case 'var': if (type === 'combo') opt.vars.push(s[i + 1]); break;
          default: break;
        }
      }
    }
    this.declaredOptions[name] = opt;
  }

  _onUsiOk() {
    if (this.state !== STATE.LAUNCHING) return;
    this._clearTimer('usiok');

    // エンジンが宣言しなくても USI_Hash / USI_Ponder は存在するものとして扱う(USI 準拠)
    if (!this.declaredOptions.USI_Hash) {
      this.declaredOptions.USI_Hash = { name: 'USI_Hash', type: 'spin', default: 32, synthesized: true };
    }
    if (!this.declaredOptions.USI_Ponder) {
      this.declaredOptions.USI_Ponder = { name: 'USI_Ponder', type: 'check', default: 'true', synthesized: true };
    }

    const report = this._sendOptions(Object.entries(this.engineOptions));
    report.eval = this._applyEvalPath();
    this.launchReport = report;

    this._write('isready');
    this.state = STATE.INITIALIZING;
    this._setTimer('readyok', this.timeouts.readyokMs, () => {
      this.log(`readyok タイムアウト(${this.timeouts.readyokMs}ms)`);
      this._failLaunch(new Error('readyok timeout'));
      this.quit();
    });
  }

  // 設定オプションを宣言と突き合わせて送信する。
  // 返り値 {applied:[{name,value}], skipped:[{name,reason}], clamped:[{name,from,to}]}
  _sendOptions(entries) {
    const report = { applied: [], skipped: [], clamped: [] };
    for (const [key, rawValue] of entries) {
      const decl = this._resolveDeclared(key);
      if (!decl) {
        report.skipped.push({ name: key, reason: 'undeclared' });
        continue;
      }
      if (decl.type === 'button') {
        report.skipped.push({ name: key, reason: 'button' });
        continue;
      }
      let value = sanitizeUSI(rawValue);
      if (decl.type === 'spin') {
        let n = Number(value);
        if (!Number.isFinite(n)) {
          report.skipped.push({ name: key, reason: 'not_a_number' });
          continue;
        }
        const orig = n;
        if (typeof decl.min === 'number' && n < decl.min) n = decl.min;
        if (typeof decl.max === 'number' && n > decl.max) n = decl.max;
        if (n !== orig) report.clamped.push({ name: decl.name, from: orig, to: n });
        value = String(n);
      } else if (decl.type === 'check') {
        value = String(value) === 'true' ? 'true' : 'false';
      }
      this._write(`setoption name ${decl.name} value ${value}`);
      report.applied.push({ name: decl.name, value });
    }
    return report;
  }

  // 評価関数パスをエンジン宣言に合わせて適用する。
  // 返り値: null(未設定) | {applied:{name,value}} | {skippedReason:'unsupported'}
  _applyEvalPath() {
    if (!this.evalPath) return null;
    const p = this.evalPath.replace(/\\/g, '/');
    const looksLikeFile = /\.[A-Za-z0-9]+$/.test(p.split('/').pop() || '');
    const dir = looksLikeFile ? p.slice(0, Math.max(p.lastIndexOf('/'), 0)) || '.' : p;
    let name = null;
    let value = null;
    if (this._resolveDeclaredExact('EvalDir')) {
      name = 'EvalDir';
      value = dir;
    } else if (this._resolveDeclaredExact('EvalFile')) {
      name = 'EvalFile';
      value = p;
    } else if (this._resolveDeclaredExact('DNN_Model')) {
      name = 'DNN_Model';
      value = p;
    } else {
      return { skippedReason: 'unsupported' };
    }
    this._write(`setoption name ${name} value ${sanitizeUSI(value)}`);
    return { applied: { name, value } };
  }

  _resolveDeclaredExact(name) {
    if (this.declaredOptions[name]) return this.declaredOptions[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(this.declaredOptions)) {
      if (key.toLowerCase() === lower) return this.declaredOptions[key];
    }
    return null;
  }

  // 設定キー → 宣言済みオプションの解決。
  // 完全一致 → 大文字小文字無視 → Hash/USI_Hash 別名 の順。
  _resolveDeclared(key) {
    if (this.declaredOptions[key]) return this.declaredOptions[key];
    const lower = String(key).toLowerCase();
    for (const name of Object.keys(this.declaredOptions)) {
      if (name.toLowerCase() === lower) return this.declaredOptions[name];
    }
    const aliases = { hash: 'USI_Hash', usi_hash: 'Hash' };
    const alias = aliases[lower];
    if (alias) {
      if (this.declaredOptions[alias]) return this.declaredOptions[alias];
      for (const name of Object.keys(this.declaredOptions)) {
        if (name.toLowerCase() === alias.toLowerCase()) return this.declaredOptions[name];
      }
    }
    return null;
  }

  _onReadyOk() {
    if (this.state !== STATE.INITIALIZING) return;
    this._clearTimer('readyok');
    if (!this._launched) {
      this._launched = true;
      this._write('usinewgame');
      const res = this._launchResolve;
      this._launchResolve = null; this._launchReject = null;
      if (res) res({ id: { ...this.id }, report: this.launchReport, declaredOptions: this.declaredOptions });
    }
    this.state = STATE.READY;
    this._afterIdle();
  }

  _onBestMove(line) {
    this._clearTimer('stopGuard');
    const wasSearching = this.state === STATE.SEARCHING;
    if (!wasSearching) {
      this._hist('*', 'unexpected bestmove (ignored)');
      return;
    }
    const tokens = line.split(/\s+/);
    const move = tokens[1] || '';

    const cs = this.currentSearch;
    this.currentSearch = null;
    this.currentGoSfen = null;
    this.state = STATE.READY;

    if (cs) {
      this._clearTimer('searchGuard');
      cs.resolve({ status: 'done', bestmove: move, lastParsed: cs.lastParsed });
    }
    this._afterIdle();
  }

  _onInfoLine(line) {
    const parsed = parseUsiInfo(line);
    if (!parsed) return;
    if (this.currentSearch && (parsed.scoreCP !== undefined || parsed.scoreMate !== undefined)) {
      const mpv = parsed.multipv === undefined ? 1 : parsed.multipv;
      if (mpv === 1 && !parsed.lowerbound && !parsed.upperbound) {
        this.currentSearch.lastParsed = parsed;
      } else if (mpv === 1 && !this.currentSearch.lastParsed) {
        // bound 値しか無いよりは有ったほうがまし(最終手段としてのみ保持)
        this.currentSearch.lastParsed = parsed;
      }
    }
    if (this.onInfo) {
      this.onInfo({ sfen: this.currentGoSfen, raw: line, parsed });
    }
  }

  // ---- アイドル時の予約消化チェーン ----
  // bestmove / readyok のたびに呼ばれ、
  // ①予約オプション → ②usinewgame → (①②があれば isready) → ③予約 go の順に消化する。

  _afterIdle() {
    if (this.state !== STATE.READY) return;

    let needApply = false;
    if (this.reservedOptions.length > 0) {
      const entries = this.reservedOptions;
      this.reservedOptions = [];
      const report = this._sendOptions(entries);
      this._reportOptionResult(report);
      needApply = report.applied.length > 0;
    }
    if (this.newGamePending) {
      this.newGamePending = false;
      this._write('usinewgame');
      needApply = true;
    }
    if (needApply) {
      this._write('isready');
      this.state = STATE.INITIALIZING;
      this._setTimer('readyok', this.timeouts.readyokMs, () => {
        this.log(`readyok タイムアウト(適用サイクル)`);
        this._wedge('readyok timeout during apply');
      });
      return; // readyok で再び _afterIdle が走る
    }

    // チェーン全消化 → 適用待ちを解決
    if (this.readyWaiters.length > 0) {
      const ws = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of ws) w();
    }

    if (this.reservedGo) {
      const go = this.reservedGo;
      this.reservedGo = null;
      this._flushGo(go);
    }
  }

  _reportOptionResult(report) {
    for (const s of report.skipped) this.log(`オプション ${s.name} をスキップ(${s.reason === 'undeclared' ? 'エンジン未対応' : s.reason})`);
    for (const c of report.clamped) this.log(`オプション ${c.name} を ${c.from} → ${c.to} に制限(エンジン宣言の範囲)`);
  }

  _flushGo(go) {
    const sfen = sanitizeUSI(go.sfen);
    this._write(`position sfen ${sfen}`);
    if (go.spec.movetimeMs) {
      this._write(`go movetime ${Math.floor(go.spec.movetimeMs)}`);
    } else {
      this._write('go infinite');
    }
    this.state = STATE.SEARCHING;
    this.currentGoSfen = go.sfen;
    this._stopSent = false;

    if (go.spec.movetimeMs && go.spec.ticket) {
      const cs = go.spec.ticket;
      cs.sfen = go.sfen;
      this.currentSearch = cs;
      // movetime を大幅超過しても bestmove が来ない場合は stop → (stopGuard) → wedge
      this._setTimer('searchGuard', go.spec.movetimeMs + 15000, () => {
        if (this.currentSearch === cs) {
          this.log('movetime 超過: stop を送信します');
          this._sendStop();
        }
      });
    }
  }

  _sendStop() {
    if (this.state !== STATE.SEARCHING) return;
    if (this._stopSent) return; // 現在の go に対する stop は 1 回だけ
    this._stopSent = true;
    this._write('stop');
    this._setTimer('stopGuard', this.timeouts.stopBestmoveMs, () => {
      this._wedge('bestmove timeout after stop');
    });
  }

  // エンジンがプロトコル的に応答不能(wedged)。段階破棄して利用側に通知する。
  _wedge(reason) {
    this.log(`エンジン応答なし(${reason})。プロセスを破棄します`);
    this._hist('*', `wedged: ${reason}`);
    this._wedgeReason = reason;
    this.quit();
  }

  // ---- 公開 API ----

  // 予約中でまだ flush していない go を破棄する。
  // movetime のチケットを持っていたら preempted で必ず解決する(宙吊り防止)。
  _dropReservedGo() {
    const go = this.reservedGo;
    this.reservedGo = null;
    if (go && go.spec && go.spec.ticket) {
      go.spec.ticket.resolve({ status: 'preempted' });
    }
  }

  /** 対話解析(go infinite)。探索中なら予約+暗黙 stop。 */
  analyze(sfen) {
    this._dropReservedGo();
    this.reservedGo = { sfen, spec: { infinite: true } };
    this._dispatch();
  }

  /**
   * バッチ 1 局面(go movetime)。resolve は必ず 1 回:
   *   {status:'done', bestmove, lastParsed} | {status:'preempted'}
   * preempted は「結果を捨てて再キューせよ」の意味。
   */
  search(sfen, movetimeMs) {
    return new Promise((resolve) => {
      if (!this.running) { resolve({ status: 'preempted' }); return; }
      const ticket = { resolve, lastParsed: null, settled: false };
      const safeResolve = (v) => { if (!ticket.settled) { ticket.settled = true; resolve(v); } };
      ticket.resolve = safeResolve;
      if (this.currentSearch) {
        // 直列運用前提だが、万一の二重呼び出しでは古い方を破棄扱いに
        this.currentSearch.resolve({ status: 'preempted' });
        this.currentSearch = null;
      }
      this._dropReservedGo();
      this.reservedGo = { sfen, spec: { movetimeMs, ticket } };
      this._dispatch();
    });
  }

  _dispatch() {
    switch (this.state) {
      case STATE.READY:
        this._afterIdle();
        break;
      case STATE.SEARCHING:
        // 実行中の movetime 探索は破棄(部分探索の低品質 bestmove を結果にしない)
        if (this.currentSearch) {
          this.currentSearch.resolve({ status: 'preempted' });
          this.currentSearch = null;
          this._clearTimer('searchGuard');
        }
        this._sendStop();
        break;
      case STATE.LAUNCHING:
      case STATE.INITIALIZING:
        break; // readyok 到達時に _afterIdle が消化する
      default:
        break; // QUITTING / CLOSED では黙って捨てる(呼び出し側が running を見る)
    }
  }

  /**
   * 探索停止。discardSearch: 実行中の movetime 探索を preempted で破棄(再キュー用)。
   * 予約済みでまだ送っていない go も取り消す。
   */
  stop({ discardSearch = false } = {}) {
    this._dropReservedGo();
    if (this.state !== STATE.SEARCHING) return;
    if (discardSearch && this.currentSearch) {
      this.currentSearch.resolve({ status: 'preempted' });
      this.currentSearch = null;
      this._clearTimer('searchGuard');
    }
    this._sendStop();
  }

  /**
   * オプション変更。将来の起動用に engineOptions にも取り込む。
   * 探索中は予約し bestmove 後に flush → isready。適用完了(チェーン消化)で resolve。
   */
  setOptions(map) {
    for (const [k, v] of Object.entries(map)) this.engineOptions[k] = v;
    if (!this.running) return Promise.resolve({ applied: false, reason: 'not_running' });
    return new Promise((resolve) => {
      this.readyWaiters.push(() => resolve({ applied: true }));
      this.reservedOptions.push(...Object.entries(map));
      if (this.state === STATE.SEARCHING) {
        if (this.currentSearch) {
          this.currentSearch.resolve({ status: 'preempted' });
          this.currentSearch = null;
          this._clearTimer('searchGuard');
        }
        this._sendStop();
      } else if (this.state === STATE.READY) {
        this._afterIdle();
      }
      // LAUNCHING / INITIALIZING → readyok 後のチェーンで消化
    });
  }

  /** ハッシュクリア(usinewgame + isready)。適用完了で resolve。 */
  newGame() {
    if (!this.running) return Promise.resolve({ applied: false, reason: 'not_running' });
    return new Promise((resolve) => {
      this.readyWaiters.push(() => resolve({ applied: true }));
      this.newGamePending = true;
      if (this.state === STATE.SEARCHING) {
        if (this.currentSearch) {
          this.currentSearch.resolve({ status: 'preempted' });
          this.currentSearch = null;
          this._clearTimer('searchGuard');
        }
        this._sendStop();
      } else if (this.state === STATE.READY) {
        this._afterIdle();
      }
    });
  }

  /** 段階終了: quit → SIGTERM → SIGKILL。close で resolve。冪等。 */
  quit() {
    if (this.state === STATE.CLOSED) return Promise.resolve();
    if (this.state === STATE.QUITTING) {
      return new Promise((r) => this._closeWaiters.push(r));
    }
    const proc = this.proc;
    this.state = STATE.QUITTING;
    this._clearTimer('usiok');
    this._clearTimer('readyok');
    this._clearTimer('stopGuard');
    this._clearTimer('searchGuard');
    if (this.currentSearch) {
      this.currentSearch.resolve({ status: 'preempted' });
      this.currentSearch = null;
    }
    return new Promise((resolve) => {
      this._closeWaiters.push(resolve);
      if (!proc) { this._finalizeClose(null, null, 'no process'); return; }
      this._write('quit');
      this._setTimer('quitTerm', this.timeouts.quitTermMs, () => {
        try { proc.kill(); } catch (_) { /* already dead */ }
      });
      this._setTimer('quitKill', this.timeouts.quitKillMs, () => {
        try { proc.kill('SIGKILL'); } catch (_) { /* already dead */ }
      });
    });
  }

  _finalizeClose(code, signal, reason) {
    const prevState = this.state;
    this._clearAllTimers();
    if (this.rl) { try { this.rl.close(); } catch (_) { /* noop */ } this.rl = null; }
    this.proc = null;
    this.state = STATE.CLOSED;
    this._hist('*', `closed: code=${code} signal=${signal}${reason ? ` (${reason})` : ''}`);

    if (this.currentSearch) {
      this.currentSearch.resolve({ status: 'preempted' });
      this.currentSearch = null;
    }
    this._dropReservedGo();
    this.reservedOptions = [];
    this.newGamePending = false;
    if (this.readyWaiters.length > 0) {
      const ws = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of ws) w();
    }
    this._failLaunch(new Error(reason || `engine closed (code=${code})`));

    const waiters = this._closeWaiters;
    this._closeWaiters = [];
    for (const w of waiters) w();

    if (prevState !== STATE.QUITTING && prevState !== STATE.CLOSED) {
      if (this.onUnexpectedClose) this.onUnexpectedClose({ code, signal, reason: reason || null });
    } else if (this._wedgeReason && this.onUnexpectedClose) {
      // wedge 起因の quit は「異常」として通知する(再起動判断のため)
      this.onUnexpectedClose({ code, signal, reason: this._wedgeReason });
    }
    this._wedgeReason = null;
  }
}

module.exports = { UsiEngine, parseUsiInfo, parseScoreMate, SCORE_MATE_UNKNOWN, STATE, DEFAULT_TIMEOUTS };

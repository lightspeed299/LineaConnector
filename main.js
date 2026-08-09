// Linea Connector — Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const io = require('socket.io-client');
const { autoUpdater } = require('electron-updater');
const { UsiEngine } = require('./usi-engine');
const { YaneBook } = require('./book');

const CURRENT_VERSION = `v${require('./package.json').version}`;
const DEFAULT_SERVER_URL = 'https://api.lineashogi.com';
function decodeLegacyValue(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}
const LEGACY_PRODUCT_KEY = decodeLegacyValue('c2hvZ2lzdGFjaw==');
const LEGACY_PRODUCT_TITLE = decodeLegacyValue('U2hvZ2lTdGFjaw==');
const LEGACY_SERVER_URLS = new Set([
  `https://${LEGACY_PRODUCT_KEY}-server.onrender.com`,
  `http://${LEGACY_PRODUCT_KEY}-server.onrender.com`,
]);
const ENGINE_MODE_ALWAYS = 'always';
const ENGINE_MODE_ON_DEMAND = 'onDemand';
const ENGINE_IDLE_SHUTDOWN_DELAY_MS = 3000;
const UPDATE_CHECK_INITIAL_DELAY_MS = 5 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_IDLE_INSTALL_DELAY_MS = 30 * 60 * 1000;
const UPDATE_IDLE_INSTALL_POLL_MS = 60 * 1000;

let updateInitialCheckTimer = null;
let updatePeriodicCheckTimer = null;
let updateCheckInFlight = null;
let updateIdleInstallTimer = null;
let updateReadyToInstall = false;
let updateReadyVersion = null;
let lastActivityAt = Date.now();

function sanitizeDeviceMeta(value, fallback, maxLength) {
  const cleaned = String(value || '')
    .replace(/[\r\n\x00-\x1f\x7f<>]/g, '')
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function getConnectorIdentity() {
  return {
    deviceName: sanitizeDeviceMeta(os.hostname(), 'Windows PC', 64),
    platform: sanitizeDeviceMeta(`${os.type()} ${os.arch()}`, 'Windows', 32),
    version: CURRENT_VERSION,
  };
}

function getEngineMode(config) {
  return config?.engineMode === ENGINE_MODE_ON_DEMAND ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS;
}

function normalizeServerUrl(value) {
  const serverUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!serverUrl || LEGACY_SERVER_URLS.has(serverUrl)) {
    return DEFAULT_SERVER_URL;
  }
  return serverUrl;
}

// 旧キー fv_scale(小文字)を FV_SCALE へ移行する。
// USIオプション名は宣言と突き合わせて解決されるため実害は少ないが、表記を正に統一する。
function normalizeEngineOptions(options) {
  const src = { ...(options || {}) };
  if (src.fv_scale !== undefined && src.FV_SCALE === undefined) {
    src.FV_SCALE = src.fv_scale;
  }
  delete src.fv_scale;
  return src;
}

function normalizeConfig(config) {
  return {
    ...config,
    serverUrl: normalizeServerUrl(config?.serverUrl),
    engineMode: getEngineMode(config),
    engineOptions: normalizeEngineOptions(config?.engineOptions),
    bookPath: String(config?.bookPath || ''),
    useBook: config?.useBook === true || config?.useBook === 'true',
  };
}

function configsDiffer(a, b) {
  return JSON.stringify(a || null) !== JSON.stringify(b || null);
}

function isOnDemandEngineMode(config = currentConfig) {
  return getEngineMode(config) === ENGINE_MODE_ON_DEMAND;
}

function buildStatus(connected = !!socket?.connected, engineRunning = !!(engine && engine.running)) {
  return {
    connected,
    engineRunning,
    engineMode: getEngineMode(currentConfig),
  };
}

// --- 設定ファイル ---
// Electron標準の userData (%APPDATA%\linea-connector) を使用
// LINEA_CONNECTOR_CONFIG_DIR はE2Eテスト・サポート診断用の上書き
function getConfigPath() {
  const dir = process.env.LINEA_CONNECTOR_CONFIG_DIR || app.getPath('userData');
  return path.join(dir, 'config.json');
}

// app.whenReady() 後に初期化するため遅延
let CONFIG_PATH;

// 旧フォルダ → 新フォルダ (linea-connector) へ移行
function migrateOldConfig() {
  const legacyDirs = [`${LEGACY_PRODUCT_KEY}-connector`, `${LEGACY_PRODUCT_TITLE}Connector`];
  for (const dirName of legacyDirs) {
    const oldDir = path.join(process.env.APPDATA || '', dirName);
    const oldFile = path.join(oldDir, 'config.json');
    if (fs.existsSync(oldFile) && !fs.existsSync(CONFIG_PATH)) {
      try {
        fs.copyFileSync(oldFile, CONFIG_PATH);
        fs.rmSync(oldDir, { recursive: true, force: true });
        log('旧設定を移行しました');
      } catch (e) { /* 移行失敗は無視 */ }
    } else if (fs.existsSync(oldDir) && fs.existsSync(CONFIG_PATH)) {
      // 両方あれば旧フォルダだけ削除
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch (e) { /* */ }
    }
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      const normalized = normalizeConfig(parsed);
      if (configsDiffer(parsed, normalized)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2));
        log('設定ファイルを最新形式へ移行しました');
      }
      return normalized;
    }
  } catch (e) {
    log(`設定読み込みエラー: ${e.message}`);
  }
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(config), null, 2));
}

// --- ログ送信 ---
let mainWindow = null;

function log(msg) {
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const entry = `${timestamp}  ${msg}`;
  console.log(entry);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', entry);
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', status);
  }
}

// --- Socket.io + Engine ---
let socket = null;
let engine = null;               // UsiEngine | null
let engineStartPromise = null;
let isAnalyzing = false;         // ブラウザ意図としての対話解析中フラグ
let lastSfen = null;
let lastTurn = null;
let currentConfig = null;
let engineIdleShutdownTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★バックグラウンド全解析バッチ（サーバー主導・Connector は無状態）
let batchQueue = []; // { jobId, sfen }[]
let batchSecondsPerMove = 3;
let batchActive = false;
// ジョブ全体の進捗（サーバーが analyze_batch に載せてくる doneCount/totalCount が正）。
// jobId が変わったらリセットする。
let batchJobId = null;
let batchJobDone = 0;
let batchJobTotal = 0;
// analyze_stop で止められたジョブ。preempted 再キュー時の復活を防ぐ。
const stoppedBatchJobs = new Set();

function markActivity() {
  lastActivityAt = Date.now();
}

// --- 定跡 (やねうら王 .db) ---
let book = null;            // YaneBook | null
let bookLoadedPath = null;  // 現在開いているファイル(エラー時は 'error:'+path)
let bookLoadPromise = null;

async function ensureBook(config = currentConfig) {
  const bookPath = String(config?.bookPath || '');
  if (!bookPath) {
    if (book) await closeBook();
    bookLoadedPath = null;
    return null;
  }
  if (book && bookLoadedPath === bookPath) return book;
  if (bookLoadPromise) return bookLoadPromise;
  bookLoadPromise = (async () => {
    if (book) await closeBook();
    if (!fs.existsSync(bookPath)) {
      log(`定跡ファイルが見つかりません: ${bookPath}`);
      bookLoadedPath = `error:${bookPath}`;
      return null;
    }
    try {
      const opened = await YaneBook.open(bookPath);
      book = opened;
      bookLoadedPath = bookPath;
      log(`定跡を読み込みました: ${path.basename(bookPath)} (${opened.mode === 'in-memory' ? `${opened.entryCount}局面` : '大容量モード'})`);
      return opened;
    } catch (e) {
      log(`定跡の読み込みに失敗: ${e.message}`);
      bookLoadedPath = `error:${bookPath}`;
      return null;
    }
  })();
  try {
    return await bookLoadPromise;
  } finally {
    bookLoadPromise = null;
  }
}

function closeBook() {
  const b = book;
  book = null;
  bookLoadedPath = null;
  return b ? b.close() : Promise.resolve();
}

function bookStatusForSync() {
  const bookPath = String(currentConfig?.bookPath || '');
  if (!bookPath) return { bookFile: null, bookStatus: null };
  if (book && bookLoadedPath === bookPath) {
    return {
      bookFile: path.basename(bookPath),
      bookStatus: 'ok',
      bookMode: book.mode,
      bookEntries: book.mode === 'in-memory' ? book.entryCount : undefined,
    };
  }
  if (bookLoadedPath === `error:${bookPath}`) {
    return { bookFile: path.basename(bookPath), bookStatus: 'error' };
  }
  return { bookFile: path.basename(bookPath), bookStatus: 'loading' };
}

// ★エンジン自動再起動（クラッシュ時）: 1分間に最大3回まで
const ENGINE_RESTART_LIMIT = 3;
const ENGINE_RESTART_WINDOW_MS = 60 * 1000;
let engineRestartTimestamps = [];

// ★info行スロットリング: MultiPVごとに最新のみ150ms間隔で送信（NPS改善）
const INFO_THROTTLE_MS = 150;
const pendingInfoByMultipv = new Map(); // multipv -> payload
let infoFlushTimer = null;

// 定跡候補手を MultiPV 形式の解析行として送出する(ShogiHome usi.ts:204-220 と同じマッピング:
// multipv=順位・scoreCP←評価値・nodes←採用数・pv←[手,応手])。既存の候補手UIがそのまま使われる。
function emitBookMoves(sfen, turn, bookMoves) {
  if (!socket?.connected) return;
  const limit = Math.min(bookMoves.length, 10);
  log(`定跡ヒット: ${bookMoves.length}手 (${path.basename(currentConfig?.bookPath || '')})`);
  for (let i = 0; i < limit; i++) {
    const m = bookMoves[i];
    const pv = m.usi2 ? [m.usi, m.usi2] : [m.usi];
    const v2 = {
      multipv: i + 1,
      pv,
      currmove: m.usi,
      book: true,
    };
    if (typeof m.score === 'number') v2.scoreCP = Math.round(m.score);
    if (typeof m.depth === 'number') v2.depth = m.depth;
    if (typeof m.count === 'number') { v2.nodes = m.count; v2.bookCount = m.count; }
    // 旧クライアント互換の生info行(scoreが無い手は旧クライアントでは表示されない)
    const infoParts = ['info'];
    if (v2.depth !== undefined) infoParts.push(`depth ${v2.depth}`);
    if (v2.scoreCP !== undefined) infoParts.push(`score cp ${v2.scoreCP}`);
    infoParts.push(`multipv ${i + 1}`);
    if (v2.nodes !== undefined) infoParts.push(`nodes ${v2.nodes}`);
    infoParts.push(`pv ${pv.join(' ')}`);
    socket.emit('connector_analysis_update', { info: infoParts.join(' '), sfen, turn, v2 });
  }
}

function queueAnalysisUpdate(multipv, payload) {
  pendingInfoByMultipv.set(multipv, payload);
  if (infoFlushTimer) return;
  infoFlushTimer = setTimeout(() => {
    infoFlushTimer = null;
    if (!socket?.connected) { pendingInfoByMultipv.clear(); return; }
    for (const p of pendingInfoByMultipv.values()) {
      socket.emit('connector_analysis_update', p);
    }
    pendingInfoByMultipv.clear();
  }, INFO_THROTTLE_MS);
}

function emitEngineSettings() {
  if (currentConfig?.engineOptions && socket?.connected) {
    socket.emit('connector_engine_settings', {
      Threads: currentConfig.engineOptions.Threads,
      MultiPV: currentConfig.engineOptions.MultiPV,
      // 定跡設定(v6.1.0〜)。サーバーは素通し・旧クライアントは未知フィールドを無視する
      UseBook: !!currentConfig.useBook,
      ...bookStatusForSync(),
    });
  }
}

function clearEngineIdleShutdown() {
  if (engineIdleShutdownTimer) {
    clearTimeout(engineIdleShutdownTimer);
    engineIdleShutdownTimer = null;
  }
}

function scheduleEngineIdleShutdown() {
  if (!isOnDemandEngineMode(currentConfig) || !engine) return;
  clearEngineIdleShutdown();
  engineIdleShutdownTimer = setTimeout(async () => {
    engineIdleShutdownTimer = null;
    if (!isOnDemandEngineMode(currentConfig) || isAnalyzing || batchActive || !engine) return;
    log('省メモリモード: エンジンを停止してメモリを解放します');
    await stopEngineProcess();
    sendStatus(buildStatus(!!socket?.connected, false));
  }, ENGINE_IDLE_SHUTDOWN_DELAY_MS);
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/');
}

function stableEngineOptions(options) {
  return JSON.stringify(
    Object.entries(options || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, String(value)])
  );
}

function hasConnectionConfigChanged(prevConfig, nextConfig) {
  if (!prevConfig) return false;
  return (
    String(prevConfig.serverUrl || DEFAULT_SERVER_URL) !== String(nextConfig.serverUrl || DEFAULT_SERVER_URL) ||
    String(prevConfig.apiKey || '') !== String(nextConfig.apiKey || '')
  );
}

function hasEngineConfigChanged(prevConfig, nextConfig) {
  if (!prevConfig) return true;
  return (
    normalizePathForCompare(prevConfig.enginePath) !== normalizePathForCompare(nextConfig.enginePath) ||
    stableEngineOptions(prevConfig.engineOptions) !== stableEngineOptions(nextConfig.engineOptions)
  );
}

async function restartEngineWithConfig(config, reason) {
  const wasAnalyzing = isAnalyzing;
  const resumeSfen = lastSfen;
  const resumeTurn = lastTurn;
  if (reason) log(reason);
  isAnalyzing = false;
  const started = await startEngine(config);
  if (started && engine && wasAnalyzing && resumeSfen) {
    lastSfen = resumeSfen;
    lastTurn = resumeTurn;
    isAnalyzing = true;
    log('解析を再開します');
    engine.analyze(resumeSfen);
  }
  return started;
}

async function applyConfigUpdate(nextConfig, prevConfig) {
  currentConfig = nextConfig;

  // 定跡ファイルの変更はエンジンと独立に反映する(解除なら閉じる・変更なら開き直す)
  if (String(prevConfig?.bookPath || '') !== String(nextConfig.bookPath || '')) {
    void ensureBook(nextConfig).then(() => emitEngineSettings());
  }

  if (!socket) {
    return { applied: false, reason: 'not_connected' };
  }

  if (hasConnectionConfigChanged(prevConfig, nextConfig)) {
    log('接続設定の変更を反映します');
    disconnectFromServer();
    connectToServer(nextConfig);
    return { applied: true, restartedSocket: true };
  }

  const engineConfigChanged = hasEngineConfigChanged(prevConfig, nextConfig);
  const engineModeChanged = getEngineMode(prevConfig) !== getEngineMode(nextConfig);

  if (engineConfigChanged) {
    if (isOnDemandEngineMode(nextConfig) && !isAnalyzing) {
      if (engine) {
        log('設定を保存しました。省メモリモードのため、次回解析時に新しいエンジン設定で起動します');
        await stopEngineProcess();
        sendStatus(buildStatus(!!socket?.connected, false));
      } else {
        log('設定を保存しました。次回解析時に新しいエンジン設定で起動します');
      }
      emitEngineSettings();
      return { applied: true, deferredEngineStart: true };
    }

    await restartEngineWithConfig(nextConfig, '設定変更を反映するためエンジンを再起動します');
    emitEngineSettings();
    return { applied: true, restartedEngine: true };
  }

  if (engineModeChanged) {
    if (isOnDemandEngineMode(nextConfig)) {
      log('省メモリモードを有効にしました');
      scheduleEngineIdleShutdown();
    } else {
      log('常駐モードを有効にしました');
      clearEngineIdleShutdown();
      if (socket?.connected && !engine) {
        await startEngine(nextConfig);
      }
    }
    emitEngineSettings();
    sendStatus(buildStatus());
    return { applied: true, engineModeChanged: true };
  }

  log('設定を保存しました');
  emitEngineSettings();
  sendStatus(buildStatus());
  return { applied: true };
}

function connectToServer(config) {
  const normalizedConfig = normalizeConfig(config);
  currentConfig = normalizedConfig;
  const serverUrl = normalizedConfig.serverUrl;

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  log('Linea Cloudに接続中...');
  sendStatus(buildStatus(false));

  socket = io(serverUrl, {
    auth: { type: 'connector', token: normalizedConfig.apiKey, ...getConnectorIdentity() }
  });

  socket.on('connect', () => {
    log(`接続成功 (ID: ${socket.id})`);
    log(`[DIAG] エンジン状態: ${engine?.running ? 'running (PID: ' + engine.pid + ')' : 'stopped'}`);
    log(`[DIAG] 現在の設定: Threads=${normalizedConfig.engineOptions?.Threads || '未設定'}, MultiPV=${normalizedConfig.engineOptions?.MultiPV || '未設定'}, Mode=${getEngineMode(normalizedConfig)}`);
    socket.emit('connector_ready');
    sendStatus(buildStatus(true));
    if (isOnDemandEngineMode(normalizedConfig)) {
      log('省メモリモード: 解析開始時にエンジンを起動します');
    } else {
      startEngine(normalizedConfig);
    }
    // 定跡利用が有効なら事前に読み込んでおく(無効なら初回リクエスト時に遅延ロード)
    if (normalizedConfig.useBook && normalizedConfig.bookPath) {
      void ensureBook(normalizedConfig).then(() => emitEngineSettings());
    }
  });

  socket.on('connect_error', (err) => {
    log(`[DIAG] 接続エラー: ${err.message} (type: ${err.type || 'unknown'})`);
    sendStatus(buildStatus(false));
  });

  socket.on('disconnect', (reason) => {
    log(`[DIAG] 切断 (reason: ${reason}, engineRunning: ${!!engine?.running})`);
    // 再接続後はサーバーが残りから再バッチするのでローカルキューは破棄。
    // batchActive はループ自身に落とさせる（ここで消すと再接続時に二重ループになる）
    batchQueue = [];
    if (engine && batchActive && !isAnalyzing) {
      engine.stop({ discardSearch: true });
    }
    sendStatus(buildStatus(false));
    if (reason === 'io server disconnect') {
      log('[DIAG] サーバー側切断 → 手動再接続を試行');
      socket.connect();
    }
  });

  // ★診断: 再接続イベント
  socket.io.on('reconnect_attempt', (attempt) => {
    log(`[DIAG] 再接続試行 #${attempt}`);
  });
  socket.io.on('reconnect', (attempt) => {
    log(`[DIAG] 再接続成功 (${attempt}回目)`);
  });
  socket.io.on('reconnect_error', (err) => {
    log(`[DIAG] 再接続エラー: ${err.message}`);
  });

  // ★設定同期: ブラウザ接続時に現在のエンジン設定を返す
  socket.on('request_engine_settings', () => {
    markActivity();
    log(`[DIAG] ブラウザから設定リクエスト受信 → Threads=${currentConfig?.engineOptions?.Threads}, MultiPV=${currentConfig?.engineOptions?.MultiPV}`);
    emitEngineSettings();
  });

  // --- 解析リクエスト ---
  socket.on('request_analysis', async (data) => {
    markActivity();
    const { sfen, turn } = data || {};
    if (!sfen) return;
    lastSfen = sfen;
    lastTurn = turn;
    clearEngineIdleShutdown();
    const requestSfen = sfen;
    const requestTurn = turn;

    // ★定跡: 「定跡を利用」ON でヒットしたら、エンジンを回さず候補手を返す
    //   (ShogiHome の searchBook と同じ発想。手を進めて定跡を外れたら自動でエンジンへ)
    if (currentConfig?.useBook && currentConfig?.bookPath) {
      try {
        const b = await ensureBook(currentConfig);
        if (lastSfen !== requestSfen || lastTurn !== requestTurn) return;
        if (b) {
          const bookMoves = await b.searchMoves(sfen);
          if (lastSfen !== requestSfen || lastTurn !== requestTurn) return;
          if (bookMoves.length > 0) {
            // 対話解析セッションとしては扱わない(エンジンは止め、バッチには道を譲る)
            if (isAnalyzing) {
              isAnalyzing = false;
              if (engine) engine.stop();
            }
            emitBookMoves(requestSfen, requestTurn, bookMoves);
            scheduleEngineIdleShutdown();
            return;
          }
        }
      } catch (e) {
        log(`定跡検索エラー: ${e.message}`);
      }
    }

    if (!engine || !engine.running) {
      if (isOnDemandEngineMode(currentConfig)) {
        log('省メモリモード: 解析開始のためエンジンを起動します');
      }
      const started = await startEngine(currentConfig);
      if (!started || !engine) {
        log('解析開始できません: エンジンが起動していません');
        return;
      }
      if (lastSfen !== requestSfen || lastTurn !== requestTurn) return;
    }
    isAnalyzing = true;
    log('解析開始...');
    // UsiEngine 内部で「予約+暗黙stop→bestmove後にposition/go」に直列化される。
    // バッチのmovetime探索中なら結果は破棄され、ループが再キューする。
    engine.analyze(sfen);
  });

  socket.on('stop_analysis', () => {
    markActivity();
    log('解析停止');
    isAnalyzing = false;
    if (engine) {
      // discardSearch: バッチ探索が走っていた場合は結果を捨てさせる（ループが再キュー）
      engine.stop({ discardSearch: true });
    }
    scheduleEngineIdleShutdown();
  });

  // ★バックグラウンド全解析: サーバーからバッチを受け取り go movetime で逐次解析
  socket.on('connector:analyze_batch', (data) => {
    markActivity();
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    const jobId = typeof data?.jobId === 'string' ? data.jobId : '';
    if (!jobId || positions.length === 0) return;
    stoppedBatchJobs.delete(jobId);
    // サーバーは 1 バッチずつしか送らないのでキューは丸ごと置き換え
    batchQueue = positions
      .filter((p) => p && typeof p.sfen === 'string' && p.sfen.length > 0)
      .map((p) => ({ jobId, sfen: p.sfen }));
    const sec = Number(data?.secondsPerMove);
    batchSecondsPerMove = Number.isFinite(sec)
      ? Math.min(30, Math.max(1, Math.floor(sec)))
      : 3;
    // ジョブ全体の進捗をサーバーの値に同期（再送でローカルカウントがずれても補正される）
    const done = Number(data?.doneCount);
    const total = Number(data?.totalCount);
    if (jobId !== batchJobId) {
      batchJobId = jobId;
      batchJobDone = Number.isFinite(done) && done >= 0 ? done : 0;
      batchJobTotal = Number.isFinite(total) && total > 0 ? total : 0;
      log(`バッチ解析ジョブ受信 (全 ${batchJobTotal || '?'} 局面, ${batchSecondsPerMove}秒/手)`);
    } else {
      if (Number.isFinite(done) && done >= 0) batchJobDone = done;
      if (Number.isFinite(total) && total > 0) batchJobTotal = total;
    }
    startBatchLoop();
  });

  socket.on('connector:analyze_stop', (data) => {
    markActivity();
    const jobId = typeof data?.jobId === 'string' ? data.jobId : null;
    if (jobId) {
      stoppedBatchJobs.add(jobId);
      batchQueue = batchQueue.filter((item) => item.jobId !== jobId);
    } else {
      for (const item of batchQueue) stoppedBatchJobs.add(item.jobId);
      if (batchJobId) stoppedBatchJobs.add(batchJobId);
      batchQueue = [];
    }
    // Set が際限なく育たないように軽く刈る
    if (stoppedBatchJobs.size > 50) {
      for (const id of stoppedBatchJobs) {
        stoppedBatchJobs.delete(id);
        if (stoppedBatchJobs.size <= 25) break;
      }
    }
    // エンジンに残った探索を止める（対話解析 isAnalyzing 中はその探索を壊さない）
    if (batchActive && engine && !isAnalyzing) {
      engine.stop({ discardSearch: true });
    }
  });

  socket.on('reset_engine', async () => {
    markActivity();
    if (!engine || !engine.running) return;
    log('エンジンリセット');
    try {
      const wasAnalyzing = isAnalyzing;
      await engine.newGame();
      if (wasAnalyzing && lastSfen) {
        engine.analyze(lastSfen);
      }
    } catch (e) {
      log(`エンジンリセットエラー: ${e.message}`);
    }
  });

  socket.on('set_engine_option', async (data) => {
    markActivity();
    const { name, value } = data || {};
    if (typeof name !== 'string') return;

    // ★UseBook はエンジンオプションではなく Connector 側の疑似オプション。
    //   エンジンへは送らず、設定として保存して同期だけ返す
    if (name === 'UseBook') {
      const useBook = String(value) === 'true';
      const cfg = currentConfig || normalizedConfig;
      cfg.useBook = useBook;
      currentConfig = cfg;
      try { saveConfig(cfg); } catch (e) { log(`設定保存エラー: ${e.message}`); }
      log(`定跡利用を${useBook ? '有効' : '無効'}にしました`);
      emitEngineSettings();
      // 読み込み完了後にもう一度同期(loading→ok/errorの反映)
      if (useBook && cfg.bookPath) {
        void ensureBook(cfg).then(() => emitEngineSettings());
      }
      return;
    }

    const activeConfig = currentConfig || normalizedConfig;
    const oldValue = activeConfig.engineOptions?.[name];
    log(`[DIAG] オプション変更: ${name} = ${oldValue} → ${value} (ブラウザからの要求)`);

    if (!activeConfig.engineOptions) activeConfig.engineOptions = {};
    activeConfig.engineOptions[name] = value;
    currentConfig = activeConfig;
    try { saveConfig(activeConfig); } catch (e) { log(`設定保存エラー: ${e.message}`); }

    if (!engine || !engine.running) {
      log('[DIAG] エンジン停止中のため、次回起動時にオプションを反映します');
      emitEngineSettings();
      return;
    }

    try {
      const wasAnalyzing = isAnalyzing;
      // 探索中なら UsiEngine が stop→bestmove→setoption→isready を直列化する。
      // バッチ探索は破棄され再キューされる。
      await engine.setOptions({ [name]: value });
      if (wasAnalyzing && lastSfen) {
        engine.analyze(lastSfen);
      }
    } catch (e) {
      log(`オプション変更エラー: ${e.message}`);
    } finally {
      // ★設定同期: 変更後の実際の値をブラウザへ通知
      emitEngineSettings();
    }
  });

}

function disconnectFromServer() {
  clearEngineIdleShutdown();
  batchQueue = [];
  void closeBook();
  const e = engine;
  engine = null;
  if (e) e.quit();
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  isAnalyzing = false;
  sendStatus(buildStatus(false, false));
  log('切断しました');
}

// --- エンジン起動 ---

// 旧エンジンを安全に終了させる（quit → SIGTERM → SIGKILL は UsiEngine 内で段階実行）
function stopEngineProcess() {
  const e = engine;
  engine = null;
  if (!e) return Promise.resolve();
  clearEngineIdleShutdown();
  return e.quit();
}

async function startEngine(config) {
  if (engineStartPromise) {
    log('エンジン起動中のため、完了を待ちます');
    return engineStartPromise;
  }

  engineStartPromise = (async () => {
    const normalizedConfig = normalizeConfig(config);

    // 旧エンジンの終了を待ってから新エンジンを起動（二重起動防止）
    await stopEngineProcess();

    const enginePath = normalizedConfig.enginePath;

    if (!enginePath || !fs.existsSync(enginePath)) {
      log(`エンジンが見つかりません: ${enginePath || '(未設定)'}`);
      sendStatus(buildStatus(!!socket?.connected, false));
      return false;
    }

    log(`エンジン起動: ${path.basename(enginePath)}`);
    log(`[DIAG] 適用オプション: ${JSON.stringify(normalizedConfig.engineOptions || {})}`);

    const e = new UsiEngine({
      cmd: enginePath,
      engineOptions: normalizedConfig.engineOptions || {},
      log,
    });
    engine = e;

    // 対話解析の info をブラウザへ（局面タグで古い info を落とす）
    // v2: 構造化済みフィールド（depth/seldepth/timeMs/nodes/nps/hashfullPerMill/
    //     multipv/scoreCP/scoreMate/lowerbound/upperbound/pv[]）。
    //     info(生文字列)は旧クライアント互換のため残す。サーバーは素通しする。
    e.onInfo = ({ sfen, raw, parsed }) => {
      if (!isAnalyzing || !socket?.connected) return;
      if (sfen !== lastSfen) return;
      if (parsed.scoreCP === undefined && parsed.scoreMate === undefined) return;
      const multipv = parsed.multipv === undefined ? 1 : parsed.multipv;
      queueAnalysisUpdate(multipv, { info: raw, sfen: lastSfen, turn: lastTurn, v2: parsed });
    };

    e.onUnexpectedClose = ({ code, signal, reason }) => {
      if (engine !== e) return;
      engine = null;
      log(`エンジン終了 (code: ${code}${signal ? `, signal: ${signal}` : ''}${reason ? `, ${reason}` : ''})`);
      const wasAnalyzing = isAnalyzing;
      isAnalyzing = false;
      sendStatus(buildStatus(!!socket?.connected, false));

      // ★エンジン自動再起動（意図しないクラッシュ・応答不能時）
      const shouldRestart = currentConfig && socket?.connected &&
        (!isOnDemandEngineMode(currentConfig) || wasAnalyzing || batchActive);
      if (!shouldRestart) return;
      const now = Date.now();
      engineRestartTimestamps = engineRestartTimestamps.filter(t => now - t < ENGINE_RESTART_WINDOW_MS);
      if (engineRestartTimestamps.length >= ENGINE_RESTART_LIMIT) {
        log('❌ エンジンの再起動回数が上限に達しました。手動で再接続してください。');
        return;
      }
      engineRestartTimestamps.push(now);
      log(`⚠️ エンジンが異常終了しました。自動再起動します... (${engineRestartTimestamps.length}/${ENGINE_RESTART_LIMIT})`);
      setTimeout(async () => {
        const started = await startEngine(currentConfig);
        if (started && engine && wasAnalyzing && lastSfen) {
          // 再起動後はハッシュが空の状態からの再解析になる（結果は新規探索として届く）
          isAnalyzing = true;
          engine.analyze(lastSfen);
        }
      }, 1000);
    };

    try {
      const res = await e.launch();
      if (engine !== e) return false; // 起動待ちの間に破棄された
      log(`エンジン準備完了: ${res.id.name || path.basename(enginePath)}`);
      if (res.report.skipped.length > 0) {
        log(`未対応オプションをスキップ: ${res.report.skipped.map((s) => s.name).join(', ')}`);
      }
      for (const c of res.report.clamped) {
        log(`オプション ${c.name} を ${c.from} → ${c.to} に制限（エンジン宣言の範囲）`);
      }
      sendStatus(buildStatus(!!socket?.connected, true));
      return true;
    } catch (err) {
      log(`エンジン起動失敗: ${err.message}`);
      if (engine === e) engine = null;
      e.quit();
      sendStatus(buildStatus(!!socket?.connected, false));
      return false;
    }
  })();

  try {
    return await engineStartPromise;
  } finally {
    engineStartPromise = null;
  }
}

// --- バックグラウンド全解析ループ ---
function startBatchLoop() {
  if (batchActive) return;
  batchActive = true;
  (async () => {
    while (batchQueue.length > 0) {
      if (!socket?.connected) {
        batchQueue = [];
        break;
      }
      // 対話解析を優先
      if (isAnalyzing) {
        await sleep(1000);
        continue;
      }
      if (!engine || !engine.running) {
        if (isOnDemandEngineMode(currentConfig)) {
          log('省メモリモード: バッチ解析のためエンジンを起動します');
        }
        const started = await startEngine(currentConfig);
        if (!started || !engine) {
          log('バッチ解析を中止: エンジンが起動していません');
          batchQueue = [];
          break;
        }
      }
      clearEngineIdleShutdown();
      const item = batchQueue.shift();
      if (!item) break;

      const res = await engine.search(item.sfen, batchSecondsPerMove * 1000);
      if (res.status === 'done') {
        if (socket?.connected) {
          const payload = { jobId: item.jobId, sfen: item.sfen };
          const lp = res.lastParsed;
          if (lp) {
            if (lp.scoreMate !== undefined) payload.scoreMate = lp.scoreMate;
            else if (lp.scoreCP !== undefined) payload.scoreCp = lp.scoreCP;
          }
          if (res.bestmove && res.bestmove !== 'resign' && res.bestmove !== 'win') {
            payload.bestMove = res.bestmove;
          }
          socket.emit('connector:analysis_result', payload);
          batchJobDone += 1;
          // 10 局面ごと・ジョブ完走時にジョブ全体の進捗を出す
          if (batchJobDone % 10 === 0 || batchJobDone === batchJobTotal) {
            log(`バッチ解析: ${batchJobDone}/${batchJobTotal || '?'} 局面完了`);
          }
        }
      } else {
        // preempted: 対話解析・切断・エンジン再起動などで破棄された → 再キュー
        if (!stoppedBatchJobs.has(item.jobId)) {
          batchQueue.unshift(item);
        }
        await sleep(200);
      }
    }
    batchActive = false;
    scheduleEngineIdleShutdown();
  })().catch((err) => {
    log(`バッチ解析ループエラー: ${err?.message || err}`);
    batchActive = false;
    batchQueue = [];
    scheduleEngineIdleShutdown();
  });
}

// --- IPC Handlers ---
function setupIPC() {
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('get-version', () => CURRENT_VERSION);
  ipcMain.handle('get-system-info', () => ({
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.floor(os.totalmem() / (1024 * 1024)),
  }));

  ipcMain.handle('save-config', async (_, config) => {
    markActivity();
    if (!config || typeof config !== 'object' || typeof config.apiKey !== 'string' || typeof config.enginePath !== 'string') {
      return { ok: false };
    }
    const prevConfig = currentConfig ? normalizeConfig(currentConfig) : null;
    const nextConfig = normalizeConfig(config);
    saveConfig(nextConfig);
    const result = await applyConfigUpdate(nextConfig, prevConfig);
    return { ok: true, ...result };
  });

  ipcMain.handle('select-engine-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'エンジンを選択',
      filters: [
        { name: '実行ファイル', extensions: ['exe', 'bat', 'cmd'] },
        { name: 'すべてのファイル', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0].replace(/\\/g, '/');
  });

  ipcMain.handle('check-eval-files', (_, enginePath) => {
    try {
      if (!enginePath || !/\.(exe|bat|cmd)$/i.test(enginePath)) return { ok: false, files: [] };
      const dir = path.dirname(enginePath.replace(/\//g, path.sep));
      const files = fs.readdirSync(dir);
      // NNUE系: nn.bin, *.nnue, nn*.bin
      const nnueFiles = files.filter(f =>
        /^nn.*\.bin$/i.test(f) || /\.nnue$/i.test(f)
      );
      // DL系: *.onnx
      const dlFiles = files.filter(f => /\.onnx$/i.test(f));
      // eval/ サブフォルダ内のファイルも検出
      const evalDir = files.find(f => {
        const full = path.join(dir, f);
        return f.toLowerCase() === 'eval' && fs.statSync(full).isDirectory();
      });
      let evalContents = [];
      if (evalDir) {
        try {
          evalContents = fs.readdirSync(path.join(dir, evalDir))
            .filter(f => /\.(bin|nnue)$/i.test(f));
        } catch (_) { /* ignore */ }
      }

      if (nnueFiles.length > 0) {
        return { ok: true, type: 'NNUE', files: nnueFiles };
      }
      if (dlFiles.length > 0) {
        return { ok: true, type: 'DL', files: dlFiles };
      }
      if (evalDir) {
        const display = evalContents.length > 0
          ? evalContents.map(f => `eval/${f}`)
          : ['eval/'];
        return { ok: true, type: 'evalフォルダ', files: display };
      }
      return { ok: false, files: [] };
    } catch (e) {
      return { ok: false, error: e.message, files: [] };
    }
  });

  // 定跡ファイル選択
  ipcMain.handle('select-book-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '定跡ファイルを選択（やねうら王 .db 形式）',
      filters: [
        { name: '定跡DB (やねうら王形式)', extensions: ['db'] },
        { name: 'すべてのファイル', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0].replace(/\\/g, '/');
  });

  ipcMain.handle('connect', (_, config) => {
    markActivity();
    connectToServer(config);
    return true;
  });

  ipcMain.handle('disconnect', () => {
    markActivity();
    disconnectFromServer();
    return true;
  });

  // ★USI通信ログ（直近100件のリングバッファ）
  ipcMain.handle('get-usi-history', () => {
    return engine ? engine.getHistoryText() : '';
  });

  // --- 自動アップデート ---
  ipcMain.handle('check-for-update', () => {
    return checkForConnectorUpdate();
  });
  ipcMain.handle('download-update', () => {
    markActivity();
    autoUpdater.downloadUpdate().catch((err) => {
      log(`ダウンロードエラー: ${err.message}`);
    });
  });
  ipcMain.handle('install-update', () => {
    markActivity();
    disconnectFromServer();
    autoUpdater.quitAndInstall(true, true);
  });
}

// --- ウィンドウ作成 ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    minWidth: 420,
    minHeight: 520,
    resizable: true,
    show: !process.env.LINEA_CONNECTOR_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: `Linea Connector ${CURRENT_VERSION}`,
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- アプリ起動 ---
app.whenReady().then(() => {
  CONFIG_PATH = getConfigPath();
  migrateOldConfig();
  setupIPC();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  stopUpdateCheckSchedule();
  disconnectFromServer();
  app.quit();
});

app.on('before-quit', () => {
  stopUpdateCheckSchedule();
});

// --- 自動アップデート ---
function setupAutoUpdater() {
  if (process.env.LINEA_CONNECTOR_TEST) return; // E2Eテスト中はGitHubへ行かない
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log(`新バージョン ${info.version} を自動ダウンロードします`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info.version);
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', Math.round(progress.percent));
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('アップデートのダウンロード完了');
    updateReadyToInstall = true;
    updateReadyVersion = info?.version || null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', {
        version: updateReadyVersion,
        idleMinutes: Math.round(UPDATE_IDLE_INSTALL_DELAY_MS / 60000),
      });
    }
    scheduleIdleUpdateInstall();
  });

  autoUpdater.on('error', (err) => {
    // latest.yml未公開やネットワークエラーは無視
    if (err.message && (err.message.includes('latest.yml') || err.message.includes('net::') || err.message.includes('404'))) {
      return;
    }
    log(`アップデート確認エラー: ${err.message}`);
  });

  startUpdateCheckSchedule();
}

function checkForConnectorUpdate() {
  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }

  try {
    updateCheckInFlight = autoUpdater.checkForUpdates()
      .catch(() => null)
      .finally(() => {
        updateCheckInFlight = null;
      });
  } catch (_) {
    updateCheckInFlight = null;
    return Promise.resolve(null);
  }

  return updateCheckInFlight;
}

function startUpdateCheckSchedule() {
  stopUpdateCheckSchedule();

  updateInitialCheckTimer = setTimeout(() => {
    checkForConnectorUpdate();
  }, UPDATE_CHECK_INITIAL_DELAY_MS);

  updatePeriodicCheckTimer = setInterval(() => {
    checkForConnectorUpdate();
  }, UPDATE_CHECK_INTERVAL_MS);
}

function stopUpdateCheckSchedule() {
  if (updateInitialCheckTimer) {
    clearTimeout(updateInitialCheckTimer);
    updateInitialCheckTimer = null;
  }
  if (updatePeriodicCheckTimer) {
    clearInterval(updatePeriodicCheckTimer);
    updatePeriodicCheckTimer = null;
  }
  clearIdleUpdateInstallTimer();
}

function clearIdleUpdateInstallTimer() {
  if (updateIdleInstallTimer) {
    clearTimeout(updateIdleInstallTimer);
    updateIdleInstallTimer = null;
  }
}

function canInstallDownloadedUpdate() {
  const idleMs = Date.now() - lastActivityAt;
  return updateReadyToInstall
    && idleMs >= UPDATE_IDLE_INSTALL_DELAY_MS
    && !isAnalyzing
    && !batchActive;
}

function scheduleIdleUpdateInstall() {
  clearIdleUpdateInstallTimer();
  if (!updateReadyToInstall) return;

  if (canInstallDownloadedUpdate()) {
    log(`アップデート ${updateReadyVersion || ''} をアイドル時間中に自動適用します`.trim());
    disconnectFromServer();
    autoUpdater.quitAndInstall(true, true);
    return;
  }

  const remainingIdleMs = Math.max(UPDATE_IDLE_INSTALL_DELAY_MS - (Date.now() - lastActivityAt), UPDATE_IDLE_INSTALL_POLL_MS);
  updateIdleInstallTimer = setTimeout(
    scheduleIdleUpdateInstall,
    Math.min(remainingIdleMs, UPDATE_IDLE_INSTALL_POLL_MS)
  );
}

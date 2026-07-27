// Linea Connector — Electron Main Process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const io = require('socket.io-client');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

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

function normalizeConfig(config) {
  return {
    ...config,
    serverUrl: normalizeServerUrl(config?.serverUrl),
    engineMode: getEngineMode(config),
    engineOptions: { ...(config?.engineOptions || {}) },
  };
}

function configsDiffer(a, b) {
  return JSON.stringify(a || null) !== JSON.stringify(b || null);
}

function isOnDemandEngineMode(config = currentConfig) {
  return getEngineMode(config) === ENGINE_MODE_ON_DEMAND;
}

function buildStatus(connected = !!socket?.connected, engineRunning = !!engineProcess) {
  return {
    connected,
    engineRunning,
    engineMode: getEngineMode(currentConfig),
  };
}

// --- 設定ファイル ---
// Electron標準の userData (%APPDATA%\linea-connector) を使用
function getConfigPath() {
  const dir = app.getPath('userData');
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
        log('旧サーバーURLをLinea APIへ移行しました');
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

// --- USI入力サニタイズ ---
function sanitizeUSI(str) {
  return String(str).replace(/[\r\n\x00-\x1f]/g, '');
}

// --- Socket.io + Engine ---
let socket = null;
let engineProcess = null;
let isAnalyzing = false;
let isChangingOption = false;
let isChangingOptionTimer = null;
let lastSfen = null;
let lastTurn = null;
let currentConfig = null;
let engineIdleShutdownTimer = null;

// ★バックグラウンド全解析バッチ（サーバー主導・Connector は無状態）
let batchQueue = []; // { jobId, sfen }[]
let batchSecondsPerMove = 3;
let batchActive = false;
// ジョブ全体の進捗（サーバーが analyze_batch に載せてくる doneCount/totalCount が正）。
// jobId が変わったらリセットする。
let batchJobId = null;
let batchJobDone = 0;
let batchJobTotal = 0;
// 現在のバッチ探索を破棄して局面をキュー先頭へ戻すフック。
// 対話解析系のハンドラが engine に stop を書く「前」に呼ぶことで、
// 部分探索の低品質な bestmove を結果として送ってしまうのを防ぐ。
let batchPreemptCurrent = null;

function markActivity() {
  lastActivityAt = Date.now();
}

// ★エンジン自動再起動（クラッシュ時）: 1分間に最大3回まで
const ENGINE_RESTART_LIMIT = 3;
const ENGINE_RESTART_WINDOW_MS = 60 * 1000;
let engineRestartTimestamps = [];

// ★安全な stdin.write ヘルパー（破損パイプへの書き込みを防止）
function safeWrite(cmd) {
  if (engineProcess && engineProcess.stdin && engineProcess.stdin.writable) {
    try {
      engineProcess.stdin.write(cmd);
      return true;
    } catch (e) {
      log(`stdin書き込みエラー: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ★isChangingOption 安全タイムアウト設定/解除
function setChangingOption(value) {
  isChangingOption = value;
  if (isChangingOptionTimer) {
    clearTimeout(isChangingOptionTimer);
    isChangingOptionTimer = null;
  }
  if (value) {
    isChangingOptionTimer = setTimeout(() => {
      if (isChangingOption) {
        log('⚠️ isChangingOption 安全タイムアウト: 強制リセット');
        isChangingOption = false;
        isChangingOptionTimer = null;
      }
    }, 15000);
  }
}

function emitEngineSettings() {
  if (currentConfig?.engineOptions && socket?.connected) {
    socket.emit('connector_engine_settings', {
      Threads: currentConfig.engineOptions.Threads,
      MultiPV: currentConfig.engineOptions.MultiPV,
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
  if (!isOnDemandEngineMode(currentConfig) || !engineProcess) return;
  clearEngineIdleShutdown();
  engineIdleShutdownTimer = setTimeout(async () => {
    engineIdleShutdownTimer = null;
    if (!isOnDemandEngineMode(currentConfig) || isAnalyzing || isChangingOption || !engineProcess) return;
    log('省メモリモード: エンジンを停止してメモリを解放します');
    await killEngineProcess();
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
  if (started && wasAnalyzing && resumeSfen) {
    lastSfen = resumeSfen;
    lastTurn = resumeTurn;
    isAnalyzing = true;
    log('解析を再開します');
    safeWrite(`position sfen ${sanitizeUSI(resumeSfen)}\n`);
    safeWrite('go infinite\n');
  }
  return started;
}

async function applyConfigUpdate(nextConfig, prevConfig) {
  currentConfig = nextConfig;

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
      if (engineProcess) {
        log('設定を保存しました。省メモリモードのため、次回解析時に新しいエンジン設定で起動します');
        await killEngineProcess();
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
      if (socket?.connected && !engineProcess) {
        await startEngine(nextConfig);
      }
    }
    emitEngineSettings();
    sendStatus(buildStatus(!!socket?.connected, !!engineProcess));
    return { applied: true, engineModeChanged: true };
  }

  log('設定を保存しました');
  emitEngineSettings();
  sendStatus(buildStatus(!!socket?.connected, !!engineProcess));
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
  sendStatus(buildStatus(false, !!engineProcess));

  socket = io(serverUrl, {
    auth: { type: 'connector', token: normalizedConfig.apiKey, ...getConnectorIdentity() }
  });

  socket.on('connect', () => {
    log(`接続成功 (ID: ${socket.id})`);
    log(`[DIAG] エンジン状態: ${engineProcess ? 'running (PID: ' + engineProcess.pid + ')' : 'stopped'}`);
    log(`[DIAG] 現在の設定: Threads=${normalizedConfig.engineOptions?.Threads || '未設定'}, MultiPV=${normalizedConfig.engineOptions?.MultiPV || '未設定'}, Mode=${getEngineMode(normalizedConfig)}`);
    socket.emit('connector_ready');
    sendStatus(buildStatus(true, !!engineProcess));
    if (isOnDemandEngineMode(normalizedConfig)) {
      log('省メモリモード: 解析開始時にエンジンを起動します');
    } else {
      startEngine(normalizedConfig);
    }
  });

  socket.on('connect_error', (err) => {
    log(`[DIAG] 接続エラー: ${err.message} (type: ${err.type || 'unknown'})`);
    sendStatus(buildStatus(false, false));
  });

  socket.on('disconnect', (reason) => {
    log(`[DIAG] 切断 (reason: ${reason}, engineRunning: ${!!engineProcess})`);
    // 再接続後はサーバーが残りから再バッチするのでローカルキューは破棄。
    // batchActive はループ自身に落とさせる（ここで消すと再接続時に二重ループになる）
    if (batchPreemptCurrent) batchPreemptCurrent();
    batchQueue = [];
    sendStatus(buildStatus(false, !!engineProcess));
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
    const { sfen, turn } = data;
    if (isChangingOption) {
      lastSfen = sfen;
      lastTurn = turn;
      return;
    }
    if (!sfen) return;
    lastSfen = sfen;
    lastTurn = turn;
    // バッチ探索中なら破棄して後回し（対話解析優先）
    if (batchPreemptCurrent) batchPreemptCurrent();
    clearEngineIdleShutdown();
    const requestSfen = sfen;
    const requestTurn = turn;
    if (!engineProcess) {
      if (isOnDemandEngineMode(currentConfig)) {
        log('省メモリモード: 解析開始のためエンジンを起動します');
      }
      const started = await startEngine(currentConfig);
      if (!started || !engineProcess) {
        log('解析開始できません: エンジンが起動していません');
        return;
      }
      if (lastSfen !== requestSfen || lastTurn !== requestTurn) return;
    }
    isAnalyzing = true;
    log('解析開始...');
    safeWrite('stop\n');
    safeWrite(`position sfen ${sanitizeUSI(sfen)}\n`);
    safeWrite('go infinite\n');
  });

  socket.on('stop_analysis', () => {
    markActivity();
    if (isChangingOption) {
      isAnalyzing = false;
      scheduleEngineIdleShutdown();
      return;
    }
    log('解析停止');
    isAnalyzing = false;
    // この stop はバッチ探索も止めてしまうので、先に現在の局面を退避する
    if (batchPreemptCurrent) batchPreemptCurrent();
    safeWrite('stop\n');
    safeWrite('usinewgame\n');
    safeWrite('isready\n');
    scheduleEngineIdleShutdown();
  });

  // ★バックグラウンド全解析: サーバーからバッチを受け取り go movetime で逐次解析
  socket.on('connector:analyze_batch', (data) => {
    markActivity();
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    const jobId = typeof data?.jobId === 'string' ? data.jobId : '';
    if (!jobId || positions.length === 0) return;
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
    // 探索中の局面をいったんキューへ戻してから該当ジョブごと落とす
    if (batchPreemptCurrent) batchPreemptCurrent();
    if (jobId) {
      batchQueue = batchQueue.filter((item) => item.jobId !== jobId);
    } else {
      batchQueue = [];
    }
    // エンジンに残った探索を止める（対話解析 isAnalyzing 中はその探索を壊さない）
    if (batchActive && !isAnalyzing) {
      safeWrite('stop\n');
    }
  });

  socket.on('reset_engine', async () => {
    markActivity();
    if (!engineProcess) return;
    if (batchPreemptCurrent) batchPreemptCurrent();
    log('エンジンリセット');
    try {
      const wasAnalyzing = isAnalyzing;
      if (wasAnalyzing) {
        safeWrite('stop\n');
        await waitForStop(engineProcess);
      }
      isAnalyzing = false;
      safeWrite('usinewgame\n');
      safeWrite('isready\n');
      await waitForReady(engineProcess);
      if (wasAnalyzing && lastSfen) {
        isAnalyzing = true;
        safeWrite(`position sfen ${sanitizeUSI(lastSfen)}\n`);
        safeWrite('go infinite\n');
      }
    } catch (e) {
      log(`エンジンリセットエラー: ${e.message}`);
      isAnalyzing = false;
    }
  });

  socket.on('set_engine_option', async (data) => {
    markActivity();
    if (isChangingOption) {
      log(`[DIAG] set_engine_option 拒否 (engineProcess: ${!!engineProcess}, isChangingOption: ${isChangingOption})`);
      return;
    }
    const { name, value } = data;
    const activeConfig = currentConfig || normalizedConfig;
    const oldValue = activeConfig.engineOptions?.[name];
    log(`[DIAG] オプション変更: ${name} = ${oldValue} → ${value} (ブラウザからの要求)`);

    if (!activeConfig.engineOptions) activeConfig.engineOptions = {};
    activeConfig.engineOptions[name] = value;
    currentConfig = activeConfig;
    try { saveConfig(activeConfig); } catch (e) { log(`設定保存エラー: ${e.message}`); }

    if (!engineProcess) {
      log('[DIAG] エンジン停止中のため、次回起動時にオプションを反映します');
      emitEngineSettings();
      return;
    }

    // オプション変更は stop/setoption を書くので、バッチ探索中の局面は退避する
    if (batchPreemptCurrent) batchPreemptCurrent();
    setChangingOption(true);

    try {
      const wasAnalyzing = isAnalyzing;
      if (wasAnalyzing) {
        safeWrite('stop\n');
        await waitForStop(engineProcess);
      }
      safeWrite(`setoption name ${sanitizeUSI(name)} value ${sanitizeUSI(value)}\n`);
      safeWrite('isready\n');
      await waitForReady(engineProcess);
      if (wasAnalyzing && lastSfen) {
        safeWrite(`position sfen ${sanitizeUSI(lastSfen)}\n`);
        safeWrite('go infinite\n');
      }
    } catch (e) {
      log(`オプション変更エラー: ${e.message}`);
    } finally {
      setChangingOption(false);
      // ★設定同期: 変更後の実際の値をブラウザへ通知
      emitEngineSettings();
    }
  });

}

function disconnectFromServer() {
  clearEngineIdleShutdown();
  if (batchPreemptCurrent) batchPreemptCurrent();
  batchQueue = [];
  if (engineProcess) {
    try { engineProcess.stdin.write('quit\n'); } catch (e) {}
    engineProcess.kill();
    engineProcess = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  isAnalyzing = false;
  sendStatus(buildStatus(false, false));
  log('切断しました');
}

// --- エンジン起動 ---
let engineStartPromise = null;

// ★旧エンジンを安全に終了させる（quit → SIGTERM → 3秒後にフォースキル）
function killEngineProcess() {
  return new Promise((resolve) => {
    clearEngineIdleShutdown();
    if (!engineProcess) { resolve(); return; }

    const proc = engineProcess;
    engineProcess = null;

    let settled = false;
    const settle = () => { if (settled) return; settled = true; resolve(); };

    // 3秒で強制終了（Windowsでは大きなプロセスの終了に時間がかかる）
    const forceTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      settle();
    }, 3000);

    proc.once('close', () => {
      clearTimeout(forceTimer);
      settle();
    });

    // USIプロトコルで正常終了を要求 → 1秒後にSIGTERM
    try { proc.stdin.write('quit\n'); } catch {}
    setTimeout(() => { try { proc.kill(); } catch {} }, 1000);
  });
}

async function startEngine(config) {
  if (engineStartPromise) {
    log('エンジン起動中のため、完了を待ちます');
    return engineStartPromise;
  }

  engineStartPromise = (async () => {
    const normalizedConfig = normalizeConfig(config);

    // ★修正: 旧エンジンの終了を待ってから新エンジンを起動（二重起動防止）
    await killEngineProcess();

    const enginePath = normalizedConfig.enginePath;

    if (!enginePath || !fs.existsSync(enginePath)) {
      log(`エンジンが見つかりません: ${enginePath || '(未設定)'}`);
      sendStatus(buildStatus(!!socket?.connected, false));
      return false;
    }

    log(`エンジン起動: ${path.basename(enginePath)}`);
    log(`[DIAG] 適用オプション: ${JSON.stringify(normalizedConfig.engineOptions || {})}`);
    const proc = spawn(enginePath, [], { cwd: path.dirname(enginePath) });
    engineProcess = proc;

    proc.stdin.write('usi\n');
    if (normalizedConfig.engineOptions) {
      for (const [key, value] of Object.entries(normalizedConfig.engineOptions)) {
        proc.stdin.write(`setoption name ${key} value ${value}\n`);
      }
    }
    proc.stdin.write('isready\n');
    proc.stdin.write('usinewgame\n');

    // ★info行スロットリング: MultiPVごとに最新のみ150ms間隔で送信（NPS改善）
    let pendingInfoLines = [];
    let infoFlushTimer = null;
    const INFO_THROTTLE_MS = 150;

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === 'readyok') {
          log('エンジン準備完了');
          sendStatus(buildStatus(!!socket?.connected, true));
        }
        if (isAnalyzing && trimmed.startsWith('info') && trimmed.includes('score')) {
          if (socket?.connected) {
            pendingInfoLines.push({ info: trimmed, sfen: lastSfen, turn: lastTurn });

            if (!infoFlushTimer) {
              infoFlushTimer = setTimeout(() => {
                // MultiPVごとに最新のinfoだけを送信
                const latest = new Map();
                for (const item of pendingInfoLines) {
                  const mpvMatch = item.info.match(/multipv (\d+)/);
                  const mpv = mpvMatch ? mpvMatch[1] : '1';
                  latest.set(mpv, item);
                }
                for (const data of latest.values()) {
                  socket.emit('connector_analysis_update', data);
                }
                pendingInfoLines = [];
                infoFlushTimer = null;
              }, INFO_THROTTLE_MS);
            }
          }
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('Failed') || msg.includes('cannot open')) {
        log(`エンジンエラー: ${msg.trim()}`);
      }
    });

    proc.on('close', (code) => {
      // ★ガード: 古いプロセスのハンドラが新プロセスの参照を上書きしないようにする
      if (engineProcess !== proc) return;

      log(`エンジン終了 (code: ${code})`);
      engineProcess = null;
      // ★デッドロック防止: エンジン終了時にフラグを強制リセット
      setChangingOption(false);
      const wasAnalyzing = isAnalyzing;
      isAnalyzing = false;
      sendStatus(buildStatus(!!socket?.connected, false));

      // ★エンジン自動再起動（意図しないクラッシュ時）
      const shouldRestart = currentConfig && socket?.connected && code !== 0 && code !== null &&
        (!isOnDemandEngineMode(currentConfig) || wasAnalyzing);
      if (shouldRestart) {
        const now = Date.now();
        engineRestartTimestamps = engineRestartTimestamps.filter(t => now - t < ENGINE_RESTART_WINDOW_MS);
        if (engineRestartTimestamps.length < ENGINE_RESTART_LIMIT) {
          engineRestartTimestamps.push(now);
          log(`⚠️ エンジンがクラッシュしました。自動再起動します... (${engineRestartTimestamps.length}/${ENGINE_RESTART_LIMIT})`);
          setTimeout(async () => {
            const started = await startEngine(currentConfig);
            if (started && wasAnalyzing && lastSfen) {
              isAnalyzing = true;
              safeWrite(`position sfen ${sanitizeUSI(lastSfen)}\n`);
              safeWrite('go infinite\n');
            }
          }, 1000);
        } else {
          log('❌ エンジンの再起動回数が上限に達しました。手動で再接続してください。');
        }
      }
    });

    return true;
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
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (isChangingOption) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (!engineProcess) {
        if (isOnDemandEngineMode(currentConfig)) {
          log('省メモリモード: バッチ解析のためエンジンを起動します');
        }
        const started = await startEngine(currentConfig);
        if (!started || !engineProcess) {
          log('バッチ解析を中止: エンジンが起動していません');
          batchQueue = [];
          break;
        }
      }
      clearEngineIdleShutdown();
      const item = batchQueue.shift();
      if (!item) break;
      await analyzeBatchPosition(item);
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

function analyzeBatchPosition({ jobId, sfen }) {
  return new Promise((resolve) => {
    const proc = engineProcess;
    if (!proc || !socket?.connected) {
      resolve();
      return;
    }

    const movetimeMs = batchSecondsPerMove * 1000;
    let lastScoreInfo = null;
    let settled = false;

    const cleanup = () => {
      if (batchPreemptCurrent === preempt) batchPreemptCurrent = null;
      proc.stdout.off('data', onData);
    };

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (payload && socket?.connected) {
        socket.emit('connector:analysis_result', payload);
        batchJobDone += 1;
        // 10 局面ごと・ジョブ完走時にジョブ全体の進捗を出す
        // （ローカルキューは現在バッチの残りでしかないため表示しない）
        if (batchJobDone % 10 === 0 || batchJobDone === batchJobTotal) {
          log(`バッチ解析: ${batchJobDone}/${batchJobTotal || '?'} 局面完了`);
        }
      }
      resolve();
    };

    // 対話解析などに横取りされたら結果を破棄してキュー先頭へ戻す。
    // 呼び出し元（request_analysis / stop_analysis / reset_engine /
    // set_engine_option / analyze_stop / disconnect）が engine に書く前に呼ぶ。
    // ここでは stop を書かない: 直後に対話解析の go infinite が始まっている
    // 可能性があり、書くとその探索まで止めてしまう。
    const preempt = () => {
      if (settled) return;
      settled = true;
      cleanup();
      batchQueue.unshift({ jobId, sfen });
      resolve();
    };
    batchPreemptCurrent = preempt;

    const buildPayload = () => {
      const payload = { jobId, sfen };
      if (lastScoreInfo) {
        const mateMatch = lastScoreInfo.match(/score mate (-?\d+)/);
        const cpMatch = lastScoreInfo.match(/score cp (-?\d+)/);
        if (mateMatch) payload.scoreMate = parseInt(mateMatch[1], 10);
        else if (cpMatch) payload.scoreCp = parseInt(cpMatch[1], 10);
      }
      return payload;
    };

    const onData = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('info') && trimmed.includes('score')) {
          // multipv 1（または multipv 無し）の最新だけ保持
          const mpvMatch = trimmed.match(/multipv (\d+)/);
          const mpv = mpvMatch ? parseInt(mpvMatch[1], 10) : 1;
          if (mpv === 1) lastScoreInfo = trimmed;
        }
        if (trimmed.startsWith('bestmove')) {
          // フック経由を通らずに対話解析が始まっていたら、
          // この bestmove は途中打ち切りの低品質値なので捨てて再キューする
          if (isAnalyzing) {
            preempt();
            return;
          }
          const moveToken = trimmed.split(/\s+/)[1] || '';
          const payload = buildPayload();
          if (moveToken && moveToken !== 'resign' && moveToken !== 'win') {
            payload.bestMove = moveToken;
          }
          finish(payload);
          return;
        }
      }
    };

    proc.stdout.on('data', onData);

    safeWrite(`position sfen ${sanitizeUSI(sfen)}\n`);
    safeWrite(`go movetime ${movetimeMs}\n`);

    const timeoutMs = movetimeMs + 15_000;
    setTimeout(() => {
      if (settled) return;
      if (isAnalyzing) {
        // 対話解析中に stop を書くとその探索を壊すので、破棄して再キュー
        preempt();
        return;
      }
      safeWrite('stop\n');
      setTimeout(() => {
        if (settled) return;
        // タイムアウト時も最後の score があれば返す
        if (lastScoreInfo) {
          finish(buildPayload());
        } else {
          finish(null);
        }
      }, 2000);
    }, timeoutMs);
  });
}

// --- 補助関数 ---
function waitForStop(proc) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { proc.stdout.off('data', listener); resolve(); }, 1000);
    const listener = (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim().startsWith('bestmove') || line.trim().includes('depth 0')) {
          clearTimeout(timeout); proc.stdout.off('data', listener); resolve(); return;
        }
      }
    };
    proc.stdout.on('data', listener);
  });
}

function waitForReady(proc) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { proc.stdout.off('data', listener); log('readyokタイムアウト'); resolve(); }, 5000);
    const listener = (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim() === 'readyok') {
          clearTimeout(timeout); proc.stdout.off('data', listener); resolve(); return;
        }
      }
    };
    proc.stdout.on('data', listener);
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
        { name: '実行ファイル', extensions: ['exe'] },
        { name: 'すべてのファイル', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0].replace(/\\/g, '/');
  });

  ipcMain.handle('check-eval-files', (_, enginePath) => {
    try {
      if (!enginePath || !enginePath.endsWith('.exe')) return { ok: false, files: [] };
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
    && !isChangingOption;
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

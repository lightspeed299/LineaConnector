// Linea Connector — Renderer (app.js)
(async () => {
  const $ = (sel) => document.querySelector(sel);
  const DEFAULT_SERVER_URL = 'https://api.lineashogi.com';
  const ENGINE_MODE_ALWAYS = 'always';
  const ENGINE_MODE_ON_DEMAND = 'onDemand';
  const config = await window.connector.getConfig();
  const version = await window.connector.getVersion();
  const sysInfo = await window.connector.getSystemInfo();

  // スレッド/Hash上限をシステム仕様に合わせる
  const maxThreads = sysInfo.cpuCores;
  const maxHashMB = Math.floor(sysInfo.totalMemoryMB * 0.75); // メモリの75%まで
  applyLimits('wizard-threads', 'wizard-hash', maxThreads, maxHashMB);
  applyLimits('cfg-threads', 'cfg-hash', maxThreads, maxHashMB);

  function applyLimits(threadsId, hashId, maxT, maxH) {
    const tEl = $(`#${threadsId}`);
    const hEl = $(`#${hashId}`);
    if (tEl) { tEl.max = maxT; tEl.title = `最大 ${maxT} (CPU論理コア数)`; }
    if (hEl) { hEl.max = maxH; hEl.title = `最大 ${maxH} MB (搭載メモリの75%)`; }
  }

  // 設定があればメイン画面、なければウィザード
  if (config && config.apiKey && config.enginePath) {
    showMain(config);
  } else {
    showWizard();
  }

  // ========== Wizard ==========
  function showWizard() {
    $('#wizard').classList.remove('hidden');
    $('#main').classList.add('hidden');
    showStep(1);

    // Step 1: API Key
    const apikeyInput = $('#wizard-apikey');
    const next1 = $('#wizard-next1');
    apikeyInput.addEventListener('input', () => {
      next1.disabled = !apikeyInput.value.trim();
    });
    next1.addEventListener('click', () => showStep(2));

    // Step 2: Engine
    const engineInput = $('#wizard-engine');
    const next2 = $('#wizard-next2');
    $('#wizard-browse').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (filePath) {
        engineInput.value = filePath;
        next2.disabled = false;
        checkEvalFiles(filePath);
      }
    });
    next2.addEventListener('click', () => showStep(3));
    $('#wizard-back2').addEventListener('click', () => showStep(1));

    // Step 3: Options
    $('#wizard-back3').addEventListener('click', () => showStep(2));
    $('#wizard-finish').addEventListener('click', async () => {
      const newConfig = {
        serverUrl: DEFAULT_SERVER_URL,
        apiKey: apikeyInput.value.trim(),
        enginePath: engineInput.value,
        engineMode: $('#wizard-engine-ondemand').checked ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS,
        engineOptions: {
          Threads: parseInt($('#wizard-threads').value, 10) || 4,
          USI_Hash: parseInt($('#wizard-hash').value, 10) || 1024,
          MultiPV: parseInt($('#wizard-multipv').value, 10) || 3,
          FV_SCALE: parseInt($('#wizard-fvscale').value, 10) || 24,
        }
      };
      await window.connector.saveConfig(newConfig);
      showMain(newConfig);
      window.connector.connect(newConfig);
    });
  }

  function showStep(n) {
    for (let i = 1; i <= 3; i++) {
      $(`#wizard-step${i}`).classList.toggle('hidden', i !== n);
    }
  }

  async function checkEvalFiles(enginePath) {
    const statusEl = $('#wizard-eval-status');
    statusEl.textContent = '評価関数を確認中...';
    statusEl.className = 'eval-status';

    const result = await window.connector.checkEvalFiles(enginePath);
    if (result.ok) {
      statusEl.textContent = `評価関数を検出 (${result.type}): ${result.files.join(', ')}`;
      statusEl.style.color = '#008000';
    } else {
      statusEl.textContent = '評価関数が見つかりません。エンジンと同じフォルダに配置してください。';
      statusEl.style.color = '#cc6600';
    }
  }

  // ========== Main Screen ==========
  function showMain(cfg) {
    $('#wizard').classList.add('hidden');
    $('#main').classList.remove('hidden');
    $('#version').textContent = version;

    populateSettings(cfg);
    setupMainHandlers(cfg);

    // 既存設定があれば自動接続
    if (cfg.apiKey && cfg.enginePath) {
      window.connector.connect(cfg);
    }
  }

  function populateSettings(cfg) {
    $('#cfg-apikey').value = cfg.apiKey || '';
    $('#cfg-engine').value = cfg.enginePath || '';
    $('#cfg-eval').value = cfg.evalPath || '';
    $('#cfg-book').value = cfg.bookPath || '';
    // 評価関数が未設定なら、エンジンから自動検出して初期値として埋める(保存で確定)
    if (!cfg.evalPath && cfg.enginePath) {
      void autofillEvalFromEngine(cfg.enginePath, { quiet: true });
    }
    const opts = cfg.engineOptions || {};
    $('#cfg-threads').value = opts.Threads || 4;
    $('#cfg-hash').value = opts.USI_Hash || 1024;
    $('#cfg-multipv').value = opts.MultiPV || 3;
    $('#cfg-fvscale').value = opts.FV_SCALE || opts.fv_scale || 24;
    $('#cfg-engine-ondemand').checked = cfg.engineMode === ENGINE_MODE_ON_DEMAND;

    if (cfg.enginePath) {
      const name = cfg.enginePath.split('/').pop();
      $('#engine-name').textContent = name;
    }
  }

  // ★エンジンに同梱された評価関数を検出して「評価関数」欄へ自動入力する
  async function autofillEvalFromEngine(enginePath, { quiet } = {}) {
    try {
      const result = await window.connector.checkEvalFiles(enginePath);
      if (!result.ok || result.files.length === 0) {
        if (!quiet) addLog('⚠ 評価関数を自動検出できませんでした。「評価関数」の参照から指定できます');
        return false;
      }
      const engineDir = enginePath.split('/').slice(0, -1).join('/');
      const full = `${engineDir}/${result.files[0]}`;
      $('#cfg-eval').value = full;
      if (!quiet) addLog(`評価関数を自動検出 (${result.type}): ${result.files[0]}（変更する場合は参照から）`);
      return true;
    } catch {
      return false;
    }
  }

  function setupMainHandlers(cfg) {
    let activeConfig = { ...cfg };

    // API Key visibility toggle
    let keyVisible = false;
    $('#btn-toggle-key').addEventListener('click', () => {
      keyVisible = !keyVisible;
      $('#cfg-apikey').type = keyVisible ? 'text' : 'password';
      $('#btn-toggle-key').textContent = keyVisible ? '非表示' : '表示';
    });

    // Engine select
    $('#btn-select-engine').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (filePath) {
        $('#cfg-engine').value = filePath;
        $('#engine-name').textContent = filePath.split('/').pop();
        // エンジンに合わせて評価関数欄も自動更新(変更したい場合は参照から)
        const filled = await autofillEvalFromEngine(filePath);
        if (!filled) {
          $('#cfg-eval').value = '';
        }
      }
    });

    // Eval select
    $('#btn-select-eval').addEventListener('click', async () => {
      const filePath = await window.connector.selectEvalFile();
      if (filePath) {
        $('#cfg-eval').value = filePath;
        addLog('評価関数を選択しました。「設定を保存」でエンジンに反映されます');
      }
    });

    // Book select
    $('#btn-select-book').addEventListener('click', async () => {
      const filePath = await window.connector.selectBookFile();
      if (filePath) {
        $('#cfg-book').value = filePath;
        addLog('定跡ファイルを選択しました。「設定を保存」で反映されます');
      }
    });

    // Save
    $('#btn-save').addEventListener('click', async () => {
      let threads = parseInt($('#cfg-threads').value, 10) || 4;
      let hash = parseInt($('#cfg-hash').value, 10) || 1024;
      if (threads > maxThreads) { threads = maxThreads; $('#cfg-threads').value = threads; addLog(`Threadsを${maxThreads}に制限しました (CPUコア数上限)`); }
      if (hash > maxHashMB) { hash = maxHashMB; $('#cfg-hash').value = hash; addLog(`Hashを${maxHashMB}MBに制限しました (メモリ75%上限)`); }
      const updated = {
        serverUrl: activeConfig.serverUrl || DEFAULT_SERVER_URL,
        apiKey: $('#cfg-apikey').value,
        enginePath: $('#cfg-engine').value,
        evalPath: $('#cfg-eval').value,
        bookPath: $('#cfg-book').value,
        useBook: activeConfig.useBook === true,
        engineMode: $('#cfg-engine-ondemand').checked ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS,
        engineOptions: {
          Threads: threads,
          USI_Hash: hash,
          MultiPV: parseInt($('#cfg-multipv').value, 10) || 3,
          FV_SCALE: parseInt($('#cfg-fvscale').value, 10) || 24,
        }
      };
      const result = await window.connector.saveConfig(updated);
      if (result?.ok) {
        activeConfig = updated;
        addLog(result.restartedSocket
          ? '設定を保存し、接続を更新しました'
          : result.restartedEngine
            ? '設定を保存し、エンジンを再起動しました'
            : result.deferredEngineStart
              ? '設定を保存しました（次回解析時に反映）'
              : '設定を保存しました');
      } else {
        addLog('⚠ 設定を保存できませんでした');
      }
    });

    // Reconnect
    $('#btn-reconnect').addEventListener('click', async () => {
      await window.connector.disconnect();
      const freshConfig = await window.connector.getConfig();
      if (freshConfig) {
        activeConfig = freshConfig;
        populateSettings(freshConfig);
        window.connector.connect(freshConfig);
      }
    });
  }

  // ========== Status & Logs ==========
  window.connector.onStatusUpdate((status) => {
    const badge = $('#status-badge');
    const text = $('#status-text');
    const engineStatus = $('#engine-status');

    if (status.connected) {
      badge.className = 'status-badge online';
      text.textContent = 'ONLINE';
    } else {
      badge.className = 'status-badge offline';
      text.textContent = 'OFFLINE';
    }

    const isOnDemandIdle = status.connected && !status.engineRunning && status.engineMode === ENGINE_MODE_ON_DEMAND;
    engineStatus.textContent = status.engineRunning ? '待機中' : (isOnDemandIdle ? '省メモリ待機' : '停止');

    // ステータスバー更新
    const sbConn = $('#sb-connection');
    const sbEngine = $('#sb-engine');
    if (sbConn) sbConn.textContent = `接続: ${status.connected ? 'オンライン' : 'オフライン'}`;
    if (sbEngine) sbEngine.textContent = `エンジン: ${status.engineRunning ? '待機中' : (isOnDemandIdle ? '省メモリ待機' : '停止')}`;
  });

  window.connector.onLogMessage((msg) => {
    addLog(msg);
  });

  function addLog(msg) {
    const container = $('#log-container');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;

    // 最大100件
    while (container.children.length > 100) {
      container.removeChild(container.firstChild);
    }
  }

  // ★USI通信ログコピー（エンジンとの生のやりとり直近100件）
  $('#btn-copy-usi').addEventListener('click', async () => {
    const btn = $('#btn-copy-usi');
    const text = await window.connector.getUsiHistory();
    if (!text) {
      addLog('USI通信ログはまだありません（エンジン起動後に記録されます）');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ コピー済み';
      setTimeout(() => { btn.textContent = '⚙ USI通信'; }, 2000);
    } catch {
      addLog('USI通信ログのコピーに失敗しました');
    }
  });

  // ★ログコピー機能
  $('#btn-copy-log').addEventListener('click', async () => {
    const container = $('#log-container');
    const lines = Array.from(container.children).map(el => el.textContent);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('#btn-copy-log');
      btn.textContent = '✅ コピー済み';
      setTimeout(() => { btn.textContent = '📋 コピー'; }, 2000);
    } catch {
      // フォールバック: 手動選択
      const range = document.createRange();
      range.selectNodeContents(container);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });

  // ========== Auto Update ==========
  window.connector.onUpdateAvailable((version) => {
    const bar = $('#update-bar');
    const msg = $('#update-msg');
    const btn = $('#btn-update');
    bar.classList.remove('hidden');
    bar.className = 'update-bar downloading';
    msg.textContent = `v${version} を自動ダウンロード中...`;
    btn.textContent = 'ダウンロード中';
    btn.disabled = true;
    btn.onclick = () => {};
  });

  window.connector.onUpdateProgress((percent) => {
    const msg = $('#update-msg');
    msg.textContent = `ダウンロード中... ${percent}%`;
  });

  window.connector.onUpdateDownloaded((info = {}) => {
    const bar = $('#update-bar');
    const msg = $('#update-msg');
    const btn = $('#btn-update');
    bar.className = 'update-bar ready';
    msg.textContent = `アップデート準備完了。${info.idleMinutes || 30}分アイドル後に自動適用します`;
    btn.textContent = '今すぐ再起動';
    btn.disabled = false;
    btn.onclick = () => {
      window.connector.installUpdate();
    };
  });
})();

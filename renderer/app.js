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

  // ===== エンジン/定跡登録簿（v6.4.0〜/v6.5.0〜）の編集状態 =====
  // 「設定を保存」までのローカル編集ドラフト。保存時に engines/books + default*Uri と
  // 使用中エンジン・定跡のミラー(フラット項目)を main へ渡す。
  // ※起動直後の showMain() から使うため、宣言は起動分岐より前に置くこと(TDZ回避)
  let draftEngines = {};
  let selectedUri = '';
  let draftBooks = {};
  let selectedBookUri = '';
  let activeConfig = null;
  const DEFAULT_ENGINE_OPTIONS = { Threads: 4, USI_Hash: 1024, MultiPV: 3, FV_SCALE: 24 };

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
      // 保存時にエンジン登録簿(v2)形式へ移行されるため、正規化済み設定を読み直して表示する
      const savedConfig = (await window.connector.getConfig()) || newConfig;
      showMain(savedConfig); // showMain が自動接続する
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

  function generateUri(kind) {
    // main側 config-schema.js と同形式(le://engine|book/...)。一意性だけが目的
    return `le://${kind}/${Date.now()}/${Math.random().toString(16).slice(2, 10)}`;
  }

  function engineDisplayNameFromPath(p) {
    const base = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    return base.replace(/\.(exe|bat|cmd)$/i, '') || 'エンジン';
  }

  // 定跡の表示名は拡張子込みのファイル名（.db/.ybb の区別が情報になる）
  function bookDisplayNameFromPath(p) {
    return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '定跡';
  }

  // パス末尾の depth+1 セグメントをラベル化（config-schema.js の uniquifyBookNames と同ロジック。
  // user_book1.db 衝突時だけ親フォルダを足して区別する — 保存前のドラフト表示用）
  function bookLabelFromPath(p, depth) {
    const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(Math.max(0, parts.length - 1 - depth)).join('/');
  }

  function uniquifyDraftBookNames() {
    const entries = Object.values(draftBooks);
    for (const e of entries) e.name = bookLabelFromPath(e.path, 0) || '定跡';
    for (let depth = 1; depth <= 4; depth++) {
      const counts = new Map();
      for (const e of entries) counts.set(e.name, (counts.get(e.name) || 0) + 1);
      let changed = false;
      for (const e of entries) {
        if ((counts.get(e.name) || 0) > 1) {
          const next = bookLabelFromPath(e.path, depth);
          if (next && next !== e.name) { e.name = next; changed = true; }
        }
      }
      if (!changed) break;
    }
  }

  function populateSettings(cfg) {
    // APIキーは表示しない(書き込み専用)。貼り付けて保存すると置き換わる
    const keyField = $('#cfg-apikey');
    keyField.value = '';
    keyField.placeholder = cfg.apiKeyDecryptFailed
      ? 'キーを復号できませんでした — 再発行したキーを貼り付けてください'
      : (cfg.apiKey ? '設定済み（変更するには新しいキーを貼り付け）' : 'sk_live_...');
    $('#cfg-engine-ondemand').checked = cfg.engineMode === ENGINE_MODE_ON_DEMAND;

    draftEngines = JSON.parse(JSON.stringify(cfg.engines || {}));
    selectedUri = cfg.defaultEngineUri && draftEngines[cfg.defaultEngineUri]
      ? cfg.defaultEngineUri
      : (Object.keys(draftEngines)[0] || '');
    renderEngineSelect();
    loadEngineFields();

    draftBooks = JSON.parse(JSON.stringify(cfg.books || {}));
    selectedBookUri = cfg.defaultBookUri && draftBooks[cfg.defaultBookUri]
      ? cfg.defaultBookUri
      : (Object.keys(draftBooks)[0] || '');
    renderBookSelect();
  }

  function renderBookSelect() {
    const sel = $('#cfg-book-select');
    sel.innerHTML = '';
    uniquifyDraftBookNames();
    const uris = Object.keys(draftBooks);
    if (uris.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未設定';
      sel.appendChild(opt);
      selectedBookUri = '';
    } else {
      for (const [uri, b] of Object.entries(draftBooks)) {
        const opt = document.createElement('option');
        opt.value = uri;
        opt.textContent = b.name || bookDisplayNameFromPath(b.path);
        sel.appendChild(opt);
      }
      if (!selectedBookUri || !draftBooks[selectedBookUri]) {
        selectedBookUri = uris[0];
      }
      sel.value = selectedBookUri;
    }
    const selectedPath = draftBooks[selectedBookUri]?.path || '';
    sel.title = selectedPath || '使用する定跡を選択';
    $('#cfg-book-path').value = selectedPath;
    $('#btn-book-del').disabled = uris.length === 0;
  }

  function renderEngineSelect() {
    const sel = $('#cfg-engine-select');
    sel.innerHTML = '';
    for (const [uri, e] of Object.entries(draftEngines)) {
      const opt = document.createElement('option');
      opt.value = uri;
      opt.textContent = e.name || engineDisplayNameFromPath(e.path);
      sel.appendChild(opt);
    }
    if (selectedUri) sel.value = selectedUri;
    $('#btn-engine-dup').disabled = !selectedUri;
    $('#btn-engine-del').disabled = Object.keys(draftEngines).length <= 1;
  }

  // 選択中エントリの内容を編集欄へ展開する
  function loadEngineFields() {
    const e = draftEngines[selectedUri];
    const opts = e?.options || {};
    $('#cfg-engine-name').value = e?.name || '';
    $('#cfg-engine').value = e?.path || '';
    $('#cfg-eval').value = e?.evalPath || '';
    $('#cfg-threads').value = opts.Threads || DEFAULT_ENGINE_OPTIONS.Threads;
    $('#cfg-hash').value = opts.USI_Hash || DEFAULT_ENGINE_OPTIONS.USI_Hash;
    $('#cfg-multipv').value = opts.MultiPV || DEFAULT_ENGINE_OPTIONS.MultiPV;
    $('#cfg-fvscale').value = opts.FV_SCALE || opts.fv_scale || DEFAULT_ENGINE_OPTIONS.FV_SCALE;
    $('#engine-name').textContent = e ? (e.name || engineDisplayNameFromPath(e.path)) : '—';
    // 評価関数が未設定なら、エンジンから自動検出して初期値として埋める(保存で確定)
    if (e && e.path && !e.evalPath) {
      void autofillEvalFromEngine(e.path, { quiet: true });
    }
  }

  // 編集欄の内容を選択中エントリへ書き戻す
  function stashEngineFields() {
    const e = draftEngines[selectedUri];
    if (!e) return;
    e.name = $('#cfg-engine-name').value.trim() || engineDisplayNameFromPath($('#cfg-engine').value);
    e.path = $('#cfg-engine').value;
    e.evalPath = $('#cfg-eval').value;
    e.options = {
      ...e.options,
      Threads: parseInt($('#cfg-threads').value, 10) || DEFAULT_ENGINE_OPTIONS.Threads,
      USI_Hash: parseInt($('#cfg-hash').value, 10) || DEFAULT_ENGINE_OPTIONS.USI_Hash,
      MultiPV: parseInt($('#cfg-multipv').value, 10) || DEFAULT_ENGINE_OPTIONS.MultiPV,
      FV_SCALE: parseInt($('#cfg-fvscale').value, 10) || DEFAULT_ENGINE_OPTIONS.FV_SCALE,
    };
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
    activeConfig = { ...cfg };

    // ===== エンジン登録簿の操作 =====
    $('#cfg-engine-select').addEventListener('change', (ev) => {
      stashEngineFields(); // 直前まで編集していたエントリの内容を保持
      selectedUri = ev.target.value;
      renderEngineSelect(); // 改名を選択肢ラベルへ反映
      loadEngineFields();
      addLog('エンジンを切り替えるには「設定を保存」を押してください');
    });

    $('#cfg-engine-name').addEventListener('change', () => {
      stashEngineFields();
      renderEngineSelect();
    });

    $('#btn-engine-add').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (!filePath) return;
      stashEngineFields();
      const uri = generateUri('engine');
      draftEngines[uri] = {
        uri,
        name: engineDisplayNameFromPath(filePath),
        path: filePath,
        evalPath: '',
        options: { ...DEFAULT_ENGINE_OPTIONS },
        createdAt: Date.now(),
      };
      selectedUri = uri;
      renderEngineSelect();
      loadEngineFields();
      addLog('エンジンを追加登録しました。「設定を保存」で切り替わります');
    });

    $('#btn-engine-dup').addEventListener('click', () => {
      if (!draftEngines[selectedUri]) return;
      stashEngineFields();
      const src = draftEngines[selectedUri];
      const uri = generateUri('engine');
      draftEngines[uri] = JSON.parse(JSON.stringify({ ...src, uri, name: `${src.name}のコピー`, createdAt: Date.now() }));
      selectedUri = uri;
      renderEngineSelect();
      loadEngineFields();
      addLog('エンジンを複製しました。評価関数やオプションを変えて使い分けできます');
    });

    $('#btn-engine-del').addEventListener('click', () => {
      const e = draftEngines[selectedUri];
      if (!e) return;
      if (Object.keys(draftEngines).length <= 1) {
        addLog('⚠ 最後のエンジンは削除できません');
        return;
      }
      if (!confirm(`「${e.name}」を登録から削除しますか？（ファイル自体は削除されません）`)) return;
      delete draftEngines[selectedUri];
      selectedUri = Object.keys(draftEngines)[0] || '';
      renderEngineSelect();
      loadEngineFields();
      addLog('登録を削除しました。「設定を保存」で確定します');
    });

    // Engine executable select (選択中エントリの実行ファイル変更)
    $('#btn-select-engine').addEventListener('click', async () => {
      const filePath = await window.connector.selectEngineFile();
      if (!filePath) return;
      const nameField = $('#cfg-engine-name');
      const prevAuto = engineDisplayNameFromPath($('#cfg-engine').value);
      // 表示名が自動命名のままなら新しいパスに合わせる（手動の名前は尊重）
      if (!nameField.value.trim() || nameField.value.trim() === prevAuto) {
        nameField.value = engineDisplayNameFromPath(filePath);
      }
      $('#cfg-engine').value = filePath;
      $('#engine-name').textContent = nameField.value || engineDisplayNameFromPath(filePath);
      // エンジンに合わせて評価関数欄も自動更新(変更したい場合は参照から)
      const filled = await autofillEvalFromEngine(filePath);
      if (!filled) {
        $('#cfg-eval').value = '';
      }
      stashEngineFields();
      renderEngineSelect();
    });

    // Eval select
    $('#btn-select-eval').addEventListener('click', async () => {
      const filePath = await window.connector.selectEvalFile();
      if (filePath) {
        $('#cfg-eval').value = filePath;
        addLog('評価関数を選択しました。「設定を保存」でエンジンに反映されます');
      }
    });

    // ===== 定跡登録簿の操作 =====
    $('#cfg-book-select').addEventListener('change', (ev) => {
      if (!ev.target.value) return;
      selectedBookUri = ev.target.value;
      renderBookSelect();
      addLog('定跡を切り替えるには「設定を保存」を押してください');
    });

    $('#btn-book-add').addEventListener('click', async () => {
      const filePath = await window.connector.selectBookFile();
      if (!filePath) return;
      const uri = generateUri('book');
      draftBooks[uri] = { uri, name: bookDisplayNameFromPath(filePath), path: filePath, createdAt: Date.now() };
      selectedBookUri = uri;
      renderBookSelect();
      addLog('定跡を追加登録しました。「設定を保存」で反映されます');
    });

    $('#btn-book-del').addEventListener('click', () => {
      const b = draftBooks[selectedBookUri];
      if (!b) return;
      if (!confirm(`「${b.name}」を登録から削除しますか？（ファイル自体は削除されません）`)) return;
      delete draftBooks[selectedBookUri];
      selectedBookUri = Object.keys(draftBooks)[0] || '';
      renderBookSelect();
      addLog('定跡の登録を削除しました。「設定を保存」で確定します');
    });

    // Save
    $('#btn-save').addEventListener('click', async () => {
      let threads = parseInt($('#cfg-threads').value, 10) || 4;
      let hash = parseInt($('#cfg-hash').value, 10) || 1024;
      if (threads > maxThreads) { threads = maxThreads; $('#cfg-threads').value = threads; addLog(`Threadsを${maxThreads}に制限しました (CPUコア数上限)`); }
      if (hash > maxHashMB) { hash = maxHashMB; $('#cfg-hash').value = hash; addLog(`Hashを${maxHashMB}MBに制限しました (メモリ75%上限)`); }
      // APIキー: 欄に貼り付けがあれば置き換え、空なら現在のキーを維持
      const typedKey = $('#cfg-apikey').value.trim();
      if (typedKey && !/^sk_live_[0-9a-f]{48}$/.test(typedKey)) {
        addLog('⚠ APIキーの形式が正しくありません（sk_live_ で始まる発行済みキーを貼り付けてください）');
        return;
      }
      stashEngineFields();
      const selected = draftEngines[selectedUri];
      const updated = {
        serverUrl: activeConfig?.serverUrl || DEFAULT_SERVER_URL,
        apiKey: typedKey || activeConfig?.apiKey || '',
        // 登録簿(v2)。フラット項目は使用中エンジンのミラー(旧バージョン互換+main側の差分検出用)
        engines: draftEngines,
        defaultEngineUri: selectedUri,
        enginePath: selected?.path || '',
        evalPath: selected?.evalPath || '',
        engineOptions: { ...(selected?.options || {}) },
        books: draftBooks,
        defaultBookUri: selectedBookUri,
        bookPath: draftBooks[selectedBookUri]?.path || '',
        useBook: activeConfig?.useBook === true,
        engineMode: $('#cfg-engine-ondemand').checked ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS,
      };
      const result = await window.connector.saveConfig(updated);
      if (result?.ok) {
        // 正規化済み(表示名の一意化・登録簿の採番済み)の設定を読み直してドラフトを同期
        const fresh = await window.connector.getConfig();
        activeConfig = fresh || updated;
        if (fresh) populateSettings(fresh);
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

// Linea Connector — Renderer (app.js)
(async () => {
  const $ = (sel) => document.querySelector(sel);
  const DEFAULT_SERVER_URL = 'https://api.lineashogi.com';
  const ENGINE_MODE_ALWAYS = 'always';
  const ENGINE_MODE_ON_DEMAND = 'onDemand';
  const config = await window.connector.getConfig();
  const version = await window.connector.getVersion();
  const sysInfo = await window.connector.getSystemInfo();

  // Hash上限をシステム仕様に合わせる(Threads/MultiPV欄はv6.7.0で廃止 — 研究室から変更)
  const maxHashMB = Math.floor(sysInfo.totalMemoryMB * 0.75); // メモリの75%まで
  // 新規登録時の自動既定: UI応答用に2コア残す
  const autoThreads = Math.max(1, (sysInfo.cpuCores || 4) - 2);
  applyHashLimit('wizard-hash');
  applyHashLimit('cfg-hash');

  function applyHashLimit(id) {
    const el = $(`#${id}`);
    if (el) { el.max = maxHashMB; el.title = `最大 ${maxHashMB} MB (搭載メモリの75%)`; }
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
  // ★フォーム編集中フラグ: Webからの config-updated で編集中ドラフトを潰さないためのガード
  let formDirty = false;
  let engineSelectTouched = false; // このセッションでPC側がエンジン選択を触ったか
  let bookSelectTouched = false;   // 同・定跡選択
  let lastStatus = null;
  const DEFAULT_ENGINE_OPTIONS = { Threads: autoThreads, USI_Hash: 1024, MultiPV: 3, FV_SCALE: 24 };

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

    // Step 3: Options（Threads/MultiPVは自動既定 — 研究室から変更できる）
    $('#wizard-back3').addEventListener('click', () => showStep(2));
    $('#wizard-finish').addEventListener('click', async () => {
      const newConfig = {
        serverUrl: DEFAULT_SERVER_URL,
        apiKey: apikeyInput.value.trim(),
        enginePath: engineInput.value,
        engineMode: $('#wizard-engine-ondemand').checked ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS,
        engineOptions: {
          Threads: autoThreads,
          USI_Hash: parseInt($('#wizard-hash').value, 10) || 1024,
          MultiPV: 3,
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
      statusEl.style.color = '#107c10';
    } else {
      statusEl.textContent = '評価関数が見つかりません。エンジンと同じフォルダに配置してください。';
      statusEl.style.color = '#9a6700';
    }
  }

  // ========== Main Screen ==========
  function showMain(cfg) {
    $('#wizard').classList.add('hidden');
    $('#main').classList.remove('hidden');
    $('#version').textContent = `Linea Connector ${version}`;

    populateSettings(cfg);
    setupMainHandlers(cfg);
    renderStatus(lastStatus || { connected: false, engineRunning: false });

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

    formDirty = false;
    engineSelectTouched = false;
    bookSelectTouched = false;
    updateHero(cfg);
  }

  // ===== 状態ストリップ =====

  // 使用中エンジンの表示名だけを出す(USI id name等の詳細は出さない — 本人指定 2026-08-14)
  function updateHero(cfg) {
    const c = cfg || activeConfig;
    if (!c) return;
    const entry = c.engines?.[c.defaultEngineUri];
    $('#st-engine-name').textContent = entry?.name || engineDisplayNameFromPath(c.enginePath) || '—';
  }

  function fmtNps(nps) {
    const n = Number(nps);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(n);
  }

  // 評価値は研究室と同じ先手視点で表示する(USIは手番視点なので後手番なら符号反転)
  function fmtScore(live) {
    if (!live) return '—';
    const flip = live.turn === 'w' || live.turn === 'white';
    if (live.scoreMate !== undefined) {
      const m = Number(live.scoreMate);
      if (!Number.isFinite(m)) return '—';
      if (Math.abs(m) >= 10000) return flip !== (m > 0) ? '詰みあり' : '被詰み';
      const v = flip ? -m : m;
      return `詰み ${v > 0 ? '+' : ''}${v}`;
    }
    if (live.scoreCP !== undefined) {
      const v = Number(live.scoreCP);
      if (!Number.isFinite(v)) return '—';
      const s = flip ? -v : v;
      return `${s > 0 ? '+' : ''}${s}`;
    }
    return '—';
  }

  function fmtRemaining(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return ` · 残り約${Math.max(1, Math.round(seconds))}秒`;
    return ` · 残り約${Math.ceil(seconds / 60)}分`;
  }

  function setChip(text, tone) {
    const chip = $('#state-chip');
    chip.className = `chip${tone ? ` ${tone}` : ''}`;
    $('#state-chip-text').textContent = text;
  }

  function renderStatus(status) {
    lastStatus = status;
    const conn = $('#conn-indicator');
    const connected = !!status.connected;
    conn.className = `conn ${connected ? 'on' : 'off'}`;
    $('#conn-text').textContent = connected ? 'オンライン' : 'オフライン';

    // 待機中は1行のみ。何か起きているときだけ下段(ライブ統計/進捗/再接続)が出現する
    const showLive = connected && status.analyzing;
    const showBatch = connected && !status.analyzing && !!status.batch;
    const showExtra = showLive || showBatch || !connected;
    $('#status-extra').classList.toggle('hidden', !showExtra);
    $('#strip-live').classList.toggle('hidden', !showLive);
    $('#strip-batch').classList.toggle('hidden', !showBatch);
    $('#strip-offline').classList.toggle('hidden', connected);

    if (!connected) {
      setChip('切断', 'red');
      return;
    }

    if (showLive) {
      setChip('解析中', 'amber');
      const live = status.live || {};
      $('#live-nps').textContent = fmtNps(live.nps);
      const d = live.depth !== undefined ? String(live.depth) : '—';
      $('#live-depth').textContent = live.seldepth !== undefined ? `${d}/${live.seldepth}` : d;
      $('#live-score').textContent = fmtScore(status.live);
      return;
    }

    if (showBatch) {
      const b = status.batch;
      setChip(`全解析 ${b.done}/${b.total}`, 'amber');
      const pct = b.total > 0 ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0;
      $('#batch-fill').style.width = `${pct}%`;
      const remain = fmtRemaining((b.total - b.done) * (b.secondsPerMove || 3));
      $('#batch-text').textContent = `${b.done}/${b.total} 局面 · ${b.secondsPerMove || 3}秒/手${remain}`;
      return;
    }

    // 待機系
    const isOnDemandIdle = !status.engineRunning && status.engineMode === ENGINE_MODE_ON_DEMAND;
    setChip(status.engineRunning ? '待機中' : (isOnDemandIdle ? '省メモリ待機' : '停止'), '');
  }

  // ===== 設定フォーム =====

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
    $('#cfg-hash').value = opts.USI_Hash || DEFAULT_ENGINE_OPTIONS.USI_Hash;
    $('#cfg-fvscale').value = opts.FV_SCALE || opts.fv_scale || DEFAULT_ENGINE_OPTIONS.FV_SCALE;
    // 評価関数が未設定なら、エンジンから自動検出して初期値として埋める(保存で確定)
    if (e && e.path && !e.evalPath) {
      void autofillEvalFromEngine(e.path, { quiet: true });
    }
  }

  // 編集欄の内容を選択中エントリへ書き戻す
  // ※Threads/MultiPVの欄は無い — 既存値を温存する(研究室からの変更が正)
  function stashEngineFields() {
    const e = draftEngines[selectedUri];
    if (!e) return;
    e.name = $('#cfg-engine-name').value.trim() || engineDisplayNameFromPath($('#cfg-engine').value);
    e.path = $('#cfg-engine').value;
    e.evalPath = $('#cfg-eval').value;
    e.options = {
      ...e.options,
      USI_Hash: parseInt($('#cfg-hash').value, 10) || DEFAULT_ENGINE_OPTIONS.USI_Hash,
      FV_SCALE: parseInt($('#cfg-fvscale').value, 10) || DEFAULT_ENGINE_OPTIONS.FV_SCALE,
    };
    if (e.options.Threads === undefined) e.options.Threads = DEFAULT_ENGINE_OPTIONS.Threads;
    if (e.options.MultiPV === undefined) e.options.MultiPV = DEFAULT_ENGINE_OPTIONS.MultiPV;
  }

  // ★エンジンに同梱された評価関数を検出して「評価関数」欄へ自動入力する
  async function autofillEvalFromEngine(enginePath, { quiet } = {}) {
    try {
      const result = await window.connector.checkEvalFiles(enginePath);
      if (!result.ok || result.files.length === 0) {
        if (!quiet) addLocalLog('⚠ 評価関数を自動検出できませんでした。「評価関数」の参照から指定できます');
        return false;
      }
      const engineDir = enginePath.split('/').slice(0, -1).join('/');
      const full = `${engineDir}/${result.files[0]}`;
      $('#cfg-eval').value = full;
      if (!quiet) addLocalLog(`評価関数を自動検出 (${result.type}): ${result.files[0]}（変更する場合は参照から）`);
      return true;
    } catch {
      return false;
    }
  }

  function setupMainHandlers(cfg) {
    activeConfig = { ...cfg };

    // ★編集中フラグ: 設定パネルの入力を触ったら立てる(populateでリセット)
    for (const id of ['cfg-engine-name', 'cfg-hash', 'cfg-fvscale', 'cfg-apikey', 'cfg-engine-ondemand']) {
      const el = $(`#${id}`);
      el.addEventListener('input', () => { formDirty = true; });
      el.addEventListener('change', () => { formDirty = true; });
    }

    // ===== エンジン登録簿の操作 =====
    $('#cfg-engine-select').addEventListener('change', (ev) => {
      stashEngineFields(); // 直前まで編集していたエントリの内容を保持
      selectedUri = ev.target.value;
      formDirty = true;
      engineSelectTouched = true;
      renderEngineSelect(); // 改名を選択肢ラベルへ反映
      loadEngineFields();
      addLocalLog('エンジンを切り替えるには「設定を保存」を押してください');
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
      formDirty = true;
      engineSelectTouched = true;
      renderEngineSelect();
      loadEngineFields();
      addLocalLog('エンジンを追加登録しました。「設定を保存」で切り替わります');
    });

    $('#btn-engine-dup').addEventListener('click', () => {
      if (!draftEngines[selectedUri]) return;
      stashEngineFields();
      const src = draftEngines[selectedUri];
      const uri = generateUri('engine');
      draftEngines[uri] = JSON.parse(JSON.stringify({ ...src, uri, name: `${src.name}のコピー`, createdAt: Date.now() }));
      selectedUri = uri;
      formDirty = true;
      engineSelectTouched = true;
      renderEngineSelect();
      loadEngineFields();
      addLocalLog('エンジンを複製しました。評価関数やオプションを変えて使い分けできます');
    });

    $('#btn-engine-del').addEventListener('click', () => {
      const e = draftEngines[selectedUri];
      if (!e) return;
      if (Object.keys(draftEngines).length <= 1) {
        addLocalLog('⚠ 最後のエンジンは削除できません');
        return;
      }
      if (!confirm(`「${e.name}」を登録から削除しますか？（ファイル自体は削除されません）`)) return;
      delete draftEngines[selectedUri];
      selectedUri = Object.keys(draftEngines)[0] || '';
      formDirty = true;
      engineSelectTouched = true;
      renderEngineSelect();
      loadEngineFields();
      addLocalLog('登録を削除しました。「設定を保存」で確定します');
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
      formDirty = true;
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
        formDirty = true;
        addLocalLog('評価関数を選択しました。「設定を保存」でエンジンに反映されます');
      }
    });

    // ===== 定跡登録簿の操作 =====
    $('#cfg-book-select').addEventListener('change', (ev) => {
      if (!ev.target.value) return;
      selectedBookUri = ev.target.value;
      formDirty = true;
      bookSelectTouched = true;
      renderBookSelect();
      addLocalLog('定跡を切り替えるには「設定を保存」を押してください');
    });

    $('#btn-book-add').addEventListener('click', async () => {
      const filePath = await window.connector.selectBookFile();
      if (!filePath) return;
      const uri = generateUri('book');
      draftBooks[uri] = { uri, name: bookDisplayNameFromPath(filePath), path: filePath, createdAt: Date.now() };
      selectedBookUri = uri;
      formDirty = true;
      bookSelectTouched = true;
      renderBookSelect();
      addLocalLog('定跡を追加登録しました。「設定を保存」で反映されます');
    });

    $('#btn-book-del').addEventListener('click', () => {
      const b = draftBooks[selectedBookUri];
      if (!b) return;
      if (!confirm(`「${b.name}」を登録から削除しますか？（ファイル自体は削除されません）`)) return;
      delete draftBooks[selectedBookUri];
      selectedBookUri = Object.keys(draftBooks)[0] || '';
      formDirty = true;
      bookSelectTouched = true;
      renderBookSelect();
      addLocalLog('定跡の登録を削除しました。「設定を保存」で確定します');
    });

    // Save
    $('#btn-save').addEventListener('click', async () => {
      let hash = parseInt($('#cfg-hash').value, 10) || 1024;
      if (hash > maxHashMB) { hash = maxHashMB; $('#cfg-hash').value = hash; addLocalLog(`Hashを${maxHashMB}MBに制限しました (メモリ75%上限)`); }
      // APIキー: 欄に貼り付けがあれば置き換え、空なら現在のキーを維持
      const typedKey = $('#cfg-apikey').value.trim();
      if (typedKey && !/^sk_live_[0-9a-f]{48}$/.test(typedKey)) {
        addLocalLog('⚠ APIキーの形式が正しくありません（sk_live_ で始まる発行済みキーを貼り付けてください）');
        return;
      }
      stashEngineFields();

      // ★Web所有値の統合: フォーム編集中に研究室から変更された値を巻き戻さない。
      //   Threads/MultiPV(エンジン別)と、PC側で触っていないエンジン/定跡選択は最新設定が正
      const fresh = (await window.connector.getConfig()) || activeConfig || {};
      for (const [uri, e] of Object.entries(draftEngines)) {
        const freshOpts = fresh.engines?.[uri]?.options;
        if (freshOpts) {
          if (freshOpts.Threads !== undefined) e.options.Threads = freshOpts.Threads;
          if (freshOpts.MultiPV !== undefined) e.options.MultiPV = freshOpts.MultiPV;
        }
      }
      const effEngineUri = engineSelectTouched
        ? selectedUri
        : (fresh.defaultEngineUri && draftEngines[fresh.defaultEngineUri] ? fresh.defaultEngineUri : selectedUri);
      const effBookUri = bookSelectTouched
        ? selectedBookUri
        : (fresh.defaultBookUri && draftBooks[fresh.defaultBookUri] ? fresh.defaultBookUri : selectedBookUri);

      const selected = draftEngines[effEngineUri];
      const updated = {
        serverUrl: activeConfig?.serverUrl || fresh.serverUrl || DEFAULT_SERVER_URL,
        apiKey: typedKey || fresh.apiKey || activeConfig?.apiKey || '',
        // 登録簿(v2)。フラット項目は使用中エンジンのミラー(旧バージョン互換+main側の差分検出用)
        engines: draftEngines,
        defaultEngineUri: effEngineUri,
        enginePath: selected?.path || '',
        evalPath: selected?.evalPath || '',
        engineOptions: { ...(selected?.options || {}) },
        books: draftBooks,
        defaultBookUri: effBookUri,
        bookPath: draftBooks[effBookUri]?.path || '',
        useBook: fresh.useBook === true, // 定跡の利用ON/OFFは研究室のセレクタが正(PCにトグルは無い)
        engineMode: $('#cfg-engine-ondemand').checked ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS,
      };
      const result = await window.connector.saveConfig(updated);
      if (result?.ok) {
        // 正規化済み(表示名の一意化・登録簿の採番済み)の設定を読み直してドラフトを同期
        const freshAfter = await window.connector.getConfig();
        activeConfig = freshAfter || updated;
        if (freshAfter) populateSettings(freshAfter);
        addLocalLog(result.restartedSocket
          ? '設定を保存し、接続を更新しました'
          : result.restartedEngine
            ? '設定を保存し、エンジンを再起動しました'
            : result.deferredEngineStart
              ? '設定を保存しました（次回解析時に反映）'
              : '設定を保存しました');
      } else {
        addLocalLog('⚠ 設定を保存できませんでした');
      }
    });

    // Reconnect（設定パネルと状態パネルの両方から）
    const reconnect = async () => {
      await window.connector.disconnect();
      const freshConfig = await window.connector.getConfig();
      if (freshConfig) {
        activeConfig = freshConfig;
        populateSettings(freshConfig);
        window.connector.connect(freshConfig);
      }
    };
    $('#btn-reconnect').addEventListener('click', reconnect);
    $('#btn-reconnect-hero').addEventListener('click', reconnect);
  }

  // ========== Status & Config Sync ==========
  window.connector.onStatusUpdate((status) => {
    renderStatus(status);
  });

  // ★Webからの切替(エンジン/定跡/オプション)をフォームへ反映。
  //   編集中(formDirty)はドラフトを潰さず、状態パネルだけ更新(保存時にWeb所有値を統合する)
  window.connector.onConfigUpdated((cfg) => {
    if (!cfg) return;
    activeConfig = cfg;
    if (formDirty) {
      updateHero(cfg);
    } else {
      populateSettings(cfg);
    }
  });

  // ========== ログ（層別: 診断ログは「詳細ログ」トグルで表示） ==========
  const LOG_LIMIT = 300;
  const logEntries = []; // { time, text, kind }
  let verboseLog = false;

  function classifyLog(text) {
    if (text.startsWith('[DIAG]')) return 'diag';
    if (/[⚠❌]|エラー|失敗|できません|見つかりません/.test(text)) return 'warn';
    if (/解析|バッチ|定跡/.test(text)) return 'ana';
    if (/エンジン|評価関数|オプション|準備完了|MultiPV|Threads|Hash/.test(text)) return 'eng';
    if (/接続|切断|Linea Cloud|オンライン|トレイ|アップデート|ダウンロード/.test(text)) return 'conn';
    return 'info';
  }

  const KIND_CLASS = { conn: 'c-conn', eng: 'c-eng', ana: 'c-ana', warn: 'c-warn', diag: '', info: '' };

  function renderLog() {
    const container = $('#log-container');
    const frag = document.createDocumentFragment();
    let diagCount = 0;
    for (const e of logEntries) {
      if (e.kind === 'diag') {
        diagCount++;
        if (!verboseLog) continue;
      }
      const row = document.createElement('div');
      row.className = `fe${e.kind === 'diag' ? ' diag' : ''}`;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = e.time;
      const d = document.createElement('span');
      d.className = `d ${KIND_CLASS[e.kind] || ''}`.trim();
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = e.text;
      row.append(t, d, m);
      frag.appendChild(row);
    }
    if (!verboseLog && diagCount > 0) {
      const row = document.createElement('div');
      row.className = 'fe coalesced';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = '…';
      const d = document.createElement('span');
      d.className = 'd';
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = `診断ログ ${diagCount} 件（詳細ログで表示）`;
      row.append(t, d, m);
      frag.appendChild(row);
    }
    container.replaceChildren(frag);
    container.scrollTop = container.scrollHeight;
  }

  // main からのログ行: "HH:MM:SS  メッセージ"
  window.connector.onLogMessage((entry) => {
    const match = String(entry).match(/^(\S+)\s+([\s\S]*)$/);
    const time = match ? match[1] : '';
    const text = match ? match[2] : String(entry);
    pushLog(time, text);
  });

  function pushLog(time, text) {
    logEntries.push({ time, text, kind: classifyLog(text) });
    while (logEntries.length > LOG_LIMIT) logEntries.shift();
    renderLog();
  }

  // renderer 自身の操作ガイダンス(mainを経由しないログ)
  function addLocalLog(text) {
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    pushLog(time, text);
  }

  $('#btn-verbose-log').addEventListener('click', () => {
    verboseLog = !verboseLog;
    $('#btn-verbose-log').setAttribute('aria-pressed', String(verboseLog));
    renderLog();
  });

  // ★USI通信ログコピー（エンジンとの生のやりとり直近100件）
  $('#btn-copy-usi').addEventListener('click', async () => {
    const btn = $('#btn-copy-usi');
    const text = await window.connector.getUsiHistory();
    if (!text) {
      addLocalLog('USI通信ログはまだありません（エンジン起動後に記録されます）');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ コピー済み';
      setTimeout(() => { btn.textContent = 'USI通信'; }, 2000);
    } catch {
      addLocalLog('USI通信ログのコピーに失敗しました');
    }
  });

  // ★ログコピー（診断ログ含む全件 — サポート用）
  $('#btn-copy-log').addEventListener('click', async () => {
    const text = logEntries.map((e) => `${e.time}  ${e.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('#btn-copy-log');
      btn.textContent = '✅ コピー済み';
      setTimeout(() => { btn.textContent = 'コピー'; }, 2000);
    } catch {
      addLocalLog('ログのコピーに失敗しました');
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

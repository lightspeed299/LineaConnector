// E2E: 実Electronのmainプロセス ⇄ ローカルSocket.IOサーバー ⇄ モックUSIエンジン(.bat経由)
// 通信仕様(イベント名・payload形状)の全経路を検証する。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { Server } = require('socket.io');

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const POS_A = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2';
const POS_B = 'lnsgkgsnl/1r5b1/pppppppp1/8p/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('E2E: request_analysis / batch / set_engine_option / reset_engine の全経路', { timeout: 90000 }, async () => {
  // --- 一時設定ディレクトリ + .bat ラッパー(bat起動経路も同時に検証) ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linea-connector-e2e-'));
  const mockPath = path.join(__dirname, 'mock-usi-engine.js');
  const batPath = path.join(tmp, 'engine.bat');
  fs.writeFileSync(batPath, `@echo off\r\nnode "${mockPath}" %*\r\n`);

  // --- モックサーバー ---
  const httpServer = http.createServer();
  const ioServer = new Server(httpServer);
  const port = await new Promise((res) => httpServer.listen(0, '127.0.0.1', () => res(httpServer.address().port)));

  const events = [];
  function push(name, data) { events.push({ name, data }); }
  function countOf(name, pred = () => true) {
    return events.filter((e) => e.name === name && pred(e)).length;
  }
  function waitEvent(pred, timeoutMs, label) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const hit = events.find(pred);
        if (hit) { clearInterval(timer); resolve(hit); return; }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout: ${label}\n--- events so far ---\n${events.map((e) => e.name).join(', ')}`));
        }
      }, 25);
    });
  }

  let connSocket = null;
  ioServer.on('connection', (s) => {
    if (s.handshake.auth?.type !== 'connector') { s.disconnect(); return; }
    connSocket = s;
    push('connected', s.handshake.auth);
    for (const ev of ['connector_ready', 'connector_analysis_update', 'connector_engine_settings', 'connector:analysis_result']) {
      s.on(ev, (data) => push(ev, data));
    }
  });

  // 定跡フィクスチャ(STARTPOS のみ収録)
  const bookPath = path.join(tmp, 'test-book.db');
  fs.writeFileSync(bookPath, [
    '#YANEURAOU-DB2016 1.00',
    `sfen ${STARTPOS}`,
    '2g2f 3c3d 63 27 935',
    '7g7f none 20 25 600',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    serverUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk_live_' + '0'.repeat(48),
    enginePath: batPath.replace(/\\/g, '/'),
    bookPath: bookPath.replace(/\\/g, '/'),
    useBook: false,
    engineMode: 'always',
    engineOptions: { Threads: 2, MultiPV: 1, USI_Hash: 16 },
  }, null, 2));

  // --- Electron 起動(非表示・自動更新なし・設定は一時ディレクトリ) ---
  const electronPath = require('electron'); // plain node からはバイナリパス文字列が返る
  const appDir = path.join(__dirname, '..');
  const proc = spawn(electronPath, [appDir], {
    env: {
      ...process.env,
      LINEA_CONNECTOR_CONFIG_DIR: tmp,
      LINEA_CONNECTOR_HIDDEN: '1',
      LINEA_CONNECTOR_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mainLog = '';
  proc.stdout.on('data', (d) => { mainLog += d.toString(); });
  proc.stderr.on('data', (d) => { mainLog += d.toString(); });

  try {
    // 接続 + identity
    const conn = await waitEvent((e) => e.name === 'connected', 30000, 'connector connects');
    assert.equal(conn.data.type, 'connector');
    assert.match(String(conn.data.version), /^v\d+\./);
    assert.ok(conn.data.deviceName.length > 0);
    await waitEvent((e) => e.name === 'connector_ready', 5000, 'connector_ready');

    // 対話解析
    connSocket.emit('request_analysis', { sfen: STARTPOS, turn: 'b' });
    const upd = await waitEvent((e) => e.name === 'connector_analysis_update', 20000, 'analysis update');
    assert.equal(upd.data.sfen, STARTPOS);
    assert.equal(upd.data.turn, 'b');
    assert.ok(String(upd.data.info).startsWith('info '), `info行が生で届く: ${upd.data.info}`);
    // v2構造化フィールド(Phase B): 旧クライアント互換のためinfoと並存する
    assert.ok(upd.data.v2, 'v2フィールドが載る');
    assert.equal(typeof upd.data.v2.depth, 'number');
    assert.equal(typeof upd.data.v2.scoreCP, 'number');
    assert.ok(Array.isArray(upd.data.v2.pv) && upd.data.v2.pv.length > 0);
    assert.equal(typeof upd.data.v2.nps, 'number');

    // 対話解析中に届いたバッチは待たされる
    connSocket.emit('connector:analyze_batch', {
      jobId: 'job1',
      positions: [{ sfen: POS_A }, { sfen: POS_B }],
      secondsPerMove: 1,
      doneCount: 0,
      totalCount: 2,
    });
    await sleep(1500);
    assert.equal(countOf('connector:analysis_result'), 0, '対話解析中はバッチ結果が出ない');

    // 停止 → バッチが流れる
    connSocket.emit('stop_analysis', {});
    await waitEvent(() => countOf('connector:analysis_result') >= 2, 25000, '2 batch results');
    const results = events.filter((e) => e.name === 'connector:analysis_result').map((e) => e.data);
    assert.deepEqual(new Set(results.map((r) => r.sfen)), new Set([POS_A, POS_B]));
    for (const r of results) {
      assert.equal(r.jobId, 'job1');
      assert.equal(r.bestMove, '7g7f');
      assert.equal(r.scoreCp, 55);
    }

    // オプション変更 → 設定同期が返る
    connSocket.emit('set_engine_option', { name: 'MultiPV', value: 2 });
    await waitEvent((e) => e.name === 'connector_engine_settings' && e.data?.MultiPV === 2, 10000, 'settings sync MultiPV=2');

    // 再解析 → reset_engine 後も解析が再開される
    connSocket.emit('request_analysis', { sfen: POS_A, turn: 'w' });
    await waitEvent((e) => e.name === 'connector_analysis_update' && e.data.sfen === POS_A, 15000, 'second analysis');
    const before = countOf('connector_analysis_update', (e) => e.data.sfen === POS_A);
    connSocket.emit('reset_engine');
    await waitEvent(
      () => countOf('connector_analysis_update', (e) => e.data.sfen === POS_A) > before + 2,
      15000, 'analysis resumes after reset');

    // --- 定跡フロー ---
    // UseBook ON → 設定同期に定跡状態が載る
    connSocket.emit('set_engine_option', { name: 'UseBook', value: 'true' });
    await waitEvent(
      (e) => e.name === 'connector_engine_settings' && e.data?.UseBook === true && e.data?.bookStatus === 'ok',
      10000, 'UseBook sync with book ok');

    // 定跡ヒット局面 → 候補手がMultiPV行として届く(エンジンではなく定跡から)
    const beforeBook = events.length;
    connSocket.emit('request_analysis', { sfen: STARTPOS, turn: 'b' });
    const bookRow = await waitEvent(
      (e, i) => e.name === 'connector_analysis_update' && e.data?.v2?.book === true,
      10000, 'book move rows');
    assert.equal(bookRow.data.sfen, STARTPOS);
    await waitEvent(
      () => countOf('connector_analysis_update', (e) => e.data?.v2?.book === true) >= 2,
      5000, 'both book rows');
    const bookRows = events.slice(beforeBook)
      .filter((e) => e.name === 'connector_analysis_update' && e.data?.v2?.book === true)
      .map((e) => e.data);
    const row1 = bookRows.find((r) => r.v2.multipv === 1);
    const row2 = bookRows.find((r) => r.v2.multipv === 2);
    assert.deepEqual(row1.v2.pv, ['2g2f', '3c3d']);
    assert.equal(row1.v2.scoreCP, 63);
    assert.equal(row1.v2.bookCount, 935);
    assert.deepEqual(row2.v2.pv, ['7g7f']);
    assert.ok(String(row1.info).includes('score cp 63'), '旧クライアント互換のinfo行');

    // 定跡外の局面 → 通常のエンジン解析に戻る
    const beforeEngine = events.length;
    connSocket.emit('request_analysis', { sfen: POS_B, turn: 'b' });
    const engineRow = await waitEvent(
      (e) => e.name === 'connector_analysis_update' && e.data?.sfen === POS_B && !e.data?.v2?.book,
      15000, 'engine analysis resumes off-book');
    assert.equal(typeof engineRow.data.v2.depth, 'number');
    void beforeEngine;

    // UseBook OFF → 同期が返る
    connSocket.emit('set_engine_option', { name: 'UseBook', value: 'false' });
    await waitEvent(
      (e) => e.name === 'connector_engine_settings' && e.data?.UseBook === false,
      10000, 'UseBook off sync');

    // 最後にもう一度停止(後片付け)
    connSocket.emit('stop_analysis', {});
    await sleep(300);
  } catch (err) {
    err.message += `\n--- electron main log ---\n${mainLog.slice(-4000)}`;
    throw err;
  } finally {
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (_) { /* already dead */ }
    ioServer.close();
    httpServer.close();
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* mock engine may hold files briefly */ }
  }
});

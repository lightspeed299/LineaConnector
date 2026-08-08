'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { UsiEngine, SCORE_MATE_UNKNOWN, STATE } = require('../usi-engine.js');

const MOCK = path.join(__dirname, 'mock-usi-engine.js');

function makeEngine({ behaviors = [], engineOptions = {}, timeouts = {} } = {}) {
  return new UsiEngine({
    cmd: process.execPath,
    args: [MOCK, behaviors.join(',')],
    cwd: __dirname,
    engineOptions,
    timeouts,
    log: () => {},
  });
}

function sent(engine) {
  return engine.history.filter((h) => h.d === '>').map((h) => h.line);
}

function waitFor(cond, timeoutMs = 5000, label = 'condition') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      let v;
      try { v = cond(); } catch (e) { clearInterval(timer); reject(e); return; }
      if (v) { clearInterval(timer); resolve(v); return; }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 10);
  });
}

async function withEngine(opts, fn) {
  const engine = makeEngine(opts);
  try {
    await fn(engine);
  } finally {
    await engine.quit();
  }
}

test('起動ハンドシェイク: 宣言パース・合成・clamp・skip・送信順', async () => {
  await withEngine({
    engineOptions: {
      Threads: 64,          // max 32 に clamp される
      MultiPV: 3,
      fv_scale: 24,         // 大文字小文字無視で FV_SCALE に解決
      Nonexistent: 1,       // 宣言なし → skip
      USI_Hash: 256,        // 合成宣言に対して送信される
      ClearHash: 1,         // button → skip
    },
  }, async (engine) => {
    const res = await engine.launch();
    assert.equal(res.id.name, 'MockEngine');
    assert.equal(res.id.author, 'Linea');
    assert.ok(engine.declaredOptions.Threads);
    assert.ok(engine.declaredOptions.USI_Hash.synthesized);
    assert.ok(engine.declaredOptions.USI_Ponder.synthesized);
    assert.deepEqual(engine.declaredOptions.Style.vars, ['Normal', 'Aggressive']);
    assert.equal(engine.declaredOptions.EvalDir.default, '<empty>');

    const appliedNames = res.report.applied.map((a) => a.name);
    assert.ok(appliedNames.includes('FV_SCALE'), 'fv_scale→FV_SCALE解決');
    assert.ok(appliedNames.includes('USI_Hash'));
    const clampedThreads = res.report.clamped.find((c) => c.name === 'Threads');
    assert.deepEqual({ from: clampedThreads.from, to: clampedThreads.to }, { from: 64, to: 32 });
    const skippedNames = res.report.skipped.map((s) => s.name);
    assert.ok(skippedNames.includes('Nonexistent'));
    assert.ok(skippedNames.includes('ClearHash'));

    // 送信順: usi → setoption* → isready → usinewgame
    const lines = sent(engine);
    assert.equal(lines[0], 'usi');
    const isreadyIdx = lines.indexOf('isready');
    const newgameIdx = lines.indexOf('usinewgame');
    assert.ok(isreadyIdx > 0 && newgameIdx > isreadyIdx, 'usi→isready→usinewgameの順');
    for (const l of lines.slice(1, isreadyIdx)) {
      assert.ok(l.startsWith('setoption name '), `isready前はsetoptionのみ: ${l}`);
    }
    const applied = lines.find((l) => l.startsWith('setoption name Threads'));
    assert.equal(applied, 'setoption name Threads value 32');
  });
});

test('chunked: 分断されたinfo行が壊れず届く', async () => {
  await withEngine({ behaviors: ['chunked'] }, async (engine) => {
    const infos = [];
    engine.onInfo = (x) => infos.push(x);
    await engine.launch();
    engine.analyze('lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1');
    const hit = await waitFor(
      () => infos.find((x) => x.parsed.scoreCP !== undefined && Array.isArray(x.parsed.pv)),
      5000, 'intact info');
    assert.equal(hit.parsed.pv.length, 3);
    assert.ok(hit.parsed.nps === 500000);
    assert.ok(hit.raw.includes('score cp'), '分断が復元されている');
  });
});

test('go予約+暗黙stop: 連続解析要求はstop1回とbestmove後のgoに直列化される', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    engine.analyze('POS_A');
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'first go');
    engine.analyze('POS_B');
    engine.analyze('POS_C'); // 最新が勝つ(B は捨てられる)
    await waitFor(() => sent(engine).filter((l) => l === 'go infinite').length === 2, 5000, 'second go');
    const lines = sent(engine);
    assert.equal(lines.filter((l) => l === 'stop').length, 1, 'stopは1回だけ');
    const positions = lines.filter((l) => l.startsWith('position sfen'));
    assert.deepEqual(positions, ['position sfen POS_A', 'position sfen POS_C']);
    // stop → bestmove を待ってから次の position/go(stop より後に position が来る)
    assert.ok(lines.indexOf('stop') < lines.lastIndexOf('position sfen POS_C'));
  });
});

test('stop: 重複送信されず、予約goも取り消される', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    engine.analyze('POS_A');
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'go');
    engine.stop();
    engine.stop();
    await waitFor(() => engine.state === STATE.READY, 3000, 'ready after stop');
    const lines = sent(engine);
    assert.equal(lines.filter((l) => l === 'stop').length, 1);
    assert.equal(lines.filter((l) => l === 'go infinite').length, 1, '新しいgoは出ない');
  });
});

test('search(movetime): 完走してbestmoveと最終評価を返す', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    const res = await engine.search('POS_A', 150);
    assert.equal(res.status, 'done');
    assert.equal(res.bestmove, '7g7f');
    assert.equal(res.lastParsed.scoreCP, 55);
    assert.deepEqual(res.lastParsed.pv, ['7g7f', '3c3d']);
  });
});

test('preempt: movetime探索中のanalyzeで結果は破棄され、後で対話goが走る', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    const p = engine.search('POS_BATCH', 5000);
    await waitFor(() => sent(engine).some((l) => l.startsWith('go movetime')), 3000, 'movetime go');
    engine.analyze('POS_LIVE');
    const res = await p;
    assert.equal(res.status, 'preempted');
    await waitFor(() => sent(engine).includes('go infinite'), 5000, 'live go after bestmove');
    const lines = sent(engine);
    assert.ok(lines.indexOf('stop') < lines.indexOf('go infinite'));
    assert.ok(lines.includes('position sfen POS_LIVE'));
  });
});

test('score mate +(手数未確定)を±10000で構造化する', async () => {
  await withEngine({ behaviors: ['mate-unknown'] }, async (engine) => {
    const infos = [];
    engine.onInfo = (x) => infos.push(x);
    await engine.launch();
    engine.analyze('POS_A');
    const hit = await waitFor(() => infos.find((x) => x.parsed.scoreMate !== undefined), 5000, 'mate info');
    assert.equal(hit.parsed.scoreMate, SCORE_MATE_UNKNOWN);
  });
});

test('lowerboundフラグが構造化される', async () => {
  await withEngine({ behaviors: ['bounds'] }, async (engine) => {
    const infos = [];
    engine.onInfo = (x) => infos.push(x);
    await engine.launch();
    engine.analyze('POS_A');
    const hit = await waitFor(() => infos.find((x) => x.parsed.lowerbound === true), 5000, 'bound info');
    assert.equal(hit.parsed.scoreCP !== undefined, true);
  });
});

test('探索中のsetOptions: stop→bestmove後にsetoption→isreadyの順で適用される', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    engine.analyze('POS_A');
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'go');
    const res = await engine.setOptions({ MultiPV: 5 });
    assert.equal(res.applied, true);
    const lines = sent(engine);
    const stopIdx = lines.indexOf('stop');
    const setIdx = lines.indexOf('setoption name MultiPV value 5');
    const isreadyIdx = lines.lastIndexOf('isready');
    assert.ok(stopIdx > 0 && setIdx > stopIdx && isreadyIdx > setIdx,
      `順序: stop(${stopIdx}) → setoption(${setIdx}) → isready(${isreadyIdx})`);
    assert.equal(engine.state, STATE.READY);
  });
});

test('newGame: stop→usinewgame→isreadyでハッシュクリアされる', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    engine.analyze('POS_A');
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'go');
    const res = await engine.newGame();
    assert.equal(res.applied, true);
    const lines = sent(engine);
    const stopIdx = lines.indexOf('stop');
    const ngIdx = lines.lastIndexOf('usinewgame');
    const irIdx = lines.lastIndexOf('isready');
    assert.ok(stopIdx > 0 && ngIdx > stopIdx && irIdx > ngIdx);
  });
});

test('usiokタイムアウトでlaunchがrejectされプロセスは破棄される', async () => {
  const engine = makeEngine({ behaviors: ['slow-usiok'], timeouts: { usiokMs: 200 } });
  await assert.rejects(() => engine.launch(), /usiok timeout/);
  await waitFor(() => engine.state === STATE.CLOSED, 8000, 'closed');
});

test('readyokタイムアウトでlaunchがrejectされる', async () => {
  const engine = makeEngine({ behaviors: ['no-readyok'], timeouts: { readyokMs: 200 } });
  await assert.rejects(() => engine.launch(), /readyok timeout/);
  await waitFor(() => engine.state === STATE.CLOSED, 8000, 'closed');
});

test('wedge: stop後にbestmoveが来ないエンジンは段階破棄され通知される', async () => {
  const engine = makeEngine({ behaviors: ['no-bestmove'], timeouts: { stopBestmoveMs: 300 } });
  let closed = null;
  engine.onUnexpectedClose = (x) => { closed = x; };
  await engine.launch();
  engine.analyze('POS_A');
  await waitFor(() => sent(engine).includes('go infinite'), 3000, 'go');
  engine.stop();
  await waitFor(() => closed !== null, 10000, 'unexpected close');
  assert.match(closed.reason, /bestmove timeout/);
  assert.equal(engine.state, STATE.CLOSED);
});

test('探索中クラッシュ: searchはpreemptedになり異常終了が通知される', async () => {
  const engine = makeEngine({ behaviors: ['crash-on-go'] });
  let closed = null;
  engine.onUnexpectedClose = (x) => { closed = x; };
  await engine.launch();
  const res = await engine.search('POS_A', 1000);
  assert.equal(res.status, 'preempted');
  await waitFor(() => closed !== null, 5000, 'close event');
  assert.equal(closed.code, 42);
  await engine.quit();
});

test('quit: 正常終了しstateがCLOSEDになる(冪等)', async () => {
  const engine = makeEngine({});
  await engine.launch();
  await engine.quit();
  assert.equal(engine.state, STATE.CLOSED);
  await engine.quit(); // 2回目も安全
});

test('stderr大量出力でも詰まらない(drain)', async () => {
  await withEngine({ behaviors: ['stderr-spam'] }, async (engine) => {
    await engine.launch();
    const res = await engine.search('POS_A', 100);
    assert.equal(res.status, 'done');
    assert.ok(engine.stderrTail.length > 0);
  });
});

test('未flushの予約search(初期化中)がstopで宙吊りにならずpreempted解決される', async () => {
  await withEngine({ behaviors: ['slow-readyok'] }, async (engine) => {
    await engine.launch(); // launch自体のreadyokも150ms遅い
    const ng = engine.newGame(); // 適用サイクル開始(150msのINITIALIZING窓)
    const p = engine.search('POS_PENDING', 1000); // 予約だけされ、まだflushされない
    engine.stop(); // 予約を取り消す
    const res = await p;
    assert.equal(res.status, 'preempted');
    await ng;
    assert.ok(!sent(engine).some((l) => l.startsWith('go movetime')), 'goは送られない');
  });
});

test('未flushの予約searchがanalyzeの上書きでもpreempted解決される', async () => {
  await withEngine({ behaviors: ['slow-readyok'] }, async (engine) => {
    await engine.launch();
    const ng = engine.newGame();
    const p = engine.search('POS_PENDING', 1000);
    engine.analyze('POS_LIVE'); // 予約を上書き
    const res = await p;
    assert.equal(res.status, 'preempted');
    await ng;
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'live go');
    assert.ok(!sent(engine).some((l) => l.startsWith('go movetime')));
  });
});

test('未知のゴミ行が混ざっても解析は継続する', async () => {
  await withEngine({ behaviors: ['noisy'] }, async (engine) => {
    const infos = [];
    engine.onInfo = (x) => infos.push(x);
    await engine.launch();
    engine.analyze('POS_A');
    await waitFor(() => infos.length >= 8, 5000, 'infos keep flowing');
    assert.ok(infos.every((x) => x.parsed.depth === undefined || x.parsed.depth >= 1));
  });
});

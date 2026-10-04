'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { UsiEngine, SCORE_MATE_UNKNOWN, STATE } = require('../usi-engine.js');
const { clockCommand, matchPosition } = require('../usi-engine.js');

const MOCK = path.join(__dirname, 'mock-usi-engine.js');
const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

test('対局 clock コマンドは秒読み/Fischerを混在させず履歴を送る', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    await engine.search(STARTPOS, { type: 'clock', moves: ['7g7f', '3c3d'],
      clock: { btime: 5000, wtime: 6000, byoyomi: 30000 }, timeoutMs: 1000 });
    assert.ok(sent(engine).includes(`position sfen ${STARTPOS} moves 7g7f 3c3d`));
    assert.ok(sent(engine).includes('go btime 5000 wtime 6000 byoyomi 30000'));
    await engine.search(STARTPOS, { type: 'clock', moves: [],
      clock: { btime: 200, wtime: 400, binc: 0, winc: 0 }, timeoutMs: 1000 });
    assert.ok(sent(engine).includes('go btime 200 wtime 400 binc 0 winc 0'));
    await engine.gameOver('win');
    assert.equal(sent(engine).at(-1), 'gameover win');
  });
});

test('対局パラメータの不正値・USIコマンド注入を拒否', () => {
  assert.equal(clockCommand({ btime: 4_200_000, wtime: 4_000_000, binc: 60_000, winc: 60_000 }),
    'go btime 4200000 wtime 4000000 binc 60000 winc 60000'); // accumulated increments may exceed the initial-time cap
  for (const clock of [{ btime: -1, wtime: 0 }, { btime: NaN, wtime: 0 },
    { btime: 0, wtime: 0, byoyomi: 1, binc: 1, winc: 1 }, { btime: 0, wtime: 0, binc: 1 },
    { btime: 1.2, wtime: 0 }, { btime: 0, wtime: Infinity }]) assert.throws(() => clockCommand(clock));
  assert.throws(() => matchPosition(`${STARTPOS}\nquit`, []));
  assert.throws(() => matchPosition(STARTPOS, ['7g7f\nquit']));
  assert.throws(() => matchPosition(STARTPOS, ['P*0a']));
});

test('対局取消はstop bestmove排出まで待ち、次探索へ誤帰属しない', async () => {
  await withEngine({ behaviors: ['wait-for-stop'] }, async (engine) => {
    await engine.launch();
    const result = engine.search(STARTPOS, { type: 'clock', moves: [],
      clock: { btime: 10000, wtime: 10000, byoyomi: 0 }, timeoutMs: 1000 });
    await engine.stopAndWait();
    assert.equal((await result).status, 'preempted');
    assert.equal(engine.state, STATE.READY);
    const next = await engine.search(STARTPOS, { type: 'movetime', movetimeMs: 50 });
    assert.equal(next.status, 'done');
    await engine.gameOver(null);
    assert.equal(sent(engine).some((line) => line === 'gameover null'), false);
  });
});

test('時計探索はresign/winを失わず返し、期限でstopする', async () => {
  for (const bestmove of ['resign', 'win']) {
    await withEngine({ behaviors: [bestmove] }, async (engine) => {
      await engine.launch();
      const result = await engine.search(STARTPOS, { type: 'clock', moves: [],
        clock: { btime: 0, wtime: 0, byoyomi: 1000 }, timeoutMs: 1000 });
      assert.equal(result.bestmove, bestmove);
    });
  }
  await withEngine({ behaviors: ['wait-for-stop'] }, async (engine) => {
    await engine.launch();
    const result = await engine.search(STARTPOS, { type: 'clock', moves: [],
      clock: { btime: 0, wtime: 0, byoyomi: 100 }, timeoutMs: 100 });
    assert.equal(result.status, 'done');
    assert.ok(sent(engine).includes('stop'));
  });
});

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
    const res = await engine.search('POS_A', { type: 'movetime', movetimeMs: 150 });
    assert.equal(res.status, 'done');
    assert.equal(res.bestmove, '7g7f');
    assert.equal(res.lastParsed.scoreCP, 55);
    assert.deepEqual(res.lastParsed.pv, ['7g7f', '3c3d']);
  });
});

test('preempt: movetime探索中のanalyzeで結果は破棄され、後で対話goが走る', async () => {
  await withEngine({}, async (engine) => {
    await engine.launch();
    const p = engine.search('POS_BATCH', { type: 'movetime', movetimeMs: 5000 });
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
  const res = await engine.search('POS_A', { type: 'movetime', movetimeMs: 1000 });
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
    const res = await engine.search('POS_A', { type: 'movetime', movetimeMs: 100 });
    assert.equal(res.status, 'done');
    assert.ok(engine.stderrTail.length > 0);
  });
});

test('未flushの予約search(初期化中)がstopで宙吊りにならずpreempted解決される', async () => {
  await withEngine({ behaviors: ['slow-readyok'] }, async (engine) => {
    await engine.launch(); // launch自体のreadyokも150ms遅い
    const ng = engine.newGame(); // 適用サイクル開始(150msのINITIALIZING窓)
    const p = engine.search('POS_PENDING', { type: 'movetime', movetimeMs: 1000 }); // 予約だけされ、まだflushされない
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
    const p = engine.search('POS_PENDING', { type: 'movetime', movetimeMs: 1000 });
    engine.analyze('POS_LIVE'); // 予約を上書き
    const res = await p;
    assert.equal(res.status, 'preempted');
    await ng;
    await waitFor(() => sent(engine).includes('go infinite'), 3000, 'live go');
    assert.ok(!sent(engine).some((l) => l.startsWith('go movetime')));
  });
});

test('evalPath: 宣言済みEvalDirへ親ディレクトリが適用される', async () => {
  const engine = makeEngine({});
  engine.evalPath = 'C:/Shogi/Engines/foo/eval/nn.bin';
  try {
    const res = await engine.launch();
    assert.deepEqual(res.report.eval, { applied: { name: 'EvalDir', value: 'C:/Shogi/Engines/foo/eval' } });
    assert.ok(sent(engine).includes('setoption name EvalDir value C:/Shogi/Engines/foo/eval'));
  } finally {
    await engine.quit();
  }
});

test('evalPath: ディレクトリ指定ならそのまま・EvalDir未宣言ならunsupported', async () => {
  const dirEngine = makeEngine({});
  dirEngine.evalPath = 'C:/Shogi/EvalDir';
  try {
    const res = await dirEngine.launch();
    assert.equal(res.report.eval.applied.value, 'C:/Shogi/EvalDir');
  } finally {
    await dirEngine.quit();
  }

  const noEval = makeEngine({ behaviors: ['no-evaldir'] });
  noEval.evalPath = 'C:/Shogi/eval/nn.bin';
  try {
    const res = await noEval.launch();
    assert.deepEqual(res.report.eval, { skippedReason: 'unsupported' });
    assert.ok(!sent(noEval).some((l) => l.startsWith('setoption name EvalDir')));
  } finally {
    await noEval.quit();
  }
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

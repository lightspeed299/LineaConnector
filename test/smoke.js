// 実機エンジンでのスモークテスト(手動実行用・CI対象外)
// 使い方: node test/smoke.js "C:\path\to\engine.exe"
'use strict';

const { UsiEngine } = require('../usi-engine.js');

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const AFTER_76FU = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cmd = process.argv[2];
  if (!cmd) { console.error('usage: node test/smoke.js <engine.exe>'); process.exit(1); }

  const engine = new UsiEngine({
    cmd,
    engineOptions: {
      USI_Hash: 256,
      Threads: 4,
      MultiPV: 3,
      fv_scale: 24,        // 小文字 → 宣言解決の実地確認
      Nonexistent: 1,      // skip されるはず
    },
    log: (m) => console.log(`[log] ${m}`),
  });

  let infoCount = 0;
  let lastMpv1 = null;
  engine.onInfo = ({ parsed }) => {
    infoCount += 1;
    const mpv = parsed.multipv === undefined ? 1 : parsed.multipv;
    if (mpv === 1 && (parsed.scoreCP !== undefined || parsed.scoreMate !== undefined)) lastMpv1 = parsed;
  };
  engine.onUnexpectedClose = (x) => console.log(`[UNEXPECTED CLOSE] ${JSON.stringify(x)}`);

  console.log('--- launch ---');
  const t0 = Date.now();
  const res = await engine.launch();
  console.log(`launched in ${Date.now() - t0}ms: ${res.id.name} / ${res.id.author}`);
  console.log(`declared options: ${Object.keys(engine.declaredOptions).length}`);
  console.log(`applied: ${res.report.applied.map((a) => `${a.name}=${a.value}`).join(', ')}`);
  console.log(`skipped: ${res.report.skipped.map((s) => `${s.name}(${s.reason})`).join(', ')}`);
  console.log(`clamped: ${res.report.clamped.map((c) => `${c.name}:${c.from}→${c.to}`).join(', ') || '(none)'}`);

  console.log('--- analyze 3s (MultiPV=3) ---');
  engine.analyze(STARTPOS);
  await sleep(3000);
  console.log(`infos=${infoCount} lastMpv1=${JSON.stringify(lastMpv1)}`);

  console.log('--- setOptions MultiPV=1 during search ---');
  const t1 = Date.now();
  await engine.setOptions({ MultiPV: 1 });
  console.log(`applied in ${Date.now() - t1}ms (state=${engine.state})`);
  engine.analyze(AFTER_76FU);
  await sleep(1500);
  console.log(`lastMpv1=${JSON.stringify(lastMpv1)}`);

  console.log('--- stop ---');
  engine.stop();
  await sleep(500);
  console.log(`state=${engine.state}`);

  console.log('--- search movetime 1000 ---');
  const t2 = Date.now();
  const r1 = await engine.search(AFTER_76FU, 1000);
  console.log(`search done in ${Date.now() - t2}ms: ${JSON.stringify(r1)}`);

  console.log('--- newGame + search 500 ---');
  await engine.newGame();
  const r2 = await engine.search(STARTPOS, 500);
  console.log(`result: status=${r2.status} bestmove=${r2.bestmove} score=${r2.lastParsed ? r2.lastParsed.scoreCP : '(none)'}`);

  console.log('--- quit ---');
  await engine.quit();
  console.log(`state=${engine.state}`);

  console.log('--- history tail ---');
  const lines = engine.getHistoryText().split('\n');
  console.log(lines.slice(-20).join('\n'));
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });

// テスト用モック USI エンジン。
// 使い方: node mock-usi-engine.js [behavior1,behavior2,...]
// behaviors:
//   chunked      … info 行を stdout.write 2回に分断して書く(行バッファリング検証)
//   bounds       … lowerbound 付き info を混ぜる
//   mate-unknown … score mate + (手数未確定) を混ぜる
//   noisy        … 未知のゴミ行を混ぜる
//   slow-usiok   … usiok を返さない
//   no-readyok   … readyok を返さない
//   slow-readyok … readyok を150ms遅らせる(INITIALIZING窓の検証用)
//   no-bestmove  … stop を無視する(bestmove を返さない)
//   crash-on-go  … go を受けたら exit(42)
//   stderr-spam  … 起動時に stderr へ 256KB 書く(drain 検証)
'use strict';

const readline = require('readline');

const behaviors = new Set((process.argv[2] || '').split(',').filter(Boolean));
const has = (b) => behaviors.has(b);

if (has('stderr-spam')) {
  const junk = 'x'.repeat(1024) + '\n';
  for (let i = 0; i < 256; i++) process.stderr.write(junk);
}

let searching = false;
let infoTimer = null;
let movetimeTimer = null;
let depth = 0;
let tick = 0;

function out(line) {
  process.stdout.write(line + '\n');
}

function emitInfo() {
  depth += 1;
  tick += 1;
  const base = `info depth ${depth} seldepth ${depth + 3} time ${depth * 10} nodes ${depth * 1000} nps 500000 hashfull 100 multipv 1 score cp ${100 + depth} pv 7g7f 3c3d 2g2f`;
  if (has('mate-unknown') && tick % 4 === 0) {
    out(`info depth ${depth} score mate + pv 7g7f`);
    return;
  }
  if (has('bounds') && tick % 3 === 0) {
    out(base.replace(' pv ', ' lowerbound pv '));
    return;
  }
  if (has('noisy') && tick % 5 === 0) {
    out('random junk line that is not usi');
  }
  if (has('chunked')) {
    // "score" の途中でチャンクを切る(素朴な chunk.split('\n') 実装だと必ず壊れる)
    const cut = base.indexOf('sco') + 3;
    process.stdout.write(base.slice(0, cut));
    setTimeout(() => process.stdout.write(base.slice(cut) + '\n'), 3);
    return;
  }
  out(base);
}

function stopSearch(sendBestmove) {
  if (infoTimer) { clearInterval(infoTimer); infoTimer = null; }
  if (movetimeTimer) { clearTimeout(movetimeTimer); movetimeTimer = null; }
  if (searching && sendBestmove) {
    out('bestmove 7g7f ponder 3c3d');
  }
  searching = false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (line === 'usi') {
    out('id name MockEngine');
    out('id author Linea');
    out('option name Threads type spin default 4 min 1 max 32');
    out('option name MultiPV type spin default 1 min 1 max 10');
    out('option name FV_SCALE type spin default 16 min 1 max 128');
    if (!has('no-evaldir')) out('option name EvalDir type string default <empty>');
    out('option name ClearHash type button');
    out('option name Style type combo default Normal var Normal var Aggressive');
    if (!has('slow-usiok')) out('usiok');
    return;
  }
  if (line === 'isready') {
    if (has('no-readyok')) return;
    if (has('slow-readyok')) { setTimeout(() => out('readyok'), 150); return; }
    out('readyok');
    return;
  }
  if (line === 'usinewgame') return;
  if (line.startsWith('setoption')) return;
  if (line.startsWith('position')) return;
  if (line === 'go infinite') {
    if (has('crash-on-go')) process.exit(42);
    searching = true;
    depth = 0;
    infoTimer = setInterval(emitInfo, 10);
    return;
  }
  if (line.startsWith('go movetime')) {
    if (has('crash-on-go')) process.exit(42);
    searching = true;
    const ms = Number(line.split(/\s+/)[2]) || 100;
    movetimeTimer = setTimeout(() => {
      out('info depth 20 seldepth 25 time 100 nodes 12345 nps 400000 multipv 1 score cp 55 pv 7g7f 3c3d');
      out('bestmove 7g7f ponder 3c3d');
      searching = false;
    }, ms);
    return;
  }
  if (line === 'stop') {
    if (has('no-bestmove')) return;
    stopSearch(true);
    return;
  }
  if (line === 'quit') {
    stopSearch(false);
    process.exit(0);
  }
});

rl.on('close', () => process.exit(0));

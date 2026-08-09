'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { YaneBook, normalizeQuerySfen } = require('../book.js');

const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const AFTER_76 = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2';

let tmpDir;
function fixture(name, content) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linea-book-test-'));
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ソート順に注意: "…9/9/2P6/…"(w側) は "…9/9/9/…"(b側) より辞書順で先
const BASIC = [
  '#YANEURAOU-DB2016 1.00',
  `sfen ${AFTER_76.replace(' 2', ' 34')}`, // 手数34で書かれていても正規化キーで引ける
  '3c3d 6g6f -32 none ',
  '8c8d none none none ',
  `sfen ${STARTPOS}`,
  '2g2f 3c3d 63 27 935',
  '#position comment line',
  '7g7f none 20 25 6 #指し手コメント',
  '5g5f none -32 23 3',
  '7i6h none   8', // v1.20.0互換: score/depthが空文字(連続スペース)・count=8
  '',
].join('\n');

test('in-memory: 基本パース(カラム変形・none・空文字・コメント・手数正規化)', async () => {
  const book = await YaneBook.open(fixture('basic.db', BASIC));
  try {
    assert.equal(book.mode, 'in-memory');
    assert.equal(book.entryCount, 2);

    const moves = await book.searchMoves(STARTPOS);
    assert.equal(moves.length, 4);
    assert.deepEqual(moves[0], { usi: '2g2f', usi2: '3c3d', score: 63, depth: 27, count: 935 });
    assert.deepEqual(moves[1], { usi: '7g7f', score: 20, depth: 25, count: 6, comment: '指し手コメント' });
    assert.deepEqual(moves[2], { usi: '5g5f', score: -32, depth: 23, count: 3 });
    // 位置固定カラム: 空文字の score/depth は undefined、5列目が count
    assert.deepEqual(moves[3], { usi: '7i6h', count: 8 });

    // ファイル側が手数34でも、正規化キーで検索できる
    const moves2 = await book.searchMoves(AFTER_76);
    assert.equal(moves2.length, 2);
    assert.deepEqual(moves2[0], { usi: '3c3d', usi2: '6g6f', score: -32 });
    assert.deepEqual(moves2[1], { usi: '8c8d' });

    // クエリ側が手数違いでもヒットする
    const moves3 = await book.searchMoves(AFTER_76.replace(' 2', ' 100'));
    assert.equal(moves3.length, 2);

    // ミス
    assert.deepEqual(await book.searchMoves('9/9/9/9/9/9/9/9/9 b - 1'), []);
  } finally {
    await book.close();
  }
});

test('ヘッダー無し・BOM・CRLF のファイルも読める', async () => {
  const noHeader = '﻿' + [
    `sfen ${STARTPOS}`,
    '2g2f 3c3d 10 5 100',
  ].join('\r\n') + '\r\n';
  const book = await YaneBook.open(fixture('noheader-bom-crlf.db', noHeader));
  try {
    const moves = await book.searchMoves(STARTPOS);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].usi, '2g2f');
  } finally {
    await book.close();
  }
});

function generateSorted(n) {
  const lines = ['#YANEURAOU-DB2016 1.00'];
  for (let i = 0; i < n; i++) {
    const body = `board${String(i).padStart(5, '0')} b - 1`;
    lines.push(`sfen ${body}`);
    lines.push(`7g7f none ${i} 10 ${i * 2}`);
    lines.push(`2g2f none none none `);
  }
  lines.push('');
  return lines.join('\n');
}

test('on-the-fly: 二分探索で先頭/中間/末尾/ミスが正しい + in-memoryと同一結果', async () => {
  const p = fixture('big-sorted.db', generateSorted(300));
  const otf = await YaneBook.open(p, { forceOnTheFly: true });
  const mem = await YaneBook.open(p);
  try {
    assert.equal(otf.mode, 'on-the-fly');
    assert.equal(mem.mode, 'in-memory');
    for (const i of [0, 1, 149, 298, 299]) {
      const sfen = `board${String(i).padStart(5, '0')} b - 1`;
      const a = await otf.searchMoves(sfen);
      const b = await mem.searchMoves(sfen);
      assert.deepEqual(a, b, `entry ${i}`);
      assert.equal(a.length, 2);
      assert.equal(a[0].score, i);
      assert.equal(a[0].count, i * 2);
    }
    // ミス(範囲外・両端の外側)
    assert.deepEqual(await otf.searchMoves('aaaaa b - 1'), []);
    assert.deepEqual(await otf.searchMoves('zzzzz b - 1'), []);
    // 手数付きクエリでもヒット
    assert.equal((await otf.searchMoves('board00100 b - 77')).length, 2);
  } finally {
    await otf.close();
    await mem.close();
  }
});

test('on-the-fly: 未ソートのファイルは明示エラーで拒否される', async () => {
  const unsorted = [
    '#YANEURAOU-DB2016 1.00',
    `sfen ${STARTPOS}`,
    '2g2f none 1 1 1',
    `sfen ${AFTER_76}`, // 辞書順で STARTPOS より前に来るべき行が後にある
    '3c3d none 1 1 1',
    '',
  ].join('\n');
  const p = fixture('unsorted.db', unsorted);
  await assert.rejects(() => YaneBook.open(p, { forceOnTheFly: true }), /ソート/);
  // in-memory なら順序に依存しないので読める
  const mem = await YaneBook.open(p);
  try {
    assert.equal((await mem.searchMoves(AFTER_76)).length, 1);
  } finally {
    await mem.close();
  }
});

test('normalizeQuerySfen: 手数だけを1に固定する', () => {
  assert.equal(normalizeQuerySfen('board b - 42'), 'board b - 1');
  assert.equal(normalizeQuerySfen('board b S2Pn 1'), 'board b S2Pn 1');
  assert.equal(normalizeQuerySfen('board w - '), 'board w - 1');
});

test('後始末', () => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

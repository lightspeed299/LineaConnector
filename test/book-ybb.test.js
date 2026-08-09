'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  sfenToPackedSfen, packedSfenToSfen, packedSfenFromBuffer, packedSfenToBytes, comparePackedSfenBytes,
} = require('../packed-sfen.js');
const { YbbBook, fromYaneMove16, toYaneMove16 } = require('../book-ybb.js');
const { openBook, flippedSFEN, flippedUSIMove, YaneBook } = require('../book.js');

const GOLDEN = path.join(__dirname, 'fixtures', 'yaneuraou-edit.ybb');
const STARTPOS = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const AFTER_76 = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 1';

let tmpDir;
function tmpFile(name, content) {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linea-ybb-test-'));
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---- PackedSfen ----

test('packed-sfen: STARTPOSが256bitに収まり往復一致する', () => {
  const packed = sfenToPackedSfen(STARTPOS);
  assert.equal(packed.length, 8);
  assert.equal(packedSfenToSfen(packed, 1), STARTPOS);
});

test('packed-sfen: 両玉のみの盤(全駒が駒箱)でも厳密256bitで往復する', () => {
  // PackedSfenは「両玉が盤上」を前提に丁度256bitになる(玉が欠けると盤マス書きが増えて溢れる)
  const kingsOnly = '4k4/9/9/9/9/9/9/9/4K4 b - 1';
  assert.equal(packedSfenToSfen(sfenToPackedSfen(kingsOnly), 1), kingsOnly);
  assert.throws(() => sfenToPackedSfen('9/9/9/9/9/9/9/9/9 b - 1'), /overflow/);
});

test('packed-sfen: 不正SFENはthrowする', () => {
  assert.throws(() => sfenToPackedSfen('9/9/9 b - 1'), /9 ranks/);
  assert.throws(() => sfenToPackedSfen('ppppppppp/ppppppppp/ppppppppp/9/9/9/9/9/9 w - 1'), /too many P/);
  assert.throws(() => sfenToPackedSfen(STARTPOS.replace(' b ', ' x ')), /turn/);
});

// ---- やねうら王 Move16 ----

test('move16: USI表現と往復一致する(盤上・成り・打ち)', () => {
  for (const usi of ['7g7f', '3c3d', '2h2b+', '8h2b+', 'P*5e', 'G*4b', 'R*1a', '1a1b']) {
    assert.equal(fromYaneMove16(toYaneMove16(usi)), usi, usi);
  }
});

// ---- golden .ybb (ShogiHome実生成バイナリとの交差検証) ----

test('golden ybb: 全レコードで「私のdecode→encode」が原バイト列と一致する', () => {
  const data = fs.readFileSync(GOLDEN);
  const recordCount = Number(data.readBigUInt64LE(16));
  assert.ok(recordCount > 0);
  for (let i = 0; i < recordCount; i++) {
    const off = 32 + i * 44;
    const packed = packedSfenFromBuffer(data, off);
    const sfen = packedSfenToSfen(packed, 1);
    const reencoded = packedSfenToBytes(sfenToPackedSfen(sfen));
    const original = new Uint8Array(data.buffer, data.byteOffset + off, 32);
    assert.equal(comparePackedSfenBytes(reencoded, original), 0,
      `record ${i}: ${sfen} の再エンコードが原バイト列と一致しない`);
  }
});

test('golden ybb: in-memoryとon-the-flyで全エントリの検索結果が一致する', async () => {
  const mem = await YbbBook.open(GOLDEN);
  const otf = await YbbBook.open(GOLDEN, { forceOnTheFly: true });
  try {
    assert.equal(mem.mode, 'in-memory');
    assert.equal(otf.mode, 'on-the-fly');
    assert.ok(mem.entryCount > 0);
    for (const [sfen, entry] of mem.entries) {
      const a = await otf.searchMoves(sfen);
      assert.deepEqual(a, entry.moves, sfen);
      assert.ok(a.length > 0 || entry.moves.length === 0);
      for (const m of a) {
        assert.match(m.usi, /^(?:[1-9][a-i][1-9][a-i]\+?|[RBGSNLP]\*[1-9][a-i])$/, `USI形式: ${m.usi}`);
        assert.equal(typeof m.score, 'number');
      }
    }
    // ミス
    assert.deepEqual(await otf.searchMoves('9/9/9/9/9/9/9/9/9 b - 1'), []);
  } finally {
    await mem.close();
    await otf.close();
  }
});

test('golden ybb: openBookファサード経由で手数付きクエリでもヒットする', async () => {
  const book = await openBook(GOLDEN);
  try {
    assert.equal(book.format, 'ybb');
    const mem = await YbbBook.open(GOLDEN);
    const anySfen = mem.entries.keys().next().value;
    await mem.close();
    const withPly = anySfen.replace(/ 1$/, ' 42');
    const moves = await book.searchMoves(withPly);
    assert.ok(moves.length > 0, `${withPly} でヒットしない`);
  } finally {
    await book.close();
  }
});

// ---- 合成 .ybb (二分探索の境界) ----

function buildYbb(entries, withDepth) {
  // entries: [{sfen, moves: [{usi, score, depth?}]}]
  const packedList = entries.map((e) => ({
    bytes: packedSfenToBytes(sfenToPackedSfen(e.sfen)),
    moves: e.moves,
    ply: 1,
  }));
  packedList.sort((a, b) => comparePackedSfenBytes(a.bytes, b.bytes));
  const entrySize = withDepth ? 6 : 4;
  const header = Buffer.alloc(32);
  header.write('YANE-BINBOOK-V1\0', 0, 'latin1');
  header.writeBigUInt64LE(BigInt(packedList.length), 16);
  header.writeBigUInt64LE(withDepth ? 1n : 0n, 24);
  const records = [];
  const movesBufs = [];
  let movesOffset = 0;
  for (const item of packedList) {
    const rec = Buffer.alloc(44);
    Buffer.from(item.bytes).copy(rec, 0);
    rec.writeBigUInt64LE(BigInt(movesOffset), 32);
    rec.writeUInt16LE(item.ply, 40);
    rec.writeUInt16LE(item.moves.length, 42);
    records.push(rec);
    const mb = Buffer.alloc(item.moves.length * entrySize);
    item.moves.forEach((m, i) => {
      mb.writeUInt16LE(toYaneMove16(m.usi), i * entrySize);
      mb.writeInt16LE(m.score, i * entrySize + 2);
      if (withDepth) mb.writeUInt16LE(m.depth || 0, i * entrySize + 4);
    });
    movesBufs.push(mb);
    movesOffset += mb.length;
  }
  return Buffer.concat([header, ...records, ...movesBufs]);
}

test('合成ybb: 二分探索が先頭/中間/末尾/ミスで正しい(V0=depthなし)', async () => {
  // 後手玉を1段目の各筋に置いた9局面×両手番=18局面(先手玉は9段目5筋に固定。
  // PackedSfenは両玉盤上が前提。packed順ソートはbuildYbbが行う)
  const simple = [];
  for (let file = 1; file <= 9; file++) {
    for (const turn of ['b', 'w']) {
      const row = [];
      for (let f = 9; f >= 1; f--) row.push(f === file ? 'k' : '1');
      const rank1 = row.join('').replace(/1{2,}/g, (m) => String(m.length));
      const sfen = `${rank1}/9/9/9/9/9/9/9/4K4 ${turn} - 1`;
      simple.push({ sfen, moves: [{ usi: '7g7f', score: file * (turn === 'b' ? 10 : -10) }] });
    }
  }
  const file = tmpFile('synthetic-v0.ybb', buildYbb(simple, false));
  const otf = await YbbBook.open(file, { forceOnTheFly: true });
  const mem = await YbbBook.open(file);
  try {
    for (const e of simple) {
      const a = await otf.searchMoves(e.sfen);
      const b = await mem.searchMoves(e.sfen);
      assert.deepEqual(a, b, e.sfen);
      assert.equal(a.length, 1, e.sfen);
      assert.equal(a[0].usi, '7g7f');
      assert.equal(a[0].depth, undefined, 'V0はdepthなし');
    }
    assert.deepEqual(await otf.searchMoves(STARTPOS), []);
  } finally {
    await otf.close();
    await mem.close();
  }
});

test('合成ybb: 壊れたmagicは明示エラー', async () => {
  const bad = Buffer.from(buildYbb([{ sfen: STARTPOS, moves: [{ usi: '7g7f', score: 1 }] }], true));
  bad.write('XXXX', 0, 'latin1');
  const p = tmpFile('bad-magic.ybb', bad);
  await assert.rejects(() => YbbBook.open(p), /YBB形式ではありません/);
  await assert.rejects(() => YbbBook.open(p, { forceOnTheFly: true }), /YBB形式ではありません/);
});

// ---- FlippedBook ----

test('flippedSFEN: 平手初期局面は盤対称なので手番だけ反転する', () => {
  assert.equal(flippedSFEN(STARTPOS), STARTPOS.replace(' b ', ' w '));
});

test('flippedSFEN: 反転の反転は恒等・持ち駒/成駒も正しく入れ替わる', () => {
  const complex = 'l4kbnl/4g4/2ns1g1pp/p3ppp2/1p1P1P1P1/2r1P1P2/PP1S2N1P/2G1KG3/LN5RL b B2Ps2p 1';
  const flippedOnce = flippedSFEN(complex);
  assert.equal(flippedSFEN(flippedOnce), complex);
  assert.notEqual(flippedOnce, complex);
  // 先手持ち駒 B2Ps2p → 反転後は s2p が大文字化して先頭へ
  assert.ok(flippedOnce.includes(' S2P') && /b2p/.test(flippedOnce), flippedOnce);
  assert.equal(flippedSFEN(AFTER_76) !== AFTER_76, true);
  assert.equal(flippedSFEN(flippedSFEN(AFTER_76)), AFTER_76);
});

test('flippedUSIMove: 既知の対応(7g7f↔3c3d・中央や打ちも)', () => {
  assert.equal(flippedUSIMove('7g7f'), '3c3d');
  assert.equal(flippedUSIMove('3c3d'), '7g7f');
  assert.equal(flippedUSIMove('P*5e'), 'P*5e');
  assert.equal(flippedUSIMove('2b3a+'), '8h7i+');
});

test('FlippedBook: 反転局面しか定跡に無くてもヒットし指し手が反転して返る', async () => {
  // 後手が3四歩と突いた局面(=AFTER_76の反転)だけを収録した .db
  const flippedPos = flippedSFEN(AFTER_76); // 先手番・後手2C歩型
  const db = [
    '#YANEURAOU-DB2016 1.00',
    `sfen ${flippedPos}`,
    '7g7f 8c8d 50 20 100',
    '',
  ].join('\n');
  const p = tmpFile('flip-only.db', db);
  const book = await openBook(p);
  try {
    // 反転局面そのもの → 直接ヒット(指し手は原文のまま)
    const direct = await book.searchMoves(flippedPos);
    assert.equal(direct[0].usi, '7g7f');
    // 元の局面 → flip経由でヒットし、指し手が反転して返る
    const viaFlip = await book.searchMoves(AFTER_76);
    assert.equal(viaFlip.length, 1);
    assert.equal(viaFlip[0].usi, '3c3d');
    assert.equal(viaFlip[0].usi2, '2g2f'); // 8c8d の反転
    assert.equal(viaFlip[0].score, 50);
    assert.equal(viaFlip[0].count, 100);
  } finally {
    await book.close();
  }
});

test('FlippedBook: .ybbでも反転ヒットする', async () => {
  const flippedPos = flippedSFEN(AFTER_76);
  const file = tmpFile('flip-only.ybb', buildYbb([
    { sfen: flippedPos, moves: [{ usi: '7g7f', score: 33, depth: 12 }] },
  ], true));
  const book = await openBook(file, { forceOnTheFly: true });
  try {
    const viaFlip = await book.searchMoves(AFTER_76);
    assert.equal(viaFlip.length, 1);
    assert.equal(viaFlip[0].usi, '3c3d');
    assert.equal(viaFlip[0].score, 33);
    assert.equal(viaFlip[0].depth, 12);
  } finally {
    await book.close();
  }
});

test('後始末', () => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// YaneBook を明示importしているのは既存 .db 経路が facade からも壊れていないことの確認用
void YaneBook;

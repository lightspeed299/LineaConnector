// Linea Connector — やねうら王定跡 (.db / yane2016 テキスト形式) リーダー
//
// 実装の出典: docs/research/shogihome.md 第1章
// (ShogiHome src/background/book/yaneuraou.ts の読み取り系を移植。編集・保存は持たない)
//
// 保証すること:
//  - SFEN 正規化(手数→1)を API 境界で一元化。ファイル内の手数付き SFEN・クエリの手数付き
//    SFEN のどちらでもヒットする(手数は minPly として保持)
//  - 「読みは寛容」: ヘッダー無し / BOM / CRLF / `none`・空文字カラム / 未知行コメント扱い
//  - ファイルサイズ閾値(既定 32MiB)で in-memory / on-the-fly を自動切替。
//    on-the-fly はファイル上の二分探索(常駐メモリほぼゼロ)で、開くときに
//    先頭 10000 局面のソート順を検証する(未ソートは静かに誤動作せず明示エラー)
'use strict';

const fs = require('fs');
const readline = require('readline');

const SFEN_MARKER = 'sfen ';
const LF = 0x0a;
const CR = 0x0d;
const DEFAULT_ON_THE_FLY_THRESHOLD_MB = 32;
const SORT_VALIDATION_LINES = 10000;
const MOVE_BLOCK_BUFFER_SIZE = 8 * 1024; // 1局面の指し手ブロック読み取り上限(ShogiHome と同じ)

// 指し手行の判定(ShogiHome yaneuraou.ts:75 と同じ2形式)
const MOVE_LINE_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[RBGSNLP]\*[1-9][a-i])(?:\s|$)/;

/**
 * "sfen " 行を正規化キーと手数に分解する。
 * キーは手数を " 1" に固定した SFEN 本体(盤面/手番/持ち駒)。
 */
function normalizeSfenLine(line) {
  // "sfen " をスキップし、3 フィールド(盤面/手番/持ち駒)の終端を探す
  const begin = SFEN_MARKER.length;
  let end = begin;
  for (let columns = 0; end < line.length; end++) {
    if (line[end] !== ' ') continue;
    columns++;
    if (columns === 3) break;
  }
  return [
    line.slice(begin, end) + ' 1',
    parseInt(line.slice(end + 1), 10) || 0,
  ];
}

/** クエリ SFEN(接頭辞なし)を正規化キーへ。 */
function normalizeQuerySfen(sfen) {
  const [key] = normalizeSfenLine(SFEN_MARKER + String(sfen).trim());
  return key;
}

// 行を { type: 'header'|'comment'|'sfen'|'move', ... } に分類する
function parseLine(line) {
  if (line.startsWith('#') || line.startsWith('//')) {
    // ヘッダー(#YANEURAOU-DB2016 ...)もコメント行の一種として扱う(バージョン差異に寛容)
    const isHeader = line.startsWith('#YANEURAOU-DB2016');
    const comment = line.startsWith('//') ? line.slice(2) : line.slice(1);
    return { type: isHeader ? 'header' : 'comment', comment };
  }
  if (line.startsWith(SFEN_MARKER)) {
    return { type: 'sfen', line };
  }
  if (MOVE_LINE_RE.test(line)) {
    return { type: 'move', move: parseMoveLine(line) };
  }
  // どれにも該当しない行はコメント扱い(ShogiHome と同じ寛容さ)
  return { type: 'comment', comment: line };
}

/**
 * 指し手行 → BookMove。
 * カラムは位置固定 `usi usi2 score depth count` で、省略は `none` または空文字
 * (ShogiHome v1.20.0 が空文字を出力していた互換。連続スペースをまとめてはいけない)。
 * 行末の `#...` / `//...` は指し手コメント。
 */
function parseMoveLine(line) {
  let head = line;
  let comment;
  const hashIdx = line.indexOf(' #');
  const slashIdx = line.indexOf(' //');
  let cIdx = -1;
  if (hashIdx >= 0 && slashIdx >= 0) cIdx = Math.min(hashIdx, slashIdx);
  else if (hashIdx >= 0) cIdx = hashIdx;
  else if (slashIdx >= 0) cIdx = slashIdx;
  if (cIdx >= 0) {
    const raw = line.slice(cIdx + 1).trimEnd();
    comment = raw.startsWith('//') ? raw.slice(2) : raw.slice(1);
    head = line.slice(0, cIdx);
  }

  const cols = head.split(' ');
  const numOrUndef = (v) => {
    if (v === undefined || v === '' || v === 'none') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const move = { usi: cols[0] };
  if (cols[1] !== undefined && cols[1] !== 'none' && cols[1] !== '') move.usi2 = cols[1];
  const score = numOrUndef(cols[2]);
  const depth = numOrUndef(cols[3]);
  const count = numOrUndef(cols[4]);
  if (score !== undefined) move.score = score;
  if (depth !== undefined) move.depth = depth;
  if (count !== undefined) move.count = count;
  if (comment) move.comment = comment;
  return move;
}

// ---- on-the-fly 用の低レベル関数(ShogiHome yaneuraou.ts:298-384 の移植) ----

function checkSfenMarker(offset, buffer) {
  for (let i = 0; i < SFEN_MARKER.length; i++) {
    if (buffer[offset + i] !== SFEN_MARKER.charCodeAt(i)) return false;
  }
  return true;
}

function readLineFromBuffer(buffer, size, offset = 0) {
  let end = offset;
  while (end < size && buffer[end] !== LF && buffer[end] !== CR) end++;
  return buffer.toString('utf-8', offset, end);
}

function findSfenMarker(buffer, size, isFileHead) {
  if (isFileHead) {
    // 通常は先頭にヘッダーがあるが、いきなり sfen が来ても扱えるようにする(BOM も考慮)
    if (checkSfenMarker(0, buffer)) return 0;
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf && checkSfenMarker(3, buffer)) {
      return 3;
    }
  }
  for (let i = 0; i < size - (SFEN_MARKER.length + 1); i++) {
    if ((buffer[i] === LF || buffer[i] === CR) && checkSfenMarker(i + 1, buffer)) {
      return i + 1;
    }
  }
  return -1;
}

async function binarySearch(normalizedSfen, file, size) {
  const bufferSize = 1024;
  const buffer = Buffer.alloc(bufferSize);
  let begin = 0;
  let end = size;
  while (begin < end) {
    const mid = Math.floor((begin + end) / 2);

    // mid 以降で最初の "sfen " 行頭を探す
    let head = mid;
    let sfenOffset = -1;
    while (head < end) {
      const read = await file.read(buffer, 0, bufferSize, head);
      if (read.bytesRead === 0) break;
      const offset = findSfenMarker(buffer, read.bytesRead, head === 0);
      if (offset >= 0) {
        sfenOffset = head + offset;
        break;
      }
      head += bufferSize - (SFEN_MARKER.length + 1);
    }
    if (sfenOffset < 0) return [-1, 0];

    const read = await file.read(buffer, 0, bufferSize, sfenOffset);
    const sfenLine = readLineFromBuffer(buffer, read.bytesRead);
    const [currentSfen, ply] = normalizeSfenLine(sfenLine);
    if (normalizedSfen === currentSfen) {
      return [sfenOffset + sfenLine.length + 1, ply];
    }
    if (normalizedSfen < currentSfen) {
      end = mid;
    } else {
      begin = sfenOffset + sfenLine.length + 1;
    }
  }
  return [-1, 0];
}

/** ソート順の検証(先頭 N 局面のみ・ShogiHome と同じ妥協) */
async function validateOrdering(path) {
  const stream = fs.createReadStream(path, 'utf-8');
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let prev;
    let count = 0;
    for await (const rawLine of reader) {
      const line = count === 0 && rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
      if (!line.startsWith(SFEN_MARKER)) continue;
      if (prev !== undefined && prev >= line) return false;
      prev = line;
      count++;
      if (count >= SORT_VALIDATION_LINES) break;
    }
    return true;
  } finally {
    reader.close();
    stream.destroy();
  }
}

class YaneBook {
  constructor() {
    this.mode = null;          // 'in-memory' | 'on-the-fly'
    this.path = null;
    this.entries = null;       // Map<normalizedSfen, {moves, minPly, comment}> (in-memory)
    this.file = null;          // FileHandle (on-the-fly)
    this.size = 0;
    this.entryCount = 0;       // in-memory のみ正確。on-the-fly は 0
  }

  /**
   * @param {string} path .db ファイル
   * @param {object} [opts]
   * @param {number} [opts.onTheFlyThresholdMB=32] このサイズ超は on-the-fly
   * @param {boolean} [opts.forceOnTheFly=false]
   */
  static async open(path, opts = {}) {
    const thresholdMB = Number.isFinite(opts.onTheFlyThresholdMB)
      ? opts.onTheFlyThresholdMB
      : DEFAULT_ON_THE_FLY_THRESHOLD_MB;
    const stat = await fs.promises.stat(path);
    const book = new YaneBook();
    book.path = path;
    book.size = stat.size;

    if (opts.forceOnTheFly || stat.size > thresholdMB * 1024 * 1024) {
      if (!(await validateOrdering(path))) {
        throw new Error('定跡ファイルが局面順にソートされていません(大容量モード非対応)');
      }
      book.file = await fs.promises.open(path, 'r');
      book.mode = 'on-the-fly';
      return book;
    }

    book.entries = await loadInMemory(path);
    book.entryCount = book.entries.size;
    book.mode = 'in-memory';
    return book;
  }

  /**
   * @param {string} sfen 手数付きでも可(正規化して検索)
   * @returns {Promise<Array<{usi, usi2?, score?, depth?, count?, comment?}>>}
   */
  async searchMoves(sfen) {
    const key = normalizeQuerySfen(sfen);
    if (this.mode === 'in-memory') {
      const entry = this.entries.get(key);
      return entry ? entry.moves.slice() : [];
    }
    if (this.mode === 'on-the-fly') {
      const [offset] = await binarySearch(key, this.file, this.size);
      if (offset < 0) return [];
      const buffer = Buffer.alloc(MOVE_BLOCK_BUFFER_SIZE);
      const read = await this.file.read(buffer, 0, MOVE_BLOCK_BUFFER_SIZE, offset);
      if (read.bytesRead === 0) return [];
      const moves = [];
      let i = 0;
      while (i < read.bytesRead) {
        const line = readLineFromBuffer(buffer, read.bytesRead, i);
        i += line.length + 1;
        if (i > read.bytesRead) break; // バッファ末尾で行が切れている(不完全行は捨てる)
        if (line === '') continue;     // CRLF の残り等
        const parsed = parseLine(line);
        if (parsed.type === 'move') {
          moves.push(parsed.move);
        } else if (parsed.type === 'comment' || parsed.type === 'header') {
          continue;
        } else {
          break; // 次の sfen 行 = このエントリの終わり
        }
      }
      return moves;
    }
    return [];
  }

  async close() {
    if (this.file) {
      try { await this.file.close(); } catch (_) { /* noop */ }
      this.file = null;
    }
    this.entries = null;
    this.mode = null;
  }
}

async function loadInMemory(path) {
  const entries = new Map();
  const stream = fs.createReadStream(path, 'utf-8');
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let current = null;
  let lineNo = 0;
  try {
    for await (const rawLine of reader) {
      const line = lineNo === 0 && rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
      lineNo++;
      if (line === '') continue;
      const parsed = parseLine(line);
      switch (parsed.type) {
        case 'sfen': {
          const [key, ply] = normalizeSfenLine(line);
          const existing = entries.get(key);
          if (existing) {
            // 同一局面の重複エントリ: minPly は小さい方(ShogiHome と同じ)
            existing.minPly = Math.min(existing.minPly, ply);
            current = existing;
          } else {
            current = { moves: [], minPly: ply, comment: '' };
            entries.set(key, current);
          }
          break;
        }
        case 'move':
          if (current) current.moves.push(parsed.move);
          break;
        case 'comment':
          if (current && current.moves.length === 0) {
            current.comment = current.comment ? `${current.comment}\n${parsed.comment}` : parsed.comment;
          }
          break;
        case 'header':
        default:
          break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return entries;
}

// ---- 盤面180°反転 (FlippedBook 相当) ----
// ShogiHome src/common/helpers/sfen.ts の移植。正規化済みSFEN専用。

function flippedSFEN(sfen) {
  const sections = sfen.split(' ');
  // 盤: 逆順に走査しつつ大小反転(+は直前へ付け直す)
  const board = [];
  for (let i = sections[0].length - 1; i >= 0; i--) {
    let c = sections[0][i];
    c = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (i > 0 && sections[0][i - 1] === '+') {
      board.push('+');
      i--;
    }
    board.push(c);
  }
  sections[0] = board.join('');
  // 手番
  sections[1] = sections[1] === 'b' ? 'w' : 'b';
  // 持ち駒: 先手部(大文字列)と後手部(小文字列)を入れ替えて大小反転
  if (sections[2] !== '-') {
    let blackHandLength = sections[2].length;
    for (; blackHandLength >= 1; blackHandLength--) {
      const char = sections[2][blackHandLength - 1];
      if (char !== char.toLowerCase()) break;
    }
    sections[2] =
      sections[2].slice(blackHandLength).toUpperCase() +
      sections[2].slice(0, blackHandLength).toLowerCase();
  }
  return sections.join(' ');
}

const USI_FLIP_MAP = {
  '1': '9', '2': '8', '3': '7', '4': '6', '5': '5', '6': '4', '7': '3', '8': '2', '9': '1',
  a: 'i', b: 'h', c: 'g', d: 'f', e: 'e', f: 'd', g: 'c', h: 'b', i: 'a',
};

function flippedUSIMove(usi) {
  let flipped = '';
  for (let i = 0; i < usi.length; i++) {
    flipped += USI_FLIP_MAP[usi[i]] || usi[i];
  }
  return flipped;
}

// ---- フォーマット統合 + FlippedBook ----

const { YbbBook } = require('./book-ybb');

/**
 * .db / .ybb 共通のファサード。
 * - クエリの SFEN 正規化(手数→1)を一元化
 * - 通常ヒットが無ければ 180°反転局面でも検索し、指し手を反転して返す
 *   (やねうら王 FlippedBook 相当・常時有効)
 */
class Book {
  constructor(impl, format) {
    this.impl = impl;
    this.format = format; // 'db' | 'ybb'
  }
  get mode() { return this.impl.mode; }
  get entryCount() { return this.impl.entryCount; }
  get path() { return this.impl.path; }

  async searchMoves(sfen) {
    const key = normalizeQuerySfen(sfen);
    const direct = await this.impl.searchMoves(key);
    if (direct.length > 0) return direct;

    const flipped = await this.impl.searchMoves(flippedSFEN(key));
    if (flipped.length === 0) return [];
    return flipped.map((m) => {
      const out = { ...m, usi: flippedUSIMove(m.usi) };
      if (m.usi2) out.usi2 = flippedUSIMove(m.usi2);
      return out;
    });
  }

  close() { return this.impl.close(); }
}

/**
 * 拡張子でフォーマットを判別して開く(.ybb はバイナリ、他は yane2016 テキスト)。
 */
async function openBook(path, opts = {}) {
  const isYbb = String(path).toLowerCase().endsWith('.ybb');
  const impl = isYbb ? await YbbBook.open(path, opts) : await YaneBook.open(path, opts);
  return new Book(impl, isYbb ? 'ybb' : 'db');
}

module.exports = {
  YaneBook,
  openBook,
  Book,
  normalizeQuerySfen,
  parseMoveLine,
  flippedSFEN,
  flippedUSIMove,
  DEFAULT_ON_THE_FLY_THRESHOLD_MB,
};

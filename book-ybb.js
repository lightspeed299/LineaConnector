// やねうら王バイナリ定跡DB (.ybb) リーダー。
// ShogiHome src/background/book/ybb.ts の読み取り系の移植(書き出しは持たない)。
// 仕様: shogihome specs/ybb-format.md /
//       https://github.com/yaneurao/YaneuraOu-ScriptCollection (BookMinerCpp 04-ybb.md)
//
// 構造:
//   ヘッダー32B: magic "YANE-BINBOOK-V1\0" + record_count u64LE + flags u64LE
//   レコード44B×N: packed_sfen(32) + moves_offset u64LE + ply u16 + move_count u16
//   moves: move16 u16 + eval int16 [+ depth u16 (flags bit0=1)]
// レコードは packed_sfen のバイト列辞書順ソート済みが前提(二分探索)。
'use strict';

const fs = require('fs');
const {
  sfenToPackedSfen,
  packedSfenToSfen,
  packedSfenFromBuffer,
  packedSfenToBytes,
  comparePackedSfenBytes,
} = require('./packed-sfen');

const MAGIC = 'YANE-BINBOOK-V1\0';
const INDEX_HEADER_SIZE = 32;
const RECORD_SIZE = 44;
const MOVE_ENTRY_SIZE_V0 = 4;
const MOVE_ENTRY_SIZE_V1 = 6;

// --- やねうら王 Move16 ---
// bit0-6: to / bit7-13: from or 打駒種 / bit14: 打 / bit15: 成
const MOVE_DROP = 1 << 14;
const MOVE_PROMOTE = 1 << 15;
const DROP_PIECE_REVERSE = { 1: 'P', 2: 'L', 3: 'N', 4: 'S', 5: 'B', 6: 'R', 7: 'G' };
const DROP_PIECE_MAP = { P: 1, L: 2, N: 3, S: 4, G: 7, B: 5, R: 6 };

function squareFromYane(value) {
  const file = Math.trunc(value / 9) + 1;
  const rank = (value % 9) + 1;
  return String(file) + String.fromCharCode('a'.charCodeAt(0) + rank - 1);
}

function squareToYane(usiSquare) {
  const file = usiSquare.charCodeAt(0) - '1'.charCodeAt(0) + 1;
  const rank = usiSquare.charCodeAt(1) - 'a'.charCodeAt(0) + 1;
  return (file - 1) * 9 + (rank - 1);
}

function fromYaneMove16(value) {
  const to = squareFromYane(value & 0x7f);
  if (value & MOVE_DROP) {
    const pt = (value >> 7) & 0x7f;
    const pieceSfen = DROP_PIECE_REVERSE[pt];
    if (!pieceSfen) throw new Error(`Invalid YaneuraOu Move16 drop piece type: ${pt}`);
    return pieceSfen + '*' + to;
  }
  const from = squareFromYane((value >> 7) & 0x7f);
  const promote = value & MOVE_PROMOTE ? '+' : '';
  return from + to + promote;
}

// テスト・フィクスチャ生成用(読み取り経路では未使用)
function toYaneMove16(usi) {
  const toSq = squareToYane(usi.slice(2, 4));
  if (usi[1] === '*') {
    const pt = DROP_PIECE_MAP[usi[0]];
    if (!pt) throw new Error(`Invalid drop piece: ${usi}`);
    return MOVE_DROP | (pt << 7) | toSq;
  }
  const fromSq = squareToYane(usi.slice(0, 2));
  const promote = usi.length === 5 && usi[4] === '+' ? MOVE_PROMOTE : 0;
  return promote | (fromSq << 7) | toSq;
}

function moveEntrySize(flags) {
  return (flags & 1n) === 1n ? MOVE_ENTRY_SIZE_V1 : MOVE_ENTRY_SIZE_V0;
}

function readMoves(buf, moveCount, entrySize) {
  const moves = [];
  for (let i = 0; i < moveCount; i++) {
    const off = i * entrySize;
    const move16 = buf.readUInt16LE(off);
    const score = buf.readInt16LE(off + 2);
    const depth = entrySize >= MOVE_ENTRY_SIZE_V1 ? buf.readUInt16LE(off + 4) : undefined;
    const move = { usi: fromYaneMove16(move16), score };
    if (depth !== undefined && depth > 0) move.depth = depth;
    moves.push(move);
  }
  return moves;
}

async function readExact(file, buf, offset, length, position) {
  const { bytesRead } = await file.read(buf, offset, length, position);
  if (bytesRead !== length) {
    throw new Error(`YBB read error: expected ${length} bytes at offset ${position}, got ${bytesRead}`);
  }
}

function parseHeader(buf) {
  const magic = buf.toString('latin1', 0, 16);
  if (magic !== MAGIC) {
    throw new Error(`YBB形式ではありません (magic: ${JSON.stringify(magic.replace(/\0/g, ''))})`);
  }
  const recordCount = buf.readBigUInt64LE(16);
  const flags = buf.readBigUInt64LE(24);
  return { recordCount, flags };
}

class YbbBook {
  constructor() {
    this.mode = null;          // 'in-memory' | 'on-the-fly'
    this.path = null;
    this.entries = null;       // Map<sfen(ply1), {moves, minPly}>
    this.file = null;
    this.size = 0;
    this.recordCount = 0n;
    this.flags = 0n;
    this.entryCount = 0;
  }

  static async open(path, opts = {}) {
    const thresholdMB = Number.isFinite(opts.onTheFlyThresholdMB) ? opts.onTheFlyThresholdMB : 32;
    const stat = await fs.promises.stat(path);
    const book = new YbbBook();
    book.path = path;
    book.size = stat.size;

    if (opts.forceOnTheFly || stat.size > thresholdMB * 1024 * 1024) {
      const file = await fs.promises.open(path, 'r');
      try {
        const headerBuf = Buffer.alloc(INDEX_HEADER_SIZE);
        await readExact(file, headerBuf, 0, INDEX_HEADER_SIZE, 0);
        const { recordCount, flags } = parseHeader(headerBuf);
        book.file = file;
        book.recordCount = recordCount;
        book.flags = flags;
        book.mode = 'on-the-fly';
        return book;
      } catch (e) {
        await file.close();
        throw e;
      }
    }

    // in-memory: 全読み(ybbは丸読みも軽い。閾値以下のファイルのみ)
    const data = await fs.promises.readFile(path);
    if (data.length < INDEX_HEADER_SIZE) throw new Error('YBB形式ではありません (ファイルが短すぎます)');
    const { recordCount, flags } = parseHeader(data);
    const entrySize = moveEntrySize(flags);
    const movesAreaStart = INDEX_HEADER_SIZE + Number(recordCount) * RECORD_SIZE;
    const entries = new Map();
    for (let i = 0; i < Number(recordCount); i++) {
      const recOff = INDEX_HEADER_SIZE + i * RECORD_SIZE;
      const packed = packedSfenFromBuffer(data, recOff);
      const movesRelOffset = Number(data.readBigUInt64LE(recOff + 32));
      const ply = data.readUInt16LE(recOff + 40);
      const moveCount = data.readUInt16LE(recOff + 42);
      const sfen = packedSfenToSfen(packed, 1);
      const movesBuf = data.subarray(movesAreaStart + movesRelOffset, movesAreaStart + movesRelOffset + moveCount * entrySize);
      entries.set(sfen, { moves: readMoves(movesBuf, moveCount, entrySize), minPly: ply });
    }
    book.entries = entries;
    book.entryCount = entries.size;
    book.mode = 'in-memory';
    book.recordCount = recordCount;
    book.flags = flags;
    return book;
  }

  /** @param {string} sfen 正規化済み(手数1)の SFEN */
  async searchMoves(sfen) {
    if (this.mode === 'in-memory') {
      // Mapのキーは packedSfenToSfen の正準形。持ち駒表記等のゆれを
      // encode→decode 往復で正準化してから引く
      let key;
      try {
        key = packedSfenToSfen(sfenToPackedSfen(sfen), 1);
      } catch (_) {
        return [];
      }
      const entry = this.entries.get(key);
      return entry ? entry.moves.slice() : [];
    }
    if (this.mode !== 'on-the-fly' || this.recordCount === 0n) return [];

    let targetBytes;
    try {
      targetBytes = packedSfenToBytes(sfenToPackedSfen(sfen));
    } catch (_) {
      return []; // エンコード不能なSFEN(盤面異常等)はミス扱い
    }
    const entrySize = moveEntrySize(this.flags);
    const movesAreaStart = INDEX_HEADER_SIZE + Number(this.recordCount) * RECORD_SIZE;
    const recBuf = Buffer.alloc(RECORD_SIZE);

    let lo = 0n;
    let hi = this.recordCount - 1n;
    while (lo <= hi) {
      const mid = (lo + hi) / 2n;
      const offset = INDEX_HEADER_SIZE + Number(mid) * RECORD_SIZE;
      await readExact(this.file, recBuf, 0, RECORD_SIZE, offset);
      const cmp = comparePackedSfenBytes(new Uint8Array(recBuf.buffer, recBuf.byteOffset, 32), targetBytes);
      if (cmp === 0) {
        const movesRelOffset = Number(recBuf.readBigUInt64LE(32));
        const moveCount = recBuf.readUInt16LE(42);
        if (moveCount === 0) return [];
        const movesBuf = Buffer.alloc(moveCount * entrySize);
        await readExact(this.file, movesBuf, 0, movesBuf.length, movesAreaStart + movesRelOffset);
        return readMoves(movesBuf, moveCount, entrySize);
      } else if (cmp < 0) {
        lo = mid + 1n;
      } else {
        if (mid === 0n) break;
        hi = mid - 1n;
      }
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

module.exports = { YbbBook, fromYaneMove16, toYaneMove16, MAGIC, INDEX_HEADER_SIZE, RECORD_SIZE, moveEntrySize };

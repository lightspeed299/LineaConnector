// PackedSfen (やねうら王の256bit局面表現) のエンコード/デコード。
// ShogiHome src/background/book/packed_sfen.ts の移植(tsshogi非依存・SFEN文字列直処理)。
// 仕様: shogihome specs/packed-sfen-format.md
//  - LSB-first ビットストリーム・厳密256bit(盤ハフマン+手駒+駒箱で常に埋まる)
//  - マス番号はやねうら王式 file-major: (file-1)*9 + (rank-1)
'use strict';

const PIECE_ORDER = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];
const HAND_SFEN_ORDER = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
const BOARD_PIECE_TOTAL = { P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2 };

const BOARD_HUFFMAN = {
  E: { code: 0x00, bits: 1 },
  P: { code: 0x01, bits: 2 },
  L: { code: 0x03, bits: 4 },
  N: { code: 0x0b, bits: 4 },
  S: { code: 0x07, bits: 4 },
  G: { code: 0x0f, bits: 5 },
  B: { code: 0x1f, bits: 6 },
  R: { code: 0x3f, bits: 6 },
};

const PIECEBOX_HUFFMAN = {
  P: { code: 0x02, bits: 2 },
  L: { code: 0x09, bits: 4 },
  N: { code: 0x0d, bits: 4 },
  S: { code: 0x0b, bits: 4 },
  G: { code: 0x1b, bits: 5 },
  B: { code: 0x2f, bits: 6 },
  R: { code: 0x3f, bits: 6 },
};

const BOARD_CHAR_TO_PIECE = { p: 'P', l: 'L', n: 'N', s: 'S', g: 'G', b: 'B', r: 'R', k: 'K' };

// YaneuraOu: index = (file-1)*9 + (rank-1) / tsshogi互換の盤配列: index = (rank-1)*9 + (9-file)
function yaneIndexToTsIndex(yaneIndex) {
  const file = Math.trunc(yaneIndex / 9) + 1;
  const rank = (yaneIndex % 9) + 1;
  return (rank - 1) * 9 + (9 - file);
}

const BOARD_DECODE_TABLE = new Map(
  Object.entries(BOARD_HUFFMAN).map(([piece, h]) => [`${h.bits}:${h.code}`, piece]),
);
const HAND_DECODE_TABLE = new Map(
  PIECE_ORDER.map((piece) => {
    const h = BOARD_HUFFMAN[piece];
    return [`${h.bits - 1}:${h.code >> 1}`, piece];
  }),
);

class BitWriter {
  constructor() {
    this.cursor = 0;
    this.words = new Uint32Array(8);
  }
  writeBits(value, bits) {
    if (bits <= 0) return;
    if (bits > 32 || this.cursor + bits > 256) {
      throw new Error('Packed SFEN overflow: too many bits');
    }
    const masked = bits === 32 ? value >>> 0 : (value & ((1 << bits) - 1)) >>> 0;
    const wordIndex = this.cursor >>> 5;
    const bitOffset = this.cursor & 31;
    this.words[wordIndex] = (this.words[wordIndex] | (masked << bitOffset)) >>> 0;
    const available = 32 - bitOffset;
    if (bits > available) {
      this.words[wordIndex + 1] = (this.words[wordIndex + 1] | (masked >>> available)) >>> 0;
    }
    this.cursor += bits;
  }
  writeBit(value) { this.writeBits(value & 1, 1); }
  get bitLength() { return this.cursor; }
}

class BitReader {
  constructor(words) {
    this.cursor = 0;
    this.words = words;
    this.bitLimit = words.length * 32;
  }
  readBits(bits) {
    if (bits <= 0) return 0;
    if (bits > 32 || this.cursor + bits > this.bitLimit) {
      throw new Error('Packed SFEN underflow: no more bits');
    }
    const wordIndex = this.cursor >>> 5;
    const bitOffset = this.cursor & 31;
    const mask = bits === 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
    let value = (this.words[wordIndex] >>> bitOffset) & mask;
    const available = 32 - bitOffset;
    if (bits > available) {
      const upperMask = ((1 << (bits - available)) - 1) >>> 0;
      value = (value | ((this.words[wordIndex + 1] & upperMask) << available)) >>> 0;
    }
    this.cursor += bits;
    return value;
  }
  readBit() { return this.readBits(1); }
  get bitLength() { return this.cursor; }
}

function createNonKingCountMap() {
  return { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 };
}

function parseBoard(boardPart) {
  const ranks = boardPart.split('/');
  if (ranks.length !== 9) {
    throw new Error(`Invalid SFEN board: expected 9 ranks but got ${ranks.length}`);
  }
  const board = [];
  const kings = { b: 81, w: 81 };
  const boardCounts = createNonKingCountMap();

  for (let rankIndex = 0; rankIndex < ranks.length; rankIndex++) {
    const rank = ranks[rankIndex];
    let fileIndex = 0;
    for (let i = 0; i < rank.length; i++) {
      const ch = rank[i];
      if (ch >= '1' && ch <= '9') {
        const empty = Number(ch);
        for (let j = 0; j < empty; j++) { board.push(undefined); fileIndex++; }
        continue;
      }
      let promoted = false;
      let pieceChar = ch;
      if (ch === '+') {
        i++;
        if (i >= rank.length) throw new Error('Invalid SFEN board: dangling promotion marker');
        promoted = true;
        pieceChar = rank[i];
      }
      const lower = pieceChar.toLowerCase();
      const type = BOARD_CHAR_TO_PIECE[lower];
      if (!type) throw new Error(`Invalid SFEN board piece: ${pieceChar}`);
      const color = pieceChar === lower ? 'w' : 'b';
      if (type === 'K') {
        if (promoted) throw new Error('Invalid SFEN board: king cannot be promoted');
        const tsIndex = rankIndex * 9 + fileIndex;
        if (kings[color] !== 81) throw new Error(`Invalid SFEN board: duplicate ${color} king`);
        // tsIndex → yaneIndex
        const file = 9 - (tsIndex % 9);
        const rnk = Math.trunc(tsIndex / 9) + 1;
        kings[color] = (file - 1) * 9 + (rnk - 1);
      } else {
        if (type === 'G' && promoted) throw new Error('Invalid SFEN board: gold cannot be promoted');
        boardCounts[type]++;
      }
      board.push({ type, color, promoted });
      fileIndex++;
    }
    if (fileIndex !== 9) {
      throw new Error(`Invalid SFEN board rank width at rank ${rankIndex + 1}: ${fileIndex}`);
    }
  }
  if (board.length !== 81) throw new Error(`Invalid SFEN board squares: ${board.length}`);
  return { board, kings, boardCounts };
}

function parseHands(handsPart) {
  const hands = { b: createNonKingCountMap(), w: createNonKingCountMap() };
  if (handsPart === '-') return hands;
  let num = '';
  for (const ch of handsPart) {
    if (ch >= '0' && ch <= '9') { num += ch; continue; }
    const lower = ch.toLowerCase();
    const type = BOARD_CHAR_TO_PIECE[lower];
    if (!type || type === 'K') throw new Error(`Invalid SFEN hand piece: ${ch}`);
    const n = num ? Number(num) : 1;
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid SFEN hand count: ${num}`);
    num = '';
    const color = ch === lower ? 'w' : 'b';
    hands[color][type] += n;
  }
  if (num) throw new Error(`Invalid SFEN hands: dangling number ${num}`);
  return hands;
}

function computePieceBoxCounts(boardCounts, hands) {
  const result = createNonKingCountMap();
  for (const type of PIECE_ORDER) {
    const remaining = BOARD_PIECE_TOTAL[type] - boardCounts[type] - hands.b[type] - hands.w[type];
    if (remaining < 0) throw new Error(`Invalid SFEN: too many ${type} pieces`);
    result[type] = remaining;
  }
  return result;
}

function writeBoardPiece(writer, piece) {
  if (!piece) {
    writer.writeBits(BOARD_HUFFMAN.E.code, BOARD_HUFFMAN.E.bits);
    return;
  }
  if (piece.type === 'K') return;
  const code = BOARD_HUFFMAN[piece.type];
  writer.writeBits(code.code, code.bits);
  if (piece.type !== 'G') writer.writeBit(piece.promoted ? 1 : 0);
  writer.writeBit(piece.color === 'b' ? 0 : 1);
}

function writeHandPiece(writer, type, color) {
  const code = BOARD_HUFFMAN[type];
  writer.writeBits(code.code >> 1, code.bits - 1);
  if (type !== 'G') writer.writeBit(0);
  writer.writeBit(color === 'b' ? 0 : 1);
}

function writePieceBoxPiece(writer, type) {
  const code = PIECEBOX_HUFFMAN[type];
  writer.writeBits(code.code, code.bits);
  if (type !== 'G') writer.writeBit(0);
}

function readBoardPiece(reader) {
  let code = 0;
  for (let bits = 1; bits <= 6; bits++) {
    code |= reader.readBit() << (bits - 1);
    const type = BOARD_DECODE_TABLE.get(`${bits}:${code}`);
    if (!type) continue;
    if (type === 'E') return undefined;
    const promoted = type !== 'G' ? reader.readBit() === 1 : false;
    const color = reader.readBit() === 0 ? 'b' : 'w';
    return { type, color, promoted };
  }
  throw new Error('Invalid packed sfen: cannot decode board piece');
}

function readHandPiece(reader) {
  let code = 0;
  for (let bits = 1; bits <= 6; bits++) {
    code |= reader.readBit() << (bits - 1);
    const type = HAND_DECODE_TABLE.get(`${bits}:${code}`);
    if (!type) continue;
    const promoted = type !== 'G' ? reader.readBit() === 1 : false;
    const color = reader.readBit() === 0 ? 'b' : 'w';
    return { type, color, promoted };
  }
  throw new Error('Invalid packed sfen: cannot decode hand/piece-box piece');
}

function pieceToBoardChar(piece) {
  const ch = piece.color === 'b' ? piece.type : piece.type.toLowerCase();
  return piece.promoted ? `+${ch}` : ch;
}

function boardToSFEN(board) {
  const ranks = [];
  for (let rank = 0; rank < 9; rank++) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 9; file++) {
      const piece = board[rank * 9 + file];
      if (!piece) { empty++; continue; }
      if (empty > 0) { row += String(empty); empty = 0; }
      row += pieceToBoardChar(piece);
    }
    if (empty > 0) row += String(empty);
    ranks.push(row);
  }
  return ranks.join('/');
}

function handsToSFEN(hands) {
  let text = '';
  for (const color of ['b', 'w']) {
    for (const type of HAND_SFEN_ORDER) {
      const count = hands[color][type];
      if (!count) continue;
      if (count > 1) text += String(count);
      text += color === 'b' ? type : type.toLowerCase();
    }
  }
  return text || '-';
}

/** SFEN文字列 → PackedSfen(Uint32Array x8)。手数は無視される。 */
function sfenToPackedSfen(sfen) {
  const [boardPart, turnPart, handsPart] = String(sfen).trim().split(/\s+/, 4);
  if (!boardPart || !turnPart || !handsPart) throw new Error(`Invalid SFEN: ${sfen}`);
  if (turnPart !== 'b' && turnPart !== 'w') throw new Error(`Invalid SFEN turn: ${turnPart}`);

  const { board, kings, boardCounts } = parseBoard(boardPart);
  const hands = parseHands(handsPart);
  const pieceBoxCounts = computePieceBoxCounts(boardCounts, hands);

  const writer = new BitWriter();
  writer.writeBit(turnPart === 'b' ? 0 : 1);
  writer.writeBits(kings.b, 7);
  writer.writeBits(kings.w, 7);

  for (let yane = 0; yane < 81; yane++) {
    const piece = board[yaneIndexToTsIndex(yane)];
    if (piece && piece.type === 'K') continue;
    writeBoardPiece(writer, piece);
  }
  for (const color of ['b', 'w']) {
    for (const type of PIECE_ORDER) {
      for (let i = 0; i < hands[color][type]; i++) writeHandPiece(writer, type, color);
    }
  }
  for (const type of PIECE_ORDER) {
    for (let i = 0; i < pieceBoxCounts[type]; i++) writePieceBoxPiece(writer, type);
  }
  if (writer.bitLength !== 256) {
    throw new Error(`Invalid packed sfen bit length: ${writer.bitLength}`);
  }
  return writer.words;
}

/** PackedSfen → SFEN文字列(手数は引数で与える。PackedSfenは手数を持たない)。 */
function packedSfenToSfen(packedSfen, ply = 1) {
  if (packedSfen.length < 8) {
    throw new Error(`Packed SFEN requires 8 words but got ${packedSfen.length}`);
  }
  const reader = new BitReader(packedSfen.subarray(0, 8));
  const board = Array.from({ length: 81 }, () => undefined);
  const turn = reader.readBit() === 0 ? 'b' : 'w';

  for (const color of ['b', 'w']) {
    const yaneSq = reader.readBits(7);
    if (yaneSq === 81) continue;
    if (yaneSq < 0 || yaneSq >= 81) {
      throw new Error(`Invalid packed sfen: king square out of range (${yaneSq})`);
    }
    const tsSq = yaneIndexToTsIndex(yaneSq);
    if (board[tsSq]) throw new Error(`Invalid packed sfen: duplicated king square (${yaneSq})`);
    board[tsSq] = { type: 'K', color, promoted: false };
  }

  for (let yane = 0; yane < 81; yane++) {
    const tsSq = yaneIndexToTsIndex(yane);
    if (board[tsSq] && board[tsSq].type === 'K') continue;
    board[tsSq] = readBoardPiece(reader);
  }

  const hands = { b: createNonKingCountMap(), w: createNonKingCountMap() };
  while (reader.bitLength < 256) {
    const piece = readHandPiece(reader);
    if (piece.promoted) continue; // 駒箱マーカー(手駒に成駒は無い)
    hands[piece.color][piece.type]++;
  }
  if (reader.bitLength !== 256) {
    throw new Error(`Invalid packed sfen bit length: ${reader.bitLength}`);
  }
  return `${boardToSFEN(board)} ${turn} ${handsToSFEN(hands)} ${ply}`;
}

/** Buffer上のoffsetから32バイトをPackedSfen(Uint32Array x8)として読む。 */
function packedSfenFromBuffer(buf, offset) {
  const words = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    words[i] = buf.readUInt32LE(offset + i * 4);
  }
  return words;
}

/** PackedSfen → 32バイトのUint8Array(比較・書き込み用)。 */
function packedSfenToBytes(words) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const w = words[i];
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

function comparePackedSfenBytes(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

module.exports = {
  sfenToPackedSfen,
  packedSfenToSfen,
  packedSfenFromBuffer,
  packedSfenToBytes,
  comparePackedSfenBytes,
  // SFEN文字列の構造化パーサ/シリアライザ(定跡PV延長の局面適用などに再利用)
  parseBoard,
  parseHands,
  boardToSFEN,
  handsToSFEN,
};

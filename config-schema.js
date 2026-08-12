'use strict';
// Linea Connector — 設定スキーマ（v2: エンジン登録簿）
//
// Electron 非依存。normalizeConfig() が設定の唯一の正規化窓口で、ここで
//   1) 旧形式（単一 enginePath）→ 登録簿形式への移行
//   2) フラット項目（enginePath/evalPath/engineOptions）と登録簿の同期
// を行う。
//
// 設計（docs/research/shogihome.md §3.6 の最小実装 = Phase A）:
// - 登録簿のキーは不透明 URI（ShogiHome の es:// と同型）。パスでは一意化しない。
//   同じ実行ファイルを設定違い（評価関数・オプション）で何本でも登録できることが価値。
// - フラット項目は常に「使用中エンジン（defaultEngineUri）の写し」として保存する。
//   旧バージョンへロールバックしても壊れない（additive スキーマ）ためと、
//   main.js の既存コード（startEngine / hasEngineConfigChanged / set_engine_option）を
//   変えずに済ませるため。
// - フラット項目が使用中エントリとズレていたら「フラット優先」で使用中エントリへ
//   取り込む（旧バージョンで設定変更→再アップデートのケース）。自動で別エントリへ
//   乗り換えたりはしない。呼び出し側は defaultEngineUri を変えるとき、フラット項目も
//   新エンジンの値で渡すこと（renderer は保存時にミラーを組んで送る）。

const crypto = require('crypto');

const DEFAULT_SERVER_URL = 'https://api.lineashogi.com';

function decodeLegacyValue(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}
const LEGACY_PRODUCT_KEY = decodeLegacyValue('c2hvZ2lzdGFjaw==');
const LEGACY_PRODUCT_TITLE = decodeLegacyValue('U2hvZ2lTdGFjaw==');
const LEGACY_SERVER_URLS = new Set([
  `https://${LEGACY_PRODUCT_KEY}-server.onrender.com`,
  `http://${LEGACY_PRODUCT_KEY}-server.onrender.com`,
]);

const ENGINE_MODE_ALWAYS = 'always';
const ENGINE_MODE_ON_DEMAND = 'onDemand';

function getEngineMode(config) {
  return config?.engineMode === ENGINE_MODE_ON_DEMAND ? ENGINE_MODE_ON_DEMAND : ENGINE_MODE_ALWAYS;
}

function normalizeServerUrl(value) {
  const serverUrl = String(value || '').trim().replace(/\/+$/, '');
  if (!serverUrl || LEGACY_SERVER_URLS.has(serverUrl)) {
    return DEFAULT_SERVER_URL;
  }
  return serverUrl;
}

// 旧キー fv_scale(小文字)を FV_SCALE へ移行する。
// USIオプション名は宣言と突き合わせて解決されるため実害は少ないが、表記を正に統一する。
function normalizeEngineOptions(options) {
  const src = { ...(options || {}) };
  if (src.fv_scale !== undefined && src.FV_SCALE === undefined) {
    src.FV_SCALE = src.fv_scale;
  }
  delete src.fv_scale;
  return src;
}

function normalizePathForCompare(value) {
  return String(value || '').replace(/\\/g, '/');
}

function stableEngineOptions(options) {
  return JSON.stringify(
    Object.entries(options || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, String(value)])
  );
}

// 登録簿キー。時刻+乱数の不透明ID（一意性が目的で秘匿性は不要）
function generateUri(kind, now = Date.now()) {
  return `le://${kind}/${now}/${crypto.randomBytes(4).toString('hex')}`;
}

function generateEngineUri(now = Date.now()) {
  return generateUri('engine', now);
}

function generateBookUri(now = Date.now()) {
  return generateUri('book', now);
}

function engineDisplayNameFromPath(enginePath) {
  const base = normalizePathForCompare(enginePath).split('/').filter(Boolean).pop() || '';
  return base.replace(/\.(exe|bat|cmd)$/i, '') || 'エンジン';
}

// 定跡の表示名は拡張子込みのファイル名（.db/.ybb の区別が情報になる）
function bookDisplayNameFromPath(bookPath) {
  return normalizePathForCompare(bookPath).split('/').filter(Boolean).pop() || '定跡';
}

// 登録エントリの型崩れ対策。未知フィールドは温存する（前方互換）
function sanitizeEngineEntry(uri, entry) {
  const src = entry && typeof entry === 'object' ? entry : {};
  const enginePath = String(src.path || '');
  return {
    ...src,
    uri,
    name: String(src.name || '') || engineDisplayNameFromPath(enginePath),
    path: enginePath,
    evalPath: String(src.evalPath || ''),
    options: normalizeEngineOptions(src.options),
    ...(src.defaultName !== undefined ? { defaultName: String(src.defaultName || '') } : {}),
    ...(src.author !== undefined ? { author: String(src.author || '') } : {}),
    ...(typeof src.createdAt === 'number' ? { createdAt: src.createdAt } : {}),
  };
}

function engineFieldsDiffer(entry, flat) {
  return (
    normalizePathForCompare(entry.path) !== normalizePathForCompare(flat.enginePath) ||
    normalizePathForCompare(entry.evalPath) !== normalizePathForCompare(flat.evalPath) ||
    stableEngineOptions(entry.options) !== stableEngineOptions(flat.engineOptions)
  );
}

// 定跡エントリ。プロセス寿命がないためエンジンより薄い（名前はパスから導出）
function sanitizeBookEntry(uri, entry) {
  const src = entry && typeof entry === 'object' ? entry : {};
  const bookPath = String(src.path || '');
  return {
    ...src,
    uri,
    name: bookDisplayNameFromPath(bookPath),
    path: bookPath,
    ...(typeof src.createdAt === 'number' ? { createdAt: src.createdAt } : {}),
  };
}

// パス末尾の depth+1 セグメントをラベル化（depth=0 でファイル名のみ）
function bookLabelFromPath(bookPath, depth) {
  const parts = normalizePathForCompare(bookPath).split('/').filter(Boolean);
  return parts.slice(Math.max(0, parts.length - 1 - depth)).join('/');
}

// 定跡はやねうら王系の慣習でファイル名が衝突しやすい(user_book1.db だらけ)ため、
// 衝突するエントリだけ親フォルダを1段ずつ足して区別できる表示名にする。
// この name がそのまま Web のカタログにも流れる（フルパスは送らない方針の中で、
// 区別に必要な最小限のフォルダ名だけが露出する）
function uniquifyBookNames(books) {
  const entries = Object.values(books);
  for (const e of entries) {
    e.name = bookLabelFromPath(e.path, 0) || '定跡';
  }
  for (let depth = 1; depth <= 4; depth++) {
    const counts = new Map();
    for (const e of entries) counts.set(e.name, (counts.get(e.name) || 0) + 1);
    let changed = false;
    for (const e of entries) {
      if ((counts.get(e.name) || 0) > 1) {
        const next = bookLabelFromPath(e.path, depth);
        if (next && next !== e.name) {
          e.name = next;
          changed = true;
        }
      }
    }
    if (!changed) break; // 同一パスの二重登録などは同名のまま打ち切り
  }
}

function normalizeConfig(config) {
  const base = {
    ...config,
    serverUrl: normalizeServerUrl(config?.serverUrl),
    engineMode: getEngineMode(config),
    engineOptions: normalizeEngineOptions(config?.engineOptions),
    enginePath: String(config?.enginePath || ''),
    evalPath: String(config?.evalPath || ''),
    bookPath: String(config?.bookPath || ''),
    useBook: config?.useBook === true || config?.useBook === 'true',
  };

  // --- エンジン登録簿（v2） ---
  const engines = {};
  if (config?.engines && typeof config.engines === 'object') {
    for (const [uri, entry] of Object.entries(config.engines)) {
      if (typeof uri === 'string' && uri && entry && typeof entry === 'object') {
        engines[uri] = sanitizeEngineEntry(uri, entry);
      }
    }
  }
  let defaultEngineUri =
    typeof config?.defaultEngineUri === 'string' && engines[config.defaultEngineUri]
      ? config.defaultEngineUri
      : Object.keys(engines)[0] || '';

  // 移行: 登録簿が空でフラットにエンジンがあれば 1 件目として合成
  if (!defaultEngineUri && base.enginePath) {
    const uri = generateEngineUri();
    engines[uri] = sanitizeEngineEntry(uri, {
      name: engineDisplayNameFromPath(base.enginePath),
      path: base.enginePath,
      evalPath: base.evalPath,
      options: base.engineOptions,
      createdAt: Date.now(),
    });
    defaultEngineUri = uri;
  }

  // 同期: フラット項目がズレていたらフラット優先で使用中エントリへ取り込む
  const active = engines[defaultEngineUri];
  if (active && base.enginePath && engineFieldsDiffer(active, base)) {
    engines[defaultEngineUri] = sanitizeEngineEntry(defaultEngineUri, {
      ...active,
      path: base.enginePath,
      evalPath: base.evalPath,
      options: base.engineOptions,
    });
  }

  // --- 定跡登録簿（v6.5.0〜）: エンジンと同じ「登録簿+フラットミラー」パターン ---
  const books = {};
  if (config?.books && typeof config.books === 'object') {
    for (const [uri, entry] of Object.entries(config.books)) {
      if (typeof uri === 'string' && uri && entry && typeof entry === 'object') {
        books[uri] = sanitizeBookEntry(uri, entry);
      }
    }
  }
  let defaultBookUri =
    typeof config?.defaultBookUri === 'string' && books[config.defaultBookUri]
      ? config.defaultBookUri
      : Object.keys(books)[0] || '';

  // 移行: 登録簿が空でフラットに定跡パスがあれば 1 件目として合成
  if (!defaultBookUri && base.bookPath) {
    const uri = generateBookUri();
    books[uri] = sanitizeBookEntry(uri, { path: base.bookPath, createdAt: Date.now() });
    defaultBookUri = uri;
  }

  // 同期: フラット bookPath がズレていたらフラット優先で使用中エントリへ取り込む
  const activeBook = books[defaultBookUri];
  if (
    activeBook && base.bookPath &&
    normalizePathForCompare(activeBook.path) !== normalizePathForCompare(base.bookPath)
  ) {
    books[defaultBookUri] = sanitizeBookEntry(defaultBookUri, { ...activeBook, path: base.bookPath });
  }

  // 表示名の一意化（user_book1.db 衝突対策）
  uniquifyBookNames(books);

  // ミラー: フラット項目は常に使用中エンジン/定跡の写し
  const mirrored = engines[defaultEngineUri];
  const mirroredBook = books[defaultBookUri];
  return {
    ...base,
    ...(mirrored
      ? {
          enginePath: mirrored.path,
          evalPath: mirrored.evalPath,
          engineOptions: { ...mirrored.options },
        }
      : {}),
    // 定跡なし(全削除)は bookPath '' で表現される。呼び出し側は defaultBookUri を
    // 変える/空にするとき bookPath も揃えて渡すこと（renderer は保存時にミラーを組む）
    bookPath: mirroredBook ? mirroredBook.path : base.bookPath,
    engines,
    defaultEngineUri,
    books,
    defaultBookUri,
  };
}

module.exports = {
  DEFAULT_SERVER_URL,
  LEGACY_PRODUCT_KEY,
  LEGACY_PRODUCT_TITLE,
  ENGINE_MODE_ALWAYS,
  ENGINE_MODE_ON_DEMAND,
  getEngineMode,
  normalizeServerUrl,
  normalizeEngineOptions,
  normalizePathForCompare,
  stableEngineOptions,
  generateEngineUri,
  generateBookUri,
  engineDisplayNameFromPath,
  bookDisplayNameFromPath,
  sanitizeEngineEntry,
  sanitizeBookEntry,
  normalizeConfig,
};

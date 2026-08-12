'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeConfig,
  generateEngineUri,
  generateBookUri,
  engineDisplayNameFromPath,
  DEFAULT_SERVER_URL,
} = require('../config-schema.js');

const FLAT = {
  serverUrl: 'https://api.lineashogi.com',
  apiKey: 'sk_live_x',
  enginePath: 'C:/engines/suisho5/YaneuraOu.exe',
  evalPath: 'C:/engines/suisho5/nn.bin',
  bookPath: '',
  useBook: false,
  engineMode: 'always',
  engineOptions: { Threads: 4, MultiPV: 3, USI_Hash: 1024, FV_SCALE: 24 },
};

test('移行: 旧形式(単一enginePath)から登録簿1件を合成し、フラットはミラーとして残る', () => {
  const c = normalizeConfig(FLAT);
  assert.equal(Object.keys(c.engines).length, 1);
  const uri = c.defaultEngineUri;
  assert.match(uri, /^le:\/\/engine\/\d+\/[0-9a-f]{8}$/);
  const e = c.engines[uri];
  assert.equal(e.uri, uri);
  assert.equal(e.name, 'YaneuraOu');
  assert.equal(e.path, FLAT.enginePath);
  assert.equal(e.evalPath, FLAT.evalPath);
  assert.deepEqual(e.options, FLAT.engineOptions);
  assert.equal(typeof e.createdAt, 'number');
  // フラット項目は使用中エンジンのミラー(旧バージョンへ戻しても動く)
  assert.equal(c.enginePath, FLAT.enginePath);
  assert.equal(c.evalPath, FLAT.evalPath);
  assert.deepEqual(c.engineOptions, FLAT.engineOptions);
});

test('冪等: 2回目のnormalizeでURIも内容も変わらない', () => {
  const c1 = normalizeConfig(FLAT);
  const c2 = normalizeConfig(c1);
  assert.deepEqual(c2, c1);
});

test('defaultEngineUriが無効(削除済み等)なら先頭エントリへフォールバック', () => {
  const c1 = normalizeConfig(FLAT);
  const c2 = normalizeConfig({ ...c1, defaultEngineUri: 'le://engine/999/deadbeef' });
  assert.equal(c2.defaultEngineUri, c1.defaultEngineUri);
});

test('同期: フラット項目の変更(旧バージョン運用・ブラウザのset_engine_option)は使用中エントリへ取り込む', () => {
  const c1 = normalizeConfig(FLAT);
  const drifted = { ...c1, engineOptions: { ...c1.engineOptions, Threads: 8 } };
  const c2 = normalizeConfig(drifted);
  assert.equal(c2.engines[c2.defaultEngineUri].options.Threads, 8);
  assert.equal(c2.engineOptions.Threads, 8);
  // 勝手に別エントリへ乗り換えたりはしない
  assert.equal(c2.defaultEngineUri, c1.defaultEngineUri);
});

test('切替: defaultEngineUri+ミラーを新エンジンの値で渡すと反映され、旧エントリは無傷', () => {
  const c1 = normalizeConfig(FLAT);
  const uriA = c1.defaultEngineUri;
  const uriB = generateEngineUri();
  const entryB = {
    uri: uriB,
    name: '水匠改',
    path: 'C:/engines/kai/YaneuraOu.exe',
    evalPath: 'C:/eval2/nn.bin',
    options: { Threads: 2, MultiPV: 1 },
  };
  const c2 = normalizeConfig({
    ...c1,
    engines: { ...c1.engines, [uriB]: entryB },
    defaultEngineUri: uriB,
    enginePath: entryB.path,
    evalPath: entryB.evalPath,
    engineOptions: { ...entryB.options },
  });
  assert.equal(c2.defaultEngineUri, uriB);
  assert.equal(c2.enginePath, entryB.path);
  assert.deepEqual(c2.engineOptions, entryB.options);
  assert.equal(c2.engines[uriA].path, FLAT.enginePath);
  assert.deepEqual(c2.engines[uriA].options, FLAT.engineOptions);
});

test('同一exe+評価関数違いの2登録が共存できる(URIで一意・パスでは一意化しない)', () => {
  const uriA = generateEngineUri();
  const uriB = generateEngineUri();
  const shared = 'C:/engines/suisho5/YaneuraOu.exe';
  const c = normalizeConfig({
    ...FLAT,
    engines: {
      [uriA]: { uri: uriA, name: '水匠5', path: shared, evalPath: 'C:/e1/nn.bin', options: { Threads: 4 } },
      [uriB]: { uri: uriB, name: '水匠5(自作評価関数)', path: shared, evalPath: 'C:/e2/nn.bin', options: { Threads: 4 } },
    },
    defaultEngineUri: uriA,
    enginePath: shared,
    evalPath: 'C:/e1/nn.bin',
    engineOptions: { Threads: 4 },
  });
  assert.equal(Object.keys(c.engines).length, 2);
  assert.equal(c.engines[uriA].evalPath, 'C:/e1/nn.bin');
  assert.equal(c.engines[uriB].evalPath, 'C:/e2/nn.bin');
  assert.equal(c.evalPath, 'C:/e1/nn.bin');
});

test('エントリのfv_scale(旧表記)はFV_SCALEへ正規化・未知フィールドは温存', () => {
  const uri = generateEngineUri();
  const c = normalizeConfig({
    ...FLAT,
    engines: {
      [uri]: {
        uri,
        name: 'x',
        path: FLAT.enginePath,
        evalPath: FLAT.evalPath,
        options: { ...FLAT.engineOptions, FV_SCALE: undefined, fv_scale: 20 },
        futureField: 'keep-me',
        defaultName: 'YaneuraOu NNUE 7.63',
        author: 'yaneurao',
      },
    },
    defaultEngineUri: uri,
    engineOptions: { ...FLAT.engineOptions, FV_SCALE: undefined, fv_scale: 20 },
  });
  const e = c.engines[uri];
  assert.equal(e.options.FV_SCALE, 20);
  assert.equal(e.options.fv_scale, undefined);
  assert.equal(e.futureField, 'keep-me');
  assert.equal(e.defaultName, 'YaneuraOu NNUE 7.63');
  assert.equal(e.author, 'yaneurao');
});

test('エンジン未設定の空configでは登録簿も空のまま', () => {
  const c = normalizeConfig({ apiKey: 'sk_live_x' });
  assert.deepEqual(c.engines, {});
  assert.equal(c.defaultEngineUri, '');
  assert.equal(c.enginePath, '');
});

test('レガシーserverUrlはデフォルトへ置換される(回帰)', () => {
  const legacyKey = Buffer.from('c2hvZ2lzdGFjaw==', 'base64').toString('utf8');
  const c = normalizeConfig({ ...FLAT, serverUrl: `https://${legacyKey}-server.onrender.com` });
  assert.equal(c.serverUrl, DEFAULT_SERVER_URL);
});

test('定跡: 旧形式(bookPath)から登録簿1件を合成し、フラットはミラー・冪等', () => {
  const c = normalizeConfig({ ...FLAT, bookPath: 'C:/books/user_book1.db' });
  assert.equal(Object.keys(c.books).length, 1);
  const uri = c.defaultBookUri;
  assert.match(uri, /^le:\/\/book\/\d+\/[0-9a-f]{8}$/);
  assert.equal(c.books[uri].name, 'user_book1.db');
  assert.equal(c.bookPath, 'C:/books/user_book1.db');
  const c2 = normalizeConfig(c);
  assert.deepEqual(c2, c);
});

test('定跡: 切替と全削除(bookPath空)が表現できる', () => {
  const c1 = normalizeConfig({ ...FLAT, bookPath: 'C:/books/a.db' });
  const uriB = generateBookUri();
  const withB = normalizeConfig({
    ...c1,
    books: { ...c1.books, [uriB]: { uri: uriB, path: 'C:/books/b.ybb' } },
    defaultBookUri: uriB,
    bookPath: 'C:/books/b.ybb',
  });
  assert.equal(withB.defaultBookUri, uriB);
  assert.equal(withB.bookPath, 'C:/books/b.ybb');
  assert.equal(withB.books[uriB].name, 'b.ybb');
  assert.equal(withB.books[c1.defaultBookUri].path, 'C:/books/a.db'); // 旧エントリは無傷
  // 全削除: books空+bookPath空なら勝手に復活しない
  const cleared = normalizeConfig({ ...withB, books: {}, defaultBookUri: '', bookPath: '' });
  assert.deepEqual(cleared.books, {});
  assert.equal(cleared.bookPath, '');
  assert.equal(cleared.defaultBookUri, '');
});

test('定跡: 旧バージョンで bookPath だけ変更→使用中エントリへ取り込む(名前も追随)', () => {
  const c1 = normalizeConfig({ ...FLAT, bookPath: 'C:/books/a.db' });
  const drifted = normalizeConfig({ ...c1, bookPath: 'C:/books/new.db' });
  assert.equal(drifted.defaultBookUri, c1.defaultBookUri);
  assert.equal(drifted.books[drifted.defaultBookUri].path, 'C:/books/new.db');
  assert.equal(drifted.books[drifted.defaultBookUri].name, 'new.db');
});

test('定跡: 同名ファイル(user_book1.db)は親フォルダ付きの一意な表示名になる', () => {
  const uriA = generateBookUri();
  const uriB = generateBookUri();
  const uriC = generateBookUri();
  const c = normalizeConfig({
    ...FLAT,
    books: {
      [uriA]: { uri: uriA, path: 'C:/books/petashock/user_book1.db' },
      [uriB]: { uri: uriB, path: 'C:/books/suisho/user_book1.db' },
      [uriC]: { uri: uriC, path: 'C:/books/standard_book.db' },
    },
    defaultBookUri: uriA,
    bookPath: 'C:/books/petashock/user_book1.db',
  });
  assert.equal(c.books[uriA].name, 'petashock/user_book1.db');
  assert.equal(c.books[uriB].name, 'suisho/user_book1.db');
  // 衝突しないものはファイル名のまま
  assert.equal(c.books[uriC].name, 'standard_book.db');
  // 同期(bookFile表示・カタログ)にも一意ラベルが流れる前提の冪等性
  const c2 = normalizeConfig(c);
  assert.deepEqual(c2, c);
});

test('定跡: 親フォルダまで同名なら更に上位のフォルダで区別する', () => {
  const uriA = generateBookUri();
  const uriB = generateBookUri();
  const c = normalizeConfig({
    ...FLAT,
    books: {
      [uriA]: { uri: uriA, path: 'C:/petashock/books/user_book1.db' },
      [uriB]: { uri: uriB, path: 'C:/suisho/books/user_book1.db' },
    },
    defaultBookUri: uriA,
    bookPath: 'C:/petashock/books/user_book1.db',
  });
  assert.equal(c.books[uriA].name, 'petashock/books/user_book1.db');
  assert.equal(c.books[uriB].name, 'suisho/books/user_book1.db');
});

test('generateEngineUri/表示名ヘルパー', () => {
  assert.notEqual(generateEngineUri(), generateEngineUri());
  assert.equal(engineDisplayNameFromPath('C:\\engines\\YaneuraOu_NNUE.exe'), 'YaneuraOu_NNUE');
  assert.equal(engineDisplayNameFromPath('C:/engines/run.bat'), 'run');
  assert.equal(engineDisplayNameFromPath(''), 'エンジン');
});

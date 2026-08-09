const legacyProductKey = Buffer.from('c2hvZ2lzdGFjaw==', 'base64').toString('utf8');

module.exports = {
  npmRebuild: false,
  afterPack: './afterPack.js',
  appId: ['com', legacyProductKey, 'connector'].join('.'),
  productName: 'Linea Connector',
  files: [
    'main.js',
    'usi-engine.js',
    'book.js',
    'book-ybb.js',
    'packed-sfen.js',
    'preload.js',
    'renderer/**/*',
    'assets/**/*',
    'package.json',
  ],
  win: {
    target: ['nsis'],
    icon: 'assets/icon.ico',
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    shortcutName: 'Linea Connector',
    artifactName: 'LineaConnector-Setup.${ext}',
  },
  publish: {
    provider: 'github',
    owner: 'lightspeed299',
    repo: 'LineaConnector',
  },
};

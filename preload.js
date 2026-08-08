// Linea Connector — Preload (Security Bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', {
  // 設定
  getConfig: () => ipcRenderer.invoke('get-config'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // エンジン選択
  selectEngineFile: () => ipcRenderer.invoke('select-engine-file'),
  checkEvalFiles: (enginePath) => ipcRenderer.invoke('check-eval-files', enginePath),

  // 接続制御
  connect: (config) => ipcRenderer.invoke('connect', config),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // USI通信ログ（直近100件）
  getUsiHistory: () => ipcRenderer.invoke('get-usi-history'),

  // 自動アップデート
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),

  // イベント受信（重複登録防止）
  onStatusUpdate: (callback) => {
    ipcRenderer.removeAllListeners('status-update');
    ipcRenderer.on('status-update', (_, data) => callback(data));
  },
  onLogMessage: (callback) => {
    ipcRenderer.removeAllListeners('log-message');
    ipcRenderer.on('log-message', (_, msg) => callback(msg));
  },
  onUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.on('update-available', (_, version) => callback(version));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_, percent) => callback(percent));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.removeAllListeners('update-downloaded');
    ipcRenderer.on('update-downloaded', (_, info) => callback(info));
  },
});

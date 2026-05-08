const { dialog, shell } = require('electron');
const https = require('node:https');

const LATEST_RELEASE_API = 'https://api.github.com/repos/FB208/OpenBidKit_Yibiao/releases/latest';
const LATEST_RELEASE_PAGE = 'https://github.com/FB208/OpenBidKit_Yibiao/releases/latest';

function formatReleaseNotes(releaseNotes) {
  if (!releaseNotes) {
    return '';
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => item?.note || item?.version || '')
      .filter(Boolean)
      .join('\n\n');
  }

  return String(releaseNotes);
}

let autoUpdaterInstance = null;
let shouldOpenDownloadPageForUpdate = false;

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i] : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(LATEST_RELEASE_API, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API 请求失败：${response.statusCode}`));
          return;
        }

        try {
          const release = JSON.parse(data);
          resolve({
            version: release.tag_name?.replace(/^v/, '') || '',
            body: release.body || '',
          });
        } catch {
          reject(new Error('解析 GitHub API 响应失败'));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('请求超时'));
    });
  });
}

async function triggerUpdateDownload({ mainWindow, onProgress, onDownloaded, onError }) {
  if (!autoUpdaterInstance || shouldOpenDownloadPageForUpdate) {
    shell.openExternal(LATEST_RELEASE_PAGE);
    return;
  }

  autoUpdaterInstance.removeAllListeners('download-progress');
  autoUpdaterInstance.removeAllListeners('update-downloaded');
  autoUpdaterInstance.removeAllListeners('error');

  autoUpdaterInstance.on('download-progress', (progress) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    }
    onProgress?.(progress.percent);
  });

  autoUpdaterInstance.on('update-downloaded', (info) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    onDownloaded?.(info.version);
  });

  autoUpdaterInstance.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    onError?.(error instanceof Error ? error.message : String(error));
  });

  try {
    const result = await autoUpdaterInstance.checkForUpdates();
    if (!result) {
      shell.openExternal(LATEST_RELEASE_PAGE);
      return;
    }

    await autoUpdaterInstance.downloadUpdate();
  } catch (error) {
    onError?.(error instanceof Error ? error.message : String(error));
  }
}

function quitAndInstall() {
  if (autoUpdaterInstance) {
    autoUpdaterInstance.quitAndInstall(false, true);
  }
}

function setupAutoUpdate({ app, mainWindow }) {
  if (!app.isPackaged) {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;
  shouldOpenDownloadPageForUpdate = app.getName() === 'OpenBidKit_Yibiao';

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('download-progress', (progress) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已下载',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '是否立即重启应用并安装更新？',
      noLink: true,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1);
    }
    console.warn('自动更新检查失败', error);
  });

  setTimeout(() => {
    fetchLatestRelease().then(async (release) => {
      if (!release.version || compareVersions(release.version, app.getVersion()) <= 0) {
        return;
      }

      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: [shouldOpenDownloadPageForUpdate ? '打开下载页' : '立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `发现新版本 ${release.version}`,
        detail: formatReleaseNotes(release.body) || '是否现在下载更新？',
        noLink: true,
      });

      if (result.response !== 0) {
        return;
      }

      await triggerUpdateDownload({
        mainWindow,
        onDownloaded: async (version) => {
          const dialogResult = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            buttons: ['重启安装', '稍后'],
            defaultId: 0,
            cancelId: 1,
            title: '更新已下载',
            message: `新版本 ${version} 已下载完成`,
            detail: '是否立即重启应用并安装更新？',
            noLink: true,
          });

          if (dialogResult.response === 0) {
            autoUpdater.quitAndInstall(false, true);
          }
        },
        onError: async (message) => {
          await dialog.showMessageBox(mainWindow, {
            type: 'error',
            buttons: ['打开下载页', '知道了'],
            defaultId: 0,
            cancelId: 1,
            title: '更新下载失败',
            message: '更新下载失败',
            detail: message,
            noLink: true,
          }).then((dialogResult) => {
            if (dialogResult.response === 0) {
              shell.openExternal(LATEST_RELEASE_PAGE);
            }
          });
        },
      });
    }).catch((error) => {
      console.warn('启动自动更新检查失败', error);
    });
  }, 3000);
}

module.exports = { setupAutoUpdate, triggerUpdateDownload, quitAndInstall };

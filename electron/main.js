const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

const isDev = process.env.NODE_ENV !== "production";
const APP_URL = process.env.APP_URL || (isDev ? "http://localhost:3000" : "https://your-code-compass-domain.com");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Code Compass",
  });

  mainWindow.loadURL(APP_URL);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // First-class settings: open Settings in the same window (feels native)
  mainWindow.setMenu(
    Menu.buildFromTemplate([
      {
        label: app.name || "Code Compass",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings",
            accelerator: "CmdOrCtrl+,",
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                const base = APP_URL.replace(/\/$/, "");
                const settingsUrl = base + "/app/settings";
                mainWindow.loadURL(settingsUrl);
              }
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "Back to app",
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.loadURL(APP_URL);
              }
            },
          },
        ],
      },
    ])
  );
}

app.whenReady().then(() => {
  createWindow();

  // Auto-updates: only in production and when electron-updater is available (packaged app)
  if (!isDev) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.checkForUpdatesAndNotify().catch((err) => {
        console.warn("Auto-update check failed:", err.message);
      });
    } catch (e) {
      // electron-updater not installed (e.g. dev); skip
    }
  }
});

app.on("window-all-closed", () => {
  mainWindow = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

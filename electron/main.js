const { app, BrowserWindow } = require("electron");
const path = require("path");

const isDev = process.env.NODE_ENV !== "production";
const APP_URL = process.env.APP_URL || (isDev ? "http://localhost:3000" : "https://your-code-compass-domain.com");

function createWindow() {
  const win = new BrowserWindow({
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

  win.loadURL(APP_URL);

  if (isDev) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

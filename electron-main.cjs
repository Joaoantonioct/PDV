const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { DatabaseSync } = require("node:sqlite");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const APP_NAME = "PontoCerto PDV";
const BACKUP_LIMIT = 7;
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

app.setName(APP_NAME);
app.setPath("userData", join(app.getPath("appData"), APP_NAME));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow;
  let server;
  let serverUrl;
  let backupTimer;
  let isQuitting = false;
  let shutdownStarted = false;

  function loadConfiguration(configPath) {
    if (!existsSync(configPath)) return false;
    const contents = readFileSync(configPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[match[1]] = value;
    }
    return true;
  }

  async function initializeDatabasePath(dataDirectory, legacyPaths) {
    const databasePath = join(dataDirectory, "pdv.sqlite");
    if (!existsSync(databasePath)) {
      let legacyPath = legacyPaths.find((candidate) =>
        candidate && resolve(candidate) !== resolve(databasePath) && existsSync(candidate));
      if (!legacyPath && app.isPackaged) {
        const choice = await dialog.showMessageBox({
          type: "question",
          title: APP_NAME,
          message: "Você já possui um banco de dados do PDV para importar?",
          detail: "Importar o banco existente mantém produtos, estoque, usuários e vendas. O arquivo original não será alterado.",
          buttons: ["Selecionar banco existente", "Começar sem importar"],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice.response === 0) {
          const selection = await dialog.showOpenDialog({
            title: "Selecionar banco SQLite do PDV",
            properties: ["openFile"],
            filters: [{ name: "Banco SQLite", extensions: ["sqlite", "db"] }],
          });
          if (selection.canceled || !selection.filePaths[0]) {
            throw new Error("A seleção do banco foi cancelada. Nenhum banco foi criado.");
          }
          legacyPath = selection.filePaths[0];
        }
      }
      if (legacyPath) {
        const source = new DatabaseSync(legacyPath);
        try {
          const escapedPath = databasePath.replaceAll("'", "''");
          source.exec(`VACUUM INTO '${escapedPath}'`);
        } catch (error) {
          if (existsSync(databasePath)) unlinkSync(databasePath);
          throw new Error(`Não foi possível migrar o banco existente: ${error.message}`);
        } finally {
          source.close();
        }
      }
    }
    return databasePath;
  }

  function backupDatabase(database, backupDirectory, window) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const backupPath = join(backupDirectory, `pdv-${date}.sqlite`);
    if (existsSync(backupPath)) return;
    try {
      const escapedPath = backupPath.replaceAll("'", "''");
      database.exec(`VACUUM INTO '${escapedPath}'`);
      const backups = readdirSync(backupDirectory)
        .filter((name) => /^pdv-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
        .map((name) => ({ name, modified: statSync(join(backupDirectory, name)).mtimeMs }))
        .sort((left, right) => right.modified - left.modified);
      for (const oldBackup of backups.slice(BACKUP_LIMIT)) {
        unlinkSync(join(backupDirectory, oldBackup.name));
      }
    } catch (error) {
      console.error("Falha ao criar backup automático do banco:", error);
      const options = {
        type: "warning",
        title: APP_NAME,
        message: "Não foi possível criar o backup automático do banco de dados.",
        detail: `Os dados locais continuam disponíveis, mas faça um backup manual. Detalhe: ${error.message}`,
      };
      if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options);
      else void dialog.showMessageBox(options);
    }
  }

  async function createWindow() {
    if (!serverUrl) return;
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      title: APP_NAME,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== new URL(serverUrl).origin) event.preventDefault();
    });
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
    await mainWindow.loadURL(serverUrl);
  }

  function buildMenu(configPath, dataDirectory) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: "Arquivo",
        submenu: [{ role: "quit", label: "Sair" }],
      },
      {
        label: "Ajuda",
        submenu: [
          {
            label: "Abrir configuração de sincronização",
            click: () => {
              if (process.platform === "win32") {
                spawn("notepad.exe", [configPath], { detached: true, stdio: "ignore" }).unref();
              } else {
                void shell.openPath(configPath);
              }
            },
          },
          {
            label: "Abrir pasta de dados e backups",
            click: () => { void shell.openPath(dataDirectory); },
          },
        ],
      },
    ]));
  }

  async function startApplication() {
    const userDataDirectory = app.getPath("userData");
    const dataDirectory = join(userDataDirectory, "data");
    const backupDirectory = join(userDataDirectory, "backups");
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(backupDirectory, { recursive: true });

    const configPath = join(userDataDirectory, ".env");
    const projectRoot = app.getAppPath();
    const sourceConfigPath = app.isPackaged ? undefined : join(projectRoot, ".env");
    loadConfiguration(configPath);
    if (sourceConfigPath) loadConfiguration(sourceConfigPath);
    const hasSiteSyncConfiguration = Boolean(
      process.env.PDV_SITE_SYNC_URL && process.env.PDV_SITE_SYNC_TOKEN,
    );
    if (!existsSync(configPath)) {
      const templatePath = app.isPackaged
        ? join(process.resourcesPath, "desktop-config.example")
        : join(projectRoot, "desktop-config.example");
      if (existsSync(templatePath)) copyFileSync(templatePath, configPath);
    }

    const legacyDatabasePaths = [
      process.env.PDV_DB_PATH,
      app.isPackaged ? undefined : join(projectRoot, "data", "pdv.sqlite"),
    ];
    const databasePath = await initializeDatabasePath(dataDirectory, legacyDatabasePaths);
    process.env.PDV_DB_PATH = databasePath;
    process.env.PDV_COOKIE_SECURE = "false";

    const { createApplication } = await import(pathToFileURL(join(projectRoot, "server.mjs")).href);
    server = createApplication({ dbPath: databasePath });
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    serverUrl = `http://127.0.0.1:${server.address().port}`;
    backupDatabase(server.database, backupDirectory, null);
    backupTimer = setInterval(
      () => backupDatabase(server.database, backupDirectory, mainWindow),
      BACKUP_INTERVAL_MS,
    );
    backupTimer.unref();
    buildMenu(configPath, userDataDirectory);
    await createWindow();

    if (!hasSiteSyncConfiguration && app.isPackaged) {
      const reminderPath = join(userDataDirectory, ".sync-config-reminded");
      if (!existsSync(reminderPath)) {
        await dialog.showMessageBox(mainWindow, {
          type: "info",
          title: APP_NAME,
          message: "O PDV está pronto para uso local.",
          detail: "Para sincronizar com o site, configure a URL e o token no menu Ajuda > Abrir configuração de sincronização e reinicie o aplicativo.",
        });
        writeFileSync(reminderPath, "");
      }
    }
  }

  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInterval(backupTimer);
    if (server) {
      if (server.listening) {
        await new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
      }
      server.database.close();
    }
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startApplication).catch((error) => {
    console.error("Falha ao iniciar o aplicativo PDV:", error);
    void dialog.showErrorBox(
      APP_NAME,
      `Não foi possível iniciar o PDV. Verifique a configuração e o banco local.\n\n${error.message}`,
    );
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void shutdown().then(() => {
      isQuitting = true;
      app.quit();
    }).catch((error) => {
      console.error("Falha ao encerrar o servidor PDV:", error);
      isQuitting = true;
      app.quit();
    });
  });
}

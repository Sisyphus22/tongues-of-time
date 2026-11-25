// Tongues of Time — desktop shell.
// Serves the Tongues of Time page from ./app over a private tongues:// scheme, keeps the
// user's pictures, videos and entries on this computer, and calls Claude with
// the user's own Anthropic API key (stored encrypted by the operating system:
// DPAPI on Windows, Keychain on macOS, the desktop keyring on Linux).

const { app, BrowserWindow, Menu, ipcMain, protocol, net, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const AnthropicModule = require("@anthropic-ai/sdk");
const Anthropic = AnthropicModule.default || AnthropicModule;

const MODELS = {
  "claude-opus-5-5": "Opus 5.5 — best writing (about 3 cents a question)",
  "claude-sonnet-5-5": "Sonnet 5.5 — balanced (about 1 cent a question)",
  "claude-haiku-5-5": "Haiku 5.5 — fastest, cheapest (under 0.1 cent a question)",
};
const DEFAULT_MODEL = "claude-opus-5-5";
const KEYS_PAGE = "https://console.anthropic.com/settings/keys";
const MEDIA_TYPES = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
  "video/mp4": ".mp4", "video/webm": ".webm",
};
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  { scheme: "tongues", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const APP_DIR = path.join(__dirname, "app");
let DATA_DIR, MEDIA_DIR, DB_FILE, SETTINGS_FILE;
let store = { collections: {}, assets: {} };
let settings = { model: DEFAULT_MODEL };

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}
const saveStore = () => writeJSON(DB_FILE, store);
const saveSettings = () => writeJSON(SETTINGS_FILE, settings);

function getKey() {
  if (settings.keyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(settings.keyEnc, "base64")); } catch { return null; }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}
function clientFor(key) { return new Anthropic({ apiKey: key }); }

function errorResult(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { ok: false, code: "cancelled", message: "Stopped" };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, code: "invalid_key", message: err.message };
  if (err instanceof Anthropic.RateLimitError) return { ok: false, code: "rate_limited", message: err.message };
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) return { ok: false, code: "api_error", message: (err.error && err.error.error && err.error.error.message) || err.message };
  if (err instanceof Anthropic.APIConnectionError) return { ok: false, code: "offline", message: err.message };
  if (err instanceof Anthropic.APIError) return { ok: false, code: "upstream_error", message: err.message };
  return { ok: false, code: "upstream_error", message: String((err && err.message) || err) };
}

/* ---------- Claude ---------- */
const running = new Map();
ipcMain.handle("claude:ask", async (event, { id, prompt }) => {
  const key = getKey();
  if (!key) return { ok: false, code: "no_key", message: "No API key" };
  if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, code: "api_error", message: "Empty question" };
  const ctl = new AbortController();
  running.set(id, ctl);
  let text = "";
  try {
    const stream = clientFor(key).beta.messages.stream({
      model: MODELS[settings.model] ? settings.model : DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt.slice(0, 200000) }],
    }, { signal: ctl.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        text += ev.delta.text;
        if (!event.sender.isDestroyed()) event.sender.send("claude:text", { id, text });
      }
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") return { ok: false, code: "refused", message: "Declined" };
    return { ok: true, text, truncated: msg.stop_reason === "max_tokens" };
  } catch (err) {
    return errorResult(err);
  } finally {
    running.delete(id);
  }
});
ipcMain.handle("claude:abort", (_e, id) => { const c = running.get(id); if (c) c.abort(); });

/* ---------- narrator voice (fish.audio, with the user's own key) ---------- */
const VOICE_API = (!require("electron").app.isPackaged && process.env.FISH_API_BASE) || "https://api.fish.audio"; // a local test server only in development
const VOICE_KEYS_PAGE = "https://fish.audio/app/api-keys/";
const VOICE_MODELS = {
  "s2.1-pro-free": "Free model (fish.audio's free tier)",
  "s2.1-pro": "Best quality (about 1.5 cents per 1,000 letters)",
};
const DEFAULT_VOICE_MODEL = "s2.1-pro-free";
const VOICES = {
  "76a298d92ef647e39e01fe0572e68459": "Medieval Grime: deep, somber and dramatic",
  "ef9c79b62ef34530bf452c0e50e3c260": "Horror: deep, calm and mysterious",
  "7131193661114896bb7ca2ec3d0e3e03": "Bible Story Teller: deep, resonant and calm",
  "8906b5268cae414fb9b8d3da6e84413d": "Measured Storyteller: clear and calm (woman)",
};
const DEFAULT_VOICE = "7131193661114896bb7ca2ec3d0e3e03";
const VOICE_LANGS = new Set(["en", "zh", "ja", "ko", "fr", "de", "es", "it", "pt", "nl", "pl", "ru", "ar"]);
function getVoiceKey() {
  if (settings.voiceKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(settings.voiceKeyEnc, "base64")); } catch { return null; }
  }
  return process.env.FISH_API_KEY || null;
}
function voiceError(status, detail) {
  if (status === 401 || status === 403) return { ok: false, code: "invalid_voice_key", message: "fish.audio didn't accept the narrator key. Paste a working key in Connect Claude." };
  if (status === 402) return { ok: false, code: "voice_no_credit", message: "Your fish.audio account needs credit for this voice model. In Connect Claude, switch the narrator to the free model, or add credit at fish.audio." };
  if (status === 429) return { ok: false, code: "busy", message: "The narrator is busy. Try again in a moment." };
  if (status === 404) return { ok: false, code: "voice_not_found", message: "fish.audio couldn't find that voice. Pick another narrator voice in Connect Claude." };
  return { ok: false, code: "upstream_error", message: "The narrator couldn't speak (fish.audio said " + status + (detail ? ": " + detail : "") + ")." };
}
const voiceRunning = new Map();
ipcMain.handle("voice:speak", async (_e, { id, text, language }) => {
  const key = getVoiceKey();
  if (!key) return { ok: false, code: "no_voice_key", message: "No narrator key" };
  text = String(text || "").trim().slice(0, 5000);
  if (!text) return { ok: false, code: "api_error", message: "Nothing to say" };
  const ctl = new AbortController();
  voiceRunning.set(id, ctl);
  const body = { text, reference_id: /^[0-9a-f]{32}$/.test(settings.voiceId || "") ? settings.voiceId : DEFAULT_VOICE, format: "mp3", mp3_bitrate: 128, latency: "normal", normalize: true };
  const lang = String(language || "").toLowerCase().split("-")[0];
  const call = (b) => fetch(VOICE_API + "/v1/tts", {
    method: "POST", signal: ctl.signal, body: JSON.stringify(b),
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", model: VOICE_MODELS[settings.voiceModel] ? settings.voiceModel : DEFAULT_VOICE_MODEL },
  });
  try {
    let res = await call(VOICE_LANGS.has(lang) ? { ...body, language: lang } : body);
    if ((res.status === 400 || res.status === 422) && VOICE_LANGS.has(lang)) res = await call(body);
    if (!res.ok) {
      let detail = "";
      try { detail = String((await res.json()).message || "").slice(0, 160); } catch {}
      return voiceError(res.status, detail);
    }
    return { ok: true, audio: new Uint8Array(await res.arrayBuffer()), type: "audio/mpeg" };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, code: "stopped", message: "Stopped" };
    return { ok: false, code: "offline", message: "Can't reach fish.audio for the narrator. Check your internet connection." };
  } finally {
    voiceRunning.delete(id);
  }
});
ipcMain.handle("voice:abort", (_e, id) => { const c = voiceRunning.get(id); if (c) c.abort(); });
ipcMain.handle("settings:setVoiceKey", async (_e, key) => {
  key = String(key || "").trim();
  if (!key) return { ok: false, message: "Paste a fish.audio key first." };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: "This computer has no secure storage available for the key, so it wasn't saved." };
  try {
    const res = await fetch(VOICE_API + "/model?self=true&page_size=1", { headers: { Authorization: "Bearer " + key } });
    if (res.status === 401 || res.status === 403) return { ok: false, message: "fish.audio didn't accept that key. Check you copied all of it." };
  } catch { return { ok: false, message: "Can't reach fish.audio to check the key. Check your internet connection." }; }
  settings.voiceKeyEnc = safeStorage.encryptString(key).toString("base64");
  saveSettings();
  return { ok: true, settings: publicSettings() };
});
ipcMain.handle("settings:clearVoiceKey", () => { delete settings.voiceKeyEnc; saveSettings(); return publicSettings(); });
ipcMain.handle("settings:setVoice", (_e, id) => { if (/^[0-9a-f]{32}$/.test(String(id))) { settings.voiceId = String(id); saveSettings(); } return publicSettings(); });
ipcMain.handle("settings:setVoiceModel", (_e, m) => { if (VOICE_MODELS[m]) { settings.voiceModel = m; saveSettings(); } return publicSettings(); });
ipcMain.handle("open:voiceKeys", () => shell.openExternal(VOICE_KEYS_PAGE));

/* ---------- settings ---------- */
const publicSettings = () => ({
  hasKey: !!getKey(), fromEnv: !settings.keyEnc && !!process.env.ANTHROPIC_API_KEY,
  model: settings.model, models: MODELS, canEncrypt: safeStorage.isEncryptionAvailable(),
  hasVoiceKey: !!getVoiceKey(), voiceId: /^[0-9a-f]{32}$/.test(settings.voiceId || "") ? settings.voiceId : DEFAULT_VOICE, voices: VOICES,
  voiceModel: VOICE_MODELS[settings.voiceModel] ? settings.voiceModel : DEFAULT_VOICE_MODEL, voiceModels: VOICE_MODELS,
});
ipcMain.handle("settings:get", () => publicSettings());
ipcMain.handle("settings:setKey", async (_e, key) => {
  key = String(key || "").trim();
  if (!key) return { ok: false, message: "Paste a key first." };
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: "This computer has no secure storage available for the key, so it wasn't saved." };
  try { await clientFor(key).models.retrieve(DEFAULT_MODEL); }
  catch (err) {
    const r = errorResult(err);
    if (r.code === "invalid_key") return { ok: false, message: "Anthropic didn't accept that key. Check you copied all of it." };
    if (r.code === "offline") return { ok: false, message: "Can't reach Anthropic to check the key. Check your internet connection." };
  }
  settings.keyEnc = safeStorage.encryptString(key).toString("base64");
  saveSettings();
  return { ok: true, settings: publicSettings() };
});
ipcMain.handle("settings:clearKey", () => { delete settings.keyEnc; saveSettings(); return publicSettings(); });
ipcMain.handle("settings:setModel", (_e, model) => { if (MODELS[model]) { settings.model = model; saveSettings(); } return publicSettings(); });
ipcMain.handle("open:keys", () => shell.openExternal(KEYS_PAGE));

/* ---------- local database ---------- */
const COLLECTIONS = new Set(["pictures", "entries"]);
const DOC_ID = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
ipcMain.handle("db:list", (_e, col) => (COLLECTIONS.has(col) ? store.collections[col] || {} : {}));
ipcMain.handle("db:set", (event, col, id, data) => {
  if (!COLLECTIONS.has(col) || !DOC_ID.test(id) || !data || typeof data !== "object") return { ok: false };
  (store.collections[col] = store.collections[col] || {})[id] = data;
  saveStore(); event.sender.send("db:changed", col); return { ok: true };
});
ipcMain.handle("db:delete", (event, col, id) => {
  if (!COLLECTIONS.has(col) || !store.collections[col]) return { ok: true };
  delete store.collections[col][id];
  saveStore(); event.sender.send("db:changed", col); return { ok: true };
});

/* ---------- pictures and videos ---------- */
ipcMain.handle("assets:upload", (_e, { bytes, type }) => {
  const ext = MEDIA_TYPES[type];
  if (!ext) return { ok: false, code: "unsupported_type", message: "Unsupported file type" };
  const buf = Buffer.from(bytes);
  if (!buf.length) return { ok: false, code: "invalid_request", message: "Empty file" };
  if (buf.length > MAX_MEDIA_BYTES) return { ok: false, code: "too_large", message: "File too large" };
  const id = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(MEDIA_DIR, id + ext), buf);
  store.assets[id] = { ext, type, size: buf.length, at: new Date().toISOString() };
  saveStore();
  return { ok: true, id, size: buf.length };
});

/* ---------- window ---------- */
function serve(request) {
  const url = new URL(request.url);
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith("/_blob/")) {
    const id = p.slice(7);
    const meta = /^[0-9a-f]{32}$/.test(id) && store.assets[id];
    if (!meta) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(path.join(MEDIA_DIR, id + meta.ext)).toString(), { headers: request.headers });
  }
  if (p === "/" || p === "") p = "/index.html";
  const file = path.normalize(path.join(APP_DIR, p));
  if (!file.startsWith(APP_DIR + path.sep)) return new Response("Forbidden", { status: 403 });
  return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 420, minHeight: 500,
    backgroundColor: "#100f12", title: "Tongues of Time", autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("tongues://")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); }
  });
  win.loadURL("tongues://app/index.html");
  // Developer check: APP_SNAPSHOT=<file.png> [APP_SNAPSHOT_JS=<script>] saves a screenshot and quits.
  if (process.env.APP_SNAPSHOT) {
    win.webContents.setAudioMuted(true);
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 2500));
      if (process.env.APP_SNAPSHOT_JS) {
        try { console.log("JS:", JSON.stringify(await win.webContents.executeJavaScript(process.env.APP_SNAPSHOT_JS))); } catch (e) { console.log("JS error:", e.message); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.APP_SNAPSHOT, img.toPNG());
      app.quit();
    });
    win.webContents.on("console-message", (e) => { if (e.level === "error" || e.level === "warning") console.log("console:", e.message); });
  }
}

app.whenReady().then(() => {
  DATA_DIR = app.getPath("userData");
  MEDIA_DIR = path.join(DATA_DIR, "media");
  DB_FILE = path.join(DATA_DIR, "tongues-data.json");
  SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  store = Object.assign({ collections: {}, assets: {} }, readJSON(DB_FILE, {}));
  settings = Object.assign({ model: DEFAULT_MODEL }, readJSON(SETTINGS_FILE, {}));
  protocol.handle("tongues", serve);
  // macOS needs an app menu for Cmd+C / Cmd+V (pasting the API key) and Cmd+Q.
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
  }
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

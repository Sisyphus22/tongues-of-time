// Narrow bridge between the Atlas page and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

const textListeners = new Map();
ipcRenderer.on("claude:text", (_e, { id, text }) => { const f = textListeners.get(id); if (f) f(text); });
const dbListeners = new Set();
ipcRenderer.on("db:changed", (_e, col) => dbListeners.forEach((f) => f(col)));

contextBridge.exposeInMainWorld("atlasApp", {
  ask(id, prompt, onText) {
    textListeners.set(id, onText);
    return ipcRenderer.invoke("claude:ask", { id, prompt }).finally(() => textListeners.delete(id));
  },
  abort: (id) => ipcRenderer.invoke("claude:abort", id),
  settings: () => ipcRenderer.invoke("settings:get"),
  setKey: (key) => ipcRenderer.invoke("settings:setKey", key),
  clearKey: () => ipcRenderer.invoke("settings:clearKey"),
  setModel: (model) => ipcRenderer.invoke("settings:setModel", model),
  openKeysPage: () => ipcRenderer.invoke("open:keys"),
  dbList: (col) => ipcRenderer.invoke("db:list", col),
  dbSet: (col, id, data) => ipcRenderer.invoke("db:set", col, id, data),
  dbDelete: (col, id) => ipcRenderer.invoke("db:delete", col, id),
  onDbChange: (f) => { dbListeners.add(f); },
  upload: (bytes, type) => ipcRenderer.invoke("assets:upload", { bytes, type }),
});

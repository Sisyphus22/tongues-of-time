// Gives the Tongues of Time page the same `claude.use()` surface it has on claude.ai:
// Claude via the user's own API key (desktop shell or website backend), reading aloud
// with the device's built-in voices, and the Connect Claude settings panel.
(() => {
  "use strict";
  const A = window.atlasApp;
  if (!A) return;
  const META = { fromCache: false, hasPendingWrites: false };
  const newId = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

  /* ---------- sample (ask Claude) ---------- */
  function sample(input, opts) {
    opts = opts || {};
    const prompt = typeof input === "string" ? input : (input || []).map((m) => m.content).join("\n\n");
    const id = newId(12);
    return new Promise((resolve, reject) => {
      let last = "";
      if (opts.signal) {
        if (opts.signal.aborted) { reject({ code: "cancelled", message: "Stopped" }); return; }
        opts.signal.addEventListener("abort", () => A.abort(id), { once: true });
      }
      A.ask(id, prompt, (text) => {
        const delta = text.slice(last.length); last = text;
        if (delta && typeof opts.onText === "function") { try { opts.onText({ text, delta }); } catch (e) { console.error(e); } }
      }).then((r) => {
        if (r && r.ok) { resolve({ text: r.text, truncated: !!r.truncated, modelTierApplied: "complex" }); return; }
        const err = { code: (r && r.code) || "upstream_error", message: (r && r.message) || "" };
        if (last && err.code !== "refused") err.text = last;
        if (err.code === "no_key" || err.code === "invalid_key") openSettings(err.code);
        reject(err);
      }, (e) => reject({ code: "upstream_error", message: String(e) }));
    });
  }
  sample.json = async (input, opts) => { const r = await sample(input, opts); const m = r.text.match(/[\[{][\s\S]*[\]}]/); return JSON.parse(m ? m[0] : r.text); };
  sample.limits = async () => ({ maxPromptBytes: 262144, modelTiers: ["default", "complex", "quick"] });

  /* ---------- local db ---------- */
  const subs = new Map();
  async function emit(col) {
    const set = subs.get(col); if (!set || !set.size) return;
    const docs = await A.dbList(col);
    const list = Object.keys(docs).sort().map((id) => ({ id, exists: true, data: () => docs[id], metadata: META }));
    const snap = { docs: list, size: list.length, empty: !list.length, metadata: META, docChanges: () => [] };
    set.forEach((f) => { try { f(snap); } catch (e) { console.error(e); } });
  }
  const hasStore = typeof A.dbList === "function";
  const isWeb = A.kind === "web";
  if (hasStore) A.onDbChange((col) => emit(col));
  const db = {
    doc(p) {
      const i = p.lastIndexOf("/"); const col = p.slice(0, i), id = p.slice(i + 1);
      return {
        id, path: p,
        set: async (d) => { const r = await A.dbSet(col, id, JSON.parse(JSON.stringify(d))); if (!r.ok) throw { code: "invalid_argument" }; },
        update: async (d) => { const all = await A.dbList(col); if (!all[id]) throw { code: "invalid_argument" }; await A.dbSet(col, id, Object.assign({}, all[id], JSON.parse(JSON.stringify(d)))); },
        delete: () => A.dbDelete(col, id),
        get: async () => { const all = await A.dbList(col); const d = all[id]; return { id, exists: !!d, data: () => d, metadata: META }; },
      };
    },
    collection(col) {
      return {
        path: col,
        doc: (id) => db.doc(col + "/" + (id || newId(10))),
        add: async (d) => { const ref = db.doc(col + "/" + newId(10)); await ref.set(d); return ref; },
        onSnapshot(next, error) {
          if (!subs.has(col)) subs.set(col, new Set());
          subs.get(col).add(next);
          emit(col).catch(() => error && error({ code: "unavailable" }));
          return () => subs.get(col).delete(next);
        },
      };
    },
  };

  /* ---------- local media ---------- */
  const assets = {
    async upload(blob, options) {
      const type = (options && options.type) || blob.type;
      const r = await A.upload(new Uint8Array(await blob.arrayBuffer()), type);
      if (!r.ok) throw { code: r.code, message: r.message };
      return { id: r.id, url: "/_blob/" + r.id, sizeBytes: r.size, contentType: type };
    },
  };

  /* ---------- reading aloud with the device's own voices ---------- */
  function makeTts() {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return null;
    const synth = window.speechSynthesis;
    const listeners = new Set();
    let state = "idle";
    const setState = (s, reason) => { state = s; listeners.forEach((f) => { try { f({ state: s, reason }); } catch (e) { console.error(e); } }); };
    const voicesReady = () => new Promise((resolve) => {
      if (synth.getVoices().length) { resolve(); return; }
      const done = () => { synth.removeEventListener("voiceschanged", done); resolve(); };
      synth.addEventListener("voiceschanged", done);
      setTimeout(done, 1500);
    });
    const pick = (lang) => {
      const all = synth.getVoices(); const l = String(lang || "en").toLowerCase(); const base = l.split("-")[0];
      return all.find((v) => v.lang.toLowerCase() === l) || all.find((v) => v.lang.toLowerCase().replace("_", "-").split("-")[0] === base) || null;
    };
    return {
      kind: "device",
      async speak(text, opts) {
        opts = opts || {};
        await voicesReady();
        const lang = opts.language || "en";
        const voice = pick(lang);
        if (!voice && !/^en/i.test(lang)) throw { code: "unavailable", message: "No " + lang + " voice on this device" };
        synth.cancel();
        return new Promise((resolve, reject) => {
          const u = new SpeechSynthesisUtterance(String(text));
          if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = lang;
          u.rate = Math.min(1.5, Math.max(0.5, opts.rate || 1));
          u.onstart = () => setState("speaking");
          u.onend = () => { setState("idle", "completed"); resolve(); };
          u.onerror = (e) => {
            setState("idle", e.error);
            reject(e.error === "interrupted" || e.error === "canceled" ? { code: "stopped", message: e.error } : { code: "upstream_error", message: e.error });
          };
          setState("starting");
          synth.speak(u);
        });
      },
      stop() { synth.cancel(); setState("idle", "stopped"); return Promise.resolve(); },
      onState(f) { listeners.add(f); f({ state }); return () => listeners.delete(f); },
      async voices() { await voicesReady(); return [...new Set(synth.getVoices().map((v) => v.lang))]; },
    };
  }
  const tts = makeTts();

  window.claude = { use: async (name) => (name === "sample" ? sample : name === "tts" ? tts : name === "db" && hasStore ? db : name === "assets" && hasStore ? assets : null) };

  /* ---------- Claude settings panel ---------- */
  const css = `
  .app-gear{position:fixed;top:14px;right:max(16px,env(safe-area-inset-right,0px));z-index:15;display:inline-flex;align-items:center;gap:8px;background:var(--panel-2);border:1px solid var(--line);border-radius:999px;padding:7px 13px;font:500 13px var(--ui);color:var(--fg);cursor:pointer}
  .app-gear:hover{border-color:var(--gold)}
  .app-gear i{width:8px;height:8px;border-radius:50%;background:var(--dim)}
  .app-gear.on i{background:#7fd38a}
  .app-set{max-width:560px}
  .app-set .modal-body p{color:var(--muted);font-size:14px;margin:8px 0 0}
  .app-set ol{color:var(--muted);font-size:14px;padding-left:20px;margin:10px 0 0}
  .app-set .ok{color:#7fd38a;font-size:13.5px}
  .app-overlay{position:fixed;inset:0;z-index:20;background:rgba(6,5,8,.74);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px))}
  .app-modal{background:var(--panel,var(--desk,#1a1816));color:var(--fg,var(--vellum,#ece3d1));border:1px solid var(--line,var(--rule,#35303b));border-radius:12px;width:min(560px,100%);max-height:100%;overflow:auto;box-shadow:0 30px 80px rgba(0,0,0,.6);font-family:var(--ui,system-ui,sans-serif)}
  .app-modal .modal-body{padding:20px 22px 24px}
  .app-modal h3{font-size:26px;font-weight:600;margin:6px 0 0}
  .app-modal .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold,#d9a84e)}
  .app-modal .field{display:flex;flex-direction:column;gap:5px;margin-top:12px}
  .app-modal .field label{font-size:12.5px;color:var(--muted,var(--faded,#a79e90))}
  .app-modal .field input,.app-modal .field select{width:100%;min-width:0;background:var(--panel-2,var(--desk-2,#211e25));color:inherit;border:1px solid var(--line,var(--rule,#35303b));border-radius:6px;padding:9px 10px;font-size:14px}
  .app-modal .modal-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .app-modal .btn.ghost{background:transparent}
  .app-modal .small{font-size:12.5px;color:var(--dim,#6d665e)}
  .app-modal .err{color:#f0786c;font-size:13.5px}
  .app-modal .x{position:sticky;top:0;float:right;margin:10px 10px -46px 0;width:36px;height:36px;border-radius:50%;background:rgba(17,15,13,.85);color:inherit;border:1px solid var(--line,var(--rule,#35303b));font-size:18px;line-height:1;cursor:pointer;z-index:2}
  `;
  let gear, settingsOpen = false;
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (k === "class") n.className = v; else n.setAttribute(k, v); }
    kids.flat().forEach((c) => c != null && n.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return n;
  }
  async function refreshGear() {
    const s = await A.settings();
    gear.classList.toggle("on", s.hasKey);
    gear.lastChild.textContent = s.hasKey ? "Claude connected" : "Connect Claude";
  }
  async function openSettings(reason) {
    if (settingsOpen) return;
    let overlay = document.getElementById("overlay"), modal = document.getElementById("modal");
    if (!overlay || !modal) {
      overlay = document.getElementById("appOverlay");
      if (!overlay) {
        overlay = h("div", { id: "appOverlay", class: "app-overlay", hidden: "" }, h("div", { id: "appModal", class: "app-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "modalTitle" }));
        document.body.append(overlay);
      }
      modal = document.getElementById("appModal");
    }
    settingsOpen = true;
    const s = await A.settings();
    const status = h("p", { role: "status" });
    const key = h("input", { id: "apiKey", type: "password", autocomplete: "off", spellcheck: "false", placeholder: s.hasKey ? "A key is saved. Paste a new one to replace it." : "sk-ant-…" });
    const model = h("select", { id: "apiModel" }, Object.entries(s.models).map(([v, label]) => h("option", { value: v }, label)));
    model.value = s.model;
    model.addEventListener("change", async () => { await A.setModel(model.value); status.className = "ok"; status.textContent = "Model saved."; });
    const save = h("button", { class: "btn primary", type: "submit" }, "Save key");
    const remember = h("input", { id: "apiRemember", type: "checkbox" });
    remember.checked = !!s.remember;
    const form = h("form", { class: "modal-body" },
      h("div", { class: "eyebrow" }, "Claude settings"),
      h("h3", { id: "modalTitle" }, s.hasKey ? "Claude is connected" : "Connect Claude"),
      reason === "invalid_key" ? h("p", { class: "err" }, "Your saved key was rejected. Paste a working key.") : null,
      h("p", null, "Translating uses your own Anthropic API key. You pay Anthropic per translation; there's no subscription."),
      h("ol", null,
        h("li", null, "Create an account and add credit at the Anthropic Console."),
        h("li", null, "Create an API key and paste it below.")),
      h("div", { class: "modal-actions" }, h("button", { class: "btn", type: "button", onclick: () => A.openKeysPage() }, "Open the Anthropic Console")),
      h("div", { class: "field" }, h("label", { for: "apiKey" }, "API key"), key),
      h("div", { class: "field" }, h("label", { for: "apiModel" }, "Model"), model),
      isWeb ? h("label", { class: "small", style: "display:flex;gap:8px;align-items:center;margin-top:12px" }, remember, "Remember the key in this browser (only on your own computer)") : null,
      h("p", { class: "small" }, isWeb
        ? "The key stays in this browser and is only sent to Anthropic. Don't save it on a shared or public computer. Tip: set a monthly spend limit in the Anthropic Console."
        : "The key is encrypted by your computer's secure storage and stays on this computer. It's only sent to Anthropic."),
      status,
      h("div", { class: "modal-actions" }, save,
        s.hasKey && !s.fromEnv ? h("button", { class: "btn ghost", type: "button", onclick: async () => { await A.clearKey(); await refreshGear(); close(); } }, "Remove key") : null,
        h("button", { class: "btn ghost", type: "button", onclick: () => close() }, "Close")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); status.className = ""; status.textContent = "Checking the key…"; save.disabled = true;
      const r = await A.setKey(key.value, remember.checked);
      save.disabled = false;
      if (r.ok) { status.className = "ok"; status.textContent = "Key saved. Claude is connected."; key.value = ""; await refreshGear(); setTimeout(close, 900); }
      else { status.className = "err"; status.textContent = r.message; }
    });
    const prevClass = modal.className;
    modal.classList.add("app-set"); modal.replaceChildren(h("button", { class: "x", type: "button", "aria-label": "Close", onclick: () => close() }, "×"), form);
    overlay.hidden = false; key.focus();
    function onKey(e) { if (e.key === "Escape") close(); }
    function onBackdrop(e) { if (e.target === overlay) close(); }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onBackdrop);
    function close() { settingsOpen = false; overlay.hidden = true; modal.className = prevClass; document.removeEventListener("keydown", onKey); overlay.removeEventListener("click", onBackdrop); gear.focus(); }
  }
  document.addEventListener("DOMContentLoaded", () => {
    document.head.append(h("style", null, css));
    gear = h("button", { class: "app-gear", type: "button", onclick: () => openSettings() }, h("i"), h("span", null, "Connect Claude"));
    document.body.append(gear);
    refreshGear();
  });
})();

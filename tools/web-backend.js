// Atlas of All Time — website backend for Ask Claude.
// Gives the shared Connect Claude panel (app-shim.js) the same small interface the
// desktop app provides, but runs in the visitor's browser: the official Anthropic
// SDK is loaded from a pinned CDN build and called with the visitor's own API key.
// The key is kept only in this browser (localStorage when "remember" is ticked,
// otherwise sessionStorage) and is sent only to api.anthropic.com.
(() => {
  "use strict";
  if (window.atlasApp) return;

  const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.13.0/+esm";
  const KEYS_PAGE = "https://console.anthropic.com/settings/keys";
  const MODELS = {
    "claude-opus-5-5": "Opus 5.5 — best writing (about 3 cents a question)",
    "claude-sonnet-5-5": "Sonnet 5.5 — balanced (about 1 cent a question)",
    "claude-haiku-5-5": "Haiku 5.5 — fastest, cheapest (under 0.1 cent a question)",
  };
  const DEFAULT_MODEL = "claude-opus-5-5";
  const K_KEY = "atlas.apiKey", K_MODEL = "atlas.model";

  const read = (k) => { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch { return null; } };
  const write = (k, v, remember) => {
    try {
      localStorage.removeItem(k); sessionStorage.removeItem(k);
      if (v != null) (remember ? localStorage : sessionStorage).setItem(k, v);
      return true;
    } catch { return false; }
  };
  const remembered = () => { try { return !!localStorage.getItem(K_KEY); } catch { return false; } };
  const model = () => (MODELS[read(K_MODEL)] ? read(K_MODEL) : DEFAULT_MODEL);

  let sdkPromise = null;
  const loadSdk = () => (sdkPromise = sdkPromise || import(SDK_URL).then((m) => m.default || m.Anthropic).catch((e) => { sdkPromise = null; throw e; }));
  const clientFor = async (key) => { const Anthropic = await loadSdk(); return { Anthropic, client: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }) }; };

  function errorResult(err, Anthropic) {
    if (!Anthropic) return { ok: false, code: "offline", message: "Couldn't load the Claude library. Check your internet connection." };
    if (err instanceof Anthropic.APIUserAbortError) return { ok: false, code: "cancelled", message: "Stopped" };
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, code: "invalid_key", message: err.message };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, code: "rate_limited", message: err.message };
    if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) return { ok: false, code: "api_error", message: (err.error && err.error.error && err.error.error.message) || err.message };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, code: "offline", message: err.message };
    if (err instanceof Anthropic.APIError) return { ok: false, code: "upstream_error", message: err.message };
    return { ok: false, code: "upstream_error", message: String((err && err.message) || err) };
  }

  const running = new Map();
  window.atlasApp = {
    kind: "web",
    async ask(id, prompt, onText) {
      const key = read(K_KEY);
      if (!key) return { ok: false, code: "no_key", message: "No API key" };
      let Anthropic = null;
      const ctl = new AbortController();
      running.set(id, ctl);
      let text = "";
      try {
        const c = await clientFor(key); Anthropic = c.Anthropic;
        const stream = c.client.beta.messages.stream({
          model: model(),
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          messages: [{ role: "user", content: String(prompt).slice(0, 200000) }],
        }, { signal: ctl.signal });
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") { text += ev.delta.text; onText(text); }
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === "refusal") return { ok: false, code: "refused", message: "Declined" };
        return { ok: true, text, truncated: msg.stop_reason === "max_tokens" };
      } catch (err) {
        return errorResult(err, Anthropic);
      } finally {
        running.delete(id);
      }
    },
    abort(id) { const c = running.get(id); if (c) c.abort(); },
    async settings() {
      return { hasKey: !!read(K_KEY), fromEnv: false, model: model(), models: MODELS, canEncrypt: true, remember: remembered() };
    },
    async setKey(key, remember) {
      key = String(key || "").trim();
      if (!key) return { ok: false, message: "Paste a key first." };
      let Anthropic = null;
      try { const c = await clientFor(key); Anthropic = c.Anthropic; await c.client.models.retrieve(DEFAULT_MODEL); }
      catch (err) {
        const r = errorResult(err, Anthropic);
        if (r.code === "invalid_key") return { ok: false, message: "Anthropic didn't accept that key. Check you copied all of it." };
        if (r.code === "offline") return { ok: false, message: "Can't reach Anthropic to check the key. Check your internet connection." };
      }
      if (!write(K_KEY, key, !!remember)) return { ok: false, message: "This browser is blocking storage, so the key couldn't be saved." };
      return { ok: true };
    },
    async clearKey() { write(K_KEY, null); return this.settings(); },
    async setModel(m) { if (MODELS[m]) write(K_MODEL, m, true); return this.settings(); },
    openKeysPage() { window.open(KEYS_PAGE, "_blank", "noopener"); },
  };
})();

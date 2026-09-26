// POST /api/sample — asks the configured language model on behalf of the page, under a daily cap.
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   LLM_API_KEY    required. Your provider key (kept server-side, never sent to the browser).
//   LLM_BASE_URL   OpenAI-compatible base URL. Default: https://api.tokenrouter.com/v1
//   LLM_MODEL      model name. Default: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
//   LLM_MODEL_QUICK optional cheaper/faster model for "quick" calls.
//   LLM_API_STYLE  "openai" (default) or "anthropic" (native Anthropic Messages API).
//   FALLBACK_API_KEY / FALLBACK_BASE_URL / FALLBACK_MODEL: optional second OpenAI-compatible provider, tried if the first fails.
//   QUOTA_SECRET   shared secret for the Supabase take_quota() function.
//   DAILY_PER_VISITOR (default 8) and DAILY_TOTAL (default 150): the caps.
const crypto = require("crypto");

const SUPABASE_URL = "https://wfwuphdhaxwzsydnamms.supabase.co";
const SUPABASE_KEY = "sb_publishable_kbqZRUu-EFsb-ww3xyYOlw_30vSf7MN";
const IMG_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function fail(res, status, code, message) { res.status(status).json({ code, message }); }

async function takeQuota(ip) {
  const perIp = parseInt(process.env.DAILY_PER_VISITOR || "8", 10);
  const total = parseInt(process.env.DAILY_TOTAL || "150", 10);
  const hash = crypto.createHash("sha256").update(ip + "|" + (process.env.QUOTA_SECRET || "")).digest("hex").slice(0, 32);
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/take_quota", {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ p_secret: process.env.QUOTA_SECRET || "", p_ip: hash, per_ip: perIp, global_cap: total }),
    });
    return await r.json();
  } catch (e) { return { ok: false, reason: "unavailable" }; }
}

function stripThinking(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}


async function openaiChat(p, msgs) {
  try {
    const r = await fetch(p.base.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + p.key, "content-type": "application/json" },
      body: JSON.stringify({ model: p.model, messages: msgs, max_tokens: 6000, temperature: 0.8 }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = Array.isArray(data) ? data[0] && data[0].error : data.error;
      return { status: r.status, message: (e && (e.message || e)) || r.statusText };
    }
    const choice = (data.choices || [])[0] || {};
    const c = choice.message && choice.message.content;
    const text = stripThinking(Array.isArray(c) ? c.map(x => x.text || "").join("") : c || "");
    return text ? { text, truncated: choice.finish_reason === "length" } : { status: 502, message: "empty reply" };
  } catch (e) { return { status: 502, message: "unreachable" }; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "invalid_request", "Use POST.");
  const key = process.env.LLM_API_KEY;
  if (!key) return fail(res, 503, "sampling_disabled", "The site has no model key configured.");

  const b = req.body || {};
  let messages = null;
  if (typeof b.input === "string" && b.input.trim()) messages = [{ role: "user", content: b.input }];
  else if (Array.isArray(b.input)) messages = b.input.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content).map(m => ({ role: m.role, content: m.content }));
  if (!messages || !messages.length || messages[messages.length - 1].role !== "user") return fail(res, 400, "invalid_request", "Send a prompt.");
  if (JSON.stringify(messages).length > 70000) return fail(res, 413, "prompt_too_large", "The prompt is too long.");
  const images = Array.isArray(b.images) ? b.images.slice(0, 2) : [];
  if (images.some(u => typeof u !== "string" || u.length > 8_000_000 || !IMG_RE.test(u))) return fail(res, 400, "image_rejected", "Images must be JPEG, PNG, WebP or GIF under about 6 MB.");

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "unknown";
  const q = await takeQuota(ip);
  if (!q || q.ok !== true) {
    const why = q && q.reason === "global" ? "The site has used today's allowance of Claude-powered deductions. Try again tomorrow." : q && q.reason === "ip" ? "You've used today's allowance of deductions on this site. Try again tomorrow." : "The deduction service is unavailable just now.";
    return fail(res, 429, "rate_limited", why);
  }

  const system = b.json
    ? "Your reply will be parsed by a program. Reply with only the single JSON value requested: no explanations, no markdown, no code fences."
    : "Reply in plain text.";
  const style = (process.env.LLM_API_STYLE || "openai").toLowerCase();
  const model = (b.tier === "quick" && process.env.LLM_MODEL_QUICK) || process.env.LLM_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";

  try {
    let text = "", truncated = false;
    if (style === "anthropic") {
      const msgs = messages.map((m, i) => {
        if (i !== messages.length - 1 || !images.length) return m;
        const blocks = images.map(u => { const [, mt, data] = u.match(/^data:(image\/\w+);base64,(.*)$/); return { type: "image", source: { type: "base64", media_type: mt, data } }; });
        return { role: "user", content: [...blocks, { type: "text", text: m.content }] };
      });
      const r = await fetch((process.env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 3000, system, messages: msgs }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return fail(res, r.status === 429 ? 429 : 502, r.status === 429 ? "rate_limited" : "upstream_error", (data.error && data.error.message) || r.statusText);
      text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      truncated = data.stop_reason === "max_tokens";
    } else {
      const msgs = [{ role: "system", content: system }, ...messages];
      if (images.length) {
        const last = msgs[msgs.length - 1];
        msgs[msgs.length - 1] = { role: "user", content: [{ type: "text", text: last.content }, ...images.map(u => ({ type: "image_url", image_url: { url: u } }))] };
      }
      const providers = [{ key, base: process.env.LLM_BASE_URL || "https://api.tokenrouter.com/v1", model }];
      if (process.env.FALLBACK_API_KEY) providers.push({ key: process.env.FALLBACK_API_KEY, base: process.env.FALLBACK_BASE_URL || "https://api.tokenrouter.com/v1", model: process.env.FALLBACK_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" });
      let lastErr = null;
      for (const p of providers) {
        const out = await openaiChat(p, msgs);
        if (out.text) { text = out.text; truncated = out.truncated; lastErr = null; break; }
        lastErr = out; console.error("provider failed", p.base, p.model, out.status, out.message);
      }
      if (lastErr) return fail(res, lastErr.status === 429 ? 429 : 502, lastErr.status === 429 ? "rate_limited" : /image|vision|multimodal/i.test(String(lastErr.message)) ? "images_unavailable" : "upstream_error", String(lastErr.message || "The model couldn't answer."));
    }
    text = stripThinking(text);
    if (!text) return fail(res, 502, "empty_completion", "The model returned nothing.");
    res.status(200).json({ text, truncated });
  } catch (e) {
    fail(res, 502, "upstream_error", "The model couldn't be reached.");
  }
};

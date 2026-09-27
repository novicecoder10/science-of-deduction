// Local development server for The Science of Deduction.
// Serves the site and runs api/sample.js the way Vercel does, with the same /_blob rewrites.
// Usage: copy .env.example to .env, fill in your keys, then `npm run dev` (Node 18 or later).
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
// minimal .env loader (no dependencies)
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const handler = require("./api/sample.js");
const SUPABASE_PUBLIC = "https://wfwuphdhaxwzsydnamms.supabase.co/storage/v1/object/public/tour/";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8" };

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "content-length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);

  if (p === "/api/sample") {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on("end", async () => {
      try { req.body = raw ? JSON.parse(raw) : {}; } catch (_) { req.body = {}; }
      const wrap = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(o) { res.writeHead(this.statusCode, { "content-type": "application/json" }); res.end(JSON.stringify(o)); },
      };
      try { await handler(req, wrap); } catch (e) { console.error(e); if (!res.headersSent) { res.writeHead(500); res.end("{}"); } }
    });
    return;
  }
  if (p.startsWith("/_blob/static/")) p = "/tour/" + p.slice("/_blob/static/".length);
  else if (p.startsWith("/_blob/")) { res.writeHead(302, { location: SUPABASE_PUBLIC + p.slice("/_blob/".length) }); return res.end(); }
  if (p === "/" || p === "") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || /[\\/]\.(env|git)/.test(file)) { res.writeHead(403); return res.end(); }
  sendFile(res, fs.existsSync(file) ? file : file + ".html");
}).listen(PORT, () => {
  console.log(`The Science of Deduction → http://localhost:${PORT}`);
  if (!process.env.LLM_API_KEY) console.log("Note: LLM_API_KEY is not set in .env, so Summon and photo reading will say they're unavailable.");
});

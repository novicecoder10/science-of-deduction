/*
 * claude-shim.js — lets the page run outside claude.ai.
 * It provides the same small API the page was written against (window.claude.use)
 * and backs it with:
 *   sample  → /api/sample (a Vercel function that calls your LLM with your key, under a daily cap)
 *   db      → a Supabase table of JSON documents (the shared casebook and the photo tour)
 *   assets  → Supabase Storage (tour photographs), for the signed-in editor only
 */
(function () {
  "use strict";
  var SUPABASE_URL = "https://wfwuphdhaxwzsydnamms.supabase.co";
  var SUPABASE_KEY = "sb_publishable_kbqZRUu-EFsb-ww3xyYOlw_30vSf7MN";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  var session = null;
  var ready = sb.auth.getSession().then(function (r) { session = r.data.session; }).catch(function () {});
  sb.auth.onAuthStateChange(function (_e, s) { session = s; renderEditorBar(); });

  /* ---------------- sample ---------------- */
  function downscale(blob) {
    return (window.createImageBitmap ? createImageBitmap(blob) : Promise.reject()).then(function (bmp) {
      var s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", .86);
    }).catch(function () {
      return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsDataURL(blob); });
    });
  }
  function parseJSON(t) {
    try { return JSON.parse(t); } catch (_) {}
    var f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (_) {} }
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
    throw { code: "invalid_json", message: "The reply held no JSON.", text: t };
  }
  function call(input, opts, json) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) return Promise.reject({ code: "cancelled", message: "cancelled" });
    var body = { input: input, json: !!json, tier: opts.modelTier || "default" };
    var imgs = opts.images ? (opts.images instanceof Blob ? [opts.images] : Array.prototype.slice.call(opts.images)) : [];
    return Promise.all(imgs.slice(0, 2).map(downscale)).then(function (urls) {
      if (urls.length) body.images = urls;
      return fetch("/api/sample", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: opts.signal });
    }).catch(function (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled", message: "cancelled" };
      if (e && e.code) throw e;
      throw { code: "upstream_error", message: String(e) };
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw { code: data.code || "upstream_error", message: data.message || res.statusText };
        var text = data.text || "";
        if (opts.onText) { try { opts.onText({ text: text, delta: text }); } catch (_) {} }
        return json ? parseJSON(text) : { text: text, truncated: !!data.truncated, modelTierApplied: body.tier };
      });
    });
  }
  var sample = function (input, opts) { return call(input, opts, false); };
  sample.json = function (input, opts) { return call(input, opts, true); };
  sample.limits = function () { return Promise.resolve({ maxPromptBytes: 65536, images: { maxCount: 2, maxInputBytes: 20 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } }); };

  /* ---------------- db ---------------- */
  var listeners = [];
  function snapDoc(row) { var d = row.data; return { id: row.id, exists: true, data: function () { return d; }, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function fetchRows(collection) {
    return sb.from("docs").select("id,data,created_at").eq("collection", collection).limit(1000).then(function (r) {
      if (r.error) throw { code: "unavailable", message: r.error.message };
      return r.data || [];
    });
  }
  function toSnap(rows, order, lim) {
    var r = rows.slice();
    if (order) r.sort(function (a, b) { var x = a.data[order.f], y = b.data[order.f], c = x < y ? -1 : x > y ? 1 : 0; return order.dir === "desc" ? -c : c; });
    if (lim) r = r.slice(0, lim);
    var docs = r.map(snapDoc);
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function refresh(l) { fetchRows(l.collection).then(function (rows) { l.next(toSnap(rows, l.order, l.lim)); }).catch(function () {}); }
  function notify(collection) { listeners.forEach(function (l) { if (l.collection === collection) refresh(l); }); }
  function query(collection, order, lim) {
    return {
      path: collection,
      orderBy: function (f, dir) { return query(collection, { f: f, dir: dir || "asc" }, lim); },
      limit: function (n) { return query(collection, order, n); },
      where: function () { return this; },
      get: function () { return fetchRows(collection).then(function (rows) { return toSnap(rows, order, lim); }); },
      onSnapshot: function (next, err) {
        var l = { collection: collection, order: order, lim: lim, next: next, err: err };
        listeners.push(l); refresh(l);
        l.t = setInterval(function () { if (!document.hidden) refresh(l); }, 15000);
        return function () { clearInterval(l.t); listeners = listeners.filter(function (x) { return x !== l; }); };
      }
    };
  }
  function newId() { return (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20); }
  function errCode(msg) { return /row-level|permission|policy|violates/i.test(msg) ? "invalid_argument" : /full/i.test(msg) ? "quota_exceeded" : "unavailable"; }
  function docRef(collection, id) {
    var ref = {
      id: id, path: collection + "/" + id,
      get: function () { return sb.from("docs").select("id,data").eq("collection", collection).eq("id", id).maybeSingle().then(function (r) { return r.data ? snapDoc(r.data) : { id: id, exists: false, data: function () {} }; }); },
      set: function (obj) {
        return sb.from("docs").insert({ collection: collection, id: id, data: obj }).then(function (r) {
          if (r.error && r.error.code === "23505") return sb.from("docs").update({ data: obj }).eq("collection", collection).eq("id", id);
          return r;
        }).then(function (r) { if (r.error) throw { code: errCode(r.error.message), message: r.error.message }; notify(collection); });
      },
      update: function (patch) {
        return sb.from("docs").select("data").eq("collection", collection).eq("id", id).maybeSingle().then(function (r) {
          if (r.error || !r.data) throw { code: "invalid_argument", message: "That document doesn't exist." };
          var merged = Object.assign({}, r.data.data, patch);
          return sb.from("docs").update({ data: merged }).eq("collection", collection).eq("id", id).select("id");
        }).then(function (r) {
          if (r.error) throw { code: errCode(r.error.message), message: r.error.message };
          if (!r.data || !r.data.length) throw { code: "invalid_argument", message: "Not allowed." };
          notify(collection);
        });
      },
      delete: function () { return sb.from("docs").delete().eq("collection", collection).eq("id", id).then(function (r) { if (r.error) throw { code: errCode(r.error.message), message: r.error.message }; notify(collection); }); }
    };
    return ref;
  }
  var db = {
    collection: function (path) {
      var q = query(path, null, null);
      q.doc = function (id) { return docRef(path, id || newId()); };
      q.add = function (d) { var r = docRef(path, newId()); return r.set(d).then(function () { return r; }); };
      return q;
    },
    doc: function (path) { var p = path.split("/"); return docRef(p[0], p[1]); }
  };

  /* ---------------- assets (editor only) ---------------- */
  var EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  var assets = {
    upload: function (blob, opts) {
      var type = (opts && opts.type) || blob.type || "image/jpeg";
      if (!EXT[type]) return Promise.reject({ code: "unsupported_type", message: "Use a JPEG, PNG or WebP image." });
      var id = newId() + "." + EXT[type];
      return sb.storage.from("tour").upload(id, blob, { contentType: type, upsert: false }).then(function (r) {
        if (r.error) throw { code: /size|large/i.test(r.error.message) ? "too_large" : /mime|type/i.test(r.error.message) ? "unsupported_type" : /row-level|policy|unauthor/i.test(r.error.message) ? "not_granted" : "upstream_error", message: r.error.message };
        return { id: id, url: "/_blob/" + id, sizeBytes: blob.size, contentType: type };
      });
    },
    delete: function (ref) {
      var id = String(ref).replace(/^\/?_blob\//, "");
      if (id.indexOf("static/") === 0) return Promise.resolve({ deleted: false });
      return sb.storage.from("tour").remove([id]).then(function (r) { if (r.error) throw { code: "upstream_error", message: r.error.message }; return { deleted: true }; });
    },
    list: function () { return Promise.resolve({ assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } }); }
  };

  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === "sample") return sample;
        if (name === "db") return db;
        if (name === "assets") return session ? assets : null;
        return null;
      });
    }
  };

  /* ---------------- editor sign-in ---------------- */
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs || {}) n.setAttribute(k, attrs[k]); if (text) n.textContent = text; return n; }
  function renderEditorBar() {
    var bar = document.getElementById("editor-bar"); if (!bar) return;
    bar.textContent = "";
    if (session && session.user) {
      bar.append(el("span", {}, "Signed in as editor (" + session.user.email + ") · "));
      var out = el("button", { type: "button", class: "linkish" }, "Sign out");
      out.onclick = function () { sb.auth.signOut().then(function () { location.reload(); }); };
      bar.append(out);
    } else {
      var b = el("button", { type: "button", class: "linkish" }, "Editor sign-in");
      b.onclick = openDialog; bar.append(b);
    }
  }
  function openDialog() {
    var d = document.getElementById("editor-dialog");
    if (!d) {
      d = el("dialog", { id: "editor-dialog", class: "editor-dialog" });
      d.innerHTML = '<form method="dialog" id="editor-form"><h3>Editor sign-in</h3><p>Only the site\'s editor can add photographs to the tour.</p>' +
        '<label>Email <input type="email" id="ed-email" required autocomplete="username"></label>' +
        '<label>Password <input type="password" id="ed-pass" required minlength="8" autocomplete="current-password"></label>' +
        '<p class="ed-msg" id="ed-msg"></p><div class="ed-row"><button type="submit" class="btn small" id="ed-in">Sign in</button>' +
        '<button type="button" class="btn ghost small" id="ed-up">Create the editor account</button><button type="button" class="btn ghost small" id="ed-close">Close</button></div></form>';
      document.body.append(d);
      var msg = function (t) { document.getElementById("ed-msg").textContent = t; };
      document.getElementById("ed-close").onclick = function () { d.close(); };
      document.getElementById("editor-form").addEventListener("submit", function (e) {
        e.preventDefault();
        msg("Signing in…");
        sb.auth.signInWithPassword({ email: document.getElementById("ed-email").value.trim(), password: document.getElementById("ed-pass").value }).then(function (r) {
          if (r.error) { msg(/confirm/i.test(r.error.message) ? "Confirm your email first: open the link Supabase sent you, then sign in here." : "That email and password didn't match."); return; }
          location.reload();
        });
      });
      document.getElementById("ed-up").onclick = function () {
        var em = document.getElementById("ed-email").value.trim(), pw = document.getElementById("ed-pass").value;
        if (!em || pw.length < 8) { msg("Enter your email and a password of at least 8 characters."); return; }
        msg("Creating the account…");
        sb.auth.signUp({ email: em, password: pw }).then(function (r) {
          msg(r.error ? r.error.message : "Check your inbox and open the confirmation link. It may land on a blank page; that's fine. Then come back and sign in.");
        });
      };
    }
    try { d.showModal(); } catch (_) { d.setAttribute("open", ""); }
  }
  document.addEventListener("DOMContentLoaded", renderEditorBar);
})();

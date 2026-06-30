// Applyin Extension - Service Worker v5
import { CONFIG } from "../config.module.js";
// Logging helper
const log = {
  info: (...a) => console.log('[Applyin SW]', ...a),
  ok: (...a) => console.log('[Applyin SW] ✓', ...a),
  warn: (...a) => console.warn('[Applyin SW] ⚠', ...a),
  error: (...a) => console.error('[Applyin SW] ✗', ...a),
};
// All AI calls go through the Applyin backend.
// OpenAI key is never in the extension.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Backend API ───────────────────────────────────────────────────────────────
// Render backend URL (from central config)
const API_BASE = CONFIG.API_BASE;

async function apiCall(path, method = "GET", body = null) {
  const t0 = Date.now();
  const { auth_token } = await chrome.storage.local.get("auth_token");
  const headers = { "Content-Type": "application/json" };
  if (auth_token) headers["Authorization"] = `Bearer ${auth_token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } catch (e) {
    // Network error or CORS - backend not reachable
    log.error('API unreachable:', e.message);
    throw new Error("BACKEND_UNREACHABLE");
  }

  // Token expired - clear it
  // 401 on an authenticated call = saved token expired → clear it.
  // 401 on login/signup = bad credentials → let the backend's message through.
  if (res.status === 401) {
    const isAuthAttempt = path.includes("/auth/login") || path.includes("/auth/signup");
    if (!isAuthAttempt) {
      await chrome.storage.local.remove(["auth_token", "user"]);
      throw new Error("SESSION_EXPIRED");
    }
    // fall through - read the backend's actual error (e.g. "Invalid email or password")
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`API error ${res.status}`);
  }
  if (!res.ok) {
    // Carry the structured detail object so callers can read a 422 rejection
    // (e.g. { code, message, pages_parsed, word_count }) rather than a flat string.
    const err = new Error(
      (data.detail && data.detail.message) ||
      (typeof data.detail === "string" ? data.detail : `API error ${res.status}`)
    );
    err.detail = data.detail;
    err.status = res.status;
    throw err;
  }
  return data;
}

// Cold-start-tolerant variant of apiCall. Same logic, but the fetch gets a long
// timeout (up to ~90s) so a sleeping Render instance waking up does NOT fail
// instantly as BACKEND_UNREACHABLE. Used for the analysis call.
async function apiCallLong(path, method = "GET", body = null) {
  const { auth_token } = await chrome.storage.local.get("auth_token");
  const headers = { "Content-Type": "application/json" };
  if (auth_token) headers["Authorization"] = `Bearer ${auth_token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000); // 90s for cold start + analysis
  opts.signal = ctrl.signal;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, opts);
  } catch (e) {
    log.error('API unreachable (long):', e.message);
    throw new Error("BACKEND_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    const isAuthAttempt = path.includes("/auth/login") || path.includes("/auth/signup");
    if (!isAuthAttempt) {
      await chrome.storage.local.remove(["auth_token", "user"]);
      throw new Error("SESSION_EXPIRED");
    }
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`API error ${res.status}`); }
  if (!res.ok) {
    const err = new Error(
      (data.detail && data.detail.message) ||
      (typeof data.detail === "string" ? data.detail : `API error ${res.status}`));
    err.detail = data.detail; err.status = res.status;
    throw err;
  }
  return data;
}

// Wake a sleeping Render instance: hit /health and wait until it answers (or
// time out). Returns when the backend is responsive so the next call succeeds.
async function wakeBackend() {
  const deadline = Date.now() + 75000; // try for up to 75s
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${API_BASE}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) { log.ok('Backend awake'); return true; }
    } catch (_) { /* still waking - wait and retry */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  log.warn('Backend did not wake within timeout');
  return false;
}
async function sha(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function cacheKey(jobData, resumeB64) {
  const jobPart = (jobData.title + "|" + jobData.company + "|" + jobData.description);
  const resumePart = resumeB64 ? await sha(resumeB64) : "NO_RESUME";
  const full = await sha(jobPart + "|" + resumePart);
  return "cache_" + full.slice(0, 40);
}
async function getCached(key) {
  const s = await chrome.storage.local.get(key);
  const e = s[key];
  if (!e || Date.now() - e.ts > CACHE_TTL_MS) { if (e) chrome.storage.local.remove(key); return null; }
  return { ...e.data, cached: true };
}
async function setCache(key, data) {
  await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
}

// ── Message handler ───────────────────────────────────────────────────────────
// Notify any open LinkedIn tabs that auth state changed, so the in-page
// sidebar refreshes without a reload after a popup login/signup.
function broadcastSessionChanged() {
  chrome.tabs.query({ url: "https://www.linkedin.com/*" }, tabs => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: "SESSION_CHANGED" }, () => chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // ── Auth ───────────────────────────────────────────────────────────────────
  if (msg.type === "LOGIN") {
    apiCall("/auth/login", "POST", { email: msg.email, password: msg.password })
      .then(async data => {
        log.ok('Login success:', data.email, '| credits:', data.credits);
        await chrome.storage.local.set({
          auth_token: data.access_token,
          refresh_token: data.refresh_token,
          user: { id: data.user_id, email: data.email, credits: data.credits }
        });
        broadcastSessionChanged();
        sendResponse({ ok: true, ...data });
      })
      .catch(e => {
        const msg = e.message === "BACKEND_UNREACHABLE"
          ? "Cannot reach Applyin server. Make sure the backend is deployed."
          : e.message;
        sendResponse({ ok: false, error: msg });
      });
    return true;
  }

  if (msg.type === "SIGNUP") {
    apiCall("/auth/signup", "POST", { email: msg.email, password: msg.password, is_adult: true, consent: msg.consent === true })
      .then(async data => {
        // Email-confirmation flow: the account is created but NOT yet confirmed, so
        // the backend returns pending=true and NO session tokens. This is success,
        // but the user must confirm their email and then sign in. Do not store
        // tokens or report a logged-in session; surface the friendly pending state.
        if (data && data.pending) {
          log.ok('Signup pending email confirmation:', data.email);
          sendResponse({ ok: false, pending: true, message: data.message || "Check your inbox to confirm your email, then sign in to start." });
          return;
        }
        log.ok('Signup success:', data.email, '| credits:', data.credits);
        await chrome.storage.local.set({
          auth_token: data.access_token,
          refresh_token: data.refresh_token,
          user: { id: data.user_id, email: data.email, credits: data.credits }
        });
        broadcastSessionChanged();
        sendResponse({ ok: true, ...data });
      })
      .catch(e => {
        // (Legacy) 503 "confirm your email" path - also treated as pending.
        const raw = e.message || "";
        if (/almost there|confirm your email|check your inbox/i.test(raw)) {
          sendResponse({ ok: false, pending: true, message: raw });
          return;
        }
        const msg = raw === "BACKEND_UNREACHABLE"
          ? "Cannot reach Applyin server. Make sure the backend is deployed."
          : raw;
        sendResponse({ ok: false, error: msg });
      });
    return true;
  }

  if (msg.type === "LOGOUT") {
    chrome.storage.local.remove(["auth_token", "refresh_token", "user", "resume_b64_0", "resume_b64_chunks", "resume_name"])
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "GET_SESSION") {
    chrome.storage.local.get(["auth_token", "user"]).then(async s => {
      if (!s.auth_token || !s.user) {
        sendResponse({ loggedIn: false, user: null });
        return;
      }
      // Validate token + fetch fresh credits from server
      try {
        const me = await apiCall("/auth/me");
        const freshUser = { id: me.user_id, email: me.email, credits: me.credits };
        await chrome.storage.local.set({ user: freshUser });
        log.ok('Session valid, fresh credits:', me.credits);
        sendResponse({ loggedIn: true, user: freshUser });
      } catch (e) {
        // Token expired - try refresh
        log.warn('Token check failed, attempting refresh:', e.message);
        const { refresh_token } = await chrome.storage.local.get("refresh_token");
        if (refresh_token) {
          try {
            const refreshed = await apiCall("/auth/refresh", "POST", { refresh_token });
            await chrome.storage.local.set({
              auth_token: refreshed.access_token,
              refresh_token: refreshed.refresh_token
            });
            const me = await apiCall("/auth/me");
            const freshUser = { id: me.user_id, email: me.email, credits: me.credits };
            await chrome.storage.local.set({ user: freshUser });
            log.ok('Token refreshed, credits:', me.credits);
            sendResponse({ loggedIn: true, user: freshUser });
            return;
          } catch (re) {
            log.warn('Refresh failed:', re.message);
          }
        }
        // Refresh failed - fall back to cached session (stay logged in, show cached credits)
        sendResponse({ loggedIn: true, user: s.user });
      }
    });
    return true;
  }

  if (msg.type === "GET_CREDITS") {
    apiCall("/credits/balance")
      .then(async data => {
        // Update cached user object
        const { user } = await chrome.storage.local.get("user");
        if (user) await chrome.storage.local.set({ user: { ...user, credits: data.credits } });
        sendResponse({ credits: data.credits });
      })
      .catch(e => sendResponse({ credits: null, error: e.message }));
    return true;
  }

  if (msg.type === "GET_PACKAGES") {
    // Public endpoint - no auth, manual timeout for Render cold start compatibility
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 28000); // 28s timeout
    fetch(`${API_BASE}/credits/packages`, { signal: ctrl.signal })
      .then(r => { clearTimeout(t); return r.json(); })
      .then(data => sendResponse(data))
      .catch(e => { clearTimeout(t); sendResponse({ error: e.message, packages: null }); });
    return true;
  }

  if (msg.type === "CREATE_ORDER") {
    // Creates a Razorpay Payment Link - opens in browser tab, zero CSP issues
    apiCall("/credits/order", "POST", { package_id: msg.package_id, currency: msg.currency || "INR" })
      .then(data => {
        if (data.payment_url) {
          // Open payment page in a new browser tab
          chrome.tabs.create({ url: data.payment_url });
        }
        sendResponse({ ok: true, ...data });
      })
      .catch(e => {
        const errMsg = e.message === "BACKEND_UNREACHABLE"
          ? "Cannot reach Applyin server. Make sure the backend is deployed."
          : e.message;
        sendResponse({ ok: false, error: errMsg });
      });
    return true;
  }

  // ── Analysis (storage-based - SW responds immediately, stores result when done) ──
  if (msg.type === "ANALYZE_JOB") {
    const analysisId = Date.now().toString();
    chrome.storage.local.set({ analysis_status: "running", analysis_id: analysisId });
    sendResponse({ ok: true, analysisId });
    log.info('Analysis job started, id:', analysisId, '| job:', msg.payload?.title, '| resume:', msg.resumeB64 ? 'YES (' + Math.round(msg.resumeB64.length / 1024) + 'KB)' : 'NO');
    startKeepAlive();
    // resumeB64 passed directly from content script - more reliable than SW storage read
    handleAnalyze(msg.payload, !!msg.forceRefresh, msg.resumeB64 || null)
      .then(result => {
        stopKeepAlive();
        // Resume gate rejection - store a typed error string the content script
        // can render as a clear message. No analysis output exists.
        if (result && result.error === "RESUME_REJECTED") {
          log.warn('Resume rejected:', result.reject?.code, result.reject?.message);
          chrome.storage.local.set({
            analysis_status: "error",
            analysis_id: analysisId,
            analysis_error: "RESUME_REJECTED::" + (result.reject?.message || "We couldn't read that resume.")
          });
          return;
        }
        if (result && result.error) {
          log.error('Analysis returned error:', result.error);
          chrome.storage.local.set({
            analysis_status: "error",
            analysis_id: analysisId,
            analysis_error: result.error
          });
          return;
        }
        log.ok('Analysis complete, score:', result?.match_score, '| fit:', result?.fit_level, '| storing result...');
        chrome.storage.local.set({
          analysis_status: "done",
          analysis_id: analysisId,
          analysis_result: JSON.stringify(result),
          analysis_ts: Date.now()
        });
      })
      .catch(e => {
        stopKeepAlive();
        log.error('Analysis failed:', e.message);
        chrome.storage.local.set({
          analysis_status: "error",
          analysis_id: analysisId,
          analysis_error: e.message
        });
      });
    return true;
  }

  if (msg.type === "GET_RESUME_STATUS") {
    chrome.storage.local.get(["resume_b64_0", "resume_b64_chunks", "resume_name"]).then(s => {
      const has = !!(s.resume_b64_chunks > 0 && s.resume_b64_0);
      sendResponse({ hasResume: has, isPDF: has, name: s.resume_name || null });
    });
    return true;
  }

  if (msg.type === "GET_RESUME_B64") {
    // Reassemble the full resume from the stable SW context. Used as a fallback when
    // the content script's own storage read returns empty (stale page context after
    // a LinkedIn SPA job change), so the loaded resume is reused, not lost.
    chrome.storage.local.get(["resume_b64_chunks"]).then(meta => {
      const n = parseInt(meta.resume_b64_chunks) || 0;
      if (n === 0) { sendResponse({ b64: null }); return; }
      const keys = Array.from({ length: n }, (_, i) => "resume_b64_" + i);
      chrome.storage.local.get(keys).then(data => {
        const b64 = keys.map(k => data[k] || "").join("");
        sendResponse({ b64: b64.length > 100 ? b64 : null });
      });
    });
    return true;
  }

  if (msg.type === "CLEAR_JOB_CACHE") {
    chrome.storage.local.get(null, all => {
      const keys = Object.keys(all).filter(k => k.startsWith("cache_"));
      chrome.storage.local.remove(keys, () => sendResponse({ cleared: keys.length }));
    });
    return true;
  }
});

// Keep SW alive during long operations (OpenAI calls can take 15-30s)
// Use multiple strategies to prevent Chrome from killing the SW
let keepAliveInterval = null;
function startKeepAlive() {
  stopKeepAlive();
  // Ping storage every 5s to keep SW active
  keepAliveInterval = setInterval(() => {
    chrome.storage.local.get("__ping", () => { chrome.runtime.lastError; });
    // Also fetch a tiny request to keep network context alive
  }, 5000);
}
function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Re-register SW when it wakes up
self.addEventListener('activate', () => {
  log.info('Service worker activated');
});

async function handleAnalyze(jobData, forceRefresh, resumeOverride) {
  // 1. Check session
  const { auth_token, user } = await chrome.storage.local.get(["auth_token", "user"]);
  if (!auth_token) return { error: "NOT_LOGGED_IN" };

  // 2. Resume - use override from content script (most reliable) or fall back to storage
  let resumeB64 = resumeOverride || null;

  if (!resumeB64) {
    // Fallback: read from storage in SW
    const chunkMeta = await chrome.storage.local.get(["resume_b64_chunks"]);
    const numChunks = parseInt(chunkMeta.resume_b64_chunks) || 0;
    if (numChunks > 0) {
      const chunkKeys = Array.from({ length: numChunks }, (_, i) => "resume_b64_" + i);
      const chunkData = await chrome.storage.local.get(chunkKeys);
      const assembled = chunkKeys.map(k => chunkData[k] || "").join("");
      if (assembled.length > 100) resumeB64 = assembled;
    }
  }
  log.info('handleAnalyze: resume =', resumeB64 ? resumeB64.length + ' chars' : 'NONE', '| job:', jobData.title);

  // 3. Check local cache first (saves credits) - keyed on full resume hash
  const key = await cacheKey(jobData, resumeB64);
  if (!forceRefresh) {
    const cached = await getCached(key);
    if (cached) return { ...cached, credits_used: 0 };
  }

  // 4. Call backend (backend holds OpenAI key, deducts credit).
  //    Render free tier sleeps after inactivity and cold-starts in ~50s. A naive
  //    fetch fails instantly as BACKEND_UNREACHABLE. So: try once; if unreachable,
  //    wake the instance (/health with a long timeout) and retry the analysis.
  try {
    let result;
    try {
      result = await apiCallLong("/analyze/job", "POST", {
        job: jobData, resume_b64: resumeB64, force_refresh: forceRefresh,
      });
    } catch (e1) {
      if (e1.message === "BACKEND_UNREACHABLE") {
        log.warn('Backend asleep - waking and retrying...');
        await wakeBackend();                 // blocks until /health responds or times out
        result = await apiCallLong("/analyze/job", "POST", {
          job: jobData, resume_b64: resumeB64, force_refresh: forceRefresh,
        });
      } else {
        throw e1;
      }
    }

    if (!result) throw new Error("Analysis returned no result");
    await setCache(key, result);

    // Update local credit count
    if (result.credits_remaining !== undefined && user) {
      await chrome.storage.local.set({ user: { ...user, credits: result.credits_remaining } });
    }

    return result;
  } catch (e) {
    if (e.message === "INSUFFICIENT_CREDITS") return { error: "INSUFFICIENT_CREDITS" };
    if (e.message === "SESSION_EXPIRED") return { error: "NOT_LOGGED_IN" };
    // Resume gate rejection - backend sends a structured 422 detail object.
    if (e.status === 422 && e.detail && e.detail.code) {
      return { error: "RESUME_REJECTED", reject: e.detail };
    }
    throw e;
  }
}

// Applyin Extension — Service Worker v4
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
// Render backend URL
const API_BASE = "https://applyin-backend.onrender.com";

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
    // Network error or CORS — backend not reachable
    log.error('API unreachable:', e.message);
    throw new Error("BACKEND_UNREACHABLE");
  }

  // Token expired — clear it
  // 401 on an authenticated call = saved token expired → clear it.
  // 401 on login/signup = bad credentials → let the backend's message through.
  if (res.status === 401) {
    const isAuthAttempt = path.includes("/auth/login") || path.includes("/auth/signup");
    if (!isAuthAttempt) {
      await chrome.storage.local.remove(["auth_token", "user"]);
      throw new Error("SESSION_EXPIRED");
    }
    // fall through — read the backend's actual error (e.g. "Invalid email or password")
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`API error ${res.status}`);
  }
  if (!res.ok) throw new Error(data.detail || `API error ${res.status}`);
  return data;
}

// ── Cache (local, per-device) ─────────────────────────────────────────────────
function cacheKey(jobData, resumeFingerprint) {
  const raw = (jobData.title + jobData.company + jobData.description).slice(0, 160) + (resumeFingerprint || "");
  return "cache_" + btoa(unescape(encodeURIComponent(raw))).slice(0, 40);
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
    apiCall("/auth/signup", "POST", { email: msg.email, password: msg.password })
      .then(async data => {
        log.ok('Signup success:', data.email, '| credits:', data.credits);
        await chrome.storage.local.set({
          auth_token: data.access_token,
          refresh_token: data.refresh_token,
          user: { id: data.user_id, email: data.email, credits: data.credits }
        });
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
        // Token expired — try refresh
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
        // Refresh failed — fall back to cached session (stay logged in, show cached credits)
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
    // Public endpoint — no auth, manual timeout for Render cold start compatibility
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 28000); // 28s timeout
    fetch(`${API_BASE}/credits/packages`, { signal: ctrl.signal })
      .then(r => { clearTimeout(t); return r.json(); })
      .then(data => sendResponse(data))
      .catch(e => { clearTimeout(t); sendResponse({ error: e.message, packages: null }); });
    return true;
  }

  if (msg.type === "WAKE_SERVER") {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 35000);
    fetch(`${API_BASE}/health`, { signal: ctrl.signal })
      .then(r => { clearTimeout(t); return r.json(); })
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(e => { clearTimeout(t); sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  if (msg.type === "CREATE_ORDER") {
    // Creates a Razorpay Payment Link — opens in browser tab, zero CSP issues
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

  if (msg.type === "CREATE_PAYMENT_LINK") {
    // Create a Razorpay Payment Link — hosted page, no JS SDK needed
    apiCall("/credits/create-payment-link", "POST", {
      package_id: msg.package_id,
      currency: "INR"
    })
      .then(data => {
        if (!data.ok || !data.payment_url) throw new Error(data.detail || "No payment URL");
        // Open Razorpay hosted payment page in a new tab
        chrome.tabs.create({ url: data.payment_url, active: true });
        sendResponse({ ok: true, ...data });
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "VERIFY_PAYMENT") {
    // Calls backend verify-payment endpoint with all three Razorpay fields
    // Backend checks HMAC-SHA256 signature — credits only land if it matches
    apiCall("/credits/verify-payment", "POST", {
      razorpay_order_id: msg.razorpay_order_id,
      razorpay_payment_id: msg.razorpay_payment_id,
      razorpay_signature: msg.razorpay_signature,
    })
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Analysis (storage-based — SW responds immediately, stores result when done) ──
  if (msg.type === "ANALYZE_JOB") {
    const analysisId = Date.now().toString();
    chrome.storage.local.set({ analysis_status: "running", analysis_id: analysisId });
    sendResponse({ ok: true, analysisId });
    log.info('Analysis job started, id:', analysisId, '| job:', msg.payload?.title, '| resume:', msg.resumeB64 ? 'YES (' + Math.round(msg.resumeB64.length / 1024) + 'KB)' : 'NO');
    startKeepAlive();
    // resumeB64 passed directly from content script — more reliable than SW storage read
    handleAnalyze(msg.payload, !!msg.forceRefresh, msg.resumeB64 || null)
      .then(result => {
        stopKeepAlive();
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

  if (msg.type === "POLL_ANALYSIS") {
    chrome.storage.local.get(
      ["analysis_status", "analysis_id", "analysis_result", "analysis_error"],
      data => sendResponse(data)
    );
    return true;
  }

  if (msg.type === "GET_RESUME_STATUS") {
    chrome.storage.local.get(["resume_b64_0", "resume_b64_chunks", "resume_name"]).then(s => {
      const has = !!(s.resume_b64_chunks > 0 && s.resume_b64_0);
      sendResponse({ hasResume: has, isPDF: has, name: s.resume_name || null });
    });
    return true;
  }

  if (msg.type === "CLEAR_RESUME") {
    const keys = ["resume_b64_0", "resume_name", "resume_b64_chunks", "resume"];
    for (let i = 1; i <= 20; i++) keys.push("resume_b64_" + i);
    chrome.storage.local.remove(keys).then(() => sendResponse({ ok: true }));
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

  // 2. Resume — use override from content script (most reliable) or fall back to storage
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

  // 3. Check local cache first (saves credits)
  const fp = resumeB64 ? resumeB64.slice(0, 40) : "";
  const key = cacheKey(jobData, fp);
  if (!forceRefresh) {
    const cached = await getCached(key);
    if (cached) return { ...cached, credits_used: 0 };
  }

  // 4. Call backend (backend holds OpenAI key, deducts credit)
  try {
    const result = await apiCall("/analyze/job", "POST", {
      job: jobData,
      resume_b64: resumeB64,
      force_refresh: forceRefresh,
    });

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
    throw e;
  }
}

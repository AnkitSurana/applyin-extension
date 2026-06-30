// Applyin Popup - v2
import { CONFIG } from "../config.module.js";

const API_BASE = CONFIG.API_BASE;
let currentTab = "login";
let sidebarActive = false;

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Set logo icons (CSP-safe - runs from external popup.js)
  try {
    const iconUrl = chrome.runtime.getURL("icons/icon32.png");
    document.querySelectorAll(".popup-logo-img").forEach(img => { img.src = iconUrl; });
  } catch(e) {}

  chrome.runtime.sendMessage({ type: "GET_SESSION" }, res => {
    if (chrome.runtime.lastError || !res?.loggedIn) {
      showView("login");
    } else {
      showView("main");
      populateMain(res.user);
    }
    checkBackendStatus();
  });
}

// ── View switching ────────────────────────────────────────────────────────────
function showView(view) {
  document.getElementById("login-view").style.display = view === "login" ? "block" : "none";
  document.getElementById("main-view").style.display  = view === "main"  ? "block" : "none";
}

// ── Backend status ────────────────────────────────────────────────────────────
async function checkBackendStatus() {
  // Update both views' server dots
  const setStatus = (state, text) => {
    ["server-dot-l","server-dot-m"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.className = "server-dot " + state;
    });
    ["server-label-l","server-label-m"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = text;
    });
  };

  setStatus("checking", "Checking server…");

  try {
    const r = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      setStatus("online", "<strong>Server online</strong> · Ready to analyse");
      const retry = document.getElementById("retry-btn");
      if (retry) retry.style.display = "none";
      updateFooter("Connected");
    } else throw new Error();
  } catch {
    setStatus("offline", "<strong>Server offline</strong> · First request may take 30s");
    const retry = document.getElementById("retry-btn");
    if (retry) retry.style.display = "block";
    updateFooter("Waking server…");
  }
}

function updateFooter(msg) {
  const el = document.getElementById("footer-info");
  if (el) el.textContent = msg;
}

// ── Main view ─────────────────────────────────────────────────────────────────
function populateMain(user) {
  const email   = user?.email || "·";
  const initial = email.charAt(0).toUpperCase();

  const avatar = document.getElementById("avatar");
  const name   = document.getElementById("user-name");
  const mail   = document.getElementById("user-email");
  if (avatar) avatar.textContent = initial;
  if (name)   name.textContent   = email.split("@")[0];
  if (mail)   mail.textContent   = email;

  loadCredits();
  checkPageContext();
}

function loadCredits() {
  chrome.runtime.sendMessage({ type: "GET_CREDITS" }, res => {
    if (chrome.runtime.lastError) return;
    const c  = res?.credits ?? "·";
    const el = document.getElementById("credits-val");
    if (el) {
      el.style.animation = "none";
      requestAnimationFrame(() => {
        el.style.animation = "";
        el.textContent = c !== "·" ? `${c} credit${c !== 1 ? "s" : ""}` : "Loading…";
        el.style.color = c === 0 ? "#d93025" : c <= 3 ? "#f29900" : "#202124";
      });
    }
  });
}

// ── Page context ──────────────────────────────────────────────────────────────
function checkPageContext() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab   = tabs[0];
    const url   = tab?.url || "";
    const isJob = url.includes("linkedin.com/jobs");
    const isLI  = url.includes("linkedin.com");

    const notLinkedIn = document.getElementById("not-linkedin");
    const activity    = document.getElementById("activity-strip");
    const actDot      = document.getElementById("activity-dot");
    const actText     = document.getElementById("activity-text");
    const toggleCard  = document.getElementById("toggle-card");

    if (!isLI) {
      if (notLinkedIn) notLinkedIn.style.display = "flex";
      if (activity)    activity.style.display    = "none";
      if (toggleCard)  toggleCard.style.opacity  = ".5";
      if (toggleCard)  toggleCard.style.pointerEvents = "none";
      return;
    }

    if (notLinkedIn) notLinkedIn.style.display = "none";
    if (toggleCard)  { toggleCard.style.opacity = "1"; toggleCard.style.pointerEvents = ""; }

    if (isJob) {
      // On a job page - check if sidebar is active
      chrome.storage.local.get("sidebar_active", ({ sidebar_active }) => {
        sidebarActive = sidebar_active !== false;
        updateToggle(sidebarActive);

        if (activity && actDot && actText) {
          activity.style.display = "flex";
          if (sidebarActive) {
            actDot.style.background = "#1e8e3e";
            actDot.style.animation  = "pulse-g 2.5s infinite";
            actText.innerHTML = "<strong>Sidebar active</strong> · Applyin is running on this page";
          } else {
            actDot.style.background = "#80868b";
            actDot.style.animation  = "none";
            actText.innerHTML = "Sidebar paused · Toggle to re-activate";
          }
        }
      });
    } else {
      // On LinkedIn but not a job page
      if (activity && actDot && actText) {
        activity.style.display = "flex";
        actDot.style.background = "#f29900";
        actDot.style.animation = "pulse-a .8s infinite";
        actText.innerHTML = "Navigate to a <strong>job listing</strong> to analyse fit";
      }
      chrome.storage.local.get("sidebar_active", ({ sidebar_active }) => {
        updateToggle(sidebar_active !== false);
      });
    }
  });
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function updateToggle(active) {
  const card  = document.getElementById("toggle-card");
  const title = document.getElementById("toggle-title");
  const sub   = document.getElementById("toggle-sub");
  if (!card) return;

  if (active) {
    card.classList.add("active");
    if (title) title.textContent = "Sidebar active";
    if (sub)   sub.textContent   = "Applyin is showing on LinkedIn";
  } else {
    card.classList.remove("active");
    if (title) title.textContent = "Sidebar inactive";
    if (sub)   sub.textContent   = "Click to activate";
  }
}

function toggleSidebar() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab?.url?.includes("linkedin.com")) {
      chrome.tabs.create({ url: "https://www.linkedin.com/jobs/" });
      window.close();
      return;
    }
    sidebarActive = !sidebarActive;
    chrome.storage.local.set({ sidebar_active: sidebarActive });
    updateToggle(sidebarActive);
    checkPageContext();
    chrome.tabs.sendMessage(tab.id,
      { type: sidebarActive ? "SHOW_SIDEBAR" : "HIDE_SIDEBAR" },
      () => chrome.runtime.lastError
    );
  });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function handleAuth() {
  const email  = document.getElementById("login-email").value.trim();
  const pass   = document.getElementById("login-password").value;
  const errEl  = document.getElementById("login-error");
  const btn    = document.getElementById("login-submit");

  errEl.textContent = "";
  errEl.classList.remove("info");   // reset to error (red) styling; pending state re-adds it
  if (!email || !pass)  { errEl.textContent = "Please fill in both fields"; return; }
  if (pass.length < 8)  { errEl.textContent = "Password must be at least 8 characters"; return; }
  if (currentTab === "signup") {
    const cbox = document.getElementById("consent-box");
    if (!cbox || !cbox.checked) { errEl.textContent = "Please agree to resume processing to continue."; return; }
  }

  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${currentTab === "login" ? "Signing in…" : "Creating account…"}`;

  chrome.runtime.sendMessage(
    { type: currentTab === "login" ? "LOGIN" : "SIGNUP", email, password: pass, consent: currentTab === "signup" },
    res => {
      btn.disabled = false;
      btn.textContent = currentTab === "login" ? "Sign in" : "Create account";
      // Confirm-email pending: account created, user must verify their email. Show a
      // friendly (non-red) message, not an error.
      if (res?.pending) {
        errEl.classList.add("info");
        errEl.textContent = res.message || "Check your inbox to confirm your email, then sign in to start.";
        return;
      }
      errEl.classList.remove("info");
      if (!res?.ok) {
        errEl.textContent = res?.error?.includes("Cannot reach")
          ? "Server is waking up (free tier), try again in 30s"
          : res?.error || "Something went wrong";
        return;
      }
      // Consent is recorded by the backend at signup (via the consent flag), so no
      // separate RECORD_CONSENT call is needed here.
      showView("main");
      populateMain(res);
      checkBackendStatus();
    }
  );
}

// ── Events ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Version badge: read through the central config helper so every screen shows the
  // exact same value (the number itself lives only in manifest.json).
  try {
    const v = CONFIG.getVersion();
    document.querySelectorAll(".js-version").forEach(el => { el.textContent = v; });
  } catch (e) {}
  // Login tabs
  document.querySelectorAll(".tab-btn").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.tab;
      const btn   = document.getElementById("login-submit");
      const free  = document.getElementById("login-free");
      const pass  = document.getElementById("login-password");
      if (btn)  btn.textContent  = currentTab === "login" ? "Sign in" : "Create account";
      if (free) free.style.display = currentTab === "signup" ? "flex" : "none";
      if (pass) pass.placeholder  = currentTab === "signup" ? "Password (min 8 chars)" : "Password";
      const crow = document.getElementById("consent-row");
      const cbox = document.getElementById("consent-box");
      if (crow) crow.style.display = currentTab === "signup" ? "flex" : "none";
      // On signup the submit is disabled until consent is checked.
      if (btn) btn.disabled = currentTab === "signup" && !(cbox && cbox.checked);
      document.getElementById("login-error").textContent = "";
    });
  });

  document.getElementById("login-submit").addEventListener("click", handleAuth);
  const _cbox = document.getElementById("consent-box");
  if (_cbox) _cbox.addEventListener("change", () => {
    const btn = document.getElementById("login-submit");
    if (btn && currentTab === "signup") btn.disabled = !_cbox.checked;
  });
  document.getElementById("login-email").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("login-password").focus();
  });
  document.getElementById("login-password").addEventListener("keydown", e => {
    if (e.key === "Enter") handleAuth();
  });

  document.getElementById("toggle-card")?.addEventListener("click", toggleSidebar);
  document.getElementById("retry-btn")?.addEventListener("click", checkBackendStatus);
  document.getElementById("sign-out-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "LOGOUT" }, () => {
      chrome.runtime.lastError;
      showView("login");
      checkBackendStatus();
    });
  });
  document.getElementById("buy-btn")?.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.url?.includes("linkedin.com")) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "OPEN_BUY_CREDITS" }, () => chrome.runtime.lastError);
        window.close();
      } else {
        chrome.tabs.create({ url: "https://www.linkedin.com/jobs/" });
        window.close();
      }
    });
  });
  document.getElementById("go-linkedin")?.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.linkedin.com/jobs/" });
    window.close();
  });

  init();
});

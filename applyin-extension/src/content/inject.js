// Applyin v2 — content script
(function () {
  "use strict";

  let sidebarEl = null;

  // ── Applyin Logger ───────────────────────────────────────────────────────────
  const log = {
    _fmt: (level, emoji, ...args) => {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const style = {
        info: 'color:#1a73e8;font-weight:600',
        success: 'color:#1e8e3e;font-weight:600',
        warn: 'color:#f29900;font-weight:600',
        error: 'color:#d93025;font-weight:600',
      }[level] || '';
      console.log(`%c[Applyin ${ts}] ${emoji}`, style, ...args);
    },
    info: (...a) => log._fmt('info', 'ℹ', ...a),
    ok: (...a) => log._fmt('success', '✓', ...a),
    warn: (...a) => log._fmt('warn', '⚠', ...a),
    error: (...a) => log._fmt('error', '✗', ...a),
    section: (title) => console.groupCollapsed(`%c[Applyin] ── ${title} ──`, 'color:#80868b;font-style:italic'),
    end: () => console.groupEnd(),
  };

  // ── Patch chrome.storage.local to survive context invalidation ──────────────
  // Returns both Promise (for await) and calls callback (for callback style)
  // Must support both patterns since inject.js uses both
  const _storageGet = chrome.storage.local.get.bind(chrome.storage.local);
  const _storageSet = chrome.storage.local.set.bind(chrome.storage.local);
  const _storageRemove = chrome.storage.local.remove.bind(chrome.storage.local);

  chrome.storage.local.get = function (keys, cb) {
    const p = new Promise(resolve => {
      try {
        _storageGet(keys, result => {
          try { chrome.runtime.lastError; } catch (e) { }
          resolve(result || {});
        });
      } catch (e) { resolve({}); }
    });
    if (cb) p.then(cb);
    return p;
  };

  chrome.storage.local.set = function (obj, cb) {
    const p = new Promise(resolve => {
      try {
        _storageSet(obj, () => {
          try { chrome.runtime.lastError; } catch (e) { }
          resolve();
        });
      } catch (e) { resolve(); }
    });
    if (cb) p.then(cb);
    return p;
  };

  chrome.storage.local.remove = function (keys, cb) {
    const p = new Promise(resolve => {
      try {
        _storageRemove(keys, () => {
          try { chrome.runtime.lastError; } catch (e) { }
          resolve();
        });
      } catch (e) { resolve(); }
    });
    if (cb) p.then(cb);
    return p;
  };

  // ── Safe chrome messaging — survives extension context invalidation ─────────
  // Optional timeoutMs: call cb(null) if no response within that time
  function safeSend(msg, cb, timeoutMs) {
    let done = false;
    let timer = null;

    function finish(res) {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (cb) cb(res);
    }

    if (timeoutMs) {
      timer = setTimeout(() => finish(null), timeoutMs);
    }

    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) { finish(null); return; }
        finish(res);
      });
    } catch (e) {
      finish(null);
    }
  }
  let lastJobId = null;
  let isAnalyzing = false;

  // ── LinkedIn scraping ──────────────────────────────────────────────────────
  function getText(selectors) {
    for (const s of selectors) {
      try { const el = document.querySelector(s); if (el?.textContent?.trim().length > 1) return el.textContent.trim(); } catch { }
    }
    return "";
  }

  function scrapeJobData() {
    const title = getText([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".jobs-unified-top-card__job-title h1",
      "h1.t-24.t-bold", "h1.t-24",
      ...Array.from(document.querySelectorAll("h1")).filter(h => h.textContent.trim().length < 120).map((_, i) => `h1:nth-of-type(${i + 1})`)
    ]) || document.title.split(" | ")[0];

    // Try DOM selectors first
    let company = getText([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name a",
      ".jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__subtitle-primary-grouping a",
      ".jobs-unified-top-card__subtitle-primary-grouping",
      ".job-details-jobs-unified-top-card__primary-description-without-tagline a",
      ".job-details-jobs-unified-top-card__primary-description-container a",
      "[class*='company-name'] a",
      "[class*='company-name']",
      "[class*='topcard__org'] a",
      "[class*='topcard__org']",
    ]);

    if (!company) {
      // Parse page title — LinkedIn formats as:
      // "Senior Data Engineer | Avathon | LinkedIn"  OR
      // "Senior Data Engineer at Avathon | LinkedIn"
      const t = document.title;
      if (t.includes(" at ")) {
        company = t.split(" at ")[1]?.split(" |")[0]?.trim() || "";
      } else {
        const parts = t.split(" | ");
        // parts[0]=title, parts[1]=company, parts[2]="LinkedIn"
        if (parts.length >= 3 && parts[2]?.trim() === "LinkedIn") {
          company = parts[1]?.trim() || "";
        } else if (parts.length === 2) {
          company = parts[1]?.replace("LinkedIn", "").trim() || "";
        }
      }
    }

    if (!company) {
      // Most reliable: LinkedIn always has a /company/ link for the hiring company
      try {
        const companyLinks = document.querySelectorAll("a[href*='linkedin.com/company/']");
        for (const link of companyLinks) {
          const text = link.textContent.trim();
          // Skip "Follow" buttons, short texts, and nav links
          if (text && text.length > 1 && text.length < 60 && !["Follow", "See all"].includes(text)) {
            company = text;
            break;
          }
        }
      } catch (e) { }
    }

    const location = getText([
      ".job-details-jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__workplace-type"
    ]);

    let description = "";
    for (const sel of ["#job-details", ".jobs-description__content", ".jobs-description-content", ".jobs-box__html-content", "[class*='jobs-description']"]) {
      try { const el = document.querySelector(sel); if (el?.innerText?.trim().length > 100) { description = el.innerText.trim(); break; } } catch { }
    }
    if (!description) {
      const candidates = Array.from(document.querySelectorAll("div,section"))
        .filter(el => { const t = el.innerText || ""; return t.length > 300 && t.length < 15000 && /responsibilities|requirements|experience|qualifications|skills/i.test(t); })
        .sort((a, b) => b.innerText.length - a.innerText.length);
      description = candidates[0]?.innerText?.trim() || "";
    }

    const techKeywords = ["Python", "SQL", "Spark", "Kafka", "Airflow", "dbt", "Kubernetes", "Docker", "AWS", "GCP", "Azure", "Terraform", "Snowflake", "Redshift", "BigQuery", "Databricks", "MLflow", "Ray", "Flink", "Trino", "React", "TypeScript", "JavaScript", "Java", "Scala", "Go", "Rust", "C++", "C#", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "FastAPI", "Django", "Flask", "Spring", "Node.js", "GraphQL", "REST", "CI/CD", "Looker", "Tableau", "Power BI", "Pandas", "NumPy", "scikit-learn", "TensorFlow", "PyTorch", "LangChain", "Delta Lake", "Iceberg", "Hadoop"];
    const skills = techKeywords.filter(s => description.toLowerCase().includes(s.toLowerCase()));
    const expMatch = description.match(/(\d+)\+?\s*(?:to\s*\d+\+?\s*)?years?/i);

    return { title, company, location, description, skills, experience: expMatch ? `${expMatch[1]}+ years` : "Not specified" };
  }

  function currentJobId() {
    const m = window.location.href.match(/\/jobs\/view\/(\d+)/);
    return m ? m[1] : window.location.href;
  }

  // ── PDF extraction ─────────────────────────────────────────────────────────
  // ── Build sidebar HTML ─────────────────────────────────────────────────────

  function buildHTML() {
    return `
<div class="cc-header">
  <div class="cc-brand">
    <img id="cc-brand-img" width="26" height="26" style="border-radius:6px;display:block" />
    <span>Apply<span style="color:#28a75a">in</span></span>
  </div>
  <div class="cc-header-actions">
    <button class="cc-hbtn" id="cc-settings-btn" title="Settings">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
    <button class="cc-hbtn" id="cc-collapse-btn" title="Collapse">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
  </div>
</div>

<div id="cc-main" class="cc-scroll">
  <!-- Auth wall -->
  <div class="cc-auth-wall" id="cc-auth-wall" style="display:none">
    <div class="cc-auth-logo">
      <img id="cc-auth-logo-img" width="56" height="56" style="border-radius:14px;display:block;margin-bottom:4px" />
      <span>Apply<span style="color:#28a75a">in</span></span>
    </div>
    <p class="cc-auth-tagline">Know your fit before you apply.</p>
    <div class="cc-auth-tabs">
      <button class="cc-auth-tab active" data-tab="login">Sign in</button>
      <button class="cc-auth-tab" data-tab="signup">Create account</button>
    </div>
    <div class="cc-auth-form" id="cc-auth-form">
      <input type="email" class="cc-auth-input" id="cc-auth-email" placeholder="Email address" autocomplete="email" />
      <input type="password" class="cc-auth-input" id="cc-auth-password" placeholder="Password" autocomplete="current-password" />
      <div class="cc-auth-error" id="cc-auth-error"></div>
      <button class="cc-analyse-btn" id="cc-auth-submit">Sign in</button>
    </div>
    <p class="cc-auth-free">3 free analyses on signup · No card required</p>
  </div>

  <!-- Resume + Analyse -->
  <div class="cc-section-plain">
    <div class="cc-upload-row">
      <label class="cc-upload-zone" id="cc-upload-zone" for="cc-file-input">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span id="cc-upload-label">Upload resume PDF</span>
      </label>
      <input type="file" id="cc-file-input" accept=".pdf,application/pdf" style="display:none" />
      <div class="cc-usage-pill" id="cc-usage-pill">— / 3</div>
    </div>
    <!-- Live progress steps (shown during upload + analysis) -->
    <div class="cc-steps" id="cc-steps" style="display:none"></div>
    <div class="cc-job-chip" id="cc-job-chip">Detecting job…</div>
    <button class="cc-analyse-btn" id="cc-analyse-btn">Analyse fit</button>
  </div>

  <!-- Results (hidden until analysis) -->
  <div id="cc-results" style="display:none">

    <!-- Job context header — shows what role was analysed -->
    <div id="cc-result-context" style="display:none;margin:10px 10px 0;padding:9px 12px;background:var(--grey-50);border:1px solid var(--border);border-radius:var(--r);display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div style="min-width:0">
        <div id="cc-result-job-title" style="font-family:var(--font-d);font-size:12.5px;font-weight:600;color:var(--grey-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <div id="cc-result-company" style="font-size:11px;color:var(--grey-600);margin-top:1px"></div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span id="cc-cached-badge" style="display:none;align-items:center;font-size:10.5px;font-weight:600;color:#137333;background:#e6f4ea;padding:3px 8px;border-radius:10px;border:1px solid #ceead6">⚡ Free</span>
        <button id="cc-reanalyse-btn" style="display:none;background:none;border:1px solid var(--grey-300);border-radius:16px;font-family:var(--font);font-size:11px;color:var(--grey-600);padding:4px 10px;cursor:pointer">↺ Fresh</button>
      </div>
    </div>

    <!-- Score block -->
    <div class="cc-score-block" id="cc-score-block">
      <div class="cc-score-header">
        <div class="cc-score-left">
          <div class="cc-score-ring-wrap" id="cc-score-circle">
            <svg width="72" height="72" viewBox="0 0 72 72">
              <circle class="cc-score-ring-bg" cx="36" cy="36" r="33"/>
              <circle class="cc-score-ring-fill" id="cc-score-ring" cx="36" cy="36" r="33"/>
            </svg>
            <div class="cc-score-center">
              <div class="cc-score-num" id="cc-score-num">–</div>
              <div class="cc-score-pct" id="cc-score-label">%</div>
            </div>
          </div>
        </div>
        <div class="cc-score-right">
          <div class="cc-score-title" id="cc-score-title-el">–</div>
          <div class="cc-verdict" id="cc-verdict"></div>
          <div class="cc-apply-badge" id="cc-apply-badge"></div>
        </div>
      </div>
      <!-- Score breakdown — proof the resume was parsed -->
      <div class="cc-score-breakdown" id="cc-score-breakdown" style="display:none">
        <div class="cc-breakdown-title">How this score was calculated</div>
        <div id="cc-breakdown-rows"></div>
      </div>
    </div>

    <!-- Why you fit / don't fit -->
    <details class="cc-accordion" open>
      <summary class="cc-acc-head">
        <span class="cc-acc-icon"><span class="cc-acc-dot cc-acc-dot-green"></span>Fit analysis</span><svg class="cc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="cc-acc-body" id="cc-fit-body"></div>
    </details>

    <!-- Skills gap -->
    <details class="cc-accordion">
      <summary class="cc-acc-head">
        <span class="cc-acc-icon"><span class="cc-acc-dot cc-acc-dot-red"></span>Skills gap</span><svg class="cc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="cc-acc-body" id="cc-skills-body"></div>
    </details>

    <!-- Improvement plan -->
    <details class="cc-accordion">
      <summary class="cc-acc-head">
        <span class="cc-acc-icon"><span class="cc-acc-dot cc-acc-dot-blue"></span>Improvement plan</span><svg class="cc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="cc-acc-body" id="cc-plan-body"></div>
    </details>

    <!-- Resume suggestions -->
    <details class="cc-accordion">
      <summary class="cc-acc-head">
        <span class="cc-acc-icon"><span class="cc-acc-dot cc-acc-dot-yellow"></span>Resume improvements</span><svg class="cc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="cc-acc-body" id="cc-resume-body"></div>
    </details>

    <!-- Interview guide -->
    <details class="cc-accordion">
      <summary class="cc-acc-head">
        <span class="cc-acc-icon"><span class="cc-acc-dot cc-acc-dot-purple"></span>Interview guide</span><svg class="cc-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="cc-acc-body" id="cc-interview-body"></div>
    </details>

    <!-- Next step CTA -->
    <div class="cc-next-step" id="cc-next-step"></div>

  </div>

  <!-- Loading -->
  <div class="cc-loading" id="cc-loading" style="display:none">
    <div class="cc-loading-bar"><div class="cc-loading-fill"></div></div>
    <p id="cc-loading-msg">Analysing role…</p>
  </div>

  <!-- Paywall -->
  <div class="cc-paywall" id="cc-paywall" style="display:none">
    <div class="cc-paywall-title">Out of credits</div>
    <p class="cc-paywall-desc">You've used all your credits. Top up to continue getting personalised job analysis.</p>
    <button class="cc-analyse-btn" id="cc-upgrade-cta">Upgrade to Pro →</button>
    <p class="cc-paywall-sub">Unlimited · Resume AI · Full interview prep</p>
  </div>
</div>

<!-- Account overlay -->
<div id="cc-settings" style="display:none" class="cc-scroll">
  <div class="cc-settings-head">
    <button class="cc-hbtn" id="cc-settings-back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span class="cc-settings-title">Account</span>
  </div>
  <div class="cc-theme-toggle">
    <span class="cc-theme-toggle-label">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      Dark mode
    </span>
    <label class="cc-toggle-switch" id="cc-theme-toggle">
      <input type="checkbox" id="cc-theme-input">
      <div class="cc-toggle-track"></div>
      <div class="cc-toggle-thumb"></div>
    </label>
  </div>
  <div class="cc-setting-group">
    <div class="cc-setting-label">Signed in as</div>
    <div class="cc-setting-desc" id="cc-s-email">—</div>
    <button class="cc-text-btn cc-danger-btn" id="cc-logout-btn">Sign out</button>
  </div>
  <div class="cc-setting-group">
    <div class="cc-setting-label">Resume</div>
    <div class="cc-setting-desc" id="cc-s-resume-status">No resume saved.</div>
    <button class="cc-text-btn cc-danger-btn" id="cc-clear-resume" style="display:none">Clear resume</button>
  </div>
  <div class="cc-setting-group">
    <div class="cc-setting-label">Credits</div>
    <div class="cc-setting-desc" id="cc-s-usage">Loading…</div>
    <button class="cc-btn-buy-small" id="cc-buy-more-btn">Buy more credits →</button>
  </div>
</div>`;
  }

  // ── Inject ─────────────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById("cc-root")) return;

    // Sidebar
    const root = document.createElement("div");
    root.id = "cc-root";
    root.innerHTML = buildHTML();
    document.body.appendChild(root);
    document.body.classList.add("cc-pushed");
    sidebarEl = root;

    // Pull tab — separate fixed element outside sidebar, never clipped by overflow:hidden
    if (!document.getElementById("cc-pull-tab")) {
      const pullTab = document.createElement("div");
      pullTab.id = "cc-pull-tab";
      pullTab.title = "Open Applyin";
      // Use the actual Applyin logo in the pull tab
      const iconUrl = chrome.runtime.getURL('icons/icon48.png');
      pullTab.innerHTML = `
        <img src="${iconUrl}" width="26" height="26" style="border-radius:6px;display:block" />
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="3" style="margin-top:2px">
          <polyline points="9 18 15 12 9 6"/>
        </svg>`;
      document.body.appendChild(pullTab);
      pullTab.addEventListener("click", expandSidebar);
    }

    wire();

    // Set icons immediately — don't wait for applyTheme
    try {
      const icon32 = chrome.runtime.getURL('icons/icon32.png');
      const icon128 = chrome.runtime.getURL('icons/icon128.png');
      const brandImg = sidebarEl.querySelector('#cc-brand-img');
      const authImg = sidebarEl.querySelector('#cc-auth-logo-img');
      if (brandImg) brandImg.src = icon32;
      if (authImg) authImg.src = icon128;
    } catch (e) { log.warn('Icon set failed:', e.message); }

    refreshUsage();
    detectJob();
  }



























  // ── File upload ────────────────────────────────────────────────────────────



  async function storeResume(text, label) {
    await chrome.storage.local.set({ resume: text.slice(0, 8000) });
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 1).length;
    const short = label && label.length > 20 ? label.slice(0, 18) + '…' : (label || 'Resume');
    setUploadLabel(true, short + ' · ' + wordCount + 'w');
    refreshSettingsResume();
    toast('Resume saved · ' + wordCount + ' words');
    const results = sidebarEl?.querySelector('#cc-results');
    if (results && results.style.display !== 'none') showReanalyseNudge();
  }

  function showReanalyseNudge() {
    // Remove any existing nudge
    sidebarEl?.querySelector("#cc-reanalyse-nudge")?.remove();
    const nudge = document.createElement("div");
    nudge.id = "cc-reanalyse-nudge";
    nudge.className = "cc-reanalyse-nudge";
    nudge.innerHTML = `<span>Resume updated — re-analyse to get personalised results</span><button id="cc-reanalyse-btn">Re-analyse</button>`;
    // Insert after the section-plain div
    const anchor = sidebarEl?.querySelector(".cc-section-plain");
    if (anchor) anchor.after(nudge);
    nudge.querySelector("#cc-reanalyse-btn").addEventListener("click", () => {
      nudge.remove();
      analyse(true); // force bypass cache since resume just changed
    });
  }


  function setProgressStep(idx, done, active) {
    const el = sidebarEl?.querySelector(`#cc-step-${idx}`);
    if (!el) return;
    el.dataset.state = done ? 'done' : active ? 'active' : 'pending';
  }







  // ── Analysis ─────────────────────────────────────────────────────────────
  function analyse(forceRefresh) {
    if (isAnalyzing) return;
    const job = scrapeJobData();
    if (!job.title || !job.description) {
      toast("Job not fully loaded. Scroll the page first.", "warn"); return;
    }
    isAnalyzing = true;
    log.info('Analyse fit clicked for:', job.title);
    sidebarEl.querySelector("#cc-results").style.display = "none";
    sidebarEl.querySelector("#cc-paywall").style.display = "none";
    sidebarEl.querySelector(".cc-retry-bar")?.remove();
    setAnalysisSteps();
    setLoading(true, "Analysing your fit…");
    setTimeout(() => setProgressStep(0, true) || setProgressStep(1, false, true), 200);
    setTimeout(() => setProgressStep(1, true) || setProgressStep(2, false, true), 800);

    // Read resume in content script — avoids SW storage read timing issues
    function getResumeB64(cb) {
      chrome.storage.local.get(["resume_b64_chunks"], meta => {
        const n = parseInt(meta.resume_b64_chunks) || 0;
        if (n === 0) { cb(null); return; }
        const keys = Array.from({ length: n }, (_, i) => "resume_b64_" + i);
        chrome.storage.local.get(keys, data => {
          const b64 = keys.map(k => data[k] || "").join("");
          log.ok('Resume read from storage:', b64.length, 'chars,', n, 'chunk(s)');
          cb(b64.length > 100 ? b64 : null);
        });
      });
    }

    getResumeB64(resumeB64 => {
      log.info('Resume ready:', resumeB64 ? Math.round(resumeB64.length / 1024) + 'KB' : 'NONE — JD only');
      safeSend({
        type: "ANALYZE_JOB",
        payload: job,
        resumeB64: resumeB64,
        forceRefresh: !!forceRefresh
      }, res => {
        if (!res?.ok) {
          isAnalyzing = false; setLoading(false); clearProgressSteps();
          showRetryBar(); return;
        }
        const analysisId = res.analysisId;
        let polls = 0;
        log.info('Analysis job sent to SW, polling for result...');
        const poll = setInterval(() => {
          polls++;
          if (polls === 1) log.info('Waiting for AI response...');
          if (polls > 90) {
            clearInterval(poll); isAnalyzing = false; setLoading(false); clearProgressSteps();
            showRetryBar("Analysis timed out — click Retry"); return;
          }
          try {
            chrome.storage.local.get(
              ["analysis_status", "analysis_id", "analysis_result", "analysis_error"],
              data => {
                if (polls <= 2) log.info('Poll', polls, '| storage:', data?.analysis_status, '| stored_id:', data?.analysis_id, '| expected:', analysisId, '| match:', data?.analysis_id === analysisId);
                if (!data || data.analysis_id !== analysisId) return;
                if (data.analysis_status === "running") {
                  if (polls === 5) { setProgressStep(2, true); setProgressStep(3, false, true); }
                  if (polls === 12) { setProgressStep(3, true); setProgressStep(4, false, true); }
                  return;
                }
                clearInterval(poll);
                isAnalyzing = false; setLoading(false);
                if (data.analysis_status === "error") {
                  clearProgressSteps();
                  const err = data.analysis_error || "Unknown error";
                  log.error('Analysis failed:', err);
                  if (err === "NOT_LOGGED_IN" || err === "SESSION_EXPIRED") { showAuthWall(); return; }
                  if (err === "INSUFFICIENT_CREDITS") { sidebarEl.querySelector("#cc-paywall").style.display = "block"; return; }
                  showRetryBar(err.slice(0, 80)); return;
                }
                if (data.analysis_status === "done") {
                  log.ok('Analysis complete — rendering results');
                  let result;
                  try { result = JSON.parse(data.analysis_result); }
                  catch (e) { showRetryBar("Bad response — retry"); return; }
                  setProgressStep(2, true); setProgressStep(3, true); setProgressStep(4, true);
                  setTimeout(() => clearProgressSteps(), 600);
                  renderResults(result, job);
                  refreshUsage();
                  if (result.cached) toast("✓ Cached result — no credit used");
                }
              }
            );
          } catch (e) { /* context invalidated — keep polling */ }
        }, 2000);
      }, 8000);
    });
  }

  function showRetryBar(msg) {
    sidebarEl?.querySelector(".cc-retry-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "cc-retry-bar";
    bar.style.cssText = "margin:8px 12px;padding:10px 14px;background:#fef7e0;border:1px solid #f9c97c;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px";
    bar.innerHTML = '<span style="font-size:12.5px;color:#7a4f00;flex:1;line-height:1.4">' + (msg || "Server took too long — happens on first request") + '</span><button style="flex-shrink:0;background:#1a73e8;color:#fff;border:none;border-radius:16px;font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;cursor:pointer">Retry</button>';
    sidebarEl?.querySelector("#cc-analyse-btn")?.after(bar);
    bar.querySelector("button").addEventListener("click", () => { bar.remove(); analyse(true); });
  }





  // ── Score breakdown helper ─────────────────────────────────────────────────
  function buildScoreBreakdown(d, job, hasResume) {
    // hasResume = whether a resume PDF was stored and sent to the AI
    const score = d.match_score;

    const totalSkills = job.skills.length;
    const missingCount = (d.missing_skills || []).length;
    const matchedSkills = Math.max(0, totalSkills - missingCount);
    const skillPct = totalSkills > 0 ? Math.round((matchedSkills / Math.max(1, totalSkills)) * 100) : 0;
    const expPct = d.fit_level === "strong" ? Math.min(100, score + 10)
      : d.fit_level === "medium" ? Math.min(85, score + 5)
        : Math.max(10, score - 5);
    const keywordPct = totalSkills > 0 ? Math.round((matchedSkills / totalSkills) * 100) : 0;

    const rows = [
      { label: "Skills match", pct: skillPct, detail: `${matchedSkills} / ${totalSkills} from JD` },
      { label: "Experience", pct: expPct, detail: job.experience !== "Not specified" ? `JD: ${job.experience}` : "See JD" },
      { label: "Keyword overlap", pct: keywordPct, detail: `${matchedSkills} keywords matched` },
      { label: "Overall fit", pct: score, detail: `${score}% match` },
    ];

    const breakdown = sidebarEl.querySelector("#cc-score-breakdown");
    const rowsEl = sidebarEl.querySelector("#cc-breakdown-rows");
    if (!breakdown || !rowsEl) return;

    rowsEl.innerHTML = rows.map(r => {
      const color = r.pct >= 70 ? "#057642" : r.pct >= 45 ? "#d97706" : "#b91c1c";
      return `<div class="cc-breakdown-row">
        <span class="cc-breakdown-label">${r.label}</span>
        <div class="cc-breakdown-bar-wrap">
          <div class="cc-breakdown-bar-bg">
            <div class="cc-breakdown-bar-fill" style="width:${r.pct}%;background:${color}"></div>
          </div>
        </div>
        <span class="cc-breakdown-val" style="color:${color}">${r.pct}%</span>
      </div>`;
    }).join("") + (hasResume
      ? `<div class="cc-breakdown-row cc-breakdown-confirm">
           <span>✓ Resume analysed against this role</span>
         </div>`
      : `<div class="cc-breakdown-row cc-breakdown-warn">
           <span>⚠ No resume detected — score is JD-only estimate</span>
         </div>`);

    breakdown.style.display = "block";
  }

  // ── Render results ─────────────────────────────────────────────────────────


  // ── Helpers ────────────────────────────────────────────────────────────────
  function scoreColor(score) {
    if (score >= 75) return "var(--cc-green)";
    if (score >= 45) return "var(--cc-amber)";
    return "var(--cc-red)";
  }

  function setLoading(show, msg) {
    const el = sidebarEl.querySelector("#cc-loading");
    const btn = sidebarEl.querySelector("#cc-analyse-btn");
    el.style.display = show ? "block" : "none";
    if (msg) sidebarEl.querySelector("#cc-loading-msg").textContent = msg;
    btn.disabled = show;
    btn.textContent = show ? "Matching resume to role…" : "Analyse fit";
  }

  function toast(msg, type) {
    document.querySelectorAll(".cc-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "cc-toast" + (type === "warn" ? " cc-toast-warn" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Messages from popup ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_SIDEBAR") {
      sidebarEl?.classList.remove("cc-collapsed");
      document.body.classList.add("cc-pushed");
      const btn = sidebarEl?.querySelector("#cc-collapse-btn");
      if (btn) btn.querySelector("svg polyline")?.setAttribute("points", "15 18 9 12 15 6");
    }
    if (msg.type === "HIDE_SIDEBAR") {
      sidebarEl?.classList.add("cc-collapsed");
      document.body.classList.remove("cc-pushed");
    }
    if (msg.type === "OPEN_BUY_CREDITS") {
      showBuyCreditsModal();
    }
    if (msg.type === "CREDITS_UPDATED") {
      updateCreditPill(msg.credits);
      toast(`✓ ${msg.added} credits added! Balance: ${msg.credits}`);
      refreshUsage();
    }
  });

  // ── SPA navigation ─────────────────────────────────────────────────────────
  function checkNav() {
    const id = currentJobId();
    if (id !== lastJobId) {
      lastJobId = id;
      if (sidebarEl) {
        sidebarEl.querySelector("#cc-results").style.display = "none";
        sidebarEl.querySelector("#cc-paywall").style.display = "none";
        sidebarEl.querySelector("#cc-analyse-btn").disabled = false;
        sidebarEl.querySelector("#cc-analyse-btn").textContent = "Analyse fit";
        setTimeout(detectJob, 1000);
      }
    }
  }




  function expandSidebar() {
    if (!sidebarEl) return;
    sidebarEl.classList.remove("cc-collapsed");
    document.body.classList.add("cc-pushed");
    const tab = document.getElementById("cc-pull-tab");
    if (tab) tab.classList.remove("cc-tab-visible");
    chrome.storage.local.set({ sidebar_active: true });
    const poly = sidebarEl.querySelector("#cc-collapse-btn svg polyline");
    if (poly) poly.setAttribute("points", "15 18 9 12 15 6");
  }

  function collapseSidebar() {
    if (!sidebarEl) return;
    sidebarEl.classList.add("cc-collapsed");
    document.body.classList.remove("cc-pushed");
    const tab = document.getElementById("cc-pull-tab");
    if (tab) tab.classList.add("cc-tab-visible");
    chrome.storage.local.set({ sidebar_active: false });
    const poly = sidebarEl.querySelector("#cc-collapse-btn svg polyline");
    if (poly) poly.setAttribute("points", "9 18 15 12 9 6");
  }

  function wire() {
    // Collapse button
    sidebarEl.querySelector("#cc-collapse-btn").addEventListener("click", collapseSidebar);

    // Settings / account
    sidebarEl.querySelector("#cc-settings-btn").addEventListener("click", () => showSettings(true));
    sidebarEl.querySelector("#cc-settings-back").addEventListener("click", () => showSettings(false));

    // Auth wall tabs
    sidebarEl.querySelectorAll(".cc-auth-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        sidebarEl.querySelectorAll(".cc-auth-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const isLogin = tab.dataset.tab === "login";
        sidebarEl.querySelector("#cc-auth-submit").textContent = isLogin ? "Sign in" : "Create account";
        sidebarEl.querySelector("#cc-auth-error").textContent = "";
        sidebarEl.querySelector("#cc-auth-password").autocomplete = isLogin ? "current-password" : "new-password";
      });
    });
    sidebarEl.querySelector("#cc-auth-submit").addEventListener("click", handleAuth);
    sidebarEl.querySelector("#cc-auth-email").addEventListener("keydown", e => { if (e.key === "Enter") sidebarEl.querySelector("#cc-auth-password").focus(); });
    sidebarEl.querySelector("#cc-auth-password").addEventListener("keydown", e => { if (e.key === "Enter") handleAuth(); });

    // File upload — label[for] handles the click natively, no JS needed
    // Only wire the change event and drag/drop
    const zone = sidebarEl.querySelector("#cc-upload-zone");
    const input = sidebarEl.querySelector("#cc-file-input");
    input.addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFile(file);
      // Reset so same file can be re-selected
      setTimeout(() => { e.target.value = ""; }, 100);
    });
    zone.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); zone.classList.add("cc-drag"); });
    zone.addEventListener("dragleave", e => { e.stopPropagation(); zone.classList.remove("cc-drag"); });
    zone.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove("cc-drag");
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    // Analyse
    sidebarEl.querySelector("#cc-analyse-btn").addEventListener("click", () => analyse(false));
    // Re-analyse fresh button (inside results)
    sidebarEl.querySelector("#cc-reanalyse-btn")?.addEventListener("click", () => {
      const rb = sidebarEl.querySelector("#cc-reanalyse-btn");
      if (rb) rb.style.display = "none";
      analyse(true);
    });

    // Account settings actions
    sidebarEl.querySelector("#cc-logout-btn")?.addEventListener("click", handleLogout);
    sidebarEl.querySelector("#cc-clear-resume").addEventListener("click", clearResume);
    sidebarEl.querySelector("#cc-buy-more-btn")?.addEventListener("click", showBuyCreditsModal);

    // Buy credits from results area
    sidebarEl.querySelector("#cc-upgrade-cta")?.addEventListener("click", showBuyCreditsModal);
  }

  // ── Auth & Settings ────────────────────────────────────────────────────────
  function showSettings(show) {
    if (show) log.info('Settings panel opened');
    sidebarEl.querySelector("#cc-main").style.display = show ? "none" : "block";
    sidebarEl.querySelector("#cc-settings").style.display = show ? "block" : "none";
    if (show) { refreshSettingsResume(); refreshSettingsCredits(); }
  }

  function refreshSettingsCredits() {
    const el = sidebarEl?.querySelector("#cc-s-usage");
    const emailEl = sidebarEl?.querySelector("#cc-s-email");
    chrome.storage.local.get("user", ({ user }) => {
      if (emailEl && user?.email) emailEl.textContent = user.email;
      if (el) el.textContent = "Loading…";
      safeSend({ type: "GET_CREDITS" }, res => {
        if (chrome.runtime.lastError || !res) { if (el) el.textContent = "—"; return; }
        if (el) el.textContent = res?.credits != null
          ? `${res.credits} credit${res.credits !== 1 ? "s" : ""} remaining`
          : "Could not load";
      });
    });
  }

  function handleAuth() {
    const email = sidebarEl.querySelector("#cc-auth-email").value.trim();
    const password = sidebarEl.querySelector("#cc-auth-password").value;
    const isLogin = sidebarEl.querySelector('.cc-auth-tab.active')?.dataset?.tab === "login";
    const errEl = sidebarEl.querySelector("#cc-auth-error");
    const btn = sidebarEl.querySelector("#cc-auth-submit");

    if (!email || !password) { errEl.textContent = "Please fill in all fields"; return; }
    if (password.length < 6) { errEl.textContent = "Password must be at least 6 characters"; return; }

    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = isLogin ? "Signing in…" : "Creating account…";

    safeSend(
      { type: isLogin ? "LOGIN" : "SIGNUP", email, password },
      res => {
        btn.disabled = false;
        btn.textContent = isLogin ? "Sign in" : "Create account";
        if (!res?.ok) {
          if (res?.error?.includes("backend") || res?.error?.includes("Cannot reach")) {
            errEl.textContent = "Backend not deployed yet. Follow the deployment guide first.";
          } else {
            errEl.textContent = res?.error || "Something went wrong. Try again.";
          }
          return;
        }
        // Logged in — immediately show full UI without refresh
        log.ok('Logged in as', res.email, '· Credits:', res.credits);
        sidebarEl.querySelector("#cc-auth-wall").style.display = "none";
        sidebarEl.querySelector("#cc-upload-row").style.display = "flex";
        sidebarEl.querySelector("#cc-job-chip").style.display = "block";
        sidebarEl.querySelector("#cc-analyse-btn").style.display = "block";
        updateCreditPill(res.credits);
        if (!isLogin) toast(`Welcome! You have ${res.credits} free credits to start`);
        else toast("Signed in");
        // Immediately detect job and refresh usage — no page reload needed
        detectJob();
        refreshUsage();
        // Check if resume already uploaded
        chrome.storage.local.get(["resume_b64_chunks", "resume_name"], s => {
          if (s.resume_b64_chunks > 0 && s.resume_name) {
            const fname = s.resume_name.length > 20 ? s.resume_name.slice(0, 18) + "…" : s.resume_name;
            setUploadLabel(true, fname + " · PDF ready");
          }
        });
      }
    );
  }

  function handleLogout() {
    safeSend({ type: "LOGOUT" }, () => {
      if (chrome.runtime.lastError) { toast("Logout error. Reload page.", "warn"); return; }
      showSettings(false);
      showAuthWall();
      toast("Signed out");
    });
  }

  function showAuthWall() {
    // Before showing auth wall, double-check storage directly
    // (avoids flashing auth wall when SW is just slow to wake)
    chrome.storage.local.get(["auth_token", "user"], (s) => {
      if (chrome.runtime.lastError) {
        _showAuthWallUI();
        return;
      }
      if (s.auth_token && s.user) {
        // We have a session — don't show auth wall, show main UI
        onLoggedIn(s.user);
        return;
      }
      _showAuthWallUI();
    });
  }

  function _showAuthWallUI() {
    log.info('Showing auth wall');
    const wall = sidebarEl?.querySelector("#cc-auth-wall");
    const row = sidebarEl?.querySelector("#cc-upload-row");
    const chip = sidebarEl?.querySelector("#cc-job-chip");
    const btn = sidebarEl?.querySelector("#cc-analyse-btn");
    const steps = sidebarEl?.querySelector("#cc-steps");
    const results = sidebarEl?.querySelector("#cc-results");
    if (wall) wall.style.display = "flex";
    if (row) row.style.display = "none";
    if (chip) chip.style.display = "none";
    if (btn) btn.style.display = "none";
    if (steps) steps.style.display = "none";
    if (results) results.style.display = "none";
  }

  function updateCreditPill(credits) {
    if (credits != null) log.info('Credits updated:', credits);
    const pill = sidebarEl?.querySelector("#cc-usage-pill");
    if (pill) pill.textContent = credits != null ? `${credits} credit${credits !== 1 ? "s" : ""}` : "—";
  }

  function refreshSettingsResume() {
    safeSend({ type: 'GET_RESUME_STATUS' }, (s) => {
      const el = sidebarEl?.querySelector('#cc-s-resume-status');
      const btn = sidebarEl?.querySelector('#cc-clear-resume');
      if (s?.hasResume) {
        if (el) el.textContent = s.isPDF ? ('PDF: ' + (s.name || 'resume.pdf')) : ('Text resume (~' + s.wordCount + ' words)');
        btn && (btn.style.display = 'inline');
      } else {
        if (el) el.textContent = 'No resume saved.';
        btn && (btn.style.display = 'none');
      }
    });
  }

  function clearResume() {
    const keys = ["resume", "resume_b64", "resume_name", "resume_b64_chunks"];
    for (let i = 0; i <= 20; i++) keys.push("resume_b64_" + i);
    chrome.storage.local.remove(keys, () => {
      setUploadLabel(false);
      refreshSettingsResume();
      toast("Resume cleared");
    });
  }

  function refreshUsage() {
    safeSend({ type: "GET_CREDITS" }, res => {
      if (chrome.runtime.lastError) return; // SW not ready yet
      if (res?.credits != null) updateCreditPill(res.credits);
    });
  }

  // ── Job detection ──────────────────────────────────────────────────────────
  function detectJob() {
    const job = scrapeJobData();
    const chip = sidebarEl?.querySelector("#cc-job-chip");
    if (!chip) return;
    if (job.title) {
      log.info('Job detected:', job.title, '@ company:', job.company || '(not found) | title:', document.title.slice(0, 60));
      chip.textContent = job.title + (job.company ? ` · ${job.company}` : "");
      chip.classList.remove("cc-chip-warn");
    } else {
      chip.textContent = "⚠ Job not detected — try scrolling";
      chip.classList.add("cc-chip-warn");
    }
  }

  // ── File upload ────────────────────────────────────────────────────────────
  async function handleFile(file) {
    // PDF upload — convert to base64 and store directly (no sendMessage needed)
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      toast('Please upload a PDF file.', 'warn');
      setUploadLabel(false);
      return;
    }

    setUploadLabel(null, 'Reading PDF…');
    setProgressSteps([
      { label: 'Reading file', done: false, active: true },
      { label: 'Encoding PDF', done: false, active: false },
      { label: 'Saving to storage', done: false, active: false },
      { label: 'Ready to analyse', done: false, active: false },
    ]);

    try {
      // Step 1: Read as ArrayBuffer
      const buf = await file.arrayBuffer();
      setProgressStep(0, true);
      setProgressStep(1, false, true);

      // Step 2: Encode to base64 in chunks (prevents UI freeze on large files)
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode(...slice);
        if (i % (CHUNK * 10) === 0) await new Promise(r => setTimeout(r, 0)); // yield to UI
      }
      const b64 = btoa(binary);
      log.ok('Resume encoded:', b64.length, 'chars (~' + Math.round(b64.length / 1024) + 'KB)');
      setProgressStep(1, true);
      setProgressStep(2, false, true);

      // Step 3: Store directly in chrome.storage.local (content scripts have full access)
      // Split into chunks if > 2MB to stay under per-item limit
      const STORAGE_CHUNK = 1024 * 1024 * 1.5; // 1.5MB per chunk (base64 chars)
      const toRemove = [];
      for (let i = 0; ; i++) { toRemove.push('resume_b64_' + i); if (i > 20) break; }
      await chrome.storage.local.remove(toRemove);

      if (b64.length <= STORAGE_CHUNK) {
        await chrome.storage.local.set({ resume_b64_0: b64, resume_b64_chunks: 1, resume_name: file.name });
      } else {
        const chunks = Math.ceil(b64.length / STORAGE_CHUNK);
        const obj = { resume_b64_chunks: chunks, resume_name: file.name };
        for (let i = 0; i < chunks; i++) {
          obj['resume_b64_' + i] = b64.slice(i * STORAGE_CHUNK, (i + 1) * STORAGE_CHUNK);
        }
        await chrome.storage.local.set(obj);
      }
      // Remove old single-key format
      await chrome.storage.local.remove(['resume_b64', 'resume']);
      setProgressStep(2, true);
      setProgressStep(3, false, true);

      const fname = file.name.length > 20 ? file.name.slice(0, 18) + '…' : file.name;
      setUploadLabel(true, fname + ' · PDF ready');
      setProgressStep(3, true);
      setTimeout(() => clearProgressSteps(), 1500);
      refreshSettingsResume();
      toast('Resume ready — click Analyse fit!');

      // Make sure analyse button is visible and pulse it
      const analyseBtn = sidebarEl?.querySelector('#cc-analyse-btn');
      if (analyseBtn) {
        analyseBtn.style.display = 'block';
        // Brief highlight animation to draw attention
        analyseBtn.style.transform = 'scale(1.03)';
        analyseBtn.style.boxShadow = '0 4px 20px rgba(26,115,232,.6)';
        setTimeout(() => {
          analyseBtn.style.transform = '';
          analyseBtn.style.boxShadow = '';
        }, 600);
      }

      const results = sidebarEl?.querySelector('#cc-results');
      if (results && results.style.display !== 'none') showReanalyseNudge();

    } catch (e) {
      log.error('Resume upload failed:', e.message);
      toast('Error reading PDF: ' + e.message, 'warn');
      setUploadLabel(false);
      clearProgressSteps();
    }
  }

  async function storeResume(text, label) {
    await chrome.storage.local.set({ resume: text.slice(0, 8000) });
    const wordCount = text.trim().split(/\s+/).filter(w => w.length > 1).length;
    const short = label && label.length > 20 ? label.slice(0, 18) + '…' : (label || 'Resume');
    setUploadLabel(true, short + ' · ' + wordCount + 'w');
    refreshSettingsResume();
    toast('Resume saved · ' + wordCount + ' words');
    const results = sidebarEl?.querySelector('#cc-results');
    if (results && results.style.display !== 'none') showReanalyseNudge();
  }

  function showReanalyseNudge() {
    // Remove any existing nudge
    sidebarEl?.querySelector("#cc-reanalyse-nudge")?.remove();
    const nudge = document.createElement("div");
    nudge.id = "cc-reanalyse-nudge";
    nudge.className = "cc-reanalyse-nudge";
    nudge.innerHTML = `<span>Resume updated — re-analyse to get personalised results</span><button id="cc-reanalyse-btn">Re-analyse</button>`;
    // Insert after the section-plain div
    const anchor = sidebarEl?.querySelector(".cc-section-plain");
    if (anchor) anchor.after(nudge);
    nudge.querySelector("#cc-reanalyse-btn").addEventListener("click", () => {
      nudge.remove();
      analyse(true); // force bypass cache since resume just changed
    });
  }

  // ── Progress steps ───────────────────────────────────────────────────────────
  function setProgressSteps(steps) {
    const el = sidebarEl?.querySelector('#cc-steps');
    if (!el) return;
    el.innerHTML = steps.map((s, i) => `
      <div class="cc-step" id="cc-step-${i}" data-state="${s.active ? 'active' : 'pending'}">
        <span class="cc-step-dot"></span>
        <span class="cc-step-label">${s.label}</span>
      </div>`).join('');
    el.style.display = 'block';
  }

  function setProgressStep(idx, done, active) {
    const el = sidebarEl?.querySelector(`#cc-step-${idx}`);
    if (!el) return;
    el.dataset.state = done ? 'done' : active ? 'active' : 'pending';
  }

  function clearProgressSteps() {
    const el = sidebarEl?.querySelector('#cc-steps');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  }

  function setAnalysisSteps() {
    setProgressSteps([
      { label: 'Reading job description', done: false, active: true },
      { label: 'Loading your resume PDF', done: false, active: false },
      { label: 'Matching against JD', done: false, active: false },
      { label: 'Scoring your fit', done: false, active: false },
      { label: 'Building your report', done: false, active: false },
    ]);
  }

  function setUploadLabel(loaded, name) {
    const label = sidebarEl?.querySelector("#cc-upload-label");
    const zone = sidebarEl?.querySelector("#cc-upload-zone");
    if (!label) return;
    if (loaded === null) { label.textContent = name || "Reading…"; return; }
    if (loaded) {
      label.textContent = name || "Resume saved";
      zone?.classList.add("cc-zone-loaded");
    } else {
      label.textContent = "Upload resume";
      zone?.classList.remove("cc-zone-loaded");
    }
  }



  // ── Score breakdown helper ─────────────────────────────────────────────────
  function buildScoreBreakdown(d, job, hasResume) {
    // hasResume = whether a resume PDF was stored and sent to the AI
    const score = d.match_score;

    const totalSkills = job.skills.length;
    const missingCount = (d.missing_skills || []).length;
    const matchedSkills = Math.max(0, totalSkills - missingCount);
    const skillPct = totalSkills > 0 ? Math.round((matchedSkills / Math.max(1, totalSkills)) * 100) : 0;
    const expPct = d.fit_level === "strong" ? Math.min(100, score + 10)
      : d.fit_level === "medium" ? Math.min(85, score + 5)
        : Math.max(10, score - 5);
    const keywordPct = totalSkills > 0 ? Math.round((matchedSkills / totalSkills) * 100) : 0;

    const rows = [
      { label: "Skills match", pct: skillPct, detail: `${matchedSkills} / ${totalSkills} from JD` },
      { label: "Experience", pct: expPct, detail: job.experience !== "Not specified" ? `JD: ${job.experience}` : "See JD" },
      { label: "Keyword overlap", pct: keywordPct, detail: `${matchedSkills} keywords matched` },
      { label: "Overall fit", pct: score, detail: `${score}% match` },
    ];

    const breakdown = sidebarEl.querySelector("#cc-score-breakdown");
    const rowsEl = sidebarEl.querySelector("#cc-breakdown-rows");
    if (!breakdown || !rowsEl) return;

    rowsEl.innerHTML = rows.map(r => {
      const color = r.pct >= 70 ? "#057642" : r.pct >= 45 ? "#d97706" : "#b91c1c";
      return `<div class="cc-breakdown-row">
        <span class="cc-breakdown-label">${r.label}</span>
        <div class="cc-breakdown-bar-wrap">
          <div class="cc-breakdown-bar-bg">
            <div class="cc-breakdown-bar-fill" style="width:${r.pct}%;background:${color}"></div>
          </div>
        </div>
        <span class="cc-breakdown-val" style="color:${color}">${r.pct}%</span>
      </div>`;
    }).join("") + (hasResume
      ? `<div class="cc-breakdown-row cc-breakdown-confirm">
           <span>✓ Resume analysed against this role</span>
         </div>`
      : `<div class="cc-breakdown-row cc-breakdown-warn">
           <span>⚠ No resume detected — score is JD-only estimate</span>
         </div>`);

    breakdown.style.display = "block";
  }

  // ── Render results ─────────────────────────────────────────────────────────
  function renderResults(d, job) {
    log.info('renderResults called, score:', d?.match_score, 'fit:', d?.fit_level);
    try {

      // ── Job context header ───────────────────────────────────────────────────
      const ctxEl = sidebarEl.querySelector("#cc-result-context");
      const ctxTitle = sidebarEl.querySelector("#cc-result-job-title");
      const ctxCo = sidebarEl.querySelector("#cc-result-company");
      const cachedBadge = sidebarEl.querySelector("#cc-cached-badge");
      const reBtn = sidebarEl.querySelector("#cc-reanalyse-btn");

      if (ctxEl) ctxEl.style.display = "flex";
      if (ctxTitle) ctxTitle.textContent = job.title || "Unknown role";
      if (ctxCo) ctxCo.textContent = [job.company, job.location].filter(Boolean).join(" · ");

      // Show cached badge or re-analyse button
      if (cachedBadge) cachedBadge.style.display = d.cached ? "inline-flex" : "none";
      if (reBtn) reBtn.style.display = "inline-block";

      // Score block
      const scoreEl = sidebarEl.querySelector("#cc-score-num");
      const labelEl = sidebarEl.querySelector("#cc-score-label");
      const circleEl = sidebarEl.querySelector("#cc-score-circle");
      const verdictEl = sidebarEl.querySelector("#cc-verdict");
      const applyEl = sidebarEl.querySelector("#cc-apply-badge");

      const isGreen = d.match_score >= 75;
      const isAmber = d.match_score >= 45;
      const textColor = isGreen ? "#137333" : isAmber ? "#7a4f00" : "#9e2114";

      // Animate SVG ring
      const ringEl = sidebarEl.querySelector("#cc-score-ring");
      if (ringEl) {
        const circumference = 2 * Math.PI * 33;
        const offset = circumference - (d.match_score / 100) * circumference;
        ringEl.style.strokeDasharray = circumference;
        ringEl.style.strokeDashoffset = circumference;
        requestAnimationFrame(() => setTimeout(() => { ringEl.style.strokeDashoffset = offset; }, 50));
        ringEl.setAttribute("class", "cc-score-ring-fill " + (isGreen ? "cc-ring-green" : isAmber ? "cc-ring-amber" : "cc-ring-red"));
      }

      scoreEl.textContent = d.match_score;
      scoreEl.style.color = textColor;
      labelEl.textContent = "%";
      const titleEl = sidebarEl.querySelector(".cc-score-title");
      if (titleEl) { titleEl.textContent = { strong: "Strong fit", medium: "Partial fit", weak: "Weak fit" }[d.fit_level] || "Analysed"; titleEl.style.color = textColor; }
      if (circleEl) { circleEl.className = "cc-score-ring-wrap"; }
      if (verdictEl) verdictEl.textContent = d.verdict || d.recommendation || "";

      const applyMap = {
        "Apply Now": { cls: "cc-apply-green", icon: "✓" },
        "Apply With Prep": { cls: "cc-apply-amber", icon: "→" },
        "Improve First": { cls: "cc-apply-amber", icon: "↑" },
        "Skip": { cls: "cc-apply-red", icon: "✕" }
      };
      const av = d.apply_recommendation?.verdict || "Apply With Prep";
      const am = applyMap[av] || applyMap["Apply With Prep"];
      if (applyEl) { applyEl.textContent = `${am.icon}  ${av}`; applyEl.className = `cc-apply-badge ${am.cls}`; }

      // Score breakdown — check actual storage word count
      safeSend({ type: "GET_RESUME_STATUS" }, (s) => {
        buildScoreBreakdown(d, job, !!s?.hasResume);
      });

      // Fit analysis
      const fitBody = sidebarEl.querySelector("#cc-fit-body");
      let fitHTML = "";
      if (d.fit_reasons?.length) {
        fitHTML += `<div class="cc-fit-group"><div class="cc-fit-group-label cc-green-label">Why you fit</div>`;
        d.fit_reasons.forEach(r => { fitHTML += `<div class="cc-fit-item cc-fit-yes"><span class="cc-fit-dot cc-dot-green"></span><span>${r}</span></div>`; });
        fitHTML += `</div>`;
      }
      if (d.gap_reasons?.length) {
        fitHTML += `<div class="cc-fit-group"><div class="cc-fit-group-label cc-red-label">Where you fall short</div>`;
        d.gap_reasons.forEach(r => { fitHTML += `<div class="cc-fit-item cc-fit-no"><span class="cc-fit-dot cc-dot-red"></span><span>${r}</span></div>`; });
        fitHTML += `</div>`;
      }
      fitBody.innerHTML = fitHTML || "<p class='cc-empty'>No data.</p>";

      // Skills gap
      const skillsBody = sidebarEl.querySelector("#cc-skills-body");
      let skHTML = "";
      if (job.skills.length) {
        skHTML += `<div class="cc-skill-group-label">Detected in JD</div><div class="cc-chips">`;
        job.skills.slice(0, 12).forEach(s => { skHTML += `<span class="cc-chip cc-chip-have">${s}</span>`; });
        skHTML += `</div>`;
      }
      if (d.missing_skills?.length) {
        skHTML += `<div class="cc-skill-group-label cc-red-label" style="margin-top:14px">Missing skills</div>`;
        d.missing_skills.forEach(s => {
          const sk = typeof s === "string" ? { skill: s, importance: "important", how_to_learn: "" } : s;
          const impColor = sk.importance === "critical" ? "cc-badge-red" : sk.importance === "important" ? "cc-badge-amber" : "cc-badge-grey";
          skHTML += `<div class="cc-missing-row"><div class="cc-missing-top"><span class="cc-missing-skill">${sk.skill}</span><span class="cc-badge ${impColor}">${sk.importance}</span></div>${sk.how_to_learn ? `<div class="cc-how-to">→ ${sk.how_to_learn}</div>` : ""}</div>`;
        });
      }
      skillsBody.innerHTML = skHTML || "<p class='cc-empty'>No skills gap detected.</p>";

      // Improvement plan
      const planBody = sidebarEl.querySelector("#cc-plan-body");
      let planHTML = "";
      (d.improvement_plan || []).forEach((item, i) => {
        const p = typeof item === "string" ? { action: item, impact: "medium", timeframe: "" } : item;
        const impClass = p.impact === "high" ? "cc-badge-amber" : "cc-badge-grey";
        planHTML += `<div class="cc-plan-item"><div class="cc-plan-num">${String(i + 1).padStart(2, "0")}</div><div class="cc-plan-content"><div class="cc-plan-action">${p.action}</div><div class="cc-plan-meta"><span class="cc-badge ${impClass}">${p.impact} impact</span>${p.timeframe ? `<span class="cc-timeframe">${p.timeframe}</span>` : ""}</div></div></div>`;
      });
      planBody.innerHTML = planHTML || "<p class='cc-empty'>No plan items.</p>";

      // Resume suggestions
      const resumeBody = sidebarEl.querySelector("#cc-resume-body");
      let resHTML = "";
      (d.resume_suggestions || []).forEach((s, i) => {
        const sug = typeof s === "string" ? { issue: s, fix: "", example: "" } : s;
        resHTML += `<div class="cc-resume-item"><div class="cc-resume-issue">${sug.issue}</div>${sug.fix ? `<div class="cc-resume-fix">Fix: ${sug.fix}</div>` : ""}${sug.example ? `<div class="cc-resume-example">"${sug.example}"</div>` : ""}</div>`;
      });
      resumeBody.innerHTML = resHTML || "<p class='cc-empty'>Resume looks good for this role.</p>";

      // Interview guide
      const intBody = sidebarEl.querySelector("#cc-interview-body");
      let intHTML = "";

      const renderQ = (q, type) => {
        if (type === "technical") {
          return `<div class="cc-q-card"><div class="cc-q-text">${q.question}</div>${q.why_asked ? `<div class="cc-q-meta">Tests: ${q.why_asked}</div>` : ""}${q.how_to_answer ? `<div class="cc-q-guide"><span class="cc-q-guide-label">How to answer</span> ${q.how_to_answer}</div>` : ""}${q.example_answer_start ? `<div class="cc-q-example">"${q.example_answer_start}"</div>` : ""}</div>`;
        } else if (type === "behavioural") {
          return `<div class="cc-q-card"><div class="cc-q-text">${q.question}</div>${q.why_asked ? `<div class="cc-q-meta">Tests: ${q.why_asked}</div>` : ""}${q.star_guide ? `<div class="cc-q-guide"><span class="cc-q-guide-label">STAR guide</span> ${q.star_guide}</div>` : ""}</div>`;
        } else {
          return `<div class="cc-q-card"><div class="cc-q-text">${q.question}</div>${q.context ? `<div class="cc-q-meta">${q.context}</div>` : ""}${q.how_to_answer ? `<div class="cc-q-guide"><span class="cc-q-guide-label">Key points</span> ${q.how_to_answer}</div>` : ""}</div>`;
        }
      };

      const iq = d.interview_guide || {};
      if (iq.technical?.length) {
        intHTML += `<div class="cc-q-section-label">Technical</div>`;
        iq.technical.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "technical"); });
      }
      if (iq.behavioural?.length) {
        intHTML += `<div class="cc-q-section-label" style="margin-top:14px">Behavioural</div>`;
        iq.behavioural.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "behavioural"); });
      }
      if (iq.company_specific?.length) {
        intHTML += `<div class="cc-q-section-label" style="margin-top:14px">Company-specific</div>`;
        iq.company_specific.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "company"); });
      }
      intBody.innerHTML = intHTML || "<p class='cc-empty'>No interview questions.</p>";

      // Next step
      const ns = sidebarEl.querySelector("#cc-next-step");
      if (d.apply_recommendation?.next_step) {
        ns.innerHTML = `<div class="cc-next-label">Next step</div><div class="cc-next-text">${d.apply_recommendation.next_step}</div>${d.apply_recommendation.reasoning ? `<div class="cc-next-reason">${d.apply_recommendation.reasoning}</div>` : ""}`;
        ns.style.display = "block";
      } else {
        ns.style.display = "none";
      }

      // ── Resume confirmation card ─────────────────────────────────────────────
      // Shows what we read from the resume so user knows it was processed
      const resultsEl = sidebarEl.querySelector("#cc-results");

      // Remove old resume card if exists
      resultsEl.querySelector(".cc-resume-confirm-card")?.remove();

      chrome.storage.local.get(["resume_b64_chunks", "resume_name"], s => {
        const hasResume = s.resume_b64_chunks > 0;

        const card = document.createElement("div");
        card.className = "cc-resume-confirm-card";

        if (hasResume) {
          const fname = s.resume_name || "Resume.pdf";
          const strengths = d.resume_strengths || d.fit_reasons?.slice(0, 2) || [];
          const weaknesses = d.resume_suggestions?.slice(0, 2) || [];

          card.innerHTML = `
          <div class="cc-rc-header">
            <div class="cc-rc-icon">📄</div>
            <div class="cc-rc-title">
              <div class="cc-rc-name">${fname.length > 25 ? fname.slice(0, 23) + "…" : fname}</div>
              <div class="cc-rc-sub">Resume read and analysed ✓</div>
            </div>
          </div>
          ${strengths.length ? `
          <div class="cc-rc-section">
            <div class="cc-rc-section-label cc-green-label">✓ Strong points in your resume</div>
            ${strengths.map(s => `<div class="cc-rc-item cc-rc-good">${s}</div>`).join("")}
          </div>` : ""}
          ${weaknesses.length ? `
          <div class="cc-rc-section">
            <div class="cc-rc-section-label cc-red-label">↑ Needs improvement</div>
            ${weaknesses.map(w => `<div class="cc-rc-item cc-rc-bad">${w.issue || w}</div>`).join("")}
          </div>` : ""}
        `;
        } else {
          card.innerHTML = `
          <div class="cc-rc-header cc-rc-warn">
            <div class="cc-rc-icon">⚠️</div>
            <div class="cc-rc-title">
              <div class="cc-rc-name">No resume uploaded</div>
              <div class="cc-rc-sub">Analysis based on JD only — upload resume for full fit score</div>
            </div>
          </div>
        `;
        }

        // Insert before score block
        const scoreBlock = resultsEl.querySelector("#cc-score-block");
        if (scoreBlock) scoreBlock.before(card);
      });

      resultsEl.style.display = "block";
      // Scroll to top of results
      sidebarEl.querySelector("#cc-main").scrollTop = 0;
      log.ok('renderResults complete');
    } catch (renderErr) {
      log.error('renderResults crashed:', renderErr.message, renderErr.stack?.split('\n')[1]);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function scoreColor(score) {
    if (score >= 75) return "var(--cc-green)";
    if (score >= 45) return "var(--cc-amber)";
    return "var(--cc-red)";
  }

  function setLoading(show, msg) {
    const el = sidebarEl.querySelector("#cc-loading");
    const btn = sidebarEl.querySelector("#cc-analyse-btn");
    el.style.display = show ? "block" : "none";
    if (msg) sidebarEl.querySelector("#cc-loading-msg").textContent = msg;
    btn.disabled = show;
    btn.textContent = show ? "Matching resume to role…" : "Analyse fit";
  }

  function toast(msg, type) {
    document.querySelectorAll(".cc-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "cc-toast" + (type === "warn" ? " cc-toast-warn" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Messages from popup ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_SIDEBAR") {
      sidebarEl?.classList.remove("cc-collapsed");
      document.body.classList.add("cc-pushed");
      const btn = sidebarEl?.querySelector("#cc-collapse-btn");
      if (btn) btn.querySelector("svg polyline")?.setAttribute("points", "15 18 9 12 15 6");
    }
    if (msg.type === "HIDE_SIDEBAR") {
      sidebarEl?.classList.add("cc-collapsed");
      document.body.classList.remove("cc-pushed");
    }
    if (msg.type === "OPEN_BUY_CREDITS") {
      showBuyCreditsModal();
    }
    if (msg.type === "CREDITS_UPDATED") {
      updateCreditPill(msg.credits);
      toast(`✓ ${msg.added} credits added! Balance: ${msg.credits}`);
      refreshUsage();
    }
  });

  // ── SPA navigation ─────────────────────────────────────────────────────────
  function checkNav() {
    const id = currentJobId();
    if (id !== lastJobId) {
      lastJobId = id;
      if (sidebarEl) {
        sidebarEl.querySelector("#cc-results").style.display = "none";
        sidebarEl.querySelector("#cc-paywall").style.display = "none";
        sidebarEl.querySelector("#cc-analyse-btn").disabled = false;
        sidebarEl.querySelector("#cc-analyse-btn").textContent = "Analyse fit";
        setTimeout(detectJob, 1000);
      }
    }
  }

  // ── Buy credits modal — all styles inline to prevent LinkedIn CSS override ──
  function showBuyCreditsModal() {
    document.getElementById("cc-buy-modal")?.remove();

    const modal = document.createElement("div");
    modal.id = "cc-buy-modal";
    // Overlay styles fully inline — LinkedIn cannot override these
    Object.assign(modal.style, {
      position: "fixed", inset: "0", zIndex: "9999999",
      fontFamily: "'Google Sans Text','Google Sans',system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center"
    });

    // Backdrop
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, {
      position: "absolute", inset: "0",
      background: "rgba(32,33,36,.55)"
    });
    backdrop.addEventListener("click", () => modal.remove());
    modal.appendChild(backdrop);

    // Box
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "relative", zIndex: "1",
      background: "#fff", borderRadius: "16px",
      boxShadow: "0 8px 40px rgba(0,0,0,.22)",
      width: "min(460px,90vw)", maxHeight: "85vh",
      overflow: "hidden", display: "flex", flexDirection: "column",
      fontFamily: "inherit", animation: "cc-fadein .2s ease"
    });

    box.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px 12px;border-bottom:1px solid #e8eaed">
        <span style="font-family:'Google Sans',sans-serif;font-size:18px;font-weight:700;color:#202124">Buy credits</span>
        <button id="cc-buy-close" style="background:none;border:none;font-size:20px;color:#5f6368;cursor:pointer;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .1s" onmouseover="this.style.background='#f1f3f4'" onmouseout="this.style.background='none'">✕</button>
      </div>
      <div style="padding:10px 20px 14px;font-size:13px;color:#5f6368;border-bottom:1px solid #e8eaed">
        One credit = one full analysis. <strong style="color:#202124">Credits never expire.</strong>
      </div>
      <div id="cc-pkgs-inner" style="overflow-y:auto;padding:14px 20px;display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;color:#80868b;padding:10px 0">Loading packages…</div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid #e8eaed;text-align:center;font-size:12px;color:#80868b">
        🔒 Secure payments via Razorpay · INR &amp; USD accepted
      </div>
    `;

    modal.appendChild(box);
    document.body.appendChild(modal);

    box.querySelector("#cc-buy-close").addEventListener("click", () => modal.remove());

    // Load packages with live countdown (handles Render 30s cold start)
    function loadPackages() {
      const inner = modal?.querySelector("#cc-pkgs-inner");
      if (!inner || !modal.isConnected) return;

      let secs = 0;
      inner.innerHTML = `
        <div style="text-align:center;padding:20px 0">
          <div style="display:inline-block;width:22px;height:22px;border:3px solid #e8eaed;border-top-color:#1a73e8;border-radius:50%;animation:cc-spin .7s linear infinite;margin-bottom:10px"></div>
          <div id="cc-pkg-msg" style="font-size:13px;color:#5f6368;margin-bottom:4px">Connecting to server…</div>
          <div style="font-size:11.5px;color:#9aa0a6">Free tier may take up to 30s to wake up</div>
        </div>`;

      const timer = setInterval(() => {
        secs++;
        const m = inner?.querySelector("#cc-pkg-msg");
        if (!m) { clearInterval(timer); return; }
        if (secs < 8) m.textContent = "Connecting to server…";
        else m.textContent = "Server waking up… (" + secs + "s)";
      }, 1000);

      safeSend({ type: "GET_PACKAGES" }, (res) => {
        clearInterval(timer);
        if (!inner || !modal.isConnected) return;

        if (!res?.packages) {
          inner.innerHTML = `
            <div style="text-align:center;padding:16px 0">
              <div style="font-size:13px;color:#d93025;margin-bottom:12px">Server took too long to respond.</div>
              <button id="cc-retry-pkg" style="background:#1a73e8;color:#fff;border:none;border-radius:20px;font-family:'Google Sans',sans-serif;font-size:13px;font-weight:500;padding:9px 22px;cursor:pointer">Try again</button>
            </div>`;
          inner.querySelector("#cc-retry-pkg")?.addEventListener("click", loadPackages);
          return;
        }

        inner.innerHTML = "";
        res.packages.forEach((pkg, i) => {
          const card = document.createElement("div");
          Object.assign(card.style, {
            border: pkg.popular ? "2px solid #1a73e8" : "1.5px solid #e8eaed",
            borderRadius: "12px", padding: "16px",
            background: pkg.popular ? "#f0f6ff" : "#fff",
            position: "relative", marginTop: i > 0 ? "14px" : "0",
          });
          card.innerHTML = (pkg.popular ? `<div style="position:absolute;top:-11px;left:14px;background:#1a73e8;color:#fff;font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;font-family:'Google Sans',sans-serif">Most popular</div>` : "") +
            `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
              <div>
                <div style="font-family:'Google Sans',sans-serif;font-size:17px;font-weight:700;color:#202124;margin-bottom:3px">${pkg.credits} credits</div>
                <div style="font-size:15px;font-weight:600;color:#1a73e8;margin-bottom:2px">₹${(pkg.inr / 100).toFixed(0)} <span style="font-size:12px;font-weight:400;color:#80868b">/ $${(pkg.usd / 100).toFixed(2)}</span></div>
                <div style="font-size:11.5px;color:#80868b">₹${(pkg.inr / pkg.credits / 100).toFixed(1)} per analysis · Never expire</div>
              </div>
              <button data-pkg-id="${pkg.id}" style="flex-shrink:0;background:#1a73e8;color:#fff;border:none;border-radius:20px;font-family:'Google Sans',sans-serif;font-size:13.5px;font-weight:500;padding:10px 22px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(26,115,232,.3)">Buy</button>
            </div>`;
          card.querySelector("button").addEventListener("click", () => startPurchase(pkg.id, modal));
          inner.appendChild(card);
        });
      });
    }
    loadPackages();
  }

  function startPurchase(packageId, modal) {
    const btn = modal?.querySelector(`[data-pkg-id="${packageId}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "Opening payment page…"; }

    safeSend({ type: "CREATE_ORDER", package_id: packageId, currency: "INR" }, res => {
      if (!res?.ok || !res.payment_url) {
        toast(res?.error || "Could not create order. Try again.", "warn");
        if (btn) { btn.disabled = false; btn.textContent = "Buy"; }
        return;
      }
      // Worker already opened the payment URL in a new tab
      modal?.remove();
      toast("Payment page opened in new tab ✓");
      // Poll for credit update after user likely completes payment
      setTimeout(() => refreshUsage(), 30000);
      setTimeout(() => refreshUsage(), 60000);
    });
  }



  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    inject();
    lastJobId = currentJobId();
    safeSend({ type: "CLEAR_JOB_CACHE" }, () => { chrome.runtime.lastError; });

    // If sidebar was left collapsed, show the pull tab immediately
    chrome.storage.local.get("sidebar_active", ({ sidebar_active }) => {
      if (sidebar_active === false) collapseSidebar();
    });

    // ── Theme init ───────────────────────────────────────────────────────────
    function applyTheme(dark) {
      const root = sidebarEl;
      if (dark) {
        root.setAttribute("data-theme", "dark");
      } else {
        root.removeAttribute("data-theme");
      }
      // Update icon images
      const icon32 = chrome.runtime.getURL('icons/icon32.png');
      const icon128 = chrome.runtime.getURL('icons/icon128.png');
      const brandImg = sidebarEl.querySelector('#cc-brand-img');
      const authImg = sidebarEl.querySelector('#cc-auth-logo-img');
      if (brandImg) brandImg.src = icon32;
      if (authImg) authImg.src = icon128;
      // Update toggle state
      const input = sidebarEl.querySelector("#cc-theme-input");
      if (input) input.checked = dark;
    }

    // Load saved theme
    chrome.storage.local.get(["Applyin_dark_mode"], s => {
      applyTheme(!!s.Applyin_dark_mode);
    });

    // Wire toggle
    sidebarEl.querySelector("#cc-theme-input")?.addEventListener("change", e => {
      const dark = e.target.checked;
      chrome.storage.local.set({ Applyin_dark_mode: dark });
      applyTheme(dark);
      log.info("Theme:", dark ? "dark" : "light");
    });

    // Check session — retry up to 3 times with backoff (SW may be waking up)
    function tryGetSession(attempts) {
      safeSend({ type: "GET_SESSION" }, res => {
        if (!res) {
          if (attempts > 0) {
            setTimeout(() => tryGetSession(attempts - 1), 800);
          } else {
            // SW not responding — show auth wall, user can refresh
            showAuthWall();
          }
          return;
        }
        if (!res.loggedIn) { log.info('Not logged in — showing auth wall'); showAuthWall(); return; }
        log.ok('Session restored:', res.user?.email, '· Credits:', res.user?.credits);
        onLoggedIn(res.user);
      });
    }
    tryGetSession(3);

    function onLoggedIn(user) {
      // Show main UI, hide auth wall
      const wall = sidebarEl?.querySelector("#cc-auth-wall");
      const row = sidebarEl?.querySelector("#cc-upload-row");
      const chip = sidebarEl?.querySelector("#cc-job-chip");
      const btn = sidebarEl?.querySelector("#cc-analyse-btn");
      if (wall) wall.style.display = "none";
      if (row) row.style.display = "flex";
      if (chip) chip.style.display = "block";
      if (btn) btn.style.display = "block";

      updateCreditPill(user?.credits);

      safeSend({ type: 'GET_RESUME_STATUS' }, s => {
        if (!s) return;
        if (s.isPDF && s.name) setUploadLabel(true, s.name.slice(0, 18) + ' · PDF ready');
        else if (s.hasResume) setUploadLabel(true, 'Resume saved');
      });
      safeSend({ type: "GET_CREDITS" }, r => {
        if (r?.credits != null) updateCreditPill(r.credits);
      });
    }

    new MutationObserver(checkNav).observe(document.body, { childList: true, subtree: false });
  }

  // Handle show/hide from popup toggle
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_SIDEBAR") {
      sidebarEl?.classList.remove("cc-collapsed");
      document.body.classList.add("cc-pushed");
      const btn = sidebarEl?.querySelector("#cc-collapse-btn");
      if (btn) btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
    }
    if (msg.type === "HIDE_SIDEBAR") {
      sidebarEl?.classList.add("cc-collapsed");
      document.body.classList.remove("cc-pushed");
      const btn = sidebarEl?.querySelector("#cc-collapse-btn");
      if (btn) btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
    }
    if (msg.type === "OPEN_BUY_CREDITS") {
      showBuyCreditsModal();
    }
  });

  // Recover from extension context invalidation on page
  function safeInit() {
    try {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => setTimeout(init, 1500));
      } else {
        setTimeout(init, 1500);
      }
    } catch (e) {
      log.warn('Init failed (will retry):', e.message);
    }
  }

  // Re-attempt if service worker wakes up later
  chrome.runtime.onConnect && chrome.runtime.onConnect;
  safeInit();
})();

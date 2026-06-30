// Applyin v2 - content script
(function () {
  "use strict";

  // Central config (loaded via config.js before this script in the manifest).
  // Falls back to applyin.co.in defaults if for any reason it is not present.
  const CFG = (typeof window !== "undefined" && window.APPLYIN_CONFIG) || {
    SITE: "https://applyin.co.in",
    URLS: {
      privacy: "https://applyin.co.in/privacy",
      terms:   "https://applyin.co.in/terms",
      help:    "https://applyin.co.in/help",
    },
    getVersion: function () {
      try { return "v" + chrome.runtime.getManifest().version; } catch (e) { return ""; }
    },
  };
  const URLS = CFG.URLS;
  // Live extension version via the central config helper (same value everywhere).
  let APP_VERSION = "";
  try { APP_VERSION = (CFG.getVersion ? CFG.getVersion() : "v" + chrome.runtime.getManifest().version); } catch (e) {}

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

  // -- Safe chrome messaging - survives extension context invalidation ─────────
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
  let _restoreSession = null;
  let isAnalyzing = false;

  function applyPullTabFit(fit) {
    const tab = document.getElementById("cc-pull-tab");
    if (!tab) return;
    tab.classList.remove("cc-fit-strong", "cc-fit-medium", "cc-fit-weak");
    if (fit) tab.classList.add("cc-fit-" + fit);
  }

  // ── LinkedIn scraping ──────────────────────────────────────────────────────
  function getText(selectors) {
    for (const s of selectors) {
      try { const el = document.querySelector(s); if (el?.textContent?.trim().length > 1) return el.textContent.trim(); } catch { }
    }
    return "";
  }

  function downloadReportCard(d, job) {
    const esc2 = s => String(s == null ? "" : s).replace(/\s+[\u2014\u2013]\s+/g, ", ").replace(/[\u2014\u2013]/g, "-").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    const score = parseInt(d.match_score) || 0;
    const fit = d.fit_level || "medium";
    const accent = fit === "strong" ? "#2f9e63" : fit === "weak" ? "#bc2b40" : "#a96d0c";
    const rec = d.apply_recommendation || {};
    const bd = d.score_breakdown || {};
    const math = d.score_math || [];
    const checks = d.requirement_checks || [];
    const kw = d.critical_keywords_missing || [];
    const ats = d.ats_assessment || {};
    const dimName = { skills_match:"Skills", experience_match:"Experience", domain_match:"Domain", qualifications_match:"Qualifications", soft_skills_match:"Soft skills" };

    const strengths = [...(d.resume_strengths||[]), ...(d.fit_reasons||[])].filter(Boolean).slice(0,5);
    const areas = (d.gap_reasons||[]).filter(Boolean).slice(0,4);
    const plan = (d.improvement_plan||[]);
    const sugg = (d.resume_suggestions||[]);
    const missing = (d.missing_skills||[]);
    const iq = d.interview_guide || {};
    const nextStep = rec.next_step || "";
    const verdictText = d.verdict || rec.verdict || "";
    const jobUrl = job?.url || (typeof window !== "undefined" ? window.location.href : "");
    const LOGO = "data:image/png;base64,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";

    const dt = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
    const ref = 'AP-' + String(score).padStart(2,'0') + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
    const circ = 327, off = circ * (1 - Math.max(0, Math.min(100, score)) / 100);
    const statusWord = fit === 'strong' ? 'Strong fit' : fit === 'weak' ? 'Limited fit' : 'Moderate fit';
    const pct = Math.max(0, Math.min(100, score));
    const RC = 314.16; const ringOff = (RC*(1-pct/100)).toFixed(1);
    const CHK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><polyline points="20 6 9 17 4 12"/></svg>';

    const mathRows = math.map(m =>
      `<tr><td class="mt-d">${esc2(dimName[m.dimension]||m.dimension)}</td><td>${m.sub_score}</td><td>${m.weight_pct}%</td><td class="mt-p">${m.points}</td></tr>`).join("");
    const checkList = checks.map(c => {
      const col = c.status === "met" ? "#2f9e63" : c.status === "partial" ? "#a96d0c" : "#bc2b40";
      const lbl = c.status === "met" ? "Met" : c.status === "partial" ? "Partial" : "Gap";
      return `<div class="ck"><div class="ck-t"><span class="ck-r">${esc2(c.requirement)}</span><span class="ck-b" style="color:${col};border-color:${col}55;background:${col}12">${lbl}${c.score!=null?` &middot; ${c.score}`:""}</span></div>${c.reasoning?`<div class="ck-d">${esc2(c.reasoning)}</div>`:""}</div>`;
    }).join("");
    const strengthsList = strengths.map(s => `<div class="row"><span class="tick">${CHK}</span><span>${esc2(s)}</span></div>`).join("");
    const areasList = areas.map(s => `<div class="row"><span class="dotm"></span><span>${esc2(s)}</span></div>`).join("");
    const planList = plan.map((p,i) => {
      const o = typeof p === "string" ? {action:p} : p;
      const meta = [o.impact?o.impact.charAt(0).toUpperCase()+o.impact.slice(1)+' impact':'', o.timeframe||''].filter(Boolean).join('  &middot;  ');
      return `<li><span class="plan-n">${i+1}</span><div><div class="plan-a">${esc2(o.action)}</div>${meta?`<div class="plan-m">${meta}</div>`:''}</div></li>`;
    }).join("");
    const suggList = sugg.map(s => {
      const o = typeof s === "string" ? {issue:s} : s;
      const before = o.before||"", after = o.after||o.example||"", note = o.issue||o.gap_addressed||"";
      return `<div class="rw">${note?`<div class="rw-h">${esc2(note)}</div>`:''}${before?`<div class="rw-b"><span>Before</span>${esc2(before)}</div>`:''}${after?`<div class="rw-a"><span>After</span>${esc2(after)}</div>`:''}${o.fix&&!after?`<div class="rw-f">${esc2(o.fix)}</div>`:''}</div>`;
    }).join("");
    const kwChips = kw.map(k => `<span class="chip">${esc2(k)}</span>`).join("");
    const missingList = missing.map(s => {
      const o = typeof s === "string" ? {skill:s, importance:"important", how_to_learn:""} : s;
      const col = o.importance === "critical" ? "#bc2b40" : o.importance === "important" ? "#a96d0c" : "#2f9e63";
      return `<div class="ck"><div class="ck-t"><span class="ck-r">${esc2(o.skill)}</span>${o.importance?`<span class="ck-b" style="color:${col};border-color:${col}55;background:${col}12;text-transform:capitalize">${esc2(o.importance)}</span>`:""}</div>${o.how_to_learn?`<div class="ck-d">${esc2(o.how_to_learn)}</div>`:""}</div>`;
    }).join("");
    const atsHtml = ats.ats_score != null ? `<div class="ats"><div class="ats-n">${parseInt(ats.ats_score)||0}<span>/ 100</span></div><div class="ats-d">How screening software might rank you, by keyword and title matching. Different from your fit score, which is about whether you suit the role. Real systems vary.</div></div>` : "";

    // Interview: render the full guide using the real interview_guide schema
    const qCard = (q, leadLabel) => {
      const o = typeof q === "string" ? { question:q } : (q||{});
      const meta = o.why_asked ? `${leadLabel}: ${esc2(o.why_asked)}` : (o.context ? esc2(o.context) : "");
      const guideTxt = o.how_to_answer || o.star_guide || o.example_answer_start || "";
      const guideLbl = o.star_guide ? "STAR guide" : o.example_answer_start ? "Example opening" : "How to approach it";
      return `<div class="qa"><div class="qa-q">${esc2(o.question||"")}</div>${meta?`<div class="qa-w">${meta}</div>`:""}${guideTxt?`<div class="qa-g"><span class="qa-gl">${guideLbl}</span>${esc2(guideTxt)}</div>`:""}</div>`;
    };
    let interviewHtml = "";
    if (iq.company_style) interviewHtml += `<p class="lead">${esc2(iq.company_style)}${iq.research_source?` <span class="src">Source: ${esc2(iq.research_source)}</span>`:""}</p>`;
    const roleQs = (iq.role_specific && iq.role_specific.length) ? iq.role_specific : (iq.technical || []);
    const behQs = iq.behavioural || [];
    const coQs = iq.company_specific || [];
    if (roleQs.length) interviewHtml += `<div class="qa-grp"><div class="qa-h">Role questions</div>${roleQs.map(q=>qCard(q,"Tests")).join("")}</div>`;
    if (behQs.length) interviewHtml += `<div class="qa-grp"><div class="qa-h">Behavioural questions</div>${behQs.map(q=>qCard(q,"Competency")).join("")}</div>`;
    if (coQs.length) interviewHtml += `<div class="qa-grp"><div class="qa-h">Company-specific questions</div>${coQs.map(q=>qCard(q,"Focus")).join("")}</div>`;
    const crs = iq.assessment_strategy || iq.coding_round_strategy;
    if (crs && (crs.overview || (crs.step_by_step && crs.step_by_step.length))) {
      const roundLabel = crs.round_type ? esc2(crs.round_type.charAt(0).toUpperCase()+crs.round_type.slice(1)+" strategy") : "Assessment strategy";
      let s = `<div class="qa-grp"><div class="qa-h">${roundLabel}</div>`;
      if (crs.overview) s += `<p class="lead" style="margin-bottom:12px">${esc2(crs.overview)}</p>`;
      if (crs.step_by_step && crs.step_by_step.length) s += `<ol class="plan">${crs.step_by_step.map((x,i)=>`<li><span class="plan-n">${i+1}</span><div><div class="plan-a">${esc2(x)}</div></div></li>`).join("")}</ol>`;
      if (crs.when_stuck) s += `<div class="qa-g" style="margin-top:12px"><span class="qa-gl">When you're stuck</span>${esc2(crs.when_stuck)}</div>`;
      if (crs.mistakes_to_avoid && crs.mistakes_to_avoid.length) s += `<div style="margin-top:14px"><div class="qa-gl" style="color:#bc2b40;margin-bottom:8px">Avoid these mistakes</div><div class="rows">${crs.mistakes_to_avoid.map(m=>`<div class="row"><span class="dotm"></span><span>${esc2(m)}</span></div>`).join("")}</div></div>`;
      s += `</div>`;
      interviewHtml += s;
    }
    if (iq.preparation_checklist && iq.preparation_checklist.length) {
      interviewHtml += `<div class="qa-grp"><div class="qa-h">Preparation checklist</div><ol class="plan">${iq.preparation_checklist.map((item,i)=>{const p=typeof item==="string"?{topic:item}:item;const meta=[p.time_needed||"",p.why||""].filter(Boolean).join("  &middot;  ");return `<li><span class="plan-n">${i+1}</span><div><div class="plan-a">${esc2(p.topic||"")}</div>${meta?`<div class="plan-m">${esc2(meta)}</div>`:""}${p.resource?`<div class="plan-m">${esc2(p.resource)}</div>`:""}</div></li>`;}).join("")}</ol></div>`;
    }

    const box = (title, c, bg, inner, cls) => `<section class="sec${cls?` ${cls}`:""}" style="--secaccent:${c}"><div class="sec-h" style="background:${bg}"><span class="dot" style="background:${c}"></span><span class="sec-t">${title}</span></div><div class="sec-b">${inner}</div></section>`;
    const grp = (label, c, inner, first) => `<div class="grp"${first?"":` style="margin-top:16px"`}><div class="subl" style="color:${c}">${label}</div>${inner}</div>`;
    let sectionsHtml = "";
    if (mathRows) sectionsHtml += box('How the score was calculated', '#2078D8', '#eef4fd', `<table class="mt"><thead><tr><th>Dimension</th><th>Score</th><th>Weight</th><th>Points</th></tr></thead><tbody>${mathRows}</tbody></table>`);
    { let inner = "";
      if (strengthsList) inner += grp('Strengths', '#0c8a4b', `<div class="rows">${strengthsList}</div>`, !inner);
      if (areasList) inner += grp('Areas to address', '#c0392b', `<div class="rows">${areasList}</div>`, !inner);
      if (kwChips) inner += grp('Keywords to mirror', '#0c8a4b', `<p class="lead">Screening tools match on exact wording. Add any that are genuinely true for you.</p><div class="chips">${kwChips}</div>${atsHtml}`, !inner);
      else if (atsHtml) inner += grp('Applicant tracking estimate', '#0c8a4b', atsHtml, !inner);
      if (inner) sectionsHtml += box('Fit analysis', '#0c8a4b', '#f1faf5', inner);
    }
    { let inner = "";
      if (checkList) inner += grp('What this role requires', '#d23b54', checkList, !inner);
      if (missingList) inner += grp('How to close the gaps', '#d23b54', missingList, !inner);
      if (inner) sectionsHtml += box('Skills gap', '#d23b54', '#fdf2f4', inner);
    }
    if (planList) sectionsHtml += box('Improvement plan', '#2f7fe0', '#eef4fd', `<ol class="plan">${planList}</ol>`);
    if (suggList) sectionsHtml += box('Resume improvements', '#c47d12', '#fbf4e6', suggList);
    if (interviewHtml) sectionsHtml += box('Interview prep', '#7c4ddb', '#f3edfc', interviewHtml, 'sec-iv');

    const applyVerb = fit === "strong" ? "Apply with a tailored resume" : fit === "weak" ? "Strengthen your resume first" : "Apply with targeted prep";

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Applyin Fit Dossier &middot; ${esc2(job?.title||"")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--accent:${accent};--accent-soft:${accent}12;--accent-line:${accent}33;--brand:#2078D8;--brand-soft:#2078d80f;--brand-line:#2078d833;--good:#2f9e63;--ink:#1b2331;--paper:#eaeef3;--card:#ffffff;--muted:#67717f;--soft:#9aa3b0;--line:#e8ecf1;--serif:'IBM Plex Sans',system-ui,sans-serif;--sans:'IBM Plex Sans',system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--sans);background:#e4e8ee;color:var(--ink);line-height:1.6;padding:34px 16px;-webkit-font-smoothing:antialiased}
.sheet{max-width:680px;margin:0 auto;background:#fff;border-top:4px solid var(--brand);border-radius:3px;overflow:hidden;box-shadow:0 2px 4px rgba(16,26,43,.06),0 22px 60px rgba(16,26,43,.16)}
.headcard,.verdict,.sec,.pull{background:transparent;border:none;border-radius:0;box-shadow:none}
.headcard{overflow:hidden}
/* MASTHEAD */
.masthead{display:flex;flex-direction:column;align-items:center;gap:9px;padding:26px 40px 6px}
.mh-brand{display:flex;align-items:center;gap:11px}
.mh-logo{width:32px;height:32px;border-radius:8px;display:block}
.mh-wm{font-size:18px;font-weight:800;letter-spacing:-.3px}
.mh-a{color:#2078D8}.mh-in{color:#40A870}
.mh-meta{text-align:center;font-size:9.5px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;color:var(--soft);line-height:1.7}
/* LEDE / header */
.lede{padding:24px 40px 22px;text-align:center}
.lede-top{display:flex;flex-direction:column;align-items:center;gap:16px}
.lede-l{min-width:0}
.eyebrow{font-size:10px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:var(--brand);margin-bottom:11px}
.role{font-family:var(--sans);font-weight:700;font-size:28px;line-height:1.12;letter-spacing:-.4px;color:var(--ink);margin-bottom:8px;text-wrap:balance}
.meta{font-size:12.5px;color:var(--muted);letter-spacing:.2px}
.meta b{font-weight:700;color:var(--ink)}
.ring{position:relative;width:122px;height:122px;flex:none;margin-top:4px}
.ring svg{display:block;width:100%;height:100%}
.ring-track{stroke:#e6eaf0}
.ring-arc{transition:stroke-dashoffset 1.1s cubic-bezier(.32,.72,.3,1)}
.ring-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring-n{font-weight:800;font-size:34px;color:var(--accent);letter-spacing:-1px;line-height:1}
.ring-l{font-size:8px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--accent);margin-top:4px;text-align:center;max-width:84px}
.lede-actions{margin-top:18px;text-align:center}
.job-link{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700;letter-spacing:.3px;color:var(--brand);text-decoration:none}
.job-link svg{flex:none;opacity:.8}
.job-link:hover{text-decoration:underline}
/* VERDICT - editorial standfirst */
.verdict{margin:0;padding:4px 44px 24px;text-align:center}
.verdict-l{font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:12px;text-align:center}
.verdict-t{font-family:var(--sans);font-weight:600;font-size:16.5px;line-height:1.5;color:var(--ink);letter-spacing:-.1px;text-wrap:balance;max-width:460px;margin:0 auto}
.verdict-foot{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:16px}
.verdict-pill{display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:#fff;border-radius:30px;padding:9px 16px;font-size:11.5px;font-weight:800;letter-spacing:.3px;white-space:nowrap}
.verdict-pill svg{flex:none}
.verdict-d{font-size:12px;color:var(--muted);line-height:1.5;max-width:440px}
/* interview Q&A */
.qa-grp{margin-top:22px}
.qa-grp:first-child{margin-top:0}
.qa-h{font-size:10px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:var(--accent);margin-bottom:10px}
.qa{padding:10px 0}
.qa-grp .qa:first-of-type{border-top:none;padding-top:0}
.qa-q{font-size:13.5px;font-weight:700;color:var(--ink);line-height:1.45}
.qa-w{font-size:11.5px;color:var(--soft);margin-top:4px;letter-spacing:.2px}
.qa-g{margin-top:10px;background:${accent}0d;border-left:2.5px solid var(--accent);border-radius:0 10px 10px 0;padding:10px 13px;font-size:12.5px;color:#4a463d;line-height:1.6}
.qa-gl{display:block;font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--accent);margin-bottom:5px}
.src{color:var(--soft);font-style:italic}
.sec-iv .qa-h,.sec-iv .qa-gl{color:#7c4ddb}
.sec-iv .qa-g{background:#7c4ddb0d;border-left-color:#7c4ddb}
/* BODY */
.body{display:block;padding:10px 26px 6px}
.sec{margin:0 0 12px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
.sec-h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line)}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.sec-t{font-size:13px;font-weight:700;letter-spacing:.2px;color:var(--ink)}
.sec-b{padding:16px}
.subl{font-size:9.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;margin:0 0 10px}
.sec-n{font-family:var(--sans);font-weight:800;font-size:13px;color:var(--brand);line-height:1;letter-spacing:.5px}
.sec-l{display:inline-block;white-space:nowrap;font-size:10px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;padding:6px 15px;border-radius:30px}
.sec-rule{flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
.lead{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:14px;max-width:54ch;text-align:left}
/* score table */
.mt{width:100%;border-collapse:collapse;font-size:13.5px}
.mt th{font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--soft);font-weight:800;text-align:right;padding:0 0 10px}
.mt th:first-child{text-align:left}
.mt td{padding:8px 0;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.mt .mt-d{text-align:left;font-weight:600;color:var(--ink)}
.mt .mt-p{font-weight:800;color:var(--brand)}
.mt tbody tr:first-child td{border-top:none}
/* rows */
.rows{display:flex;flex-direction:column;gap:2px}
.row{display:flex;gap:12px;align-items:flex-start;padding:10px 0;font-size:13.5px;color:#3b372e;line-height:1.55}
.tick{width:21px;height:21px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(47,158,99,.13);color:var(--good);margin-top:1px}
.dotm{width:21px;height:21px;border-radius:50%;flex:none;margin-top:1px;background:rgba(188,43,64,.1);position:relative}
.dotm::after{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:9px;height:2px;border-radius:2px;background:#bc2b40}
/* requirement checks */
.ck{padding:9px 0}
.ck:first-child{border-top:none;padding-top:0}
.ck-t{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ck-r{font-size:13.5px;font-weight:600;color:var(--ink)}
.ck-b{font-size:10px;font-weight:800;letter-spacing:.4px;border:1px solid;border-radius:30px;padding:3px 10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.ck-d{font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.55;max-width:60ch}
/* chips */
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:12.5px;font-weight:600;background:var(--brand-soft);border:1px solid var(--brand-line);border-radius:9px;padding:7px 13px;color:#1c5fa8}
/* ats */
.ats{margin-top:18px;display:flex;align-items:center;gap:20px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.ats-n{font-family:var(--sans);font-weight:800;font-size:27px;color:var(--brand);line-height:1;flex:none;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.ats-n span{font-family:var(--sans);font-size:13px;font-weight:700;color:var(--soft);margin-left:4px}
.ats-d{font-size:12px;color:var(--muted);line-height:1.55}
/* plan */
.plan{list-style:none;display:flex;flex-direction:column;gap:4px}
.plan li{display:flex;gap:14px;align-items:flex-start;padding:9px 0}
.plan li:first-child{border-top:none;padding-top:0}
.plan-n{font-family:var(--sans);font-weight:800;font-size:14px;color:var(--brand);line-height:1;width:22px;flex:none;text-align:center;font-variant-numeric:tabular-nums}
.plan-a{font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.45}
.plan-m{font-size:11.5px;color:var(--soft);margin-top:3px;letter-spacing:.3px}
/* rewrites */
.rw{padding:10px 0}
.rw:first-child{border-top:none;padding-top:0}
.rw-h{font-size:13.5px;font-weight:700;color:var(--ink);margin-bottom:9px;line-height:1.4}
.rw-b,.rw-a{font-size:12.5px;line-height:1.55;padding:8px 12px;border-radius:0 9px 9px 0;margin-bottom:6px}
.rw-b{color:var(--muted);background:rgba(188,43,64,.06);border-left:2px solid #c98b97}
.rw-a{color:var(--ink);background:rgba(47,158,99,.08);border-left:2px solid var(--good);font-weight:500}
.rw-b span,.rw-a span{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;margin-right:8px;opacity:.65}
.rw-f{font-size:12.5px;color:var(--muted);line-height:1.55}
/* next-step pull quote */
.pull{margin:0;padding:24px 40px;position:relative;text-align:center}
.pull::before{display:none}
.pull-l{font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--brand);margin-bottom:8px}
.pull-q{font-family:var(--sans);font-weight:700;font-size:18px;line-height:1.4;color:var(--ink);letter-spacing:-.2px;text-wrap:balance;max-width:460px;margin:0 auto}
.pull-r{font-size:12.5px;color:var(--muted);margin-top:9px;line-height:1.55}
/* footer seal */
.foot{padding:8px 40px 28px;text-align:center}
.seal{display:inline-flex;flex-direction:column;align-items:center;gap:12px}
.seal-r{width:62px;height:62px;border-radius:50%;border:1.5px solid var(--brand);display:flex;align-items:center;justify-content:center;position:relative;color:var(--brand)}
.seal-r::before{content:"";position:absolute;inset:5px;border-radius:50%;border:1px dashed #2078d866}
.seal-mono{font-family:var(--sans);font-weight:800;font-size:21px}
.seal-t{font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--soft);font-weight:700;line-height:1.7}
.fine{margin-top:18px;font-size:10.5px;color:var(--soft);line-height:1.6;max-width:46ch;margin-left:auto;margin-right:auto;letter-spacing:.2px}
.foot-url{margin-top:20px}
.foot-url a{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:var(--brand);text-decoration:none;letter-spacing:.3px}
.foot-url a svg{flex:none}
.foot-raw{margin-top:6px;font-size:10.5px;color:var(--soft);word-break:break-all;letter-spacing:.2px;max-width:52ch;margin-left:auto;margin-right:auto}
.pdfbtn{position:fixed;right:22px;bottom:22px;display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;border:none;border-radius:30px;padding:12px 18px;font-family:var(--sans);font-size:13px;font-weight:800;letter-spacing:.2px;cursor:pointer;box-shadow:0 10px 26px rgba(0,0,0,.22);z-index:99;transition:filter .15s}
.pdfbtn:hover{filter:brightness(1.07)}
.pdfbtn svg{flex:none}
@media (max-width:560px){.masthead,.lede,.sec,.pull,.foot{padding-left:18px;padding-right:18px}.lede-top{flex-direction:column-reverse;align-items:flex-start;gap:18px}.role{font-size:26px}}
@media print{
  @page{margin:11mm}
  body{background:#fff;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sheet{box-shadow:none;border-radius:0;max-width:none;gap:7px}
  .pdfbtn{display:none}
  .headcard,.verdict,.sec,.pull{box-shadow:none;border:1px solid #dde3ea;border-radius:9px}
  .headcard{background:#fff}
  .masthead{padding:13px 16px 0}
  .lede{padding:9px 16px 14px}
  .sec{padding:13px 16px}
  .sec-h{margin-bottom:9px}
  .body{gap:7px}
  .verdict,.pull{padding:13px 16px}
  .foot{padding:10px 16px 0}
  .lead{margin-bottom:9px}
  .ring{width:92px;height:92px}
  .ring svg{width:92px;height:92px}
  .ring-n{font-size:28px}
  .role{font-size:25px}
  .headcard,.verdict,.sec,.pull,.rw,.ck,.plan li,.qa,.qa-grp{break-inside:avoid}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
</style></head><body>
<div class="sheet">
  <div class="headcard">
  <div class="masthead">
    <div class="mh-brand"><img class="mh-logo" src="${LOGO}" alt="Applyin"><span class="mh-wm"><span class="mh-a">Apply</span><span class="mh-in">in</span></span></div>
    <div class="mh-meta">Fit Dossier &middot; ${dt}</div>
  </div>
  <div class="lede">
    <div class="lede-top">
      <div class="lede-l">
        <div class="eyebrow">Candidate fit assessment</div>
        <div class="role">${esc2(job?.title||"This role")}</div>
        <div class="meta">${job?.company?`<b>${esc2(job.company)}</b>`:""}${job?.location?` &middot; ${esc2(job.location)}`:""}</div>
      </div>
      <div class="ring">
        <svg viewBox="0 0 120 120" width="112" height="112"><circle class="ring-track" cx="60" cy="60" r="50" fill="none" stroke-width="9"/><circle class="ring-arc" cx="60" cy="60" r="50" fill="none" stroke="${accent}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${RC}" stroke-dashoffset="${RC}" transform="rotate(-90 60 60)"/></svg>
        <div class="ring-c"><div class="ring-n">${score}</div><div class="ring-l">${statusWord}</div></div>
      </div>
    </div>
    ${jobUrl?`<div class="lede-actions"><a class="job-link" href="${esc2(jobUrl)}" target="_blank" rel="noopener"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Revisit the original posting</a></div>`:""}
  </div>
  </div>
  ${(verdictText||rec.derivation)?`<div class="verdict"><div class="verdict-l">The verdict</div>${verdictText?`<div class="verdict-t">${esc2(verdictText)}</div>`:""}<div class="verdict-foot"><span class="verdict-pill"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><polyline points="20 6 9 17 4 12"/></svg>${esc2(applyVerb)}</span></div></div>`:""}
  <div class="body">${sectionsHtml}</div>
  ${nextStep?`<div class="pull"><div class="pull-l">The one move</div><div class="pull-q">${esc2(nextStep)}</div>${rec.reasoning?`<div class="pull-r">${esc2(rec.reasoning)}</div>`:""}</div>`:""}
  <div class="foot">
    <div class="seal"><div class="seal-r"><span class="seal-mono">A</span></div><div class="seal-t">Verified analysis<br>${dt}</div></div>
    ${jobUrl?`<div class="foot-url"><a href="${esc2(jobUrl)}" target="_blank" rel="noopener"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open the original job posting</a><div class="foot-raw">${esc2(jobUrl)}</div></div>`:""}
    <div class="fine">Generated by Applyin. Scores are a directional estimate to guide your application, not a guarantee of any outcome.</div>
  </div>
</div>
<script>requestAnimationFrame(()=>{requestAnimationFrame(()=>{var a=document.querySelector('.ring-arc');if(a)a.style.strokeDashoffset='${ringOff}';});});</script>
<button class="pdfbtn" onclick="window.print()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Save as PDF</button>
</body></html>`;

    try {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safe = (job?.title || "report").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      a.href = url; a.download = `applyin-${safe}.html`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      log.warn("Report download failed", e);
    }
  }

  function scrapeJobData() {
    const title = getText([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".jobs-unified-top-card__job-title h1",
      "h1.t-24.t-bold", "h1.t-24",
      ...Array.from(document.querySelectorAll("h1")).filter(h => h.textContent.trim().length < 120).map((_, i) => `h1:nth-of-type(${i + 1})`)
    ]) || document.title.split(" | ")[0];

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
      const t = document.title;
      if (t.includes(" at ")) {
        company = t.split(" at ")[1]?.split(" |")[0]?.trim() || "";
      } else {
        const parts = t.split(" | ");
        if (parts.length >= 3 && parts[2]?.trim() === "LinkedIn") {
          company = parts[1]?.trim() || "";
        } else if (parts.length === 2) {
          company = parts[1]?.replace("LinkedIn", "").trim() || "";
        }
      }
    }

    if (!company) {
      try {
        const companyLinks = document.querySelectorAll("a[href*='linkedin.com/company/']");
        for (const link of companyLinks) {
          const text = link.textContent.trim();
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

    // ── Priority 1: LinkedIn's own job-details containers ───────────────────
    // These are the canonical selectors for the JD pane. Tried in order of
    // specificity; first one with real content wins.
    const jdSelectors = [
      // Current LinkedIn DOM (2024-2025)
      "#job-details",
      ".jobs-description__content",
      ".jobs-description-content__content",
      ".jobs-description-content",
      ".jobs-box__html-content",
      // Unified top-card description area
      ".job-details-jobs-unified-top-card__job-description",
      "[class*='jobs-description__container']",
      "[class*='jobs-description']",
      // Fallback: article or section that contains a known JD landmark
      "article.jobs-description",
      "section.jobs-description",
    ];
    for (const sel of jdSelectors) {
      try {
        const el = document.querySelector(sel);
        const t = el?.innerText?.trim() || "";
        // Must have real content - at least 200 chars AND contain at least one
        // job-related keyword so we don't accidentally grab a tiny decorative div.
        if (t.length > 200 && /responsibilities|requirements|experience|qualifications|skills|about the role|about this role|what you.ll|you will|we are looking/i.test(t)) {
          description = t;
          break;
        }
        // Accept even without keywords if it's a large block (>800 chars) from
        // a designated job-details container (selector is specific enough).
        if (t.length > 800 && (sel.includes("job-details") || sel.includes("jobs-description"))) {
          description = t;
          break;
        }
      } catch { }
    }

    // ── Priority 2: "Show more" expanded content ─────────────────────────────
    // LinkedIn hides part of the JD behind a "See more" button. After clicking
    // it the content lands in a span/div inside the job-details container. If we
    // still have no description, look for that expanded block explicitly.
    if (!description) {
      try {
        const expanded = document.querySelector(
          "#job-details .jobs-description-content__text, " +
          "#job-details span[class*='white-space']"
        );
        const t = expanded?.innerText?.trim() || "";
        if (t.length > 200) description = t;
      } catch { }
    }

    // ── Priority 3: scored candidate search ─────────────────────────────────
    // Only runs if the targeted selectors all missed. Scores each candidate div
    // on job-keyword density rather than just picking the biggest element, which
    // previously caused the nav bar / full page to win.
    if (!description) {
      const JD_KEYWORDS = /\b(responsibilities|requirements|qualifications|experience|skills|you will|you'll|we are looking|about the role|about this role|minimum|preferred|must have|nice to have|what you|day.to.day|key responsibilities|job description|position overview|role overview)\b/gi;
      const scored = Array.from(document.querySelectorAll("div, section, article"))
        .filter(el => {
          // Skip the sidebar itself and any element that contains our extension.
          if (el.closest("#cc-root")) return false;
          const t = el.innerText || "";
          // Reasonable length range for a JD - not too short, not the whole page.
          if (t.length < 300 || t.length > 30000) return false;
          // Must have at least two distinct job-keyword matches.
          const matches = t.match(JD_KEYWORDS) || [];
          if (matches.length < 2) return false;
          // Do NOT hard-reject on short lines. Real JDs are heavily bulleted
          // (responsibilities, requirements, one-word skill tags), so short average
          // line length is normal for a JD, not proof of navigation. We only reject
          // the EXTREME nav case here (almost all lines are tiny labels AND there are
          // many of them); finer discrimination is handled by scoring below.
          const lines = t.split("\n").filter(l => l.trim().length > 0);
          const avgLineLen = t.length / Math.max(1, lines.length);
          const tinyLines = lines.filter(l => l.trim().length < 12).length;
          if (lines.length > 30 && avgLineLen < 10 && tinyLines / lines.length > 0.8) {
            return false;  // unmistakable nav/menu: very many, very tiny lines
          }
          return true;
        })
        .map(el => {
          const t = el.innerText;
          const kws = (t.match(JD_KEYWORDS) || []).length;
          const lines = t.split("\n").filter(l => l.trim().length > 0);
          const avgLineLen = t.length / Math.max(1, lines.length);
          // Keyword density dominates. Prose-like text (longer average lines) gets a
          // small bonus so that, between two similar candidates, the more
          // paragraph-like one is preferred - but a bulleted JD is NOT excluded, it
          // just relies on its keyword score to win.
          const proseBonus = avgLineLen >= 25 ? 200 : 0;
          return { el, len: t.length, kws, score: kws * 120 + Math.min(t.length, 8000) + proseBonus };
        })
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        description = scored[0].el.innerText.trim();
      }
    }

    // ── Sanity check: detect if we accidentally grabbed navigation ───────────
    // The nav bar contains these tell-tale phrases. If the captured text starts
    // with them or has a very high ratio of short lines, it's nav, not a JD.
    // Block the analysis rather than send garbage to the AI.
    const _isNavContent = (t) => {
      if (!t) return false;
      // Starts with typical LinkedIn chrome
      if (/^(0 notifications|skip to main content|home\s+my network|jobs\s+messaging)/i.test(t.slice(0, 60))) return true;
      // NOTE: a previous "short-line ratio" heuristic lived here and WRONGLY flagged
      // real job descriptions as nav. JDs are full of short lines (bulleted
      // responsibilities, requirements, single-word skill tags), so a high
      // short-line ratio is normal for a JD, not a signal of navigation. That rule
      // cleared valid JDs and blocked analysis. Removed. The targeted selectors
      // above already avoid the nav chrome; the only nav signal we keep is the
      // explicit LinkedIn chrome prefix match on the first line.
      return false;
    };

    // Strip LinkedIn nav/chrome from the front of the captured text instead of
    // discarding the whole JD. When a broad selector grabs a block that begins with
    // the page chrome ("0 notifications  Skip to main content  Home  My Network
    // Jobs  Messaging …") followed by the real job description, we cut everything up
    // to where the actual JD begins rather than throwing the JD away.
    const _stripNavPrefix = (t) => {
      if (!t) return t;
      // Find the first strong JD landmark and cut to it if there's chrome before it.
      const landmark = t.search(/\b(about the job|about this role|about the role|job description|responsibilities|what you.ll do|what you will do|the role|role overview|position overview|key responsibilities|requirements|qualifications|who you are|we are looking|minimum qualifications)\b/i);
      if (landmark > 0) {
        // Only strip if the text BEFORE the landmark looks like nav chrome (short,
        // menu-like) rather than real JD content we'd lose.
        const head = t.slice(0, landmark);
        const headLines = head.split("\n").filter(l => l.trim().length > 0);
        const headIsChrome = /0 notifications|skip to main content|my network|messaging|notifications/i.test(head)
                             || (headLines.length > 3 && head.length / Math.max(1, headLines.length) < 22);
        if (headIsChrome) return t.slice(landmark).trim();
      }
      return t;
    };

    description = _stripNavPrefix(description);

    // After stripping, only clear as a LAST resort if what remains STILL begins with
    // raw page chrome (meaning we couldn't find any JD landmark at all).
    if (/^(0 notifications|skip to main content|home\s+my network|jobs\s+messaging)/i.test(description.slice(0, 60))) {
      log.warn("JD capture is still page navigation after strip; clearing. Try scrolling to the description, then retry.");
      description = "";
    }

    // Full JD is sent as-is. The AI extracts the real requirements and ignores
    // company marketing/benefits/culture (see the analysis prompt's STEP 0 and
    // the "ignore company marketing" instruction). No brittle regex trimming.

    // No client-side skill guessing. The backend reads the full JD and extracts
    // requirements for ANY domain (hospitality, BPO, finance, trades, etc.), so a
    // hardcoded tech-keyword list here would both bias the tool toward software
    // roles and mislead non-technical users. Send no skills hint; the JD is enough.
    const skills = [];

    let experience = "Not specified";
    const expPatterns = [
      /(\d{1,2})\s*\+?\s*(?:to\s*\d{1,2}\s*)?years?(?:\s+of)?\s+(?:relevant\s+|professional\s+|hands[- ]?on\s+)?experience/i,
      /(?:minimum|min\.?|at least)\s+(\d{1,2})\s*\+?\s*years?/i,
      /(\d{1,2})\s*\+?\s*years?\s+(?:in|as|with|of)\s+\w+/i,
    ];
    for (const re of expPatterns) {
      const m = description.match(re);
      if (m && parseInt(m[1]) >= 1 && parseInt(m[1]) <= 40) {
        experience = `${m[1]}+ years`;
        break;
      }
    }

    const jid = currentJobId();
    const url = /^\d+$/.test(jid) ? `https://www.linkedin.com/jobs/view/${jid}/` : window.location.href;

    return { title, company, location, description, skills, experience, url };
  }

  function currentJobId() {
    // /jobs/view/<id> (detail page) OR /jobs/search/?currentJobId=<id> (split list view).
    const viewM = window.location.href.match(/\/jobs\/view\/(\d+)/);
    if (viewM) return viewM[1];
    try {
      const q = new URLSearchParams(window.location.search).get("currentJobId");
      if (q) return q;
    } catch (e) { }
    const anyM = window.location.href.match(/currentJobId=(\d+)/);
    if (anyM) return anyM[1];
    return window.location.href;
  }

  // ── Build sidebar HTML ─────────────────────────────────────────────────────
  function buildHTML() {
    return `
<div class="cc-header">
  <div class="cc-brand">
    <img id="cc-brand-img" width="26" height="26" style="border-radius:6px;display:block" />
    <span class="cc-wordmark"><span style="color:#2078D8">Apply</span><span style="color:#40A870">in</span></span>
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
  <div class="cc-auth-wall" id="cc-auth-wall" style="display:none">
    <div class="cc-auth-logo">
      <img id="cc-auth-logo-img" width="56" height="56" style="border-radius:14px;display:block;margin-bottom:4px" />
      <span class="cc-wordmark"><span style="color:#2078D8">Apply</span><span style="color:#40A870">in</span></span>
    </div>
    <p class="cc-auth-tagline">Know your fit before you apply.</p>
    <div class="cc-auth-tabs">
      <button class="cc-auth-tab active" data-tab="login">Sign in</button>
      <button class="cc-auth-tab" data-tab="signup">Create account</button>
    </div>
    <div class="cc-auth-form" id="cc-auth-form">
      <input type="email" class="cc-auth-input" id="cc-auth-email" placeholder="Email address" autocomplete="email" />
      <input type="password" class="cc-auth-input" id="cc-auth-password" placeholder="Password" autocomplete="current-password" />
      <label class="cc-consent-row" id="cc-consent-row" style="display:none">
        <input type="checkbox" class="cc-consent-box" id="cc-consent-box" />
        <span class="cc-consent-text">I agree that my resume and the job details I choose are sent to Applyin's AI provider to generate my analysis, and that my analysis is saved to give consistent results (deletable any time). See the <a href="${URLS.privacy}" target="_blank" class="cc-consent-link">Privacy Policy</a>.</span>
      </label>
      <div class="cc-auth-error" id="cc-auth-error"></div>
      <button class="cc-analyse-btn" id="cc-auth-submit">Sign in</button>
    </div>
    <p class="cc-auth-free">3 free analyses on signup · No card required</p>
  </div>

  <div class="cc-section-plain cc-on-grad">
    <div class="cc-empty-hero">
      <div class="t1">Know your fit before you apply</div>
      <div class="t2">Upload your resume once, then score any LinkedIn role.</div>
    </div>
    <div class="cc-upload-row" id="cc-upload-row">
      <label class="cc-upload-zone" id="cc-upload-zone" for="cc-file-input">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span id="cc-upload-label">Upload resume PDF</span>
      </label>
      <input type="file" id="cc-file-input" accept=".pdf,application/pdf" style="display:none" />
      <div class="cc-usage-pill" id="cc-usage-pill">· / 3</div>
    </div>
    <div class="cc-steps" id="cc-steps" style="display:none"></div>
    <div class="cc-job-chip" id="cc-job-chip">Detecting job…</div>
    <button class="cc-analyse-btn" id="cc-analyse-btn">Analyse fit</button>
  </div>

  <div id="cc-results" style="display:none">
    <div id="cc-result-context" style="display:none">
      <div>
        <div id="cc-result-job-title"></div>
        <div id="cc-result-company"></div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span id="cc-cached-badge" style="display:none">⚡ Free</span>
        <button id="cc-reanalyse-btn" style="display:none">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>Fresh</span>
        </button>
      </div>
    </div>

    <div class="cc-score-block" id="cc-score-block">
      <div class="cc-sc-header" id="cc-sc-header">
        <div class="cc-sc-toprow">
          <span class="cc-sc-eyebrow">Your fit</span>
          <div class="cc-sc-apply-indicator" id="cc-apply-badge">
            <span class="cc-sc-apply-dot"></span>
            <span class="cc-sc-apply-text">–</span>
          </div>
        </div>
        <div class="cc-sc-role-name" id="cc-sc-role-name">–</div>
        <div class="cc-sc-arc-wrap">
          <svg width="178" height="178" viewBox="0 0 178 178" id="cc-score-circle" style="display:block">
            <defs>
              <linearGradient id="cc-arc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="rgba(255,255,255,.55)"/>
                <stop offset="100%" stop-color="rgba(255,255,255,1)"/>
              </linearGradient>
            </defs>
            <circle cx="89" cy="89" r="76" fill="none" stroke="#e7edf3" stroke-width="13"/>
            <circle id="cc-score-ring" cx="89" cy="89" r="76" fill="none" stroke="var(--accent)" stroke-width="13" stroke-linecap="round" stroke-dasharray="478" stroke-dashoffset="478" transform="rotate(-90 89 89)"/>
            <text id="cc-score-num" x="89" y="93" text-anchor="middle" font-size="48" font-weight="800" fill="#0f1d2b" letter-spacing="-2" font-family="inherit">–</text>
            <text id="cc-score-label" x="89" y="116" text-anchor="middle" font-size="10.5" font-weight="800" fill="var(--accent)" letter-spacing="1.4" font-family="inherit">–</text>
          </svg>
        </div>
        <div class="cc-trust-wrap">
          <span class="cc-trust">
            <svg class="cc-trust-seal" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
            <span>Same result within 24h</span>
            <span class="cc-info-wrap" tabindex="0">
              <svg class="cc-info-ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span class="cc-info-pop">We cache each analysis for 24 hours. Within that window, re-opening this job (even tapping Fresh) returns the same score, gaps and suggestions, with no credit charged. After 24 hours the cached result expires, so a fresh run is a new analysis and the score may vary slightly. The score is a fixed weighting of skills, experience, domain, qualifications and soft skills.</span>
            </span>
          </span>
        </div>
        <div class="cc-sc-stats">
          <div class="cc-sc-stat"><div class="cc-sc-stat-l">Skills</div><div class="cc-sc-stat-v" id="cc-dash-match-val">–</div></div>
          <div class="cc-sc-stat"><div class="cc-sc-stat-l">Exp</div><div class="cc-sc-stat-v" id="cc-dash-exp-val">–</div></div>
          <div class="cc-sc-stat"><div class="cc-sc-stat-l">Gaps</div><div class="cc-sc-stat-v cc-sc-stat-amber" id="cc-dash-gaps-val">–</div></div>
          <div class="cc-sc-stat"><div class="cc-sc-stat-l">Fixes</div><div class="cc-sc-stat-v cc-sc-stat-blue" id="cc-dash-fixes-val">–</div></div>
        </div>
      </div>
      <div class="cc-sc-white">
        <div class="cc-result-summary">
          <div class="cc-score-verdict" id="cc-verdict"></div>
          <div class="cc-breakdown-block" id="cc-score-breakdown" style="display:none">
            <div class="cc-breakdown-heading">Score breakdown</div>
            <div id="cc-breakdown-rows"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="cc-acc-list" id="cc-acc-list">
      <details class="cc-acc" id="cc-acc-fit" open>
        <summary class="cc-acc-head">
          <span class="cc-acc-left"><span class="cc-acc-dot" style="background:var(--green)"></span><span class="cc-acc-title">Fit analysis</span></span>
          <span class="cc-acc-right"><span class="cc-acc-badge" id="cc-badge-fit"></span><svg class="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </summary>
        <div class="cc-acc-teaser" id="cc-teaser-fit"></div>
        <div class="cc-acc-body" id="cc-fit-body"></div>
      </details>
      <details class="cc-acc" id="cc-acc-skills">
        <summary class="cc-acc-head">
          <span class="cc-acc-left"><span class="cc-acc-dot" style="background:var(--red)"></span><span class="cc-acc-title">Skills gap</span></span>
          <span class="cc-acc-right"><span class="cc-acc-badge" id="cc-badge-skills"></span><svg class="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </summary>
        <div class="cc-acc-teaser" id="cc-teaser-skills"></div>
        <div class="cc-acc-body" id="cc-skills-body"></div>
      </details>
      <details class="cc-acc" id="cc-acc-plan">
        <summary class="cc-acc-head">
          <span class="cc-acc-left"><span class="cc-acc-dot" style="background:#2f7fe0"></span><span class="cc-acc-title">Improvement plan</span></span>
          <span class="cc-acc-right"><span class="cc-acc-badge" id="cc-badge-plan"></span><svg class="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </summary>
        <div class="cc-acc-teaser" id="cc-teaser-plan"></div>
        <div class="cc-acc-body" id="cc-plan-body"></div>
      </details>
      <details class="cc-acc" id="cc-acc-resume">
        <summary class="cc-acc-head">
          <span class="cc-acc-left"><span class="cc-acc-dot" style="background:var(--amber)"></span><span class="cc-acc-title">Resume improvements</span></span>
          <span class="cc-acc-right"><span class="cc-acc-badge" id="cc-badge-resume"></span><svg class="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </summary>
        <div class="cc-acc-teaser" id="cc-teaser-resume"></div>
        <div class="cc-acc-body" id="cc-resume-body"></div>
      </details>
      <details class="cc-acc" id="cc-acc-interview">
        <summary class="cc-acc-head">
          <span class="cc-acc-left"><span class="cc-acc-dot" style="background:#7c3aed"></span><span class="cc-acc-title">Interview prep</span></span>
          <span class="cc-acc-right"><span class="cc-acc-badge" id="cc-badge-interview"></span><svg class="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </summary>
        <div class="cc-acc-teaser" id="cc-teaser-interview"></div>
        <div class="cc-acc-body" id="cc-interview-body"></div>
      </details>
    </div>

    <div class="cc-next-step" id="cc-next-step"></div>
    <button id="cc-download-report" class="cc-report-link" style="display:none">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Save report card (HTML)
    </button>
  </div>

  <div class="cc-loading" id="cc-loading" style="display:none">
    <div class="cc-ld-top">
      <div class="cc-ld-ctx">
        <div class="cc-ld-eyebrow">Analysing fit for</div>
        <div class="cc-ld-role" id="cc-ld-role">Loading…</div>
      </div>
    </div>
    <div class="cc-ld-mid">
      <div class="cc-ld-logo-zone"><img id="cc-loading-logo-img" class="cc-ld-logo" alt="Applyin" /></div>
      <div class="cc-ld-live">
        <div class="cc-ld-stage" id="cc-loading-msg">Getting started</div>
        <div class="cc-ld-detail" id="cc-ld-detail">Preparing your analysis…</div>
      </div>
    </div>
    <div class="cc-ld-bottom">
      <div class="cc-ld-prog-wrap">
        <div class="cc-ld-prog-head">
          <span class="cc-ld-step-lbl" id="cc-ld-step-lbl">Step 1 of 5</span>
          <span class="cc-ld-pct" id="cc-loading-pct">15%</span>
        </div>
        <div class="cc-ld-bar-track"><div class="cc-ld-bar" id="cc-loading-arc"></div></div>
      </div>
      <div class="cc-ld-fact-zone">
        <div class="cc-ld-fact-label">Did you know?</div>
        <div class="cc-ld-fact" id="cc-loading-fact"></div>
      </div>
    </div>
  </div>

  <div class="cc-paywall cc-on-grad" id="cc-paywall" style="display:none">
    <div class="cc-paywall-icon">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <div class="cc-paywall-title">You're out of credits</div>
    <p class="cc-paywall-desc">Top up to keep scoring your fit, generating resume fixes and interview prep.</p>
    <div class="cc-paywall-feats">
      <div class="cc-paywall-feat"><span class="cc-paywall-feat-ic"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span><span>Unlimited fit analyses</span></div>
      <div class="cc-paywall-feat"><span class="cc-paywall-feat-ic"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span><span>AI resume rewrites</span></div>
      <div class="cc-paywall-feat"><span class="cc-paywall-feat-ic"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span><span>Full interview prep guides</span></div>
    </div>
    <button class="cc-analyse-btn cc-btn-white" id="cc-upgrade-cta">Upgrade to Pro →</button>
    <p class="cc-paywall-sub">From $6/mo · cancel anytime</p>
  </div>
</div>

<div id="cc-settings" style="display:none" class="cc-scroll">
  <div class="cc-settings-head">
    <button class="cc-hbtn" id="cc-settings-back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span class="cc-settings-title">Account</span>
  </div>
  <div class="cc-acct-profile">
    <div class="cc-acct-avatar" id="cc-acct-avatar">A</div>
    <div class="cc-acct-id">
      <div class="cc-acct-name" id="cc-acct-name">Your account</div>
      <button class="cc-acct-email" id="cc-copy-email" type="button" aria-label="Copy email">
        <span id="cc-s-email">·</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    </div>
  </div>
  <div class="cc-settings-flow">
    <div class="cc-card cc-acct-credits" id="cc-credits-card">
      <div class="cc-acct-credits-top">
        <div>
          <div class="cc-acct-credits-num" id="cc-s-usage">…</div>
          <div class="cc-acct-credits-lbl">credits remaining</div>
        </div>
        <div class="cc-credits-right">
          <span class="cc-low-tag" id="cc-low-tag">Running low</span>
          <button class="cc-acct-buy" id="cc-buy-more-btn">Buy more</button>
        </div>
      </div>
    </div>

    <div class="cc-sett-group">
      <div class="cc-sett-label">Resume</div>
      <div class="cc-card cc-sett-onecard" id="cc-resume-card">
        <div class="cc-sett-row">
          <span class="cc-sett-row-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
          <div class="cc-sett-row-body">
            <div class="cc-sett-row-title" id="cc-resume-name">Your resume</div>
            <div class="cc-sett-row-sub" id="cc-s-resume-status">No resume saved.</div>
          </div>
          <div class="cc-sett-actions" id="cc-resume-actions">
            <button class="cc-sett-pill cc-primary" id="cc-upload-resume" style="display:none">Upload</button>
            <button class="cc-sett-pill cc-primary" id="cc-replace-resume" style="display:none">Replace</button>
            <button class="cc-sett-pill cc-danger" id="cc-clear-resume" style="display:none">Remove</button>
          </div>
          <div class="cc-sett-confirm" id="cc-remove-confirm">
            <span class="cc-confirm-q">Remove?</span>
            <button class="cc-sett-pill" id="cc-remove-no">No</button>
            <button class="cc-sett-pill cc-danger" id="cc-remove-yes">Yes</button>
          </div>
        </div>
      </div>
    </div>

    <div class="cc-sett-group">
      <div class="cc-sett-label">Preferences</div>
      <div class="cc-card cc-sett-onecard">
        <div class="cc-sett-row">
          <span class="cc-sett-row-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></span>
          <div class="cc-sett-row-body">
            <div class="cc-sett-row-title">Dark mode</div>
            <div class="cc-sett-row-sub" id="cc-dm-sub">Easier on the eyes at night</div>
          </div>
          <label class="cc-toggle-switch" id="cc-theme-toggle" aria-label="Dark mode">
            <input type="checkbox" id="cc-theme-input">
            <div class="cc-toggle-track"></div>
            <div class="cc-toggle-thumb"></div>
          </label>
        </div>
      </div>
    </div>

    <button class="cc-signout-btn" id="cc-logout-btn">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      <span>Sign out</span>
    </button>
    <div class="cc-signout-confirm" id="cc-signout-confirm">
      <div class="cc-so-q">Sign out of Applyin?</div>
      <div class="cc-so-actions">
        <button class="cc-so-cancel" id="cc-signout-cancel">Cancel</button>
        <button class="cc-so-yes" id="cc-signout-yes">Sign out</button>
      </div>
    </div>

    <div class="cc-acct-footer">
      <div class="cc-foot-links"><a href="${URLS.help}" target="_blank" rel="noopener">Help</a><span>·</span><a href="${URLS.privacy}" target="_blank" rel="noopener">Privacy</a><span>·</span><a href="${URLS.terms}" target="_blank" rel="noopener">Terms</a></div>
      <div class="cc-foot-ver">Applyin <span id="cc-app-ver">${APP_VERSION}</span> · <a href="${CFG.SITE}/changelog" target="_blank" rel="noopener">What's new</a></div>
    </div>
  </div>
</div>`;
  }

  // ── Inject ─────────────────────────────────────────────────────────────────
  function inject() {
    if (document.getElementById("cc-root")) return;

    const root = document.createElement("div");
    root.id = "cc-root";
    root.innerHTML = buildHTML();
    document.body.appendChild(root);
    document.body.classList.add("cc-pushed");
    sidebarEl = root;

    if (!document.getElementById("cc-pull-tab")) {
      const pullTab = document.createElement("div");
      pullTab.id = "cc-pull-tab";
      pullTab.title = "Open Applyin";
      const iconUrl = chrome.runtime.getURL('icons/icon48.png');
      pullTab.innerHTML = `<img src="${iconUrl}" width="30" height="30" style="display:block" />`;
      document.body.appendChild(pullTab);
      pullTab.addEventListener("click", expandSidebar);
      chrome.storage.local.get("last_fit", ({ last_fit }) => { if (last_fit) applyPullTabFit(last_fit); });
    }

    wire();

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

  function showReanalyseNudge() {
    sidebarEl?.querySelector("#cc-reanalyse-nudge")?.remove();
    const nudge = document.createElement("div");
    nudge.id = "cc-reanalyse-nudge";
    nudge.className = "cc-reanalyse-nudge";
    nudge.innerHTML = `<span>Resume updated. Re-analyse to get personalised results</span><button id="cc-reanalyse-btn">Re-analyse</button>`;
    const anchor = sidebarEl?.querySelector(".cc-section-plain");
    if (anchor) anchor.after(nudge);
    nudge.querySelector("#cc-reanalyse-btn").addEventListener("click", () => {
      nudge.remove();
      analyse(true);
    });
  }

  // ── Analysis ─────────────────────────────────────────────────────────────
  function analyse(forceRefresh) {
    if (isAnalyzing) return;
    const job = scrapeJobData();
    if (!job.title || !job.description) {
      toast("Job not fully loaded. Scroll the page first.", "warn"); return;
    }

    // Guard: require a minimum JD length that looks like real content.
    // Anything under 300 chars is almost certainly a scrape miss.
    if (job.description.length < 300) {
      toast("Job description looks too short to analyse. Scroll down to expand it, then retry.", "warn");
      isAnalyzing = false;
      return;
    }

    // Readability gate (safety net). Occasionally LinkedIn serves a JD with its
    // spaces stripped ("Doyouwantarole...partneringcloselywithmanagers..."), which
    // the model cannot read, so it would produce a confident WRONG score. Measure
    // the fraction of letters sitting in long no-space runs; clean JDs are ~0, a
    // jammed JD is high. Try a light repair first (fixes camelCase/punctuation
    // jams); if it is still heavily jammed, stop and tell the user instead of
    // analysing garbage. This does not touch the scraper above; it only validates
    // the captured text before we spend a credit.
    const _jamRatio = (t) => {
      if (!t) return 1;
      const runs = t.match(/[A-Za-z]{26,}/g) || [];
      const jammed = runs.reduce((n, r) => n + r.length, 0);
      const alpha = (t.match(/[A-Za-z]/g) || []).length || 1;
      return jammed / alpha;
    };
    if (_jamRatio(job.description) > 0.12) {
      const repaired = job.description
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([.,;:!?])([A-Za-z])/g, "$1 $2")
        .replace(/ {2,}/g, " ");
      if (_jamRatio(repaired) > 0.12) {
        toast("We couldn't read this job description cleanly. Click 'see more' to expand it, reload, then retry. No credit was used.", "warn");
        isAnalyzing = false;
        return;
      }
      job.description = repaired;  // repair worked; proceed with clean text
    }

    isAnalyzing = true;
    log.info('Analyse fit clicked for:', job.title);
    // Diagnostic: confirm the REAL current JD is captured, not stale/empty text.
    // First 160 chars should look like job content, NOT LinkedIn nav
    // ("0 notifications Skip to main content Home My Network…").
    // If "5+ years" generic requirements appear but this log shows the right JD,
    // the issue is backend-side (old deploy / model ignoring JD), not capture.
    log.info('JD captured:', job.description.length, 'chars | jobId:', currentJobId(),
      '| company:', job.company, '| first 160:', job.description.slice(0, 160).replace(/\s+/g, ' '));
    sidebarEl.querySelector("#cc-results").style.display = "none";
    sidebarEl.querySelector("#cc-paywall").style.display = "none";
    sidebarEl.querySelector(".cc-retry-bar")?.remove();
    sidebarEl.classList.remove("cc-has-fit", "cc-fit-strong", "cc-fit-medium", "cc-fit-weak");
    setAnalysisSteps();
    setLoading(true, "Analysing your fit…");
    setTimeout(() => setProgressStep(0, true) || setProgressStep(1, false, true), 200);
    setTimeout(() => setProgressStep(1, true) || setProgressStep(2, false, true), 800);

    function getResumeB64(cb) {
      chrome.storage.local.get(["resume_b64_chunks"], meta => {
        const n = parseInt(meta.resume_b64_chunks) || 0;
        if (n === 0) {
          // Page-context read found nothing. This can happen if a LinkedIn SPA job
          // change left this content script with a stale context. Ask the service
          // worker (stable context) before concluding there is no resume.
          safeSend({ type: "GET_RESUME_B64" }, res => {
            cb(res && res.b64 ? res.b64 : null);
          });
          return;
        }
        const keys = Array.from({ length: n }, (_, i) => "resume_b64_" + i);
        chrome.storage.local.get(keys, data => {
          const b64 = keys.map(k => data[k] || "").join("");
          log.ok('Resume read from storage:', b64.length, 'chars,', n, 'chunk(s)');
          if (b64.length > 100) { cb(b64); return; }
          // Assembled empty despite a chunk count: stale context. Fall back to SW.
          safeSend({ type: "GET_RESUME_B64" }, res => {
            cb(res && res.b64 ? res.b64 : null);
          });
        });
      });
    }

    getResumeB64(resumeB64 => {
      log.info('Resume ready:', resumeB64 ? Math.round(resumeB64.length / 1024) + 'KB' : 'NONE (JD only)');
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
            showRetryBar("Analysis timed out. Tap Retry"); return;
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
                  if (err && err.indexOf("RESUME_REJECTED") === 0) {
                    const rmsg = err.split("::")[1] || "We couldn't read that resume. Please re-upload.";
                    toast(rmsg, "warn");
                    const _z = sidebarEl?.querySelector("#cc-upload-zone");
                    _z?.classList.add("cc-zone-flash");
                    setTimeout(() => _z?.classList.remove("cc-zone-flash"), 900);
                    return;
                  }
                  if (err === "INSUFFICIENT_CREDITS") { sidebarEl.classList.remove("cc-has-fit","cc-fit-strong","cc-fit-medium","cc-fit-weak"); const pw = sidebarEl.querySelector("#cc-paywall"); if (pw) pw.style.display = "flex"; const sp = sidebarEl.querySelector(".cc-section-plain"); if (sp) sp.style.display = "none"; return; }
                  // Note: consent is captured ONCE at signup and used for every
                  // analysis. The backend does not ask for consent at analysis time,
                  // so there is no consent prompt here by design. Legacy accounts with
                  // no consent row are backfilled server-side without interrupting the
                  // user.
                  showRetryBar(err.slice(0, 80)); return;
                }
                if (data.analysis_status === "done") {
                  log.ok('Analysis complete, rendering results');
                  let result;
                  try { result = JSON.parse(data.analysis_result); }
                  catch (e) { showRetryBar("Something went wrong. Please retry"); return; }
                  setProgressStep(2, true); setProgressStep(3, true); setProgressStep(4, true);
                  setTimeout(() => clearProgressSteps(), 600);
                  renderResults(result, job);
                  refreshUsage();
                  if (result.unchanged) toast("✓ No changes since last run, showing your saved analysis");
                  else if (result.cached) toast("✓ Cached result (24h), no credit used");
                }
              }
            );
          } catch (e) { /* context invalidated - keep polling */ }
        }, 2000);
      }, 8000);
    });
  }

  function showRetryBar(msg) {
    sidebarEl?.querySelector(".cc-retry-bar")?.remove();
    const bar = document.createElement("div");
    bar.className = "cc-retry-bar";
    bar.style.cssText = "margin:8px 12px;padding:10px 14px;background:#fef7e0;border:1px solid #f9c97c;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:10px";
    bar.innerHTML = '<span style="font-size:12.5px;color:#7a4f00;flex:1;line-height:1.4">' + (msg || "Server took too long. This can happen on the first request") + '</span><button style="flex-shrink:0;background:#1a73e8;color:#fff;border:none;border-radius:16px;font-family:inherit;font-size:12px;font-weight:600;padding:6px 14px;cursor:pointer">Retry</button>';
    sidebarEl?.querySelector("#cc-analyse-btn")?.after(bar);
    bar.querySelector("button").addEventListener("click", () => { bar.remove(); analyse(true); });
  }

  // ── Score breakdown helper ─────────────────────────────────────────────────
  function buildScoreBreakdown(d, job, hasResume) {
    const bd = d.score_breakdown || {};
    const WEIGHTS = {
      skills_match:         { label: "Skills match",   weight: 35, evidenceKey: "skills_evidence" },
      experience_match:     { label: "Experience",      weight: 25, evidenceKey: "experience_evidence" },
      domain_match:         { label: "Domain fit",      weight: 20, evidenceKey: "domain_evidence" },
      qualifications_match: { label: "Qualifications",  weight: 10, evidenceKey: "qualifications_evidence" },
      soft_skills_match:    { label: "Soft skills",     weight: 10, evidenceKey: "soft_skills_evidence" },
    };
    const rows = Object.entries(WEIGHTS).map(([key, meta]) => ({
      label:   meta.label,
      weight:  meta.weight,
      pct:     typeof bd[key] === "number" ? bd[key] : 0,
      detail:  bd[meta.evidenceKey] || "",
    }));
    const breakdown = sidebarEl.querySelector("#cc-score-breakdown");
    const rowsEl    = sidebarEl.querySelector("#cc-breakdown-rows");
    if (!breakdown || !rowsEl) return;
    rowsEl.innerHTML = rows.map(r => {
      const color = r.pct >= 70 ? "#057642" : r.pct >= 45 ? "#d97706" : "#b91c1c";
      return `<div class="cc-breakdown-row" title="${(r.detail || "").replace(/"/g,"&quot;")}">
        <span class="cc-breakdown-label">${r.label}<span class="cc-breakdown-weight">${r.weight}%</span></span>
        <div class="cc-breakdown-bar-wrap">
          <div class="cc-breakdown-bar-fill" style="width:${r.pct}%;background:${color}"></div>
        </div>
        <span class="cc-breakdown-val" style="color:${color}">${r.pct}%</span>
      </div>`;
    }).join("");
    breakdown.style.display = "";
  }

  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/\s+[\u2014\u2013]\s+/g, ", ")
      .replace(/[\u2014\u2013]/g, "-")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function softenCaps(str) {
    if (!str || typeof str !== "string") return str ? esc(str) : "";
    const softened = str.replace(/\b(THIS|THESE|THAT|THOSE|YOUR|EVERY|ONLY|MUST|KEY|EXACTLY|NEVER|ALWAYS|REALLY|VERY|NOT|HERE|ROLE)\b/g,
      m => m.toLowerCase());
    return esc(softened);
  }

  function renderResults(d, job) {
    log.info('renderResults called, score:', d?.match_score, 'fit:', d?.fit_level);
    try {
      const ctxEl = sidebarEl.querySelector("#cc-result-context");
      const ctxTitle = sidebarEl.querySelector("#cc-result-job-title");
      const ctxCo = sidebarEl.querySelector("#cc-result-company");
      const cachedBadge = sidebarEl.querySelector("#cc-cached-badge");
      const reBtn = sidebarEl.querySelector("#cc-reanalyse-btn");

      if (ctxEl) ctxEl.style.display = "flex";
      if (ctxTitle) ctxTitle.textContent = job.title || "Unknown role";
      if (ctxCo) ctxCo.textContent = [job.company, job.location].filter(Boolean).join(" · ");

      if (cachedBadge) cachedBadge.style.display = d.cached ? "inline-flex" : "none";
      if (reBtn) reBtn.style.display = "inline-block";

      const scoreEl  = sidebarEl.querySelector("#cc-score-num");
      const labelEl  = sidebarEl.querySelector("#cc-score-label");
      const verdictEl= sidebarEl.querySelector("#cc-verdict");
      const headerEl = sidebarEl.querySelector("#cc-sc-header");
      const applyEl  = sidebarEl.querySelector("#cc-apply-badge");
      const roleEl   = sidebarEl.querySelector("#cc-sc-role-name");

      const fit = d.fit_level || (d.match_score >= 75 ? "strong" : d.match_score >= 45 ? "medium" : "weak");
      sidebarEl.classList.remove("cc-fit-strong", "cc-fit-medium", "cc-fit-weak");
      sidebarEl.classList.add("cc-fit-" + fit, "cc-has-fit");
      applyPullTabFit(fit);
      chrome.storage.local.set({ last_fit: fit });
      const _secPlain = sidebarEl.querySelector(".cc-section-plain");
      if (_secPlain) _secPlain.style.display = "none";

      if (roleEl) roleEl.textContent = (job?.title && job?.company)
        ? `${job.title} · ${job.company}` : (job?.title || "");

      const arcTotal = 478;
      const ringEl = sidebarEl.querySelector("#cc-score-ring");
      if (ringEl) {
        const offset = arcTotal - (d.match_score / 100) * arcTotal;
        ringEl.style.strokeDasharray = arcTotal;
        ringEl.style.strokeDashoffset = arcTotal;
        requestAnimationFrame(() => setTimeout(() => {
          ringEl.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)";
          ringEl.style.strokeDashoffset = offset;
        }, 80));
      }

      let _cur = 0; const _target = d.match_score;
      if (scoreEl) { scoreEl.textContent = "0"; }
      const _timer = setInterval(() => {
        _cur = Math.min(_target, _cur + Math.ceil(_target / 28));
        if (scoreEl) scoreEl.textContent = _cur;
        if (_cur >= _target) clearInterval(_timer);
      }, 32);

      const fitLabel = { strong:"Strong fit", medium:"Partial fit", weak:"Weak fit" }[d.fit_level] || "Analysed";
      if (labelEl) labelEl.textContent = fitLabel.toUpperCase();
      if (verdictEl) verdictEl.textContent = d.verdict || "";

      const av = d.apply_recommendation?.verdict || "Apply With Prep";
      const dotColor = av === "Apply Now" ? "#4ade80"
        : av === "Apply With Prep" ? "#fbbf24"
        : av === "Improve First"   ? "#fb923c"
        : "#f87171";
      if (applyEl) {
        const dot = applyEl.querySelector(".cc-sc-apply-dot");
        const txt = applyEl.querySelector(".cc-sc-apply-text");
        if (dot) dot.style.background = dotColor;
        if (txt) txt.textContent = av;
      }

      const bd = d.score_breakdown || {};
      const gapCount  = (d.missing_skills  || []).length;
      const fixCount  = (d.resume_suggestions || []).length;
      const planCount = (d.improvement_plan  || []).length;
      const intCount  = ((d.interview_guide?.role_specific || d.interview_guide?.technical || []).length)
                        + (d.interview_guide?.behavioural || []).length
                        + (d.interview_guide?.company_specific || []).length;
      const skillPct  = bd.skills_match || 0;
      const expPct    = bd.experience_match || 0;
      const _sv = (id, val) => { const el = sidebarEl.querySelector("#"+id); if (el) el.textContent = val; };
      _sv("cc-dash-match-val", skillPct + "%");
      _sv("cc-dash-exp-val",   expPct + "%");
      _sv("cc-dash-gaps-val",  gapCount === 0 ? "None" : gapCount);
      _sv("cc-dash-fixes-val", fixCount || "0");

      function setBadge(id, text, cls) {
        const el = sidebarEl.querySelector("#cc-badge-" + id);
        if (el) { el.textContent = text; el.className = "cc-acc-badge " + cls; }
      }
      function setTeaser(id, text) {
        const el = sidebarEl.querySelector("#cc-teaser-" + id);
        if (el) el.textContent = text;
      }
      const fitLevel = d.fit_level || "medium";
      setBadge("fit",
        fitLevel === "strong" ? "Strong" : fitLevel === "weak" ? "Weak" : "Partial",
        fitLevel === "strong" ? "cc-badge-green" : fitLevel === "weak" ? "cc-badge-red" : "cc-badge-amber"
      );
      const fitTeaser = [
        ...(d.fit_reasons || []).slice(0,2).map(r => r.replace(/^JD requires /i,"").split("-")[0].trim() + " ✓"),
        ...(d.gap_reasons  || []).slice(0,1).map(r => r.replace(/^JD requires /i,"").split("-")[0].trim() + " ✗"),
      ].join("  ·  ");
      setTeaser("fit", fitTeaser);
      setBadge("skills",
        gapCount === 0 ? "No gaps" : gapCount + " gap" + (gapCount > 1 ? "s" : ""),
        gapCount === 0 ? "cc-badge-green" : gapCount <= 2 ? "cc-badge-amber" : "cc-badge-red"
      );
      setTeaser("skills",
        gapCount > 0
          ? (d.missing_skills || []).slice(0,3).map(s => (typeof s === "string" ? s : s.skill)).join("  ·  ")
          : "Covers all required skills"
      );
      setBadge("plan",
        planCount + " action" + (planCount !== 1 ? "s" : ""),
        planCount > 0 ? "cc-badge-blue" : "cc-badge-green"
      );
      setTeaser("plan",
        (d.improvement_plan || []).slice(0,2).map(p =>
          (typeof p === "string" ? p : p.action || "").split(" ").slice(0,5).join(" ")
        ).join("  ·  ") || "No actions needed"
      );
      setBadge("resume",
        fixCount + " fix" + (fixCount !== 1 ? "es" : ""),
        fixCount > 0 ? "cc-badge-amber" : "cc-badge-green"
      );
      setTeaser("resume",
        fixCount > 0
          ? (d.resume_suggestions || []).slice(0,2).map(s =>
              (typeof s === "string" ? s : s.issue || "").split(" ").slice(0,4).join(" ")
            ).join("  ·  ")
          : "Resume is well-targeted"
      );
      setBadge("interview",
        intCount > 0 ? intCount + " Qs ready" : "Generating…",
        "cc-badge-purple"
      );
      setTeaser("interview",
        intCount > 0
          ? (d.interview_guide?.company_style || "").split(".")[0] || "See detailed prep guide"
          : "Interview guide available"
      );

      safeSend({ type: "GET_RESUME_STATUS" }, (s) => {
        buildScoreBreakdown(d, job, !!s?.hasResume);
      });

      const fitBody = sidebarEl.querySelector("#cc-fit-body");
      const lbl = (c,t) => `<div style="font-size:9.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;margin:0 0 10px;color:${c};">${t}</div>`;
      const CHK = '<polyline points="20 6 9 17 4 12"/>', MIN = '<line x1="5" y1="12" x2="19" y2="12"/>';
      const fitRow = (t,color,soft,icon,last) => `<div style="display:flex;gap:11px;align-items:flex-start;padding:10px 0;${last?'':'border-bottom:1px solid var(--hairline);'}"><span style="width:20px;height:20px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;margin-top:1px;background:${soft};"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3">${icon}</svg></span><span style="font-size:12.5px;line-height:1.5;color:var(--ink2);">${t}</span></div>`;
      let fitHTML = "";

      // Defensive: if the backend returned an older/empty shape with none of the
      // fields this view needs, show a clear message instead of a blank section.
      const _hasAnyFit = (d.resume_strengths?.length || d.fit_reasons?.length ||
        d.gap_reasons?.length || d.critical_keywords_missing?.length ||
        d.ats_assessment || d.headline_hook || d.verdict);
      if (fitBody && !_hasAnyFit) {
        fitBody.innerHTML = `<p class="cc-empty">${esc(d.verdict || "Analysis came back without fit details. If your backend was just updated, redeploy it and run again.")}</p>`;
        log.warn('Fit section: response had no fit fields', Object.keys(d || {}));
      } else if (fitBody) {

      // ── Fit analysis: grouped cards (why fit / why not / keywords / ATS) ──
      const ats = d.ats_assessment || {};
      const kw  = (d.critical_keywords_missing || []);
      const strengths = (d.resume_strengths || []);
      const fits      = (d.fit_reasons || []);
      const gaps      = (d.gap_reasons || []);
      const clean = s => esc(String(s).replace(/^JD requires /i, "").replace(/ - /g, ". ").replace(/-/g, ""));

      // "Why you fit" = strengths + fit reasons; "Why you might not" = gaps.
      const fitItems = [...strengths, ...fits];
      const liList = arr => arr.map(r => `<div class="cc-fa-li">${clean(r)}</div>`).join("");

      const strongItems = fitItems.slice(0,4);
      if (strongItems.length) {
        fitHTML += `<div style="margin-bottom:16px;">${lbl('var(--acc-green)','Strengths')}${strongItems.map((r,i,a)=>fitRow(clean(r),'var(--acc-green)','var(--sf-green)',CHK,i===a.length-1)).join('')}</div>`;
      }
      const checks = (d.requirement_checks || []).filter(c => c && (c.status === "not_met" || c.status === "partial"));
      let areaItems = [];
      if (checks.length) {
        areaItems = checks.slice(0,4).map(c => {
          const detail = c.reasoning || c.evidence || (c.found ? `Resume shows: ${c.found}` : "");
          return `<span style="font-weight:700;color:var(--ink);">${esc(c.requirement)}.</span> ${esc(detail)}`;
        });
      } else if (gaps.length) {
        areaItems = gaps.slice(0,3).map(clean);
      }
      if (areaItems.length) {
        fitHTML += `<div style="margin-bottom:16px;">${lbl('var(--acc-red)','Areas to address')}${areaItems.map((t,i,a)=>fitRow(t,'var(--acc-red)','var(--sf-rose)',MIN,i===a.length-1)).join('')}</div>`;
      }
      if (kw.length) {
        fitHTML += `<div style="margin-bottom:16px;">${lbl('var(--acc-green)','Add these exact words if true for you')}<div style="background:var(--sf-green);border:1px solid var(--sf-green-bd);border-radius:12px;padding:13px 14px;"><div style="font-size:11.5px;color:var(--ink2);line-height:1.5;margin-bottom:11px;">Screening tools match on the exact wording used in the job post.</div><div style="display:flex;flex-wrap:wrap;gap:7px;">${kw.map(k => `<span style="font-size:11.5px;font-weight:600;border-radius:8px;padding:6px 11px;background:var(--sf-chip);border:1px solid var(--sf-green-bd);color:var(--sf-chip-tx);">${esc(k)}</span>`).join("")}</div></div></div>`;
      }
      if (ats.ats_score != null) {
        fitHTML += `<div>${lbl('var(--acc-green)','Estimated ATS score')}<div style="background:var(--sf-green);border:1px solid var(--sf-green-bd);border-radius:12px;padding:13px 14px;"><div style="margin-bottom:7px;"><span style="font-size:26px;font-weight:800;color:var(--acc-green);letter-spacing:-.5px;line-height:1;">${parseInt(ats.ats_score)||0}<span style="font-size:13px;color:var(--ink3);font-weight:700;"> / 100</span></span></div><div style="font-size:11.5px;color:var(--ink2);line-height:1.6;">How screening software might rank you, by keyword and title matching. Different from your <strong style="color:var(--ink);">fit score above</strong>.</div></div></div>`;
      }

      fitBody.innerHTML = fitHTML || "<p class='cc-empty'>No fit data.</p>";
      }

      const skillsBody = sidebarEl.querySelector("#cc-skills-body");
      const reqs = (d.jd_requirements && d.jd_requirements.length) ? d.jd_requirements : [];
      const missingSet = new Set((d.missing_skills || []).map(s =>
        (typeof s === "string" ? s : s.skill || "").toLowerCase()
      ));
      let skHTML = "";
      if (reqs && reqs.length) {
        const have = [], miss = [];
        reqs.slice(0, 16).forEach(req => {
          const key = req.toLowerCase();
          const isGap = missingSet.has(key) || [...missingSet].some(m => key.includes(m) || m.includes(key));
          (isGap ? miss : have).push(req);
        });
        if (have.length) skHTML += `<div style="margin-bottom:16px;">${lbl('var(--acc-green)','Requirements you have')}${have.map((r,i,a)=>fitRow(esc(r),'var(--acc-green)','var(--sf-green)',CHK,i===a.length-1)).join('')}</div>`;
        if (miss.length) skHTML += `<div style="margin-bottom:16px;">${lbl('var(--acc-red)','Requirements missing')}${miss.map((r,i,a)=>fitRow(esc(r),'var(--acc-red)','var(--sf-rose)',MIN,i===a.length-1)).join('')}</div>`;
      }
      if (d.missing_skills?.length) {
        skHTML += `<div>${lbl('var(--acc-red)','How to close the gaps')}` + d.missing_skills.map((s,i,a) => {
          const sk = typeof s === "string" ? { skill: s, importance: "important", how_to_learn: "" } : s;
          const bc = sk.importance === "critical" ? 'var(--sf-rose)' : sk.importance === "important" ? 'var(--sf-amber)' : 'var(--sf-neutral)';
          const tc = sk.importance === "critical" ? 'var(--acc-red)' : sk.importance === "important" ? 'var(--acc-amber)' : 'var(--ink3)';
          return `<div style="background:var(--sf-rose);border:1px solid var(--sf-rose-bd);border-radius:12px;padding:13px 14px;${i<a.length-1?'margin-bottom:9px;':''}"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;"><span style="font-size:12.5px;font-weight:700;color:var(--ink);">${esc(sk.skill)}</span><span style="font-size:10px;font-weight:800;padding:4px 11px;border-radius:20px;background:${bc};color:${tc};">${esc(sk.importance)}</span></div>${sk.how_to_learn ? `<div style="font-size:12px;color:var(--ink2);line-height:1.55;">${softenCaps(sk.how_to_learn)}</div>` : ""}</div>`;
        }).join('') + `</div>`;
      } else if (reqs && reqs.length) {
        skHTML += `<div style="display:flex;align-items:center;gap:9px;padding:11px 13px;background:var(--sf-green);border:1px solid var(--sf-green-bd);border-radius:12px;font-size:12.5px;color:var(--acc-green);font-weight:700;"><span style="width:18px;height:18px;border-radius:50%;background:var(--acc-green);color:var(--base);font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">✓</span>Your resume covers all named requirements</div>`;
      }
      skillsBody.innerHTML = skHTML || "<p class='cc-empty'>No skills data.</p>";

      const planBody = sidebarEl.querySelector("#cc-plan-body");
      let planHTML = "";
      (d.improvement_plan || []).forEach((item, i, arr) => {
        const p = typeof item === "string" ? { action: item, impact: "medium", timeframe: "" } : item;
        const meta = [
          p.impact ? p.impact.charAt(0).toUpperCase() + p.impact.slice(1) + " impact" : "",
          p.timeframe || ""
        ].filter(Boolean).join("  ·  ");
        planHTML += `<div style="display:flex;align-items:flex-start;gap:11px;padding:11px 0;${i<arr.length-1?'border-bottom:1px solid var(--hairline);':''}"><div style="width:20px;height:20px;border-radius:50%;flex:none;background:var(--sf-blue);color:var(--acc-blue);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${i + 1}</div><div><div style="font-size:13px;font-weight:700;color:var(--ink);line-height:1.45;margin-bottom:3px;">${esc(p.action)}</div>${meta ? `<div style="font-size:11.5px;color:var(--ink3);">${esc(meta)}</div>` : ""}</div></div>`;
      });
      planBody.innerHTML = planHTML || "<p class='cc-empty'>No plan items.</p>";

      const resumeBody = sidebarEl.querySelector("#cc-resume-body");
      let resHTML = "";
      (d.resume_suggestions || []).forEach((s, i, arr) => {
        const sug = typeof s === "string" ? { issue: s } : s;
        // New XYZ shape: before/after. Old shape: issue/fix/example. Support both.
        const before = sug.before || "";
        const after  = sug.after  || sug.example || "";
        const note   = sug.issue || sug.gap_addressed || "";
        const metricWarn = sug.missing_metric
          ? `<div style="font-size:11.5px;color:var(--acc-amber);background:var(--sf-amber);border-radius:7px;padding:6px 9px;margin-top:6px;">${esc(sug.metric_prompt || "Add your real number here")}</div>` : "";
        resHTML += `<div style="display:flex;align-items:flex-start;gap:11px;padding:11px 0;${i<arr.length-1?'border-bottom:1px solid var(--hairline);':''}"><div style="width:20px;height:20px;border-radius:50%;flex:none;background:var(--sf-amber);color:var(--acc-amber);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;">${i + 1}</div><div style="min-width:0;">${note ? `<div style="font-size:13px;font-weight:700;color:var(--ink);line-height:1.4;margin-bottom:7px;">${softenCaps(note)}</div>` : ""}${before ? `<div style="display:flex;gap:9px;align-items:flex-start;margin-bottom:6px;"><span style="font-size:9px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--ink3);flex:none;width:36px;padding-top:2px;">Before</span><span style="font-size:12px;color:var(--ink3);line-height:1.5;text-decoration:line-through;">${esc(before)}</span></div>` : ""}${after ? `<div style="display:flex;gap:9px;align-items:flex-start;"><span style="font-size:9px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--acc-green);flex:none;width:36px;padding-top:2px;">After</span><span style="font-size:12px;color:var(--ink);line-height:1.5;font-weight:600;">${esc(after)}</span></div>` : ""}${sug.fix && !after ? `<div style="font-size:12px;color:var(--ink2);line-height:1.55;">${softenCaps(sug.fix)}</div>` : ""}${metricWarn}</div></div>`;
      });
      resumeBody.innerHTML = resHTML || "<p class='cc-empty'>Resume looks good for this role.</p>";

      const intBody = sidebarEl.querySelector("#cc-interview-body");
      let intHTML = "";
      const iq = d.interview_guide || {};
      if (iq.company_style) {
        const sourceTag = iq.research_source
          ? `<div class="cc-int-source-tag">Source: ${esc(iq.research_source)}</div>`
          : "";
        intHTML += `<div style="margin-bottom:16px;">
          <div style="font-size:9.5px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;margin:0 0 10px;color:var(--acc-violet);">Interview style</div>
          <div class="cc-int-style-banner" style="margin-bottom:0;">
            <div class="cc-int-style-text">${esc(iq.company_style)}</div>
            ${sourceTag}
          </div>
        </div>`;
      }
      const renderQ = (q, type) => {
        if (type === "technical") {
          return `
          <div class="cc-q-card">
            <div class="cc-q-text">${esc(q.question)}</div>
            ${q.why_asked ? `<div class="cc-q-meta">Tests: ${esc(q.why_asked)}</div>` : ""}
            ${q.how_to_answer ? `
            <div class="cc-q-guide">
              <span class="cc-q-guide-label">Step-by-step approach</span>
              ${esc(q.how_to_answer)}
            </div>` : ""}
            ${q.example_answer_start ? `
            <div class="cc-q-example">"${esc(q.example_answer_start)}"</div>` : ""}
          </div>`;
        } else if (type === "behavioural") {
          return `
          <div class="cc-q-card">
            <div class="cc-q-text">${esc(q.question)}</div>
            ${q.why_asked ? `<div class="cc-q-meta">Competency: ${esc(q.why_asked)}</div>` : ""}
            ${q.star_guide ? `
            <div class="cc-q-guide">
              <span class="cc-q-guide-label">STAR guide</span>
              ${esc(q.star_guide)}
            </div>` : ""}
          </div>`;
        } else {
          return `
          <div class="cc-q-card">
            <div class="cc-q-text">${esc(q.question)}</div>
            ${q.context ? `<div class="cc-q-meta">${esc(q.context)}</div>` : ""}
            ${q.how_to_answer ? `
            <div class="cc-q-guide">
              <span class="cc-q-guide-label">Key points</span>
              ${esc(q.how_to_answer)}
            </div>` : ""}
          </div>`;
        }
      };
      const roleQs = iq.role_specific?.length ? iq.role_specific : (iq.technical || []);
      if (roleQs.length) {
        intHTML += `<div class="cc-q-section-label">Role questions (${roleQs.length})</div>`;
        roleQs.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "role"); });
      }
      if (iq.behavioural?.length) {
        intHTML += `<div class="cc-q-section-label" style="margin-top:16px">Behavioural questions (${iq.behavioural.length})</div>`;
        iq.behavioural.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "behavioural"); });
      }
      if (iq.company_specific?.length) {
        intHTML += `<div class="cc-q-section-label" style="margin-top:16px">Company-specific questions (${iq.company_specific.length})</div>`;
        iq.company_specific.forEach(q => { intHTML += renderQ(typeof q === "string" ? { question: q } : q, "company"); });
      }
      const crs = iq.assessment_strategy || iq.coding_round_strategy;
      if (crs && (crs.overview || crs.step_by_step?.length)) {
        const roundLabel = crs.round_type ? esc(crs.round_type.charAt(0).toUpperCase() + crs.round_type.slice(1)) : "Assessment strategy";
        intHTML += `<div class="cc-q-section-label" style="margin-top:16px">${roundLabel}</div>`;
        intHTML += `<div class="cc-coding-strategy">`;
        if (crs.overview) intHTML += `<div class="cc-coding-overview">${esc(crs.overview)}</div>`;
        if (crs.step_by_step?.length) {
          intHTML += `<div class="cc-coding-steps-label">How to approach it</div>
          <ol class="cc-coding-steps">${crs.step_by_step.map(s => `<li>${esc(s)}</li>`).join("")}</ol>`;
        }
        if (crs.when_stuck) {
          intHTML += `<div class="cc-coding-stuck"><span class="cc-coding-stuck-label">When you're stuck:</span>${esc(crs.when_stuck)}</div>`;
        }
        if (crs.mistakes_to_avoid?.length) {
          intHTML += `<div class="cc-coding-mistakes-label">Avoid these mistakes:</div>
          <ul class="cc-coding-mistakes">${crs.mistakes_to_avoid.map(m => `<li>${esc(m)}</li>`).join("")}</ul>`;
        }
        intHTML += `</div>`;
      }
      if (iq.preparation_checklist?.length) {
        intHTML += `<div class="cc-q-section-label" style="margin-top:16px"> Preparation checklist</div>`;
        intHTML += `<div class="cc-prep-list">`;
        iq.preparation_checklist.forEach((item, i) => {
          const p = typeof item === "string" ? { topic: item, why: "", resource: "", time_needed: "" } : item;
          intHTML += `
          <div class="cc-prep-item">
            <div class="cc-prep-item-header">
              <span class="cc-prep-num">${i + 1}</span>
              <span class="cc-prep-topic">${esc(p.topic)}</span>
              ${p.time_needed ? `<span class="cc-prep-time"> ${esc(p.time_needed)}</span>` : ""}
            </div>
            ${p.why ? `<div class="cc-prep-why">${esc(p.why)}</div>` : ""}
            ${p.resource ? `<div class="cc-prep-resource">📚 ${esc(p.resource)}</div>` : ""}
          </div>`;
        });
        intHTML += `</div>`;
      }
      intBody.innerHTML = intHTML || "<p class='cc-empty'>No interview questions.</p>";

      const ns = sidebarEl.querySelector("#cc-next-step");
      if (d.apply_recommendation?.next_step) {
        const deriv = d.apply_recommendation.derivation
          ? `<div class="cc-next-deriv">${esc(d.apply_recommendation.derivation)}</div>` : "";
        ns.innerHTML = `<div class="cc-next-label">Next step</div><div class="cc-next-text">${esc(d.apply_recommendation.next_step)}</div>${d.apply_recommendation.reasoning ? `<div class="cc-next-reason">${esc(d.apply_recommendation.reasoning)}</div>` : ""}${deriv}`;
        ns.style.display = "block";
      } else {
        ns.style.display = "none";
      }

      const dlBtn = sidebarEl.querySelector("#cc-download-report");
      if (dlBtn) {
        dlBtn.style.display = "flex";
        dlBtn.onclick = () => downloadReportCard(d, job);
      }

      const resultsEl = sidebarEl.querySelector("#cc-results");
      // Resume-read confirmation strip (name is display-only)
      resultsEl.querySelector(".cc-resume-meta-strip")?.remove();
      const rm = d.resume_meta || {};
      if (rm.word_count) {
        const bits = [];
        if (rm.name) bits.push("<strong>" + esc(rm.name) + "</strong>");
        const role = [rm.current_title, rm.current_company].filter(Boolean).join(" @ ");
        if (role) bits.push(esc(role));
        bits.push(esc(String(rm.pages_parsed)) + " page" + (rm.pages_parsed === 1 ? "" : "s"));
        bits.push(esc(String(rm.word_count)) + " words");
        const _strip = document.createElement("div");
        _strip.className = "cc-resume-meta-strip";
        _strip.innerHTML = '<span class="cc-rms-tick">' + "\u2713" + '</span>' +
          '<span class="cc-rms-text">Resume read: ' + bits.join(" \u00b7 ") + '</span>';
        const _sb = resultsEl.querySelector("#cc-score-block");
        if (_sb) _sb.after(_strip);
      }

      resultsEl.style.display = "block";
      sidebarEl.querySelectorAll(".cc-acc").forEach(dd => { dd.open = dd.id === "cc-acc-fit"; });
      const _ns = sidebarEl.querySelector("#cc-next-step"); if (_ns) _ns.style.display = "";
      const _al = sidebarEl.querySelector("#cc-acc-list"); if (_al) _al.scrollTop = 0;
      sidebarEl.querySelector("#cc-main").scrollTop = 0;
      log.ok('renderResults complete');
    } catch (renderErr) {
      log.error('renderResults crashed:', renderErr.message, renderErr.stack?.split('\n')[1]);
    }
  }

  function setLoading(show, msg) {
    const el      = sidebarEl.querySelector("#cc-loading");
    const btn     = sidebarEl.querySelector("#cc-analyse-btn");
    const strip   = sidebarEl.querySelector("#cc-controls-strip, .cc-section-plain");
    const steps   = sidebarEl.querySelector("#cc-steps");
    const main    = sidebarEl.querySelector("#cc-main");
    el.style.display = show ? "flex" : "none";
    if (strip) strip.style.display  = show ? "none" : "";
    if (steps) steps.style.display  = "none";
    if (main)  main.style.overflow  = show ? "hidden" : "";
    if (msg) { const m = sidebarEl.querySelector("#cc-loading-msg"); if (m) m.textContent = msg; }
    if (!show) { btn.disabled = false; btn.textContent = "Analyse fit"; }
    if (show)  { try { startFacts(); } catch(e) {} }
    else       { try { stopFacts();  } catch(e) {} }
  }

  function toast(msg, type) {
    document.querySelectorAll(".cc-toast").forEach(t => t.remove());
    const t = document.createElement("div");
    t.className = "cc-toast" + (type === "warn" ? " cc-toast-warn" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

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
    if (msg.type === "OPEN_BUY_CREDITS") { showBuyCreditsModal(); }
    if (msg.type === "SESSION_CHANGED") {
      // Popup logged in and updated the worker's storage. Re-run session
      // restore so the sidebar drops the auth wall without a page reload.
      if (_restoreSession) _restoreSession();
    }
    if (msg.type === "CREDITS_UPDATED") {
      updateCreditPill(msg.credits);
      toast(`✓ ${msg.added} credits added! Balance: ${msg.credits}`);
      refreshUsage();
    }
  });

  function checkNav() {
    const id = currentJobId();
    if (id !== lastJobId) {
      lastJobId = id;
      // New job in view → its fit is unknown until re-analysed. Reset the pull
      // tab to its default colour so it never keeps the previous job's fit, and
      // drop the stored fit so a reload on this job doesn't restore a stale one.
      applyPullTabFit(null);
      chrome.storage.local.remove("last_fit");
      if (sidebarEl) {
        sidebarEl.querySelector("#cc-results").style.display = "none";
        sidebarEl.querySelector("#cc-paywall").style.display = "none";
        sidebarEl.querySelector("#cc-analyse-btn").disabled = false;
        sidebarEl.querySelector("#cc-analyse-btn").textContent = "Analyse fit";
        // LinkedIn SPA: the URL changes before the job content DOM is rendered.
        // Wait for the job details container to actually appear before scraping,
        // otherwise detectJob runs too early and finds nothing.
        _waitForJobContent(() => detectJob());
      }
    }
  }

  // Wait up to 4s for the JD container to have real content, then call cb.
  // Polls every 200ms. Falls back immediately if nothing appears in time so we
  // still call detectJob (which will show "try scrolling" rather than hanging).
  function _waitForJobContent(cb) {
    const JD_SELECTORS = ["#job-details", ".jobs-description__content",
      ".jobs-description-content", ".jobs-box__html-content", "[class*='jobs-description']"];
    let attempts = 0;
    const check = () => {
      for (const sel of JD_SELECTORS) {
        try {
          const el = document.querySelector(sel);
          if (el?.innerText?.trim().length > 100) { cb(); return; }
        } catch { }
      }
      if (++attempts < 20) setTimeout(check, 200);
      else cb(); // give up waiting - detectJob will handle the empty state
    };
    check();
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

  const FACTS = [
    "Applyin reads the full job description, not just the title, so the gaps are real ones.",
    "Your resume is compared line-by-line against every requirement in the role.",
    "85% of job seekers apply to roles they are underqualified for. You won't.",
    "The interview guide is tailored to this specific company's known style.",
    "Applyin never stores your resume on a server. It stays in your browser.",
    "Credits are only spent on new analyses. Cached results are always free.",
    "Your score is calculated from 5 weighted dimensions, not one gut feeling.",
    "The improvement plan only lists actions that close real JD gaps.",
  ];
  let _factIdx = 0, _factTimer = null, _factPct = 0;

  const LOADING_STEPS = [
    { stage:"Reading job description",  detail:"Extracting every requirement, skill and qualification from the JD",       pct:15, step:"Step 1 of 5" },
    { stage:"Validating your resume",   detail:"Reading your resume and confirming name, role and content",               pct:32, step:"Step 2 of 5" },
    { stage:"Matching skills to role",  detail:"Cross-referencing your profile against each requirement in the JD",       pct:54, step:"Step 3 of 5" },
    { stage:"Scoring your fit",         detail:"Weighing skills, experience, domain fit, qualifications and soft skills", pct:72, step:"Step 4 of 5" },
    { stage:"Building your report",     detail:"Compiling gaps, improvement plan, resume fixes and interview guide",       pct:90, step:"Step 5 of 5" },
  ];

  function startFacts() {
    let _stepIdx = 0; _factIdx = 0;
    const fEl   = sidebarEl.querySelector("#cc-loading-fact");
    const bar   = sidebarEl.querySelector("#cc-loading-arc");
    const pEl   = sidebarEl.querySelector("#cc-loading-pct");
    const msgEl = sidebarEl.querySelector("#cc-loading-msg");
    const detEl = sidebarEl.querySelector("#cc-ld-detail");
    const slEl  = sidebarEl.querySelector("#cc-ld-step-lbl");
    const roleEl= sidebarEl.querySelector("#cc-ld-role");
    const logoEl= sidebarEl.querySelector("#cc-loading-logo-img");
    if (!fEl) return;
    try { if (logoEl) logoEl.src = chrome.runtime.getURL("icons/icon128.png"); } catch(e) {}
    try {
      const chip = sidebarEl.querySelector("#cc-job-chip");
      if (roleEl && chip) roleEl.textContent = chip.textContent.trim() || "Analysing your fit";
    } catch(e) {}
    const s0 = LOADING_STEPS[0];
    if (msgEl) msgEl.textContent = s0.stage;
    if (detEl) detEl.textContent = s0.detail;
    if (slEl)  slEl.textContent  = s0.step;
    if (pEl)   pEl.textContent   = s0.pct + "%";
    if (bar)   { bar.style.transition = "none"; bar.style.width = s0.pct + "%"; }
    fEl.textContent = FACTS[0]; fEl.style.opacity = "1";
    if (_factTimer) clearInterval(_factTimer);
    _factTimer = setInterval(() => {
      _stepIdx = Math.min(_stepIdx + 1, LOADING_STEPS.length - 1);
      const s = LOADING_STEPS[_stepIdx];
      [msgEl, detEl].forEach(el => {
        if (!el) return;
        el.style.transition = "opacity .22s,transform .22s";
        el.style.opacity = "0"; el.style.transform = "translateY(5px)";
      });
      setTimeout(() => {
        if (msgEl) msgEl.textContent = s.stage;
        if (detEl) detEl.textContent = s.detail;
        if (slEl)  slEl.textContent  = s.step;
        if (pEl)   pEl.textContent   = s.pct + "%";
        if (bar)   { bar.style.transition = "width .9s cubic-bezier(.4,0,.2,1)"; bar.style.width = s.pct + "%"; }
        [msgEl, detEl].forEach(el => { if (el) { el.style.opacity = "1"; el.style.transform = "none"; } });
      }, 250);
      _factIdx = (_factIdx + 1) % FACTS.length;
      fEl.style.transition = "opacity .3s"; fEl.style.opacity = "0";
      setTimeout(() => { fEl.textContent = FACTS[_factIdx]; fEl.style.opacity = "1"; }, 300);
    }, 3500);
  }

  function stopFacts() {
    if (_factTimer) { clearInterval(_factTimer); _factTimer = null; }
    const pEl   = sidebarEl.querySelector("#cc-loading-pct");
    const bar   = sidebarEl.querySelector("#cc-loading-arc");
    const msgEl = sidebarEl.querySelector("#cc-loading-msg");
    const detEl = sidebarEl.querySelector("#cc-ld-detail");
    if (pEl)   pEl.textContent   = "100%";
    if (bar)   { bar.style.transition = "width .5s ease"; bar.style.width = "100%"; }
    if (msgEl) msgEl.textContent = "Analysis complete";
    if (detEl) detEl.textContent = "Opening your results…";
  }

  function wire() {
    sidebarEl.querySelector("#cc-collapse-btn").addEventListener("click", collapseSidebar);
    try {
      const li = sidebarEl.querySelector("#cc-loading-logo-img");
      if (li) li.src = chrome.runtime.getURL("icons/icon32.png");
    } catch(e) {}
    sidebarEl.querySelectorAll(".cc-acc").forEach(det => {
      det.addEventListener("toggle", () => {
        if (det.open) {
          sidebarEl.querySelectorAll(".cc-acc").forEach(other => {
            if (other !== det) other.open = false;
          });
        }
      });
    });
    sidebarEl.querySelector("#cc-settings-btn").addEventListener("click", () => showSettings(true));
    sidebarEl.querySelector("#cc-settings-back").addEventListener("click", () => showSettings(false));
    sidebarEl.querySelectorAll(".cc-auth-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        sidebarEl.querySelectorAll(".cc-auth-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        const isLogin = tab.dataset.tab === "login";
        const submit = sidebarEl.querySelector("#cc-auth-submit");
        submit.textContent = isLogin ? "Sign in" : "Create account";
        sidebarEl.querySelector("#cc-auth-error").textContent = "";
        sidebarEl.querySelector("#cc-auth-password").autocomplete = isLogin ? "current-password" : "new-password";
        // Consent checkbox is shown only when creating an account. The submit
        // button is disabled until consent is given. Sign in never needs it.
        const consentRow = sidebarEl.querySelector("#cc-consent-row");
        const consentBox = sidebarEl.querySelector("#cc-consent-box");
        consentRow.style.display = isLogin ? "none" : "flex";
        applyConsentGate(isLogin, submit, consentBox);
      });
    });
    // Toggle button enabled/disabled as the consent box changes (signup only).
    const _consentBox = sidebarEl.querySelector("#cc-consent-box");
    if (_consentBox) {
      _consentBox.addEventListener("change", () => {
        const isLogin = sidebarEl.querySelector('.cc-auth-tab.active')?.dataset?.tab === "login";
        applyConsentGate(isLogin, sidebarEl.querySelector("#cc-auth-submit"), _consentBox);
      });
    }
    sidebarEl.querySelector("#cc-auth-submit").addEventListener("click", handleAuth);
    sidebarEl.querySelector("#cc-auth-email").addEventListener("keydown", e => { if (e.key === "Enter") sidebarEl.querySelector("#cc-auth-password").focus(); });
    sidebarEl.querySelector("#cc-auth-password").addEventListener("keydown", e => { if (e.key === "Enter") handleAuth(); });

    const zone = sidebarEl.querySelector("#cc-upload-zone");
    const input = sidebarEl.querySelector("#cc-file-input");
    input.addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFile(file);
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

    sidebarEl.querySelector("#cc-analyse-btn").addEventListener("click", () => {
      // Ask the service worker (stable context) whether a resume exists, rather than
      // reading page-context storage directly, which can return empty after a LinkedIn
      // SPA job change invalidates this content script and wrongly shows "no resume".
      safeSend({ type: "GET_RESUME_STATUS" }, (s) => {
        if (!s?.hasResume) {
          toast("Please upload your resume first. We only analyse with a resume.", "warn");
          const zone = sidebarEl?.querySelector("#cc-upload-zone");
          zone?.classList.add("cc-zone-flash");
          setTimeout(() => zone?.classList.remove("cc-zone-flash"), 900);
          return;
        }
        analyse(false);
      });
    });
    sidebarEl.querySelector("#cc-reanalyse-btn")?.addEventListener("click", () => {
      const rb = sidebarEl.querySelector("#cc-reanalyse-btn");
      if (rb) rb.style.display = "none";
      analyse(true);
    });

    sidebarEl.querySelector("#cc-buy-more-btn")?.addEventListener("click", showBuyCreditsModal);
    sidebarEl.querySelector("#cc-upgrade-cta")?.addEventListener("click", showBuyCreditsModal);

    // Account: copy email
    sidebarEl.querySelector("#cc-copy-email")?.addEventListener("click", () => {
      const span = sidebarEl.querySelector("#cc-s-email");
      const btn = sidebarEl.querySelector("#cc-copy-email");
      const email = span?.textContent?.trim();
      if (!email || email === "·") return;
      navigator.clipboard?.writeText(email).then(() => {
        const prev = span.textContent;
        btn.classList.add("cc-copied");
        span.textContent = "Copied";
        setTimeout(() => { span.textContent = prev; btn.classList.remove("cc-copied"); }, 1300);
      }).catch(() => toast("Couldn't copy"));
    });

    // Account: upload / replace resume both trigger the hidden file input
    const fileInput = sidebarEl.querySelector("#cc-file-input");
    sidebarEl.querySelector("#cc-replace-resume")?.addEventListener("click", () => fileInput?.click());
    sidebarEl.querySelector("#cc-upload-resume")?.addEventListener("click", () => fileInput?.click());

    // Account: remove resume → inline confirm
    const reActions = sidebarEl.querySelector("#cc-resume-actions");
    const reConfirm = sidebarEl.querySelector("#cc-remove-confirm");
    sidebarEl.querySelector("#cc-clear-resume")?.addEventListener("click", () => {
      if (reActions) reActions.style.display = "none";
      reConfirm?.classList.add("cc-show");
    });
    sidebarEl.querySelector("#cc-remove-no")?.addEventListener("click", () => {
      reConfirm?.classList.remove("cc-show");
      if (reActions) reActions.style.display = "flex";
    });
    sidebarEl.querySelector("#cc-remove-yes")?.addEventListener("click", () => {
      reConfirm?.classList.remove("cc-show");
      clearResume();
    });

    // Account: sign out → inline confirm
    const soBtn = sidebarEl.querySelector("#cc-logout-btn");
    const soConfirm = sidebarEl.querySelector("#cc-signout-confirm");
    soBtn?.addEventListener("click", () => {
      soBtn.style.display = "none";
      soConfirm?.classList.add("cc-show");
    });
    sidebarEl.querySelector("#cc-signout-cancel")?.addEventListener("click", () => {
      soConfirm?.classList.remove("cc-show");
      if (soBtn) soBtn.style.display = "flex";
    });
    sidebarEl.querySelector("#cc-signout-yes")?.addEventListener("click", handleLogout);
  }

  function showSettings(show) {
    if (show) log.info('Settings panel opened');
    const hdr = sidebarEl.querySelector(".cc-header"); if (hdr) hdr.style.display = show ? "none" : "flex";
    sidebarEl.querySelector("#cc-main").style.display = show ? "none" : "block";
    sidebarEl.querySelector("#cc-settings").style.display = show ? "block" : "none";
    if (show) { refreshSettingsResume(); refreshSettingsCredits(); }
  }

  function refreshSettingsCredits() {
    const el = sidebarEl?.querySelector("#cc-s-usage");
    const emailEl = sidebarEl?.querySelector("#cc-s-email");
    const avEl = sidebarEl?.querySelector("#cc-acct-avatar");
    const nmEl = sidebarEl?.querySelector("#cc-acct-name");
    const verEl = sidebarEl?.querySelector("#cc-app-ver");
    const lowCard = sidebarEl?.querySelector("#cc-credits-card");
    try { if (verEl) verEl.textContent = (CFG.getVersion ? CFG.getVersion() : "v" + chrome.runtime.getManifest().version); } catch (e) {}
    chrome.storage.local.get("user", ({ user }) => {
      const email = user?.email || "";
      if (emailEl) emailEl.textContent = email || "·";
      if (avEl && email) avEl.textContent = email.charAt(0).toUpperCase();
      if (nmEl) nmEl.textContent = email ? email.split("@")[0] : "Your account";
      if (el) el.textContent = "…";
      if (lowCard) lowCard.classList.remove("cc-low");
      safeSend({ type: "GET_CREDITS" }, res => {
        if (chrome.runtime.lastError || !res) { if (el) el.textContent = "·"; return; }
        const c = res?.credits;
        if (el) el.textContent = c != null ? String(c) : "·";
        if (lowCard && typeof c === "number") lowCard.classList.toggle("cc-low", c <= 10);
      });
    });
  }

  function applyConsentGate(isLogin, submitBtn, consentBox) {
    if (!submitBtn) return;
    // On Sign in: always enabled. On Create account: enabled only when consent checked.
    const ok = isLogin || (consentBox && consentBox.checked);
    submitBtn.disabled = !ok;
    submitBtn.style.opacity = ok ? "" : "0.5";
    submitBtn.style.cursor = ok ? "" : "not-allowed";
  }

  function handleAuth() {
    const email = sidebarEl.querySelector("#cc-auth-email").value.trim();
    const password = sidebarEl.querySelector("#cc-auth-password").value;
    const isLogin = sidebarEl.querySelector('.cc-auth-tab.active')?.dataset?.tab === "login";
    const errEl = sidebarEl.querySelector("#cc-auth-error");
    const btn = sidebarEl.querySelector("#cc-auth-submit");
    errEl.classList.remove("cc-auth-info");   // reset to error (red); pending re-adds it
    if (!email || !password) { errEl.textContent = "Please fill in both fields"; return; }
    if (password.length < 8) { errEl.textContent = "Password must be at least 8 characters"; return; }
    const consentBox = sidebarEl.querySelector("#cc-consent-box");
    if (!isLogin && (!consentBox || !consentBox.checked)) {
      errEl.textContent = "Please agree to resume processing to continue.";
      return;
    }
    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = isLogin ? "Signing in…" : "Creating account…";
    safeSend(
      { type: isLogin ? "LOGIN" : "SIGNUP", email, password, consent: !isLogin },
      res => {
        btn.disabled = false;
        btn.textContent = isLogin ? "Sign in" : "Create account";
        // Confirm-email pending: account created, user must verify. Show a friendly
        // (non-red) message, not an error.
        if (res?.pending) {
          errEl.classList.add("cc-auth-info");
          errEl.textContent = res.message || "Check your inbox to confirm your email, then sign in to start.";
          return;
        }
        errEl.classList.remove("cc-auth-info");
        if (!res?.ok) {
          if (res?.error?.includes("backend") || res?.error?.includes("Cannot reach")) {
            errEl.textContent = "Backend not deployed yet. Follow the deployment guide first.";
          } else {
            errEl.textContent = res?.error || "Something went wrong. Try again.";
          }
          return;
        }
        // Consent for resume processing is recorded by the backend at signup (via the
        // consent flag we send), so no separate RECORD_CONSENT call is needed here.
        log.ok('Logged in as', res.email, '· Credits:', res.credits);
        sidebarEl.querySelector("#cc-auth-wall").style.display = "none";
        sidebarEl.querySelector("#cc-upload-row").style.display = "flex";
        sidebarEl.querySelector("#cc-job-chip").style.display = "block";
        sidebarEl.querySelector("#cc-analyse-btn").style.display = "block";
        updateCreditPill(res.credits);
        if (!isLogin) toast(`Welcome! You have ${res.credits} free credits to start`);
        else toast("Signed in");
        detectJob();
        refreshUsage();
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
    chrome.storage.local.get(["auth_token", "user"], (s) => {
      if (chrome.runtime.lastError) { _showAuthWallUI(); return; }
      if (s.auth_token && s.user) { onLoggedIn(s.user); return; }
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
    if (wall) wall.style.display = "block";
    if (row) row.style.display = "none";
    if (chip) chip.style.display = "none";
    if (btn) btn.style.display = "none";
    if (steps) steps.style.display = "none";
    if (results) results.style.display = "none";
    const secPlain = sidebarEl?.querySelector(".cc-section-plain"); if (secPlain) secPlain.style.display = "none";
    sidebarEl?.classList.remove("cc-has-fit", "cc-fit-strong", "cc-fit-medium", "cc-fit-weak");
  }

  function updateCreditPill(credits) {
    if (credits != null) log.info('Credits updated:', credits);
    const pill = sidebarEl?.querySelector("#cc-usage-pill");
    if (pill) pill.textContent = credits != null ? `${credits} credit${credits !== 1 ? "s" : ""}` : "·";
  }

  function refreshSettingsResume() {
    safeSend({ type: 'GET_RESUME_STATUS' }, (s) => {
      const el = sidebarEl?.querySelector('#cc-s-resume-status');
      const nameEl = sidebarEl?.querySelector('#cc-resume-name');
      const removeBtn = sidebarEl?.querySelector('#cc-clear-resume');
      const replaceBtn = sidebarEl?.querySelector('#cc-replace-resume');
      const uploadBtn = sidebarEl?.querySelector('#cc-upload-resume');
      const confirmEl = sidebarEl?.querySelector('#cc-remove-confirm');
      const actionsEl = sidebarEl?.querySelector('#cc-resume-actions');
      if (confirmEl) confirmEl.classList.remove('cc-show');
      if (actionsEl) actionsEl.style.display = 'flex';
      if (s?.hasResume) {
        if (nameEl) nameEl.textContent = s.isPDF ? (s.name || 'Resume.pdf') : 'Text resume';
        if (el) el.textContent = s.isPDF ? 'PDF resume' : ('~' + (s.wordCount || 0) + ' words');
        if (removeBtn) removeBtn.style.display = 'inline-flex';
        if (replaceBtn) replaceBtn.style.display = 'inline-flex';
        if (uploadBtn) uploadBtn.style.display = 'none';
      } else {
        if (nameEl) nameEl.textContent = 'No resume yet';
        if (el) el.textContent = 'Upload a PDF to start analysing';
        if (removeBtn) removeBtn.style.display = 'none';
        if (replaceBtn) replaceBtn.style.display = 'none';
        if (uploadBtn) uploadBtn.style.display = 'inline-flex';
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
      if (chrome.runtime.lastError) return;
      if (res?.credits != null) updateCreditPill(res.credits);
    });
  }

  function detectJob() {
    const job = scrapeJobData();
    const chip = sidebarEl?.querySelector("#cc-job-chip");
    if (!chip) return;
    if (job.title) {
      log.info('Job detected:', job.title, '@ company:', job.company || '(not found) | title:', document.title.slice(0, 60));
      chip.textContent = job.title + (job.company ? ` · ${job.company}` : "");
      chip.classList.remove("cc-chip-warn");
    } else {
      chip.textContent = "⚠ Job not detected. Try scrolling";
      chip.classList.add("cc-chip-warn");
    }
    const res = sidebarEl?.querySelector("#cc-results");
    if (res && res.style.display === "none") {
      const sec = sidebarEl?.querySelector(".cc-section-plain");
      if (sec) sec.style.display = "flex";
      sidebarEl.classList.remove("cc-has-fit", "cc-fit-strong", "cc-fit-medium", "cc-fit-weak");
    }
  }

  // ── File upload ────────────────────────────────────────────────────────────
  async function handleFile(file) {
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
      const buf = await file.arrayBuffer();
      setProgressStep(0, true);
      setProgressStep(1, false, true);
      const bytes = new Uint8Array(buf);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode(...slice);
        if (i % (CHUNK * 10) === 0) await new Promise(r => setTimeout(r, 0));
      }
      const b64 = btoa(binary);
      log.ok('Resume encoded:', b64.length, 'chars (~' + Math.round(b64.length / 1024) + 'KB)');
      setProgressStep(1, true);
      setProgressStep(2, false, true);
      const STORAGE_CHUNK = 1024 * 1024 * 1.5;
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
      await chrome.storage.local.remove(['resume_b64', 'resume']);
      setProgressStep(2, true);
      setProgressStep(3, false, true);
      const fname = file.name.length > 20 ? file.name.slice(0, 18) + '…' : file.name;
      setUploadLabel(true, fname + ' · PDF ready');
      setProgressStep(3, true);
      setTimeout(() => clearProgressSteps(), 1500);
      refreshSettingsResume();

      // Fresh resume - wipe any prior extracted strip + results so nothing stale shows.
      sidebarEl?.querySelector(".cc-resume-meta-strip")?.remove();
      const _staleResults = sidebarEl?.querySelector("#cc-results");
      if (_staleResults) _staleResults.style.display = "none";

      toast('Resume ready. Tap Analyse fit');
      const analyseBtn = sidebarEl?.querySelector('#cc-analyse-btn');
      if (analyseBtn) {
        analyseBtn.style.display = 'block';
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

  function setProgressSteps(steps) {
    const el = sidebarEl?.querySelector('#cc-steps');
    if (!el) return;
    el.innerHTML = steps.map((s, i) => `
      <div class="cc-step" id="cc-step-${i}" data-state="${s.active ? 'active' : 'pending'}">
        <span class="cc-step-dot"></span>
        <span class="cc-step-label">${s.label}</span>
      </div>`).join('');
    el.style.display = 'flex';
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
      { label: 'Validating your resume', done: false, active: false },
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

  function showBuyCreditsModal() {
    document.getElementById("cc-buy-modal")?.remove();
    const modal = document.createElement("div");
    modal.id = "cc-buy-modal";
    Object.assign(modal.style, {
      position: "fixed", inset: "0", zIndex: "9999999",
      fontFamily: "'Google Sans Text','Google Sans',system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center"
    });
    const backdrop = document.createElement("div");
    Object.assign(backdrop.style, { position: "absolute", inset: "0", background: "rgba(32,33,36,.55)" });
    backdrop.addEventListener("click", () => modal.remove());
    modal.appendChild(backdrop);
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "relative", zIndex: "1", background: "#fff", borderRadius: "16px",
      boxShadow: "0 8px 40px rgba(0,0,0,.22)", width: "min(460px,90vw)", maxHeight: "85vh",
      overflow: "hidden", display: "flex", flexDirection: "column", fontFamily: "inherit", animation: "cc-fadein .2s ease"
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
      modal?.remove();
      toast("Payment page opened in new tab ✓");
      setTimeout(() => refreshUsage(), 30000);
      setTimeout(() => refreshUsage(), 60000);
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    inject();
    // Do NOT pre-seed lastJobId with the current job. Doing so makes checkNav treat
    // the job already on the page as "unchanged", so the first job you land on is
    // never detected until you navigate to another. Leave it null; detection below
    // (and onLoggedIn's _waitForJobContent) will pick up the initial job.
    lastJobId = null;
    safeSend({ type: "CLEAR_JOB_CACHE" }, () => { chrome.runtime.lastError; });
    chrome.storage.local.get("sidebar_active", ({ sidebar_active }) => {
      if (sidebar_active === false) collapseSidebar();
    });
    function applyTheme(dark) {
      const root = sidebarEl;
      if (dark) root.setAttribute("data-theme", "dark");
      else root.removeAttribute("data-theme");
      const icon32 = chrome.runtime.getURL('icons/icon32.png');
      const icon128 = chrome.runtime.getURL('icons/icon128.png');
      const brandImg = sidebarEl.querySelector('#cc-brand-img');
      const authImg = sidebarEl.querySelector('#cc-auth-logo-img');
      if (brandImg) brandImg.src = icon32;
      if (authImg) authImg.src = icon128;
      const input = sidebarEl.querySelector("#cc-theme-input");
      if (input) input.checked = dark;
    }
    chrome.storage.local.get(["Applyin_dark_mode"], s => { applyTheme(!!s.Applyin_dark_mode); });
    sidebarEl.querySelector("#cc-theme-input")?.addEventListener("change", e => {
      const dark = e.target.checked;
      chrome.storage.local.set({ Applyin_dark_mode: dark });
      applyTheme(dark);
      log.info("Theme:", dark ? "dark" : "light");
    });
    function tryGetSession(attempts) {
      safeSend({ type: "GET_SESSION" }, res => {
        if (!res) {
          if (attempts > 0) setTimeout(() => tryGetSession(attempts - 1), 800);
          else showAuthWall();
          return;
        }
        if (!res.loggedIn) { log.info('Not logged in, showing auth wall'); showAuthWall(); return; }
        log.ok('Session restored:', res.user?.email, '· Credits:', res.user?.credits);
        onLoggedIn(res.user);
      });
    }
    // Expose so a popup login (which only updates the worker's storage) can
    // refresh the sidebar without a page reload.
    _restoreSession = () => tryGetSession(3);
    tryGetSession(3);
    function onLoggedIn(user) {
      const wall = sidebarEl?.querySelector("#cc-auth-wall");
      const row = sidebarEl?.querySelector("#cc-upload-row");
      const chip = sidebarEl?.querySelector("#cc-job-chip");
      const btn = sidebarEl?.querySelector("#cc-analyse-btn");
      if (wall) wall.style.display = "none";
      const secPlain = sidebarEl?.querySelector(".cc-section-plain"); if (secPlain) secPlain.style.display = "flex";
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
      // First load: checkNav only fires on an ID *change*, and init() already
      // pre-set lastJobId to the current job, so the initial job is never
      // detected. Force a wait-for-content detect now that auth has resolved.
      _waitForJobContent(() => detectJob());
    }
    new MutationObserver(checkNav).observe(document.body, { childList: true, subtree: false });
    // LinkedIn is an SPA: clicking a job in the list updates the URL via the history
    // API (no full load, no popstate), and DOM mutations can be missed. Catch nav both
    // by patching history methods and by a lightweight job-id poll, so changing the job
    // always re-detects it and we never analyse against the previous job's description.
    ["pushState", "replaceState"].forEach(fn => {
      const orig = history[fn];
      history[fn] = function () { const r = orig.apply(this, arguments); setTimeout(checkNav, 50); return r; };
    });
    window.addEventListener("popstate", () => setTimeout(checkNav, 50));
    setInterval(checkNav, 1200);
  }

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
    if (msg.type === "OPEN_BUY_CREDITS") { showBuyCreditsModal(); }
  });

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

  chrome.runtime.onConnect && chrome.runtime.onConnect;
  safeInit();
})();

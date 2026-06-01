# Applyin — Architecture & Build Guide

## What's in this repo (testable today)

```
applyin/
├── manifest.json                  ← MV3 extension manifest
├── icons/
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── background/
│   │   └── worker.js              ← Service worker: usage, caching, mock API
│   ├── content/
│   │   ├── inject.js              ← Sidebar injection + LinkedIn scraper
│   │   └── sidebar.css            ← Full sidebar styling
│   └── popup/
│       ├── popup.html             ← Extension popup
│       └── popup.js
└── ARCHITECTURE.md
```

---

## Loading the extension (no build step)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `applyin/` folder
5. Navigate to any `linkedin.com/jobs/view/...` page
6. The sidebar appears on the right ✓

---

## How the mock works (and how to replace it)

In `src/background/worker.js`, find `callAnalyzeAPI()`.

To connect a real backend, replace the body with:

```js
const res = await fetch("https://your-api.railway.app/analyze-job", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${await getToken()}`  // from Supabase Auth
  },
  body: JSON.stringify({ job: jobData, resume: resumeText })
});
return res.json();
```

Everything else (caching, usage counting, UI) stays the same.

---

## Backend spec (FastAPI — build order day 3–5)

### Folder structure

```
backend/
├── main.py
├── routers/
│   ├── analyze.py       # POST /analyze-job
│   ├── resume.py        # POST /upload-resume
│   ├── usage.py         # GET /usage
│   └── subscription.py  # GET /subscription
├── services/
│   ├── llm.py           # Claude/GPT call wrapper
│   ├── cache.py         # Job analysis cache (Redis or Supabase)
│   ├── usage.py         # Usage tracking + limit enforcement
│   └── extractor.py     # Lightweight skill/keyword pre-extraction
├── models/
│   └── schemas.py       # Pydantic request/response models
├── db/
│   └── supabase.py      # Supabase client
└── requirements.txt
```

### POST /analyze-job

```python
# Request
{
  "title": "Senior Data Engineer",
  "company": "Stripe",
  "description": "...",
  "skills": ["Python", "Spark", "Kafka"],
  "experience": "5+ years",
  "resume_text": "..."   # optional, from stored resume
}

# Response
{
  "match_score": 74,
  "fit_level": "medium",          # "strong" | "medium" | "weak"
  "recommendation": "Apply after tailoring...",
  "missing_skills": ["Kubernetes", "Airflow"],
  "resume_suggestions": ["..."],
  "interview_questions": {
    "technical": [...],
    "behavioural": [...],
    "company_specific": [...]
  },
  "cached": false,
  "analyses_remaining": 2
}
```

### POST /upload-resume

```python
# Multipart form — PDF or plain text
# Extract text, store in Supabase users.resume_text
# Return { "status": "ok", "word_count": 412 }
```

### GET /usage

```python
# Returns current user's usage state
{
  "user_id": "uuid",
  "analyses_used": 2,
  "analyses_limit": 3,
  "subscription": "free",   # "free" | "paid"
  "reset_date": "2026-06-01"
}
```

### GET /subscription

```python
# Placeholder — will hit Stripe/Razorpay webhook state
{
  "plan": "free",
  "stripe_customer_id": null,
  "next_billing_date": null
}
```

---

## Supabase schema

```sql
-- Users (managed by Supabase Auth)
-- Extended profile
create table user_profiles (
  id           uuid primary key references auth.users(id),
  email        text,
  resume_text  text,
  created_at   timestamptz default now()
);

-- Usage tracking
create table usage_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references user_profiles(id),
  job_title    text,
  company      text,
  match_score  int,
  fit_level    text,
  cached       boolean,
  created_at   timestamptz default now()
);

-- Monthly usage aggregation (or compute from usage_events)
create table monthly_usage (
  user_id      uuid references user_profiles(id),
  month        text,             -- "2026-05"
  count        int default 0,
  primary key (user_id, month)
);

-- Analysis cache
create table analysis_cache (
  cache_key    text primary key,
  user_id      uuid references user_profiles(id),
  result       jsonb,
  expires_at   timestamptz,
  created_at   timestamptz default now()
);

-- Subscriptions
create table subscriptions (
  user_id             uuid primary key references user_profiles(id),
  plan                text default 'free',
  stripe_customer_id  text,
  stripe_sub_id       text,
  status              text default 'inactive',
  current_period_end  timestamptz,
  updated_at          timestamptz default now()
);

-- Analytics events (lightweight)
create table analytics_events (
  id         bigserial primary key,
  user_id    uuid,
  event      text,
  properties jsonb,
  created_at timestamptz default now()
);
```

---

## AI cost control (implemented in worker.js, complete in backend)

| Layer | Mechanism | Saves |
|---|---|---|
| In-extension cache | Same URL + same user → skip API call | ~60% of calls |
| Backend cache | Same job hash across users → single LLM call | ~25% more |
| Keyword pre-extraction | Strip JD to 300-word skill summary before LLM | ~40% tokens |
| Rate limiting | Free: 3/month, Paid: 50/month | Cost ceiling |
| Model selection | Claude Haiku / GPT-4o-mini for scoring, full model for questions | ~70% cost ↓ |

---

## 7-day build order

| Day | Task |
|---|---|
| 1 | **Load & test this extension** on LinkedIn. Validate UI. Get first user feedback. |
| 2 | FastAPI skeleton: `/analyze-job` with hardcoded mock response. Deploy to Railway. |
| 3 | Wire extension → real backend. Add Supabase Auth + JWT middleware. |
| 4 | Add real LLM call (Claude Haiku). Add resume upload endpoint. |
| 5 | Supabase usage tracking. Monthly limits enforced server-side. |
| 6 | Analytics events. Caching layer. Rate limiting middleware. |
| 7 | Beta users. Collect: installs → upload resume → first analysis → repeat. |

---

## Success metric targets (week 1)

- [ ] 10 installs
- [ ] 7 resume uploads (70% activation)
- [ ] 5 users complete second analysis (50% repeat)
- [ ] 2 paywall hits (validates monetisation interest)
- [ ] 0 crashes

---

## Environment variables (backend)

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...
ANTHROPIC_API_KEY=...      # or OPENAI_API_KEY
REDIS_URL=...              # optional — Supabase table works for MVP
JWT_SECRET=...
ALLOWED_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

---

## Deployment

### Railway (backend)
```bash
railway login
railway new
railway add postgresql   # or use Supabase directly
railway deploy
```

### Extension → Chrome Web Store (post-MVP)
```bash
# Zip the folder (no node_modules, no build step needed for this version)
zip -r applyin.zip applyin/ -x "*.DS_Store"
# Upload at: https://chrome.google.com/webstore/devconsole
```

---

## Monetisation architecture (ready to wire)

All state is in `chrome.storage.local.usage.subscription`.
When the user upgrades (Stripe webhook → your backend → update Supabase subscriptions table):
1. Backend returns `subscription: "paid"` in `/usage` response
2. Extension reads it, sets `chrome.storage.local.set({ usage: { ...u, subscription: "paid" } })`
3. All limits removed instantly. No extension update needed.

Razorpay (India) is a drop-in alternative to Stripe — same webhook pattern.

# Applyin — Chrome Extension

Instantly know if you should apply to a job: AI-powered fit score, missing skills, and interview prep for LinkedIn.

Applyin is a Chrome extension that integrates with LinkedIn job listings to provide real-time resume-job matching powered by AI. Get actionable insights without leaving LinkedIn.

## Features

🎯 **Fit Score** — Instant AI-powered matching between your resume and the job  
🔍 **Missing Skills Analysis** — See exactly what skills you're missing  
📚 **Interview Prep** — Get research brief with company interview patterns & tips  
💡 **Career Insights** — Understand how your background aligns with the role  
⚡ **One-Click Analysis** — Just open a LinkedIn job and click analyze  

## Installation

### From Chrome Web Store (Coming Soon)

### Developer Mode (Manual Installation)

1. Clone the repository:
   ```bash
   git clone https://github.com/AnkitSurana/applyin-extension.git
   cd applyin-extension
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (top right)

4. Click **Load unpacked** and select the `applyin-extension` folder

5. The Applyin extension should now appear in your Chrome toolbar

## How It Works

### Step 1: Sign Up
- Click the Applyin extension icon
- Create an account (get 3 free analysis credits)

### Step 2: Go to LinkedIn Job
- Search for a job on LinkedIn
- Click on any job listing

### Step 3: Analyze
- Click the **"Analyze with Applyin"** button in the sidebar
- Upload your resume (PDF)
- Wait ~5 seconds for AI analysis

### Step 4: Get Insights
- View your **Fit Score** (0-100)
- See **Missing Skills** that are most important
- Read **Interview Prep** guide for the company
- Make an informed decision about applying

## What Gets Analyzed

Your resume is analyzed for:
- **Technical Skills** — Languages, frameworks, tools you know vs. what's needed
- **Experience Level** — Years in relevant roles
- **Domain Knowledge** — Industry experience alignment
- **Education** — Degree requirements vs. your background
- **Growth Potential** — How quickly you could learn the required skills

## Pricing

**Free Trial**: 3 analyses when you sign up  

**Credit Packages**:
- **Starter**: 20 analyses — ₹299 / $3.99
- **Pro**: 60 analyses — ₹799 / $9.99 ⭐ Popular
- **Power**: 150 analyses — ₹1,799 / $21.99

## Privacy & Security

✅ Your resume is **never stored** in our database  
✅ Resume data is sent only to OpenAI for analysis (zero-retention settings)  
✅ Only metadata (scores, token counts, timestamps) are logged  
✅ You control all data — request deletion anytime  

[Read our Privacy Policy & Compliance Notes](https://github.com/AnkitSurana/applyin-backend/blob/main/COMPLIANCE_NOTES.md)

## Tech Stack

- **Frontend**: JavaScript, Chrome Extension Manifest V3
- **Backend**: FastAPI (Python)
- **AI**: OpenAI Responses API + GPT-4o
- **Database**: Supabase (PostgreSQL)
- **Authentication**: JWT + Supabase Auth

## Project Structure

```
applyin-extension/
├── src/
│   ├── content/
│   │   ├── inject.js       # LinkedIn page injection
│   │   └── sidebar.css     # Analysis sidebar styling
│   ├── background/
│   │   └── worker.js       # Service worker (background tasks)
│   ├── popup/
│   │   └── popup.html      # Extension popup UI
│   └── utils/
│       └── api.js          # API communication with backend
├── icons/                  # Extension icons
├── manifest.json           # Extension configuration
└── README.md
```

## Getting Started with Development

### Prerequisites
- Node.js 16+ (if you want to run a build step)
- Chrome browser
- A GitHub account (to fork/clone)

### Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/AnkitSurana/applyin-extension.git
   cd applyin-extension
   ```

2. Load it in Chrome:
   - `chrome://extensions/` → Developer Mode ON → Load unpacked → select folder

3. Set the backend URL in `src/utils/api.js`:
   ```javascript
   const API_BASE = "https://applyin-backend.onrender.com"; // or your local backend
   ```

4. Test the extension:
   - Go to linkedin.com/jobs
   - You should see the Applyin sidebar on job postings
   - Click "Analyze with Applyin" to test

## Backend Setup

To run the full stack locally, see the **[applyin-backend README](https://github.com/AnkitSurana/applyin-backend)** for:
- FastAPI server setup
- Supabase database configuration
- OpenAI API integration
- Payment (Razorpay) setup

## Known Limitations

- ⚠️ LinkedIn's terms of service restrict automated data collection. Use Applyin responsibly.
- ⚠️ PDF resume parsing works best for standard formats; complex layouts may have issues.
- ⚠️ Analysis takes 3–8 seconds depending on resume/JD size and server load.

## Troubleshooting

### Extension not showing on LinkedIn
- Verify manifest.json permissions match your LinkedIn URL
- Check Chrome's `chrome://extensions` page for errors
- Reload the extension (click refresh icon)

### "Backend connection failed"
- Ensure you've set the correct API_BASE URL
- Check if the backend is running (visit `/health` endpoint)
- Check browser console (F12) for detailed error messages

### Resume upload fails
- Ensure file is a valid PDF (< 10MB)
- Try a different browser if one fails consistently

## Contributing

We welcome contributions! Areas we'd love help with:

- **Bug fixes** — Found an issue? Open a PR
- **UI improvements** — Better sidebar design, UX flows
- **Resume parsing** — Better support for non-standard formats
- **Localization** — Translate to other languages
- **Testing** — Add unit & integration tests

## License

MIT License — see [LICENSE](LICENSE) file

## Support

- 📧 Email: ankitsurana002@gmail.com
- 🐛 Issues: [GitHub Issues](https://github.com/AnkitSurana/applyin-extension/issues)
- 💬 Questions: [GitHub Discussions](https://github.com/AnkitSurana/applyin-extension/discussions)

## Links

- **Backend Repo**: [applyin-backend](https://github.com/AnkitSurana/applyin-backend)
- **Portfolio**: [ankitsurana.com](https://ankitsurana.com)
- **Twitter**: [@AnkitSurana](https://twitter.com/AnkitSurana)

---

Made with ❤️ by [Ankit Surana](https://github.com/AnkitSurana)

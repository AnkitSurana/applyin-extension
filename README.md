# Applyin - Chrome Extension

Instantly know whether you should apply to a LinkedIn job. Applyin adds a sidebar to LinkedIn job pages with an AI fit score, the skills you're missing, resume rewrites, and interview prep. Upload your resume once, then click analyze on any job.

## Install (developer mode)

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open a LinkedIn job posting; the Applyin sidebar appears.

## Project structure

```
src/
├── config.js          # shared config (API base, site URLs, version)
├── content/           # in-page sidebar + LinkedIn scraping
├── background/        # service worker (backend calls, auth, caching)
└── popup/             # toolbar popup (login, credits, sidebar toggle)
manifest.json          # Manifest V3 configuration
icons/                 # extension icons
```

Manifest V3, vanilla JavaScript, no build step. Load the folder as-is.

## Privacy

Your resume is sent to the Applyin backend for analysis and is not stored there; only metadata (scores, token counts, timestamps) is logged. No API keys live in the extension.

## License

MIT - see [LICENSE](LICENSE).

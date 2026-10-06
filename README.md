# Stargazer

Your pocket dashboard for the cosmos. Live ISS tracking, tonight's cloud cover and visibility, moon phase, and the NASA Astronomy Picture of the Day. Vanilla HTML, CSS and JavaScript, no build step.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell, tabs, Open Graph tags |
| `styles.css` | Deep-space theme |
| `app.js` | Geolocation, API calls, moon phase, ISS map, share and install logic |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (caches the app shell) |
| `icons/`, `preview.png` | App icons and the social share image |

## Deploy

1. Push this folder to a GitHub repository.
2. Connect the repo to Cloudflare and publish the root folder (no build command, no build output directory).
3. The site must be served over HTTPS for geolocation, the service worker and install prompts.

## APIs

- Open-Meteo: cloud cover, visibility, sunrise and sunset (no key)
- wheretheiss.at: ISS position, polled every 10 seconds (no key)
- NASA APOD: uses a personal api.nasa.gov key set in `app.js` (it is visible to anyone who views the page source, so use a free key, not a sensitive one).

## Notes

- If location access is denied, the app falls back to Kolkata.
- After changing any cached file, bump `CACHE` in `sw.js` so users get the update.

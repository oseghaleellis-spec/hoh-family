# HOH Family

The House of Honour Family app.

- `site/` – the app itself (what people open in their browser).
- `netlify/functions/push.js` – sends phone alerts when the app is closed.
- Netlify setting needed: `FIREBASE_SERVICE_ACCOUNT` (the service-account JSON from Firebase).

To update the app: replace the files inside `site/` with the new ones Claude sends, then commit. Netlify publishes automatically.

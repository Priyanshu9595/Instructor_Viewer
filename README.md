# Instructor_Viewer

One-page Instructor Allocation sheet computed **live from BigQuery** (read-only).
React (Vite) frontend + Node/Express API.

- Top-left: title · middle: search · top-right: combined Month-Year picker
- Two-row grouped header (the original sheet layout), resizable columns,
  sticky Employee Number/Name, mobile responsive
- Rows = instructor roster; allocation % = share of the selected month's
  session minutes per program (KKH → NIAT Batch 1&2, other campuses → Batch 3,
  Intensive, Common). Columns with no data source stay blank.

## Local development

```
cd server
npm install
npm run dev          # API on :5000  (needs .env — see .env.example)

cd client
npm install
npm run dev          # app on :5174 (proxies /api to :5000)
```

`server/.env` needs `BIGQUERY_PROJECT_ID` and a service account key
(`GOOGLE_APPLICATION_CREDENTIALS` path locally, or `GCP_SA_KEY_B64` in
deployed environments). The account only needs BigQuery Data Viewer +
Job User roles. **Never commit the key file or .env** — both are gitignored.

## Deploy

### Backend (any Node host — Render/Railway/etc.)
- Root directory: `server` · Build: `npm install` · Start: `npm start`
- Env vars: `BIGQUERY_PROJECT_ID`, `GCP_SA_KEY_B64`
  (PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("bigquery-service-account.json"))`)

### Frontend (Vercel)
- Root directory: `client` · Framework: Vite (auto-detected)
- Edit `client/vercel.json` and replace `YOUR-BACKEND-URL` with the deployed
  backend URL — Vercel then proxies `/api/*` to it.

import { BigQuery } from "@google-cloud/bigquery";
import { resolveCredentials } from "./credentials.js";

// Client init + env validation. Call getBigQuery() at startup of whatever
// entry point needs BigQuery — it throws immediately (fail fast) if anything
// is missing, with every problem listed at once.

const REQUIRED = ["BIGQUERY_PROJECT_ID"];

let cached = null;

export function getBigQuery() {
  if (cached) return cached;

  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}\n` +
        "Set them in server/.env (see .env.example)."
    );
  }

  const keyPath = resolveCredentials();

  const projectId = process.env.BIGQUERY_PROJECT_ID;
  cached = {
    // Credentials flow through ADC via GOOGLE_APPLICATION_CREDENTIALS —
    // never parsed manually, never passed inline.
    bigquery: new BigQuery({ projectId }),
    projectId,
    keyPath,
  };
  return cached;
}

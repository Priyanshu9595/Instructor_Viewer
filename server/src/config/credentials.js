import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve Google credentials for Application Default Credentials (ADC).
// Order:
//   1. GOOGLE_APPLICATION_CREDENTIALS — if the file exists on disk (local dev)
//   2. GCP_SA_KEY_B64 — decoded to a 0600 temp file (deployed environments)
//   3. server/bigquery-service-account.json — conventional local fallback
//
// The key contents are never read into this process beyond the decode-and-write
// step, and are never logged or serialised. The BigQuery client picks the file
// up via ADC — we only ever hand it a path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_FILE = path.resolve(__dirname, "..", "..", "bigquery-service-account.json");

export function resolveCredentials() {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit) {
    const abs = path.resolve(explicit);
    if (fs.existsSync(abs)) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = abs;
      return abs;
    }
  }

  const b64 = process.env.GCP_SA_KEY_B64;
  if (b64) {
    const tmpFile = path.join(os.tmpdir(), `gcp-sa-${process.pid}.json`);
    fs.writeFileSync(tmpFile, Buffer.from(b64, "base64"), { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
    return tmpFile;
  }

  if (fs.existsSync(DEFAULT_KEY_FILE)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = DEFAULT_KEY_FILE;
    return DEFAULT_KEY_FILE;
  }

  throw new Error(
    "No Google credentials found. Provide one of:\n" +
      `  - GOOGLE_APPLICATION_CREDENTIALS (path to key file)${explicit ? ` — currently set to "${explicit}" but that file does not exist` : ""}\n` +
      "  - GCP_SA_KEY_B64 (base64 of the key JSON, for deployed environments)\n" +
      `  - a key file at ${DEFAULT_KEY_FILE}`
  );
}

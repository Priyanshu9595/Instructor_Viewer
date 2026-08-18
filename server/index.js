import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { getBigQuery } from "./src/config/bigquery.js";

// Instructor Allocation API — reads BigQuery live (SELECT only, never writes).
// One endpoint: /api/allocations?month=YYYY-MM

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5000;
const CACHE_TTL = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sheet layout: two-row header (group band + leaf row)
// ---------------------------------------------------------------------------

const ALLOC_DS = "niat_instructor_automation_data";
const LANGS = ["Telugu", "Tamil", "Hindi", "Marathi", "Kannada", "Malayalam", "Others"];
const CHECK_HINT = "Make Sure Check Comes 0%";

const langLeaves = (prefix) =>
  LANGS.map((l) => ({ key: `${prefix}_${l.toLowerCase()}`, label: l, kind: "percent" }));

const pctLeaf = (key, label = "Product %") => ({ key, label, kind: "percent" });
const costLeaf = (key) => ({ key, label: "Product Cost", kind: "percent" });
const checkLeaf = (key) => ({
  key, label: "Check", hint: CHECK_HINT, kind: "percent", check: { expect: 1, tolerance: 0.005 },
});

const ALLOC_GROUPS = [
  {
    group: null, frozen: true,
    leaves: [
      { key: "employee_number", label: "Employee Number", kind: "text", sticky: true },
      { key: "employee_name", label: "Employee Name", kind: "text", sticky: true },
    ],
  },
  {
    group: null,
    leaves: [
      { key: "joining_date", label: "Joining Date", kind: "date" },
      { key: "quit_date", label: "Quit Date", kind: "date" },
      { key: "for_month", label: "For Month (YYYY-MM)", kind: "text" },
      { key: "department", label: "Department", kind: "text" },
      { key: "top_department", label: "Top Department", kind: "text" },
      { key: "designation", label: "Designation", kind: "text" },
      { key: "gender", label: "Gender", kind: "text" },
      { key: "wfo_wfh", label: "WFO/WFH", kind: "text" },
      { key: "workspace", label: "Workspace", kind: "text" },
      { key: "source_department", label: "Source Department", kind: "text" },
      { key: "benficiary_department", label: "Benficiary Department", kind: "text" },
    ],
  },
  {
    group: "Make Sure Product Check Comes 100%", groupTone: "warn",
    leaves: [{ key: "product_check", label: "Product Check", kind: "percent", check: { expect: 1, tolerance: 0.005 } }],
  },
  {
    group: "Make Sure Region Check Comes 100%", groupTone: "warn",
    leaves: [{ key: "region_check", label: "Region Check", kind: "percent", check: { expect: 1, tolerance: 0.005 } }],
  },
  { group: "Academy", leaves: [...langLeaves("academy"), pctLeaf("academy_product_pct"), checkLeaf("academy_check")] },
  { group: "Intensive", leaves: [pctLeaf("intensive_product_pct")] },
  { group: "Intensive Offline", leaves: [pctLeaf("intensive_offline_product_pct")] },
  { group: "NIAT Batch 1 & 2", leaves: [costLeaf("niat_batch_1_2_product_cost")] },
  { group: "NIAT Batch 3", leaves: [costLeaf("niat_batch_3_product_cost")] },
  { group: "NIAT Batch 4", leaves: [...langLeaves("niat_batch_4"), costLeaf("niat_batch_4_product_cost"), checkLeaf("niat_batch_4_check")] },
  { group: "NIAT Batch 5", leaves: [...langLeaves("niat_batch_5"), pctLeaf("niat_batch_5_product_pct"), checkLeaf("niat_batch_5_check")] },
  { group: "NxtWave Edge", leaves: [pctLeaf("nxtwave_edge_product_pct")] },
  { group: "NxtWave Launchpad", leaves: [pctLeaf("nxtwave_launchpad_product_pct")] },
  { group: "Others", leaves: [pctLeaf("others_product_pct")] },
  { group: "Common", leaves: [pctLeaf("common_all", "All")] },
];

const ALLOC_COLUMNS = ALLOC_GROUPS.flatMap((g) =>
  g.leaves.map((l) => ({
    key: l.key, label: l.label, hint: l.hint || null, align: "left",
    kind: l.kind, sticky: !!l.sticky, check: l.check || null,
  }))
);

// ---------------------------------------------------------------------------
// Allocation query: roster (who) + monthly session minutes (what, where)
// ---------------------------------------------------------------------------

// Batch 1&2 campuses are matched by institute_name_enum from the institute
// master (joined on institute_id) — currently NIAT_KKH.
const BATCH_1_2_ENUM_RE = "(?i)(PILOT|KKH)";

// Wherever this institute_id appears, Workspace shows the enum NIAT_KKH:
const KKH_INSTITUTE_ID = "c70904a0a7e644acbcca40f3704b2c59";

// Session → bucket rules (diary note, 23 Feb). Used both for per-instructor
// shares and to find each institute's dominant batch (aliases: s = session
// schedule row, i = institute master row).
const BUCKET_CASE_SQL = `
      CASE
        WHEN s.institute_type = 'INTENSIVE_OFFLINE' THEN 'intensive_offline'
        WHEN s.institute_type = 'INTENSIVE' THEN 'intensive'
        WHEN s.institute_type = 'NIAT_TRAINING' THEN 'niat_batch_5'
        WHEN s.institute_type = 'NIAT_OFFLINE' THEN
          CASE
            WHEN REGEXP_CONTAINS(COALESCE(i.institute_name_enum, ''), r'${BATCH_1_2_ENUM_RE}')
              THEN 'niat_batch_1_2'
            WHEN s.derived_semester_title IN ('Semester 1', 'Semester 2') THEN 'niat_batch_4'
            WHEN s.derived_semester_title IS NOT NULL THEN 'niat_batch_3'
            WHEN REGEXP_CONTAINS(COALESCE(s.batch_name, ''), r'(?i)batch[ -]*1\\b') THEN 'niat_batch_3'
            WHEN REGEXP_CONTAINS(COALESCE(s.batch_name, ''), r'(?i)batch[ -]*[2-9]') THEN 'niat_batch_4'
            ELSE 'niat_batch_3'
          END
        WHEN s.institute_type IS NULL THEN 'common'
        ELSE 'others'
      END`;

const ALLOC_SQL = (projectId) => `
  WITH roster AS (
    SELECT r.instructor_user_id,
      ANY_VALUE(r.instructor_name) AS employee_name,
      ANY_VALUE(r.instructor_category) AS department,
      ANY_VALUE(r.instructor_manager_category) AS top_department,
      ANY_VALUE(r.instructor_role) AS designation,
      STRING_AGG(DISTINCT
        CASE
          WHEN i.institute_id = '${KKH_INSTITUTE_ID}' THEN i.institute_name_enum
          ELSE r.institute_name
        END, ', ') AS workspace,
      ANY_VALUE(r.instructor_manager) AS source_department,
      ANY_VALUE(i.institute_id) AS home_institute_id
    FROM \`${projectId}.${ALLOC_DS}.niat_instructor_managers_and_instructors_details\` r
    LEFT JOIN \`${projectId}.${ALLOC_DS}.niat_institute_details\` i
      ON r.institute_name = i.institute_name
    GROUP BY 1
  ),
  sess AS (
    SELECT s.instructor_user_id,
      ANY_VALUE(s.instructor_name) AS session_name,
      ${BUCKET_CASE_SQL} AS bucket,
      SUM(COALESCE(s.session_duration_in_mins_from_schedule_time, s.session_duration, 0)) AS mins
    FROM \`${projectId}.${ALLOC_DS}.niat_instructor_session_schedule_details\` s
    LEFT JOIN \`${projectId}.${ALLOC_DS}.niat_institute_details\` i
      ON s.institute_id = i.institute_id
    WHERE FORMAT_DATETIME('%Y-%m', s.session_start_datetime) = @month
    GROUP BY s.instructor_user_id, bucket
  )
  , sess_campus AS (
    -- Fallback workspace: the campuses the instructor actually taught at this
    -- month (used when the roster has no entry, e.g. inactive instructors).
    SELECT s.instructor_user_id,
      STRING_AGG(DISTINCT
        CASE WHEN s.institute_id = '${KKH_INSTITUTE_ID}' THEN 'NIAT_KKH' ELSE s.institute_name END, ', ') AS session_workspace,
      -- Central BOA point-of-contact — fallback manager when roster has none.
      STRING_AGG(DISTINCT s.central_boa_poc, ', ') AS session_poc
    FROM \`${projectId}.${ALLOC_DS}.niat_instructor_session_schedule_details\` s
    WHERE FORMAT_DATETIME('%Y-%m', s.session_start_datetime) = @month
    GROUP BY 1
  ),
  master AS (
    -- Instructor master (reverse_etl): email + fallback for department,
    -- designation and workspace when the manager roster has no entry.
    SELECT instructor_user_id,
      ANY_VALUE(instructor_mail) AS email,
      ANY_VALUE(instructor_category) AS m_department,
      ANY_VALUE(instructor_role) AS m_designation,
      ANY_VALUE(institute_name) AS m_workspace
    FROM \`${projectId}.niat_reverse_etl_bases.niat_instructor_details\`
    GROUP BY 1
  ),
  inst_bucket AS (
    -- Each institute's dominant batch: this month's sessions decide; if the
    -- campus had none this month, its all-time sessions decide. Used to give
    -- no-session instructors 100% in their home university's batch.
    SELECT institute_id, bucket FROM (
      SELECT s.institute_id,
        ${BUCKET_CASE_SQL} AS bucket,
        SUM(CASE WHEN FORMAT_DATETIME('%Y-%m', s.session_start_datetime) = @month
                 THEN COALESCE(s.session_duration_in_mins_from_schedule_time, s.session_duration, 0) ELSE 0 END) AS mins_month,
        SUM(COALESCE(s.session_duration_in_mins_from_schedule_time, s.session_duration, 0)) AS mins_all
      FROM \`${projectId}.${ALLOC_DS}.niat_instructor_session_schedule_details\` s
      LEFT JOIN \`${projectId}.${ALLOC_DS}.niat_institute_details\` i
        ON s.institute_id = i.institute_id
      WHERE s.institute_id IS NOT NULL
      GROUP BY 1, 2
    )
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY institute_id
      ORDER BY (mins_month > 0) DESC, mins_month DESC, mins_all DESC
    ) = 1
  )
  SELECT
    COALESCE(r.instructor_user_id, s.instructor_user_id) AS instructor_user_id,
    COALESCE(r.employee_name, s.session_name) AS employee_name,
    e.email,
    COALESCE(r.department, e.m_department) AS department,
    r.top_department,
    COALESCE(r.designation, e.m_designation) AS designation,
    -- Workspace = institutes where the instructor actually taught this month;
    -- roster/master institute only when there were no sessions.
    COALESCE(sc.session_workspace, r.workspace, e.m_workspace) AS workspace,
    COALESCE(r.source_department, sc.session_poc) AS source_department,
    hb.bucket AS home_bucket,
    r.home_institute_id,
    s.bucket, s.mins
  FROM roster r
  FULL OUTER JOIN sess s USING (instructor_user_id)
  LEFT JOIN sess_campus sc USING (instructor_user_id)
  LEFT JOIN master e USING (instructor_user_id)
  LEFT JOIN inst_bucket hb ON hb.institute_id = r.home_institute_id
`;

const allocCache = new Map(); // month → { ts, rows }

app.get("/api/allocations", async (req, res) => {
  try {
    const { bigquery, projectId } = getBigQuery();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : "2026-08";

    let rows;
    const cached = allocCache.get(month);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      rows = cached.rows;
    } else {
      const [raw] = await bigquery.query({ query: ALLOC_SQL(projectId), params: { month } });

      // Pivot: one row per instructor; bucket minutes → fractions of total.
      const byInstructor = new Map();
      for (const r of raw) {
        if (!r.instructor_user_id) continue; // sessions with no instructor id
        let rec = byInstructor.get(r.instructor_user_id);
        if (!rec) {
          rec = {
            id: r.instructor_user_id,
            employee_name: r.employee_name,
            email: r.email,
            department: r.department,
            top_department: r.top_department,
            designation: r.designation,
            workspace: r.workspace,
            source_department: r.source_department,
            home_bucket: r.home_bucket,
            home_institute_id: r.home_institute_id,
            buckets: {},
            totalMins: 0,
          };
          byInstructor.set(r.instructor_user_id, rec);
        }
        if (r.bucket) {
          const mins = Number(r.mins) || 0;
          rec.buckets[r.bucket] = (rec.buckets[r.bucket] || 0) + mins;
          rec.totalMins += mins;
        }
      }

      // Rows with neither a name nor an email are orphan records — drop them.
      // Most session minutes first, then alphabetical.
      const recs = [...byInstructor.values()]
        .filter((rec) => (rec.employee_name && rec.employee_name.trim()) || rec.email)
        .sort(
          (a, b) => b.totalMins - a.totalMins || String(a.employee_name).localeCompare(String(b.employee_name))
        );

      rows = recs.map((rec) => {
        const frac = (bucket) =>
          rec.totalMins > 0 && rec.buckets[bucket] ? rec.buckets[bucket] / rec.totalMins : null;
        const hasSessions = rec.totalMins > 0;
        // No sessions this month:
        //   Training Institute / Program Ops home → NIAT 5 = 100% (backup)
        //   otherwise home university/institute allocated → 100% in that
        //   institute's dominant batch (home_bucket from the data)
        const isTrainingBackup = /training institute|program[_ ]?ops/i.test(rec.workspace || "");
        // Home campus allocated but that campus has no session history yet
        // (upcoming campus) → new intake → NIAT Batch 4 (diary note: 17+24 SEM 1).
        const assignedBucket = !hasSessions
          ? (isTrainingBackup
              ? "niat_batch_5"
              : rec.home_bucket || (rec.home_institute_id ? "niat_batch_4" : null))
          : null;
        const share = (bucket) =>
          hasSessions ? frac(bucket) : assignedBucket === bucket ? 1 : null;
        // Product Check = real sum of every allocated share. Rows with no
        // allocation anywhere show 0% (red) instead of a fake 100%.
        const productCheck =
          (share("intensive") || 0) +
          (share("intensive_offline") || 0) +
          (share("niat_batch_1_2") || 0) +
          (share("niat_batch_3") || 0) +
          (share("niat_batch_4") || 0) +
          (share("niat_batch_5") || 0) +
          (share("others") || 0) +
          (share("common") || 0);
        return {
          _id: rec.id,
          // Employee Number shows the instructor's email.
          employee_number: rec.email || null,
          joining_date: null,
          quit_date: null,
          for_month: null,
          gender: null,
          wfo_wfh: null,
          benficiary_department: null,
          employee_name: rec.employee_name,
          department: rec.department,
          top_department: rec.top_department,
          designation: rec.designation,
          workspace: rec.workspace,
          source_department: rec.source_department,
          product_check: productCheck,
          region_check: 1,
          // Academy: no Academy data exists in the tables yet — the whole
          // group stays blank. Fill only when real data arrives; never guess.
          academy_others: null,
          academy_product_pct: null,
          academy_check: null,
          intensive_product_pct: share("intensive"),
          intensive_offline_product_pct: share("intensive_offline"),
          niat_batch_1_2_product_cost: share("niat_batch_1_2"),
          niat_batch_3_product_cost: share("niat_batch_3"),
          // Batch 4 = new intake (Sem 1–2), Batch 5 = Training/Backup.
          // Language split columns stay blank (no language data).
          niat_batch_4_product_cost: share("niat_batch_4"),
          niat_batch_4_others: null,
          niat_batch_4_check: null,
          niat_batch_5_product_pct: share("niat_batch_5"),
          niat_batch_5_others: null,
          niat_batch_5_check: null,
          nxtwave_edge_product_pct: null,
          nxtwave_launchpad_product_pct: null,
          others_product_pct: share("others"),
          common_all: share("common"),
        };
      });

      allocCache.set(month, { ts: Date.now(), rows });
    }

    res.json({ groups: ALLOC_GROUPS, columns: ALLOC_COLUMNS, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load allocations" });
  }
});

// ---------------------------------------------------------------------------
// Generic table browser (read-only): list every BigQuery table and browse any
// of them page by page with schema introspection — nothing hardcoded.
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_$]+$/;
let tablesCache = { ts: 0, data: null };
const schemaCache = new Map();
const countCache = new Map();

async function listTables() {
  if (tablesCache.data && Date.now() - tablesCache.ts < CACHE_TTL) return tablesCache.data;
  const { bigquery } = getBigQuery();
  const [datasets] = await bigquery.getDatasets();
  const data = [];
  for (const ds of datasets) {
    const [tables] = await ds.getTables();
    data.push({ dataset: ds.id, tables: tables.map((t) => t.id) });
  }
  tablesCache = { ts: Date.now(), data };
  return data;
}

async function getSchema(dataset, table) {
  const key = `${dataset}.${table}`;
  const cached = schemaCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.fields;
  const { bigquery } = getBigQuery();
  const [meta] = await bigquery.dataset(dataset).table(table).getMetadata();
  const fields = meta.schema.fields.map((f) => ({ name: f.name, type: f.type }));
  schemaCache.set(key, { ts: Date.now(), fields });
  return fields;
}

app.get("/api/tables", async (_req, res) => {
  try {
    res.json({ groups: await listTables() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/table-data", async (req, res) => {
  try {
    const { bigquery, projectId } = getBigQuery();
    const dataset = req.query.dataset || ALLOC_DS;
    const table = req.query.table || "";

    if (!NAME_RE.test(dataset) || !NAME_RE.test(table)) {
      return res.status(400).json({ error: "Invalid dataset/table name" });
    }
    const groups = await listTables();
    const known = groups.find((g) => g.dataset === dataset)?.tables.includes(table);
    if (!known) return res.status(404).json({ error: `Unknown table ${dataset}.${table}` });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize, 10) || 50));
    const search = (req.query.search || "").trim().toLowerCase();

    const fields = await getSchema(dataset, table);
    const fq = `\`${projectId}.${dataset}.${table}\``;
    const stringCols = fields.filter((f) => f.type === "STRING").map((f) => f.name);

    let where = "";
    const filterParams = {};
    if (search && stringCols.length > 0) {
      where =
        "WHERE (" +
        stringCols.slice(0, 12).map((c) => `LOWER(\`${c}\`) LIKE @pat`).join(" OR ") +
        ")";
      filterParams.pat = `%${search}%`;
    }

    const orderCol = stringCols[0] || fields[0]?.name;
    const orderBy = orderCol
      ? `ORDER BY (\`${orderCol}\` IS NULL OR CAST(\`${orderCol}\` AS STRING) = ''), \`${orderCol}\``
      : "";

    const cacheKey = JSON.stringify([dataset, table, search]);
    const cachedCount = countCache.get(cacheKey);
    let total;
    if (cachedCount && Date.now() - cachedCount.ts < CACHE_TTL) {
      total = cachedCount.n;
    } else {
      const [countRows] = await bigquery.query({
        query: `SELECT COUNT(*) AS n FROM ${fq} ${where}`,
        params: filterParams,
      });
      total = Number(countRows[0].n);
      countCache.set(cacheKey, { ts: Date.now(), n: total });
    }

    const [rows] = await bigquery.query({
      query: `SELECT * FROM ${fq} ${where} ${orderBy} LIMIT @limit OFFSET @offset`,
      params: { ...filterParams, limit: pageSize, offset: (page - 1) * pageSize },
    });

    const plainRows = rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => {
          if (v !== null && typeof v === "object") {
            return [k, "value" in v ? v.value : JSON.stringify(v)];
          }
          return [k, v];
        })
      )
    );

    res.json({ schema: fields, rows: plainRows, total, page, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Change detection: poll BigQuery table metadata (last_modified_time — a free
// 0-byte metadata query) every POLL_INTERVAL_SECONDS. When any source table
// changes, bump dataVersion and clear the cache. The frontend polls
// /api/version and refetches as soon as the version moves.
// ---------------------------------------------------------------------------

const POLL_MS = Math.max(2, parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 5) * 1000;
const WATCHED = [
  { dataset: ALLOC_DS, tables: [
    "niat_instructor_managers_and_instructors_details",
    "niat_instructor_session_schedule_details",
    "niat_institute_details",
  ]},
  { dataset: "niat_reverse_etl_bases", tables: ["niat_instructor_details"] },
];

let dataVersion = 1;
let lastSignature = null;

async function checkForChanges() {
  try {
    const { bigquery, projectId } = getBigQuery();
    const parts = WATCHED.map(
      (w) =>
        `SELECT '${w.dataset}' AS ds, table_id, last_modified_time
         FROM \`${projectId}.${w.dataset}.__TABLES__\`
         WHERE table_id IN (${w.tables.map((t) => `'${t}'`).join(",")})`
    );
    const [rows] = await bigquery.query({ query: parts.join(" UNION ALL ") });
    const signature = rows
      .map((r) => `${r.ds}.${r.table_id}:${r.last_modified_time}`)
      .sort()
      .join("|");

    if (lastSignature !== null && signature !== lastSignature) {
      allocCache.clear();
      dataVersion++;
      console.log(`[watch] source data changed → version ${dataVersion}`);
    }
    lastSignature = signature;
  } catch (err) {
    console.error("[watch] poll failed:", err.message);
  }
}

// Cheap endpoint the frontend polls — no BigQuery cost, just a counter.
app.get("/api/version", (_req, res) => res.json({ version: dataVersion }));

setInterval(checkForChanges, POLL_MS);
checkForChanges();

// Fail fast on startup if BigQuery env/credentials are missing.
try {
  getBigQuery();
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

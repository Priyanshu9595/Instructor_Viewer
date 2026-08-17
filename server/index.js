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
      ANY_VALUE(r.instructor_manager) AS source_department
    FROM \`${projectId}.${ALLOC_DS}.niat_instructor_managers_and_instructors_details\` r
    LEFT JOIN \`${projectId}.${ALLOC_DS}.niat_institute_details\` i
      ON r.institute_name = i.institute_name
    GROUP BY 1
  ),
  sess AS (
    SELECT s.instructor_user_id,
      ANY_VALUE(s.instructor_name) AS session_name,
      CASE
        WHEN s.institute_type = 'INTENSIVE_OFFLINE' THEN 'intensive_offline'
        WHEN s.institute_type = 'INTENSIVE' THEN 'intensive'
        WHEN s.institute_type IN ('NIAT_OFFLINE', 'NIAT_TRAINING') THEN
          CASE
            WHEN REGEXP_CONTAINS(COALESCE(i.institute_name_enum, ''), r'${BATCH_1_2_ENUM_RE}')
              THEN 'niat_batch_1_2'
            ELSE 'niat_batch_3'
          END
        WHEN s.institute_type IS NULL THEN 'common'
        ELSE 'others'
      END AS bucket,
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
  )
  SELECT
    COALESCE(r.instructor_user_id, s.instructor_user_id) AS instructor_user_id,
    COALESCE(r.employee_name, s.session_name) AS employee_name,
    e.email,
    COALESCE(r.department, e.m_department) AS department,
    r.top_department,
    COALESCE(r.designation, e.m_designation) AS designation,
    COALESCE(r.workspace, sc.session_workspace, e.m_workspace) AS workspace,
    COALESCE(r.source_department, sc.session_poc) AS source_department,
    s.bucket, s.mins
  FROM roster r
  FULL OUTER JOIN sess s USING (instructor_user_id)
  LEFT JOIN sess_campus sc USING (instructor_user_id)
  LEFT JOIN master e USING (instructor_user_id)
`;

const allocCache = new Map(); // month → { ts, rows }

app.get("/api/allocations", async (req, res) => {
  try {
    const { bigquery, projectId } = getBigQuery();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : "2026-08";
    // fresh=1 (sent on page load) bypasses the cache → refresh = live data.
    const fresh = req.query.fresh === "1";

    let rows;
    const cached = allocCache.get(month);
    if (!fresh && cached && Date.now() - cached.ts < CACHE_TTL) {
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

      // Most session minutes first, then alphabetical.
      const recs = [...byInstructor.values()].sort(
        (a, b) => b.totalMins - a.totalMins || String(a.employee_name).localeCompare(String(b.employee_name))
      );

      rows = recs.map((rec) => {
        const frac = (bucket) =>
          rec.totalMins > 0 && rec.buckets[bucket] ? rec.buckets[bucket] / rec.totalMins : null;
        const hasSessions = rec.totalMins > 0;
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
          product_check: 1,
          region_check: 1,
          // Academy language detail is not in the data — Others carries 100%.
          // Instructors with no sessions get their whole allocation here.
          academy_others: 1,
          academy_product_pct: hasSessions ? null : 1,
          academy_check: 1,
          intensive_product_pct: frac("intensive"),
          intensive_offline_product_pct: frac("intensive_offline"),
          niat_batch_1_2_product_cost: frac("niat_batch_1_2"),
          niat_batch_3_product_cost: frac("niat_batch_3"),
          // Batches 4 & 5 (upcoming campuses) stay blank until data exists.
          niat_batch_4_product_cost: null,
          niat_batch_4_others: null,
          niat_batch_4_check: null,
          niat_batch_5_product_pct: null,
          niat_batch_5_others: null,
          niat_batch_5_check: null,
          nxtwave_edge_product_pct: null,
          nxtwave_launchpad_product_pct: null,
          others_product_pct: frac("others"),
          common_all: frac("common"),
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

app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

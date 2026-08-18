import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./App.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// 2020 (data ki shuruaat) se agle saal tak — har naya saal khud add ho jayega.
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 2020 + 2 }, (_, i) => 2020 + i);



const SEARCH_KEYS = [
  "employee_number", "employee_name", "department", "top_department",
  "designation", "workspace", "source_department",
];

// Employee Number holds emails; Employee Name holds names.
// On phones the pinned columns shrink so data columns stay visible.
const stickyWidth = (col, isMobile) =>
  isMobile ? (col.key === "employee_number" ? 130 : 150) : col.key === "employee_number" ? 260 : 300;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth < 640
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// Percents arrive as fractions (1 = 100%).
const FORMAT = {
  percent: (v) => {
    if (v === null || v === undefined || v === "") return "—";
    return `${+(parseFloat(v) * 100).toFixed(2)}%`;
  },
  date: (v) => (v ? String(v).slice(0, 10) : "—"),
  text: (v) => (v === null || v === undefined || v === "" ? "—" : String(v)),
};

const formatCell = (col, value) => (FORMAT[col.kind] || FORMAT.text)(value);

// null when the leaf has no check rule or no value; otherwise "ok" | "bad".
const checkState = (col, value) => {
  if (!col.check || value === null || value === undefined || value === "") return null;
  return Math.abs(parseFloat(value) - col.check.expect) <= col.check.tolerance ? "ok" : "bad";
};

// Columns that get an Excel-style header filter (each filters its own values).
const FILTER_COLS = ["department", "top_department", "designation", "workspace", "source_department"];

// Searchable multi-select filter, embedded in a column header.
// The panel is position:fixed so the table's scroll container can't clip it.
function ColumnFilter({ options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (
        ref.current && !ref.current.contains(e.target) &&
        (!panelRef.current || !panelRef.current.contains(e.target))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const toggleOpen = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left - 8, window.innerWidth - 320)),
    });
    setOpen((o) => !o);
  };

  const shown = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()));

  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  return (
    <span className="uni-picker" ref={ref}>
      <button
        className={selected.size > 0 ? "uni-trigger active" : "uni-trigger"}
        onClick={toggleOpen}
        title="Filter this column"
      >
        ▾{selected.size > 0 && <span className="uni-count">{selected.size}</span>}
      </button>

      {open &&
        createPortal(
          <div ref={panelRef} className="uni-panel" style={{ top: pos.top, left: pos.left }}>
            <input
              className="uni-search"
              type="text"
              placeholder="Search..."
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="uni-actions">
              <span className="page-info">{selected.size} selected</span>
              {selected.size > 0 && (
                <button className="uni-clear" onClick={() => onChange(new Set())}>Clear all</button>
              )}
            </div>
            <div className="uni-list">
              {shown.length === 0 ? (
                <div className="uni-empty">No match</div>
              ) : (
                shown.map((name) => (
                  <label key={name} className="uni-item">
                    <input
                      type="checkbox"
                      checked={selected.has(name)}
                      onChange={() => toggle(name)}
                    />
                    <span>{name}</span>
                  </label>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
    </span>
  );
}

// One combined control: a button showing "August 2026" that opens a single
// panel with year arrows on top and a 12-month grid below.
function MonthYearPicker({ year, month, onChange }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(year);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const minYear = YEARS[0];
  const maxYear = YEARS[YEARS.length - 1];

  return (
    <div className="my-picker" ref={ref}>
      <button
        className="my-button"
        onClick={() => {
          setViewYear(year);
          setOpen((o) => !o);
        }}
      >
        {MONTH_NAMES[month - 1]} {year} <span className="my-caret">▾</span>
      </button>

      {open && (
        <div className="my-panel">
          <div className="my-year-row">
            <button disabled={viewYear <= minYear} onClick={() => setViewYear((y) => y - 1)}>‹</button>
            <span>{viewYear}</span>
            <button disabled={viewYear >= maxYear} onClick={() => setViewYear((y) => y + 1)}>›</button>
          </div>
          <div className="my-month-grid">
            {MONTH_NAMES.map((m, i) => (
              <button
                key={m}
                className={viewYear === year && i + 1 === month ? "my-month active" : "my-month"}
                onClick={() => {
                  onChange(viewYear, i + 1);
                  setOpen(false);
                }}
              >
                {m.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50); // editable rows-per-page
  const [data, setData] = useState({ groups: [], columns: [], rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const isMobile = useIsMobile();

  // Auto-refresh: poll the cheap /api/version endpoint every 5s; when BigQuery
  // source data changes the version bumps and the table refetches itself.
  useEffect(() => {
    let known = null;
    const tick = async () => {
      try {
        const res = await fetch("/api/version");
        const { version } = await res.json();
        if (known !== null && version !== known) setDataVersion(version);
        known = version;
      } catch {
        /* server unreachable — try again next tick */
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const m = `${year}-${String(month).padStart(2, "0")}`;

    // Instant paint: show the last saved copy of this month immediately,
    // then silently swap in fresh data when the fetch lands.
    let hadCache = false;
    try {
      const saved = JSON.parse(localStorage.getItem("allocCache") || "null");
      if (saved && saved.month === m && saved.body?.rows) {
        setData(saved.body);
        hadCache = true;
      }
    } catch {
      /* corrupt cache — ignore */
    }

    (async () => {
      setLoading(!hadCache); // spinner only when there's nothing to show yet
      setError(null);
      try {
        const res = await fetch(`/api/allocations?month=${m}`, { signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `API error ${res.status}`);
        setData(body);
        if (!hadCache) setPage(1);
        try {
          localStorage.setItem("allocCache", JSON.stringify({ month: m, body }));
        } catch {
          /* storage full — skip saving */
        }
      } catch (err) {
        if (err.name !== "AbortError") setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [year, month, dataVersion]);

  const { groups, columns } = data;

  // Distinct values per filterable column (multi-value cells split on comma).
  const filterOptions = useMemo(() => {
    const map = {};
    for (const key of FILTER_COLS) {
      const set = new Set();
      for (const r of data.rows) {
        String(r[key] || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .forEach((v) => set.add(v));
      }
      map[key] = [...set].sort();
    }
    return map;
  }, [data.rows]);

  const [colFilters, setColFilters] = useState({}); // column key â†’ Set of values

  // Search + column filters + paginate locally.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (q && !SEARCH_KEYS.some((k) => String(r[k] || "").toLowerCase().includes(q))) {
        return false;
      }
      for (const key of FILTER_COLS) {
        const sel = colFilters[key];
        if (sel && sel.size > 0) {
          const mine = String(r[key] || "").split(",").map((x) => x.trim());
          if (!mine.some((v) => sel.has(v))) return false;
        }
      }
      return true;
    });
  }, [data.rows, search, colFilters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, filtered.length);

  // Column widths — every column can be resized by dragging the handle on the
  // right edge of its subheader cell. Defaults are sized so everything is
  // readable on first open.
  const DEFAULT_COL_WIDTH = {
    joining_date: 115,
    quit_date: 105,
    for_month: 165,
    department: 125,
    top_department: 150,
    designation: 200,
    gender: 95,
    wfo_wfh: 105,
    workspace: 240,
    source_department: 200,
    benficiary_department: 185,
    // Wide enough for their band labels to fit in one line
    product_check: 310,
    region_check: 300,
    intensive_offline_product_pct: 175,
    niat_batch_1_2_product_cost: 165,
    nxtwave_edge_product_pct: 150,
    nxtwave_launchpad_product_pct: 195,
  };

  const defaultWidth = (col) => {
    if (col.sticky) return stickyWidth(col, isMobile);
    if (DEFAULT_COL_WIDTH[col.key]) return DEFAULT_COL_WIDTH[col.key];
    if (col.check) return 155; // Check columns carry the hint text
    if (/product_cost|product_pct|common_all/.test(col.key)) return 120;
    return 105; // language columns
  };

  const [colWidths, setColWidths] = useState({});
  const widthOf = (col) => colWidths[col.key] ?? defaultWidth(col);

  const startResize = (e, col) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(col);
    let raf = null;
    const onMove = (ev) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const w = Math.max(60, Math.round(startW + (ev.clientX - startX)));
        setColWidths((prev) => ({ ...prev, [col.key]: w }));
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const totalWidth = columns.reduce((sum, col) => sum + widthOf(col), 0);

  const stickyLefts = useMemo(() => {
    const lefts = {};
    let left = 0;
    for (const col of columns) {
      if (col.sticky) {
        lefts[col.key] = left;
        left += widthOf(col);
      }
    }
    return lefts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, isMobile, colWidths]);

  const stickyStyle = (col) =>
    col.sticky ? { left: stickyLefts[col.key] } : undefined;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Instructor Allocation</h1>
        </div>
        <input
          className="search header-search"
          type="text"
          placeholder="Search employee, department, designation, workspace, manager..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <MonthYearPicker
          year={year}
          month={month}
          onChange={(y, m) => {
            setYear(y);
            setMonth(m);
            setPage(1);
          }}
        />
      </header>

      <main className="card">
        {error && <div className="banner error">Could not load data: {error}</div>}

        <div className="table-wrap">
          <table style={{ tableLayout: "fixed", width: totalWidth || "100%" }}>
            <colgroup>
              {columns.map((col) => (
                <col key={col.key} style={{ width: widthOf(col) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {groups.map((g, gi) => (
                  <th
                    key={gi}
                    colSpan={g.leaves.length}
                    className={[
                      "group-header",
                      g.groupTone ? `grp-${g.groupTone}` : "",
                      g.frozen ? "sticky-col" : "",
                    ].join(" ")}
                    style={g.frozen ? { left: 0 } : undefined}
                  >
                    {g.group || ""}
                  </th>
                ))}
              </tr>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={col.sticky ? "col-header sticky-col" : "col-header"}
                    style={stickyStyle(col)}
                  >
                    {col.label}
                    {FILTER_COLS.includes(col.key) && (
                      <ColumnFilter
                        options={filterOptions[col.key] || []}
                        selected={colFilters[col.key] || new Set()}
                        onChange={(next) => {
                          setColFilters((prev) => ({ ...prev, [col.key]: next }));
                          setPage(1);
                        }}
                      />
                    )}
                    {col.hint && <div className="hint">({col.hint})</div>}
                    <div className="col-resizer" onPointerDown={(e) => startResize(e, col)} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="status-cell" colSpan={columns.length || 1}>
                    Loading...
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td className="status-cell" colSpan={columns.length || 1}>
                    No instructors found for {MONTH_NAMES[month - 1]} {year}.
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => (
                  <tr key={row._id}>
                    {columns.map((col) => {
                      const state = checkState(col, row[col.key]);
                      return (
                        <td
                          key={col.key}
                          className={[
                            col.sticky ? "sticky-col" : "",
                            state === "bad" ? "check-bad" : "",
                          ].join(" ")}
                          style={stickyStyle(col)}
                        >
                          {formatCell(col, row[col.key])}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="toolbar table-footer">
          <span className="page-info rows-label">
            No of rows:{" "}
            <input
              className="rows-input"
              type="number"
              min="1"
              max="1000"
              value={pageSize}
              onChange={(e) => {
                const n = Math.max(1, Math.min(1000, parseInt(e.target.value, 10) || 1));
                setPageSize(n);
                setPage(1);
              }}
            />
          </span>
          <div className="pagination">
            <span className="page-info">
              {loading
                ? ""
                : `${from.toLocaleString()}–${to.toLocaleString()} of ${filtered.length.toLocaleString()}`}
            </span>
            <button disabled={safePage <= 1 || loading} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
            <span className="page-info">Page {safePage} / {totalPages}</span>
            <button disabled={safePage >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * SWOT Plugin — Excel File Parser (Full Rebuild)
 *
 * Built for real-world manufacturing workbooks:
 *   - Multi-sheet workbooks with data hidden across tabs
 *   - Headers buried under logos, titles, and blank rows (scans first 15 rows)
 *   - Merged cells (build sheets, job costing, schedules)
 *   - Formula cells — uses computed values, not formula strings
 *   - Hidden rows, hidden columns, hidden sheets (flagged + included)
 *   - Currency/number formatting ($12,450.00, (3,200), 45%)
 *   - Subtotal rows, spacer rows, "Prepared by:" footer junk
 *   - Password-protected files (graceful error with clear message)
 *   - Duplicate column names (auto-suffixed: Date, Date_2, Date_3)
 *   - Mixed data types in same column
 *   - Forward-fill of grouped key columns (job #, order # spanning rows)
 *
 * Browser usage (SheetJS + PapaParse loaded via CDN):
 *   const result = await parseFile(file);
 *   result.rows        → clean data rows from best sheet
 *   result.workbookMap → full sheet inventory for UI sheet selector
 *   result.warnings    → list of things the parser noticed
 *
 * Node.js testing:
 *   const XLSX = require('xlsx');
 *   global.XLSX = XLSX;
 *   const { parseFile } = require('./fileParser');
 */

// ─── Sheet type classification signals ───────────────────────────────────────

const SHEET_TYPE_SIGNALS = {
  sales:      ["quote", "quotes", "sales", "pipeline", "crm", "opportunity", "won", "lost", "prospect", "conversion"],
  ar:         ["ar", "receivable", "receivables", "invoice", "invoices", "aging", "collections", "outstanding", "net 30", "net 60", "net 90"],
  ap:         ["ap", "payable", "payables", "vendor", "vendors", "purchasing", "purchase", "po", "purchase order", "accounts payable"],
  inventory:  ["inventory", "stock", "warehouse", "parts", "sku", "bom", "bill of material", "components", "raw material"],
  workorders: ["work order", "work orders", "wo", "job", "jobs", "production", "schedule", "routing", "operation"],
  costing:    ["cost", "costing", "project cost", "build sheet", "estimate", "pricing", "margin", "labour", "labor", "overhead"],
  logistics:  ["ship", "shipping", "delivery", "carrier", "tracking", "dispatch", "freight"],
  quality:    ["quality", "scrap", "rework", "defect", "inspection", "yield", "ncr", "first pass"],
};

// Patterns that tag a row as junk — totals, headers, footers, separators
const JUNK_ROW_PATTERNS = [
  /^(total|totals|sub.?total|grand.?total)/i,
  /^(prepared.?by|created.?by|approved.?by|reviewed.?by)/i,
  /^(page \d|printed|generated|exported|report.?date)/i,
  /^(notes?|comments?|remarks?):?\s*$/i,
  /^-{3,}$/, /^={3,}$/, /^\*{3,}$/,
];

// Value coercion regexes
const CURRENCY_RE  = /^\s*[$£€¥]?\s*([\d,]+\.?\d*)\s*$/;
const NEG_PAREN_RE = /^\s*[$£€¥]?\s*\(([\d,]+\.?\d*)\)\s*$/;
const PCT_RE       = /^([\d.]+)\s*%\s*$/;

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parse any uploaded file into structured rows.
 *
 * @param {File|{name,buffer,content}} file
 * @param {Object}  [opts]
 * @param {string}  [opts.sheetHint]     - preferred sheet name or data type keyword
 * @param {string}  [opts.sheetName]     - force exact sheet name
 * @param {boolean} [opts.allSheets]     - parse every data-bearing sheet
 * @param {boolean} [opts.includeHidden] - include hidden sheets (default false)
 * @returns {Promise<ParseResult>}
 */
async function parseFile(file, opts = {}) {
  const ext  = (file.name || "").split(".").pop().toLowerCase();
  const type = detectType(ext);

  switch (type) {
    case "excel": return parseExcel(file, opts);
    case "csv":   return parseCSVFile(file, opts);
    case "json":  return parseJSONFile(file, opts);
    case "xml":   return parseXMLFile(file, opts);
    default:
      throw new Error(`UNSUPPORTED_TYPE:.${ext} — supported: xlsx, xls, xlsm, csv, json, xml, qbo`);
  }
}

// ─── Excel parser ─────────────────────────────────────────────────────────────

async function parseExcel(file, opts = {}) {

  // 1. Load buffer
  let buffer;
  if (file.arrayBuffer) buffer = await file.arrayBuffer();
  else if (file.buffer)  buffer = file.buffer; // Node test mock

  // 2. Parse workbook — capture formula results, not formula strings
  let wb;
  try {
    wb = XLSX.read(buffer, {
      type:       "array",
      cellDates:  true,   // convert date serials → JS Date
      cellNF:     true,   // keep number format for currency detection
      cellStyles: false,
      cellHTML:   false,
      sheetStubs: true,   // include empty cells (needed for merged-cell detection)
    });
  } catch (err) {
    const m = (err.message || "").toLowerCase();
    if (m.includes("password") || m.includes("encrypted")) {
      throw new Error("FILE_PASSWORD_PROTECTED: Remove the password and re-upload.");
    }
    throw new Error(`EXCEL_PARSE_ERROR: ${err.message}`);
  }

  // 3. Build sheet inventory
  const workbookMap = buildWorkbookMap(wb, opts.includeHidden);

  // 4. Select sheet(s)
  let targets;
  if (opts.sheetName) {
    const m = workbookMap.find(s => s.name === opts.sheetName);
    targets = [m || workbookMap[0]];
  } else if (opts.allSheets) {
    targets = workbookMap.filter(s => s.hasData);
  } else {
    targets = [selectBestSheet(workbookMap, opts.sheetHint)];
  }

  // 5. Parse each target
  const parsedSheets = targets.map(meta => parseSheet(wb.Sheets[meta.name], meta));

  const best = parsedSheets[0];
  return {
    fileName:    file.name,
    fileType:    "excel",
    workbookMap,
    sheets:      parsedSheets,
    rows:        best.rows,
    headers:     best.headers,
    sheetName:   best.sheetName,
    rowCount:    best.rows.length,
    warnings:    best.warnings,
    allWarnings: parsedSheets.flatMap(s => s.warnings),
  };
}

// ─── Workbook map ─────────────────────────────────────────────────────────────

function buildWorkbookMap(wb, includeHidden = false) {
  const hiddenSet = new Set(
    (wb.Workbook?.Sheets || [])
      .filter(s => s.Hidden > 0)
      .map(s => s.name)
  );

  return wb.SheetNames
    .filter(n => includeHidden || !hiddenSet.has(n))
    .map(name => {
      const sheet  = wb.Sheets[name];
      const ref    = sheet["!ref"];
      const hidden = hiddenSet.has(name);

      if (!ref) return blankMeta(name, hidden);

      const range    = XLSX.utils.decode_range(ref);
      const preview  = extractPreview(sheet, range);
      const { dataType, confidence } = classifySheet(name, preview);

      return {
        name, hidden,
        hasData:        calcDensity(sheet, range) > 0.08,
        rowCount:       range.e.r - range.s.r + 1,
        colCount:       range.e.c - range.s.c + 1,
        dataType, confidence,
        headerRow:      detectHeaderRow(sheet, range),
        dataDensity:    calcDensity(sheet, range),
        hasMergedCells: !!(sheet["!merges"]?.length),
        hasHiddenCols:  !!(sheet["!cols"]?.some(c => c?.hidden)),
        hasHiddenRows:  !!(sheet["!rows"]?.some(r => r?.hidden)),
        formulaCount:   countFormulas(sheet),
        preview,
      };
    });
}

function blankMeta(name, hidden) {
  return { name, hidden, hasData: false, rowCount: 0, colCount: 0,
           dataType: null, confidence: 0, headerRow: 0, dataDensity: 0,
           hasMergedCells: false, hasHiddenCols: false, hasHiddenRows: false,
           formulaCount: 0, preview: [] };
}

function extractPreview(sheet, range) {
  const texts = [];
  for (let r = range.s.r; r <= Math.min(range.s.r + 15, range.e.r); r++) {
    for (let c = range.s.c; c <= Math.min(range.s.c + 12, range.e.c); c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.v != null) texts.push(String(cell.v).toLowerCase().trim());
    }
  }
  return texts;
}

function classifySheet(name, preview) {
  const combined = [name.toLowerCase(), ...preview].join(" ");
  let best = { dataType: "unknown", confidence: 0 };
  for (const [type, signals] of Object.entries(SHEET_TYPE_SIGNALS)) {
    const hits = signals.filter(s => combined.includes(s)).length;
    const conf = Math.min(100, Math.round((hits / signals.length) * 160));
    if (conf > best.confidence) best = { dataType: type, confidence: conf };
  }
  return best;
}

function calcDensity(sheet, range) {
  let filled = 0, total = 0;
  const maxR = Math.min(range.s.r + 20, range.e.r);
  for (let r = range.s.r; r <= maxR; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      total++;
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.v != null && cell.v !== "") filled++;
    }
  }
  return total > 0 ? filled / total : 0;
}

function countFormulas(sheet) {
  return Object.values(sheet).filter(c => c?.f).length;
}

// ─── Sheet selection ──────────────────────────────────────────────────────────

function selectBestSheet(workbookMap, hint) {
  const candidates = workbookMap.filter(s => s.hasData);
  if (!candidates.length) return workbookMap[0] || blankMeta("Sheet1", false);

  if (hint) {
    const h = hint.toLowerCase();
    const exact   = candidates.find(s => s.name.toLowerCase() === h);
    const typeHit = candidates.find(s => s.dataType === h);
    const partial = candidates.find(s => s.name.toLowerCase().includes(h));
    if (exact || typeHit || partial) return exact || typeHit || partial;
  }

  const highConf = candidates.filter(s => s.confidence >= 35);
  if (highConf.length) return highConf.sort((a, b) => b.confidence - a.confidence)[0];
  return candidates.sort((a, b) => b.dataDensity - a.dataDensity)[0];
}

// ─── Sheet parsing ────────────────────────────────────────────────────────────

function parseSheet(sheet, meta) {
  const warnings = [];
  const ref = sheet["!ref"];
  if (!ref) return { sheetName: meta.name, rows: [], headers: [], warnings: ["Sheet is empty."] };

  const range = XLSX.utils.decode_range(ref);

  // Expand merged cells first — fills all cells in a merge with the origin value
  expandMergedCells(sheet);

  // Track hidden structure
  const hiddenCols = new Set((sheet["!cols"] || []).reduce((acc, c, i) => { if (c?.hidden) acc.push(i); return acc; }, []));
  const hiddenRows = new Set((sheet["!rows"] || []).reduce((acc, r, i) => { if (r?.hidden) acc.push(i); return acc; }, []));
  if (hiddenCols.size) warnings.push(`${hiddenCols.size} hidden column(s) included in analysis.`);
  if (hiddenRows.size) warnings.push(`${hiddenRows.size} hidden row(s) included in analysis.`);

  const headerRowIdx = meta.headerRow ?? detectHeaderRow(sheet, range);
  if (headerRowIdx > 0) warnings.push(`Header row found at row ${headerRowIdx + 1} — ${headerRowIdx} preamble row(s) skipped.`);

  // Extract raw rows with SheetJS — gets formula computed values
  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    defval:  "",
    raw:     false,
    dateNF:  "yyyy-mm-dd",
    range:   headerRowIdx,
  });

  if (!rawRows.length) {
    warnings.push("No data rows found after header detection.");
    return { sheetName: meta.name, rows: [], headers: [], warnings };
  }

  const headers = deduplicateHeaders(Object.keys(rawRows[0]));

  const rows = [];
  rawRows.forEach((rawRow, idx) => {
    const row = {};
    headers.forEach((h, i) => {
      const origKey = Object.keys(rawRow)[i];
      row[h] = coerceValue(rawRow[origKey]);
    });

    const skip = shouldSkipRow(row, headers);
    if (skip.skip) {
      if (skip.reason !== "empty" && idx < rawRows.length - 10) {
        warnings.push(`Row ${headerRowIdx + idx + 2} skipped: ${skip.reason}`);
      }
      return;
    }
    rows.push(row);
  });

  if (meta.formulaCount > 0) {
    warnings.push(`${meta.formulaCount} formula cell(s) found — computed values used (not recalculated).`);
  }

  return {
    sheetName:  meta.name,
    dataType:   meta.dataType,
    confidence: meta.confidence,
    rows:       forwardFillKeyColumns(rows, headers),
    headers,
    rowCount:   rows.length,
    warnings,
    meta,
  };
}

// ─── Merged cell expansion ────────────────────────────────────────────────────

/**
 * For every merged region, copy the top-left cell value into every
 * empty cell in the merge. This handles build sheets where a job number
 * spans 10 operation rows but only has a value in the first cell.
 */
function expandMergedCells(sheet) {
  (sheet["!merges"] || []).forEach(merge => {
    const origin = sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
    if (!origin) return;
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!sheet[addr] || sheet[addr].v == null || sheet[addr].v === "") {
          sheet[addr] = { ...origin };
        }
      }
    }
  });
}

// ─── Header row detection ─────────────────────────────────────────────────────

const HEADER_KEYWORDS = [
  "id","no","num","number","date","name","description","desc","qty","quantity",
  "amount","total","price","cost","status","customer","vendor","supplier","part",
  "sku","item","job","order","invoice","po","rep","product","type","code","ship",
  "due","paid","balance","hours","rate","unit","ref","ref#","wo","lot","serial",
  "lead","margin","percent","pct","est","actual","planned","scheduled",
];

function detectHeaderRow(sheet, range) {
  let bestRow = 0, bestScore = -1;
  const maxScan = Math.min(14, range.e.r - range.s.r);

  for (let r = range.s.r; r <= range.s.r + maxScan; r++) {
    let text = 0, keywords = 0, numeric = 0, total = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v == null || cell.v === "") continue;
      total++;
      const val = String(cell.v).toLowerCase().trim();
      if (cell.t === "s" || isNaN(Number(val.replace(/[$,]/g, "")))) {
        text++;
        if (HEADER_KEYWORDS.some(kw => val.includes(kw))) keywords++;
      } else {
        numeric++;
      }
    }
    if (!total) continue;
    const score = (text / total) * 8 + keywords * 3 + Math.min(total, 8) - (numeric > text ? 4 : 0);
    if (score > bestScore) { bestScore = score; bestRow = r - range.s.r; }
  }
  return bestRow;
}

// ─── Value coercion ───────────────────────────────────────────────────────────

function coerceValue(raw) {
  if (raw == null) return "";
  if (raw instanceof Date) return fmtDate(raw);
  const str = String(raw).trim();
  if (!str || str === "-" || /^n\/?a$/i.test(str)) return "";

  // ISO date passthrough
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str;

  // Percentage  "14.5%"  → 0.145
  const pct = str.match(PCT_RE);
  if (pct) return parseFloat(pct[1]) / 100;

  // Accounting negative  "(1,234.56)"  → -1234.56
  const neg = str.match(NEG_PAREN_RE);
  if (neg) return -parseFloat(neg[1].replace(/,/g, ""));

  // Currency / comma-number  "$1,234.56"  → 1234.56
  const cur = str.match(CURRENCY_RE);
  if (cur) { const n = parseFloat(cur[1].replace(/,/g, "")); if (!isNaN(n)) return n; }

  // Plain numeric with commas
  const plain = Number(str.replace(/,/g, ""));
  if (!isNaN(plain) && str !== "") return plain;

  return str;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── Junk row detection ───────────────────────────────────────────────────────

function shouldSkipRow(row, headers) {
  const vals    = headers.map(h => row[h]);
  const nonEmpty = vals.filter(v => v !== "" && v != null);

  if (!nonEmpty.length) return { skip: true, reason: "empty" };

  // Too sparse — likely a section header or spacer
  if (nonEmpty.length < 3 && nonEmpty.length / headers.length < 0.18) {
    return { skip: true, reason: "sparse row (likely section label or spacer)" };
  }

  // Junk pattern on first value
  const first = String(vals.find(v => v !== "" && v != null) || "");
  for (const pat of JUNK_ROW_PATTERNS) {
    if (pat.test(first)) return { skip: true, reason: `junk row pattern: "${first.slice(0,40)}"` };
  }

  // All values identical (repeated section label across merged span)
  if (nonEmpty.length >= 4 && new Set(nonEmpty.map(String)).size === 1) {
    return { skip: true, reason: "repeated section label row" };
  }

  return { skip: false, reason: null };
}

// ─── Duplicate column names ───────────────────────────────────────────────────

function deduplicateHeaders(rawHeaders) {
  const seen = {};
  return rawHeaders.map(h => {
    const k = String(h).trim() || "column";
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] === 1 ? k : `${k}_${seen[k]}`;
  });
}

// ─── Forward-fill grouped key columns ────────────────────────────────────────

/**
 * Fills downward in columns that look like "group keys" —
 * columns that are 15-80% populated, suggesting a job number or order ID
 * that appears once per group but should be on every row.
 *
 * Example: a build sheet with Job# in column A, spanning 12 operation rows,
 * but only filled in the first row. After this function every row has the Job#.
 */
function forwardFillKeyColumns(rows, headers) {
  if (!rows.length) return rows;

  const keyCols = headers.filter(h => {
    const vals = rows.map(r => r[h]);
    const filled = vals.filter(v => v !== "" && v != null).length;
    const ratio  = filled / vals.length;
    return ratio >= 0.12 && ratio <= 0.80;
  });

  if (!keyCols.length) return rows;

  const out   = rows.map(r => ({ ...r }));
  const last  = {};

  out.forEach(row => {
    keyCols.forEach(h => {
      if (row[h] !== "" && row[h] != null) last[h] = row[h];
      else if (last[h] != null) row[h] = last[h];
    });
  });

  return out;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function parseCSVFile(file, opts = {}) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header:          true,
      skipEmptyLines:  "greedy",
      dynamicTyping:   false,
      transformHeader: h => h.trim(),
      complete: result => {
        const rows = result.data
          .map(row => {
            const clean = {};
            for (const [k, v] of Object.entries(row)) {
              if (k) clean[k] = coerceValue(v);
            }
            return clean;
          })
          .filter(row => Object.values(row).filter(v => v !== "" && v != null).length >= 2);

        resolve({
          fileName: file.name, fileType: "csv",
          rows, headers: rows.length ? Object.keys(rows[0]) : [],
          rowCount: rows.length, warnings: [],
          workbookMap: null, sheets: null,
        });
      },
      error: err => reject(new Error(`CSV_PARSE_ERROR: ${err.message}`)),
    });
  });
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

async function parseJSONFile(file, opts = {}) {
  const text = file.text ? await file.text() : file.content;
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("JSON_PARSE_ERROR: Invalid JSON file."); }

  const arr = Array.isArray(parsed)    ? parsed
    : Array.isArray(parsed.data)       ? parsed.data
    : Array.isArray(parsed.records)    ? parsed.records
    : Object.values(parsed);

  const rows = arr.map(r => {
    const clean = {};
    for (const [k, v] of Object.entries(r)) { if (k) clean[k.trim()] = coerceValue(v); }
    return clean;
  }).filter(r => Object.values(r).some(v => v !== "" && v != null));

  return { fileName: file.name, fileType: "json",
           rows, headers: rows.length ? Object.keys(rows[0]) : [],
           rowCount: rows.length, warnings: [], workbookMap: null, sheets: null };
}

// ─── XML / QuickBooks / ERP ───────────────────────────────────────────────────

async function parseXMLFile(file, opts = {}) {
  const text = file.text ? await file.text() : file.content;
  const dom  = new DOMParser().parseFromString(text, "application/xml");
  const tagC = {};
  Array.from(dom.querySelectorAll("*")).forEach(el => {
    if (el.children.length > 0) tagC[el.tagName] = (tagC[el.tagName] || 0) + 1;
  });
  const rowTag = Object.entries(tagC).filter(([,c]) => c > 1).sort((a,b) => b[1]-a[1])[0]?.[0];
  if (!rowTag) return { fileName: file.name, fileType: "xml", rows: [], headers: [],
                        rowCount: 0, warnings: ["No repeating elements found."], workbookMap: null, sheets: null };

  const rows = Array.from(dom.querySelectorAll(rowTag))
    .map(el => {
      const obj = {};
      Array.from(el.children).forEach(c => { obj[c.tagName] = coerceValue(c.textContent.trim()); });
      return obj;
    })
    .filter(r => Object.values(r).some(v => v !== "" && v != null));

  return { fileName: file.name, fileType: "xml",
           rows, headers: rows.length ? Object.keys(rows[0]) : [],
           rowCount: rows.length, warnings: [], workbookMap: null, sheets: null };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function detectType(ext) {
  if (["xlsx","xls","xlsm","xlsb"].includes(ext)) return "excel";
  if (["csv","txt","tsv"].includes(ext))           return "csv";
  if (ext === "json")                               return "json";
  if (["xml","qbo","iif"].includes(ext))            return "xml";
  return "unknown";
}

/**
 * Remap parsed row keys from raw header names to standard schema field names.
 * Handles dedup suffixes (e.g. "Date_2") and preserves first match only.
 */
function applyMapping(rows, mappings) {
  const lookup = {};
  mappings.forEach(m => {
    if (m.mapped && m.mapped !== "skip" && m.mapped !== "— skip —") {
      lookup[m.raw] = m.mapped;
      // Also index base name so "Date_2" matches a "Date" mapping
      const base = m.raw.replace(/_\d+$/, "");
      if (base !== m.raw && !lookup[base]) lookup[base] = m.mapped;
    }
  });

  return rows.map(row => {
    const out = {};
    for (const [rawKey, val] of Object.entries(row)) {
      const stdKey = lookup[rawKey] || lookup[rawKey.replace(/_\d+$/, "")];
      if (stdKey && !out[stdKey]) out[stdKey] = val;
    }
    return out;
  });
}

/**
 * Returns a UI-ready summary of the workbook's sheets
 * for the sheet selector panel.
 */
function summarizeWorkbook(parseResult) {
  if (!parseResult.workbookMap) return null;
  return parseResult.workbookMap.map(s => ({
    name:           s.name,
    hidden:         s.hidden,
    hasData:        s.hasData,
    rowCount:       s.rowCount,
    colCount:       s.colCount,
    dataType:       s.dataType || "unknown",
    confidence:     s.confidence || 0,
    hasMergedCells: s.hasMergedCells,
    hasHiddenCols:  s.hasHiddenCols,
    hasHiddenRows:  s.hasHiddenRows,
    formulaCount:   s.formulaCount,
    recommended:    s.confidence >= 35 && s.hasData,
    badge: s.hidden    ? "hidden"
         : !s.hasData  ? "empty"
         : s.confidence >= 55 ? s.dataType
         : s.confidence >= 25 ? `${s.dataType}?`
         : "data",
  }));
}

module.exports = { parseFile, applyMapping, detectType, summarizeWorkbook };

/**
 * SWOT Plugin — Ingestion Orchestrator
 *
 * The single entry point for all data flowing into the plugin.
 * Accepts one or more uploaded files (or pre-loaded data objects),
 * runs them through the full pipeline, and returns a DataBundle
 * ready for the SWOT engine.
 *
 * Pipeline stages:
 *   1. Detection       — identify file type
 *   2. Structural parse — extract rows (fileParser.js)
 *   3. Column mapping  — fuzzy-match headers to schema (columnMapper.js)
 *   4. Normalization   — apply confirmed mappings (applyMapping)
 *   5. Domain routing  — place rows into the right DataBundle slot
 *   6. Validation      — flag missing critical fields, empty domains
 *
 * Usage:
 *   const bundle = await ingestFiles(files, { companyName: "Acme Mfg" });
 *   const swot   = await runSWOTAnalysis(bundle);
 *
 * Or step by step (for UI confirmation of mappings):
 *   const staged  = await stageFiles(files);
 *   // show staged.mappingReview to user, let them correct
 *   const bundle  = await finalizeIngestion(staged, confirmedMappings);
 */

const { parseFile, applyMapping, summarizeWorkbook } = require('./fileParser');
const { mapColumns, STANDARD_FIELDS }                = require('./columnMapper');

// ─── Domain routing table ─────────────────────────────────────────────────────
//
// Maps standard schema field names to DataBundle keys.
// The first matching domain "wins" for a given set of headers.

const DOMAIN_FIELD_SIGNALS = {
  sales: [
    "quote_id","quote_date","quote_value","status","win_loss_reason",
    "product_line","quote_to_close_days","pipeline_stage","deal_source",
    "contact_role","competitor_named",
  ],
  ar: [
    "invoice_id","invoice_date","invoice_amount","due_date","payment_date",
    "payment_amount","balance_due","aging_bucket","days_outstanding",
    "early_pay_discount_pct",
  ],
  ap: [
    "po_number","po_date","po_amount","vendor_name","vendor_id",
    "invoice_received_date","payment_due_date","unit_price_po",
    "unit_price_invoiced","quantity_ordered","quantity_received",
  ],
  workOrders: [
    "work_order_id","scheduled_start","scheduled_end","actual_start",
    "actual_end","quantity_planned","quantity_completed","planned_hours",
    "actual_hours","on_hold_reason","job_type","work_center_id",
  ],
  bom: [
    "parent_sku","component_sku","component_description","quantity_per",
    "unit_of_measure","lead_time_days","primary_vendor","secondary_vendor",
  ],
  inventory: [
    "quantity_on_hand","quantity_on_order","reorder_point","reorder_quantity",
    "avg_daily_usage","unit_cost","last_movement_date","location_code",
    "safety_stock","finished_goods_qty","work_in_progress_qty",
  ],
  capacity: [
    "work_center_name","hours_available","hours_scheduled","hours_actual",
    "operator_count","department",
  ],
  quality: [
    "quantity_produced","quantity_passed","quantity_scrapped",
    "quantity_reworked","scrap_reason","first_pass_yield_pct",
  ],
  deliveries: [
    "promised_ship_date","revised_ship_date","actual_ship_date",
    "on_time_delivery_pct","order_fill_rate",
  ],
  logistics: [
    "carrier","tracking_number","estimated_delivery","actual_delivery",
    "shipping_delay_days","delay_reason",
  ],
};

// Critical fields that must be present for each domain to be useful
const DOMAIN_REQUIRED_FIELDS = {
  sales:      ["status"],
  ar:         ["invoice_amount", "due_date"],
  ap:         ["po_amount", "vendor_name"],
  workOrders: ["scheduled_end", "status"],
  bom:        ["component_sku", "quantity_per"],
  inventory:  ["quantity_on_hand"],
  capacity:   ["hours_available"],
  quality:    ["quantity_produced", "quantity_passed"],
  deliveries: ["promised_ship_date"],
  logistics:  ["shipping_delay_days"],
};

// ─── Full pipeline (auto mode) ────────────────────────────────────────────────

/**
 * Full ingestion pipeline — parse, map, normalize, route, validate.
 * Use when you want zero UI interaction (batch mode / API mode).
 *
 * @param {File[]|{name,buffer}[]} files
 * @param {Object} [options]
 * @param {string} [options.companyName]
 * @param {Date}   [options.asOfDate]
 * @param {boolean}[options.includeHidden]  - include hidden Excel sheets
 * @returns {Promise<DataBundle>}
 */
async function ingestFiles(files, options = {}) {
  const staged  = await stageFiles(files, options);
  const bundle  = await finalizeIngestion(staged, null, options);
  return bundle;
}

// ─── Stage 1–3: parse + auto-map (returns review object for UI) ───────────────

/**
 * Parse all files and run auto column mapping.
 * Returns a StagedIngestion object the UI can display for user review
 * before the mappings are finalized.
 *
 * @param {File[]|{name,buffer}[]} files
 * @param {Object} [options]
 * @returns {Promise<StagedIngestion>}
 */
async function stageFiles(files, options = {}) {
  const fileList    = Array.isArray(files) ? files : [files];
  const staged      = [];
  const allWarnings = [];

  for (const file of fileList) {
    try {
      // Stage 1 + 2: detect type and parse structure
      const parsed = await parseFile(file, {
        includeHidden: options.includeHidden || false,
        sheetHint:     options.sheetHint,
      });

      allWarnings.push(...(parsed.warnings || []).map(w => `[${file.name}] ${w}`));

      // Handle multi-sheet workbooks — parse each selected sheet separately
      const sheetsToProcess = parsed.sheets
        ? parsed.sheets.filter(s => s.rows.length > 0)
        : [{ sheetName: "default", rows: parsed.rows, headers: parsed.headers, dataType: null }];

      for (const sheet of sheetsToProcess) {
        if (!sheet.rows.length) continue;

        // Stage 3: column mapping via Claude API
        const fileContext = buildFileContext(file.name, sheet.sheetName, sheet.dataType);
        const rawMappings = await mapColumns(sheet.headers, fileContext);

        const autoMappedCount = rawMappings.filter(m => m.confidence === "high").length;
        const reviewNeeded    = rawMappings.filter(m => m.confidence !== "high");

        // Detect likely domain from mapped fields
        const mappedFields  = rawMappings.filter(m => m.mapped !== "skip").map(m => m.mapped);
        const detectedDomain = detectDomain(mappedFields, sheet.dataType);

        staged.push({
          sourceFile:    file.name,
          sheetName:     sheet.sheetName,
          fileContext,
          rows:          sheet.rows,
          headers:       sheet.headers,
          mappings:      rawMappings,
          autoMappedCount,
          reviewCount:   reviewNeeded.length,
          reviewNeeded,
          detectedDomain,
          rowCount:      sheet.rows.length,
          workbookMap:   parsed.workbookMap ? summarizeWorkbook(parsed) : null,
          warnings:      sheet.warnings || [],
        });
      }

    } catch (err) {
      const code = err.message?.split(":")[0];
      allWarnings.push(buildErrorMessage(code, file.name, err.message));

      // Still add a placeholder so the UI can show the error per file
      staged.push({
        sourceFile:    file.name,
        error:         err.message,
        errorCode:     code,
        rows:          [],
        headers:       [],
        mappings:      [],
        detectedDomain: null,
        rowCount:      0,
      });
    }
  }

  return {
    staged,
    totalFiles:   fileList.length,
    totalRows:    staged.reduce((s, f) => s + f.rowCount, 0),
    warnings:     allWarnings,
    needsReview:  staged.some(f => f.reviewCount > 0),
    hasErrors:    staged.some(f => f.error),
  };
}

// ─── Stage 4–6: normalize + route + validate ─────────────────────────────────

/**
 * Apply confirmed mappings, route rows to domain slots, validate.
 *
 * @param {StagedIngestion}           staged
 * @param {Object|null}               confirmedMappings  - keyed by sourceFile+sheetName
 *                                                         null = use auto mappings as-is
 * @param {Object}                    [options]
 * @returns {DataBundle}
 */
async function finalizeIngestion(staged, confirmedMappings = null, options = {}) {
  const bundle = emptyBundle(options);
  const report = { sources: [], warnings: [...staged.warnings], errors: [] };

  for (const source of staged.staged) {
    if (source.error) {
      report.errors.push({ file: source.sourceFile, error: source.error });
      continue;
    }

    // Use confirmed mappings if provided, otherwise use auto mappings
    const mappingKey = `${source.sourceFile}::${source.sheetName}`;
    const mappings   = confirmedMappings?.[mappingKey] || source.mappings;

    // Stage 4: normalize — apply field name mappings
    const normalized = applyMapping(source.rows, mappings);

    if (!normalized.length) {
      report.warnings.push(`[${source.sourceFile} / ${source.sheetName}] No rows after normalization — check column mappings.`);
      continue;
    }

    // Stage 5: domain routing — place rows in the right bundle slot
    const domain = source.detectedDomain;
    if (domain && bundle[domain] !== undefined) {
      bundle[domain].push(...normalized);
    } else {
      // Can't auto-route — add to a staging area for manual override
      bundle._unrouted.push({
        source:       source.sourceFile,
        sheet:        source.sheetName,
        rows:         normalized,
        detectedDomain: domain,
      });
      report.warnings.push(`[${source.sourceFile} / ${source.sheetName}] Could not auto-route ${normalized.length} rows (detected domain: ${domain || "unknown"}) — manual assignment needed.`);
    }

    // Stage 6: validate — check required fields are present
    const validation = validateDomain(normalized, domain);
    if (!validation.valid) {
      report.warnings.push(
        `[${source.sourceFile} / ${source.sheetName}] Missing recommended fields for ${domain}: ${validation.missing.join(", ")}`
      );
    }

    report.sources.push({
      file:       source.sourceFile,
      sheet:      source.sheetName,
      domain,
      rowCount:   normalized.length,
      mappedFields: mappings.filter(m => m.mapped !== "skip").length,
      validation,
    });
  }

  bundle._report = report;
  bundle.asOfDate = options.asOfDate || new Date();

  return bundle;
}

// ─── Domain detection ─────────────────────────────────────────────────────────

/**
 * Score each domain against the set of mapped field names,
 * boosted by the sheet's detected data type from the parser.
 */
function detectDomain(mappedFields, sheetDataType) {
  const scores = {};

  for (const [domain, signals] of Object.entries(DOMAIN_FIELD_SIGNALS)) {
    const hits = mappedFields.filter(f => signals.includes(f)).length;
    scores[domain] = hits;
    // Bonus if the sheet classifier agrees
    if (sheetDataType && domain.toLowerCase().includes(sheetDataType.toLowerCase())) {
      scores[domain] += 3;
    }
  }

  const best = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])[0];

  return best ? best[0] : null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateDomain(rows, domain) {
  if (!domain || !DOMAIN_REQUIRED_FIELDS[domain]) return { valid: true, missing: [] };

  const required = DOMAIN_REQUIRED_FIELDS[domain];
  const available = Object.keys(rows[0] || {});
  const missing   = required.filter(f => !available.includes(f));

  return { valid: missing.length === 0, missing };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyBundle(options = {}) {
  return {
    // Sales
    sales:      [],
    // Finance
    ar:         [],
    ap:         [],
    // ERP
    workOrders: [],
    bom:        [],
    inventory:  [],
    capacity:   [],
    quality:    [],
    deliveries: [],
    // Logistics
    logistics:  [],
    // Meta
    asOfDate:   options.asOfDate || new Date(),
    companyName: options.companyName || "the company",
    _unrouted:  [],
    _report:    null,
  };
}

/**
 * Build a natural-language file context description for the column mapper prompt.
 * The more context Claude has, the better its field mappings.
 */
function buildFileContext(fileName, sheetName, detectedType) {
  const parts = [];

  // File name signals
  const fn = fileName.toLowerCase();
  if (fn.includes("quote") || fn.includes("crm") || fn.includes("sales")) parts.push("CRM or sales quote export");
  else if (fn.includes("ar") || fn.includes("aging") || fn.includes("receivable")) parts.push("accounts receivable aging report");
  else if (fn.includes("ap") || fn.includes("payable") || fn.includes("vendor")) parts.push("accounts payable or vendor invoice file");
  else if (fn.includes("wo") || fn.includes("work order") || fn.includes("production")) parts.push("production or work order schedule");
  else if (fn.includes("bom") || fn.includes("bill")) parts.push("bill of materials");
  else if (fn.includes("inv") || fn.includes("stock") || fn.includes("warehouse")) parts.push("inventory or warehouse stock file");
  else if (fn.includes("cost") || fn.includes("build") || fn.includes("project")) parts.push("project cost or build sheet");
  else if (fn.includes("ship") || fn.includes("delivery") || fn.includes("freight")) parts.push("shipping or delivery record");
  else parts.push("manufacturing business data file");

  // Sheet name adds more context
  if (sheetName && sheetName !== "default") parts.push(`sheet named "${sheetName}"`);

  // Parser-detected type
  if (detectedType && detectedType !== "unknown") parts.push(`likely data type: ${detectedType}`);

  return parts.join(", ");
}

function buildErrorMessage(code, fileName, fullMessage) {
  const messages = {
    FILE_PASSWORD_PROTECTED: `[${fileName}] File is password-protected — save an unprotected copy and re-upload.`,
    EXCEL_PARSE_ERROR:       `[${fileName}] Excel file could not be read — it may be corrupted or in an unsupported format.`,
    CSV_PARSE_ERROR:         `[${fileName}] CSV file could not be parsed — check for unusual characters or encoding.`,
    JSON_PARSE_ERROR:        `[${fileName}] JSON file is invalid — check for syntax errors.`,
    UNSUPPORTED_TYPE:        `[${fileName}] File type not supported — use xlsx, xls, csv, json, xml, or qbo.`,
  };
  return messages[code] || `[${fileName}] Parse error: ${fullMessage}`;
}

/**
 * Returns a human-readable ingestion report for display in the UI
 * or logging to the console.
 */
function formatIngestionReport(bundle) {
  const r = bundle._report;
  if (!r) return "No report available.";

  const lines = [`Ingestion complete — ${r.sources.length} source(s) processed\n`];

  r.sources.forEach(s => {
    const valid = s.validation.valid ? "✓" : "⚠";
    lines.push(`  ${valid} ${s.file} / ${s.sheet}`);
    lines.push(`      domain: ${s.domain || "unrouted"} · ${s.rowCount} rows · ${s.mappedFields} fields mapped`);
    if (!s.validation.valid) {
      lines.push(`      missing recommended fields: ${s.validation.missing.join(", ")}`);
    }
  });

  if (r.warnings.length) {
    lines.push(`\nWarnings (${r.warnings.length}):`);
    r.warnings.forEach(w => lines.push(`  ⚠ ${w}`));
  }

  if (r.errors.length) {
    lines.push(`\nErrors (${r.errors.length}):`);
    r.errors.forEach(e => lines.push(`  ✗ ${e.file}: ${e.error}`));
  }

  // Domain summary
  lines.push("\nData bundle summary:");
  const domains = ["sales","ar","ap","workOrders","bom","inventory","capacity","quality","deliveries","logistics"];
  domains.forEach(d => {
    const count = bundle[d]?.length || 0;
    if (count > 0) lines.push(`  ${d.padEnd(14)} ${count} rows`);
  });
  if (bundle._unrouted.length) {
    lines.push(`  ${"unrouted".padEnd(14)} ${bundle._unrouted.reduce((s,u) => s + u.rows.length, 0)} rows — need manual domain assignment`);
  }

  return lines.join("\n");
}

// ─── Example usage ────────────────────────────────────────────────────────────
//
// Full auto pipeline:
//
//   const bundle = await ingestFiles([quotesFile, arFile, workOrdersFile], {
//     companyName: "Acme Precision Mfg",
//     asOfDate:    new Date("2024-04-08"),
//   });
//   console.log(formatIngestionReport(bundle));
//   const swot = await runSWOTAnalysis(bundle, { companyName: bundle.companyName });
//
//
// Step-by-step (with UI review of column mappings):
//
//   // 1. Stage — parse and auto-map
//   const staged = await stageFiles([quotesFile, arFile], { companyName: "Acme" });
//
//   // 2. Show staged.staged[i].mappings to user in the UI
//   //    User corrects any mappings with confidence !== "high"
//
//   // 3. Finalize with confirmed mappings
//   const confirmedMappings = {
//     "Q1_quotes.xlsx::Q1 Quotes": correctedMappingsArray,
//   };
//   const bundle = await finalizeIngestion(staged, confirmedMappings, { companyName: "Acme" });
//   console.log(formatIngestionReport(bundle));

module.exports = {
  ingestFiles,
  stageFiles,
  finalizeIngestion,
  formatIngestionReport,
  detectDomain,
  emptyBundle,
  DOMAIN_FIELD_SIGNALS,
  DOMAIN_REQUIRED_FIELDS,
};

/**
 * SWOT Plugin — Column Mapper
 * Maps raw column headers to standard schema fields using
 * keyword/pattern matching. No API call required — fast and
 * reliable for typical manufacturing export files.
 */

const STANDARD_FIELDS = [
    // Sales / CRM
    "quote_id", "quote_date", "quote_value", "status",
    "win_loss_reason", "product_line", "quote_to_close_days",
    "sales_rep_id", "customer_name", "customer_id",
    "deal_source", "pipeline_stage", "competitor_named",
    "contact_role", "expected_close_date", "close_date",

    // AR — receivables
    "invoice_id", "invoice_date", "invoice_amount",
    "due_date", "payment_terms",
    "payment_date", "payment_amount", "balance_due",
    "early_pay_discount_pct",
    "aging_bucket",
    "days_outstanding",

    // AP — payables
    "po_number", "po_date", "po_amount",
    "vendor_name", "vendor_id",
    "invoice_received_date",
    "payment_due_date", "amount_paid",
    "unit_price_po", "unit_price_invoiced",
    "quantity_ordered", "quantity_received",
    "early_pay_cutoff_days",

    // Operations / Inventory
    "order_id", "order_date", "order_status",
    "product_sku", "quantity_on_hand",
    "materials_needed", "scheduled_ship_date", "actual_ship_date",
    "finished_goods_qty", "work_in_progress_qty",

    // Logistics
    "carrier", "tracking_number", "estimated_delivery",
    "actual_delivery", "shipping_delay_days", "delay_reason",

    // Catch-all
    "skip"
  ];

/**
 * Pattern rules: each entry is [ regex, standardField, confidence ]
 * Checked in order — first match wins.
 */
const PATTERNS = [
    // ── Quote / Sales ──────────────────────────────────────────────────────────
    [/quote\s*#|quote\s*num|quote\s*id|q\s*#/i,           "quote_id",             "high"],
    [/quote.*date|date.*quot/i,                             "quote_date",           "high"],
    [/quote.*val|quote.*amt|quote.*amount|quote.*\$/i,      "quote_value",          "high"],
    [/total\s*\$|total.*amount|deal.*val|opportunity.*val/i,"quote_value",          "medium"],
    [/unit.*price|price.*unit/i,                            "unit_price_po",        "medium"],
    [/status|result|outcome|disposition/i,                  "status",               "high"],
    [/win.*loss|lost.*reason|loss.*reason|reason.*lost/i,   "win_loss_reason",      "high"],
    [/product.*line|line.*product|product.*cat|category/i,  "product_line",         "high"],
    [/days.*close|close.*days|cycle.*time|time.*close/i,    "quote_to_close_days",  "high"],
    [/rep|salesperson|sales.*person|account.*mgr|am\b/i,    "sales_rep_id",         "high"],
    [/cust.*name|client.*name|company.*name|account.*name/i,"customer_name",        "high"],
    [/cust.*id|client.*id|account.*id|account.*#/i,         "customer_id",          "high"],
    [/source|lead.*source|deal.*source/i,                   "deal_source",          "medium"],
    [/stage|pipeline/i,                                     "pipeline_stage",       "medium"],
    [/competitor|competing|comp\b/i,                        "competitor_named",     "medium"],
    [/contact.*role|role.*contact|title/i,                  "contact_role",         "medium"],
    [/expected.*close|target.*close|projected.*close/i,     "expected_close_date",  "high"],
    [/close.*date|closed.*date|won.*date/i,                 "close_date",           "high"],

    // ── AR — Receivables ───────────────────────────────────────────────────────
    [/inv.*#|inv.*num|invoice.*id|inv.*id/i,                "invoice_id",           "high"],
    [/inv.*date|date.*inv/i,                                "invoice_date",         "high"],
    [/inv.*amount|inv.*amt|inv.*total|billed/i,             "invoice_amount",       "high"],
    [/due.*date|payment.*due|maturity/i,                    "due_date",             "high"],
    [/pay.*terms|terms|net\s*\d+/i,                         "payment_terms",        "medium"],
    [/pay.*date|date.*paid|paid.*date/i,                    "payment_date",         "high"],
    [/pay.*amount|pay.*amt|amount.*paid|amt.*paid/i,        "payment_amount",       "high"],
    [/balance.*due|outstanding.*bal|amt.*outstanding|open.*bal/i, "balance_due",    "high"],
    [/early.*pay.*disc|discount.*pct|discount.*%/i,         "early_pay_discount_pct","medium"],
    [/aging.*bucket|age.*bucket|bucket/i,                   "aging_bucket",         "high"],
    [/days.*out|days.*overdue|overdue.*days|days.*past/i,   "days_outstanding",     "high"],

    // ── AP — Payables ──────────────────────────────────────────────────────────
    [/po\s*#|po\s*num|po\s*id|purchase.*order.*#|purch.*ord/i, "po_number",         "high"],
    [/po.*date|purchase.*date|order.*date/i,                "po_date",              "high"],
    [/po.*amount|po.*amt|po.*total|purchase.*amt/i,         "po_amount",            "high"],
    [/vendor.*name|supplier.*name|vendor\b/i,               "vendor_name",          "high"],
    [/vendor.*id|supplier.*id/i,                            "vendor_id",            "high"],
    [/inv.*received|received.*inv|receipt.*date/i,          "invoice_received_date","high"],
    [/payment.*due|pay.*by/i,                               "payment_due_date",     "high"],
    [/amount.*paid|paid.*amt|payment.*made/i,               "amount_paid",          "high"],
    [/price.*po|po.*price/i,                                "unit_price_po",        "medium"],
    [/price.*inv|invoiced.*price/i,                         "unit_price_invoiced",  "medium"],
    [/qty.*ord|ordered.*qty|quantity.*ord/i,                "quantity_ordered",     "high"],
    [/qty.*rec|received.*qty|quantity.*rec/i,               "quantity_received",    "high"],
    [/early.*pay.*cut|cutoff.*days/i,                       "early_pay_cutoff_days","medium"],

    // ── Work Orders / Operations ───────────────────────────────────────────────
    [/order\s*#|order\s*id|work.*order.*#|wo\s*#|wo\s*num/i,"order_id",            "high"],
    [/order.*date|wo.*date/i,                               "order_date",           "high"],
    [/order.*status|wo.*status|job.*status/i,               "order_status",         "high"],
    [/sku|part.*#|part.*num|item.*#|item.*num|product.*#/i, "product_sku",          "high"],
    [/on.*hand|qty.*hand|quantity.*hand|stock\b/i,          "quantity_on_hand",     "high"],
    [/material.*need|mat.*req|components.*needed/i,         "materials_needed",     "medium"],
    [/sched.*ship|planned.*ship|ship.*sched/i,              "scheduled_ship_date",  "high"],
    [/actual.*ship|shipped.*date|ship.*date/i,              "actual_ship_date",     "high"],
    [/finished.*goods|fg\s*qty|finished.*qty/i,             "finished_goods_qty",   "high"],
    [/wip|work.*in.*prog|in.*process.*qty/i,                "work_in_progress_qty", "high"],

    // ── BOM ────────────────────────────────────────────────────────────────────
    [/parent.*part|assembly|parent.*sku/i,                  "product_sku",          "medium"],
    [/component|child.*part|material.*part/i,               "materials_needed",     "medium"],

    // ── Capacity ───────────────────────────────────────────────────────────────
    [/work.*center|machine|resource/i,                      "order_id",             "low"],

    // ── Logistics ─────────────────────────────────────────────────────────────
    [/carrier|shipper|shipping.*co|freight/i,               "carrier",              "high"],
    [/tracking|track.*#|track.*num/i,                       "tracking_number",      "high"],
    [/est.*deliv|expected.*deliv|promised.*deliv/i,         "estimated_delivery",   "high"],
    [/actual.*deliv|delivered|delivery.*date/i,             "actual_delivery",      "high"],
    [/delay.*days|days.*delay|late.*days/i,                 "shipping_delay_days",  "high"],
    [/delay.*reason|reason.*delay|late.*reason/i,           "delay_reason",         "high"],
  ];

/**
 * Maps raw column headers to standard schema fields using pattern matching.
 * Drop-in replacement for the original Claude-powered version — same return shape.
 *
 * @param {string[]} rawHeaders
 * @param {string}   fileContext  (kept for API compatibility, not used)
 * @returns {Promise<Array<{ raw: string, mapped: string, confidence: string, reason: string }>>}
 */
async function mapColumns(rawHeaders, fileContext = "") {
    return rawHeaders.map(raw => {
          const h = raw.trim();

                              for (const [pattern, field, confidence] of PATTERNS) {
                                      if (pattern.test(h)) {
                                                return {
                                                            raw:        h,
                                                            mapped:     field,
                                                            confidence,
                                                            reason:     `Matched pattern for ${field}`,
                                                };
                                      }
                              }

                              // Nothing matched — skip the column
                              return {
                                      raw:        h,
                                      mapped:     "skip",
                                      confidence: "low",
                                      reason:     "No pattern match found",
                              };
    });
}

// ─── Example usage (commented out — runs on every require if left active) ───
// const exampleHeaders = [
//   "Quote #", "Date Sent", "Customer", "Contact", "Product Desc",
//   "Qty", "Unit Price", "Total $", "Result", "Lost Reason",
//   "Days to Close", "Rep", "Notes"
// ];
//
// mapColumns(exampleHeaders, "sales quotes spreadsheet")
//   .then(mappings => {
//     console.log("Column mappings:\n");
//     mappings.forEach(m => {
//       const icon = m.confidence === "high" ? "✓" : m.confidence === "medium" ? "~" : "?";
//       console.log(`  ${icon} "${m.raw}" → ${m.mapped} (${m.confidence})`);
//     });
//   })
//   .catch(err => console.error("Mapping error:", err));

module.exports = { mapColumns, STANDARD_FIELDS };

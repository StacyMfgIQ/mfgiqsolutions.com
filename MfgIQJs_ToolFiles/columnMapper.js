/**
 * SWOT Plugin — Column Mapper
 * Sends raw column headers to Claude API and gets back
 * a structured mapping to standard schema fields.
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
  // Derived aging label (if pre-bucketed in source system)
  "aging_bucket",        // "current" | "net30" | "net60" | "net90" | "over90"
  "days_outstanding",    // numeric — days since due date

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
 * Maps raw column headers from an uploaded file to standard schema fields.
 *
 * @param {string[]} rawHeaders - Array of column names from the user's file
 * @param {string} fileContext - Short description of what the file contains
 *                               e.g. "QuickBooks AR export" or "sales quotes spreadsheet"
 * @returns {Promise<Array<{ raw: string, mapped: string, confidence: "high"|"medium"|"low", reason: string }>>}
 */
async function mapColumns(rawHeaders, fileContext = "manufacturing business data file") {
  const prompt = `You are a data schema mapper for a manufacturing business intelligence tool.

A user has uploaded a ${fileContext} with these column headers:
${rawHeaders.map((h, i) => `${i + 1}. "${h}"`).join("\n")}

Map each column to the closest field from this standard schema:
${STANDARD_FIELDS.join(", ")}

Rules:
- Use "skip" for free-text notes, internal IDs with no analytical value, or duplicates
- Be generous with partial matches (e.g. "Cust Name" → customer_name, "$ Amount" → quote_value)
- Confidence: "high" = obvious match, "medium" = reasonable inference, "low" = uncertain

Respond ONLY with a JSON array. No preamble, no markdown fences. Example format:
[
  { "raw": "Quote #", "mapped": "quote_id", "confidence": "high", "reason": "Direct match" },
  { "raw": "Result", "mapped": "status", "confidence": "high", "reason": "Win/loss/open status field" }
]`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content.map(b => b.text || "").join("").trim();

  try {
    return JSON.parse(text);
  } catch {
    // Strip accidental markdown fences if model slips
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  }
}

// ─── Example usage ───────────────────────────────────────────────────────────

const exampleHeaders = [
  "Quote #", "Date Sent", "Customer", "Contact", "Product Desc",
  "Qty", "Unit Price", "Total $", "Result", "Lost Reason",
  "Days to Close", "Rep", "Notes"
];

mapColumns(exampleHeaders, "sales quotes spreadsheet")
  .then(mappings => {
    console.log("Column mappings:\n");
    mappings.forEach(m => {
      const icon = m.confidence === "high" ? "✓" : m.confidence === "medium" ? "~" : "?";
      console.log(`  ${icon} "${m.raw}" → ${m.mapped} (${m.confidence})`);
      if (m.confidence !== "high") console.log(`      reason: ${m.reason}`);
    });
  })
  .catch(err => console.error("Mapping error:", err));

module.exports = { mapColumns, STANDARD_FIELDS };

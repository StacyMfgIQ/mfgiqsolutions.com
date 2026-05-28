/**
 * SWOT Plugin — Analysis Engine
 * Takes normalized, mapped records and runs them through
 * Claude to produce a structured, data-grounded SWOT report.
 */

const { buildFinanceSummary } = require('./financeModule');
const { buildERPSummary }     = require('./erpModule');
// Ingestion orchestrator produces the DataBundle that feeds this engine:
// const { ingestFiles } = require('./ingestionOrchestrator');

/**
 * Runs a full SWOT analysis on normalized manufacturing data.
 *
 * @param {Object} dataBundle - Keyed sections of normalized data
 * @param {Object[]} [dataBundle.sales]      - CRM / quote records
 * @param {Object[]} [dataBundle.ar]         - AR invoice records
 * @param {Object[]} [dataBundle.ap]         - AP / purchasing records
 * @param {Object[]} [dataBundle.workOrders] - ERP work order records
 * @param {Object[]} [dataBundle.bom]        - Bill of materials records
 * @param {Object[]} [dataBundle.inventory]  - Inventory / warehouse records
 * @param {Object[]} [dataBundle.capacity]   - Work center capacity records
 * @param {Object[]} [dataBundle.quality]    - Quality / scrap records
 * @param {Object[]} [dataBundle.deliveries] - On-time delivery records
 * @param {Object[]} [dataBundle.logistics]  - Shipping / carrier records
 * @param {Date}     [dataBundle.asOfDate]   - Reference date for aging calculations
 * @param {Object}   [options]
 * @param {number}   [options.topN=3]        - Max findings per quadrant
 * @param {string}   [options.companyName]   - Optional company name for context
 * @returns {Promise<SWOTResult>}
 */
async function runSWOTAnalysis(dataBundle, options = {}) {
  const { topN = 3, companyName = "the company" } = options;

  const sections = buildDataSummary(dataBundle);

  const prompt = `You are a business intelligence analyst specializing in local manufacturing companies.

Analyze the following operational data for ${companyName} and produce a SWOT analysis.
Focus on specific, numeric, actionable findings — not generic observations.
Every finding must reference actual numbers or patterns from the data.

${sections}

Return ONLY a JSON object in this exact structure (no preamble, no markdown):
{
  "strengths": [
    { "finding": "...", "metric": "...", "source": "sales|finance|operations|logistics" }
  ],
  "weaknesses": [
    { "finding": "...", "metric": "...", "source": "..." }
  ],
  "opportunities": [
    { "finding": "...", "metric": "...", "source": "..." }
  ],
  "threats": [
    { "finding": "...", "metric": "...", "source": "..." }
  ],
  "summary": "2-3 sentence executive summary of the most critical finding.",
  "top_priority": "Single most important action the company should take this week."
}

Rules:
- Limit each quadrant to ${topN} findings maximum
- "finding" = what is happening (plain English, 1 sentence)
- "metric" = the specific number or ratio that supports it
- Strengths = things performing well relative to norms
- Weaknesses = internal gaps, inefficiencies, or underperformance
- Opportunities = addressable gaps, untapped segments, quick wins
- Threats = risks, concentrations, competitive signals, expiring items`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content.map(b => b.text || "").join("").trim();

  try {
    return JSON.parse(text);
  } catch {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  }
}

/**
 * Converts raw data arrays into concise text summaries for the prompt.
 * Keeps token usage lean by sending stats, not raw rows.
 */
function buildDataSummary(dataBundle) {
  const parts = [];

  if (dataBundle.sales?.length) {
    const s = dataBundle.sales;
    const won     = s.filter(r => r.status?.toLowerCase().includes("won")).length;
    const lost    = s.filter(r => r.status?.toLowerCase().includes("lost")).length;
    const expired = s.filter(r => r.status?.toLowerCase().includes("expired")).length;
    const total   = s.length;
    const convRate = total ? ((won / total) * 100).toFixed(1) : 0;

    const reasonCounts = {};
    s.forEach(r => {
      if (r.win_loss_reason) {
        const k = r.win_loss_reason.toLowerCase().trim();
        reasonCounts[k] = (reasonCounts[k] || 0) + 1;
      }
    });
    const topReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `"${k}" (${v})`)
      .join(", ");

    const repPerf = {};
    s.forEach(r => {
      if (!r.sales_rep_id) return;
      if (!repPerf[r.sales_rep_id]) repPerf[r.sales_rep_id] = { won: 0, total: 0 };
      repPerf[r.sales_rep_id].total++;
      if (r.status?.toLowerCase().includes("won")) repPerf[r.sales_rep_id].won++;
    });
    const repSummary = Object.entries(repPerf)
      .map(([rep, d]) => `${rep}: ${((d.won/d.total)*100).toFixed(0)}% (${d.total} quotes)`)
      .join(", ");

    const productPerf = {};
    s.forEach(r => {
      if (!r.product_line) return;
      if (!productPerf[r.product_line]) productPerf[r.product_line] = { won: 0, total: 0 };
      productPerf[r.product_line].total++;
      if (r.status?.toLowerCase().includes("won")) productPerf[r.product_line].won++;
    });
    const productSummary = Object.entries(productPerf)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 6)
      .map(([p, d]) => `${p}: ${((d.won/d.total)*100).toFixed(0)}% win rate (${d.total} quotes)`)
      .join(", ");

    const avgDays = s.filter(r => r.quote_to_close_days > 0)
      .reduce((sum, r, _, arr) => sum + r.quote_to_close_days / arr.length, 0)
      .toFixed(1);

    parts.push(`## SALES DATA (${total} quotes)
- Win/loss/expired: ${won} won, ${lost} lost, ${expired} expired
- Overall conversion rate: ${convRate}%
- Avg days to close: ${avgDays}
- Loss reasons: ${topReasons || "not recorded"}
- By rep: ${repSummary || "not available"}
- By product line: ${productSummary || "not available"}`);
  }

  // Finance: use the dedicated finance module for full AR/AP aging + discrepancy analysis
  if (dataBundle.ar?.length || dataBundle.ap?.length || dataBundle.finance?.length) {
    const financeSummary = buildFinanceSummary({
      arRecords:  dataBundle.ar      || dataBundle.finance || [],
      apRecords:  dataBundle.ap      || [],
      asOfDate:   dataBundle.asOfDate || new Date(),
    });
    parts.push(financeSummary);
  }

  // ERP: work orders, BOM/MRP, capacity, quality, on-time delivery
  const hasERP = dataBundle.workOrders?.length || dataBundle.bom?.length ||
                 dataBundle.inventory?.length  || dataBundle.capacity?.length ||
                 dataBundle.quality?.length    || dataBundle.deliveries?.length;
  if (hasERP) {
    const erpSummary = buildERPSummary({
      workOrders: dataBundle.workOrders || [],
      bom:        dataBundle.bom        || [],
      inventory:  dataBundle.inventory  || [],
      capacity:   dataBundle.capacity   || [],
      quality:    dataBundle.quality    || [],
      deliveries: dataBundle.deliveries || [],
      asOfDate:   dataBundle.asOfDate   || new Date(),
    });
    parts.push(erpSummary);
  }

  // Legacy operations fallback (if using old flat operations array)
  if (!hasERP && dataBundle.operations?.length) {
    const o = dataBundle.operations;
    const shortfalls = o.filter(r =>
      (r.quantity_ordered || 0) > (r.quantity_on_hand || 0) + (r.work_in_progress_qty || 0)
    );
    const readyToShip = o.filter(r => r.order_status?.toLowerCase() === "ready");

    parts.push(`## OPERATIONS DATA (${o.length} open orders)
- Orders with materials shortfall: ${shortfalls.length}
- Orders ready to ship: ${readyToShip.length}
- Total orders in progress: ${o.filter(r => r.order_status?.toLowerCase() === "in progress").length}`);
  } // end legacy operations

  if (dataBundle.logistics?.length) {
    const l = dataBundle.logistics;
    const delayed = l.filter(r => (r.shipping_delay_days || 0) > 0);
    const avgDelay = delayed.length
      ? (delayed.reduce((s, r) => s + r.shipping_delay_days, 0) / delayed.length).toFixed(1)
      : 0;
    const delayCauses = {};
    delayed.forEach(r => {
      if (r.delay_reason) {
        const k = r.delay_reason.toLowerCase().trim();
        delayCauses[k] = (delayCauses[k] || 0) + 1;
      }
    });
    const topCauses = Object.entries(delayCauses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `"${k}" (${v})`)
      .join(", ");

    parts.push(`## LOGISTICS DATA (${l.length} shipments)
- Delayed shipments: ${delayed.length} of ${l.length} (${((delayed.length/l.length)*100).toFixed(0)}%)
- Avg delay: ${avgDelay} days
- Top delay causes: ${topCauses || "not recorded"}`);
  }

  return parts.join("\n\n");
}

// ─── Example usage ───────────────────────────────────────────────────────────

const sampleData = {
  sales: [
    { status: "Won",     product_line: "Hydraulic Fittings", sales_rep_id: "T.Kowalski", quote_to_close_days: 12, win_loss_reason: "" },
    { status: "Lost",    product_line: "Custom Fabrication",  sales_rep_id: "R.Chen",     quote_to_close_days: 38, win_loss_reason: "Price" },
    { status: "Lost",    product_line: "Custom Fabrication",  sales_rep_id: "T.Kowalski", quote_to_close_days: 41, win_loss_reason: "Lead time" },
    { status: "Won",     product_line: "Hydraulic Fittings", sales_rep_id: "R.Chen",     quote_to_close_days: 15, win_loss_reason: "" },
    { status: "Expired", product_line: "Sheet Metal",         sales_rep_id: "R.Chen",     quote_to_close_days: 60, win_loss_reason: "" },
    { status: "Won",     product_line: "Sheet Metal",         sales_rep_id: "T.Kowalski", quote_to_close_days: 18, win_loss_reason: "" },
    { status: "Lost",    product_line: "Custom Fabrication",  sales_rep_id: "R.Chen",     quote_to_close_days: 29, win_loss_reason: "Price" },
    { status: "Won",     product_line: "Hydraulic Fittings", sales_rep_id: "T.Kowalski", quote_to_close_days: 10, win_loss_reason: "" },
  ],
  finance: [
    { invoice_id: "INV-001", balance_due: 12400, days_overdue: 0  },
    { invoice_id: "INV-002", balance_due: 8750,  days_overdue: 45 },
    { invoice_id: "INV-003", balance_due: 3200,  days_overdue: 0  },
    { invoice_id: "INV-004", balance_due: 5500,  days_overdue: 62 },
    { invoice_id: "INV-005", invoice_amount: 9800, payment_amount: 9500, balance_due: 300, days_overdue: 0 },
  ],
  operations: [
    { order_id: "ORD-101", order_status: "In Progress", quantity_ordered: 200, quantity_on_hand: 180 },
    { order_id: "ORD-102", order_status: "In Progress", quantity_ordered: 500, quantity_on_hand: 120 },
    { order_id: "ORD-103", order_status: "Ready",       quantity_ordered: 50,  quantity_on_hand: 75  },
  ],
  logistics: [
    { shipping_delay_days: 0,  delay_reason: "" },
    { shipping_delay_days: 7,  delay_reason: "Carrier backlog" },
    { shipping_delay_days: 12, delay_reason: "Materials late" },
    { shipping_delay_days: 0,  delay_reason: "" },
    { shipping_delay_days: 4,  delay_reason: "Carrier backlog" },
  ]
};

runSWOTAnalysis(sampleData, { companyName: "Acme Precision Mfg", topN: 3 })
  .then(result => {
    console.log("\n=== SWOT ANALYSIS ===\n");
    console.log("SUMMARY:", result.summary);
    console.log("TOP PRIORITY:", result.top_priority);
    ["strengths","weaknesses","opportunities","threats"].forEach(q => {
      console.log(`\n${q.toUpperCase()}:`);
      result[q].forEach(f => console.log(`  • ${f.finding} [${f.metric}]`));
    });
  })
  .catch(err => console.error("Analysis error:", err));

module.exports = { runSWOTAnalysis, buildDataSummary };

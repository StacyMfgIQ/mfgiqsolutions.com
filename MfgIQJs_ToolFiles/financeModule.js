/**
 * SWOT Plugin — Finance Module
 * AR and AP aging analysis with Net 30 / 60 / 90 and past-due bucketing.
 * Produces a structured summary ready for the SWOT engine.
 *
 * Usage:
 *   const { buildFinanceSummary, classifyAging, computeARSummary, computeAPSummary } = require('./financeModule');
 *   const summary = buildFinanceSummary({ arRecords, apRecords, asOfDate });
 */

// ─── Aging bucket definitions ─────────────────────────────────────────────────

const AGING_BUCKETS = [
  { key: "current",       label: "Current (not yet due)",  minDays: null, maxDays: 0   },
  { key: "net30",         label: "Net 30 (1–30 days)",     minDays: 1,    maxDays: 30  },
  { key: "net60",         label: "Net 60 (31–60 days)",    minDays: 31,   maxDays: 60  },
  { key: "net90",         label: "Net 90 (61–90 days)",    minDays: 61,   maxDays: 90  },
  { key: "over90",        label: "Over 90 days",           minDays: 91,   maxDays: null},
];

/**
 * Classify a single record into an aging bucket.
 *
 * @param {Object}      record
 * @param {string|Date} record.due_date        - When payment was/is due
 * @param {string|Date} [record.payment_date]  - Actual payment date (null = unpaid)
 * @param {string|Date} [asOfDate]             - Reference date (defaults to today)
 * @returns {{ bucket: string, label: string, daysOutstanding: number, isPastDue: boolean }}
 */
function classifyAging(record, asOfDate = new Date()) {
  const ref     = new Date(asOfDate);
  const due     = new Date(record.due_date);
  const paid    = record.payment_date ? new Date(record.payment_date) : null;

  // For paid invoices, measure from due date to payment date (late payment detection)
  // For unpaid invoices, measure from due date to today
  const measureTo = paid || ref;
  const daysOutstanding = Math.floor((measureTo - due) / (1000 * 60 * 60 * 24));
  const isPastDue = !paid && daysOutstanding > 0;

  let bucket = AGING_BUCKETS[0]; // default: current
  for (const b of AGING_BUCKETS) {
    const aboveMin = b.minDays === null || daysOutstanding >= b.minDays;
    const belowMax = b.maxDays === null || daysOutstanding <= b.maxDays;
    if (aboveMin && belowMax) { bucket = b; break; }
  }

  return {
    bucket:          bucket.key,
    label:           bucket.label,
    daysOutstanding: Math.max(0, daysOutstanding),
    isPastDue,
  };
}

// ─── AR Summary ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ARRecord
 * @property {string}  invoice_id
 * @property {string}  customer_id
 * @property {string}  customer_name
 * @property {string}  invoice_date
 * @property {string}  due_date
 * @property {number}  invoice_amount
 * @property {number}  [payment_amount]    - Partial or full payment received
 * @property {string}  [payment_date]      - Date payment was received
 * @property {string}  [payment_terms]     - e.g. "Net 30", "Net 60", "2/10 Net 30"
 * @property {number}  [early_pay_discount_pct] - e.g. 2 for a 2% early pay discount
 */

/**
 * Compute a full AR aging summary from a list of AR records.
 *
 * @param {ARRecord[]} records
 * @param {Date|string} [asOfDate]
 * @returns {ARSummary}
 */
function computeARSummary(records, asOfDate = new Date()) {
  const summary = {
    totalRecords:   records.length,
    totalInvoiced:  0,
    totalCollected: 0,
    totalOutstanding: 0,
    buckets: {
      current: { count: 0, amount: 0, records: [] },
      net30:   { count: 0, amount: 0, records: [] },
      net60:   { count: 0, amount: 0, records: [] },
      net90:   { count: 0, amount: 0, records: [] },
      over90:  { count: 0, amount: 0, records: [] },
    },
    pastDueTotal:       0,
    pastDueCount:       0,
    dsoAvg:             0,    // Days Sales Outstanding (average across paid invoices)
    earlyPayOpportunity: 0,   // $ available if all early-pay discounts captured
    discrepancies:      [],   // Invoice vs payment amount mismatches
    slowPayCustomers:   [],   // Customers trending past their terms
    topExposures:       [],   // Largest single outstanding balances
  };

  const dsoSamples = [];

  records.forEach(r => {
    const invoiceAmt  = Number(r.invoice_amount)  || 0;
    const paymentAmt  = Number(r.payment_amount)  || 0;
    const balance     = invoiceAmt - paymentAmt;
    const aging       = classifyAging(r, asOfDate);

    summary.totalInvoiced   += invoiceAmt;
    summary.totalCollected  += paymentAmt;
    summary.totalOutstanding += balance;

    // Bucket assignment (use balance remaining, not full invoice)
    const bkt = summary.buckets[aging.bucket];
    bkt.count++;
    bkt.amount += balance;
    bkt.records.push({ ...r, aging });

    if (aging.isPastDue) {
      summary.pastDueTotal += balance;
      summary.pastDueCount++;
    }

    // DSO calculation (only for fully paid invoices)
    if (r.payment_date && paymentAmt >= invoiceAmt * 0.99) {
      dsoSamples.push(aging.daysOutstanding);
    }

    // Early pay discount opportunity
    if (r.early_pay_discount_pct && balance > 0) {
      summary.earlyPayOpportunity += balance * (Number(r.early_pay_discount_pct) / 100);
    }

    // Discrepancy detection: paid but amount doesn't match
    if (r.payment_date && paymentAmt > 0 && Math.abs(invoiceAmt - paymentAmt) > 0.01) {
      summary.discrepancies.push({
        invoice_id:    r.invoice_id,
        customer_name: r.customer_name,
        invoiced:      invoiceAmt,
        paid:          paymentAmt,
        gap:           invoiceAmt - paymentAmt,
        type:          paymentAmt < invoiceAmt ? "underpayment" : "overpayment",
      });
    }
  });

  // DSO average
  if (dsoSamples.length > 0) {
    summary.dsoAvg = Math.round(dsoSamples.reduce((a, b) => a + b, 0) / dsoSamples.length);
  }

  // Slow-pay customers: group by customer, flag those averaging past their terms
  const customerMap = {};
  records.forEach(r => {
    const key = r.customer_id || r.customer_name || "unknown";
    if (!customerMap[key]) {
      customerMap[key] = { name: r.customer_name || key, invoices: [], totalOutstanding: 0 };
    }
    const aging = classifyAging(r, asOfDate);
    customerMap[key].invoices.push(aging.daysOutstanding);
    if (aging.isPastDue) customerMap[key].totalOutstanding += (Number(r.invoice_amount) - Number(r.payment_amount || 0));
  });

  summary.slowPayCustomers = Object.values(customerMap)
    .map(c => ({
      name:            c.name,
      avgDaysToCollect: Math.round(c.invoices.reduce((a, b) => a + b, 0) / c.invoices.length),
      totalOutstanding: c.totalOutstanding,
      invoiceCount:    c.invoices.length,
    }))
    .filter(c => c.avgDaysToCollect > 30)
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding)
    .slice(0, 5);

  // Top exposures: largest single outstanding balances
  summary.topExposures = records
    .map(r => ({
      invoice_id:    r.invoice_id,
      customer_name: r.customer_name,
      balance:       Number(r.invoice_amount) - Number(r.payment_amount || 0),
      aging:         classifyAging(r, asOfDate),
    }))
    .filter(r => r.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5);

  return summary;
}

// ─── AP Summary ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} APRecord
 * @property {string}  po_number
 * @property {string}  vendor_name
 * @property {string}  po_date
 * @property {number}  po_amount
 * @property {string}  [invoice_received_date]
 * @property {number}  [invoice_amount]         - What vendor billed
 * @property {string}  [payment_terms]          - "Net 30", "Net 60", "2/10 Net 30"
 * @property {string}  [payment_due_date]
 * @property {string}  [payment_date]
 * @property {number}  [amount_paid]
 * @property {number}  [quantity_ordered]
 * @property {number}  [quantity_received]
 * @property {number}  [unit_price_po]          - Price on PO
 * @property {number}  [unit_price_invoiced]    - Price on vendor invoice
 * @property {number}  [early_pay_discount_pct]
 * @property {number}  [early_pay_cutoff_days]  - Days within which discount applies
 */

/**
 * Compute a full AP aging summary and discrepancy report.
 *
 * @param {APRecord[]} records
 * @param {Date|string} [asOfDate]
 * @returns {APSummary}
 */
function computeAPSummary(records, asOfDate = new Date()) {
  const summary = {
    totalRecords:       records.length,
    totalOrdered:       0,
    totalInvoiced:      0,
    totalPaid:          0,
    totalOutstanding:   0,
    buckets: {
      current: { count: 0, amount: 0 },
      net30:   { count: 0, amount: 0 },
      net60:   { count: 0, amount: 0 },
      net90:   { count: 0, amount: 0 },
      over90:  { count: 0, amount: 0 },
    },
    pastDueTotal:           0,
    pastDueCount:           0,
    priceDiscrepancies:     [],  // PO price vs invoice price mismatches
    quantityDiscrepancies:  [],  // Ordered vs received mismatches
    duplicateRisk:          [],  // Same vendor + amount within 30 days
    earlyPayOpportunity:    0,   // $ savings available from early pay
    topVendorExposures:     [],  // Largest outstanding AP balances
  };

  records.forEach(r => {
    const poAmt       = Number(r.po_amount)      || 0;
    const invoiceAmt  = Number(r.invoice_amount) || 0;
    const paidAmt     = Number(r.amount_paid)    || 0;
    const balance     = (invoiceAmt || poAmt) - paidAmt;

    summary.totalOrdered      += poAmt;
    summary.totalInvoiced     += invoiceAmt;
    summary.totalPaid         += paidAmt;
    summary.totalOutstanding  += Math.max(0, balance);

    // Aging bucket (based on payment_due_date)
    if (r.payment_due_date) {
      const aging = classifyAging(
        { due_date: r.payment_due_date, payment_date: r.payment_date },
        asOfDate
      );
      const bkt = summary.buckets[aging.bucket];
      bkt.count++;
      bkt.amount += Math.max(0, balance);

      if (aging.isPastDue) {
        summary.pastDueTotal += Math.max(0, balance);
        summary.pastDueCount++;
      }
    }

    // Price discrepancy: PO unit price vs invoice unit price
    if (r.unit_price_po && r.unit_price_invoiced) {
      const poPx = Number(r.unit_price_po);
      const invPx = Number(r.unit_price_invoiced);
      const pctDiff = Math.abs((invPx - poPx) / poPx) * 100;
      if (pctDiff > 0.5) { // flag anything over 0.5% variance
        summary.priceDiscrepancies.push({
          po_number:    r.po_number,
          vendor_name:  r.vendor_name,
          po_price:     poPx,
          invoice_price: invPx,
          variance_pct: pctDiff.toFixed(1),
          impact:       ((invPx - poPx) * (Number(r.quantity_ordered) || 1)).toFixed(2),
          overcharge:   invPx > poPx,
        });
      }
    }

    // Quantity discrepancy: ordered vs received
    if (r.quantity_ordered && r.quantity_received !== undefined) {
      const ordered  = Number(r.quantity_ordered);
      const received = Number(r.quantity_received);
      if (Math.abs(ordered - received) > 0) {
        summary.quantityDiscrepancies.push({
          po_number:   r.po_number,
          vendor_name: r.vendor_name,
          ordered,
          received,
          shortfall:   ordered - received,
          type:        received < ordered ? "short_ship" : "over_ship",
        });
      }
    }

    // Early pay opportunity
    if (r.early_pay_discount_pct && balance > 0) {
      const cutoffDays = Number(r.early_pay_cutoff_days) || 10;
      const poDate     = new Date(r.po_date);
      const daysElapsed = Math.floor((new Date(asOfDate) - poDate) / (1000 * 60 * 60 * 24));
      if (daysElapsed <= cutoffDays) {
        summary.earlyPayOpportunity += balance * (Number(r.early_pay_discount_pct) / 100);
      }
    }
  });

  // Duplicate invoice detection: same vendor + same amount within 30 days
  const sorted = [...records].sort((a, b) => new Date(a.invoice_received_date) - new Date(b.invoice_received_date));
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (!a.vendor_name || a.vendor_name !== b.vendor_name) continue;
    const amtMatch = Math.abs(Number(a.invoice_amount) - Number(b.invoice_amount)) < 0.01;
    if (!amtMatch) continue;
    const daysBetween = Math.abs(
      (new Date(b.invoice_received_date) - new Date(a.invoice_received_date)) / (1000 * 60 * 60 * 24)
    );
    if (daysBetween <= 30) {
      summary.duplicateRisk.push({
        vendor_name: a.vendor_name,
        amount:      Number(a.invoice_amount),
        date_a:      a.invoice_received_date,
        date_b:      b.invoice_received_date,
        days_apart:  Math.round(daysBetween),
      });
    }
  }

  // Top vendor exposures
  const vendorMap = {};
  records.forEach(r => {
    const key = r.vendor_name || "unknown";
    if (!vendorMap[key]) vendorMap[key] = { name: key, outstanding: 0 };
    vendorMap[key].outstanding += Math.max(0, (Number(r.invoice_amount) || Number(r.po_amount) || 0) - (Number(r.amount_paid) || 0));
  });
  summary.topVendorExposures = Object.values(vendorMap)
    .sort((a, b) => b.outstanding - a.outstanding)
    .slice(0, 5);

  return summary;
}

// ─── Prompt builder for SWOT engine ──────────────────────────────────────────

/**
 * Builds the finance section text for the SWOT analysis prompt.
 * Called by swotEngine.js buildDataSummary().
 *
 * @param {{ arRecords: ARRecord[], apRecords: APRecord[], asOfDate?: Date }} params
 * @returns {string}
 */
function buildFinanceSummary({ arRecords = [], apRecords = [], asOfDate = new Date() }) {
  const parts = [];

  // ── AR ──
  if (arRecords.length > 0) {
    const ar = computeARSummary(arRecords, asOfDate);
    const fmt = n => "$" + Math.round(n).toLocaleString();

    parts.push(`## ACCOUNTS RECEIVABLE (${ar.totalRecords} invoices as of ${new Date(asOfDate).toDateString()})

AGING BUCKETS (outstanding balances):
  Current (not yet due):  ${ar.buckets.current.count} invoices · ${fmt(ar.buckets.current.amount)}
  Net 30  (1–30 days):    ${ar.buckets.net30.count} invoices · ${fmt(ar.buckets.net30.amount)}
  Net 60  (31–60 days):   ${ar.buckets.net60.count} invoices · ${fmt(ar.buckets.net60.amount)}
  Net 90  (61–90 days):   ${ar.buckets.net90.count} invoices · ${fmt(ar.buckets.net90.amount)}
  Over 90 days:           ${ar.buckets.over90.count} invoices · ${fmt(ar.buckets.over90.amount)}

SUMMARY METRICS:
  Total invoiced:    ${fmt(ar.totalInvoiced)}
  Total collected:   ${fmt(ar.totalCollected)}
  Total outstanding: ${fmt(ar.totalOutstanding)}
  Past-due total:    ${fmt(ar.pastDueTotal)} across ${ar.pastDueCount} invoices
  Avg DSO:           ${ar.dsoAvg} days
  Early-pay $ left:  ${fmt(ar.earlyPayOpportunity)} uncaptured discounts

${ar.slowPayCustomers.length > 0 ? `SLOW-PAY CUSTOMERS:
${ar.slowPayCustomers.map(c =>
  `  ${c.name}: avg ${c.avgDaysToCollect} days to collect · ${fmt(c.totalOutstanding)} outstanding`
).join("\n")}` : ""}

${ar.discrepancies.length > 0 ? `PAYMENT DISCREPANCIES (${ar.discrepancies.length} found):
${ar.discrepancies.map(d =>
  `  ${d.invoice_id} · ${d.customer_name}: invoiced ${fmt(d.invoiced)}, paid ${fmt(d.paid)} · gap ${fmt(Math.abs(d.gap))} (${d.type})`
).join("\n")}` : "No payment discrepancies detected."}

TOP 5 OUTSTANDING BALANCES:
${ar.topExposures.map(e =>
  `  ${e.invoice_id} · ${e.customer_name}: ${fmt(e.balance)} · ${e.aging.label}`
).join("\n")}`);
  }

  // ── AP ──
  if (apRecords.length > 0) {
    const ap = computeAPSummary(apRecords, asOfDate);
    const fmt = n => "$" + Math.round(n).toLocaleString();

    parts.push(`## ACCOUNTS PAYABLE (${ap.totalRecords} POs/invoices)

AGING BUCKETS (what we owe):
  Current (not yet due):  ${ap.buckets.current.count} · ${fmt(ap.buckets.current.amount)}
  Net 30  (1–30 days):    ${ap.buckets.net30.count} · ${fmt(ap.buckets.net30.amount)}
  Net 60  (31–60 days):   ${ap.buckets.net60.count} · ${fmt(ap.buckets.net60.amount)}
  Net 90  (61–90 days):   ${ap.buckets.net90.count} · ${fmt(ap.buckets.net90.amount)}
  Over 90 days:           ${ap.buckets.over90.count} · ${fmt(ap.buckets.over90.amount)}

SUMMARY METRICS:
  Total PO value:      ${fmt(ap.totalOrdered)}
  Total invoiced by vendors: ${fmt(ap.totalInvoiced)}
  Total paid:          ${fmt(ap.totalPaid)}
  Total outstanding:   ${fmt(ap.totalOutstanding)}
  Past-due total:      ${fmt(ap.pastDueTotal)} across ${ap.pastDueCount} invoices
  Early-pay savings avail: ${fmt(ap.earlyPayOpportunity)}

${ap.priceDiscrepancies.length > 0 ? `PRICE DISCREPANCIES — vendor billed above PO (${ap.priceDiscrepancies.length}):
${ap.priceDiscrepancies.map(d =>
  `  PO ${d.po_number} · ${d.vendor_name}: PO price $${d.po_price} vs invoiced $${d.invoice_price} · ${d.variance_pct}% variance · $${d.impact} impact`
).join("\n")}` : "No price discrepancies detected."}

${ap.quantityDiscrepancies.length > 0 ? `QUANTITY DISCREPANCIES (${ap.quantityDiscrepancies.length}):
${ap.quantityDiscrepancies.map(d =>
  `  PO ${d.po_number} · ${d.vendor_name}: ordered ${d.ordered}, received ${d.received} · ${Math.abs(d.shortfall)} unit ${d.type}`
).join("\n")}` : "No quantity discrepancies detected."}

${ap.duplicateRisk.length > 0 ? `DUPLICATE INVOICE RISK (${ap.duplicateRisk.length} pairs):
${ap.duplicateRisk.map(d =>
  `  ${d.vendor_name}: $${d.amount} appears twice (${d.days_apart} days apart)`
).join("\n")}` : "No duplicate invoice risk detected."}`);
  }

  return parts.join("\n\n");
}

// ─── Example usage ────────────────────────────────────────────────────────────

const today = new Date("2024-04-08");

const sampleAR = [
  { invoice_id:"INV-001", customer_name:"Midwest Tooling",    invoice_date:"2024-02-01", due_date:"2024-03-02", invoice_amount:8700,  payment_amount:0,    payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-002", customer_name:"Great Lakes Mfg",    invoice_date:"2024-02-15", due_date:"2024-03-16", invoice_amount:5500,  payment_amount:0,    payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-003", customer_name:"Precision Parts Co", invoice_date:"2024-03-01", due_date:"2024-03-31", invoice_amount:12400, payment_amount:12400,payment_date:"2024-03-28", payment_terms:"Net 30" },
  { invoice_id:"INV-004", customer_name:"Midwest Tooling",    invoice_date:"2024-03-10", due_date:"2024-04-09", invoice_amount:3200,  payment_amount:0,    payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-005", customer_name:"Apex Assemblies",    invoice_date:"2024-01-15", due_date:"2024-02-14", invoice_amount:9800,  payment_amount:9500, payment_date:"2024-03-01", payment_terms:"Net 30", early_pay_discount_pct:2 },
  { invoice_id:"INV-006", customer_name:"Great Lakes Mfg",    invoice_date:"2024-01-01", due_date:"2024-01-31", invoice_amount:6200,  payment_amount:0,    payment_date:null,         payment_terms:"Net 30" },
];

const sampleAP = [
  { po_number:"PO-101", vendor_name:"Steel Supply Co",   po_date:"2024-03-01", po_amount:4200,  invoice_amount:4620,  payment_due_date:"2024-04-01", amount_paid:0,    unit_price_po:4.20, unit_price_invoiced:4.62, quantity_ordered:1000, quantity_received:1000, early_pay_discount_pct:2, early_pay_cutoff_days:10 },
  { po_number:"PO-102", vendor_name:"Fastener World",    po_date:"2024-03-05", po_amount:1800,  invoice_amount:1800,  payment_due_date:"2024-04-04", amount_paid:1800, unit_price_po:0.36, unit_price_invoiced:0.36, quantity_ordered:5000, quantity_received:5000 },
  { po_number:"PO-103", vendor_name:"Metal Fab Supply",  po_date:"2024-02-15", po_amount:7500,  invoice_amount:7500,  payment_due_date:"2024-03-16", amount_paid:0,    quantity_ordered:300, quantity_received:270 },
  { po_number:"PO-104", vendor_name:"Coastal Coatings",  po_date:"2024-03-20", po_amount:2100,  invoice_amount:2100,  payment_due_date:"2024-04-19", amount_paid:0 },
  { po_number:"PO-105", vendor_name:"Steel Supply Co",   po_date:"2024-03-01", po_amount:4200,  invoice_amount:4620,  invoice_received_date:"2024-03-10", payment_due_date:"2024-04-01", amount_paid:0 },
  { po_number:"PO-106", vendor_name:"Steel Supply Co",   po_date:"2024-03-01", po_amount:4200,  invoice_amount:4620,  invoice_received_date:"2024-03-22", payment_due_date:"2024-04-01", amount_paid:0 },
];

const summaryText = buildFinanceSummary({ arRecords: sampleAR, apRecords: sampleAP, asOfDate: today });
console.log(summaryText);

module.exports = { buildFinanceSummary, computeARSummary, computeAPSummary, classifyAging, AGING_BUCKETS };

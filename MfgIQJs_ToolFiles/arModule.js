/**
 * SWOT Plugin — AR Discrepancy & Collections Intelligence Module
 *
 * Detects and surfaces every category of AR issue:
 *   1. Payment discrepancies   — underpayments, overpayments, duplicate invoices
 *   2. Aging bucket analysis   — Net 30 / 60 / 90 / past due with dollar exposure
 *   3. Timing drift detection  — customers paying slower quarter-over-quarter
 *   4. DSO benchmarking        — days sales outstanding vs industry norm
 *   5. Early-pay opportunity   — uncaptured discount value
 *   6. Concentration risk      — single customer AR exposure
 *   7. Cross-domain flags      — customers who are both AR risk AND active pipeline
 *
 * Usage:
 *   const { analyzeAR, buildARSummary } = require('./arModule');
 *   const summary = buildARSummary(arRecords, salesRecords, { asOfDate });
 */

// ─── Industry benchmarks ──────────────────────────────────────────────────────

const AR_BENCHMARKS = {
  dso: {
    excellent: 30,   // days sales outstanding
    good:      38,
    warning:   50,
    critical:  65,
  },
  pastDuePct: {
    good:    10,    // % of AR that is past due
    warning: 25,
    critical: 40,
  },
  over90Pct: {
    good:    5,     // % of AR that is over 90 days
    warning: 12,
    critical: 20,
  },
  termsDriftDays: 15,   // how many days over terms before flagging drift
  discrepancyMinGap: 0.01, // minimum $ gap to flag as discrepancy
};

// ─── Main analyzer ────────────────────────────────────────────────────────────

/**
 * @param {ARRecord[]}    arRecords
 * @param {SalesRecord[]} [salesRecords]  - optional, enables cross-domain analysis
 * @param {Object}        [options]
 * @param {Date|string}   [options.asOfDate]
 * @param {Object}        [options.benchmarks]
 * @returns {ARAnalysis}
 */
function analyzeAR(arRecords, salesRecords = [], options = {}) {
  const now        = new Date(options.asOfDate || new Date());
  const benchmarks = { ...AR_BENCHMARKS, ...(options.benchmarks || {}) };

  if (!arRecords.length) return emptyAnalysis();

  // ── 1. Classify every invoice into an aging bucket ────────────────────────
  const classified = arRecords.map(r => ({
    ...r,
    _aging: classifyAging(r, now),
    _balance: computeBalance(r),
  }));

  // ── 2. Build aging summary ────────────────────────────────────────────────
  const aging = buildAgingBuckets(classified);

  // ── 3. Detect payment discrepancies ───────────────────────────────────────
  const discrepancies = detectDiscrepancies(classified, benchmarks);

  // ── 4. Detect duplicate invoices ─────────────────────────────────────────
  const duplicates = detectDuplicates(arRecords);

  // ── 5. Customer-level analysis ────────────────────────────────────────────
  const customerProfiles = buildCustomerProfiles(classified, now, benchmarks);

  // ── 6. DSO calculation ────────────────────────────────────────────────────
  const dso = computeDSO(classified, now);

  // ── 7. Early-pay opportunity ──────────────────────────────────────────────
  const earlyPayOpportunity = computeEarlyPayOpportunity(classified, now);

  // ── 8. Concentration risk ─────────────────────────────────────────────────
  const concentrationRisk = computeConcentrationRisk(classified);

  // ── 9. Cross-domain: AR risk + active pipeline ───────────────────────────
  const crossDomainFlags = salesRecords.length
    ? detectCrossDomainRisk(customerProfiles, salesRecords)
    : [];

  // ── 10. Benchmark scores ──────────────────────────────────────────────────
  const benchmarkScores = scoreBenchmarks(aging, dso, benchmarks);

  // ── 11. Trend: is AR getting better or worse? ────────────────────────────
  const trend = computeARAgingTrend(classified, now);

  return {
    totalInvoices:    arRecords.length,
    totalInvoiced:    classified.reduce((s, r) => s + (Number(r.invoice_amount) || 0), 0),
    totalCollected:   classified.reduce((s, r) => s + (Number(r.payment_amount) || 0), 0),
    totalOutstanding: aging.totalOutstanding,
    aging,
    discrepancies,
    duplicates,
    customerProfiles,
    dso,
    earlyPayOpportunity,
    concentrationRisk,
    crossDomainFlags,
    benchmarkScores,
    trend,
    asOfDate: now,
  };
}

// ─── Aging classification ─────────────────────────────────────────────────────

function classifyAging(record, asOf) {
  const due     = record.due_date    ? new Date(record.due_date)    : null;
  const paid    = record.payment_date ? new Date(record.payment_date) : null;
  const balance = computeBalance(record);

  if (!due) return { bucket: "unknown", daysOutstanding: 0, isPastDue: false, daysOverTerms: 0 };

  // For paid invoices: measure whether they paid late
  // For unpaid: measure how far past due they are
  const measureTo     = paid || asOf;
  const daysOut       = Math.floor((measureTo - due) / (1000 * 60 * 60 * 24));
  const isPastDue     = !paid && daysOut > 0;
  const isFullyPaid   = paid && balance <= 0.01;

  let bucket;
  if      (daysOut <= 0)  bucket = "current";
  else if (daysOut <= 30) bucket = "net30";
  else if (daysOut <= 60) bucket = "net60";
  else if (daysOut <= 90) bucket = "net90";
  else                    bucket = "over90";

  // Terms drift: how many days beyond stated terms?
  const termsDays = parseTermsDays(record.payment_terms);
  const daysOverTerms = termsDays ? Math.max(0, daysOut - termsDays) : 0;

  return {
    bucket,
    daysOutstanding: Math.max(0, daysOut),
    isPastDue,
    isFullyPaid,
    isPartiallyPaid: paid && balance > 0.01,
    isLatePay: paid && daysOut > 0,        // paid, but late
    daysOverTerms,
    termsDays,
  };
}

function computeBalance(r) {
  const invoiced = Number(r.invoice_amount)  || 0;
  const paid     = Number(r.payment_amount)  || 0;
  return Math.max(0, invoiced - paid);
}

function parseTermsDays(terms) {
  if (!terms) return 30; // default assumption
  const m = String(terms).match(/net\s*(\d+)/i);
  return m ? parseInt(m[1]) : 30;
}

// ─── Aging buckets ────────────────────────────────────────────────────────────

function buildAgingBuckets(classified) {
  const buckets = {
    current: { count: 0, amount: 0, invoices: [] },
    net30:   { count: 0, amount: 0, invoices: [] },
    net60:   { count: 0, amount: 0, invoices: [] },
    net90:   { count: 0, amount: 0, invoices: [] },
    over90:  { count: 0, amount: 0, invoices: [] },
    unknown: { count: 0, amount: 0, invoices: [] },
  };

  let totalOutstanding = 0;

  classified.forEach(r => {
    const balance = r._balance;
    if (balance <= 0) return; // fully paid, skip

    const bucket = r._aging.bucket;
    if (buckets[bucket]) {
      buckets[bucket].count++;
      buckets[bucket].amount += balance;
      buckets[bucket].invoices.push(r);
    }
    totalOutstanding += balance;
  });

  const pastDueAmount = buckets.net30.amount + buckets.net60.amount +
                        buckets.net90.amount + buckets.over90.amount;
  const pastDueCount  = buckets.net30.count  + buckets.net60.count  +
                        buckets.net90.count  + buckets.over90.count;

  return { buckets, totalOutstanding, pastDueAmount, pastDueCount };
}

// ─── Discrepancy detection ────────────────────────────────────────────────────

function detectDiscrepancies(classified, benchmarks) {
  const discrepancies = [];

  classified.forEach(r => {
    const invoiced = Number(r.invoice_amount) || 0;
    const paid     = Number(r.payment_amount) || 0;
    const gap      = invoiced - paid;

    // Skip unpaid invoices and zero-balance fully paid
    if (!r.payment_date && paid === 0) return;
    if (Math.abs(gap) <= benchmarks.discrepancyMinGap) return;

    discrepancies.push({
      invoice_id:    r.invoice_id,
      customer_name: r.customer_name || r.customer_id,
      invoice_date:  r.invoice_date,
      payment_date:  r.payment_date,
      invoiced,
      paid,
      gap:           Math.abs(gap),
      type:          gap > 0 ? "underpayment" : "overpayment",
      severity:      Math.abs(gap) > 1000 ? "high"
                   : Math.abs(gap) > 100  ? "medium" : "low",
      daysToResolve: r.payment_date
        ? Math.floor((new Date(r.payment_date) - new Date(r.invoice_date)) / (1000*60*60*24))
        : null,
      note: gap > 0
        ? `Customer paid $${Math.abs(gap).toFixed(2)} less than invoiced — balance outstanding`
        : `Customer overpaid by $${Math.abs(gap).toFixed(2)} — credit or refund may be owed`,
    });
  });

  return discrepancies.sort((a, b) => b.gap - a.gap);
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

function detectDuplicates(records) {
  const duplicates = [];
  const sorted = [...records].sort((a, b) =>
    ((a.customer_id || a.customer_name || "") + String(a.invoice_amount || ""))
      .localeCompare((b.customer_id || b.customer_name || "") + String(b.invoice_amount || ""))
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    const sameCustomer = (a.customer_id && a.customer_id === b.customer_id) ||
                         (a.customer_name && a.customer_name === b.customer_name);
    if (!sameCustomer) continue;

    const amtA = Number(a.invoice_amount) || 0;
    const amtB = Number(b.invoice_amount) || 0;
    if (Math.abs(amtA - amtB) > 0.01) continue;

    const dateA = a.invoice_date ? new Date(a.invoice_date) : null;
    const dateB = b.invoice_date ? new Date(b.invoice_date) : null;
    if (!dateA || !dateB) continue;

    const daysBetween = Math.abs((dateB - dateA) / (1000*60*60*24));
    if (daysBetween <= 45) {
      duplicates.push({
        invoice_a:    a.invoice_id,
        invoice_b:    b.invoice_id,
        customer_name: a.customer_name || a.customer_id,
        amount:        amtA,
        date_a:        a.invoice_date,
        date_b:        b.invoice_date,
        days_apart:    Math.round(daysBetween),
        risk:          daysBetween <= 7 ? "high" : daysBetween <= 21 ? "medium" : "low",
        note: `Same customer, same amount ($${amtA.toFixed(2)}), ${Math.round(daysBetween)}d apart — possible duplicate billing`,
      });
    }
  }
  return duplicates;
}

// ─── Customer profiles ────────────────────────────────────────────────────────

function buildCustomerProfiles(classified, asOf, benchmarks) {
  const customerMap = {};

  classified.forEach(r => {
    const key = r.customer_id || r.customer_name || "unknown";
    if (!customerMap[key]) {
      customerMap[key] = {
        name:             r.customer_name || r.customer_id || key,
        id:               r.customer_id,
        invoices:         [],
        totalInvoiced:    0,
        totalPaid:        0,
        totalOutstanding: 0,
        daysToCollect:    [],
        termsDays:        parseTermsDays(r.payment_terms),
        latestInvoiceDate: null,
      };
    }
    const c = customerMap[key];
    c.invoices.push(r);
    c.totalInvoiced    += Number(r.invoice_amount) || 0;
    c.totalPaid        += Number(r.payment_amount) || 0;
    c.totalOutstanding += r._balance;

    // Track actual days to collect for paid invoices
    if (r.payment_date && r.invoice_date) {
      const daysToCollect = Math.floor(
        (new Date(r.payment_date) - new Date(r.invoice_date)) / (1000*60*60*24)
      );
      if (daysToCollect >= 0) c.daysToCollect.push(daysToCollect);
    }

    // Track most recent invoice
    if (!c.latestInvoiceDate || new Date(r.invoice_date) > new Date(c.latestInvoiceDate)) {
      c.latestInvoiceDate = r.invoice_date;
    }
  });

  return Object.values(customerMap).map(c => {
    const avgDays = c.daysToCollect.length
      ? c.daysToCollect.reduce((s, d) => s + d, 0) / c.daysToCollect.length : null;

    const driftDays = avgDays !== null ? avgDays - c.termsDays : null;
    const isDrifting = driftDays !== null && driftDays > benchmarks.termsDriftDays;

    // Detect worsening trend: are recent invoices taking longer to collect?
    const recentDays = c.daysToCollect.slice(-3);
    const olderDays  = c.daysToCollect.slice(0, -3);
    const recentAvg  = recentDays.length ? recentDays.reduce((s,d)=>s+d,0)/recentDays.length : null;
    const olderAvg   = olderDays.length  ? olderDays.reduce((s,d)=>s+d,0)/olderDays.length   : null;
    const isTrendingWorse = recentAvg !== null && olderAvg !== null && (recentAvg - olderAvg) > 10;

    const riskLevel = c.totalOutstanding > 10000 && isDrifting ? "high"
                    : c.totalOutstanding > 5000  || isDrifting  ? "medium"
                    : "low";

    return {
      ...c,
      avgDaysToCollect:  avgDays !== null ? Math.round(avgDays) : null,
      driftDays:         driftDays !== null ? Math.round(driftDays) : null,
      isDrifting,
      isTrendingWorse,
      paymentReliability: avgDays === null ? "unknown"
                        : avgDays <= c.termsDays + 5 ? "excellent"
                        : avgDays <= c.termsDays + 15 ? "good"
                        : avgDays <= c.termsDays + 30 ? "slow"
                        : "chronic",
      riskLevel,
      invoiceCount: c.invoices.length,
    };
  }).sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}

// ─── DSO ──────────────────────────────────────────────────────────────────────

function computeDSO(classified, asOf) {
  // Standard DSO = (AR outstanding / total revenue in period) × days in period
  const paidInvoices = classified.filter(r => r.payment_date && r._aging.daysOutstanding >= 0);
  if (!paidInvoices.length) return null;

  const avgDays = paidInvoices.reduce((s, r) => s + r._aging.daysOutstanding, 0) / paidInvoices.length;
  return Math.round(avgDays);
}

// ─── Early-pay opportunity ────────────────────────────────────────────────────

function computeEarlyPayOpportunity(classified, asOf) {
  let totalOpportunity = 0;
  const opportunities  = [];

  classified.forEach(r => {
    if (!r.early_pay_discount_pct || r._balance <= 0) return;
    const cutoffDays = Number(r.early_pay_cutoff_days) || 10;
    const invoiceDate = r.invoice_date ? new Date(r.invoice_date) : null;
    if (!invoiceDate) return;

    const daysElapsed = Math.floor((asOf - invoiceDate) / (1000*60*60*24));
    if (daysElapsed <= cutoffDays) {
      const saving = r._balance * (Number(r.early_pay_discount_pct) / 100);
      totalOpportunity += saving;
      opportunities.push({
        invoice_id:    r.invoice_id,
        customer_name: r.customer_name,
        balance:       r._balance,
        discount_pct:  r.early_pay_discount_pct,
        saving:        saving,
        cutoff_date:   new Date(invoiceDate.getTime() + cutoffDays * 86400000).toISOString().split("T")[0],
        days_remaining: cutoffDays - daysElapsed,
      });
    }
  });

  return { total: totalOpportunity, opportunities };
}

// ─── Concentration risk ───────────────────────────────────────────────────────

function computeConcentrationRisk(classified) {
  const customerOutstanding = {};
  let totalOutstanding = 0;

  classified.forEach(r => {
    if (r._balance <= 0) return;
    const key = r.customer_name || r.customer_id || "unknown";
    customerOutstanding[key] = (customerOutstanding[key] || 0) + r._balance;
    totalOutstanding += r._balance;
  });

  const sorted = Object.entries(customerOutstanding)
    .sort((a, b) => b[1] - a[1]);

  const top1Pct  = totalOutstanding > 0 ? (sorted[0]?.[1] || 0) / totalOutstanding * 100 : 0;
  const top3Pct  = totalOutstanding > 0
    ? sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0) / totalOutstanding * 100 : 0;

  return {
    top1Customer:      sorted[0]?.[0],
    top1Amount:        sorted[0]?.[1] || 0,
    top1Pct:           Math.round(top1Pct),
    top3Pct:           Math.round(top3Pct),
    totalCustomers:    sorted.length,
    totalOutstanding,
    isConcentrated:    top1Pct > 35 || top3Pct > 60,
    breakdown:         sorted.slice(0, 5).map(([name, amount]) => ({
      name, amount, pct: Math.round(amount / totalOutstanding * 100)
    })),
  };
}

// ─── Cross-domain: AR risk + active sales pipeline ────────────────────────────

function detectCrossDomainRisk(customerProfiles, salesRecords) {
  const flags = [];
  const openQuotes = salesRecords.filter(r => {
    const s = (r.status || "").toLowerCase();
    return s === "open" || s === "pending" || s === "quoted";
  });

  const openByCustomer = {};
  openQuotes.forEach(r => {
    const key = r.customer_name || r.customer_id;
    if (!key) return;
    if (!openByCustomer[key]) openByCustomer[key] = { quotes: 0, value: 0 };
    openByCustomer[key].quotes++;
    openByCustomer[key].value += Number(r.quote_value) || 0;
  });

  customerProfiles.forEach(c => {
    const pipeline = openByCustomer[c.name] || openByCustomer[c.id];
    if (!pipeline) return;
    if (c.totalOutstanding <= 0 && !c.isDrifting) return;

    let riskNote = "";
    if (c.totalOutstanding > 0 && c.isDrifting) {
      riskNote = `${c.name} has $${Math.round(c.totalOutstanding).toLocaleString()} overdue AR (avg ${c.avgDaysToCollect}d vs Net ${c.termsDays}) AND $${Math.round(pipeline.value).toLocaleString()} in open quotes — consider deposit requirement or credit hold before quoting further`;
    } else if (c.totalOutstanding > 5000) {
      riskNote = `${c.name} has $${Math.round(c.totalOutstanding).toLocaleString()} outstanding AND $${Math.round(pipeline.value).toLocaleString()} in active pipeline — confirm collection status before committing capacity`;
    } else if (c.isDrifting) {
      riskNote = `${c.name} is a slow-pay customer (${c.avgDaysToCollect}d avg vs Net ${c.termsDays}) with ${pipeline.quotes} open quote(s) worth $${Math.round(pipeline.value).toLocaleString()} — revise payment terms on next job`;
    }

    if (riskNote) {
      flags.push({
        customer_name:     c.name,
        ar_outstanding:    c.totalOutstanding,
        pipeline_value:    pipeline.value,
        open_quotes:       pipeline.quotes,
        avg_days_collect:  c.avgDaysToCollect,
        payment_terms:     `Net ${c.termsDays}`,
        risk_level:        c.riskLevel,
        note:              riskNote,
      });
    }
  });

  return flags.sort((a, b) => b.ar_outstanding - a.ar_outstanding);
}

// ─── AR aging trend ───────────────────────────────────────────────────────────

function computeARAgingTrend(classified, asOf) {
  // Group invoices by month-of-invoice and see if over90 bucket is growing
  const monthBuckets = {};
  classified.forEach(r => {
    if (!r.invoice_date) return;
    const d   = new Date(r.invoice_date);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!monthBuckets[key]) monthBuckets[key] = { invoiced: 0, collected: 0 };
    monthBuckets[key].invoiced   += Number(r.invoice_amount) || 0;
    monthBuckets[key].collected  += Number(r.payment_amount) || 0;
  });

  return Object.entries(monthBuckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([month, d]) => ({
      month,
      invoiced:   Math.round(d.invoiced),
      collected:  Math.round(d.collected),
      outstanding: Math.round(d.invoiced - d.collected),
      collectRate: d.invoiced > 0 ? Math.round((d.collected / d.invoiced) * 100) : 0,
    }));
}

// ─── Benchmark scoring ────────────────────────────────────────────────────────

function scoreBenchmarks(aging, dso, benchmarks) {
  const totalOut    = aging.totalOutstanding || 1;
  const pastDuePct  = (aging.pastDueAmount / totalOut) * 100;
  const over90Pct   = (aging.buckets.over90.amount / totalOut) * 100;

  return {
    dso: dso === null ? "insufficient_data"
       : dso <= benchmarks.dso.excellent ? "excellent"
       : dso <= benchmarks.dso.good      ? "good"
       : dso <= benchmarks.dso.warning   ? "warning"
       : "critical",
    pastDuePct: pastDuePct <= benchmarks.pastDuePct.good    ? "good"
              : pastDuePct <= benchmarks.pastDuePct.warning ? "warning"
              : "critical",
    over90Pct:  over90Pct  <= benchmarks.over90Pct.good    ? "good"
              : over90Pct  <= benchmarks.over90Pct.warning ? "warning"
              : "critical",
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Builds the AR section for the SWOT engine prompt.
 * Token-efficient — sends computed stats, not raw rows.
 */
function buildARSummary(arRecords, salesRecords = [], options = {}) {
  const a   = analyzeAR(arRecords, salesRecords, options);
  const fmt = n => "$" + Math.round(n).toLocaleString();
  const pct = n => n !== null ? `${Math.round(n)}%` : "n/a";

  const lines = [];
  lines.push(`## ACCOUNTS RECEIVABLE (${a.totalInvoices} invoices · as of ${a.asOfDate.toDateString()})`);
  lines.push(`Total invoiced: ${fmt(a.totalInvoiced)} · collected: ${fmt(a.totalCollected)} · outstanding: ${fmt(a.totalOutstanding)}`);
  lines.push(`DSO: ${a.dso !== null ? a.dso + " days" : "n/a"} [benchmark: ${AR_BENCHMARKS.dso.good}d good, ${AR_BENCHMARKS.dso.warning}d warning]`);
  lines.push(`DSO rating: ${a.benchmarkScores.dso} · past-due rating: ${a.benchmarkScores.pastDuePct} · over-90 rating: ${a.benchmarkScores.over90Pct}`);

  lines.push(``);
  lines.push(`AGING BUCKETS (unpaid balances only):`);
  lines.push(`  Current (not yet due):  ${a.aging.buckets.current.count} invoices · ${fmt(a.aging.buckets.current.amount)}`);
  lines.push(`  Net 30  (1–30 days):    ${a.aging.buckets.net30.count} invoices · ${fmt(a.aging.buckets.net30.amount)}`);
  lines.push(`  Net 60  (31–60 days):   ${a.aging.buckets.net60.count} invoices · ${fmt(a.aging.buckets.net60.amount)}`);
  lines.push(`  Net 90  (61–90 days):   ${a.aging.buckets.net90.count} invoices · ${fmt(a.aging.buckets.net90.amount)}`);
  lines.push(`  Over 90 days:           ${a.aging.buckets.over90.count} invoices · ${fmt(a.aging.buckets.over90.amount)}`);
  lines.push(`  Past-due total: ${fmt(a.aging.pastDueAmount)} across ${a.aging.pastDueCount} invoices (${pct(a.aging.pastDueAmount/a.aging.totalOutstanding*100)} of AR)`);

  if (a.discrepancies.length > 0) {
    lines.push(``);
    lines.push(`PAYMENT DISCREPANCIES (${a.discrepancies.length} found):`);
    a.discrepancies.slice(0, 8).forEach(d =>
      lines.push(`  [${d.severity.toUpperCase()}] ${d.invoice_id} · ${d.customer_name}: invoiced ${fmt(d.invoiced)}, paid ${fmt(d.paid)} · gap ${fmt(d.gap)} (${d.type})`)
    );
  } else {
    lines.push(`No payment discrepancies detected.`);
  }

  if (a.duplicates.length > 0) {
    lines.push(``);
    lines.push(`DUPLICATE INVOICE RISK (${a.duplicates.length} potential duplicates):`);
    a.duplicates.forEach(d =>
      lines.push(`  [${d.risk.toUpperCase()}] ${d.customer_name}: ${fmt(d.amount)} · invoices ${d.invoice_a} and ${d.invoice_b} · ${d.days_apart}d apart`)
    );
  }

  lines.push(``);
  lines.push(`CUSTOMER COLLECTION PROFILES (top by outstanding):`);
  a.customerProfiles.slice(0, 6).forEach(c => {
    const drift = c.driftDays ? ` · ${c.driftDays}d over terms` : "";
    const trend = c.isTrendingWorse ? " · WORSENING TREND" : "";
    lines.push(`  ${c.name}: ${fmt(c.totalOutstanding)} outstanding · ${c.avgDaysToCollect !== null ? c.avgDaysToCollect + "d avg collect" : "no history"} · reliability: ${c.paymentReliability}${drift}${trend}`);
  });

  if (a.earlyPayOpportunity.total > 0) {
    lines.push(``);
    lines.push(`EARLY-PAY DISCOUNT OPPORTUNITY: ${fmt(a.earlyPayOpportunity.total)} available if invoices paid within terms`);
    a.earlyPayOpportunity.opportunities.slice(0, 4).forEach(o =>
      lines.push(`  ${o.customer_name}: ${o.discount_pct}% discount on ${fmt(o.balance)} · expires ${o.cutoff_date} (${o.days_remaining}d left)`)
    );
  }

  lines.push(``);
  lines.push(`AR CONCENTRATION: top customer = ${pct(a.concentrationRisk.top1Pct)} of outstanding · top 3 = ${pct(a.concentrationRisk.top3Pct)}`);
  a.concentrationRisk.breakdown.slice(0, 4).forEach(c =>
    lines.push(`  ${c.name}: ${fmt(c.amount)} (${c.pct}%)`)
  );

  if (a.crossDomainFlags.length > 0) {
    lines.push(``);
    lines.push(`CROSS-DOMAIN RISK — AR overdue + active sales pipeline (${a.crossDomainFlags.length} customers):`);
    a.crossDomainFlags.forEach(f =>
      lines.push(`  [${f.risk_level.toUpperCase()}] ${f.customer_name}: ${fmt(f.ar_outstanding)} overdue · ${fmt(f.pipeline_value)} in open quotes`)
    );
  }

  if (a.trend.length >= 3) {
    lines.push(``);
    lines.push(`AR MONTHLY TREND (collection rate by invoice month):`);
    a.trend.forEach(m =>
      lines.push(`  ${m.month}: invoiced ${fmt(m.invoiced)} · collected ${fmt(m.collected)} · ${m.collectRate}% collection rate`)
    );
  }

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyAnalysis() {
  return {
    totalInvoices: 0, totalInvoiced: 0, totalCollected: 0, totalOutstanding: 0,
    aging: { buckets: {}, totalOutstanding: 0, pastDueAmount: 0, pastDueCount: 0 },
    discrepancies: [], duplicates: [], customerProfiles: [],
    dso: null, earlyPayOpportunity: { total: 0, opportunities: [] },
    concentrationRisk: {}, crossDomainFlags: [],
    benchmarkScores: {}, trend: [],
  };
}

// ─── Sample data + demo ───────────────────────────────────────────────────────

const TODAY = new Date("2024-04-08");

const SAMPLE_AR = [
  { invoice_id:"INV-001", customer_name:"Midwest Tooling",    invoice_date:"2024-02-01", due_date:"2024-03-02", invoice_amount:8700,  payment_amount:8400,  payment_date:"2024-03-28", payment_terms:"Net 30" },
  { invoice_id:"INV-002", customer_name:"Midwest Tooling",    invoice_date:"2024-01-15", due_date:"2024-02-14", invoice_amount:6200,  payment_amount:6200,  payment_date:"2024-03-10", payment_terms:"Net 30" },
  { invoice_id:"INV-003", customer_name:"Great Lakes Mfg",    invoice_date:"2024-02-15", due_date:"2024-03-16", invoice_amount:5500,  payment_amount:0,     payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-004", customer_name:"Great Lakes Mfg",    invoice_date:"2024-01-20", due_date:"2024-02-19", invoice_amount:4800,  payment_amount:4800,  payment_date:"2024-03-15", payment_terms:"Net 30" },
  { invoice_id:"INV-005", customer_name:"Precision Parts Co", invoice_date:"2024-03-01", due_date:"2024-03-31", invoice_amount:12400, payment_amount:12400, payment_date:"2024-03-28", payment_terms:"Net 30" },
  { invoice_id:"INV-006", customer_name:"Apex Assemblies",    invoice_date:"2024-01-05", due_date:"2024-02-04", invoice_amount:9800,  payment_amount:9500,  payment_date:"2024-03-01", payment_terms:"Net 30", early_pay_discount_pct:2, early_pay_cutoff_days:10 },
  { invoice_id:"INV-007", customer_name:"Midwest Tooling",    invoice_date:"2024-03-10", due_date:"2024-04-09", invoice_amount:3200,  payment_amount:0,     payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-008", customer_name:"Great Lakes Mfg",    invoice_date:"2024-01-01", due_date:"2024-01-31", invoice_amount:6200,  payment_amount:0,     payment_date:null,         payment_terms:"Net 30" },
  { invoice_id:"INV-009", customer_name:"Cornerstone Mfg",   invoice_date:"2024-03-15", due_date:"2024-04-14", invoice_amount:4400,  payment_amount:0,     payment_date:null,         payment_terms:"Net 30", early_pay_discount_pct:2, early_pay_cutoff_days:10 },
  { invoice_id:"INV-010", customer_name:"Great Lakes Mfg",    invoice_date:"2024-03-20", due_date:"2024-04-04", invoice_amount:3800,  payment_amount:4200,  payment_date:"2024-04-02", payment_terms:"Net 15" },
  { invoice_id:"INV-011", customer_name:"Apex Assemblies",    invoice_date:"2024-02-20", due_date:"2024-03-21", invoice_amount:9800,  payment_amount:0,     payment_date:null,         payment_terms:"Net 30" },
];

const SAMPLE_SALES = [
  { customer_name:"Midwest Tooling",  status:"Open",  quote_value:8400  },
  { customer_name:"Great Lakes Mfg",  status:"Open",  quote_value:14000 },
  { customer_name:"Apex Assemblies",  status:"Quoted",quote_value:6200  },
];

const summary = buildARSummary(SAMPLE_AR, SAMPLE_SALES, { asOfDate: TODAY });
console.log(summary);

module.exports = { analyzeAR, buildARSummary, classifyAging, detectDiscrepancies, detectDuplicates };

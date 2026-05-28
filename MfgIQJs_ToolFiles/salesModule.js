/**
 * SWOT Plugin — Sales Analysis Module
 *
 * Computes a rich statistical summary of CRM/quote data,
 * then builds a structured prompt for Claude to generate
 * conversion-focused SWOT findings.
 *
 * What it analyzes:
 *   - Overall conversion rate + trend
 *   - Win/loss/expired breakdown
 *   - Loss reason frequency + category grouping
 *   - Performance by sales rep
 *   - Performance by product line (win rate + cycle time + deal size)
 *   - Deal size conversion tiers
 *   - Pipeline stage of loss (where deals die)
 *   - Competitive loss signals
 *   - Expired quote value at risk
 *   - Customer concentration (top N = X% of wins)
 *   - Follow-up gap detection (quotes with no recent activity)
 *   - Month-over-month trend (if date data available)
 *
 * Usage:
 *   const { buildSalesSummary, analyzeSales } = require('./salesModule');
 *   const summary = buildSalesSummary(salesRecords, { asOfDate, benchmarks });
 *   // summary feeds into swotEngine.js buildDataSummary()
 */

// ─── Industry benchmarks (manufacturing B2B) ──────────────────────────────────
// These contextualize raw numbers so Claude can call out over/under performance.

const BENCHMARKS = {
  conversionRate:    { good: 55, avg: 45, poor: 35 },   // % of quotes won
  avgCloseDays:      { good: 18, avg: 28, poor: 45 },   // days from quote to close
  expiredQuotePct:   { good: 5,  avg: 10, poor: 18 },   // % of quotes that expire
  followUpGapDays:   30,   // quotes with no activity beyond this are "at risk"
  largeDealThreshold: 25000,  // $ above which deals are "large"
  smallDealThreshold: 5000,   // $ below which deals are "small"
};

// Loss reason canonical groupings
// Maps raw reason text → standardized category
const LOSS_REASON_CATEGORIES = {
  price:       ["price", "too expensive", "cost", "budget", "pricing", "rates", "hourly", "quote too high"],
  lead_time:   ["lead time", "too slow", "delivery", "schedule", "timing", "too long", "turnaround"],
  competitor:  ["competitor", "competition", "went with", "chose", "awarded to", "fastfab", "other vendor"],
  no_decision: ["no decision", "project cancelled", "on hold", "budget freeze", "deferred", "postponed"],
  spec:        ["spec", "capability", "can't do", "no capacity", "equipment", "tolerance", "material"],
  relationship:["relationship", "preferred vendor", "existing supplier", "loyalty"],
  unknown:     [],  // catch-all
};

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Full sales analysis — computes all metrics and returns a structured
 * summary object suitable for the SWOT prompt builder.
 *
 * @param {SalesRecord[]} records
 * @param {Object} [options]
 * @param {Date}   [options.asOfDate]
 * @param {Object} [options.benchmarks]  - override default benchmarks
 * @param {number} [options.periodDays]  - analysis window in days (default: all records)
 * @returns {SalesSummary}
 */
function analyzeSales(records, options = {}) {
  const now        = new Date(options.asOfDate || new Date());
  const benchmarks = { ...BENCHMARKS, ...(options.benchmarks || {}) };

  if (!records.length) return emptySummary();

  // ── Core breakdown ─────────────────────────────────────────────────────────
  const won     = records.filter(r => normalizeStatus(r.status) === "won");
  const lost    = records.filter(r => normalizeStatus(r.status) === "lost");
  const expired = records.filter(r => normalizeStatus(r.status) === "expired");
  const open    = records.filter(r => normalizeStatus(r.status) === "open");
  const total   = records.length;

  const convRate = total > 0 ? (won.length / total) * 100 : 0;
  const expiredPct = total > 0 ? (expired.length / total) * 100 : 0;

  // ── Cycle time ────────────────────────────────────────────────────────────
  const closedWithDays = [...won, ...lost].filter(r => Number(r.quote_to_close_days) > 0);
  const avgCloseDays   = closedWithDays.length
    ? closedWithDays.reduce((s, r) => s + Number(r.quote_to_close_days), 0) / closedWithDays.length
    : null;

  const wonWithDays  = won.filter(r => Number(r.quote_to_close_days) > 0);
  const avgWonDays   = wonWithDays.length
    ? wonWithDays.reduce((s, r) => s + Number(r.quote_to_close_days), 0) / wonWithDays.length : null;

  // ── Loss reasons ──────────────────────────────────────────────────────────
  const lossReasonCounts = {};
  const lossCategories   = {};

  lost.forEach(r => {
    const raw = (r.win_loss_reason || "").toLowerCase().trim();
    if (raw) {
      lossReasonCounts[raw] = (lossReasonCounts[raw] || 0) + 1;
      const cat = categorizeLossReason(raw);
      lossCategories[cat]   = (lossCategories[cat] || 0) + 1;
    }
  });

  const topLossReasons = Object.entries(lossReasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([reason, count]) => ({ reason, count, category: categorizeLossReason(reason) }));

  const unrecordedLosses = lost.filter(r => !r.win_loss_reason || !r.win_loss_reason.trim()).length;

  // ── Rep performance ───────────────────────────────────────────────────────
  const repMap = {};
  records.forEach(r => {
    const rep = r.sales_rep_id || r.sales_rep || "Unknown";
    if (!repMap[rep]) repMap[rep] = { won: 0, lost: 0, expired: 0, open: 0, totalDays: 0, daysCount: 0, totalValue: 0 };
    const status = normalizeStatus(r.status);
    repMap[rep][status] = (repMap[rep][status] || 0) + 1;
    if (Number(r.quote_to_close_days) > 0) {
      repMap[rep].totalDays += Number(r.quote_to_close_days);
      repMap[rep].daysCount++;
    }
    repMap[rep].totalValue += Number(r.quote_value) || 0;
  });

  const repPerformance = Object.entries(repMap).map(([rep, d]) => {
    const total = d.won + d.lost + d.expired + d.open;
    return {
      rep,
      total,
      won:         d.won,
      convRate:    total > 0 ? (d.won / total) * 100 : 0,
      avgDays:     d.daysCount > 0 ? d.totalDays / d.daysCount : null,
      totalValue:  d.totalValue,
      expiredCount: d.expired,
    };
  }).sort((a, b) => b.convRate - a.convRate);

  // ── Product line performance ───────────────────────────────────────────────
  const plMap = {};
  records.forEach(r => {
    const pl = r.product_line || r.product_category || "Unspecified";
    if (!plMap[pl]) plMap[pl] = { won: 0, total: 0, totalDays: 0, daysCount: 0, totalValue: 0, lostToLeadTime: 0, lostToPrice: 0 };
    plMap[pl].total++;
    const status = normalizeStatus(r.status);
    if (status === "won") plMap[pl].won++;
    if (Number(r.quote_to_close_days) > 0 && (status === "won" || status === "lost")) {
      plMap[pl].totalDays += Number(r.quote_to_close_days);
      plMap[pl].daysCount++;
    }
    plMap[pl].totalValue += Number(r.quote_value) || 0;

    if (status === "lost") {
      const cat = categorizeLossReason((r.win_loss_reason || "").toLowerCase());
      if (cat === "lead_time") plMap[pl].lostToLeadTime++;
      if (cat === "price")     plMap[pl].lostToPrice++;
    }
  });

  const productPerformance = Object.entries(plMap).map(([line, d]) => ({
    line,
    total:            d.total,
    won:              d.won,
    convRate:         d.total > 0 ? (d.won / d.total) * 100 : 0,
    avgDays:          d.daysCount > 0 ? d.totalDays / d.daysCount : null,
    avgDealSize:      d.total > 0 ? d.totalValue / d.total : 0,
    totalPipelineValue: d.totalValue,
    lostToLeadTime:   d.lostToLeadTime,
    lostToPrice:      d.lostToPrice,
  })).sort((a, b) => b.total - a.total);

  // ── Deal size tiers ────────────────────────────────────────────────────────
  const tiers = {
    small:  { label: `Under $${(benchmarks.smallDealThreshold/1000).toFixed(0)}K`, won: 0, total: 0 },
    mid:    { label: `$${(benchmarks.smallDealThreshold/1000).toFixed(0)}K–$${(benchmarks.largeDealThreshold/1000).toFixed(0)}K`, won: 0, total: 0 },
    large:  { label: `Over $${(benchmarks.largeDealThreshold/1000).toFixed(0)}K`, won: 0, total: 0 },
  };

  records.forEach(r => {
    const v = Number(r.quote_value) || 0;
    const status = normalizeStatus(r.status);
    const tier = v < benchmarks.smallDealThreshold ? "small"
               : v < benchmarks.largeDealThreshold ? "mid" : "large";
    tiers[tier].total++;
    if (status === "won") tiers[tier].won++;
  });

  const dealSizeTiers = Object.entries(tiers).map(([key, t]) => ({
    key,
    label:    t.label,
    total:    t.total,
    won:      t.won,
    convRate: t.total > 0 ? (t.won / t.total) * 100 : 0,
  }));

  // ── Pipeline stage of loss ────────────────────────────────────────────────
  const stageLosses = {};
  lost.forEach(r => {
    const stage = r.pipeline_stage || "not recorded";
    stageLosses[stage] = (stageLosses[stage] || 0) + 1;
  });
  const stageLossBreakdown = Object.entries(stageLosses)
    .sort((a, b) => b[1] - a[1])
    .map(([stage, count]) => ({ stage, count, pct: (count / lost.length) * 100 }));

  // ── Competitive signals ───────────────────────────────────────────────────
  const competitorMentions = {};
  records.forEach(r => {
    if (r.competitor_named) {
      const c = r.competitor_named.trim();
      competitorMentions[c] = (competitorMentions[c] || 0) + 1;
    }
  });
  const topCompetitors = Object.entries(competitorMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // ── Expired quotes ────────────────────────────────────────────────────────
  const expiredValue = expired.reduce((s, r) => s + (Number(r.quote_value) || 0), 0);
  const expectedRecovery = expiredValue * (convRate / 100);

  // ── Follow-up gap ─────────────────────────────────────────────────────────
  const followUpGap = open.filter(r => {
    if (!r.last_activity_date) return false;
    const last = new Date(r.last_activity_date);
    return (now - last) / (1000 * 60 * 60 * 24) > benchmarks.followUpGapDays;
  });
  const followUpGapValue = followUpGap.reduce((s, r) => s + (Number(r.quote_value) || 0), 0);

  // ── Customer concentration ────────────────────────────────────────────────
  const customerWins = {};
  won.forEach(r => {
    const c = r.customer_name || r.customer_id || "Unknown";
    customerWins[c] = (customerWins[c] || 0) + 1;
  });
  const sortedCustomers = Object.entries(customerWins).sort((a, b) => b[1] - a[1]);
  const top3Pct = won.length > 0
    ? (sortedCustomers.slice(0, 3).reduce((s, [, n]) => s + n, 0) / won.length) * 100 : 0;

  // ── Month-over-month trend ────────────────────────────────────────────────
  const monthlyTrend = buildMonthlyTrend(records, now);

  // ── Benchmark scoring ─────────────────────────────────────────────────────
  const performance = {
    convRate:   scoreMetric(convRate, benchmarks.conversionRate, "higher"),
    closeDays:  avgCloseDays ? scoreMetric(avgCloseDays, benchmarks.avgCloseDays, "lower") : "insufficient_data",
    expiredPct: scoreMetric(expiredPct, benchmarks.expiredQuotePct, "lower"),
  };

  return {
    // Raw counts
    total, won: won.length, lost: lost.length, expired: expired.length, open: open.length,
    // Rates
    convRate, expiredPct,
    // Cycle time
    avgCloseDays, avgWonDays,
    // Loss analysis
    topLossReasons, lossCategories, unrecordedLosses,
    stageLossBreakdown,
    // Segmented performance
    repPerformance,
    productPerformance,
    dealSizeTiers,
    // Risk signals
    topCompetitors,
    expiredValue, expectedRecovery,
    followUpGap: followUpGap.length, followUpGapValue,
    top3CustomerConcentration: top3Pct,
    // Trend
    monthlyTrend,
    // Benchmark comparison
    performance,
    benchmarks,
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Converts the sales summary into a compact text block
 * for the Claude SWOT analysis prompt.
 *
 * Designed to be token-efficient — sends statistics, not raw rows.
 */
function buildSalesSummary(records, options = {}) {
  const s   = analyzeSales(records, options);
  const fmt = n => `$${Math.round(n).toLocaleString()}`;
  const p   = n => `${n.toFixed(1)}%`;
  const d   = n => n !== null ? `${n.toFixed(1)} days` : "n/a";

  const lines = [];

  lines.push(`## SALES & CONVERSION DATA (${s.total} quotes)`);
  lines.push(`Win/loss/expired/open: ${s.won} won · ${s.lost} lost · ${s.expired} expired · ${s.open} open`);
  lines.push(`Overall conversion rate: ${p(s.convRate)} [benchmark: ${p(s.benchmarks.conversionRate.avg)} avg, ${p(s.benchmarks.conversionRate.good)} good]`);
  lines.push(`Avg days to close (all closed): ${d(s.avgCloseDays)} [benchmark: ${s.benchmarks.avgCloseDays.avg}d avg, ${s.benchmarks.avgCloseDays.good}d good]`);
  lines.push(`Avg days to close (won only): ${d(s.avgWonDays)}`);
  lines.push(`Expired quote rate: ${p(s.expiredPct)} [benchmark: ${s.benchmarks.expiredQuotePct.avg}% avg]`);
  lines.push(`Performance vs benchmarks: conversion=${s.performance.convRate} · cycle time=${s.performance.closeDays} · expiry rate=${s.performance.expiredPct}`);

  lines.push(``);
  lines.push(`LOSS REASON ANALYSIS (${s.lost} losses):`);
  if (s.topLossReasons.length) {
    s.topLossReasons.forEach(r => lines.push(`  "${r.reason}" — ${r.count} times (category: ${r.category})`));
  } else {
    lines.push(`  No loss reasons recorded`);
  }
  if (s.unrecordedLosses > 0) {
    lines.push(`  ${s.unrecordedLosses} losses have NO reason recorded (${p(s.unrecordedLosses / s.lost * 100)} of all losses)`);
  }
  lines.push(`Loss reason categories: ${Object.entries(s.lossCategories).map(([c, n]) => `${c}: ${n}`).join(" · ")}`);

  if (s.stageLossBreakdown.length > 0 && s.stageLossBreakdown[0].stage !== "not recorded") {
    lines.push(``);
    lines.push(`WHERE DEALS DIE (pipeline stage at loss):`);
    s.stageLossBreakdown.slice(0, 5).forEach(st =>
      lines.push(`  ${st.stage}: ${st.count} losses (${p(st.pct)})`)
    );
  }

  lines.push(``);
  lines.push(`SALES REP PERFORMANCE:`);
  s.repPerformance.forEach(r =>
    lines.push(`  ${r.rep}: ${p(r.convRate)} conversion · ${r.total} quotes · avg ${d(r.avgDays)} close · ${r.expiredCount} expired`)
  );

  lines.push(``);
  lines.push(`PRODUCT LINE PERFORMANCE (sorted by volume):`);
  s.productPerformance.forEach(pl =>
    lines.push(`  ${pl.line}: ${p(pl.convRate)} win rate · ${pl.total} quotes · avg ${d(pl.avgDays)} close · avg deal ${fmt(pl.avgDealSize)} · lost to lead time: ${pl.lostToLeadTime} · lost to price: ${pl.lostToPrice}`)
  );

  lines.push(``);
  lines.push(`DEAL SIZE CONVERSION TIERS:`);
  s.dealSizeTiers.forEach(t =>
    lines.push(`  ${t.label}: ${p(t.convRate)} (${t.won} won of ${t.total})`)
  );

  if (s.topCompetitors.length > 0) {
    lines.push(``);
    lines.push(`COMPETITIVE SIGNALS (competitor named in lost deals):`);
    s.topCompetitors.forEach(c => lines.push(`  ${c.name}: mentioned ${c.count} times`));
  }

  lines.push(``);
  lines.push(`EXPIRED QUOTE RISK:`);
  lines.push(`  ${s.expired} expired quotes · total value: ${fmt(s.expiredValue)}`);
  lines.push(`  Expected recovery if followed up: ${fmt(s.expectedRecovery)} (at current ${p(s.convRate)} conversion rate)`);

  if (s.followUpGap > 0) {
    lines.push(``);
    lines.push(`FOLLOW-UP GAP (open quotes, no activity in ${s.benchmarks.followUpGapDays}+ days):`);
    lines.push(`  ${s.followUpGap} quotes · ${fmt(s.followUpGapValue)} at risk`);
  }

  lines.push(``);
  lines.push(`CUSTOMER CONCENTRATION:`);
  lines.push(`  Top 3 customers = ${p(s.top3CustomerConcentration)} of all won deals`);

  if (s.monthlyTrend.length >= 2) {
    lines.push(``);
    lines.push(`MONTHLY TREND (last ${s.monthlyTrend.length} months):`);
    s.monthlyTrend.forEach(m =>
      lines.push(`  ${m.month}: ${m.total} quotes · ${p(m.convRate)} conv rate`)
    );
  }

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeStatus(raw) {
  if (!raw) return "open";
  const s = String(raw).toLowerCase().trim();
  if (["won","closed won","closed - won","win","awarded"].some(v => s.includes(v))) return "won";
  if (["lost","closed lost","closed - lost","no award","not awarded"].some(v => s.includes(v))) return "lost";
  if (["expired","no response","lapsed","abandoned"].some(v => s.includes(v))) return "expired";
  return "open";
}

function categorizeLossReason(raw) {
  const s = raw.toLowerCase();
  for (const [cat, keywords] of Object.entries(LOSS_REASON_CATEGORIES)) {
    if (cat === "unknown") continue;
    if (keywords.some(k => s.includes(k))) return cat;
  }
  return "unknown";
}

function scoreMetric(value, benchmark, direction) {
  if (direction === "higher") {
    if (value >= benchmark.good) return "above_benchmark";
    if (value >= benchmark.avg)  return "at_benchmark";
    return "below_benchmark";
  } else {
    if (value <= benchmark.good) return "above_benchmark";
    if (value <= benchmark.avg)  return "at_benchmark";
    return "below_benchmark";
  }
}

function buildMonthlyTrend(records, now) {
  const months = {};
  records.forEach(r => {
    if (!r.quote_date) return;
    const d = new Date(r.quote_date);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!months[key]) months[key] = { won: 0, total: 0 };
    months[key].total++;
    if (normalizeStatus(r.status) === "won") months[key].won++;
  });
  return Object.entries(months)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([month, d]) => ({
      month,
      total:    d.total,
      won:      d.won,
      convRate: d.total > 0 ? (d.won / d.total) * 100 : 0,
    }));
}

function emptySummary() {
  return { total: 0, won: 0, lost: 0, expired: 0, open: 0, convRate: 0 };
}

// ─── Sample data + demo ───────────────────────────────────────────────────────

const SAMPLE_RECORDS = [
  { quote_id:"Q-1001", quote_date:"2024-01-05", customer_name:"Midwest Tooling",    product_line:"Hydraulic Fittings", quote_value:840,   status:"Won",     sales_rep_id:"T.Kowalski", quote_to_close_days:12, win_loss_reason:"" },
  { quote_id:"Q-1002", quote_date:"2024-01-08", customer_name:"Great Lakes Mfg",    product_line:"Custom Fabrication",  quote_value:2250,  status:"Lost",    sales_rep_id:"R.Chen",     quote_to_close_days:38, win_loss_reason:"Price" },
  { quote_id:"Q-1003", quote_date:"2024-01-10", customer_name:"Apex Assemblies",    product_line:"Sheet Metal",         quote_value:850,   status:"Won",     sales_rep_id:"M.Santos",   quote_to_close_days:14, win_loss_reason:"" },
  { quote_id:"Q-1004", quote_date:"2024-01-15", customer_name:"Precision Parts Co", product_line:"Hydraulic Fittings", quote_value:4200,  status:"Won",     sales_rep_id:"T.Kowalski", quote_to_close_days:10, win_loss_reason:"" },
  { quote_id:"Q-1005", quote_date:"2024-01-18", customer_name:"Midwest Tooling",    product_line:"Custom Fabrication",  quote_value:8500,  status:"Lost",    sales_rep_id:"T.Kowalski", quote_to_close_days:41, win_loss_reason:"Lead time" },
  { quote_id:"Q-1006", quote_date:"2024-01-22", customer_name:"Great Lakes Mfg",    product_line:"Welding & Assembly",  quote_value:3200,  status:"Lost",    sales_rep_id:"R.Chen",     quote_to_close_days:29, win_loss_reason:"Price" },
  { quote_id:"Q-1007", quote_date:"2024-02-01", customer_name:"NovaMed Devices",    product_line:"Precision Machining", quote_value:28500, status:"Lost",    sales_rep_id:"J.Williams", quote_to_close_days:55, win_loss_reason:"Lead time", competitor_named:"FastFab" },
  { quote_id:"Q-1008", quote_date:"2024-02-05", customer_name:"Apex Assemblies",    product_line:"Hydraulic Fittings", quote_value:1600,  status:"Won",     sales_rep_id:"M.Santos",   quote_to_close_days:16, win_loss_reason:"" },
  { quote_id:"Q-1009", quote_date:"2024-02-08", customer_name:"Midwest Tooling",    product_line:"Sheet Metal",         quote_value:2100,  status:"Won",     sales_rep_id:"T.Kowalski", quote_to_close_days:18, win_loss_reason:"" },
  { quote_id:"Q-1010", quote_date:"2024-02-12", customer_name:"Great Lakes Mfg",    product_line:"Custom Fabrication",  quote_value:14000, status:"Lost",    sales_rep_id:"R.Chen",     quote_to_close_days:33, win_loss_reason:"Price" },
  { quote_id:"Q-1011", quote_date:"2024-02-14", customer_name:"Cornerstone Mfg",   product_line:"Welding & Assembly",  quote_value:5500,  status:"Expired", sales_rep_id:"J.Williams", quote_to_close_days:60, win_loss_reason:"" },
  { quote_id:"Q-1012", quote_date:"2024-02-20", customer_name:"NovaMed Devices",    product_line:"Precision Machining", quote_value:32000, status:"Lost",    sales_rep_id:"J.Williams", quote_to_close_days:48, win_loss_reason:"Lead time", competitor_named:"FastFab" },
  { quote_id:"Q-1013", quote_date:"2024-03-01", customer_name:"Midwest Tooling",    product_line:"Hydraulic Fittings", quote_value:3600,  status:"Won",     sales_rep_id:"T.Kowalski", quote_to_close_days:11, win_loss_reason:"" },
  { quote_id:"Q-1014", quote_date:"2024-03-05", customer_name:"Precision Parts Co", product_line:"Sheet Metal",         quote_value:1800,  status:"Won",     sales_rep_id:"M.Santos",   quote_to_close_days:20, win_loss_reason:"" },
  { quote_id:"Q-1015", quote_date:"2024-03-10", customer_name:"Apex Assemblies",    product_line:"Custom Fabrication",  quote_value:6200,  status:"Expired", sales_rep_id:"R.Chen",     quote_to_close_days:45, win_loss_reason:"" },
  { quote_id:"Q-1016", quote_date:"2024-03-15", customer_name:"Great Lakes Mfg",    product_line:"Precision Machining", quote_value:9800,  status:"Won",     sales_rep_id:"M.Santos",   quote_to_close_days:28, win_loss_reason:"" },
  { quote_id:"Q-1017", quote_date:"2024-03-18", customer_name:"NovaMed Devices",    product_line:"Precision Machining", quote_value:41000, status:"Open",    sales_rep_id:"J.Williams", quote_to_close_days:0,  win_loss_reason:"", last_activity_date:"2024-02-28" },
  { quote_id:"Q-1018", quote_date:"2024-03-22", customer_name:"Cornerstone Mfg",   product_line:"Welding & Assembly",  quote_value:4400,  status:"Lost",    sales_rep_id:"R.Chen",     quote_to_close_days:31, win_loss_reason:"Chose competitor", competitor_named:"FastFab" },
  { quote_id:"Q-1019", quote_date:"2024-03-25", customer_name:"Midwest Tooling",    product_line:"Hydraulic Fittings", quote_value:5200,  status:"Won",     sales_rep_id:"T.Kowalski", quote_to_close_days:9,  win_loss_reason:"" },
  { quote_id:"Q-1020", quote_date:"2024-04-01", customer_name:"Apex Assemblies",    product_line:"Sheet Metal",         quote_value:3300,  status:"Open",    sales_rep_id:"M.Santos",   quote_to_close_days:0,  win_loss_reason:"", last_activity_date:"2024-04-05" },
];

const summary = buildSalesSummary(SAMPLE_RECORDS, { asOfDate: new Date("2024-04-08") });
console.log(summary);

module.exports = { analyzeSales, buildSalesSummary, normalizeStatus, categorizeLossReason, BENCHMARKS };

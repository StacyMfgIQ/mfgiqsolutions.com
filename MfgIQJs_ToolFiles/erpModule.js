/**
 * SWOT Plugin — ERP Module
 * The scheduling, planning and production intelligence engine.
 *
 * Covers:
 *   1. Work Orders       — schedule adherence, late jobs, on-hold analysis
 *   2. Bill of Materials — component coverage, single-source risk
 *   3. Inventory / MRP   — days of coverage, reorder alerts, slow-moving stock
 *   4. Capacity          — work center utilization, bottleneck detection
 *   5. Quality / Scrap   — first-pass yield, scrap cost by job type
 *   6. On-Time Delivery  — promised vs actual ship, customer OTD scores
 *
 * Usage:
 *   const { buildERPSummary } = require('./erpModule');
 *   const summary = buildERPSummary({ workOrders, bom, inventory, capacity, quality, deliveries, asOfDate });
 */

// ─── 1. Work Order Analysis ───────────────────────────────────────────────────

/**
 * @typedef {Object} WorkOrder
 * @property {string}  work_order_id
 * @property {string}  status           - open | in-progress | complete | on-hold | cancelled
 * @property {string}  job_type         - product line or job category
 * @property {string}  customer_id
 * @property {string}  customer_name
 * @property {string}  scheduled_start
 * @property {string}  scheduled_end
 * @property {string}  [actual_start]
 * @property {string}  [actual_end]
 * @property {number}  quantity_planned
 * @property {number}  [quantity_completed]
 * @property {number}  [planned_hours]
 * @property {number}  [actual_hours]
 * @property {string}  [on_hold_reason]
 * @property {number}  [priority]       - 1 = highest
 */

function analyzeWorkOrders(workOrders, asOfDate = new Date()) {
  const now = new Date(asOfDate);

  const result = {
    total:           workOrders.length,
    byStatus:        {},
    lateJobs:        [],
    onHoldJobs:      [],
    scheduleAdherence: 0,   // % of completed jobs that finished on or before scheduled_end
    avgDaysLate:     0,
    efficiencyByJobType: {},
    hoursVariance:   [],    // jobs where actual hours deviated >20% from planned
    completedOnTime: 0,
    completedLate:   0,
  };

  const lateDeltas = [];
  const completedJobs = [];

  workOrders.forEach(wo => {
    const status = (wo.status || "").toLowerCase().trim();
    result.byStatus[status] = (result.byStatus[status] || 0) + 1;

    const schedEnd  = wo.scheduled_end  ? new Date(wo.scheduled_end)  : null;
    const actualEnd = wo.actual_end     ? new Date(wo.actual_end)      : null;

    // Late detection: in-progress jobs past scheduled end, or completed jobs that ran over
    const compareDate = actualEnd || (status === "in-progress" || status === "open" ? now : null);
    if (schedEnd && compareDate && compareDate > schedEnd) {
      const daysLate = Math.ceil((compareDate - schedEnd) / (1000 * 60 * 60 * 24));
      lateDeltas.push(daysLate);

      if (status !== "complete") {
        result.lateJobs.push({
          work_order_id:  wo.work_order_id,
          customer_name:  wo.customer_name,
          job_type:       wo.job_type,
          status,
          scheduled_end:  wo.scheduled_end,
          days_late:      daysLate,
          priority:       wo.priority || 99,
          quantity_planned: wo.quantity_planned,
        });
      } else {
        result.completedLate++;
      }
    } else if (status === "complete" && schedEnd && actualEnd && actualEnd <= schedEnd) {
      result.completedOnTime++;
    }

    // On-hold jobs — frozen capital
    if (status === "on-hold") {
      result.onHoldJobs.push({
        work_order_id: wo.work_order_id,
        customer_name: wo.customer_name,
        job_type:      wo.job_type,
        on_hold_reason: wo.on_hold_reason || "not specified",
        scheduled_end: wo.scheduled_end,
        quantity_planned: wo.quantity_planned,
      });
    }

    // Efficiency: actual vs planned hours
    if (wo.planned_hours && wo.actual_hours) {
      const planned = Number(wo.planned_hours);
      const actual  = Number(wo.actual_hours);
      const variancePct = ((actual - planned) / planned) * 100;

      // Track by job type
      if (!result.efficiencyByJobType[wo.job_type]) {
        result.efficiencyByJobType[wo.job_type] = { totalVariancePct: 0, count: 0 };
      }
      result.efficiencyByJobType[wo.job_type].totalVariancePct += variancePct;
      result.efficiencyByJobType[wo.job_type].count++;

      if (Math.abs(variancePct) > 20) {
        result.hoursVariance.push({
          work_order_id: wo.work_order_id,
          job_type:      wo.job_type,
          planned_hours: planned,
          actual_hours:  actual,
          variance_pct:  variancePct.toFixed(1),
          over_budget:   actual > planned,
        });
      }
    }
  });

  // Sort late jobs by priority then days late
  result.lateJobs.sort((a, b) => a.priority - b.priority || b.days_late - a.days_late);

  // Schedule adherence %
  const totalCompleted = result.completedOnTime + result.completedLate;
  result.scheduleAdherence = totalCompleted > 0
    ? Math.round((result.completedOnTime / totalCompleted) * 100) : null;

  // Avg days late
  result.avgDaysLate = lateDeltas.length > 0
    ? Math.round(lateDeltas.reduce((a, b) => a + b, 0) / lateDeltas.length) : 0;

  // Efficiency summary by job type
  result.efficiencyByJobType = Object.entries(result.efficiencyByJobType)
    .map(([type, d]) => ({
      job_type:        type,
      avgVariancePct:  (d.totalVariancePct / d.count).toFixed(1),
      sampleSize:      d.count,
    }))
    .sort((a, b) => Math.abs(b.avgVariancePct) - Math.abs(a.avgVariancePct));

  return result;
}

// ─── 2. BOM + Inventory Coverage (MRP) ───────────────────────────────────────

/**
 * @typedef {Object} BOMRecord
 * @property {string}  parent_sku
 * @property {string}  parent_description
 * @property {string}  component_sku
 * @property {string}  component_description
 * @property {number}  quantity_per          - units of component needed per finished good
 * @property {string}  unit_of_measure
 * @property {number}  [lead_time_days]      - vendor lead time for this component
 * @property {string}  [primary_vendor]
 * @property {string}  [secondary_vendor]    - null = single source risk
 */

/**
 * @typedef {Object} InventoryRecord
 * @property {string}  sku
 * @property {string}  description
 * @property {number}  quantity_on_hand
 * @property {number}  [quantity_on_order]   - POs in transit
 * @property {number}  [reorder_point]
 * @property {number}  [reorder_quantity]
 * @property {number}  [safety_stock]
 * @property {number}  [avg_daily_usage]     - units consumed per production day
 * @property {number}  [unit_cost]
 * @property {string}  [last_movement_date]  - for slow-moving detection
 * @property {string}  [location_code]
 */

function analyzeMRP(bomRecords, inventoryRecords, openWorkOrders = [], asOfDate = new Date()) {
  const now = new Date(asOfDate);

  // Build inventory lookup
  const invMap = {};
  inventoryRecords.forEach(r => { invMap[r.sku] = r; });

  // Build demand from open work orders
  const demandMap = {};
  openWorkOrders
    .filter(wo => ["open","in-progress"].includes((wo.status||"").toLowerCase()))
    .forEach(wo => {
      if (!wo.finished_good_sku || !wo.quantity_planned) return;
      demandMap[wo.finished_good_sku] = (demandMap[wo.finished_good_sku] || 0) + Number(wo.quantity_planned);
    });

  const result = {
    componentCoverage:    [],   // days of coverage per component
    criticalShortages:    [],   // coverage < 5 days — stop-production risk
    reorderAlerts:        [],   // below reorder point
    singleSourceRisks:    [],   // no secondary vendor
    slowMoving:           [],   // no movement in 90+ days
    obsoleteRisk:         [],   // no movement in 180+ days
    totalSlowMovingValue: 0,
    totalObsoleteValue:   0,
  };

  // Analyze each component in the BOM
  const processedSkus = new Set();

  bomRecords.forEach(bom => {
    if (processedSkus.has(bom.component_sku)) return;
    processedSkus.add(bom.component_sku);

    const inv = invMap[bom.component_sku];
    if (!inv) return;

    const qoh          = Number(inv.quantity_on_hand)  || 0;
    const onOrder      = Number(inv.quantity_on_order) || 0;
    const dailyUsage   = Number(inv.avg_daily_usage)   || 0;
    const leadTime     = Number(bom.lead_time_days)    || 14;
    const unitCost     = Number(inv.unit_cost)         || 0;

    // Days of coverage
    const coverageDays = dailyUsage > 0
      ? Math.floor((qoh + onOrder) / dailyUsage)
      : null;

    result.componentCoverage.push({
      sku:              bom.component_sku,
      description:      bom.component_description,
      parent_sku:       bom.parent_sku,
      quantity_on_hand: qoh,
      quantity_on_order: onOrder,
      avg_daily_usage:  dailyUsage,
      coverage_days:    coverageDays,
      lead_time_days:   leadTime,
      coverage_vs_lead: coverageDays !== null ? coverageDays - leadTime : null,
      primary_vendor:   bom.primary_vendor,
      has_secondary:    !!bom.secondary_vendor,
    });

    // Critical shortage: coverage less than lead time — will run out before resupply
    if (coverageDays !== null && coverageDays < leadTime) {
      result.criticalShortages.push({
        sku:           bom.component_sku,
        description:   bom.component_description,
        parent_sku:    bom.parent_sku,
        coverage_days: coverageDays,
        lead_time_days: leadTime,
        gap_days:      leadTime - coverageDays,
        vendor:        bom.primary_vendor,
        urgency:       coverageDays <= 2 ? "stop-now" : coverageDays <= 7 ? "critical" : "watch",
      });
    }

    // Reorder alert
    if (inv.reorder_point && qoh <= Number(inv.reorder_point)) {
      result.reorderAlerts.push({
        sku:           bom.component_sku,
        description:   bom.component_description,
        quantity_on_hand: qoh,
        reorder_point: Number(inv.reorder_point),
        reorder_qty:   Number(inv.reorder_quantity) || 0,
        vendor:        bom.primary_vendor,
      });
    }

    // Single-source risk
    if (!bom.secondary_vendor && bom.primary_vendor) {
      result.singleSourceRisks.push({
        sku:          bom.component_sku,
        description:  bom.component_description,
        parent_sku:   bom.parent_sku,
        vendor:       bom.primary_vendor,
        lead_time:    leadTime,
        coverage_days: coverageDays,
      });
    }
  });

  // Slow-moving and obsolete inventory (all inventory, not just BOM components)
  inventoryRecords.forEach(inv => {
    if (!inv.last_movement_date) return;
    const lastMoved = new Date(inv.last_movement_date);
    const daysSinceMove = Math.floor((now - lastMoved) / (1000 * 60 * 60 * 24));
    const value = (Number(inv.quantity_on_hand) || 0) * (Number(inv.unit_cost) || 0);

    if (daysSinceMove >= 180) {
      result.obsoleteRisk.push({ sku: inv.sku, description: inv.description, days_since_movement: daysSinceMove, value, quantity_on_hand: inv.quantity_on_hand });
      result.totalObsoleteValue += value;
    } else if (daysSinceMove >= 90) {
      result.slowMoving.push({ sku: inv.sku, description: inv.description, days_since_movement: daysSinceMove, value, quantity_on_hand: inv.quantity_on_hand });
      result.totalSlowMovingValue += value;
    }
  });

  // Sort by urgency
  result.criticalShortages.sort((a, b) => a.coverage_days - b.coverage_days);
  result.componentCoverage.sort((a, b) => (a.coverage_days ?? 9999) - (b.coverage_days ?? 9999));
  result.slowMoving.sort((a, b) => b.value - a.value);
  result.obsoleteRisk.sort((a, b) => b.value - a.value);

  return result;
}

// ─── 3. Capacity & Work Center Analysis ──────────────────────────────────────

/**
 * @typedef {Object} CapacityRecord
 * @property {string}  work_center_id
 * @property {string}  work_center_name
 * @property {number}  hours_available      - scheduled hours per period
 * @property {number}  hours_scheduled      - hours of work orders assigned
 * @property {number}  [hours_actual]       - actual hours logged
 * @property {string}  [department]
 * @property {number}  [operator_count]
 */

function analyzeCapacity(capacityRecords) {
  const result = {
    workCenters:     [],
    bottlenecks:     [],   // utilization > 85%
    underutilized:   [],   // utilization < 50%
    avgUtilization:  0,
    totalAvailHours: 0,
    totalSchedHours: 0,
  };

  capacityRecords.forEach(wc => {
    const avail     = Number(wc.hours_available)  || 0;
    const scheduled = Number(wc.hours_scheduled)  || 0;
    const actual    = Number(wc.hours_actual)      || null;
    const utilPct   = avail > 0 ? Math.round((scheduled / avail) * 100) : null;

    const entry = {
      work_center_id:   wc.work_center_id,
      work_center_name: wc.work_center_name,
      department:       wc.department,
      hours_available:  avail,
      hours_scheduled:  scheduled,
      hours_actual:     actual,
      utilization_pct:  utilPct,
      operator_count:   wc.operator_count,
      overloaded:       utilPct !== null && utilPct > 100,
    };

    result.workCenters.push(entry);
    result.totalAvailHours  += avail;
    result.totalSchedHours  += scheduled;

    if (utilPct !== null && utilPct >= 85) result.bottlenecks.push(entry);
    if (utilPct !== null && utilPct < 50)  result.underutilized.push(entry);
  });

  result.bottlenecks.sort((a, b) => b.utilization_pct - a.utilization_pct);
  result.underutilized.sort((a, b) => a.utilization_pct - b.utilization_pct);
  result.avgUtilization = result.totalAvailHours > 0
    ? Math.round((result.totalSchedHours / result.totalAvailHours) * 100) : 0;

  return result;
}

// ─── 4. Quality & Scrap Analysis ─────────────────────────────────────────────

/**
 * @typedef {Object} QualityRecord
 * @property {string}  work_order_id
 * @property {string}  job_type
 * @property {string}  work_center_id
 * @property {number}  quantity_produced
 * @property {number}  quantity_passed
 * @property {number}  [quantity_scrapped]
 * @property {number}  [quantity_reworked]
 * @property {string}  [scrap_reason]
 * @property {number}  [unit_cost]          - for scrap $ calculation
 */

function analyzeQuality(qualityRecords) {
  const result = {
    totalProduced:    0,
    totalPassed:      0,
    totalScrapped:    0,
    totalReworked:    0,
    overallFPY:       0,    // First Pass Yield %
    totalScrapCost:   0,
    byJobType:        {},
    byWorkCenter:     {},
    scrapReasons:     {},
    worstPerformers:  [],   // job types or work centers with FPY < 90%
  };

  qualityRecords.forEach(r => {
    const produced  = Number(r.quantity_produced)  || 0;
    const passed    = Number(r.quantity_passed)    || 0;
    const scrapped  = Number(r.quantity_scrapped)  || (produced - passed);
    const reworked  = Number(r.quantity_reworked)  || 0;
    const scrapCost = scrapped * (Number(r.unit_cost) || 0);

    result.totalProduced  += produced;
    result.totalPassed    += passed;
    result.totalScrapped  += scrapped;
    result.totalReworked  += reworked;
    result.totalScrapCost += scrapCost;

    // By job type
    if (r.job_type) {
      if (!result.byJobType[r.job_type])
        result.byJobType[r.job_type] = { produced: 0, passed: 0, scrapped: 0, scrapCost: 0 };
      result.byJobType[r.job_type].produced  += produced;
      result.byJobType[r.job_type].passed    += passed;
      result.byJobType[r.job_type].scrapped  += scrapped;
      result.byJobType[r.job_type].scrapCost += scrapCost;
    }

    // By work center
    if (r.work_center_id) {
      if (!result.byWorkCenter[r.work_center_id])
        result.byWorkCenter[r.work_center_id] = { produced: 0, passed: 0, scrapped: 0 };
      result.byWorkCenter[r.work_center_id].produced += produced;
      result.byWorkCenter[r.work_center_id].passed   += passed;
      result.byWorkCenter[r.work_center_id].scrapped += scrapped;
    }

    // Scrap reasons
    if (r.scrap_reason) {
      const k = r.scrap_reason.toLowerCase().trim();
      result.scrapReasons[k] = (result.scrapReasons[k] || 0) + scrapped;
    }
  });

  result.overallFPY = result.totalProduced > 0
    ? Math.round((result.totalPassed / result.totalProduced) * 100) : null;

  // Worst performers
  result.worstPerformers = Object.entries(result.byJobType)
    .map(([type, d]) => ({
      job_type:    type,
      fpy:         d.produced > 0 ? Math.round((d.passed / d.produced) * 100) : null,
      scrap_cost:  d.scrapCost,
      scrap_units: d.scrapped,
    }))
    .filter(d => d.fpy !== null && d.fpy < 95)
    .sort((a, b) => a.fpy - b.fpy);

  return result;
}

// ─── 5. On-Time Delivery Analysis ────────────────────────────────────────────

/**
 * @typedef {Object} DeliveryRecord
 * @property {string}  order_id
 * @property {string}  customer_id
 * @property {string}  customer_name
 * @property {string}  promised_ship_date
 * @property {string}  [revised_ship_date]   - if promise was already moved once
 * @property {string}  [actual_ship_date]
 * @property {string}  job_type
 * @property {number}  [order_value]
 */

function analyzeDeliveries(deliveryRecords, asOfDate = new Date()) {
  const now = new Date(asOfDate);

  const result = {
    total:          deliveryRecords.length,
    shipped:        0,
    onTime:         0,
    late:           0,
    pendingAtRisk:  [],   // not yet shipped but past promised date
    otdPct:         0,
    avgDaysLate:    0,
    byCustomer:     {},
    promiseSlippage: 0,   // orders where revised_ship > promised_ship
  };

  const lateDeltas = [];

  deliveryRecords.forEach(r => {
    const promised = r.promised_ship_date ? new Date(r.promised_ship_date) : null;
    const revised  = r.revised_ship_date  ? new Date(r.revised_ship_date)  : null;
    const actual   = r.actual_ship_date   ? new Date(r.actual_ship_date)   : null;

    if (revised && promised && revised > promised) result.promiseSlippage++;

    const targetDate = actual || now;
    const benchmarkDate = revised || promised;

    if (!benchmarkDate) return;

    if (actual) {
      result.shipped++;
      if (actual <= benchmarkDate) {
        result.onTime++;
      } else {
        result.late++;
        const daysLate = Math.ceil((actual - benchmarkDate) / (1000 * 60 * 60 * 24));
        lateDeltas.push(daysLate);
      }
    } else if (now > benchmarkDate) {
      // Not shipped, past due
      result.pendingAtRisk.push({
        order_id:      r.order_id,
        customer_name: r.customer_name,
        job_type:      r.job_type,
        promised_ship_date: r.promised_ship_date,
        days_overdue:  Math.ceil((now - benchmarkDate) / (1000 * 60 * 60 * 24)),
        order_value:   r.order_value,
      });
    }

    // By customer
    const key = r.customer_id || r.customer_name || "unknown";
    if (!result.byCustomer[key]) {
      result.byCustomer[key] = { name: r.customer_name || key, onTime: 0, late: 0, total: 0 };
    }
    result.byCustomer[key].total++;
    if (actual) {
      if (actual <= benchmarkDate) result.byCustomer[key].onTime++;
      else result.byCustomer[key].late++;
    }
  });

  result.otdPct = result.shipped > 0
    ? Math.round((result.onTime / result.shipped) * 100) : null;
  result.avgDaysLate = lateDeltas.length > 0
    ? Math.round(lateDeltas.reduce((a, b) => a + b, 0) / lateDeltas.length) : 0;

  result.pendingAtRisk.sort((a, b) => b.days_overdue - a.days_overdue);

  // Customer OTD scores
  result.byCustomer = Object.values(result.byCustomer)
    .filter(c => c.total >= 2)
    .map(c => ({ ...c, otd_pct: c.total > 0 ? Math.round((c.onTime / c.total) * 100) : null }))
    .sort((a, b) => (a.otd_pct ?? 100) - (b.otd_pct ?? 100));

  return result;
}

// ─── 6. Master prompt builder ─────────────────────────────────────────────────

/**
 * Builds the full ERP section text for the SWOT engine prompt.
 *
 * @param {Object} params
 * @param {WorkOrder[]}       [params.workOrders]
 * @param {BOMRecord[]}       [params.bom]
 * @param {InventoryRecord[]} [params.inventory]
 * @param {CapacityRecord[]}  [params.capacity]
 * @param {QualityRecord[]}   [params.quality]
 * @param {DeliveryRecord[]}  [params.deliveries]
 * @param {Date|string}       [params.asOfDate]
 * @returns {string}
 */
function buildERPSummary({
  workOrders = [], bom = [], inventory = [],
  capacity = [], quality = [], deliveries = [],
  asOfDate = new Date()
}) {
  const parts = [];
  const fmt   = n  => "$" + Math.round(n).toLocaleString();
  const pct   = n  => n !== null ? `${n}%` : "n/a";

  // ── Work Orders ──
  if (workOrders.length > 0) {
    const wo = analyzeWorkOrders(workOrders, asOfDate);
    const statusLine = Object.entries(wo.byStatus)
      .map(([s, n]) => `${s}: ${n}`).join(" | ");

    parts.push(`## WORK ORDERS (${wo.total} total)
Status breakdown: ${statusLine}
Schedule adherence: ${pct(wo.scheduleAdherence)} of completed jobs finished on or before due date
Late jobs (active): ${wo.lateJobs.length} · avg ${wo.avgDaysLate} days late
On-hold jobs: ${wo.onHoldJobs.length}${wo.onHoldJobs.length > 0 ? " — " + wo.onHoldJobs.map(j => `${j.work_order_id} (${j.on_hold_reason})`).slice(0,3).join(", ") : ""}

${wo.lateJobs.length > 0 ? `TOP LATE JOBS (by priority):
${wo.lateJobs.slice(0, 5).map(j =>
  `  WO ${j.work_order_id} · ${j.customer_name} · ${j.job_type} · ${j.days_late} days late · status: ${j.status}`
).join("\n")}` : "No active late jobs."}

${wo.efficiencyByJobType.length > 0 ? `HOURS EFFICIENCY BY JOB TYPE (actual vs planned):
${wo.efficiencyByJobType.slice(0, 5).map(e =>
  `  ${e.job_type}: ${e.avgVariancePct > 0 ? "+" : ""}${e.avgVariancePct}% avg variance (${e.sampleSize} jobs)`
).join("\n")}` : ""}`);
  }

  // ── MRP / Inventory ──
  if (bom.length > 0 || inventory.length > 0) {
    const mrp = analyzeMRP(bom, inventory, workOrders, asOfDate);

    parts.push(`## MATERIALS PLANNING (${bom.length} BOM lines · ${inventory.length} inventory SKUs)

CRITICAL SHORTAGES — will run out before resupply (${mrp.criticalShortages.length}):
${mrp.criticalShortages.length > 0
  ? mrp.criticalShortages.slice(0, 8).map(s =>
    `  [${s.urgency.toUpperCase()}] ${s.sku} · ${s.description} · ${s.coverage_days}d coverage vs ${s.lead_time_days}d lead time · vendor: ${s.vendor || "unknown"}`
  ).join("\n")
  : "  None — all components have adequate coverage."}

REORDER ALERTS (${mrp.reorderAlerts.length} SKUs at or below reorder point):
${mrp.reorderAlerts.slice(0, 5).map(r =>
  `  ${r.sku} · ${r.description} · on hand: ${r.quantity_on_hand} · reorder point: ${r.reorder_point}`
).join("\n") || "  None."}

SINGLE-SOURCE RISKS (${mrp.singleSourceRisks.length} components — no backup vendor):
${mrp.singleSourceRisks.slice(0, 5).map(r =>
  `  ${r.sku} · ${r.description} · only vendor: ${r.vendor} · lead time ${r.lead_time}d`
).join("\n") || "  None detected."}

SLOW-MOVING INVENTORY (90–180 days no movement): ${mrp.slowMoving.length} SKUs · ${fmt(mrp.totalSlowMovingValue)} tied up
OBSOLETE RISK (180+ days no movement): ${mrp.obsoleteRisk.length} SKUs · ${fmt(mrp.totalObsoleteValue)} at risk
${mrp.obsoleteRisk.slice(0, 3).map(r =>
  `  ${r.sku} · ${r.description} · ${r.days_since_movement}d · ${fmt(r.value)}`
).join("\n")}`);
  }

  // ── Capacity ──
  if (capacity.length > 0) {
    const cap = analyzeCapacity(capacity);

    parts.push(`## CAPACITY & WORK CENTERS (${capacity.length} work centers)
Overall utilization: ${pct(cap.avgUtilization)} (${cap.totalSchedHours} scheduled hrs / ${cap.totalAvailHours} available hrs)

BOTTLENECKS (≥85% utilized — ${cap.bottlenecks.length} work centers):
${cap.bottlenecks.map(b =>
  `  ${b.work_center_name}: ${b.utilization_pct}% utilized${b.overloaded ? " ⚠ OVERLOADED" : ""}`
).join("\n") || "  None."}

UNDERUTILIZED (< 50% — ${cap.underutilized.length} work centers):
${cap.underutilized.map(u =>
  `  ${u.work_center_name}: ${u.utilization_pct}% utilized · ${u.hours_available - u.hours_scheduled} hrs available`
).join("\n") || "  None."}`);
  }

  // ── Quality ──
  if (quality.length > 0) {
    const q = analyzeQuality(quality);
    const topScrapReasons = Object.entries(q.scrapReasons)
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([r, n]) => `"${r}" (${n} units)`).join(", ");

    parts.push(`## QUALITY & SCRAP (${quality.length} job records)
Overall first-pass yield: ${pct(q.overallFPY)}
Total scrapped: ${q.totalScrapped} units · estimated cost: ${fmt(q.totalScrapCost)}
Total reworked: ${q.totalReworked} units
Top scrap reasons: ${topScrapReasons || "not recorded"}

WORST-PERFORMING JOB TYPES (FPY < 95%):
${q.worstPerformers.slice(0, 5).map(w =>
  `  ${w.job_type}: ${w.fpy}% FPY · ${w.scrap_units} units scrapped · ${fmt(w.scrap_cost)} in scrap cost`
).join("\n") || "  All job types at or above 95% FPY."}`);
  }

  // ── On-Time Delivery ──
  if (deliveries.length > 0) {
    const del = analyzeDeliveries(deliveries, asOfDate);

    parts.push(`## ON-TIME DELIVERY (${del.total} orders)
OTD rate: ${pct(del.otdPct)} (${del.onTime} on time, ${del.late} late of ${del.shipped} shipped)
Avg days late (when late): ${del.avgDaysLate}
Promise slippage (revised ship date pushed out): ${del.promiseSlippage} orders
Pending at risk (not shipped, past due): ${del.pendingAtRisk.length}
${del.pendingAtRisk.slice(0, 4).map(r =>
  `  ${r.order_id} · ${r.customer_name} · ${r.days_overdue}d overdue`
).join("\n")}

CUSTOMER OTD SCORES:
${del.byCustomer.slice(0, 6).map(c =>
  `  ${c.name}: ${pct(c.otd_pct)} (${c.total} orders)`
).join("\n") || "  Insufficient data."}`);
  }

  return parts.join("\n\n");
}

// ─── Example usage ────────────────────────────────────────────────────────────

const today = new Date("2024-04-08");

const sampleWorkOrders = [
  { work_order_id:"WO-001", status:"in-progress", job_type:"Hydraulic Fittings",  customer_name:"Midwest Tooling",    scheduled_start:"2024-03-25", scheduled_end:"2024-04-05", quantity_planned:200, planned_hours:40, actual_hours:38, priority:1 },
  { work_order_id:"WO-002", status:"in-progress", job_type:"Custom Fabrication",   customer_name:"Great Lakes Mfg",    scheduled_start:"2024-03-20", scheduled_end:"2024-03-30", quantity_planned:50,  planned_hours:60, actual_hours:74, priority:2 },
  { work_order_id:"WO-003", status:"on-hold",     job_type:"Sheet Metal",           customer_name:"Apex Assemblies",    scheduled_start:"2024-04-01", scheduled_end:"2024-04-10", quantity_planned:100, on_hold_reason:"Missing raw material", priority:1 },
  { work_order_id:"WO-004", status:"complete",    job_type:"Hydraulic Fittings",    customer_name:"Precision Parts Co", scheduled_start:"2024-03-01", scheduled_end:"2024-03-15", actual_end:"2024-03-14", quantity_planned:150, planned_hours:30, actual_hours:28 },
  { work_order_id:"WO-005", status:"complete",    job_type:"Welding & Assembly",    customer_name:"Midwest Tooling",    scheduled_start:"2024-03-10", scheduled_end:"2024-03-20", actual_end:"2024-03-26", quantity_planned:75,  planned_hours:20, actual_hours:29 },
  { work_order_id:"WO-006", status:"open",        job_type:"Precision Machining",   customer_name:"Great Lakes Mfg",    scheduled_start:"2024-04-10", scheduled_end:"2024-04-20", quantity_planned:80,  priority:3 },
];

const sampleBOM = [
  { parent_sku:"HF-100", parent_description:"Hydraulic Fitting Assy",  component_sku:"STL-304",  component_description:"304 Stainless Rod",    quantity_per:2, lead_time_days:14, primary_vendor:"Steel Supply Co",  secondary_vendor:"Metro Metals" },
  { parent_sku:"HF-100", parent_description:"Hydraulic Fitting Assy",  component_sku:"ORG-BN90", component_description:"Buna-N O-Ring 90",     quantity_per:4, lead_time_days:7,  primary_vendor:"Fastener World",   secondary_vendor:null },
  { parent_sku:"CF-200", parent_description:"Custom Fab Panel",         component_sku:"ALU-6061", component_description:"6061 Aluminum Sheet",  quantity_per:1, lead_time_days:21, primary_vendor:"Coastal Metals",   secondary_vendor:null },
  { parent_sku:"SM-300", parent_description:"Sheet Metal Enclosure",    component_sku:"GS-18GA",  component_description:"18GA Galv Steel Sheet",quantity_per:3, lead_time_days:10, primary_vendor:"Metal Fab Supply", secondary_vendor:"Steel Supply Co" },
];

const sampleInventory = [
  { sku:"STL-304",  description:"304 Stainless Rod",     quantity_on_hand:180, quantity_on_order:500, reorder_point:200, reorder_quantity:1000, avg_daily_usage:25, unit_cost:4.20,  last_movement_date:"2024-04-07" },
  { sku:"ORG-BN90", description:"Buna-N O-Ring 90",      quantity_on_hand:40,  quantity_on_order:0,   reorder_point:500, reorder_quantity:2000, avg_daily_usage:80, unit_cost:0.18,  last_movement_date:"2024-04-06" },
  { sku:"ALU-6061", description:"6061 Aluminum Sheet",   quantity_on_hand:12,  quantity_on_order:0,   reorder_point:20,  reorder_quantity:100,  avg_daily_usage:8,  unit_cost:28.00, last_movement_date:"2024-04-02" },
  { sku:"GS-18GA",  description:"18GA Galv Steel Sheet", quantity_on_hand:220, quantity_on_order:0,   reorder_point:100, reorder_quantity:500,  avg_daily_usage:15, unit_cost:6.50,  last_movement_date:"2024-04-05" },
  { sku:"BRS-NPT",  description:"Brass NPT Fitting",     quantity_on_hand:840, quantity_on_order:0,   reorder_point:200, reorder_quantity:500,  avg_daily_usage:0,  unit_cost:1.80,  last_movement_date:"2023-09-10" },
  { sku:"ZNC-PLT",  description:"Zinc Plated Hardware",  quantity_on_hand:2400,quantity_on_order:0,   reorder_point:500, reorder_quantity:1000, avg_daily_usage:0,  unit_cost:0.45,  last_movement_date:"2023-06-15" },
];

const sampleCapacity = [
  { work_center_id:"WC-01", work_center_name:"CNC Turning",     department:"Machining",  hours_available:160, hours_scheduled:152, hours_actual:148 },
  { work_center_id:"WC-02", work_center_name:"CNC Milling",     department:"Machining",  hours_available:160, hours_scheduled:88,  hours_actual:84  },
  { work_center_id:"WC-03", work_center_name:"Welding Bay",      department:"Fabrication",hours_available:120, hours_scheduled:118, hours_actual:null },
  { work_center_id:"WC-04", work_center_name:"Sheet Metal Press",department:"Fabrication",hours_available:160, hours_scheduled:64,  hours_actual:60  },
  { work_center_id:"WC-05", work_center_name:"Assembly",         department:"Assembly",   hours_available:200, hours_scheduled:196, hours_actual:210 },
];

const sampleQuality = [
  { work_order_id:"WO-004", job_type:"Hydraulic Fittings",  work_center_id:"WC-01", quantity_produced:150, quantity_passed:147, quantity_scrapped:3,  scrap_reason:"Dimensional variance", unit_cost:12.00 },
  { work_order_id:"WO-005", job_type:"Welding & Assembly",  work_center_id:"WC-03", quantity_produced:75,  quantity_passed:61,  quantity_scrapped:14, scrap_reason:"Weld defect",          unit_cost:28.00 },
  { work_order_id:"WO-002", job_type:"Custom Fabrication",  work_center_id:"WC-04", quantity_produced:50,  quantity_passed:42,  quantity_scrapped:6,  quantity_reworked:2, scrap_reason:"Material defect", unit_cost:45.00 },
];

const sampleDeliveries = [
  { order_id:"ORD-101", customer_name:"Midwest Tooling",    job_type:"Hydraulic Fittings", promised_ship_date:"2024-03-15", actual_ship_date:"2024-03-14", order_value:8400 },
  { order_id:"ORD-102", customer_name:"Great Lakes Mfg",    job_type:"Custom Fabrication",  promised_ship_date:"2024-03-30", actual_ship_date:"2024-04-06", order_value:12000 },
  { order_id:"ORD-103", customer_name:"Apex Assemblies",    job_type:"Sheet Metal",         promised_ship_date:"2024-04-01", actual_ship_date:null,         order_value:5500 },
  { order_id:"ORD-104", customer_name:"Precision Parts Co", job_type:"Hydraulic Fittings", promised_ship_date:"2024-03-20", actual_ship_date:"2024-03-19", order_value:9200 },
  { order_id:"ORD-105", customer_name:"Midwest Tooling",    job_type:"Welding & Assembly",  promised_ship_date:"2024-03-20", revised_ship_date:"2024-03-28", actual_ship_date:"2024-04-02", order_value:7800 },
];

const summary = buildERPSummary({
  workOrders: sampleWorkOrders,
  bom:        sampleBOM,
  inventory:  sampleInventory,
  capacity:   sampleCapacity,
  quality:    sampleQuality,
  deliveries: sampleDeliveries,
  asOfDate:   today
});

console.log(summary);

module.exports = { buildERPSummary, analyzeWorkOrders, analyzeMRP, analyzeCapacity, analyzeQuality, analyzeDeliveries };

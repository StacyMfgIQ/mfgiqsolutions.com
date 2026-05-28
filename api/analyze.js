/**
 * MfgIQ Solutions — Analysis API Endpoint
 * Vercel Serverless Function (/api/analyze)
 */

// SheetJS must be available as a global before fileParser.js is required
const XLSX = require('xlsx');
global.XLSX = XLSX;

const { createClient } = require('@supabase/supabase-js');
const { ingestFiles, formatIngestionReport } = require('../MfgIQJs_ToolFiles/ingestionOrchestrator');
const { runSWOTAnalysis } = require('../MfgIQJs_ToolFiles/swotEngine (1)');

module.exports = async function handler(req, res) {

  // ── CORS headers ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth: verify Supabase JWT ─────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: { user }, error: authErr } = await sb.auth.getUser(token);

  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // ── Parse request body ────────────────────────────────────────────────────
  const { filePaths, companyName = 'the company', userId } = req.body || {};

  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths array is required' });
  }

  // Security: files must belong to this user
  const unauthorized = filePaths.find(p => !p.startsWith(`${user.id}/`));

  if (unauthorized) {
    return res.status(403).json({ error: 'Access denied to one or more files' });
  }

  try {

    // ── Download files from Supabase Storage ──────────────────────────────
    const fileObjects = await Promise.all(
      filePaths.map(async (path) => {
        const { data, error } = await sb.storage
          .from('customer-files')
          .download(path);

        if (error) throw new Error(`Could not retrieve file: ${path}`);

        const buffer = Buffer.from(await data.arrayBuffer());
        const name   = path.split('/').pop().replace(/^\d+_/, '');

        return { name, buffer };
      })
    );

    // ── Run ingestion pipeline ────────────────────────────────────────────
    const bundle = await ingestFiles(fileObjects, {
      companyName,
      asOfDate: new Date(),
    });

    console.log('[MfgIQ] Ingestion report:\n', formatIngestionReport(bundle));

    // Check we have usable data
    const totalRows = [
      bundle.sales, bundle.ar, bundle.ap, bundle.workOrders,
      bundle.bom, bundle.inventory, bundle.capacity,
      bundle.quality, bundle.deliveries, bundle.logistics,
    ].reduce((sum, arr) => sum + (arr?.length || 0), 0);

    if (totalRows === 0) {
      return res.status(422).json({
        error: 'No usable data found in the uploaded files. Please check the file contains data rows and try again.',
        ingestionReport: formatIngestionReport(bundle),
      });
    }

    // ── Run SWOT analysis ─────────────────────────────────────────────────
    const swot = await runSWOTAnalysis(bundle, {
      companyName,
      topN: 4,
    });

    swot._meta = {
      analyzedAt:  new Date().toISOString(),
      companyName,
      totalRows,
      fileCount:   filePaths.length,
      domains:     getDomainSummary(bundle),
    };

    return res.status(200).json(swot);

  } catch (err) {
    console.error('[MfgIQ] Analysis error:', err);
    return res.status(500).json({
      error: err.message || 'Analysis failed — please try again.',
    });
  }

};

function getDomainSummary(bundle) {
  const domains = ['sales','ar','ap','workOrders','bom','inventory','capacity','quality','deliveries','logistics'];
  return domains
    .filter(d => bundle[d]?.length > 0)
    .map(d => `${d}(${bundle[d].length})`);
}

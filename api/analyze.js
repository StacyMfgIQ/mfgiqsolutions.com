/**
 * MfgIQ Solutions — Analysis API Endpoint
 * Vercel Serverless Function  (/api/analyze)
 *
 * Receives file paths from Supabase Storage,
 * runs the full ingestion + SWOT pipeline,
 * and returns a structured SWOT report JSON.
 *
 * POST /api/analyze
 * Headers: Authorization: Bearer <supabase_jwt>
 * Body:    { filePaths: string[], companyName: string, userId: string }
 */

const { createClient } = require('@supabase/supabase-js');
const { ingestFiles, formatIngestionReport } = require('../MfgIQJs_ToolFiles/ingestionOrchestrator');
const { runSWOTAnalysis } = require('../MfgIQJs_ToolFiles/swotEngine (1)');

// ─── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(CORS).end();
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).set(CORS).json({ error: 'Method not allowed' });
  }

  // ── Auth: verify Supabase JWT ──────────────────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).set(CORS).json({ error: 'Missing authorization token' });
  }

  // Initialize Supabase with the service role key for server-side operations
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY  // service role key (never expose to browser)
  );

  // Verify the user's JWT is valid
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).set(CORS).json({ error: 'Invalid or expired session' });
  }

  // ── Parse request body ─────────────────────────────────────────────────────
  const { filePaths, companyName = 'the company', userId } = req.body || {};

  if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).set(CORS).json({ error: 'filePaths array is required' });
  }

  // Security check: make sure the files belong to this user
  const unauthorizedFile = filePaths.find(p => !p.startsWith(`${user.id}/`));
  if (unauthorizedFile) {
    return res.status(403).set(CORS).json({ error: 'Access denied to one or more files' });
  }

  try {
    // ── Download files from Supabase Storage ──────────────────────────────────
    const fileObjects = await Promise.all(
      filePaths.map(async (path) => {
        const { data, error } = await sb.storage
          .from('customer-files')
          .download(path);

        if (error) throw new Error(`Could not retrieve file: ${path}`);

        // Convert Blob to Buffer with file name preserved
        const buffer = Buffer.from(await data.arrayBuffer());
        const name   = path.split('/').pop().replace(/^\d+_/, ''); // strip timestamp prefix
        return { name, buffer };
      })
    );

    // ── Run ingestion pipeline ─────────────────────────────────────────────────
    const bundle = await ingestFiles(fileObjects, {
      companyName,
      asOfDate: new Date(),
    });

    console.log('[MfgIQ] Ingestion complete for user', user.id);
    console.log('[MfgIQ]', formatIngestionReport(bundle));

    // Check if we have any usable data
    const totalRows = [
      bundle.sales, bundle.ar, bundle.ap, bundle.workOrders,
      bundle.bom, bundle.inventory, bundle.capacity,
      bundle.quality, bundle.deliveries, bundle.logistics,
    ].reduce((sum, arr) => sum + (arr?.length || 0), 0);

    if (totalRows === 0) {
      return res.status(422).set(CORS).json({
        error: 'No usable data found in the uploaded files. Please check that the files contain the expected columns and try again.',
        ingestionReport: formatIngestionReport(bundle),
      });
    }

    // ── Run SWOT analysis ──────────────────────────────────────────────────────
    const swot = await runSWOTAnalysis(bundle, {
      companyName,
      topN: 4,
    });

    // Attach metadata
    swot._meta = {
      analyzedAt:  new Date().toISOString(),
      companyName,
      totalRows,
      fileCount:   filePaths.length,
      domains:     getDomainSummary(bundle),
    };

    return res.status(200).set(CORS).json(swot);

  } catch (err) {
    console.error('[MfgIQ] Analysis error:', err);
    return res.status(500).set(CORS).json({
      error: err.message || 'Analysis failed — please try again.',
    });
  }
};

// ─── Helper: summarize which domains had data ──────────────────────────────
function getDomainSummary(bundle) {
  const domains = ['sales','ar','ap','workOrders','bom','inventory','capacity','quality','deliveries','logistics'];
  return domains
    .filter(d => bundle[d]?.length > 0)
    .map(d => `${d}(${bundle[d].length})`);
}

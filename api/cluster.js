/* ============================================================
   /api/cluster.js — Vercel serverless proxy for SERP-overlap
   keyword clustering. Holds DataForSEO creds server-side so they
   never reach the browser. Node 18+ (global fetch, Basic auth).

   POST body:
     { keywords: string[],           // 2..MAX_KEYWORDS
       location_name?: string,       // default "United States"
       language_code?: string,       // default "en"
       threshold?: number,           // shared-URL merge threshold (default 3)
       enrich?: boolean,             // pull volume/difficulty/intent (default true)
       creds?: { login, password } } // optional BYO; else server env

   Returns { clusters, matrix, keywords, meta } or { error }.
   ============================================================ */

const {
  extractRankingUrls,
  clusterKeywords,
  pickPrimary,
} = require('./cluster-core.js');

const MAX_KEYWORDS = 50;            // hard cap: bounds cost & runtime
const DFS_BASE = 'https://api.dataforseo.com/v3';
// Approx list prices (USD) for the cost estimate shown to the user.
const COST_PER_SERP = 0.002;       // serp/google/organic/live/advanced
const COST_PER_OVERVIEW = 0.0001;  // dataforseo_labs keyword_overview, per keyword

function authHeader(login, password) {
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

async function dfsPost(path, auth, body) {
  const res = await fetch(DFS_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status_code >= 40000) {
    throw new Error(`DataForSEO ${path}: ${json.status_message || res.status}`);
  }
  return json;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const location_name = body.location_name || 'United States';
    const language_code = body.language_code || 'en';
    const threshold = Number.isFinite(body.threshold) ? body.threshold : 3;
    const enrich = body.enrich !== false;

    // Clean + dedupe keyword list, enforce the cap.
    const keywords = [...new Set((body.keywords || [])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean))];
    if (keywords.length < 2) {
      res.status(400).json({ error: 'Provide at least 2 keywords.' });
      return;
    }
    if (keywords.length > MAX_KEYWORDS) {
      res.status(400).json({ error: `Max ${MAX_KEYWORDS} keywords per run (got ${keywords.length}).` });
      return;
    }

    // Credentials: BYO from body wins, else server env. Trim to defend against
    // whitespace/newlines pasted into stored secrets.
    const login = (body.creds?.login || process.env.DFS_LOGIN || '').trim();
    const password = (body.creds?.password || process.env.DFS_PASSWORD || '').trim();
    if (!login || !password) {
      res.status(401).json({ error: 'No DataForSEO credentials configured.' });
      return;
    }
    const auth = authHeader(login, password);

    // 1) One SERP call per keyword. DataForSEO's live/advanced only fully
    //    populates the FIRST task when several are batched in one POST, so we
    //    fan out one request per keyword (limited concurrency) and key results
    //    by the input keyword directly.
    const urlsByKeyword = new Map();
    const featuresByKeyword = new Map();
    const CONCURRENCY = 10;
    for (let i = 0; i < keywords.length; i += CONCURRENCY) {
      await Promise.all(keywords.slice(i, i + CONCURRENCY).map(async (keyword) => {
        const resp = await dfsPost('/serp/google/organic/live/advanced', auth,
          [{ keyword, location_name, language_code, depth: 10 }]);
        const items = resp.tasks?.[0]?.result?.[0]?.items || [];
        urlsByKeyword.set(keyword, new Set(extractRankingUrls(items)));
        featuresByKeyword.set(keyword,
          [...new Set(items.map((it) => it.type))].filter((t) => t && t !== 'organic'));
      }));
    }

    // 2) Optional enrichment: volume / difficulty / intent in one call.
    const infoByKeyword = new Map();
    if (enrich) {
      try {
        const ovResp = await dfsPost('/dataforseo_labs/google/keyword_overview/live', auth,
          [{ keywords, location_name, language_code }]);
        for (const item of ovResp.tasks?.[0]?.result?.[0]?.items || []) {
          infoByKeyword.set(String(item.keyword || '').toLowerCase(), {
            volume: item.keyword_info?.search_volume ?? null,
            difficulty: item.keyword_properties?.keyword_difficulty ?? null,
            intent: item.search_intent_info?.main_intent ?? null,
          });
        }
      } catch (e) {
        // Enrichment is best-effort; clustering still works without it.
        console.warn('enrichment failed:', e.message);
      }
    }

    // 3) Cluster.
    const entries = keywords.map((keyword) => {
      const info = infoByKeyword.get(keyword) || {};
      return {
        keyword,
        urls: urlsByKeyword.get(keyword) || new Set(),
        volume: info.volume ?? null,
        difficulty: info.difficulty ?? null,
        intent: info.intent ?? null,
        features: featuresByKeyword.get(keyword) || [],
      };
    });
    const { clusters, matrix } = clusterKeywords(entries, threshold);

    // 4) Shape the response for the UI.
    const shaped = clusters.map((c) => {
      const primaryIdx = pickPrimary(c.members, entries, matrix, threshold);
      const sharedUrls = [...new Set(c.edges.flatMap((e) => {
        const a = entries[e.i].urls, b = entries[e.j].urls;
        return [...a].filter((u) => b.has(u));
      }))];
      return {
        primary: entries[primaryIdx].keyword,
        intent: entries[primaryIdx].intent,
        features: [...new Set(c.members.flatMap((m) => entries[m].features))],
        keywords: c.members.map((m) => ({
          keyword: entries[m].keyword,
          volume: entries[m].volume,
          difficulty: entries[m].difficulty,
          intent: entries[m].intent,
          urlCount: entries[m].urls.size,
        })),
        shared_urls: sharedUrls,
      };
    });

    const estCost = keywords.length * COST_PER_SERP + (enrich ? keywords.length * COST_PER_OVERVIEW : 0);
    res.status(200).json({
      clusters: shaped,
      matrix,
      keywords,
      meta: {
        keyword_count: keywords.length,
        cluster_count: shaped.length,
        threshold,
        location_name,
        language_code,
        est_cost_usd: Number(estCost.toFixed(4)),
        source: 'DataForSEO SERP + Labs',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Clustering failed.' });
  }
};

/* ============================================================
   functions/api/cluster.js — Cloudflare Pages Function.
   Same contract as the Vercel version (POST /api/cluster) but in
   Workers style: export onRequestPost({ request, env }).
   Reuses the unit-tested engine in api/cluster-core.js.
   Creds come from Pages env vars (env.DFS_LOGIN / env.DFS_PASSWORD),
   never the browser. Optional per-request creds still supported.
   ============================================================ */

import core from '../_lib/cluster-core.js';
const { extractRankingUrls, clusterKeywords, pickPrimary } = core;

const MAX_KEYWORDS = 50;
const DFS_BASE = 'https://api.dataforseo.com/v3';
const COST_PER_SERP = 0.002;
const COST_PER_OVERVIEW = 0.0001;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function authHeader(login, password) {
  return 'Basic ' + btoa(`${login}:${password}`);
}

async function dfsPost(path, auth, body) {
  const res = await fetch(DFS_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status_code >= 40000) {
    throw new Error(`DataForSEO ${path}: ${data.status_message || res.status}`);
  }
  return data;
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const location_name = body.location_name || 'United States';
    const language_code = body.language_code || 'en';
    const threshold = Number.isFinite(body.threshold) ? body.threshold : 3;
    const enrich = body.enrich !== false;

    const keywords = [...new Set((body.keywords || [])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean))];
    if (keywords.length < 2) return json({ error: 'Provide at least 2 keywords.' }, 400);
    if (keywords.length > MAX_KEYWORDS) {
      return json({ error: `Max ${MAX_KEYWORDS} keywords per run (got ${keywords.length}).` }, 400);
    }

    // Trim to defend against whitespace/newlines pasted into dashboard secrets.
    const login = (body.creds?.login || env.DFS_LOGIN || '').trim();
    const password = (body.creds?.password || env.DFS_PASSWORD || '').trim();
    if (!login || !password) return json({ error: 'No DataForSEO credentials configured.' }, 401);
    const auth = authHeader(login, password);

    // 1) One SERP call per keyword. DataForSEO's live/advanced endpoint only
    //    fully populates the FIRST task when several are batched in one POST,
    //    so we fan out one request per keyword with limited concurrency and
    //    key results by the input keyword directly (no response-key matching).
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

    // 2) Optional enrichment.
    const infoByKeyword = new Map();
    if (enrich) {
      try {
        const ov = await dfsPost('/dataforseo_labs/google/keyword_overview/live', auth,
          [{ keywords, location_name, language_code }]);
        for (const item of ov.tasks?.[0]?.result?.[0]?.items || []) {
          infoByKeyword.set(String(item.keyword || '').toLowerCase(), {
            volume: item.keyword_info?.search_volume ?? null,
            difficulty: item.keyword_properties?.keyword_difficulty ?? null,
            intent: item.search_intent_info?.main_intent ?? null,
          });
        }
      } catch (e) { /* best-effort */ }
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

    // 4) Shape response.
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
    return json({
      clusters: shaped,
      matrix,
      keywords,
      meta: {
        keyword_count: keywords.length,
        cluster_count: shaped.length,
        threshold, location_name, language_code,
        est_cost_usd: Number(estCost.toFixed(4)),
        source: 'DataForSEO SERP + Labs',
      },
    });
  } catch (err) {
    return json({ error: err.message || 'Clustering failed.' }, 500);
  }
}

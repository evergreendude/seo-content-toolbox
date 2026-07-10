/* ============================================================
   cluster-core.js — SERP-overlap keyword clustering (pure logic)
   Shared by /api/cluster.js (serverless) and the offline test.
   No network, no secrets. CommonJS so Node + Vercel both load it.
   ============================================================ */

// Tracking / locale params that must NOT affect URL identity.
const DROP_PARAMS = /^(srsltid|utm_.*|sca_esv|hl|gl|sa|ved|usg|vl|fir|source|ref|ref_src|spm)$/i;

/* Normalize a URL for overlap matching:
   - drop protocol, leading www, trailing slash, fragment
   - keep meaningful query (e.g. YouTube ?v=ID) but strip tracking params
   Two URLs are "the same ranking result" iff their normal forms match. */
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...url.searchParams.entries()]
      .filter(([k]) => !DROP_PARAMS.test(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
    return host + path + (qs ? '?' + qs : '');
  } catch {
    return String(u || '').trim().toLowerCase();
  }
}

/* Pull ranking URLs out of a DataForSEO SERP `items` array.
   Default = classic organic results only (the signal Google is giving us
   about which page satisfies the query). Video carousels, "perspectives",
   PAA, images, shopping are intentionally excluded. */
function extractRankingUrls(items, includeTypes = ['organic']) {
  const out = [];
  for (const it of items || []) {
    if (includeTypes.includes(it.type) && it.url) out.push(normalizeUrl(it.url));
  }
  return [...new Set(out)];
}

/* Count shared normalized URLs between two Sets. */
function sharedCount(a, b) {
  let n = 0;
  for (const u of a) if (b.has(u)) n++;
  return n;
}

/* Single-linkage clustering via union-find.
   entries: [{ keyword, urls:Set<string>, ...meta }]
   Two keywords join the same cluster when they share >= threshold URLs.
   Returns { clusters:[{members:[idx], edges:[{i,j,shared}]}], matrix }. */
function clusterKeywords(entries, threshold = 3) {
  const n = entries.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const edges = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = sharedCount(entries[i].urls, entries[j].urls);
      matrix[i][j] = matrix[j][i] = shared;
      if (shared >= threshold) {
        union(i, j);
        edges.push({ i, j, shared });
      }
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(i);
  }

  const clusters = [...byRoot.values()].map((members) => ({
    members,
    edges: edges.filter((e) => members.includes(e.i) && members.includes(e.j)),
  }));

  // Biggest, then strongest clusters first.
  clusters.sort((a, b) => b.members.length - a.members.length);
  return { clusters, matrix };
}

/* Choose the keyword a cluster's page should target:
   highest search volume, tie-break by intra-cluster connectedness (degree),
   final tie-break by shortest keyword (usually the head term). */
function pickPrimary(members, entries, matrix, threshold) {
  return [...members].sort((a, b) => {
    const va = entries[a].volume ?? -1, vb = entries[b].volume ?? -1;
    if (vb !== va) return vb - va;
    const da = members.filter((m) => m !== a && matrix[a][m] >= threshold).length;
    const db = members.filter((m) => m !== b && matrix[b][m] >= threshold).length;
    if (db !== da) return db - da;
    return entries[a].keyword.length - entries[b].keyword.length;
  })[0];
}

module.exports = {
  normalizeUrl,
  extractRankingUrls,
  sharedCount,
  clusterKeywords,
  pickPrimary,
};

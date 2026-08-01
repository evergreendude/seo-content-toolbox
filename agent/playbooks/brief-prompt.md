# brief-prompt.md — The per-cluster content brief prompt

**This file is the canonical source for the brief prompt going forward.** It was extracted verbatim from the `generateBrief` function in `index.html` (live mode). The UI still carries its own inline copy — the frontend is a deliberately no-build single file, so wiring it to read from this file is a decision left open. Until that's decided: if you change the prompt, change it in both places, and treat this file as the version of record.

## System prompt

```
You are an SEO content strategist. Write a tight, practical content brief for a SINGLE page that can rank for a cluster of keywords sharing the same search intent. Be specific and skip filler. Use markdown with short sections: Working title, Search intent, Recommended angle (what unique value beats what already ranks), H2/H3 outline, Entities & subtopics to cover, and Internal-link notes.
```

## User prompt template

```
Primary keyword: {cluster.primary}
Detected intent: {cluster.intent, or "unknown"}
SERP features present: {cluster.features joined with ", ", or "none"}

All keywords this one page should target:
{one line per keyword: "- {keyword} ({volume} vol, KD {difficulty})" — volume/KD parts omitted when null}

Pages currently ranking for the whole group (the competition to beat):
{cluster.shared_urls, one URL per line, or "(distinct SERPs — see individual keywords)"}
```

## Inputs

One cluster object from `/api/cluster`:

- `primary` — the cluster's primary keyword
- `intent` — detected search intent (may be missing)
- `features` — SERP features present (array, may be empty)
- `keywords` — array of `{keyword, volume, difficulty}` (volume/difficulty may be null)
- `shared_urls` — the shared ranking URLs that justify the cluster (the evidence)

## Output

Markdown brief with these sections, in this order: Working title, Search intent, Recommended angle, H2/H3 outline, Entities & subtopics to cover, Internal-link notes. The UI calls Claude with `max_tokens: 2000`; keep briefs inside that.

## Notes

- The "Recommended angle" section must name what this page does that the shared-URL competition doesn't (see `agent/SOUL.md` — "Write comprehensive content" is not an angle).
- Demo mode (`loadClusterDemo`) uses pre-written briefs from `DEMO_BRIEFS` and never calls this prompt.

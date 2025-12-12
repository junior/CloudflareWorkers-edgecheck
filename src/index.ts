export interface Env {
  EDGE_STATS: KVNamespace;
}

type Cf = {
  colo?: string;
  country?: string;
  region?: string;
  city?: string;
  continent?: string;
  timezone?: string;
  asn?: number;
  asOrganization?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  tlsCipher?: string;
  clientTcpRtt?: number; // ms, when available
};

function getCf(request: Request): Cf {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((request as any).cf ?? {}) as Cf;
}

function msLabel(ms: number | null | undefined) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms === 0) return "<1 ms";
  return `${Math.round(ms)} ms`;
}

function verdict(ms?: number) {
  if (ms == null) return { label: "Unknown speed", emoji: "🫥" };
  if (ms <= 10) return { label: "Blazing edge-fast", emoji: "⚡️" };
  if (ms <= 30) return { label: "Very fast", emoji: "🚀" };
  if (ms <= 60) return { label: "Pretty good", emoji: "✅" };
  if (ms <= 120) return { label: "Average", emoji: "🟡" };
  return { label: "Slow-ish (maybe Wi-Fi/4G?)", emoji: "🐢" };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function countryFlagEmoji(country: string) {
  if (!country || country.length !== 2) return "";
  return country.toUpperCase().split('').map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
}

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
    ...init,
  });
}

function todayKey(): string {
  // Stats bucket by UTC day
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function recordRun(env: Env, cf: Cf, edgeRtt?: number) {
  // Only record if we have an RTT signal
  if (edgeRtt == null || Number.isNaN(edgeRtt)) return;

  const day = todayKey();
  const key = `stats:${day}`;
  const storedStr = await env.EDGE_STATS.get(key);
  const stored: Stored = storedStr ? JSON.parse(storedStr) : {
    samples: 0,
    buckets: new Array(DEFAULT_EDGES.length + 1).fill(0),
    bucketEdges: DEFAULT_EDGES,
    colo: {},
  };

  stored.samples += 1;

  const idx = bucketIndex(Math.round(edgeRtt), stored.bucketEdges);
  stored.buckets[idx] = (stored.buckets[idx] ?? 0) + 1;

  const c = stored.colo[cf.colo ?? "—"] ?? { count: 0, sumRtt: 0, country: cf.country };
  c.count += 1;
  c.sumRtt += Math.round(edgeRtt);
  c.country = cf.country; // update in case it changed, but unlikely
  stored.colo[cf.colo ?? "—"] = c;

  await env.EDGE_STATS.put(key, JSON.stringify(stored));
}

async function getPercentile(env: Env, edgeRtt?: number) {
  if (edgeRtt == null || Number.isNaN(edgeRtt)) return null;
  const day = todayKey();
  const key = `stats:${day}`;
  const storedStr = await env.EDGE_STATS.get(key);
  const stored: Stored = storedStr ? JSON.parse(storedStr) : {
    samples: 0,
    buckets: new Array(DEFAULT_EDGES.length + 1).fill(0),
    bucketEdges: DEFAULT_EDGES,
    colo: {},
  };

  const idx = bucketIndex(Math.round(edgeRtt), stored.bucketEdges);
  let countLe = 0;
  for (let i = 0; i < stored.buckets.length; i++) {
    if (i < idx) countLe += stored.buckets[i];
    else if (i === idx) countLe += stored.buckets[i]; // bucket approx
  }
  const fasterThan = stored.samples > 0 ? Math.max(0, Math.min(100, Math.round((countLe / stored.samples) * 100))) : 0;

  return { fasterThanPct: fasterThan, samples: stored.samples, day };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cf = getCf(request);

    if (url.pathname === "/__ping") {
      return new Response("ok", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=0, s-maxage=60",
        },
      });
    }

    if (url.pathname === "/leaderboard") {
      const day = url.searchParams.get("day") ?? todayKey();
      const key = `stats:${day}`;
      const storedStr = await env.EDGE_STATS.get(key);
      const stored: Stored = storedStr ? JSON.parse(storedStr) : {
        samples: 0,
        buckets: new Array(DEFAULT_EDGES.length + 1).fill(0),
        bucketEdges: DEFAULT_EDGES,
        colo: {},
      };

      const p50 = percentileFromHist(stored.samples, stored.buckets, stored.bucketEdges, 50);
      const p90 = percentileFromHist(stored.samples, stored.buckets, stored.bucketEdges, 90);
      const p99 = percentileFromHist(stored.samples, stored.buckets, stored.bucketEdges, 99);

      const topColos = Object.entries(stored.colo)
        .map(([colo, v]) => ({ colo, count: v.count, avgRtt: v.count ? Math.round(v.sumRtt / v.count) : null, country: v.country }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      const data = {
        samples: stored.samples,
        p50,
        p90,
        p99,
        topColos,
      };

      // HTML view (simple + shareable)
      const html = `<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>EdgeCheck Leaderboard</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b0f19;color:#e8eefc}
  .wrap{max-width:920px;margin:0 auto;padding:26px 18px 60px}
  .card{background:#121a2a;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px;margin-top:14px}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}
  .muted{color:#9fb0d0}
  a{color:#7aa2ff;text-decoration:none}
</style></head>
<body>
<div class="wrap">
  <h1>EdgeCheck Leaderboard <span class="muted">(${escapeHtml(day)})</span></h1>
  <div class="muted">This is based on RTT to the Cloudflare edge for users who loaded the page/API today.</div>

  <div class="card">
    <div><b>Samples:</b> ${escapeHtml(String(data.samples ?? 0))}</div>
    <div style="margin-top:8px">
      <b>p50:</b> ${escapeHtml(msLabel(data.p50))} &nbsp; • &nbsp;
      <b>p90:</b> ${escapeHtml(msLabel(data.p90))} &nbsp; • &nbsp;
      <b>p99:</b> ${escapeHtml(msLabel(data.p99))}
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 10px 0">Top locations (by sample count)</h3>
    <table>
      <thead><tr><th>Location</th><th>Samples</th><th>Avg RTT</th></tr></thead>
      <tbody>
        ${(data.topColos ?? []).map((r: any) =>
          `<tr><td>${countryFlagEmoji(r.country)}${escapeHtml(r.colo)}</td><td>${escapeHtml(String(r.count))}</td><td>${escapeHtml(msLabel(r.avgRtt))}</td></tr>`
        ).join("")}
      </tbody>
    </table>
    <div class="muted" style="margin-top:10px">Tip: share this URL after a few people try it.</div>
  </div>

  <div class="card">
    <a href="/">← Back to EdgeCheck</a>
    &nbsp; • &nbsp;
    <a href="/api" target="_blank" rel="noreferrer">API</a>
  </div>
</div>
</body></html>`;

      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    if (url.pathname === "/api") {
      const started = performance.now();

      // Tiny edge fetch test (cacheable). Hits same Worker.
      const pingUrl = new URL(request.url);
      pingUrl.pathname = "/__ping";
      const t0 = performance.now();
      await fetch(pingUrl.toString(), { cf: { cacheTtl: 60, cacheEverything: true } } as RequestInit);
      const fetchMs = performance.now() - t0;

      const edgeRtt = cf.clientTcpRtt;
      const v = verdict(edgeRtt);

      // record + compute percentile (don’t block response on record)
      ctx.waitUntil(recordRun(env, cf, edgeRtt));
      const pct = await getPercentile(env, edgeRtt);

      const totalMs = performance.now() - started;

      return json(
        {
          now: new Date().toISOString(),
          colo: cf.colo ?? null,
          geo: {
            country: cf.country ?? null,
            region: cf.region ?? null,
            city: cf.city ?? null,
            continent: cf.continent ?? null,
            timezone: cf.timezone ?? null,
          },
          network: {
            asn: cf.asn ?? null,
            asOrganization: cf.asOrganization ?? null,
            httpProtocol: cf.httpProtocol ?? null,
            tlsVersion: cf.tlsVersion ?? null,
            tlsCipher: cf.tlsCipher ?? null,
          },
          timing: {
            edgeTcpRttMs: edgeRtt ?? null,
            tinyFetchMs: Math.round(fetchMs),
            handlerTotalMs: Math.round(totalMs),
          },
          verdict: { emoji: v.emoji, label: v.label },
          leaderboard: pct
            ? { day: pct.day, samples: pct.samples, fasterThanPct: pct.fasterThanPct, url: `/leaderboard?day=${pct.day}` }
            : null,
        },
        { headers: { "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/og.png") {
      const cf = getCf(request);
      const params = url.searchParams;

      // Use params if provided (for social sharing), else cf data
      const rtt = params.get("rtt") ? parseInt(params.get("rtt")!) : (cf.clientTcpRtt ? Math.round(cf.clientTcpRtt) : null);
      const colo = params.get("colo") || cf.colo || null;
      const emoji = params.get("emoji") || null;
      const label = params.get("label") || null;

      const v = emoji && label ? { emoji, label } : verdict(rtt ?? undefined);

      const svg = `
      <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#18264a"/>
            <stop offset="100%" stop-color="#0b0f19"/>
          </linearGradient>
        </defs>

        <rect width="1200" height="630" fill="url(#bg)"/>

        <text x="80" y="140" font-size="64" fill="#e8eefc" font-family="system-ui, -apple-system, Segoe UI, Roboto">
          EdgeCheck ⚡
        </text>

        <text x="80" y="200" font-size="32" fill="#9fb0d0" font-family="system-ui">
          How close are you to the internet edge?
        </text>

        <text x="80" y="320" font-size="96" fill="#e8eefc" font-family="system-ui">
          ${v.emoji} ${rtt !== null && rtt !== undefined ? (rtt === 0 ? "<1ms" : `${rtt} ms`) : "—"}
        </text>

        <text x="80" y="380" font-size="36" fill="#9fb0d0" font-family="system-ui">
          ${v.label}
        </text>

        <text x="80" y="460" font-size="28" fill="#7aa2ff" font-family="system-ui">
          Served from colo: ${colo ?? "—"}
        </text>

        <text x="80" y="560" font-size="22" fill="#9fb0d0" font-family="system-ui">
          edgecheck.add.workers.dev
        </text>
      </svg>
      `;

      return new Response(svg, {
        headers: {
          "content-type": "image/svg+xml",
          "cache-control": "public, max-age=0, s-maxage=300",
        },
      });
    }

    // HTML landing
    const edgeRtt = cf.clientTcpRtt;
    const v = verdict(edgeRtt);

    const apiUrl = new URL(request.url);
    apiUrl.pathname = "/api";

    const shareUrl = new URL(request.url);
    shareUrl.searchParams.set("share", "1");

    const lbUrl = new URL(request.url);
    lbUrl.pathname = "/leaderboard";

    // Record stats for main page visits
    ctx.waitUntil(recordRun(env, cf, edgeRtt));

    const ogImageUrl = `/og.png?rtt=${edgeRtt ?? ''}&colo=${encodeURIComponent(cf.colo ?? '')}&emoji=${encodeURIComponent(v.emoji)}&label=${encodeURIComponent(v.label)}`;

    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta property="og:title" content="How close are you to the internet edge?" />
<meta property="og:description" content="Measure your real distance (ms) to Cloudflare’s edge — compare globally." />
<meta property="og:type" content="website" />
<meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
<title>EdgeCheck ⚡</title>
<style>
:root{--bg:#0b0f19;--card:#121a2a;--text:#e8eefc;--muted:#9fb0d0}
*{box-sizing:border-box}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:radial-gradient(1200px 700px at 20% 10%, #18264a, var(--bg));color:var(--text)}
.wrap{max-width:920px;margin:0 auto;padding:28px 18px 60px}
.top{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
h1{margin:0;font-size:28px}
.pill{background:rgba(122,162,255,.14);border:1px solid rgba(122,162,255,.35);padding:8px 12px;border-radius:999px;font-size:13px}
.grid{display:grid;grid-template-columns:1fr;gap:14px;margin-top:16px}
@media(min-width:860px){.grid{grid-template-columns:1.15fr .85fr}}
.card{background:rgba(18,26,42,.9);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px;box-shadow:0 12px 30px rgba(0,0,0,.25)}
.big{font-size:44px;margin:8px 0 0}
.muted{color:var(--muted)}
.row{display:flex;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.row:last-child{border-bottom:0}
button,a.btn{cursor:pointer;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:var(--text);padding:10px 12px;font-size:14px;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
button:hover,a.btn:hover{border-color:rgba(122,162,255,.6)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.tiny{font-size:12px}
</style></head>
<body>
<div class="wrap">
  <div class="top">
    <h1>EdgeCheck <span class="muted">— how close are you to the internet edge?</span></h1>
    <div class="pill">Served from colo: <b>${escapeHtml(cf.colo ?? "—")}</b></div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="muted">Your “distance” to Cloudflare’s edge (TCP RTT)</div>
      <div class="big">${v.emoji} ${escapeHtml(msLabel(edgeRtt))}</div>
      <div class="muted" style="margin-top:6px">${escapeHtml(v.label)} • Compare phone vs Wi-Fi, or try a VPN.</div>

      <div class="actions">
        <button id="copy">Copy my result</button>
        <a class="btn" href="${escapeHtml(apiUrl.toString())}" target="_blank" rel="noreferrer">Open JSON API</a>
        <a class="btn" href="${escapeHtml(lbUrl.toString())}">Today’s leaderboard</a>
      </div>

      <div class="muted tiny" style="margin-top:10px">
        Note: RTT may be unavailable on some connections; then you’ll still see colo + geo.
      </div>
    </div>

    <div class="card">
      <div class="row"><span class="muted">Country</span><b>${escapeHtml(cf.country ?? "—")}</b></div>
      <div class="row"><span class="muted">Region</span><b>${escapeHtml(cf.region ?? "—")}</b></div>
      <div class="row"><span class="muted">City</span><b>${escapeHtml(cf.city ?? "—")}</b></div>
      <div class="row"><span class="muted">ASN</span><b>${escapeHtml(cf.asn?.toString() ?? "—")}</b></div>
      <div class="row"><span class="muted">Network</span><b>${escapeHtml(cf.asOrganization ?? "—")}</b></div>
      <div class="row"><span class="muted">Protocol</span><b>${escapeHtml(cf.httpProtocol ?? "—")}</b></div>
    </div>
  </div>
</div>

<script>
(() => {
  const btn = document.getElementById("copy");
  btn.addEventListener("click", async () => {
    const colo = ${JSON.stringify(cf.colo ?? "—")};
    const rtt = ${JSON.stringify(msLabel(edgeRtt))};
    const verdict = ${JSON.stringify(v.emoji + " " + v.label)};
    const share = ${JSON.stringify(shareUrl.toString())};

    const text =
      "EdgeCheck: " + verdict + "\\n" +
      "RTT: " + rtt + " • Colo: " + colo + "\\n" +
      "Try yours: " + share;

    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied ✅";
      setTimeout(() => btn.textContent = "Copy my result", 1400);
    } catch (e) {
      alert(text);
    }
  });
})();
</script>
</body></html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0, s-maxage=30",
      },
    });
  },
};

type Stored = {
  samples: number;
  buckets: number[]; // histogram counts
  bucketEdges: number[]; // upper edges in ms
  // per colo aggregation
  colo: Record<string, { count: number; sumRtt: number; country?: string }>;
};

const DEFAULT_EDGES = [5, 10, 15, 20, 30, 40, 60, 80, 100, 120, 150, 200, 300, 500, 1000]; // last bucket is >1000

function bucketIndex(rtt: number, edges: number[]) {
  for (let i = 0; i < edges.length; i++) {
    if (rtt <= edges[i]) return i;
  }
  return edges.length; // overflow bucket
}

function percentileFromHist(samples: number, buckets: number[], edges: number[], targetPct: number): number | null {
  if (samples <= 0) return null;
  const targetRank = Math.ceil((targetPct / 100) * samples);
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i];
    if (acc >= targetRank) {
      // Return bucket edge as approximation
      if (i < edges.length) return edges[i];
      return edges[edges.length - 1] + 1;
    }
  }
  return null;
}
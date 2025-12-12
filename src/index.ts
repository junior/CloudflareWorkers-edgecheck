export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api") {
      return handleApi(request);
    }

    // Default: HTML page
    return handleHtml(request);
  },
};

type Cf = {
  colo?: string;
  country?: string;
  region?: string;
  city?: string;
  postalCode?: string;
  latitude?: string;
  longitude?: string;
  timezone?: string;
  metroCode?: string;
  continent?: string;
  asn?: number;
  asOrganization?: string;
  tlsCipher?: string;
  tlsVersion?: string;
  httpProtocol?: string;
  clientTcpRtt?: number; // ms (when available)
};

function getCf(request: Request): Cf {
  // Cloudflare populates request.cf at runtime
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((request as any).cf ?? {}) as Cf;
}

function msLabel(ms?: number) {
  if (ms == null || Number.isNaN(ms)) return "—";
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

function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
    ...init,
  });
}

async function handleApi(request: Request): Promise<Response> {
  const cf = getCf(request);
  const started = performance.now();

  // Tiny “edge fetch” test (cacheable). This hits the same Worker.
  // Cache it to avoid unpredictable origin latency.
  const pingUrl = new URL(request.url);
  pingUrl.pathname = "/__ping";
  const t0 = performance.now();
  await fetch(pingUrl.toString(), {
    cf: { cacheTtl: 60, cacheEverything: true },
  } as RequestInit);
  const fetchMs = performance.now() - t0;

  const totalMs = performance.now() - started;

  const edgeRtt = cf.clientTcpRtt; // best “edge” signal when present
  const v = verdict(edgeRtt);

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
        lat: cf.latitude ?? null,
        lon: cf.longitude ?? null,
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
      verdict: {
        emoji: v.emoji,
        label: v.label,
      },
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    }
  );
}

async function handleHtml(request: Request): Promise<Response> {
  const cf = getCf(request);
  const edgeRtt = cf.clientTcpRtt;
  const v = verdict(edgeRtt);

  const apiUrl = new URL(request.url);
  apiUrl.pathname = "/api";

  const shareUrl = new URL(request.url);
  shareUrl.searchParams.set("share", "1");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EdgeCheck ⚡</title>
  <style>
    :root { --bg:#0b0f19; --card:#121a2a; --text:#e8eefc; --muted:#9fb0d0; --accent:#7aa2ff; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background: radial-gradient(1200px 700px at 20% 10%, #18264a, var(--bg)); color: var(--text); }
    .wrap { max-width: 920px; margin: 0 auto; padding: 28px 18px 60px; }
    .top { display:flex; gap:14px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
    h1 { margin: 0; font-size: 28px; letter-spacing: .2px; }
    .pill { background: rgba(122,162,255,.14); border: 1px solid rgba(122,162,255,.35); color: var(--text); padding: 8px 12px; border-radius: 999px; font-size: 13px; }
    .grid { display:grid; grid-template-columns: 1fr; gap: 14px; margin-top: 16px; }
    @media (min-width: 860px) { .grid { grid-template-columns: 1.15fr .85fr; } }
    .card { background: rgba(18,26,42,.9); border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 16px; box-shadow: 0 12px 30px rgba(0,0,0,.25); }
    .big { font-size: 44px; margin: 8px 0 0; }
    .muted { color: var(--muted); }
    .row { display:flex; justify-content:space-between; gap:14px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    .row:last-child { border-bottom: 0; }
    code { background: rgba(0,0,0,.25); padding: 2px 6px; border-radius: 8px; }
    button, a.btn { cursor:pointer; border-radius: 12px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: var(--text); padding: 10px 12px; font-size: 14px; text-decoration:none; display:inline-flex; align-items:center; gap:8px; }
    button:hover, a.btn:hover { border-color: rgba(122,162,255,.6); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top: 12px; }
    .tiny { font-size: 12px; }
  </style>
</head>
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
        <div class="muted" style="margin-top:6px">${escapeHtml(v.label)} • Try on phone vs Wi-Fi, or with a VPN.</div>

        <div class="actions">
          <button id="copy">Copy my result</button>
          <a class="btn" href="${escapeAttr(apiUrl.toString())}" target="_blank" rel="noreferrer">Open JSON API</a>
        </div>

        <div class="muted tiny" style="margin-top:10px">
          Note: RTT may be unavailable on some connections/browsers; then the page still shows colo + geo.
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
(async () => {
  const api = ${JSON.stringify(apiUrl.toString())};
  let data = null;
  try { data = await fetch(api, { cache: "no-store" }).then(r => r.json()); } catch (e) {}

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
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Cache HTML lightly; geo differs by user so keep short
      "cache-control": "public, max-age=0, s-maxage=30",
    },
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string) {
  // Good enough for URLs inserted into attributes
  return escapeHtml(s);
}

declare interface Env {}

// Tiny endpoint used by /api to do a fetch test (cached by CF)
async function handlePing(): Promise<Response> {
  return new Response("ok", {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=60",
    },
  });
}

// Route /__ping (simple matcher)
addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/__ping") {
    event.respondWith(handlePing());
  }
});
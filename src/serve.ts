import { createServer, type Server } from "node:http";
import type { Board } from "./board.js";

/**
 * A read-only local web dashboard for a board. Dependency-free (`node:http`),
 * serves a self-contained HTML page plus a small JSON API. Strictly read-only:
 * non-GET requests are refused, and there are no mutation endpoints — the
 * dashboard observes the board, it never changes it.
 */
export function serve(board: Board, port: number, host = "127.0.0.1"): Server {
  const json = (
    res: import("node:http").ServerResponse,
    data: unknown,
  ): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // verifyChain() is O(n) over the whole (append-only, unbounded) timeline, and
  // the dashboard polls /api/status every 2s — so cache the verification and
  // refresh it at most once per window rather than re-hashing all of history on
  // every poll (twice, once inside signedThrough) for a long-lived server.
  const VERIFY_TTL_MS = 5000;
  let cached: { at: number; chain: ReturnType<Board["verifyChain"]> } | null =
    null;
  const verifiedChain = (): ReturnType<Board["verifyChain"]> => {
    const nowMs = Date.now();
    if (!cached || nowMs - cached.at > VERIFY_TTL_MS) {
      cached = { at: nowMs, chain: board.verifyChain() };
    }
    return cached.chain;
  };

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("read-only dashboard: only GET is allowed");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      switch (url.pathname) {
        case "/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(DASHBOARD_HTML);
          return;
        case "/api/status": {
          const chain = verifiedChain();
          return json(res, {
            ...board.status(),
            chain,
            signedThrough: board.signedThrough(chain),
          });
        }
        case "/api/report":
          return json(res, board.report());
        case "/api/tasks":
          return json(res, board.listTaskCards());
        case "/api/timeline":
          return json(
            res,
            board.timeline(Number(url.searchParams.get("limit")) || 40),
          );
        case "/api/sessions":
          return json(res, board.listSessions());
        case "/api/trust":
          return json(res, board.verifySignatures());
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  // Bind to loopback by default — the dashboard exposes the whole board with no
  // auth, so it must not be reachable from the LAN unless explicitly opted in.
  server.listen(port, host);
  return server;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Octopus Blackboard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --fg: #e6e9ef;
    --muted: #8a93a6; --accent: #6ea8fe; --ok: #4ec98a; --warn: #f0b849; --bad: #f06a6a;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 16px 24px; border-bottom: 1px solid var(--line); display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .tag { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 24px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 12px; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; }
  .kv b { font-weight: 600; }
  .pill { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
  .bar { height: 8px; background: var(--line); border-radius: 999px; overflow: hidden; margin: 6px 0 12px; }
  .bar > span { display: block; height: 100%; background: var(--ok); }
  .row { padding: 4px 0; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .tl { max-height: 340px; overflow: auto; }
  .tl .row { display: flex; gap: 10px; }
  .tl .seq { color: var(--muted); min-width: 34px; }
  .tl .who { color: var(--accent); min-width: 90px; }
  code { color: var(--muted); }
  .kb { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .kb .col h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  .card { background: var(--bg); border: 1px solid var(--line); border-left: 3px solid var(--muted); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  .card.risk-high { border-left-color: var(--bad); }
  .card.risk-medium { border-left-color: var(--warn); }
  .card.risk-low { border-left-color: var(--ok); }
  .card .num { color: var(--accent); font-weight: 600; }
  .card .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .card .pbar { height: 5px; background: var(--line); border-radius: 999px; overflow: hidden; margin: 8px 0 4px; }
  .card .pbar > span { display: block; height: 100%; background: var(--accent); }
  .chip { display:inline-block; background: var(--line); border-radius: 999px; padding: 0 6px; font-size: 11px; margin-right: 4px; }
  @media (max-width: 900px) { .kb { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1 style="display:flex;align-items:center;gap:8px;"><img src="data:image/png;base64,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" alt="" width="24" height="24" style="border-radius:6px" aria-hidden="true" /> Octopus Blackboard</h1>
  <span class="tag" id="chain">…</span>
  <span class="tag" id="trust">…</span>
  <span class="tag muted">read-only · auto-refresh 2s</span>
</header>
<div class="panel" style="margin:24px 24px 0;"><h2>Kanban</h2><div class="kb" id="kanban"></div></div>
<div class="grid">
  <div class="panel"><h2>Accountability</h2><div id="report"></div></div>
  <div class="panel"><h2>On the board</h2><div id="status"></div></div>
  <div class="panel"><h2>Sessions</h2><div id="sessions"></div></div>
  <div class="panel" style="grid-column: 1 / -1;"><h2>Timeline</h2><div class="tl" id="timeline"></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function get(p) { const r = await fetch(p); return r.json(); }

async function refresh() {
  try {
    const [status, report, timeline] = await Promise.all([get("/api/status"), get("/api/report"), get("/api/timeline")]);

    $("chain").innerHTML = !status.chain.ok
      ? '<span class="bad">✗ chain BROKEN @ ' + status.chain.brokenAtSeq + '</span>'
      : (status.chain.anchored || status.chain.length === 0)
        ? '<span class="ok">✓ chain intact (' + status.chain.length + ')</span>'
        : '<span class="warn">⚠ intact but unanchored (' + status.chain.length + ')</span>';
    $("trust").innerHTML = status.signedThrough > 0
      ? '<span class="ok">signed through #' + status.signedThrough + '</span>'
      : '<span class="muted">unsigned</span>';

    const naCov = report.reviewCoverage === null;
    const cov = naCov ? 0 : report.reviewCoverage === 1 ? 100 : Math.floor(report.reviewCoverage * 100);
    const covClass = naCov ? "muted" : cov >= 100 ? "ok" : cov >= 50 ? "warn" : "bad";
    const covLabel = naCov ? "n/a" : cov + "%";
    $("report").innerHTML =
      '<div class="kv"><span>review coverage</span><b class="' + covClass + '">' + covLabel + '</b></div>' +
      '<div class="bar"><span style="width:' + cov + '%"></span></div>' +
      '<div class="kv"><span>AI commits</span><b>' + report.commits.aiProduced + '</b></div>' +
      '<div class="kv"><span>unreviewed AI</span><b class="' + (report.commits.unreviewed ? "bad" : "ok") + '">' + report.commits.unreviewed + '</b></div>' +
      '<div class="kv"><span>attributions (ai/human)</span><b>' + report.attributions.ai + ' / ' + report.attributions.human + '</b></div>' +
      '<div class="kv"><span>open risks</span><b class="' + (report.risks.open ? "warn" : "ok") + '">' + report.risks.open + '</b></div>' +
      (report.perAgent.length ? '<div style="margin-top:8px">' + report.perAgent.map(a =>
        '<div class="row"><b>' + esc(a.agent) + '</b> <span class="muted">' + a.commits + ' commit(s), ' + a.files + ' file(s)</span></div>').join("") + '</div>' : "");

    $("status").innerHTML =
      '<div class="kv"><span>agents</span><b>' + status.agents.length + '</b></div>' +
      (status.agents.map(a => '<div class="row">' + esc(a.name) + ' <span class="muted">' + esc(a.cli || a.kind || "") + '</span></div>').join("") || '<div class="muted">none</div>') +
      '<div class="kv" style="margin-top:8px"><span>open tasks</span><b>' + status.openTasks.length + '</b></div>' +
      status.openTasks.map(t => '<div class="row">[' + esc(t.status) + '] ' + esc(t.key) + (t.claimedBy ? ' <span class="muted">← ' + esc(t.claimedBy) + '</span>' : '') + '</div>').join("") +
      '<div class="kv" style="margin-top:8px"><span>open risks</span><b>' + status.openRisks.length + '</b></div>' +
      status.openRisks.map(r => '<div class="row warn">[' + esc(r.severity) + '] ' + esc(r.title) + '</div>').join("");

    const sessions = await get("/api/sessions");
    $("sessions").innerHTML = sessions.length
      ? sessions.map(s => '<div class="row">' + (s.finishedAt ? '<span class="muted">closed</span>' : '<span class="ok">OPEN</span>') +
          ' ' + esc(s.agentName) + ' <code>' + esc(s.id.slice(0,8)) + '</code> <span class="muted">' + esc(s.gitBranch || "-") + '</span></div>').join("")
      : '<div class="muted">no sessions</div>';

    const cards = await get("/api/tasks");
    const cols = ["open", "claimed", "in-progress", "blocked", "done"];
    $("kanban").innerHTML = cols.map(col => {
      const inCol = cards.filter(c => c.task.status === col);
      const cardsHtml = inCol.map(c => {
        const t = c.task;
        const owner = (c.assignees.length ? c.assignees : (t.claimedBy ? [t.claimedBy] : []));
        const ownerHtml = owner.map(a => '<span class="chip">' + esc(a) + '</span>').join("");
        const agents = c.activeAgents > 0 ? '<span class="chip">⚡' + c.activeAgents + ' active</span>' : "";
        const proj = t.project ? '<span class="chip">' + esc(t.project) + '</span>' : "";
        const risk = t.riskLevel ? '<span class="chip">!' + esc(t.riskLevel) + '</span>' : "";
        return '<div class="card risk-' + esc(t.riskLevel || "none") + '">' +
          '<div><span class="num">#' + t.number + '</span> ' + esc(t.title || t.key) + '</div>' +
          (t.impact ? '<div class="meta">' + esc(t.impact) + '</div>' : (c.impactFiles.length ? '<div class="meta">' + c.impactFiles.length + ' file(s)</div>' : "")) +
          '<div class="pbar"><span style="width:' + (t.progress||0) + '%"></span></div>' +
          '<div class="meta">' + (t.progress||0) + '% ' + ownerHtml + agents + proj + risk + '</div>' +
        '</div>';
      }).join("") || '<div class="muted" style="font-size:12px">—</div>';
      return '<div class="col"><h3>' + col + ' (' + inCol.length + ')</h3>' + cardsHtml + '</div>';
    }).join("");

    $("timeline").innerHTML = timeline.slice().reverse().map(e =>
      '<div class="row"><span class="seq">#' + e.seq + '</span><span class="who">' + esc(e.actor) + '</span><span>' + esc(e.summary) + '</span></div>').join("");
  } catch (err) {
    $("chain").innerHTML = '<span class="bad">disconnected</span>';
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

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
  <h1>🐙 Octopus Blackboard</h1>
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

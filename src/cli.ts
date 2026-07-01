#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { Board } from "./board.js";
import { loadConfig } from "./config.js";
import { serve } from "./serve.js";
import * as git from "./git.js";
import type { RiskSeverity } from "./types.js";

const program = new Command();

program
  .name("octoboard")
  .description("Octopus Blackboard — shared memory & AI attribution for coding agents")
  .version("0.1.0")
  .option("--board <dir>", "board directory (defaults to nearest .octoboard/)")
  .option("--as <agent>", "identity to write as (or set OCTOBOARD_AGENT)")
  .option("--provider <provider>", "agent provider, e.g. anthropic, openai, local")
  .option("--model <model>", "agent model, e.g. claude-opus-4-8")
  .option("--cli <cli>", "agent CLI / surface, e.g. claude-code")
  .option("--session <id>", "act within a specific session (or set OCTOBOARD_SESSION)");

/** Config overrides from the global identity flags. */
function overrides() {
  const o = program.opts();
  if (o.session) {
    process.env.OCTOBOARD_SESSION = o.session;
  }
  return {
    boardDir: o.board,
    agent: o.as,
    provider: o.provider,
    model: o.model,
    cli: o.cli
  };
}

/** Build a Board honoring the global identity flags. */
function board(): Board {
  return Board.open(overrides());
}

/** The resolved agent identity for this invocation. */
function actor(): string {
  return loadConfig(overrides()).agent;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

program
  .command("init")
  .description("create a board in the current directory (.octoboard/)")
  .action(() => {
    const cfg = loadConfig(program.opts().board ? { boardDir: program.opts().board } : {});
    const existed = existsSync(cfg.dbPath);
    const b = new Board(cfg);
    b.close();
    console.log(existed ? `Board already present at ${cfg.dbPath}` : `Initialized board at ${cfg.dbPath}`);
  });

program
  .command("status")
  .description("show who is on the board, open work, unread messages, open risks")
  .option("--json", "output raw JSON")
  .action((opts) => {
    const b = board();
    const status = b.status(actor());
    const chain = b.verifyChain();
    b.close();
    if (opts.json) {
      printJson({ ...status, chain });
      return;
    }
    renderStatus(status, chain);
  });

program
  .command("note")
  .argument("<text>", "free-form status broadcast to the board")
  .description("leave a note on the board")
  .action((text) => {
    const b = board();
    const ev = b.note(actor(), text);
    b.close();
    console.log(`#${ev.seq} note by ${ev.actor}`);
  });

program
  .command("claim")
  .argument("<key>", "task key to claim, e.g. trust-layer-policy-schema")
  .option("--title <title>", "human title for the task")
  .description("claim a task (surfaces a conflict if another agent holds it)")
  .action((key, opts) => {
    const b = board();
    const result = b.claim(actor(), key, opts.title ?? null);
    b.close();
    if (result.conflict) {
      console.warn(`⚠ CONFLICT: "${key}" is also held by ${result.conflict}. Both claims recorded.`);
    } else {
      console.log(`Claimed "${key}".`);
    }
  });

program
  .command("release")
  .argument("<key>", "task key to release")
  .description("release a task you claimed")
  .action((key) => {
    const b = board();
    const task = b.release(actor(), key);
    b.close();
    console.log(task ? `Released "${key}".` : `No task "${key}".`);
  });

program
  .command("done")
  .argument("<key>", "task key to mark complete")
  .description("mark a task done")
  .action((key) => {
    const b = board();
    const task = b.complete(actor(), key);
    b.close();
    console.log(task ? `Completed "${key}".` : `No task "${key}".`);
  });

program
  .command("message")
  .argument("<agent>", "recipient agent, or 'all' to broadcast")
  .argument("<body>", "message body")
  .description("leave a message for another agent")
  .action((agent, body) => {
    const b = board();
    const to = agent === "all" ? null : agent;
    b.message(actor(), to, body);
    b.close();
    console.log(to ? `Message left for ${to}.` : "Broadcast to the board.");
  });

program
  .command("inbox")
  .option("--all", "include already-read messages")
  .description("show messages addressed to you (or broadcast)")
  .action((opts) => {
    const b = board();
    const messages = b.inbox(actor(), opts.all);
    b.close();
    if (messages.length === 0) {
      console.log("Inbox empty.");
      return;
    }
    for (const m of messages) {
      const dest = m.toAgent ? "" : " (broadcast)";
      console.log(`• ${m.fromAgent}${dest}: ${m.body}`);
    }
  });

program
  .command("decision")
  .argument("<title>", "the decision made")
  .option("--why <rationale>", "rationale behind the decision")
  .option("--evidence <ref>", "evidence pointer (path, URL, log)")
  .option("--commit <sha...>", "related commit sha(s)")
  .option("--task <key...>", "related task key(s)")
  .description("record an architectural decision")
  .action((title, opts) => {
    const b = board();
    b.decision(actor(), title, {
      rationale: opts.why ?? null,
      evidence: opts.evidence ?? null,
      relatedCommits: opts.commit ?? [],
      relatedTasks: opts.task ?? []
    });
    b.close();
    console.log("Decision recorded.");
  });

program
  .command("evidence")
  .argument("<ref>", "pointer to evidence: file path, URL, log, test run")
  .option("--note <note>", "what this evidence shows")
  .option("--for <target>", "what it supports, e.g. task:auth-mw")
  .description("attach evidence to the board")
  .action((ref, opts) => {
    const b = board();
    b.evidence(actor(), ref, opts.note ?? null, opts.for ?? null);
    b.close();
    console.log("Evidence attached.");
  });

program
  .command("file")
  .argument("<path>", "file path that changed")
  .option("--change <kind>", "added | modified | deleted", "modified")
  .option("--task <key>", "task this change belongs to")
  .description("record a file you touched (cooperative conflict awareness)")
  .action((path, opts) => {
    const b = board();
    if (opts.task) {
      const others = b.filesForTask(opts.task).filter((f) => f.agentId !== actor());
      if (others.length > 0) {
        console.warn(`⚠ ${others.length} change(s) by other agents already recorded on task "${opts.task}".`);
      }
    }
    b.fileChanged(actor(), path, opts.change, opts.task ?? null);
    b.close();
    console.log(`Recorded ${opts.change}: ${path}`);
  });

program
  .command("risk")
  .argument("<title>", "the risk")
  .option("--severity <level>", "low | medium | high", "medium")
  .description("flag an open risk")
  .action((title, opts) => {
    const b = board();
    b.risk(actor(), title, opts.severity as RiskSeverity);
    b.close();
    console.log("Risk flagged.");
  });

program
  .command("handoff")
  .argument("<agent>", "agent to hand off to")
  .argument("<summary>", "state at handoff, e.g. 'tests pass except policy replay'")
  .option("--context <text>", "extra context for the receiving agent")
  .option("--file <path...>", "related file(s)")
  .option("--question <q...>", "open question(s) for the next agent")
  .option("--task <key>", "task being handed off")
  .description("hand off work to another agent")
  .action((agent, summary, opts) => {
    const b = board();
    b.handoff(actor(), agent, summary, {
      context: opts.context ?? null,
      relatedFiles: opts.file ?? [],
      openQuestions: opts.question ?? [],
      taskKey: opts.task ?? null
    });
    b.close();
    console.log(`Handed off to ${agent}.`);
  });

program
  .command("timeline")
  .option("--limit <n>", "how many entries", (v) => parseInt(v, 10), 30)
  .option("--session <id>", "only events from this session (HH:MM view)")
  .option("--json", "output raw JSON")
  .description("show the append-only, hash-chained history")
  .action((opts) => {
    const b = board();
    const events = opts.session ? b.sessionTimeline(opts.session) : b.timeline(opts.limit);
    b.close();
    if (opts.json) {
      printJson(events);
      return;
    }
    if (opts.session) {
      for (const e of events) {
        const t = new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        console.log(`${t}   ${e.summary}`);
      }
      return;
    }
    for (const e of events) {
      console.log(`#${String(e.seq).padStart(3, "0")} ${e.at}  ${e.actor.padEnd(10)} ${e.summary}`);
    }
  });

// --- sessions ----------------------------------------------------------------

const session = program.command("session").description("manage execution sessions");

session
  .command("start")
  .option("--label <label>", "human label for this session")
  .description("start a session and make it current for this agent")
  .action((opts) => {
    const b = board();
    const s = b.startSession(opts.label ?? null);
    b.close();
    console.log(`Session started: ${s.id}`);
    console.log(`  agent: ${s.agentName}   branch: ${s.gitBranch ?? "-"}   machine: ${s.machine ?? "-"}`);
    console.log(`  (writes now attribute to this session; run 'octoboard session stop' to end)`);
  });

session
  .command("stop")
  .argument("[id]", "session to stop (defaults to your active session)")
  .description("stop a session")
  .action((sid) => {
    const b = board();
    const s = b.stopSession(sid);
    b.close();
    console.log(s ? `Session stopped: ${s.id}` : "No active session.");
  });

session
  .command("list")
  .option("--json", "output raw JSON")
  .description("list recent sessions")
  .action((opts) => {
    const b = board();
    const sessions = b.listSessions();
    b.close();
    if (opts.json) {
      printJson(sessions);
      return;
    }
    for (const s of sessions) {
      const state = s.finishedAt ? "closed" : "OPEN";
      console.log(`${s.id.slice(0, 8)}  [${state}] ${s.agentName.padEnd(10)} ${s.gitBranch ?? "-"}  ${s.startedAt}`);
    }
  });

session
  .command("show")
  .argument("<id>", "session id")
  .option("--json", "output raw JSON")
  .description("show a session and its timeline")
  .action((sid, opts) => {
    const b = board();
    const s = b.getSession(sid);
    const events = s ? b.sessionTimeline(sid) : [];
    b.close();
    if (!s) {
      console.log("No such session.");
      return;
    }
    if (opts.json) {
      printJson({ session: s, timeline: events });
      return;
    }
    console.log(`Session ${s.id}`);
    console.log(`  agent ${s.agentName}   branch ${s.gitBranch ?? "-"}   ${s.workingDirectory ?? ""}`);
    console.log(`  started ${s.startedAt}   ${s.finishedAt ? `finished ${s.finishedAt}` : "OPEN"}`);
    console.log("  timeline:");
    for (const e of events) {
      const t = new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      console.log(`    ${t}  ${e.summary}`);
    }
  });

// --- attribution & git --------------------------------------------------------

program
  .command("link")
  .argument("[rev]", "commit to link (defaults to HEAD)", "HEAD")
  .option("--actor <type>", "human | ai", "ai")
  .option("--name <name>", "explicit actor name")
  .option("--note", "also write an additive git note (refs/notes/blackboard)")
  .description("attribute a commit's files to the current session")
  .action((rev, opts) => {
    const b = board();
    const result = b.link(rev, {
      actorType: opts.actor,
      actor: opts.name,
      writeNote: Boolean(opts.note)
    });
    b.close();
    if (!result) {
      console.error(`Could not resolve '${rev}' (not a git repo, or unknown revision).`);
      process.exitCode = 1;
      return;
    }
    console.log(`Linked ${result.sha.slice(0, 12)} → ${opts.name ?? actor()} (${result.count} file(s)).`);
  });

program
  .command("attribute")
  .argument("<rev>", "commit sha or revision")
  .option("--file <path>", "specific file")
  .option("--actor <type>", "human | ai", "ai")
  .option("--name <name>", "explicit actor name")
  .description("record a single attribution for a commit")
  .action((rev, opts) => {
    const b = board();
    const a = b.attribute(rev, { file: opts.file ?? null, actorType: opts.actor, actor: opts.name });
    b.close();
    console.log(`Attributed ${a.commit.slice(0, 12)}${a.file ? ` (${a.file})` : ""} to ${a.actorType} ${a.actor}.`);
  });

program
  .command("review")
  .argument("<rev>", "commit sha or revision")
  .option("--by <type>", "human | ai", "human")
  .option("--name <name>", "reviewer name")
  .option("--outcome <outcome>", "approved | changes-requested | rejected | commented", "approved")
  .option("--note <note>", "review note")
  .description("record who reviewed a commit and the outcome")
  .action((rev, opts) => {
    const b = board();
    const r = b.review(rev, {
      reviewerType: opts.by,
      reviewer: opts.name,
      outcome: opts.outcome,
      note: opts.note ?? null
    });
    b.close();
    console.log(`Recorded ${r.reviewerType} review of ${r.commit.slice(0, 12)}: ${r.outcome}.`);
  });

program
  .command("who")
  .argument("<file>", "file to explain")
  .option("--line <n>", "which session introduced this line", (v) => parseInt(v, 10))
  .option("--json", "output raw JSON")
  .description("who changed this file (git authors + AI sessions)")
  .action((file, opts) => {
    const b = board();
    if (opts.line !== undefined) {
      if (!Number.isInteger(opts.line) || opts.line < 1) {
        b.close();
        console.error("--line must be a positive integer.");
        process.exitCode = 1;
        return;
      }
      const bl = b.blame(file, opts.line);
      b.close();
      if (!bl) {
        console.log("No blame available (not a git repo, or file/line unknown).");
        return;
      }
      if (opts.json) return printJson(bl);
      console.log(`${file}:${opts.line} last changed in ${bl.sha.slice(0, 12)} (git author ${bl.gitAuthor})`);
      for (const a of bl.attributions) {
        console.log(`  ↳ ${a.actorType} ${a.actor}${a.model ? ` [${a.model}]` : ""} session ${a.sessionId?.slice(0, 8) ?? "-"}`);
      }
      return;
    }
    const result = b.whoTouched(file);
    b.close();
    if (opts.json) return printJson(result);
    console.log(`Git authors:  ${result.gitAuthors.join(", ") || "(none / not a repo)"}`);
    console.log("AI sessions touching this file:");
    if (result.sessions.length === 0) console.log("  (none recorded)");
    for (const s of result.sessions) {
      console.log(`  ${s.agent.padEnd(10)} session ${s.sessionId?.slice(0, 8) ?? "-"}  ${s.at}`);
    }
    if (result.attributions.length > 0) {
      console.log("Commit attributions:");
      for (const a of result.attributions) {
        console.log(`  ${a.commit.slice(0, 12)}  ${a.actorType} ${a.actor}${a.model ? ` [${a.model}]` : ""}`);
      }
    }
  });

program
  .command("explain")
  .argument("[rev]", "commit to explain (defaults to HEAD)", "HEAD")
  .option("--json", "output raw JSON")
  .description("explain a commit: attribution, reviews, related decisions")
  .action((rev, opts) => {
    const b = board();
    const info = b.explain(rev);
    b.close();
    if (!info) {
      console.log(`Nothing known about '${rev}'.`);
      return;
    }
    if (opts.json) return printJson(info);
    const c: any = info.commit;
    console.log(`commit ${c.sha}`);
    if (c.author) console.log(`  ${c.author} <${c.authorEmail}>  ${c.date}`);
    if (c.subject) console.log(`  ${c.subject}`);
    console.log("  produced by:");
    if (info.attributions.length === 0) console.log("    (no AI attribution recorded)");
    for (const a of info.attributions) {
      console.log(`    ${a.actorType} ${a.actor}${a.model ? ` [${a.model}]` : ""}${a.file ? ` — ${a.file}` : ""}`);
    }
    console.log("  reviews:");
    if (info.reviews.length === 0) console.log("    (unreviewed)");
    for (const r of info.reviews) {
      console.log(`    ${r.reviewerType} ${r.reviewer}: ${r.outcome}`);
    }
    if (info.decisions.length > 0) {
      console.log("  decisions:");
      for (const d of info.decisions) console.log(`    ${d.title}`);
    }
    if (info.note) console.log(`  git note: ${info.note}`);
  });

program
  .command("commits")
  .argument("<actor>", "actor, cli, provider, or model, e.g. claude-code")
  .option("--json", "output raw JSON")
  .description("which commits came from an AI / CLI")
  .action((query, opts) => {
    const b = board();
    const rows = b.commitsByActor(query);
    b.close();
    if (opts.json) return printJson(rows);
    if (rows.length === 0) console.log(`No commits attributed to '${query}'.`);
    for (const r of rows) {
      console.log(`${r.commit.slice(0, 12)}  ${r.actor}${r.cli ? ` (${r.cli})` : ""}  ${r.at}`);
    }
  });

program
  .command("unreviewed")
  .option("--json", "output raw JSON")
  .description("AI-produced commits with no human review")
  .action((opts) => {
    const b = board();
    const rows = b.unreviewedCommits();
    b.close();
    if (opts.json) return printJson(rows);
    if (rows.length === 0) {
      console.log("✓ every AI-attributed commit has a human review.");
      return;
    }
    console.log("Commits never human-reviewed:");
    for (const r of rows) console.log(`  ${r.commit.slice(0, 12)}  ${r.actor}  ${r.at}`);
  });

program
  .command("joint")
  .argument("<agentA>")
  .argument("<agentB>")
  .description("files modified by BOTH agents (collision surface)")
  .action((a, bName) => {
    const b = board();
    const files = b.jointFiles(a, bName);
    b.close();
    if (files.length === 0) {
      console.log(`No files jointly modified by ${a} and ${bName}.`);
      return;
    }
    console.log(`Files touched by both ${a} and ${bName}:`);
    for (const f of files) console.log(`  ${f}`);
  });

program
  .command("serve")
  .option("--port <n>", "port to listen on", (v) => parseInt(v, 10), 4319)
  .description("start a read-only local web dashboard")
  .action((opts) => {
    const b = board();
    const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : 4319;
    const server = serve(b, port);
    console.error(`Dashboard on http://localhost:${port} (read-only) — Ctrl-C to stop`);
    process.on("SIGINT", () => {
      server.close();
      b.close();
      process.exit(0);
    });
  });

program
  .command("report")
  .option("--json", "output raw JSON")
  .description("scorecard: review coverage, AI/human ratio, per-agent breakdown")
  .action((opts) => {
    const b = board();
    const r = b.report();
    b.close();
    if (opts.json) {
      printJson(r);
      return;
    }
    const pct = (n: number): string => `${Math.round(n * 100)}%`;
    console.log("── Accountability scorecard ───────────");
    console.log(`  review coverage:   ${pct(r.reviewCoverage)}  (${r.commits.humanReviewed}/${r.commits.aiProduced} AI commits human-reviewed)`);
    console.log(`  unreviewed AI:     ${r.commits.unreviewed} commit(s)`);
    console.log(`  attributions:      ${r.attributions.total}  (ai ${r.attributions.ai} / human ${r.attributions.human})`);
    console.log(`  sessions:          ${r.sessions.total}  (${r.sessions.open} open)`);
    console.log(`  open risks:        ${r.risks.open}`);
    console.log("  per agent:");
    if (r.perAgent.length === 0) console.log("    (none)");
    for (const a of r.perAgent) {
      console.log(`    ${a.agent.padEnd(14)} ${a.commits} commit(s), ${a.files} file(s), ${a.attributions} attribution(s)`);
    }
  });

program
  .command("blame")
  .argument("<file>", "file to trace")
  .argument("<line>", "line number")
  .option("--json", "output raw JSON")
  .description("trace a line back to the session that introduced it (narrative)")
  .action((file, lineArg, opts) => {
    const line = parseInt(lineArg, 10);
    const b = board();
    if (!Number.isInteger(line) || line < 1) {
      b.close();
      console.error("line must be a positive integer.");
      process.exitCode = 1;
      return;
    }
    const n = b.blameNarrative(file, line);
    b.close();
    if (!n) {
      console.log("No blame available (not a git repo, or file/line unknown).");
      return;
    }
    if (opts.json) {
      printJson(n);
      return;
    }
    console.log(`${file}:${line} last changed in ${n.sha.slice(0, 12)} (git author ${n.gitAuthor})`);
    for (const a of n.attributions) {
      console.log(`  produced by ${a.actorType} ${a.actor}${a.model ? ` [${a.model}]` : ""}`);
    }
    if (n.session) {
      console.log(`  in session ${n.session.id.slice(0, 8)} (${n.session.agentName}, branch ${n.session.gitBranch ?? "-"})`);
      // Show the session's other activity, minus the kinds surfaced separately
      // (decisions/handoffs below) and the link/attribution for this very line.
      const shownSeparately = new Set(["decision", "handoff", "link", "attribution"]);
      const also = n.sessionTimeline.filter((e) => !shownSeparately.has(e.kind));
      if (also.length > 0) {
        console.log("  that session also:");
        for (const e of also) console.log(`    · ${e.summary}`);
      }
      for (const d of n.decisions) console.log(`    ⟐ decided: ${d.title}`);
      for (const h of n.handoffs) console.log(`    → handoff to ${h.toAgent}: ${h.summary}`);
    } else {
      console.log("  (no session context recorded for this commit)");
    }
  });

program
  .command("export")
  .option("--range <range>", "commit range to export, e.g. main..HEAD (default: all attributed)")
  .option("--out <file>", "write the bundle to a file (default: stdout)")
  .description("export a portable attribution bundle (survives push/PR)")
  .action((opts) => {
    const b = board();
    const commits = opts.range ? git.revList(opts.range) : undefined;
    const bundle = b.exportBundle(commits);
    b.close();
    const json = JSON.stringify(bundle, null, 2);
    if (opts.out) {
      writeFileSync(opts.out, json, "utf8");
      console.log(`Wrote ${bundle.attributions.length} attribution(s), ${bundle.reviews.length} review(s) to ${opts.out}.`);
    } else {
      console.log(json);
    }
  });

program
  .command("import")
  .argument("<file>", "bundle file to import")
  .description("import an attribution bundle into this board (idempotent)")
  .action((file) => {
    const b = board();
    try {
      const bundle = JSON.parse(readFileSync(file, "utf8"));
      const counts = b.importBundle(bundle);
      console.log(
        `Imported ${counts.attributions} attribution(s), ${counts.reviews} review(s), ${counts.sessions} session(s), ${counts.decisions} decision(s).`
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      b.close();
    }
  });

program
  .command("trailers")
  .argument("[rev]", "commit to describe", "HEAD")
  .description("print git trailer lines encoding a commit's attribution")
  .action((rev) => {
    const b = board();
    const lines = b.trailersFor(rev);
    b.close();
    if (lines.length === 0) {
      console.error("No attribution recorded for this commit.");
      process.exitCode = 1;
      return;
    }
    for (const l of lines) {
      console.log(l);
    }
  });

program
  .command("check")
  .option("--range <range>", "commit range to check, e.g. main..HEAD (default: all attributed commits)")
  .option("--require-human-review", "fail if any AI-produced commit lacks a human review")
  .option("--require-attribution", "fail if a scoped commit has no attribution at all")
  .option("--verify-chain", "fail if the timeline hash chain is broken")
  .option("--json", "output raw JSON")
  .description("governance gate: assert policy over commits, exit 1 on violation")
  .action((opts) => {
    const b = board();
    let commits: string[] | undefined;
    if (opts.range) {
      commits = git.revList(opts.range);
    }
    // With no explicit policy flags, apply a sensible default gate.
    const anyPolicy = opts.requireHumanReview || opts.requireAttribution || opts.verifyChain;
    const result = b.check({
      commits,
      requireHumanReview: anyPolicy ? Boolean(opts.requireHumanReview) : true,
      requireAttribution: Boolean(opts.requireAttribution),
      verifyChain: anyPolicy ? Boolean(opts.verifyChain) : true
    });
    b.close();

    if (opts.json) {
      printJson(result);
    } else if (result.ok) {
      console.log(`✓ policy passed (${result.checked} commit(s) checked).`);
    } else {
      console.error(`✗ policy FAILED — ${result.violations.length} violation(s):`);
      for (const v of result.violations) {
        const where = v.commit ? `${v.commit.slice(0, 12)} ` : "";
        console.error(`  [${v.kind}] ${where}${v.detail}`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("watch")
  .option("--for <agent>", "only notify about events relevant to this agent")
  .option("--interval <ms>", "poll interval in milliseconds", (v) => parseInt(v, 10), 1000)
  .option("--once", "print events since the current head and exit (no loop)")
  .description("subscribe to board changes (poll the timeline for new events)")
  .action((opts) => {
    const b = board();
    const forAgent: string | undefined = opts.for;
    let last = b.headSeq();

    const drain = (): void => {
      const fresh = b.since(last);
      if (fresh.length > 0) {
        last = fresh[fresh.length - 1].seq;
      }
      const show = forAgent ? b.notable(fresh, forAgent) : fresh;
      for (const e of show) {
        const t = new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        console.log(`${t}  #${e.seq} ${e.actor.padEnd(10)} ${e.summary}`);
      }
    };

    if (opts.once) {
      // `--once` reports from 0 so a one-shot poll is useful in scripts.
      last = 0;
      drain();
      b.close();
      return;
    }

    const interval = Number.isInteger(opts.interval) && opts.interval > 0 ? opts.interval : 1000;
    console.error(`watching board from seq ${last}${forAgent ? ` for ${forAgent}` : ""} — Ctrl-C to stop`);
    const timer = setInterval(drain, interval);
    process.on("SIGINT", () => {
      clearInterval(timer);
      b.close();
      process.exit(0);
    });
  });

program
  .command("sign")
  .description("sign the current timeline head with your active session key")
  .action(() => {
    const b = board();
    const signed = b.signHead();
    b.close();
    if (!signed) {
      console.error("Nothing to sign (no active session, missing key, or empty board).");
      process.exitCode = 1;
      return;
    }
    console.log(`Signed head at seq ${signed.headSeq}.`);
  });

program
  .command("verify")
  .description("verify the timeline hash chain and show signature trust")
  .action(() => {
    const b = board();
    const result = b.verifyChain();
    const sigs = b.verifySignatures();
    const signedThrough = b.signedThrough();
    b.close();
    if (result.ok) {
      console.log(`✓ chain intact — ${result.length} entr(ies) verified`);
    } else {
      console.error(`✗ chain BROKEN at seq ${result.brokenAtSeq} (of ${result.length})`);
      process.exitCode = 1;
    }
    if (sigs.length === 0) {
      console.log("trust: (no signatures yet — run 'octoboard sign' or stop a session)");
    } else {
      console.log(`trust: signed through seq ${signedThrough}`);
      for (const s of sigs) {
        const mark = s.valid && s.current ? "✓ trusted" : s.valid ? "⚠ stale (history changed)" : "✗ invalid";
        console.log(`  seq ${String(s.headSeq).padStart(3)}  ${s.agent ?? "?"} (${s.sessionId.slice(0, 8)})  ${mark}`);
      }
    }
  });

function renderStatus(status: ReturnType<Board["status"]>, chain: ReturnType<Board["verifyChain"]>): void {
  const seen = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  };

  console.log("── Agents ─────────────────────────────");
  if (status.agents.length === 0) console.log("  (none yet)");
  for (const a of status.agents) {
    console.log(`  ${a.name.padEnd(12)} ${a.kind ?? ""}  last seen ${seen(a.lastSeen)}`);
  }

  console.log("\n── Open work ──────────────────────────");
  if (status.openTasks.length === 0) console.log("  (nothing claimed)");
  for (const t of status.openTasks) {
    const holder = t.claimedBy ? `← ${t.claimedBy}` : "(unclaimed)";
    console.log(`  [${t.status}] ${t.key.padEnd(28)} ${holder}`);
  }

  console.log("\n── Unread messages ────────────────────");
  if (status.unreadMessages.length === 0) console.log("  (none)");
  for (const m of status.unreadMessages) {
    const dest = m.toAgent ? `→ ${m.toAgent}` : "→ all";
    console.log(`  ${m.fromAgent} ${dest}: ${m.body}`);
  }

  console.log("\n── Open risks ─────────────────────────");
  if (status.openRisks.length === 0) console.log("  (none)");
  for (const r of status.openRisks) {
    console.log(`  [${r.severity}] ${r.title}`);
  }

  console.log("\n── Recent ─────────────────────────────");
  for (const e of status.recentTimeline) {
    console.log(`  #${e.seq} ${e.actor}: ${e.summary}`);
  }

  const mark = chain.ok ? "✓" : "✗";
  console.log(`\naudit: ${mark} ${chain.length} entries${chain.ok ? "" : ` — BROKEN at ${chain.brokenAtSeq}`}`);
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

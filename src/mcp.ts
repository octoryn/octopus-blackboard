#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Board } from "./board.js";
import { loadConfig } from "./config.js";
import { getAdapter, ADAPTERS } from "./adapters.js";
import * as git from "./git.js";
import type { RiskSeverity, FileChangeKind } from "./types.js";

/**
 * MCP server for the Octopus Blackboard. Any MCP-capable agent (Claude Code,
 * Cursor, a custom client) can read and write the shared board without the
 * blackboard orchestrating anything: the agent decides when to look and what
 * to record. Identity defaults to OCTOBOARD_AGENT; a per-call `agent` argument
 * overrides it.
 */
const server = new Server(
  { name: "octopus-blackboard", version: "0.1.5" },
  { capabilities: { tools: {} } },
);

const defaultAgent = loadConfig().agent;

function withBoard<T>(fn: (b: Board) => T): T {
  const b = Board.open();
  try {
    return fn(b);
  } finally {
    b.close();
  }
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

const AGENT_PROP = {
  agent: {
    type: "string",
    description: "acting agent identity (defaults to OCTOBOARD_AGENT)",
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "board_status",
      description:
        "Read the board: active agents, open tasks and who holds them, unread messages, open risks, recent history. Call this before starting work to see what other agents are doing.",
      inputSchema: {
        type: "object",
        properties: { ...AGENT_PROP },
      },
    },
    {
      name: "board_timeline",
      description:
        "Read the append-only, hash-chained history of everything that happened on the board.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", default: 30 } },
      },
    },
    {
      name: "board_note",
      description: "Broadcast a free-form status note to the board.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, ...AGENT_PROP },
        required: ["text"],
      },
    },
    {
      name: "board_claim",
      description:
        "Claim a task by key so other agents know you own it. If another agent already holds it, the response reports the conflict (the board records but does not block).",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "task key, e.g. trust-layer-policy-schema",
          },
          title: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["key"],
      },
    },
    {
      name: "board_task_define",
      description:
        "Create or update a task's kanban fields: title, description (what it is), project, impact (change surface), and risk level. New keys get a stable task number.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          project: { type: "string" },
          impact: { type: "string" },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          ...AGENT_PROP,
        },
        required: ["key"],
      },
    },
    {
      name: "board_task",
      description:
        "Get a task's full kanban card (status, progress, assignees, active-agent count, impacted files, linked risks) by key or number (#145).",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "task key or number" },
        },
        required: ["ref"],
      },
    },
    {
      name: "board_tasks",
      description: "List all tasks as kanban cards (for a board/kanban view).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_assign",
      description:
        "Assign a task to an agent and notify them — records the assignee AND leaves a 'please look at task #N' message in that agent's inbox. Passive: the board records the ask; the agent reads its inbox and decides to act. Never launches the agent.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "task key or number" },
          to: { type: "string", description: "agent to notify" },
          ...AGENT_PROP,
        },
        required: ["ref", "to"],
      },
    },
    {
      name: "board_progress",
      description:
        "Report task progress 0–100 (moves it to in-progress, or done at 100). Use this from an agent as it works a task so the kanban shows a live progress bar.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "task key or number" },
          percent: { type: "number" },
          ...AGENT_PROP,
        },
        required: ["ref", "percent"],
      },
    },
    {
      name: "board_message",
      description:
        "Leave a message for another agent (or broadcast with to='all').",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "recipient agent name, or 'all'" },
          body: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["to", "body"],
      },
    },
    {
      name: "board_inbox",
      description:
        "Read what's waiting for you: messages (addressed or broadcast) and handoffs left for you.",
      inputSchema: {
        type: "object",
        properties: {
          includeRead: { type: "boolean", default: false },
          ...AGENT_PROP,
        },
      },
    },
    {
      name: "board_handoffs",
      description:
        "Handoffs left FOR you — the work another agent passed to you, with context and open questions.",
      inputSchema: { type: "object", properties: { ...AGENT_PROP } },
    },
    {
      name: "board_decision",
      description:
        "Record a decision and its rationale so other agents see what was decided and why.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          rationale: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["title"],
      },
    },
    {
      name: "board_evidence",
      description:
        "Attach evidence (file path, URL, log, test run) supporting some work.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          note: { type: "string" },
          target: {
            type: "string",
            description: "what it supports, e.g. task:auth-mw",
          },
          ...AGENT_PROP,
        },
        required: ["ref"],
      },
    },
    {
      name: "board_file_changed",
      description:
        "Record that you touched a file. If a task key is given, the response reports files other agents already changed for that task (conflict awareness).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          change: {
            type: "string",
            enum: ["added", "modified", "deleted"],
            default: "modified",
          },
          task: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["path"],
      },
    },
    {
      name: "board_risk",
      description:
        "Flag an open risk the next agent should know before acting.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            default: "medium",
          },
          ...AGENT_PROP,
        },
        required: ["title"],
      },
    },
    {
      name: "board_handoff",
      description:
        "Hand off work to another agent with a summary of the state at handoff.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          summary: { type: "string" },
          context: { type: "string" },
          relatedFiles: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
          task: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["to", "summary"],
      },
    },
    {
      name: "session_start",
      description:
        "Start an execution session. Subsequent writes and links attribute to it. Captures machine, working directory, git branch, and repository.",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" }, ...AGENT_PROP },
      },
    },
    {
      name: "session_stop",
      description: "Close the active session (or a specific one).",
      inputSchema: {
        type: "object",
        properties: { session: { type: "string" }, ...AGENT_PROP },
      },
    },
    {
      name: "board_link",
      description:
        "Attribute a Git commit's files to the current session (who actually produced the code). Reads Git; never rewrites history. Optionally writes an additive git note.",
      inputSchema: {
        type: "object",
        properties: {
          rev: {
            type: "string",
            description: "commit/revision, defaults to HEAD",
          },
          actorType: { type: "string", enum: ["human", "ai"], default: "ai" },
          name: { type: "string", description: "explicit actor name" },
          writeNote: { type: "boolean", default: false },
          ...AGENT_PROP,
        },
      },
    },
    {
      name: "board_attribute",
      description:
        "Record a single attribution (commit + optional file) to a human or AI actor.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string" },
          file: { type: "string" },
          actorType: { type: "string", enum: ["human", "ai"], default: "ai" },
          name: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["rev"],
      },
    },
    {
      name: "board_review",
      description:
        "Record who reviewed a commit and the outcome (human or AI reviewer).",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string" },
          reviewerType: {
            type: "string",
            enum: ["human", "ai"],
            default: "human",
          },
          name: { type: "string" },
          outcome: {
            type: "string",
            enum: ["approved", "changes-requested", "rejected", "commented"],
            default: "approved",
          },
          note: { type: "string" },
          ...AGENT_PROP,
        },
        required: ["rev"],
      },
    },
    {
      name: "board_who",
      description:
        "Who changed a file: Git authors, AI sessions that touched it, and commit attributions. Pass a line number to trace which session introduced that line.",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "number" } },
        required: ["file"],
      },
    },
    {
      name: "board_explain",
      description:
        "Explain a commit: its AI attribution, reviews, and related decisions.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string", description: "defaults to HEAD" },
        },
      },
    },
    {
      name: "board_unreviewed",
      description:
        "List AI-produced commits that have never been reviewed by a human.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_check",
      description:
        "Governance gate: assert policy over commits and report pass/fail plus violations. Read-only — reports, does not block. Use in CI to keep unreviewed AI work off a branch.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            type: "string",
            description:
              "commit range, e.g. main..HEAD (default: all attributed commits)",
          },
          requireHumanReview: {
            type: "boolean",
            description: "fail if an AI commit lacks a human review",
          },
          requireAttribution: {
            type: "boolean",
            description: "fail if a scoped commit has no attribution",
          },
          verifyChain: {
            type: "boolean",
            description: "fail if the timeline hash chain is broken",
          },
        },
      },
    },
    {
      name: "board_export",
      description:
        "Export a portable attribution bundle (attributions, reviews, sessions, decisions) for a commit range, so attribution survives push/PR into a team board or CI.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            type: "string",
            description: "commit range (default: all attributed commits)",
          },
        },
      },
    },
    {
      name: "board_import",
      description:
        "Import an attribution bundle (as produced by board_export) into this board. Idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          bundle: {
            type: "object",
            description: "the bundle object from board_export",
          },
        },
        required: ["bundle"],
      },
    },
    {
      name: "board_trailers",
      description:
        "Git trailer lines encoding a commit's attribution, for embedding in a commit message.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string", description: "defaults to HEAD" },
        },
      },
    },
    {
      name: "board_since",
      description:
        "Subscribe primitive: poll for timeline events after a given seq. Returns the new head seq and events (optionally filtered to those relevant to an agent). Call board_status first to get a starting seq.",
      inputSchema: {
        type: "object",
        properties: {
          afterSeq: {
            type: "number",
            description: "return events with seq greater than this",
          },
          forAgent: {
            type: "string",
            description: "filter to messages/handoffs/conflicts for this agent",
          },
        },
        required: ["afterSeq"],
      },
    },
    {
      name: "board_sign",
      description:
        "Sign the current timeline head with the active session's key (attests board state through the head seq).",
      inputSchema: { type: "object", properties: { ...AGENT_PROP } },
    },
    {
      name: "board_trust",
      description:
        "Show signature trust: which sessions have signed the timeline and whether each signature is valid and still current.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_report",
      description:
        "Accountability scorecard: review coverage, AI/human ratio, per-agent breakdown, session and risk counts.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "board_blame",
      description:
        "Blame → narrative: trace a file line back to the session that introduced it and surface that session's other work, decisions, and handoffs.",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "number" } },
        required: ["file", "line"],
      },
    },
    {
      name: "board_heartbeat",
      description:
        "Stamp the active session as alive (real-time liveness, so other agents can tell active from stale).",
      inputSchema: { type: "object", properties: { ...AGENT_PROP } },
    },
    {
      name: "board_prune",
      description:
        "Retention: delete messages/evidence/file-change rows created before an ISO time. The audit timeline is never pruned.",
      inputSchema: {
        type: "object",
        properties: {
          before: { type: "string", description: "ISO timestamp" },
        },
        required: ["before"],
      },
    },
    {
      name: "board_redact",
      description:
        "Hide a timeline entry's content at the read layer (the hash chain stays valid — this is not cryptographic erasure).",
      inputSchema: {
        type: "object",
        properties: { seq: { type: "number" }, reason: { type: "string" } },
        required: ["seq"],
      },
    },
    {
      name: "board_ingest",
      description:
        "Ingest a CLI transcript's content into the active session (file edits, decisions, notes). Format is one of: " +
        ADAPTERS.join(", ") +
        ". Use 'generic' with our normalized event schema for any CLI.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "raw transcript content" },
          format: { type: "string", enum: ADAPTERS, default: "generic" },
        },
        required: ["content"],
      },
    },
  ],
}));

/** Coerce an optional numeric arg to a non-negative integer, or a fallback. */
function intArg(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, any>;
  const actor: string = args.agent ?? defaultAgent;

  try {
    return handleTool(name, args, actor);
  } catch (err) {
    // Never let a malformed request crash the server; surface a clean error.
    return {
      isError: true,
      ...text(
        `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
});

function handleTool(name: string, args: Record<string, any>, actor: string) {
  switch (name) {
    case "board_status":
      return text(
        withBoard((b) => ({ ...b.status(actor), chain: b.verifyChain() })),
      );

    case "board_timeline":
      return text(withBoard((b) => b.timeline(intArg(args.limit, 30))));

    case "board_note":
      return text(withBoard((b) => b.note(actor, String(args.text))));

    case "board_claim":
      return text(
        withBoard((b) => {
          const r = b.claim(actor, String(args.key), args.title ?? null);
          return r.conflict
            ? {
                ...r,
                warning: `Task "${args.key}" is also held by ${r.conflict}.`,
              }
            : r;
        }),
      );

    case "board_task_define":
      return text(
        withBoard((b) =>
          b.defineTask(actor, String(args.key), {
            title: args.title ?? null,
            description: args.description ?? null,
            project: args.project ?? null,
            impact: args.impact ?? null,
            riskLevel: args.riskLevel ?? null,
          }),
        ),
      );

    case "board_task":
      return text(
        withBoard((b) => {
          const t = b.resolveTask(String(args.ref));
          return t
            ? (b.taskCard(t.key) ?? `No task '${args.ref}'.`)
            : `No task '${args.ref}'.`;
        }),
      );

    case "board_tasks":
      return text(withBoard((b) => b.listTaskCards()));

    case "board_assign":
      return text(
        withBoard((b) => {
          const t = b.resolveTask(String(args.ref));
          return t
            ? (b.assign(actor, t.key, String(args.to)) ??
                `No task '${args.ref}'.`)
            : `No task '${args.ref}'.`;
        }),
      );

    case "board_progress":
      return text(
        withBoard((b) => {
          const t = b.resolveTask(String(args.ref));
          return t
            ? (b.setProgress(actor, t.key, Number(args.percent)) ??
                `No task '${args.ref}'.`)
            : `No task '${args.ref}'.`;
        }),
      );

    case "board_message": {
      const to = args.to === "all" ? null : String(args.to);
      return text(withBoard((b) => b.message(actor, to, String(args.body))));
    }

    case "board_inbox":
      return text(
        withBoard((b) => ({
          messages: b.inbox(actor, Boolean(args.includeRead)),
          handoffs: b.handoffsFor(actor),
        })),
      );

    case "board_handoffs":
      return text(withBoard((b) => b.handoffsFor(actor)));

    case "board_decision":
      return text(
        withBoard((b) =>
          b.decision(actor, String(args.title), {
            rationale: args.rationale ?? null,
            evidence: args.evidence ?? null,
            relatedCommits: args.relatedCommits ?? [],
            relatedTasks: args.relatedTasks ?? [],
          }),
        ),
      );

    case "board_evidence":
      return text(
        withBoard((b) =>
          b.evidence(
            actor,
            String(args.ref),
            args.note ?? null,
            args.target ?? null,
          ),
        ),
      );

    case "board_file_changed":
      return text(
        withBoard((b) => {
          const taskKey = args.task ?? null;
          const others = taskKey
            ? b.filesForTask(taskKey).filter((f) => f.agentId !== actor)
            : [];
          const fc = b.fileChanged(
            actor,
            String(args.path),
            (args.change ?? "modified") as FileChangeKind,
            taskKey,
          );
          return others.length > 0
            ? {
                file: fc,
                warning: `${others.length} change(s) by other agents on task "${taskKey}".`,
                others,
              }
            : { file: fc };
        }),
      );

    case "board_risk":
      return text(
        withBoard((b) =>
          b.risk(
            actor,
            String(args.title),
            (args.severity ?? "medium") as RiskSeverity,
          ),
        ),
      );

    case "board_handoff":
      return text(
        withBoard((b) =>
          b.handoff(actor, String(args.to), String(args.summary), {
            context: args.context ?? null,
            relatedFiles: args.relatedFiles ?? [],
            openQuestions: args.openQuestions ?? [],
            taskKey: args.task ?? null,
          }),
        ),
      );

    case "session_start":
      return text(withBoard((b) => b.startSession(args.label ?? null)));

    case "session_stop":
      return text(
        withBoard(
          (b) =>
            b.stopSession(args.session ?? undefined) ?? "No active session.",
        ),
      );

    case "board_link":
      return text(
        withBoard((b) => {
          const r = b.link(String(args.rev ?? "HEAD"), {
            actorType: args.actorType ?? "ai",
            actor: args.name,
            writeNote: Boolean(args.writeNote),
          });
          return r ?? `Could not resolve '${args.rev ?? "HEAD"}'.`;
        }),
      );

    case "board_attribute":
      return text(
        withBoard((b) =>
          b.attribute(String(args.rev), {
            file: args.file ?? null,
            actorType: args.actorType ?? "ai",
            actor: args.name,
          }),
        ),
      );

    case "board_review":
      return text(
        withBoard((b) =>
          b.review(String(args.rev), {
            reviewerType: args.reviewerType ?? "human",
            reviewer: args.name,
            outcome: args.outcome ?? "approved",
            note: args.note ?? null,
          }),
        ),
      );

    case "board_who": {
      // Distinguish "no line given" from line 0/NaN — only blame on a valid
      // positive integer line.
      const line =
        typeof args.line === "number" || typeof args.line === "string"
          ? Number(args.line)
          : NaN;
      const hasLine = Number.isInteger(line) && line > 0;
      return text(
        withBoard((b) =>
          hasLine
            ? (b.blame(String(args.file), line) ?? "No blame available.")
            : b.whoTouched(String(args.file)),
        ),
      );
    }

    case "board_explain":
      return text(
        withBoard(
          (b) =>
            b.explain(String(args.rev ?? "HEAD")) ??
            `Nothing known about '${args.rev ?? "HEAD"}'.`,
        ),
      );

    case "board_unreviewed":
      return text(withBoard((b) => b.unreviewedCommits()));

    case "board_check": {
      const commits = args.range ? git.revList(String(args.range)) : undefined;
      const anyPolicy =
        args.requireHumanReview || args.requireAttribution || args.verifyChain;
      return text(
        withBoard((b) =>
          b.check({
            commits,
            requireHumanReview: anyPolicy
              ? Boolean(args.requireHumanReview)
              : true,
            requireAttribution: Boolean(args.requireAttribution),
            verifyChain: anyPolicy ? Boolean(args.verifyChain) : true,
          }),
        ),
      );
    }

    case "board_export":
      return text(
        withBoard((b) =>
          b.exportBundle(
            args.range ? git.revList(String(args.range)) : undefined,
          ),
        ),
      );

    case "board_import":
      return text(withBoard((b) => b.importBundle(args.bundle)));

    case "board_trailers":
      return text(
        withBoard((b) => b.trailersFor(String(args.rev ?? "HEAD")).join("\n")),
      );

    case "board_since":
      return text(
        withBoard((b) => {
          const events = b.since(intArg(args.afterSeq, 0));
          return {
            headSeq: b.headSeq(),
            events: args.forAgent
              ? b.notable(events, String(args.forAgent))
              : events,
          };
        }),
      );

    case "board_sign":
      return text(
        withBoard(
          (b) =>
            b.signHead() ??
            "Nothing to sign (no active session, missing key, or empty board).",
        ),
      );

    case "board_trust":
      return text(
        withBoard((b) => ({
          signedThrough: b.signedThrough(),
          signatures: b.verifySignatures(),
        })),
      );

    case "board_report":
      return text(withBoard((b) => b.report()));

    case "board_heartbeat":
      return text(withBoard((b) => b.heartbeat() ?? "No active session."));

    case "board_prune": {
      const when = new Date(String(args.before));
      if (isNaN(when.getTime())) {
        return text("before must be a valid ISO timestamp.");
      }
      return text(withBoard((b) => b.prune(when.toISOString())));
    }

    case "board_redact": {
      const seq = intArg(args.seq, 0);
      if (seq < 1) {
        return text("seq must be a positive integer.");
      }
      return text(
        withBoard((b) =>
          b.redact(seq, args.reason ?? null)
            ? `Redacted #${seq}.`
            : `No timeline entry #${seq}.`,
        ),
      );
    }

    case "board_ingest": {
      const adapter = getAdapter(String(args.format ?? "generic"));
      if (!adapter) {
        return text(`Unknown format. Available: ${ADAPTERS.join(", ")}`);
      }
      const events = adapter.parse(String(args.content ?? ""));
      return text(withBoard((b) => b.ingest(events)));
    }

    case "board_blame": {
      const line = intArg(args.line, 0);
      if (line < 1) {
        return text("line must be a positive integer.");
      }
      return text(
        withBoard(
          (b) =>
            b.blameNarrative(String(args.file), line) ?? "No blame available.",
        ),
      );
    }

    default:
      return text(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

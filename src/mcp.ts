#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Board } from "./board.js";
import { loadConfig } from "./config.js";
import type { RiskSeverity, FileChangeKind } from "./types.js";

/**
 * MCP server for the Octopus Blackboard. Any MCP-capable agent (Claude Code,
 * Cursor, a custom client) can read and write the shared board without the
 * blackboard orchestrating anything: the agent decides when to look and what
 * to record. Identity defaults to OCTOBOARD_AGENT; a per-call `agent` argument
 * overrides it.
 */
const server = new Server(
  { name: "octopus-blackboard", version: "0.1.0" },
  { capabilities: { tools: {} } }
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
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

const AGENT_PROP = {
  agent: { type: "string", description: "acting agent identity (defaults to OCTOBOARD_AGENT)" }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "board_status",
      description:
        "Read the board: active agents, open tasks and who holds them, unread messages, open risks, recent history. Call this before starting work to see what other agents are doing.",
      inputSchema: {
        type: "object",
        properties: { ...AGENT_PROP }
      }
    },
    {
      name: "board_timeline",
      description: "Read the append-only, hash-chained history of everything that happened on the board.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", default: 30 } }
      }
    },
    {
      name: "board_note",
      description: "Broadcast a free-form status note to the board.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, ...AGENT_PROP },
        required: ["text"]
      }
    },
    {
      name: "board_claim",
      description:
        "Claim a task by key so other agents know you own it. If another agent already holds it, the response reports the conflict (the board records but does not block).",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "task key, e.g. trust-layer-policy-schema" },
          title: { type: "string" },
          ...AGENT_PROP
        },
        required: ["key"]
      }
    },
    {
      name: "board_message",
      description: "Leave a message for another agent (or broadcast with to='all').",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "recipient agent name, or 'all'" },
          body: { type: "string" },
          ...AGENT_PROP
        },
        required: ["to", "body"]
      }
    },
    {
      name: "board_inbox",
      description: "Read messages addressed to you or broadcast to the board.",
      inputSchema: {
        type: "object",
        properties: { includeRead: { type: "boolean", default: false }, ...AGENT_PROP }
      }
    },
    {
      name: "board_decision",
      description: "Record a decision and its rationale so other agents see what was decided and why.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, rationale: { type: "string" }, ...AGENT_PROP },
        required: ["title"]
      }
    },
    {
      name: "board_evidence",
      description: "Attach evidence (file path, URL, log, test run) supporting some work.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          note: { type: "string" },
          target: { type: "string", description: "what it supports, e.g. task:auth-mw" },
          ...AGENT_PROP
        },
        required: ["ref"]
      }
    },
    {
      name: "board_file_changed",
      description:
        "Record that you touched a file. If a task key is given, the response reports files other agents already changed for that task (conflict awareness).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          change: { type: "string", enum: ["added", "modified", "deleted"], default: "modified" },
          task: { type: "string" },
          ...AGENT_PROP
        },
        required: ["path"]
      }
    },
    {
      name: "board_risk",
      description: "Flag an open risk the next agent should know before acting.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
          ...AGENT_PROP
        },
        required: ["title"]
      }
    },
    {
      name: "board_handoff",
      description: "Hand off work to another agent with a summary of the state at handoff.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          summary: { type: "string" },
          context: { type: "string" },
          relatedFiles: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
          task: { type: "string" },
          ...AGENT_PROP
        },
        required: ["to", "summary"]
      }
    },
    {
      name: "session_start",
      description:
        "Start an execution session. Subsequent writes and links attribute to it. Captures machine, working directory, git branch, and repository.",
      inputSchema: { type: "object", properties: { label: { type: "string" }, ...AGENT_PROP } }
    },
    {
      name: "session_stop",
      description: "Close the active session (or a specific one).",
      inputSchema: { type: "object", properties: { session: { type: "string" }, ...AGENT_PROP } }
    },
    {
      name: "board_link",
      description:
        "Attribute a Git commit's files to the current session (who actually produced the code). Reads Git; never rewrites history. Optionally writes an additive git note.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string", description: "commit/revision, defaults to HEAD" },
          actorType: { type: "string", enum: ["human", "ai"], default: "ai" },
          name: { type: "string", description: "explicit actor name" },
          writeNote: { type: "boolean", default: false },
          ...AGENT_PROP
        }
      }
    },
    {
      name: "board_attribute",
      description: "Record a single attribution (commit + optional file) to a human or AI actor.",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string" },
          file: { type: "string" },
          actorType: { type: "string", enum: ["human", "ai"], default: "ai" },
          name: { type: "string" },
          ...AGENT_PROP
        },
        required: ["rev"]
      }
    },
    {
      name: "board_review",
      description: "Record who reviewed a commit and the outcome (human or AI reviewer).",
      inputSchema: {
        type: "object",
        properties: {
          rev: { type: "string" },
          reviewerType: { type: "string", enum: ["human", "ai"], default: "human" },
          name: { type: "string" },
          outcome: {
            type: "string",
            enum: ["approved", "changes-requested", "rejected", "commented"],
            default: "approved"
          },
          note: { type: "string" },
          ...AGENT_PROP
        },
        required: ["rev"]
      }
    },
    {
      name: "board_who",
      description:
        "Who changed a file: Git authors, AI sessions that touched it, and commit attributions. Pass a line number to trace which session introduced that line.",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "number" } },
        required: ["file"]
      }
    },
    {
      name: "board_explain",
      description: "Explain a commit: its AI attribution, reviews, and related decisions.",
      inputSchema: { type: "object", properties: { rev: { type: "string", description: "defaults to HEAD" } } }
    },
    {
      name: "board_unreviewed",
      description: "List AI-produced commits that have never been reviewed by a human.",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, any>;
  const actor: string = args.agent ?? defaultAgent;

  switch (name) {
    case "board_status":
      return text(withBoard((b) => ({ ...b.status(actor), chain: b.verifyChain() })));

    case "board_timeline":
      return text(withBoard((b) => b.timeline(args.limit ?? 30)));

    case "board_note":
      return text(withBoard((b) => b.note(actor, String(args.text))));

    case "board_claim":
      return text(
        withBoard((b) => {
          const r = b.claim(actor, String(args.key), args.title ?? null);
          return r.conflict
            ? { ...r, warning: `Task "${args.key}" is also held by ${r.conflict}.` }
            : r;
        })
      );

    case "board_message": {
      const to = args.to === "all" ? null : String(args.to);
      return text(withBoard((b) => b.message(actor, to, String(args.body))));
    }

    case "board_inbox":
      return text(withBoard((b) => b.inbox(actor, Boolean(args.includeRead))));

    case "board_decision":
      return text(
        withBoard((b) =>
          b.decision(actor, String(args.title), {
            rationale: args.rationale ?? null,
            evidence: args.evidence ?? null,
            relatedCommits: args.relatedCommits ?? [],
            relatedTasks: args.relatedTasks ?? []
          })
        )
      );

    case "board_evidence":
      return text(
        withBoard((b) => b.evidence(actor, String(args.ref), args.note ?? null, args.target ?? null))
      );

    case "board_file_changed":
      return text(
        withBoard((b) => {
          const taskKey = args.task ?? null;
          const others = taskKey
            ? b.filesForTask(taskKey).filter((f) => f.agentId !== actor)
            : [];
          const fc = b.fileChanged(actor, String(args.path), (args.change ?? "modified") as FileChangeKind, taskKey);
          return others.length > 0
            ? { file: fc, warning: `${others.length} change(s) by other agents on task "${taskKey}".`, others }
            : { file: fc };
        })
      );

    case "board_risk":
      return text(
        withBoard((b) => b.risk(actor, String(args.title), (args.severity ?? "medium") as RiskSeverity))
      );

    case "board_handoff":
      return text(
        withBoard((b) =>
          b.handoff(actor, String(args.to), String(args.summary), {
            context: args.context ?? null,
            relatedFiles: args.relatedFiles ?? [],
            openQuestions: args.openQuestions ?? [],
            taskKey: args.task ?? null
          })
        )
      );

    case "session_start":
      return text(withBoard((b) => b.startSession(args.label ?? null)));

    case "session_stop":
      return text(withBoard((b) => b.stopSession(args.session ?? undefined) ?? "No active session."));

    case "board_link":
      return text(
        withBoard((b) => {
          const r = b.link(String(args.rev ?? "HEAD"), {
            actorType: args.actorType ?? "ai",
            actor: args.name,
            writeNote: Boolean(args.writeNote)
          });
          return r ?? `Could not resolve '${args.rev ?? "HEAD"}'.`;
        })
      );

    case "board_attribute":
      return text(
        withBoard((b) =>
          b.attribute(String(args.rev), {
            file: args.file ?? null,
            actorType: args.actorType ?? "ai",
            actor: args.name
          })
        )
      );

    case "board_review":
      return text(
        withBoard((b) =>
          b.review(String(args.rev), {
            reviewerType: args.reviewerType ?? "human",
            reviewer: args.name,
            outcome: args.outcome ?? "approved",
            note: args.note ?? null
          })
        )
      );

    case "board_who":
      return text(
        withBoard((b) =>
          args.line ? b.blame(String(args.file), Number(args.line)) ?? "No blame available." : b.whoTouched(String(args.file))
        )
      );

    case "board_explain":
      return text(withBoard((b) => b.explain(String(args.rev ?? "HEAD")) ?? `Nothing known about '${args.rev ?? "HEAD"}'.`));

    case "board_unreviewed":
      return text(withBoard((b) => b.unreviewedCommits()));

    default:
      return text(`Unknown tool: ${name}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

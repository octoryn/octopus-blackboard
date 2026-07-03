import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boardExistsAt,
  detectClient,
  renderQuickstart,
  runQuickstart,
} from "../src/quickstart.js";
import { tempDir } from "./helpers.js";

describe("quickstart command", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir("bbqs-");
    // Never let an ambient session/dir env leak into these boards.
    delete process.env.OCTOBOARD_SESSION;
    delete process.env.OCTOBOARD_DIR;
    delete process.env.OCTOBOARD_AGENT;
  });
  afterEach(() => dir.dispose());

  it("initializes a board in a temp dir when absent", () => {
    expect(boardExistsAt(dir.path)).toBe(false);
    const r = runQuickstart({ cwd: dir.path });
    expect(r.created).toBe(true);
    expect(r.boardDir).toBe(join(dir.path, ".octoboard"));
    expect(boardExistsAt(dir.path)).toBe(true);
    // The proof step wrote one entry and the chain verifies.
    expect(r.probe).not.toBeNull();
    expect(r.probe?.chainOk).toBe(true);
    expect(r.probe?.seq).toBeGreaterThan(0);
  });

  it("is idempotent on a second run — never clobbers the existing board", () => {
    const first = runQuickstart({ cwd: dir.path });
    expect(first.created).toBe(true);
    expect(first.probe?.seq).toBe(1);

    const second = runQuickstart({ cwd: dir.path });
    // Second run reuses the existing board (created === false) and does not
    // reset it: the timeline kept growing rather than starting over.
    expect(second.created).toBe(false);
    expect(second.dbPath).toBe(first.dbPath);
    expect(second.probe?.seq).toBeGreaterThan(first.probe!.seq);
    expect(second.probe?.chainOk).toBe(true);
    expect(boardExistsAt(dir.path)).toBe(true);
  });

  it("detects the client from a fixture env (.claude → Claude Code, .cursor → Cursor)", () => {
    // No marker → generic fallback.
    expect(detectClient(dir.path).client).toBe("json");

    const claudeDir = tempDir("bbqs-claude-");
    mkdirSync(join(claudeDir.path, ".claude"));
    const claude = detectClient(claudeDir.path);
    expect(claude.client).toBe("claude-code");
    expect(claude.label).toBe("Claude Code");
    expect(claude.marker).toBe(".claude");
    claudeDir.dispose();

    const cursorDir = tempDir("bbqs-cursor-");
    mkdirSync(join(cursorDir.path, ".cursor"));
    const cursor = detectClient(cursorDir.path);
    expect(cursor.client).toBe("cursor");
    expect(cursor.label).toBe("Cursor");
    cursorDir.dispose();
  });

  it("does not confidently mis-detect on ambiguous markers (.vscode dir, bare .mcp.json)", () => {
    // A bare editor-settings dir is NOT evidence VS Code is your MCP client.
    const vs = tempDir("bbqs-vscode-");
    mkdirSync(join(vs.path, ".vscode"));
    expect(detectClient(vs.path).client).toBe("json"); // generic, not "vscode"
    // …but an actual VS Code MCP config is real evidence.
    writeFileSync(join(vs.path, ".vscode", "mcp.json"), "{}");
    const withMcp = detectClient(vs.path);
    expect(withMcp.client).toBe("vscode");
    expect(withMcp.label).toBe("VS Code");
    vs.dispose();

    // A bare .mcp.json is shared by several clients → generic, not Claude Code.
    const generic = tempDir("bbqs-mcpjson-");
    writeFileSync(join(generic.path, ".mcp.json"), "{}");
    expect(detectClient(generic.path).client).toBe("json");
    generic.dispose();

    // The definitive .claude marker still wins even alongside a bare .mcp.json.
    const both = tempDir("bbqs-both-");
    mkdirSync(join(both.path, ".claude"));
    writeFileSync(join(both.path, ".mcp.json"), "{}");
    expect(detectClient(both.path).client).toBe("claude-code");
    both.dispose();
  });

  it("threads a detected client through the quickstart result", () => {
    mkdirSync(join(dir.path, ".cursor"));
    const r = runQuickstart({ cwd: dir.path });
    expect(r.detected.client).toBe("cursor");
    // The config snippet is generated for the detected client and writes under
    // its identity.
    const parsed = JSON.parse(r.config.content);
    expect(parsed.mcpServers.blackboard.env.OCTOBOARD_AGENT).toBe("cursor");
  });

  it("prints a non-empty config snippet and the 3-step guide", () => {
    const r = runQuickstart({ cwd: dir.path });
    expect(r.config.content.length).toBeGreaterThan(0);
    const out = renderQuickstart(r);
    expect(out).toContain("Paste this MCP config");
    expect(out).toContain("octopus-blackboard-mcp");
    expect(out).toContain("Reload your MCP client");
    expect(out).toContain("board_status");
  });

  it("can skip the proof step and force a client", () => {
    const r = runQuickstart({ cwd: dir.path, noProbe: true, client: "codex" });
    expect(r.probe).toBeNull();
    expect(r.detected.client).toBe("codex");
    // Board was still initialized even without the proof.
    expect(boardExistsAt(dir.path)).toBe(true);
    // Codex uses TOML.
    expect(r.config.content).toContain("[mcp_servers.blackboard]");
  });
});

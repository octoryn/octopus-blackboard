import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tempDir } from "./helpers.js";
import { mcpConfig, MCP_CLIENTS } from "../src/mcp-config.js";

describe("MCP protocol compliance (any CLI can connect)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir("bbmcp-")));
  afterEach(() => dir.dispose());

  it(
    "initializes, lists tools with valid schemas, and round-trips write+read over stdio",
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/mcp.ts"],
        cwd: process.cwd(),
        env: { ...process.env, OCTOBOARD_DIR: join(dir.path, ".octoboard"), OCTOBOARD_AGENT: "cursor" }
      });
      const client = new Client({ name: "test-cli", version: "1.0.0" });
      await client.connect(transport);

      // initialize succeeded → server identity is reported.
      expect(client.getServerVersion()?.name).toBe("octopus-blackboard");

      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(20);
      // Strict clients require every tool inputSchema to be an object schema.
      for (const t of tools) {
        expect((t.inputSchema as { type?: string }).type).toBe("object");
      }

      await client.callTool({ name: "board_note", arguments: { text: "hello from a generic MCP client" } });
      const status = await client.callTool({ name: "board_status", arguments: {} });
      const parsed = JSON.parse((status.content as { text: string }[])[0].text);
      expect(parsed.agents.map((a: { name: string }) => a.name)).toContain("cursor");
      expect(parsed.chain.ok).toBe(true);

      await client.close();
    },
    30000
  );
});

describe("mcp-config generator", () => {
  it("produces a valid mcpServers block for JSON clients", () => {
    const r = mcpConfig("cursor", { agent: "cursor" });
    const parsed = JSON.parse(r.content);
    expect(parsed.mcpServers.blackboard.command).toBe("npx");
    expect(parsed.mcpServers.blackboard.args).toContain("octopus-blackboard-mcp");
    expect(parsed.mcpServers.blackboard.env.OCTOBOARD_AGENT).toBe("cursor");
  });

  it("defaults the agent identity to the client name, and emits TOML for codex", () => {
    expect(JSON.parse(mcpConfig("gemini").content).mcpServers.blackboard.env.OCTOBOARD_AGENT).toBe("gemini");
    const codex = mcpConfig("codex");
    expect(codex.content).toContain("[mcp_servers.blackboard]");
    expect(codex.content).toContain('OCTOBOARD_AGENT = "codex"');
  });

  it("covers every advertised client without throwing", () => {
    for (const c of MCP_CLIENTS) {
      const r = mcpConfig(c);
      expect(r.path.length).toBeGreaterThan(0);
      expect(r.content.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Octopus Blackboard — a shared memory and coordination layer for AI coding
 * agents. Programmatic entry point; see `cli.ts` for the `octoboard` command
 * and `mcp.ts` for the MCP server.
 */
export { Board, BUNDLE_VERSION } from "./board.js";
export type {
  ClaimResult,
  ChainVerification,
  PolicyResult,
  PolicyViolation,
  PolicyOptions,
  AttributionBundle,
  Report
} from "./board.js";
export { serve } from "./serve.js";
export { createSyncTarget, FileSyncTarget, PostgresSyncTarget } from "./sync.js";
export type { SyncTarget, SyncCounts } from "./sync.js";
export { getAdapter, genericAdapter, ADAPTERS } from "./adapters.js";
export type { Adapter, IngestEvent } from "./adapters.js";
export { mcpConfig, MCP_CLIENTS } from "./mcp-config.js";
export type { McpClient, McpConfigOptions, McpConfigResult } from "./mcp-config.js";
export { loadConfig, resolveBoardDir, findBoardDir } from "./config.js";
export type { BoardConfig, ConfigOverrides } from "./config.js";
export * from "./types.js";

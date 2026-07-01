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
export { loadConfig, resolveBoardDir, findBoardDir } from "./config.js";
export type { BoardConfig, ConfigOverrides } from "./config.js";
export * from "./types.js";

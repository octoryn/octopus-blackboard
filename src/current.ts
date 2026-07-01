import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tracks each agent's currently-active session so successive CLI invocations
 * (which are separate processes) know which session they belong to. Stored as a
 * single JSON map `{ agentName: sessionId }` under the board directory. An
 * explicit `OCTOBOARD_SESSION` env var always wins over the pointer file.
 */

const POINTER_FILE = "current-sessions.json";

function pointerPath(boardDir: string): string {
  return join(boardDir, POINTER_FILE);
}

function readMap(boardDir: string): Record<string, string> {
  const path = pointerPath(boardDir);
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(boardDir: string, map: Record<string, string>): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(pointerPath(boardDir), JSON.stringify(map, null, 2), "utf8");
}

/** The active session id for an agent: env override, then pointer file. */
export function currentSession(boardDir: string, agent: string): string | null {
  const fromEnv = process.env.OCTOBOARD_SESSION;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return readMap(boardDir)[agent] ?? null;
}

export function setCurrentSession(boardDir: string, agent: string, sessionId: string): void {
  const map = readMap(boardDir);
  map[agent] = sessionId;
  writeMap(boardDir, map);
}

export function clearCurrentSession(boardDir: string, agent: string): void {
  const map = readMap(boardDir);
  delete map[agent];
  writeMap(boardDir, map);
}

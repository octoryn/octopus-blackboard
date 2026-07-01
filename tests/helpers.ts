import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board.js";
import { loadConfig, type ConfigOverrides } from "../src/config.js";

/** A fresh temp directory, auto-removed by the returned dispose(). */
export function tempDir(prefix = "bb-"): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Open a board rooted at `<dir>/.octoboard` with an explicit identity. */
export function openBoard(dir: string, overrides: ConfigOverrides = {}): Board {
  // Never let an ambient session pointer/env leak into a test board.
  delete process.env.OCTOBOARD_SESSION;
  return new Board(
    loadConfig({
      boardDir: join(dir, ".octoboard"),
      agent: "claude",
      ...overrides,
    }),
  );
}

export function boardDir(dir: string): string {
  return join(dir, ".octoboard");
}

export function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Initialise a throwaway git repo with a committer identity. */
export function initRepo(cwd: string): void {
  git(["init"], cwd);
  git(["config", "user.email", "dev@example.com"], cwd);
  git(["config", "user.name", "Dev"], cwd);
}

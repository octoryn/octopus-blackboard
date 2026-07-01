import { execFileSync } from "node:child_process";

/**
 * Read-only (and append-only) Git helpers.
 *
 * The blackboard NEVER rewrites Git history. Everything here either reads Git
 * (branch, remote, commit contents, blame) or writes additive metadata that
 * does not touch existing commits (`git notes`). Git remains the source of
 * code; the blackboard is the source of attribution.
 *
 * Every function degrades gracefully outside a repository — returning
 * `undefined` rather than throwing — so the board works with or without Git.
 */

function git(args: string[], cwd: string = process.cwd()): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

export function isRepo(cwd: string = process.cwd()): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

export function repoRoot(cwd: string = process.cwd()): string | undefined {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export function currentBranch(cwd: string = process.cwd()): string | undefined {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch === "HEAD" ? undefined : branch; // detached HEAD
}

export function remoteUrl(cwd: string = process.cwd()): string | undefined {
  return git(["remote", "get-url", "origin"], cwd);
}

/** Resolve any revision (HEAD, a tag, short sha) to a full commit sha. */
export function resolveRev(rev: string, cwd: string = process.cwd()): string | undefined {
  // `--end-of-options` stops a dashed `rev` from being read as a rev-parse flag.
  return git(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], cwd);
}

/**
 * List commit shas in a revision range (e.g. `main..HEAD`), newest first.
 * `--end-of-options` blocks flag injection via a dashed range.
 */
export function revList(range: string, cwd: string = process.cwd()): string[] {
  const out = git(["rev-list", "--end-of-options", range], cwd);
  if (!out) {
    return [];
  }
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

export interface CommitInfo {
  sha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
}

export function commitInfo(rev: string, cwd: string = process.cwd()): CommitInfo | undefined {
  // `--end-of-options` stops flag parsing: a `rev` starting with `-` can never
  // be treated as a git option (e.g. `--output=<path>` file write). See safeRev.
  const out = git(["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "--end-of-options", rev], cwd);
  if (!out) {
    return undefined;
  }
  const parts = out.split("\x1f");
  if (parts.length < 5) {
    return undefined;
  }
  const [sha, author, authorEmail, date, subject] = parts;
  return { sha, author, authorEmail, date, subject };
}

/** Files touched by a commit (paths relative to the repo root). */
export function filesInCommit(rev: string, cwd: string = process.cwd()): string[] {
  // `-z` disables path C-quoting so non-ASCII / whitespace filenames survive
  // intact; `--end-of-options` blocks flag injection via a dashed `rev`.
  const out = git(
    ["show", "--name-only", "--format=", "--no-renames", "-z", "--end-of-options", rev],
    cwd
  );
  if (!out) {
    return [];
  }
  // NUL-delimited; with `--format=` a leading empty field precedes the paths.
  return out.split("\0").filter((p) => p.length > 0);
}

/** Distinct Git authors that have touched a file (from `git log`). */
export function fileAuthors(file: string, cwd: string = process.cwd()): string[] {
  // `--` marks the end of options; `file` is unambiguously a pathspec.
  const out = git(["log", "--format=%an", "--", file], cwd);
  if (!out) {
    return [];
  }
  return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
}

/** Resolve which commit last modified a specific line — `git blame -L`. */
export function blameLine(
  file: string,
  line: number,
  cwd: string = process.cwd()
): { sha: string; author: string } | undefined {
  // `--` ensures a `file` beginning with `-` is a pathspec, not a blame flag
  // (e.g. `--contents=<path>`).
  const out = git(["blame", "-L", `${line},${line}`, "--porcelain", "--", file], cwd);
  if (!out) {
    return undefined;
  }
  const sha = out.split("\n")[0]?.split(" ")[0];
  const authorLine = out.split("\n").find((l) => l.startsWith("author "));
  const author = authorLine ? authorLine.slice("author ".length) : "unknown";
  if (!sha) {
    return undefined;
  }
  return { sha, author };
}

/**
 * Append attribution as a Git note under `refs/notes/blackboard`. Notes are
 * additive: they never alter the commit or its sha. Returns true on success.
 */
export function writeNote(rev: string, note: string, cwd: string = process.cwd()): boolean {
  // `note` is data (bound after `-m`); `--end-of-options` guards the object rev.
  const res = git(["notes", "--ref=blackboard", "add", "-f", "-m", note, "--end-of-options", rev], cwd);
  return res !== undefined;
}

export function readNote(rev: string, cwd: string = process.cwd()): string | undefined {
  return git(["notes", "--ref=blackboard", "show", "--end-of-options", rev], cwd);
}

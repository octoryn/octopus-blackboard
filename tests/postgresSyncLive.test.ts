import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { openBoard, tempDir } from "./helpers.js";
import { createSyncTarget, PostgresSyncTarget } from "../src/sync.js";

const PG = process.env.OCTOBOARD_TEST_PG_URL;

/**
 * DB-gated Postgres sync contract. Skips unless OCTOBOARD_TEST_PG_URL points at
 * a reachable Postgres database. CI runs this against a real service container.
 */
describe.skipIf(!PG)("Postgres team sync (live DB)", () => {
  const marker = randomUUID().slice(0, 8);
  const commit = `deadbeef${marker}`;
  const src = tempDir("bbpg-src-");
  const dst = tempDir("bbpg-dst-");

  afterAll(async () => {
    src.dispose();
    dst.dispose();
    if (!PG) return;
    try {
      const pg = await import("pg");
      const Client = pg.default?.Client ?? pg.Client;
      const client = new Client({ connectionString: PG });
      await client.connect();
      for (const table of [
        "attributions",
        "reviews",
        "sessions",
        "decisions",
      ]) {
        await client.query(`DELETE FROM bb_${table} WHERE id LIKE $1`, [
          `%${marker}%`,
        ]);
      }
      await client.end();
    } catch {
      // Best-effort cleanup only; live DB tests use unique ids.
    }
  });

  it("pushes, dedupes, pulls, and imports portable records", async () => {
    const source = openBoard(src.path, { agent: "claude", cli: "claude-code" });
    const session = source.startSession(`pg-sync-${marker}`);
    source.attribute(commit, {
      actorType: "ai",
      actor: "claude",
      file: `fixtures/${marker}.ts`,
      sessionId: session.id,
    });
    source.review(commit, {
      reviewerType: "human",
      reviewer: "Ran",
      outcome: "approved",
      note: `pg-sync-${marker}`,
    });
    const bundle = source.exportBundle();

    const target = createSyncTarget(PG!);
    expect(target).toBeInstanceOf(PostgresSyncTarget);
    const pushed = await target.push(bundle);
    expect(pushed.attributions).toBe(1);
    expect(pushed.reviews).toBe(1);
    expect((await target.push(bundle)).attributions).toBe(0);

    const pulled = await target.pull();
    expect(pulled.attributions.some((a) => a.commit === commit)).toBe(true);
    expect(pulled.reviews.some((r) => r.commit === commit)).toBe(true);
    await target.close();
    source.close();

    const destination = openBoard(dst.path, { agent: "codex" });
    const counts = destination.importBundle(pulled);
    expect(counts.attributions).toBe(1);
    expect(counts.reviews).toBe(1);
    expect(
      destination.commitsByActor("claude").some((a) => a.commit === commit),
    ).toBe(true);
    destination.close();
  });
});

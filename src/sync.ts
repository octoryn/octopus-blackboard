import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUNDLE_VERSION, type AttributionBundle } from "./board.js";

/**
 * Team sync. A board stays local-first; a `SyncTarget` is a shared place
 * several boards push their attribution bundles to and pull each other's from.
 * Sync moves the portable, id-keyed records (attributions, reviews, sessions,
 * decisions) — never a board's private hash chain, which cannot merge. Merges
 * are idempotent (dedup by id).
 *
 * Two targets ship: a file (a JSON bundle on a shared drive — the reference,
 * fully tested) and Postgres (a team database — requires `pg` + a URL).
 */
export interface SyncCounts {
  attributions: number;
  reviews: number;
  sessions: number;
  decisions: number;
}

export interface SyncTarget {
  push(bundle: AttributionBundle): Promise<SyncCounts>;
  pull(): Promise<AttributionBundle>;
  close(): Promise<void>;
}

const EMPTY: () => AttributionBundle = () => ({
  version: BUNDLE_VERSION,
  exportedAt: "",
  attributions: [],
  reviews: [],
  sessions: [],
  decisions: [],
});

/** Merge `incoming` into `base`, deduping by row id. Returns [merged, added]. */
function mergeById(
  base: AttributionBundle,
  incoming: AttributionBundle,
): [AttributionBundle, SyncCounts] {
  const merged = EMPTY();
  merged.exportedAt = incoming.exportedAt || base.exportedAt;
  const counts: SyncCounts = {
    attributions: 0,
    reviews: 0,
    sessions: 0,
    decisions: 0,
  };
  for (const key of [
    "attributions",
    "reviews",
    "sessions",
    "decisions",
  ] as const) {
    const seen = new Set((base[key] as { id: string }[]).map((r) => r.id));
    const out = [...(base[key] as { id: string }[])];
    for (const row of incoming[key] as { id: string }[]) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
        counts[key] += 1;
      }
    }
    (merged[key] as unknown[]) = out;
  }
  return [merged, counts];
}

/** A shared JSON bundle file — e.g. on a network drive. */
export class FileSyncTarget implements SyncTarget {
  constructor(private readonly path: string) {}

  private read(): AttributionBundle {
    if (!existsSync(this.path)) {
      return EMPTY();
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.path, "utf8"),
      ) as AttributionBundle;
      return { ...EMPTY(), ...parsed };
    } catch {
      return EMPTY();
    }
  }

  async push(bundle: AttributionBundle): Promise<SyncCounts> {
    const [merged, counts] = mergeById(this.read(), bundle);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(merged, null, 2), "utf8");
    return counts;
  }

  async pull(): Promise<AttributionBundle> {
    return this.read();
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

/**
 * A Postgres team board. Records are stored one-row-per-record with a JSONB
 * `data` column keyed by id, so the sync store never has to track the
 * blackboard's evolving column set. Requires the optional `pg` dependency and a
 * reachable connection URL.
 */
export class PostgresSyncTarget implements SyncTarget {
  private clientPromise: Promise<any> | null = null;

  constructor(private readonly url: string) {}

  private async client(): Promise<any> {
    if (this.clientPromise) {
      return this.clientPromise;
    }
    this.clientPromise = (async () => {
      let pg: any;
      try {
        // Non-literal specifier: `pg` is an optional dependency, so it is
        // imported dynamically and typed loosely rather than resolved at build.
        const mod = "pg";
        pg = await import(mod);
      } catch {
        throw new Error(
          "Postgres sync requires the optional 'pg' package: npm install pg",
        );
      }
      const Client = pg.default?.Client ?? pg.Client;
      const client = new Client({ connectionString: this.url });
      await client.connect();
      for (const t of ["attributions", "reviews", "sessions", "decisions"]) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS bb_${t} (id TEXT PRIMARY KEY, data JSONB NOT NULL)`,
        );
      }
      return client;
    })();
    return this.clientPromise;
  }

  async push(bundle: AttributionBundle): Promise<SyncCounts> {
    const client = await this.client();
    const counts: SyncCounts = {
      attributions: 0,
      reviews: 0,
      sessions: 0,
      decisions: 0,
    };
    for (const key of [
      "attributions",
      "reviews",
      "sessions",
      "decisions",
    ] as const) {
      for (const row of bundle[key] as { id: string }[]) {
        const res = await client.query(
          `INSERT INTO bb_${key} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [row.id, JSON.stringify(row)],
        );
        counts[key] += res.rowCount ?? 0;
      }
    }
    return counts;
  }

  async pull(): Promise<AttributionBundle> {
    const client = await this.client();
    const bundle = EMPTY();
    for (const key of [
      "attributions",
      "reviews",
      "sessions",
      "decisions",
    ] as const) {
      const res = await client.query(`SELECT data FROM bb_${key}`);
      (bundle[key] as unknown[]) = res.rows.map((r: any) =>
        typeof r.data === "string" ? JSON.parse(r.data) : r.data,
      );
    }
    return bundle;
  }

  async close(): Promise<void> {
    if (this.clientPromise) {
      const client = await this.clientPromise;
      await client.end();
    }
  }
}

/** Build a target from a spec: a `postgres://` URL, or else a file path. */
export function createSyncTarget(spec: string): SyncTarget {
  if (spec.startsWith("postgres://") || spec.startsWith("postgresql://")) {
    return new PostgresSyncTarget(spec);
  }
  return new FileSyncTarget(spec);
}

import type { Driver } from "neo4j-driver";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, stat, rm, type FileHandle } from "node:fs/promises";
import { createDriver, neo4jConfigFromEnv, newSession } from "../../src/interfaces/neo4j.js";
import { migrate } from "../../src/memory/migrate.js";

export interface TestContext {
  driver: Driver;
}

const LOCK_PATH = join(tmpdir(), "minimi-integration.lock");
let lockHandle: FileHandle | null = null;

/**
 * Community edition (pinned image) supports exactly one database, so test-suite
 * isolation by database is unavailable. Instead the integration suite is
 * EXPLICITLY SERIALIZED via a cross-process lock file: suites can run in
 * separate processes (node --test spawns one per file) without wiping each
 * other's fixtures. Release is in `closeDatabase`.
 */
async function acquireIntegrationLock(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      lockHandle = await open(LOCK_PATH, "wx");
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const st = await stat(LOCK_PATH);
        if (Date.now() - st.mtimeMs > 10 * 60_000) {
          await rm(LOCK_PATH, { force: true }); // stale lock from a crashed suite
          continue;
        }
      } catch {
        /* vanished between open and stat — retry */
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the integration-suite lock");
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
    }
  }
}

async function releaseIntegrationLock(): Promise<void> {
  try {
    if (lockHandle) {
      await lockHandle.close();
      lockHandle = null;
      await rm(LOCK_PATH, { force: true });
    }
  } catch {
    /* never mask suite failures */
  }
}

export async function freshDatabase(): Promise<TestContext> {
  await acquireIntegrationLock();
  const driver = createDriver(neo4jConfigFromEnv());
  await migrate(neo4jConfigFromEnv(), driver); // creates constraints/indexes if missing
  const session = newSession(driver, "WRITE");
  await session.run("MATCH (n) WHERE NOT n:SchemaVersion DETACH DELETE n");
  await session.close();
  return { driver };
}

export async function closeDatabase(ctx: TestContext | undefined): Promise<void> {
  try {
    if (ctx) await ctx.driver.close();
  } finally {
    await releaseIntegrationLock();
  }
}

/** Backdoor for test fixtures: force a job's lease into the past (simulates expiry). */
export async function expireLease(ctx: TestContext, jobId: string): Promise<void> {
  const s = newSession(ctx.driver, "WRITE");
  await s.run("MATCH (j:Job {id: $id}) SET j.leaseUntil = datetime() - duration({minutes: 5})", { id: jobId });
  await s.close();
}

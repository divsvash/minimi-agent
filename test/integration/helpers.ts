import type { Driver } from "neo4j-driver";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, stat, utimes, writeFile, readFile, rm, type FileHandle } from "node:fs/promises";
import { createDriver, neo4jConfigFromEnv, newSession } from "../../src/interfaces/neo4j.js";
import { migrate } from "../../src/memory/migrate.js";

export interface TestContext {
  driver: Driver;
}

const LOCK_PATH = join(tmpdir(), "minimi-integration.lock");
/** Heartbeat refreshes the lock mtime every 2s; a lock is stale only when its owner is dead or mtime is 10 min old. */
const HEARTBEAT_MS = 2_000;
const STALE_MS = 10 * 60_000;

let lockHandle: FileHandle | null = null;
let heartbeat: NodeJS.Timeout | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockOwner(): Promise<number | null> {
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function isLockStale(): Promise<boolean> {
  const owner = await readLockOwner();
  if (owner !== null && !pidAlive(owner)) return true;
  if (owner === null) {
    try {
      const st = await stat(LOCK_PATH);
      return Date.now() - st.mtimeMs > STALE_MS;
    } catch {
      return true; // vanished — free to take
    }
  }
  return false;
}

/**
 * Community edition (pinned image) supports exactly one database, so test-suite
 * isolation by database is unavailable. Suites are explicitly serialized
 * cross-process via a PID-owned lock file with a heartbeat (mtime refresh).
 * A lock is taken forcibly only when its owner process is dead or the mtime
 * is over 10 minutes stale. Release happens in closeDatabase — and on failure
 * of freshDatabase after acquisition.
 */
async function acquireIntegrationLock(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      lockHandle = await open(LOCK_PATH, "wx");
      await writeFile(lockHandle, JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME ?? "host", acquiredAt: Date.now() }));
      heartbeat = setInterval(async () => {
        try {
          if (lockHandle) await utimes(LOCK_PATH, new Date(), new Date());
        } catch {
          /* best-effort */
        }
      }, HEARTBEAT_MS);
      heartbeat.unref();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (await isLockStale()) {
        await rm(LOCK_PATH, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the integration-suite lock");
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
    }
  }
}

async function releaseIntegrationLock(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
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
  try {
    const driver = createDriver(neo4jConfigFromEnv());
    await migrate(neo4jConfigFromEnv(), driver);
    const session = newSession(driver, "WRITE");
    await session.run("MATCH (n) WHERE NOT n:SchemaVersion DETACH DELETE n");
    await session.close();
    return { driver };
  } catch (err) {
    await releaseIntegrationLock(); // do not leak the lock on failure
    throw err;
  }
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

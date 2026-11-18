import type { Driver } from "neo4j-driver";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { open, stat, utimes, writeFile, readFile, rm, rename, link, type FileHandle } from "node:fs/promises";
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
let lockToken: string | null = null;
let heartbeat: NodeJS.Timeout | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockSnapshot(): Promise<string | null> {
  try {
    return await readFile(LOCK_PATH, "utf8");
  } catch {
    return null;
  }
}

/** A heartbeat-refreshed lock whose owner pid looks dead is still treated as LIVE while
 *  the file mtime is fresh — pidAlive can misfire (pid recycling, EPERM), and stealing a
 *  live suite's lock cascades into cross-process database corruption. */
const LIVE_MTIME_GRACE_MS = 45_000;

/** Snapshot-based staleness check for a lock that already exists (EEXIST path). */
async function staleSnapshot(): Promise<{ stale: boolean; raw: string | null }> {
  const raw = await readLockSnapshot();
  if (raw === null) return { stale: true, raw: null }; // vanished — free to take
  let owner: number | null = null;
  try {
    const parsed = JSON.parse(raw) as { pid?: number };
    owner = typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    owner = null;
  }
  let mtimeMs = Number.POSITIVE_INFINITY;
  try {
    const st = await stat(LOCK_PATH);
    mtimeMs = st.mtimeMs;
  } catch {
    return { stale: true, raw }; // vanished between read and stat — free to take
  }
  const mtimeAge = Date.now() - mtimeMs;
  if (owner !== null) {
    const dead = !pidAlive(owner);
    // dead pid alone is not enough — require the mtime to be older than the grace window
    return { stale: dead && mtimeAge > LIVE_MTIME_GRACE_MS, raw };
  }
  return { stale: mtimeAge > STALE_MS, raw };
}

/**
 * Atomic ownership handoff: rename(2)/MoveFile is atomic on the same filesystem,
 * so after the rename succeeds THIS process holds the only reference to those exact
 * bytes. Deletion or restoration is decided on the quarantined copy — a check and a
 * remove on the shared path are never performed as two separate steps.
 * Returns null when the lock path is already gone.
 */
async function quarantineLock(): Promise<{ quarantine: string; raw: string | null } | null> {
  const quarantine = `${LOCK_PATH}.quarantine-${process.pid}-${randomUUID()}`;
  try {
    await rename(LOCK_PATH, quarantine);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // already gone
    throw err;
  }
  let raw: string | null = null;
  try {
    raw = await readFile(quarantine, "utf8");
  } catch {
    raw = null; // unreadable — caller decides (restore, never delete blindly)
  }
  return { quarantine, raw };
}

/** Put back a quarantined lock this process does NOT own. Restoration uses a hard
 *  link, which fails atomically with EEXIST if a replacement owner already took the
 *  path — the replacement is never clobbered. */
async function restoreQuarantinedLock(quarantine: string): Promise<void> {
  try {
    await link(quarantine, LOCK_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // LOCK_PATH is held by a replacement owner; the quarantined bytes are obsolete.
    } else {
      // Cannot restore atomically — leave the uniquely named copy rather than destroy it.
      console.warn(`unable to restore quarantined integration-suite lock ${quarantine}: ${String(err)}`);
      return;
    }
  }
  await rm(quarantine, { force: true });
}

/** Remove the lock only if it is still byte-identical to the stale snapshot we judged —
 *  the rename in quarantineLock() is the atomic point that makes this safe. */
async function rmIfUnchanged(snapshot: string | null): Promise<boolean> {
  const qu = await quarantineLock();
  if (!qu) return true; // vanished — free to take
  if (qu.raw === snapshot) {
    await rm(qu.quarantine, { force: true });
    return true;
  }
  await restoreQuarantinedLock(qu.quarantine);
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
      lockToken = randomUUID();
      await writeFile(
        lockHandle,
        JSON.stringify({
          pid: process.pid,
          host: process.env.COMPUTERNAME ?? "host",
          acquiredAt: Date.now(),
          token: lockToken,
        }),
      );
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
      if (code !== "EEXIST") {
        // partial acquisition (e.g. writeFile failed after open) — clean up only our own lock
        await releaseIntegrationLock();
        throw err;
      }
      const snap = await staleSnapshot();
      if (snap.stale) {
        // forcible take only against the exact stale bytes we judged — never a replacement lock
        if (await rmIfUnchanged(snap.raw)) {
          console.warn("integration-suite lock judged stale and forcibly reclaimed");
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for the integration-suite lock");
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
    }
  }
}

/** Remove the shared lock only if it still carries THIS process's token — decided on the
 *  atomically quarantined copy, so a replacement owner's lock is never deleted. */
async function removeLockIfOurs(): Promise<void> {
  if (!lockToken) return;
  const qu = await quarantineLock();
  if (!qu) return; // already gone — nothing to remove
  let ours = false;
  if (qu.raw !== null) {
    try {
      const parsed = JSON.parse(qu.raw) as { token?: unknown };
      // Valid JSON carrying someone else's token ⇒ replacement owner, never touch it.
      // Valid JSON with our token (or no token — cannot be a replacement's) ⇒ ours.
      ours = !(typeof parsed.token === "string" && parsed.token !== lockToken);
    } catch (err) {
      // Unparseable ⇒ almost certainly our own partial write (a replacement owner
      // always writes valid JSON), so removing is safe. Anything else ⇒ restore.
      ours = err instanceof SyntaxError;
    }
  }
  // raw === null (unreadable) ⇒ restore, never delete blindly.
  if (ours) {
    await rm(qu.quarantine, { force: true });
  } else {
    await restoreQuarantinedLock(qu.quarantine);
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
      await removeLockIfOurs();
      lockToken = null;
    }
  } catch {
    /* never mask suite failures */
  }
}

export async function freshDatabase(): Promise<TestContext> {
  await acquireIntegrationLock();
  let driver: Driver | undefined;
  try {
    driver = createDriver(neo4jConfigFromEnv());
    await migrate(neo4jConfigFromEnv(), driver);
    const session = newSession(driver, "WRITE");
    try {
      await session.run("MATCH (n) WHERE NOT n:SchemaVersion DETACH DELETE n");
    } finally {
      await session.close();
    }
    return { driver };
  } catch (err) {
    try {
      await driver?.close(); // do not leak the driver when migration fails mid-setup
    } catch {
      /* best-effort */
    }
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

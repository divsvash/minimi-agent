import type { Driver } from "neo4j-driver";
import { createDriver, neo4jConfigFromEnv, newSession } from "../../src/interfaces/neo4j.js";
import { migrate } from "../../src/memory/migrate.js";

export interface TestContext {
  driver: Driver;
}

export async function freshDatabase(): Promise<TestContext> {
  await migrate(); // creates constraints/indexes if missing
  const driver = createDriver(neo4jConfigFromEnv());
  const session = newSession(driver, "WRITE");
  await session.run("MATCH (n) DETACH DELETE n");
  await session.close();
  return { driver };
}

export async function closeDatabase(ctx: TestContext | undefined): Promise<void> {
  if (!ctx) return;
  await ctx.driver.close();
}

/** Backdoor for test fixtures: force a job's lease into the past (simulates expiry). */
export async function expireLease(ctx: TestContext, jobId: string): Promise<void> {
  const s = newSession(ctx.driver, "WRITE");
  await s.run("MATCH (j:Job {id: $id}) SET j.leaseUntil = datetime() - duration({minutes: 5})", { id: jobId });
  await s.close();
}

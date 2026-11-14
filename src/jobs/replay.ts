/**
 * Reconciliation replayer (ADR-010): re-enqueues extraction for episodes lacking a
 * completed extract job. NOT the crash-recovery path — torn writes cannot occur
 * (Episode+Job commit atomically). Use for legacy imports, manual fixes, dead-job resets.
 * Enqueue is idempotent by key, so repeated runs are safe.
 */
import { createDriver, neo4jConfigFromEnv } from "../interfaces/neo4j.js";
import { EpisodeStore } from "../memory/episodeStore.js";
import { JobLedger } from "./ledger.js";
import { migrate } from "../memory/migrate.js";

async function main() {
  await migrate();
  const cfg = neo4jConfigFromEnv();
  const driver = createDriver(cfg);
  const ledger = new JobLedger(driver);
  const episodes = new EpisodeStore(driver);
  const orphans = await episodes.withoutCompletedExtraction(new Date());
  for (const ep of orphans) {
    await ledger.enqueue("extract", { episodeId: ep.id }, `extract:${ep.id}`);
  }
  console.log(`replay: ensured-extract-jobs for ${orphans.length} episode(s)`);
  await driver.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

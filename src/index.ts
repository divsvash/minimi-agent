import { createApp } from "./api/app.js";
import { migrate } from "./memory/migrate.js";
import { JobLedger } from "./jobs/ledger.js";
import { createDriver, neo4jConfigFromEnv } from "./interfaces/neo4j.js";

async function main() {
  await migrate(); // idempotent
  const { app, driver } = createApp();

  // In-process sweeper: requeues expired running jobs, reaps invisible provisionals.
  // Fences — not the sweeper — are the correctness mechanism (ADR-010); this is hygiene.
  const ledger = new JobLedger(driver, {
    leaseSeconds: Number(process.env.JOB_LEASE_SECONDS ?? 120),
    sweepIntervalMs: 30_000,
  });
  const sweeper = setInterval(() => {
    ledger.sweep().catch((err) => console.error("sweep failed", err));
  }, 30_000);
  sweeper.unref();

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`minimi listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

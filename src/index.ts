import { createApp } from "./api/app.js";
import { migrate } from "./memory/migrate.js";
import { JobLedger } from "./jobs/ledger.js";
import { createDriver, neo4jConfigFromEnv } from "./interfaces/neo4j.js";

async function main() {
  // ONE shared driver for the whole process — created here, closed on shutdown.
  const driver = createDriver(neo4jConfigFromEnv());
  await migrate(neo4jConfigFromEnv(), driver); // idempotent

  const { app } = createApp({ driver });

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
  const server = app.listen(port, () => console.log(`minimi listening on :${port}`));

  const shutdown = async (signal: string) => {
    console.log(`${signal} received — closing HTTP and driver…`);
    clearInterval(sweeper);
    server.close(async () => {
      await driver.close();
      process.exit(0);
    });
    // hard deadline — never hang shutdown
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

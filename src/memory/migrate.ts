import { createDriver, neo4jConfigFromEnv, newSession } from "../interfaces/neo4j.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * Apply pending migrations. Idempotent; recorded in (:SchemaVersion).
 * Schema statements run as autocommit (never mixed with writes in one tx —
 * Neo4j forbids combining schema modification with writes in a single transaction).
 */
export async function migrate(driverConfig = neo4jConfigFromEnv(), existingDriver?: import("neo4j-driver").Driver): Promise<string[]> {
  const driver = existingDriver ?? createDriver(driverConfig);
  const ownDriver = existingDriver === undefined;
  const applied: string[] = [];
  try {
    const s0 = newSession(driver, "WRITE");
    // constraint creation is itself a schema statement — autocommit (session.run), not executeWrite
    await s0.run("CREATE CONSTRAINT schema_version IF NOT EXISTS FOR (v:SchemaVersion) REQUIRE v.id IS UNIQUE");
    await s0.close();

    for (const migration of MIGRATIONS) {
      const writer = newSession(driver, "WRITE");
      const { records } = await writer.run(
        "MATCH (v:SchemaVersion {id: $id}) RETURN v.id AS id",
        { id: migration.id },
      );
      await writer.close();
      if (records.length > 0) continue;

      for (const statement of migration.cypher) {
        const s = newSession(driver, "WRITE");
        try {
          await s.run(statement); // autocommit — schema modification must stand alone
        } finally {
          await s.close();
        }
      }

      const tail = newSession(driver, "WRITE");
      try {
        await tail.run("MERGE (v:SchemaVersion {id: $id}) SET v.appliedAt = datetime()", {
          id: migration.id,
        });
      } finally {
        await tail.close();
      }
      applied.push(migration.id);
    }
  } finally {
    if (ownDriver) await driver.close();
  }
  return applied;
}

// Run directly: tsx src/memory/migrate.ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

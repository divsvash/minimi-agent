import neo4j, { Driver, Session } from "neo4j-driver";

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jConfig {
  return {
    uri: env.NEO4J_URI ?? "bolt://localhost:7687",
    user: env.NEO4J_USER ?? "neo4j",
    password: env.NEO4J_PASSWORD ?? "minimi-dev-password",
  };
}

export function createDriver(cfg: Neo4jConfig): Driver {
  return neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
    maxConnectionPoolSize: 16,
    disableLosslessIntegers: true,
  });
}

export type SessionMode = "WRITE" | "READ";
export function newSession(driver: Driver, mode: SessionMode = "WRITE"): Session {
  return driver.session({
    defaultAccessMode: mode === "WRITE" ? neo4j.session.WRITE : neo4j.session.READ,
  });
}

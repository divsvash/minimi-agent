# Minimi

Minimi is a conversational agent built around persistent memory rather than disposable chat history. Its first implementation provides atomic episode ingestion, timezone-aware recall, full-text search and a fenced background job ledger. 
Start here: **[DESIGN.md](DESIGN.md)** (one page) · full reference: **[docs/architecture.md](docs/architecture.md)** · decisions: **[docs/decisions/](docs/decisions/)**

## Status: Slice 1 shipped & verified; Slices 2–11 planned

Working & tested: Episode persistence (verbatim, atomic with outbox job), idempotent ingest (upstream `messageId` preferred; content-addressed fallback), per-session sequence guard with `(sessionId, seq)` uniqueness, day-scoped tz-aware verbatim recall with "interpreted as" echo, synchronous full-text search, and the Neo4j job ledger — fenced claiming, fenced output commits, provisional outputs, sweeper, replay reconciler.

Not yet (see architecture.md §11): extraction (3) · entity resolution (4) · temporal corrections (5) · hybrid retrieval/synthesis (6) · research subsystem (7) · reasoning flows (8).

## Prerequisites
- Node ≥ 20 · Docker with compose (image pinned: `neo4j:5.26.0-community` + APOC)

## One-command dev
```bash
npm install
npm run db:up        # starts Neo4j, waits for healthcheck
npm run dev          # runs migrations, serves on :3000, starts the sweeper
```

## Endpoints (Slice 1)
- `POST /episodes` `{sessionId, text, role?, messageId?, tz?, occurredAt?}` → `{episodeId, created, jobId}`
  - Identity contract: `messageId` wins; otherwise content-addressed. Without `messageId`, byte-identical resends are idempotent re-deliveries of one turn; genuinely identical repeated turns need a `messageId`.
- `GET /recall?date=2026-11-03&tz=Europe/Lisbon` → verbatim turns + `interpretedAs` echo (UTC bounds; DST-aware)
- `GET /search?q=HubSpot`
- `GET /health` · `GET /jobs/dead` · `POST /jobs/:id/redrive`

## Tests
```bash
npm run test:unit          # offline (tz math, id hashing)
npm run test:integration   # boots pinned Neo4j; suite is serialized cross-process (Community edition = one DB)
```
The claim race is a hard gate: 8 racing workers × 24 jobs → exactly-once claim; stale-generation completion, stale output writes, and provisional promotion/reaping are all covered; concurrent-ingest `(sessionId, seq)` uniqueness is covered.

## Configuration
Copy `.env.example` → `.env`. Pinned `dbms.index.fulltext.eventually_consistent=false` (ADR-011) — do not enable eventual consistency. `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS` tune the ledger. Migrations: `npm run db:migrate` (idempotent; safe to re-run).

## Layout
`src/core` contracts-ish primitives · `src/interfaces` neo4j driver factory · `src/memory` stores/migrations · `src/ingestion` ingest + outbox · `src/jobs` ledger + replay · `src/api` HTTP surface · `test/integration` (lock-serialized suites).

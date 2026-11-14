# Minimi

Conversational agent with persistent, temporal, and relational memory. See `docs/architecture.md` and `docs/decisions/`.

## Current status: Slice 1 — memory spine + fenced job ledger

Working: Episode persistence (verbatim, atomic with outbox job), idempotent ingest, day-scoped verbatim recall with tz handling, synchronous full-text search, the Neo4j-backed job ledger with fenced claiming/completion/outputs, provisional outputs, sweeper, replay reconciler.

Not yet: extraction (Slice 3), entities (4), temporal corrections (5), hybrid retrieval (6), research subsystem (7), reasoning flows (8).

## Prerequisites
- Node ≥ 20, Docker with compose.

## One-command dev
```bash
npm install
npm run db:up        # neo4j:5.26.0-community + APOC, waits for healthcheck
npm run dev          # migrates, starts API on :3000, starts in-process sweeper
```
OpenAPI-ish endpoints:
- `POST /episodes` `{sessionId, text, role?, tz?, occurredAt?}` → `{episodeId, created, jobId}`
- `GET /recall?date=2026-11-03&tz=Europe/Lisbon` → verbatim turns + `interpretedAs` echo
- `GET /search?q=HubSpot`
- `GET /jobs/dead`, `POST /jobs/:id/redrive`

## Tests
```bash
npm run test:unit          # offline
npm run test:integration   # boots the pinned Neo4j container; race test is a real gate
```
The claim-race integration test claims 24 jobs from 8 racing workers and asserts exactly-one-winner; stale-generation completion, stale output writes, and provisional invisibility are covered there too.

## Configuration
Copy `.env.example` → `.env`. Key settings: `NEO4J_*`, `PORT`, `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`. Full-text eventual-consistency mode is pinned OFF (`NEO4J_dbms_index_fulltext_eventually__consistent=false`) — do not enable it (ADR-011).

# Integrated Implementation Log

Date: 2026-09-01

## Scope

The recovery implementation was integrated into the `dev-vale` codebase. The
result keeps the existing Git workspace recovery UI and APIs while adding the
developer trace stream, attempt-level observability, and durable trace journal.

The integrated working copy is:

`D:\kaggle\6002作业\trace1-Agent-dev-vale-integrated`

The same source was synchronized to the requested target:

`D:\kaggle\hacthon\trace1-Agent-`

## Completed

- Preserved Git checkpoint, diff preview, path selection, restore, conflict
  handling, restore audit records, and interrupted-restore recovery.
- Added stable per-run trace sequence numbers and migration support for older
  database versions.
- Added `attempt.started`, `attempt.completed`, `attempt.failed`,
  `retry.scheduled`, and `model.failed` events with attempt and operation IDs.
- Added live NDJSON trace streaming at
  `GET /api/developer/runs/:id/stream`, with token authentication, snapshot
  replay, de-duplication, and terminal stream closure.
- Added `TraceJournal` recovery for events emitted while the process is
  restarting or the database write is temporarily unavailable.
- Connected the real runner to `AttemptTrace`; model, tool, file, and failure
  events remain associated with the attempt and operation/span IDs.
- Added Git executable discovery for PATH, Git for Windows, and `MinGit-*`.
  An explicit `GIT_BIN` path still takes precedence. Git is spawned without a
  shell, so paths containing spaces work.
- Added the dev-vale demo matrix, tests, retry trace contract, and this log.

## Recovery and retry boundary

The current integration observes one real attempt per run and records retry
metadata, but it does not automatically retry or switch models. That boundary
is deliberate: automatic retry needs an idempotent fallback policy and
attempt-level workspace snapshots for side-effect safety. The extension point
is `runner-factory.ts`; the existing Git restore path can be reused there.

## Verification

- Integrated copy: typecheck, demo matrix (13/13), server tests (100/100), and
  server/web production builds pass.
- Target copy: typecheck, demo matrix (13/13), server tests (100/100), and
  server/web production builds pass under normal write permissions.
- The destination `add-roll-back` work tree also retains the original live
  stream de-duplication and operation-correlation tests; its server suite is
  `102/102` after the recovery integration.
- MinGit 2.54.0 was exercised with a real SHA-256 bare repository: checkpoint,
  deletion, preview, and exact-byte restore all succeeded.
- Runtime smoke checks passed for health, system capability reporting, and
  stream authentication/404 handling.

## Local Git requirement

The application uses local Git plumbing only (`hash-object`, `cat-file`,
`mktree`, `commit-tree`, `update-ref`, and related commands). It does not need a
remote helper. Either Git for Windows or MinGit is sufficient, provided it is
at least version 2.29 and supports SHA-256 repositories. Set `GIT_BIN` when
automatic discovery is not appropriate.

The target directory did not contain a `.git` directory, so the integration
was synchronized as source files rather than performed as a repository merge.

---
title: M3 NLP
summary: entity / IOC / theme extraction — in-batch concurrency
last_updated: 2026-05-28
code_sha: def5678
atoms: 8
commits: 5
---
# component: M3 NLP

## Current architecture

In-batch `asyncio.gather` + `Semaphore`.

## Cross-links

- Theme: [[quality]]

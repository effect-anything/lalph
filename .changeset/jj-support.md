---
"lalph": patch
---

Add support for running lalph inside Jujutsu (`jj`) repositories, including GitHub repo detection, worktree/workspace setup, explicit per-project execution mode selection (`worktree` vs `in-place`), jj-aware push flows, and automatic task change preparation that reuses an empty current change before creating a new one. Also add `openai-api` and `anthropic-api` clanka providers for local API-compatible model backends, while keeping `crs` as a temporary compatibility alias.

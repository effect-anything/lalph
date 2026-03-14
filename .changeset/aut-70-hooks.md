---
"lalph": patch
---

Add post-create hook execution during worktree setup, with `.lalph/hooks.yml` taking precedence over the legacy `scripts/worktree-setup.sh` fallback. Hook commands now run in sorted order with template interpolation, inherited `LALPH_*` environment variables, and strict failure handling.

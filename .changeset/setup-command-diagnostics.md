---
"cf-open-agents-api": patch
---

A failed environment setup command now says how it failed: the `environment_setup_failed` message names the exit code or the 120-second timeout, and the Worker logs `Environment command failed` with the command, its exit code and the tail of its output.

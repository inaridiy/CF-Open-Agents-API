---
"cf-open-agents-api": patch
---

A harness container that does not become ready within 3 minutes now fails its boot, and the next attempt starts a new container; a start that never answered used to hold the turn until the runtime ended the alarm (about 15 minutes). A sandbox container that replaced an earlier one (after an idle stop or a platform restart) starts the servers its object served before, such as Codex's exec-server, on the first proxied request; a turn used to continue without a shell.

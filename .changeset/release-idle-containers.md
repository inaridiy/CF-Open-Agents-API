---
"cf-open-agents-api": patch
---

Stop harness and sandbox containers once a session is idle or deleted. The harness never reached its idle timeout because an unread `POST /jobs` response stayed counted as a request in flight; a Codex sandbox never slept because the Sandbox SDK keeps a container awake while `exec-server` runs; and deleting a session left both running. HarnessDO now releases every Container response body, destroys its idle container and the sandbox it owns, and a sandbox whose harness is gone ends itself. `RuntimeDriver` gains an optional `release(sessionId)`, called after a session's deletion commits.

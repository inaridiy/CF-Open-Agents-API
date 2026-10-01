---
"cf-open-agents-api": patch
"create-cf-open-agents-api": patch
---

Fix the upgrade from 0.5: a Durable Object class whose namespace has had a default-policy container application does not start `durable_object` containers, and the old applications have to go as part of the switch. "Upgrading from 0.5" in docs/deployment.md now binds `HARNESS` and `SANDBOX` to new classes (`HarnessContainerDO`, `SandboxContainerDO`) and deletes the old applications. `create-cf-open-agents-api init` and `doctor` accept those class names; `init --force` no longer rewrites a default-policy container entry in place, which produced a configuration whose containers never started. `SandboxDO` now fails a container start that has not become ready within 3 minutes instead of waiting indefinitely.

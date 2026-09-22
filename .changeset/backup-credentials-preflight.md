---
"cf-open-agents-api": patch
---

Refuse hosted session creation with `503 environment_unavailable` naming the R2 secrets the Sandbox SDK needs (`CLOUDFLARE_R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BACKUP_BUCKET_NAME`) when a deployment sets neither them nor `LOCAL_BACKUPS`, instead of starting a container and failing the session as `environment_setup_failed` with no cause anywhere. Environment drivers may declare a `preflight`, and a setup failure now logs its cause chain with the session id.

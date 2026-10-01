# Upgrading

How to move an existing deployment to a newer release. A new project needs none of this; start with the [QuickStart](quickstart.md). What changed in each release is in the changelogs: [cf-open-agents-api](../packages/agent-api/CHANGELOG.md) and [create-cf-open-agents-api](../packages/create-cf-open-agents-api/CHANGELOG.md).

## From 0.5 to 0.6

Releases up to 0.5 ran `HarnessDO` and `SandboxDO` on the default scheduling policy through `@cloudflare/containers` and Sandbox SDK 0.x. 0.6 starts both containers itself on `scheduling_policy: "durable_object"`. The move cannot be undone: after the deploy, a rollback to a 0.5 version cannot start containers. Cloudflare's [migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/) describes the platform side.

A Durable Object class whose namespace has had a default-policy container application does not start `durable_object` containers: `start()` returns, `running` turns true, and commands and intercepts then wait without an answer. Containers of new classes did not start either while the old applications existed. So the upgrade binds the two container objects to new classes and deletes the old applications at the switch ([Cloudflare Containers: known issues](cloudflare-containers.md#upgrading-from-05-containers-never-start)).

1. Update `cf-open-agents-api` and `create-cf-open-agents-api` to the newest `alpha` (`pnpm add cf-open-agents-api@alpha` and `pnpm add -D create-cf-open-agents-api@alpha`); the install refreshes the image snapshot in `.cf-open-agents-api/`. In a project the CLI set up, run `pnpm exec create-cf-open-agents-api init` and read its notes: it replaces a class re-export in the entry module that still names `ContainerProxy`, notes a leftover `BACKUP_BUCKET_NAME`, and notes each container entry still on the default policy. It does not rewrite those entries, with or without `--force`: rewritten in place, an entry keeps a class whose containers never start. A hand-written composition adds `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway` to its `defineAgentWorker` destructuring and drops `ContainerProxy`.
2. Rehearse on a staging Worker with sessions in it. A staging deployment needs its own Worker, container application and bucket names in its configuration; `wrangler deploy --name` does not rename container applications.
3. Bind the container objects to new classes. In the entry module, export the library's classes under the new names as well (keep the old names exported; the old classes stay in the migrations):

   ```ts
   export {
     Agents,
     Models,
     SessionDO,
     TenantCatalogDO,
     HarnessDO,
     SandboxDO,
     HarnessDO as HarnessContainerDO,
     SandboxDO as SandboxContainerDO,
     ContainerEgress,
     SandboxEgress,
     DirectoryBackupGateway,
   } from "./agents.js";
   ```

   In the Wrangler configuration, point the `HARNESS` and `SANDBOX` bindings at `HarnessContainerDO` and `SandboxContainerDO`, add a migration `{ "tag": "v2", "new_sqlite_classes": ["HarnessContainerDO", "SandboxContainerDO"] }` (the next free tag), and replace the two container entries with `durable_object` entries for the new classes:

   ```jsonc
   {
     "class_name": "HarnessContainerDO",
     "name": "<worker>-harness",
     "scheduling_policy": "durable_object",
     "images": {
       "harness": {
         "dockerfile": ".cf-open-agents-api/docker/Harness.Dockerfile",
         "build_context": ".cf-open-agents-api",
       },
     },
   }
   ```

   and the same for `SandboxContainerDO` with `"name": "<worker>-sandbox"` and an image named `sandbox` (`Sandbox.Dockerfile`). Drop `instance_type` and `max_instances`; the objects choose their size when they start a container. `create-cf-open-agents-api init` and `doctor` accept these class names.

4. Delete the old container applications as part of the switch, right before or right after the deploy: `pnpm exec wrangler containers list`, then `pnpm exec wrangler containers delete <id>` for `<worker>-harnessdo` and `<worker>-sandboxdo`. While they existed, the new classes' containers did not start either; sessions waiting on them continued as soon as the old applications were deleted. Turns in flight at the switch fail, and uncommitted workspace state in the old containers is lost.
5. Deploy the new version to 100%; a deployment that mixes versions cannot use gradual deployments. The first deploy of an image waits while Cloudflare prepares it, and on the deployment this guide comes from the sandbox image took 10 to 50 minutes; Wrangler gives up after 15 minutes with `Timed out while preparing the container image on Cloudflare's network.` while the preparation continues. Deploy again later; once an image digest is prepared, a deploy with it is quick.
6. Verify with a new session, and continue an old one: the old classes' storage is not carried over, but the container objects keep no state a session needs. Committed checkpoints restore, a workspace backup that Sandbox SDK 0.x wrote is converted on its first restore, and the next checkpoint stores the 1.0 form.
7. Afterwards, delete the secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CLOUDFLARE_R2_ACCOUNT_ID` (`pnpm exec wrangler secret delete <name>`), remove `vars.BACKUP_BUCKET_NAME` from the Wrangler configuration and `LOCAL_BACKUPS` from `.dev.vars`; nothing reads them.

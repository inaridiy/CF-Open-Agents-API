# Cloudflare Containers: known issues

Each session runs two containers on Cloudflare Containers: one for the agent runtime and one for its workspace. The library starts them through Cloudflare's Durable Object container API (`ctx.container`, the `durable_object` scheduling policy), which Cloudflare released at the end of September 2026. This page records what we have seen that platform do on real deployments, what the library does about it, and what you can do. The entries were observed on 2026-10-01 with Wrangler `4.145.0` and reported to Cloudflare in their Discord the same day; this page changes when the platform does.

## The first deploy can time out while Cloudflare prepares an image

**What you see.** The first `wrangler deploy` of a project, or the first after an image changed, stops after 15 minutes with `Timed out while preparing the container image on Cloudflare's network.`

**What happens.** After pushing an image, Wrangler asks Cloudflare to prepare it and waits up to 15 minutes. The runtime image was ready in under a minute; the workspace image took between 10 and 50 minutes, and one first request failed with HTTP 500. The preparation carries on after Wrangler gives up. Nothing was deployed, and the previous version keeps serving.

**What to do.** Run `pnpm exec wrangler deploy` again in 30 to 60 minutes. Once an image is prepared, a deploy that uses it does not wait.

## Some new sessions fail to start their containers

**What you see.** Creating a session fails with `environment_setup_failed` (the demo shows it on the job page), or a turn stays `in_progress` without output. `pnpm exec wrangler tail` shows `Container boot failed` with the exception `The container connection is temporarily unavailable, try again shortly`.

**What happens.** Now and then a newly started container does not answer its first command; the call fails after about 47 seconds, or does not return at all. The failure stays with that session's containers: one kept failing on every restart for over ten minutes, while new sessions started normally within seconds. It hit two of five new sessions in our small sample, and none of about a dozen containers we started directly.

**What the library does.** A container that is not ready within 3 minutes fails its start, is destroyed, and the next attempt starts a new one. For the workspace container that fails the request, which is `environment_setup_failed` when a session is created; the runtime container is retried until the turn's deadline (`maxTurnMs`, 15 minutes by default). A workspace container that replaced an earlier one starts the agent's tool server again, so a turn does not continue without a shell. (Runtime start deadline and server restore: 0.6.2.)

**What to do.** Create a new session (in the demo, submit the job again). If it keeps happening on your account, open an issue with the times and session ids.

## Upgrading from 0.5: containers never start

**Only deployments upgraded from 0.5 or earlier.** A new project is not affected.

**What you see.** After the upgrade, no container starts: `start()` returns and `running` turns true, then every command waits without an answer. `pnpm exec wrangler containers info <id>` shows the application with `active: 0, starting: 0`.

**What happens.** A Durable Object class whose namespace has had a container application on the default scheduling policy does not start `durable_object` containers. Cloudflare's [migration guide](https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/) says that the old and new applications cannot share a namespace, but the deploy succeeds and nothing reports an error. While the old applications existed, containers of new classes did not start either; they started as soon as the old applications were deleted.

**What to do.** Follow [Upgrading](upgrading.md#from-05-to-06): bind the container objects to new classes, and delete the old applications at the switch, right before or right after the deploy.

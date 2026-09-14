# Implementation and validation

The [architecture](architecture.md) describes the implemented service boundaries;
[compatibility](compatibility.md) defines the public alpha contract. Source and
published packages are built from tagged commits. Test results for each revision
are available in [GitHub Actions](https://github.com/inaridiy/CF-Open-Agents-API/actions).

## Validation boundaries

| Command                | Evidence                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm check`           | Documentation, agent guidance, checker fixtures, types, lint, real workerd/SQLite tests and builds      |
| `pnpm test:codex`      | Real Codex app-server/exec-server, external functions and history recovery                              |
| `pnpm test:harnesses`  | Three native runtimes, SDK model protocols, tools, cancellation and restored history                    |
| `pnpm test:containers` | Worker/Container transport, separate Sandbox execution, skills and R2 restore after compute destruction |
| `pnpm types`           | Generated Worker binding/runtime declarations                                                           |
| `pnpm deploy:check`    | Both images and the Worker deployment bundle, without deployment                                        |
| `pnpm test:package`    | Packed library installation, public entrypoint imports and consumer type compatibility                  |

Runtime suites use local scripted model endpoints. They establish integration and
recovery behavior; they do not measure model quality or establish every upstream
provider's compatibility. A successful build alone does not establish Container
callback routing or persistence recovery.

## Implementation constraints

Kysely compiles queries for synchronous SQLite transactions. Container outbound
handlers use the SDK's static registration setter. WebSocket upgrades cross the
native fetch boundary. R2 uploads use bounded snapshots with a known body length.
Native homes are captured only after process shutdown and restored at stable paths.

Claude SDK MCP integration uses the installed MCP server to avoid mixing incompatible
Zod parsers. OpenCode uses bundled plugins and a read-only runtime config to keep
startup offline. Package caches and logs are excluded from native checkpoints.

See [contributing](../CONTRIBUTING.md#validation) for required checks,
[deployment prerequisites](deployment.md#local-runtime-notes) for Container tests,
and [known issues](known-issues.md) for narrowly scoped upstream diagnostics.

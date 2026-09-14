# Effect house rules

The project uses `effect@3.22.2`. HTTP handlers, Workers RPC methods, Durable Object alarms, SDK callbacks and the supervisor's process entrypoint keep their platform signatures; everything behind them composes Effect programs. These five rules apply to every change:

1. **No `Effect.run*` below an entrypoint.** `runPromise` and `runSync` are boundary runners. They belong in a route handler, an RPC method, an alarm, a Container RPC method or `main.ts`, never inside a helper another Effect could call.
2. **No `yield*` inside a `transaction` callback.** SQLite transactions run synchronously through `transactionSync`. The callback type rejects Promises and Effects; compile Kysely queries and execute them inside, and do network I/O outside.
3. **Every `io` callback takes the signal, and non-idempotent writes are `uninterruptible`.** `io(name, (signal) => promise)` supplies an interruption signal to APIs that accept one. A write whose outcome must be recorded even when the fiber is interrupted is wrapped in `Effect.uninterruptible`. There is no blanket retry of external writes; an unknown outcome stays explicit.
4. **Every fiber has an owner scope.** Forked work uses `Effect.forkIn(scope)` or `forkScoped`, and the scope closes with the job, request or object that started it. Finalizers release MCP servers, model body readers, child processes and workspace handles, including on setup failure.
5. **Errors are tagged or die.** Expected failures are `ApiError` or `OperationError` (both tagged and yieldable) in the error channel. Anything else is a defect. Boundary runners unwrap the exit so the API's error name, status and code survive Workers RPC instead of a `FiberFailure` wrapper.

## Where things stand

The Worker and the supervisor are being migrated to this shape in a later pass: honest interruption end to end, tagged errors everywhere, a typed RPC envelope, a repository seam in front of `SqlStore`, Scope-owned supervisor jobs and a subscribable event log with a long-poll variant of `GET /jobs/:turn`. Until that lands, the rules above describe what new code must do and the direction existing code is moving, not a finished state. The current contracts are the ones in `packages/agent-api/src/runtime.ts`, `effect.ts` and `environments.ts`; [library-api.md](library-api.md#effect-extension-contracts) summarizes them for driver authors.

## Reading the pinned release

The pinned Effect release ships no `AGENTS.md`. Read `node_modules/effect/src` for signatures and the Effect v3 documentation for semantics before writing Effect code. Preserve the pin.

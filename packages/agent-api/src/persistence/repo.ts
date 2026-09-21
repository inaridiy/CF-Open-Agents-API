import { Effect } from "effect";

import { StorageFailure } from "../errors.js";
import type { Sync, Transactional } from "./record-store.js";

export type { Sync } from "./record-store.js";

/**
 * The outside edge of the persistence seam, for one typed view `Tx` of a store.
 * `transaction` runs `f` in one store transaction: a throw rolls it back and
 * then becomes the failure channel, classified by `expected` into the typed error `E` or a
 * `StorageFailure` (an unknown outcome, never a definite answer). `read` runs `f` against
 * the same view without a transaction. Both are lazy: constructing the effect runs
 * nothing, and the callback runs on the fiber's current tick.
 */
export interface Repo<Tx, E> {
  readonly transaction: <A>(f: (tx: Tx) => Sync<A>) => Effect.Effect<A, E | StorageFailure>;
  readonly read: <A>(f: (tx: Tx) => Sync<A>) => Effect.Effect<A, E | StorageFailure>;
}

export const makeRepo = <Tx, E>(
  tx: Tx,
  transactional: Transactional,
  expected: (thrown: unknown) => thrown is E,
  name: string,
): Repo<Tx, E> => {
  const attempt = <A>(operation: string, run: () => A) =>
    Effect.suspend((): Effect.Effect<A, E | StorageFailure> => {
      try {
        return Effect.succeed(run());
      } catch (thrown) {
        return Effect.fail(
          expected(thrown) ? thrown : new StorageFailure({ operation, cause: thrown }),
        );
      }
    });
  return {
    transaction: (f) =>
      attempt(`${name}.transaction`, () => transactional.transaction(() => f(tx))),
    read: (f) => attempt(`${name}.read`, () => f(tx)),
  };
};

/**
 * A record kind whose value type follows the kind, at zero runtime cost: the phantom
 * `__value` member never exists on the string, it only carries `A` for inference. A plain
 * string is not a `Kind`, so every read and write names a declared kind.
 */
export type Kind<A> = string & { readonly __value: (_: never) => A };
export const kind = <A>(name: string): Kind<A> => name as Kind<A>;

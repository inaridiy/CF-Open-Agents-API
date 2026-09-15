import { ContainerUnassigned, RecordTooLarge } from "../errors.js";
import type { Checkpoint } from "../runtime.js";
import {
  type ArtifactManifest,
  type Assignment,
  type ChildRecord,
  HarnessKinds,
  type SandboxState,
} from "./harness-kinds.js";
import type { RecordStore, Transactional } from "./record-store.js";
import { makeRepo, type Repo } from "./repo.js";

/**
 * Typed, synchronous view of one HarnessDO's rows. Every method is plain and total: it
 * either returns or throws a tagged domain error, and a throw inside a transaction is the
 * rollback. Nothing here suspends, so a callback over it can run in `transactionSync`.
 */
export interface HarnessTx {
  /** Escape hatch for kinds without a dedicated accessor. */
  readonly store: RecordStore;
  assignment(): Assignment | undefined;
  /** Throws `ContainerUnassigned` before any session was assigned. */
  requireAssignment(): Assignment;
  putAssignment(assignment: Assignment): void;
  sandbox(): SandboxState | undefined;
  rememberSandbox(state: SandboxState): void;
  forgetSandbox(): void;
  child(subagentId: string): ChildRecord | undefined;
  putChild(subagentId: string, record: ChildRecord): void;
  checkpoint(generation: number): Checkpoint | undefined;
  putCheckpoint(generation: number, checkpoint: Checkpoint): void;
  artifacts(generation: number): ArtifactManifest | undefined;
  putArtifacts(generation: number, manifest: ArtifactManifest): void;
}
const CURRENT = "current";
export const makeHarnessTx = (store: RecordStore): HarnessTx => ({
  store,
  assignment: () => store.get(HarnessKinds.assignment, CURRENT),
  requireAssignment: () => {
    const assignment = store.get(HarnessKinds.assignment, CURRENT);
    if (!assignment) throw new ContainerUnassigned();
    return assignment;
  },
  putAssignment: (assignment) => store.put(HarnessKinds.assignment, CURRENT, assignment),
  sandbox: () => store.get(HarnessKinds.sandbox, CURRENT),
  rememberSandbox: (state) => store.put(HarnessKinds.sandbox, CURRENT, state),
  forgetSandbox: () => store.remove(HarnessKinds.sandbox, CURRENT),
  child: (subagentId) => store.get(HarnessKinds.child, subagentId),
  putChild: (subagentId, record) => store.put(HarnessKinds.child, subagentId, record),
  checkpoint: (generation) => store.get(HarnessKinds.checkpoint, String(generation)),
  putCheckpoint: (generation, checkpoint) =>
    store.put(HarnessKinds.checkpoint, String(generation), checkpoint),
  artifacts: (generation) => store.get(HarnessKinds.artifacts, String(generation)),
  putArtifacts: (generation, manifest) =>
    store.put(HarnessKinds.artifacts, String(generation), manifest),
});

/** Everything a harness transaction may throw on purpose; the rest is a `StorageFailure`. */
export type HarnessTxError = RecordTooLarge | ContainerUnassigned;
export const isHarnessTxError = (value: unknown): value is HarnessTxError =>
  value instanceof RecordTooLarge || value instanceof ContainerUnassigned;
/** The outside edge of the seam for a HarnessDO: see `Repo`. */
export type HarnessRepository = Repo<HarnessTx, HarnessTxError>;
export const makeHarnessRepo = (
  store: RecordStore,
  transactional: Transactional,
): HarnessRepository => makeRepo(makeHarnessTx(store), transactional, isHarnessTxError, "harness");

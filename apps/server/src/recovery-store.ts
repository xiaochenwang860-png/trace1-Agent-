import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type {
  GitRecoveryCheckpoint,
  GitRecoveryRepository,
  GitRecoverySnapshot,
} from "./git-recovery-repository.js";

const SNAPSHOT_VERSION = 1 as const;
const DEFAULT_POLICY_ID = "complete-workspace-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface RecoveryStoreLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCaptureAttempts?: number;
}

export type RecoveryGitRepository = Pick<
  GitRecoveryRepository,
  "probe" | "capture" | "load" | "writeBlob" | "readBlob" | "resolveRef"
>;

export interface RecoverySnapshotEntry {
  path: string;
  kind: "file" | "directory";
  mode: number;
  size?: number;
  blobHash?: string;
  gitBlobOid?: string;
}

export interface RecoverySnapshot {
  version: typeof SNAPSHOT_VERSION;
  policyId: string;
  rootHash: string;
  entries: RecoverySnapshotEntry[];
  fileCount: number;
  totalBytes: number;
  storage?: "git-sha256-v1";
  repositoryId?: string;
  commitOid?: string | null;
  workspaceTreeOid?: string;
  manifestBlobOid?: string;
  controlTreeOid?: string;
}

export interface WorkspaceRecoveryLocation {
  repositoryId: string;
  workspacePath: string;
}

export interface RecoveryCaptureOptions {
  refName?: string;
}

export interface RecoverySnapshotLocator {
  repositoryId: string;
  commitOid: string;
  rootHash: string;
  workspaceTreeOid: string;
  manifestBlobOid: string;
}

export interface RestoreRequest {
  workspacePath: string;
  repositoryId?: string;
  snapshot: RecoverySnapshot;
  expectedCurrentRootHash: string;
  operationId?: string;
  paths?: string[];
}

export interface RecoverySnapshotChange {
  path: string;
  kind: "created" | "modified" | "deleted" | "type-changed";
  before: RecoverySnapshotEntry | null;
  after: RecoverySnapshotEntry | null;
}

export interface RestorePreview {
  mode: "full" | "selective";
  requestedPaths: string[];
  currentRootHash: string;
  targetRootHash: string;
  resultingRootHash: string;
  changes: RecoverySnapshotChange[];
}

export interface RestoreResult extends RestorePreview {
  operationId: string;
  previousRootHash: string;
  restoredRootHash: string;
  safetySnapshotId: string;
  quarantinePath: string;
  restoredPaths: string[];
  restoredEntryCount: number;
}

export interface RecoveryStoreHooks {
  afterScanPass?: ((event: {
    workspacePath: string;
    attempt: number;
    rootHash: string;
  }) => void | Promise<void>) | undefined;
  afterRestorePreflight?: ((event: {
    workspacePath: string;
    operationId: string;
  }) => void | Promise<void>) | undefined;
  afterWorkspaceQuarantined?: ((event: {
    workspacePath: string;
    quarantinePath: string;
    operationId: string;
  }) => void | Promise<void>) | undefined;
  afterWorkspacePublished?: ((event: {
    workspacePath: string;
    quarantinePath: string;
    operationId: string;
  }) => void | Promise<void>) | undefined;
}

export interface RecoveryStoreOptions extends RecoveryStoreLimits {
  policyId?: string;
  hooks?: RecoveryStoreHooks;
  gitRepository?: RecoveryGitRepository;
  /** Enables the filesystem-backed Git test double; never set by production. */
  allowTestFileBackend?: boolean;
}

export type RecoveryErrorCode =
  | "RECOVERY_INTEGRITY_ERROR"
  | "RECOVERY_LIMIT_EXCEEDED"
  | "RECOVERY_OPERATION_CONFLICT"
  | "RECOVERY_UNSUPPORTED_ENTRY"
  | "WORKSPACE_CHANGED"
  | "WORKSPACE_UNSTABLE";

export class RecoveryStoreError extends Error {
  constructor(
    public readonly code: RecoveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecoveryStoreError";
  }
}

export class WorkspaceChangedError extends RecoveryStoreError {
  constructor(
    public readonly expectedRootHash: string,
    public readonly actualRootHash: string,
  ) {
    super(
      "WORKSPACE_CHANGED",
      "Workspace changed after the recovery point was inspected",
    );
    this.name = "WorkspaceChangedError";
  }
}

export class WorkspaceUnstableError extends RecoveryStoreError {
  constructor(workspacePath: string, attempts: number, options?: ErrorOptions) {
    super(
      "WORKSPACE_UNSTABLE",
      `Workspace did not remain stable across ${attempts} capture attempts: ${workspacePath}`,
      options,
    );
    this.name = "WorkspaceUnstableError";
  }
}

export class RecoveryIntegrityError extends RecoveryStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("RECOVERY_INTEGRITY_ERROR", message, options);
    this.name = "RecoveryIntegrityError";
  }
}

export class RecoveryLimitError extends RecoveryStoreError {
  constructor(message: string) {
    super("RECOVERY_LIMIT_EXCEEDED", message);
    this.name = "RecoveryLimitError";
  }
}

export class RecoveryOperationConflictError extends RecoveryStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("RECOVERY_OPERATION_CONFLICT", message, options);
    this.name = "RecoveryOperationConflictError";
  }
}

class ScanChangedError extends Error {}

interface ResolvedLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxCaptureAttempts: number;
}

type RestoreJournalState =
  | "PREPARED"
  | "QUARANTINED"
  | "PUBLISHED"
  | "COMMITTED"
  | "ROLLED_BACK";

interface RestoreJournal {
  version: 1;
  state: RestoreJournalState;
  operationId: string;
  workspacePath: string;
  stagingPath: string;
  quarantinePath: string;
  expectedRootHash: string;
  resultingRootHash: string;
  updatedAt: string;
}

const defaultLimits: ResolvedLimits = {
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCaptureAttempts: 3,
};

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function normalizeMode(file: BigIntStats): number {
  if (process.platform === "win32") {
    return file.isDirectory() ? 0o755 : 0o644;
  }
  return Number(file.mode & 0o777n);
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new RecoveryIntegrityError(`Unsafe snapshot path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new RecoveryIntegrityError(`Unsafe snapshot path: ${JSON.stringify(relativePath)}`);
  }
}

function resolveSnapshotPath(root: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!isPathInside(root, resolved)) {
    throw new RecoveryIntegrityError(`Snapshot path escapes its workspace: ${relativePath}`);
  }
  return resolved;
}

function calculateRootHash(
  policyId: string,
  entries: readonly RecoverySnapshotEntry[],
): string {
  const hash = createHash("sha256");
  hash.update("workspace-recovery\0");
  hash.update(String(SNAPSHOT_VERSION));
  hash.update("\0");
  hash.update(policyId);
  hash.update("\0");
  for (const entry of entries) {
    hash.update(entry.kind === "directory" ? "D\0" : "F\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.blobHash ?? "");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashGitBlob(value: Uint8Array): string {
  const bytes = Buffer.from(value);
  return createHash("sha256")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validateOperationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new RecoveryIntegrityError("Recovery operation ID contains unsafe characters");
  }
  return value;
}

function normalizeSelectionPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const selectedPath of paths) {
    assertSafeRelativePath(selectedPath);
    if (path.posix.normalize(selectedPath) !== selectedPath) {
      throw new RecoveryIntegrityError(
        `Recovery selection path is not normalized: ${selectedPath}`,
      );
    }
    normalized.add(selectedPath);
  }
  const ordered = [...normalized].sort(comparePaths);
  return ordered.filter(
    (candidate, index) =>
      !ordered.some(
        (parent, parentIndex) =>
          parentIndex !== index && candidate.startsWith(`${parent}/`),
      ),
  );
}

function isSelected(relativePath: string, paths: readonly string[]): boolean {
  return paths.some(
    (selectedPath) =>
      relativePath === selectedPath || relativePath.startsWith(`${selectedPath}/`),
  );
}

function sameEntry(
  before: RecoverySnapshotEntry,
  after: RecoverySnapshotEntry,
): boolean {
  return (
    before.kind === after.kind &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.blobHash === after.blobHash
  );
}

export function diffSnapshots(
  before: RecoverySnapshot,
  after: RecoverySnapshot,
  paths?: string[],
): RecoverySnapshotChange[] {
  const selectedPaths = paths === undefined ? null : normalizeSelectionPaths(paths);
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const allPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const changes: RecoverySnapshotChange[] = [];
  for (const relativePath of [...allPaths].sort(comparePaths)) {
    if (selectedPaths && !isSelected(relativePath, selectedPaths)) continue;
    const previous = beforeByPath.get(relativePath) ?? null;
    const current = afterByPath.get(relativePath) ?? null;
    if (!previous && current) {
      changes.push({ path: relativePath, kind: "created", before: null, after: current });
    } else if (previous && !current) {
      changes.push({ path: relativePath, kind: "deleted", before: previous, after: null });
    } else if (previous && current && !sameEntry(previous, current)) {
      changes.push({
        path: relativePath,
        kind: previous.kind === current.kind ? "modified" : "type-changed",
        before: previous,
        after: current,
      });
    }
  }
  return changes;
}

export class RecoveryStore {
  private readonly limits: ResolvedLimits;
  private readonly policyId: string;
  private readonly hooks: RecoveryStoreHooks;
  private readonly gitRepository: RecoveryGitRepository | null;
  private readonly allowTestFileBackend: boolean;
  private readonly workspaceLocks = new Map<string, Promise<void>>();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly recoveryRoot: string,
    options: RecoveryStoreOptions = {},
  ) {
    this.policyId = options.policyId ?? DEFAULT_POLICY_ID;
    if (this.policyId.length === 0 || this.policyId.includes("\0")) {
      throw new TypeError("policyId must be a non-empty string without NUL bytes");
    }
    this.limits = {
      maxFiles: validatePositiveInteger(options.maxFiles ?? defaultLimits.maxFiles, "maxFiles"),
      maxFileBytes: validatePositiveInteger(
        options.maxFileBytes ?? defaultLimits.maxFileBytes,
        "maxFileBytes",
      ),
      maxTotalBytes: validatePositiveInteger(
        options.maxTotalBytes ?? defaultLimits.maxTotalBytes,
        "maxTotalBytes",
      ),
      maxCaptureAttempts: validatePositiveInteger(
        options.maxCaptureAttempts ?? defaultLimits.maxCaptureAttempts,
        "maxCaptureAttempts",
      ),
    };
    this.hooks = options.hooks ?? {};
    this.gitRepository = options.gitRepository ?? null;
    this.allowTestFileBackend = options.allowTestFileBackend ?? false;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const directories = [
          mkdir(this.operationRoot(), { recursive: true, mode: 0o700 }),
        ];
        if (!this.gitRepository) {
          directories.push(
            mkdir(this.objectRoot(), { recursive: true, mode: 0o700 }),
            mkdir(this.manifestRoot(), { recursive: true, mode: 0o700 }),
          );
        }
        await Promise.all(directories);
        await this.gitRepository?.probe();
        await this.reconcileOperations();
      })();
    }
    return this.initialization;
  }

  async capture(
    location: string | WorkspaceRecoveryLocation,
    options: RecoveryCaptureOptions = {},
  ): Promise<RecoverySnapshot> {
    const { workspacePath, repositoryId } = this.resolveLocation(location);
    return this.withWorkspaceLock(workspacePath, async () => {
      await this.initialize();
      await this.assertWorkspaceBoundary(workspacePath);
      const snapshot = await this.captureStable(
        workspacePath,
        true,
        repositoryId,
      );
      if (repositoryId && this.gitRepository) {
        if (!options.refName) {
          throw new RecoveryIntegrityError(
            "Git recovery captures require a durable checkpoint ref",
          );
        }
        const checkpoint = await this.gitRepository.capture(
          repositoryId,
          this.toGitSnapshot(snapshot),
          options.refName,
        );
        return this.withGitCheckpoint(snapshot, checkpoint);
      }
      await this.putManifest(snapshot);
      return repositoryId
        ? this.withTestCheckpoint(snapshot, repositoryId)
        : snapshot;
    });
  }

  async inspect(
    location: string | WorkspaceRecoveryLocation,
  ): Promise<RecoverySnapshot> {
    const { workspacePath, repositoryId } = this.resolveLocation(location);
    return this.withWorkspaceLock(workspacePath, async () => {
      await this.initialize();
      await this.assertWorkspaceBoundary(workspacePath);
      const snapshot = await this.captureStable(
        workspacePath,
        repositoryId !== null,
        repositoryId,
      );
      return repositoryId
        ? {
            ...snapshot,
            storage: "git-sha256-v1",
            repositoryId,
            commitOid: null,
          }
        : snapshot;
    });
  }

  async loadSnapshot(
    locator: string | RecoverySnapshotLocator,
  ): Promise<RecoverySnapshot> {
    await this.initialize();
    const rootHash = typeof locator === "string" ? locator : locator.rootHash;
    if (!SHA256_PATTERN.test(rootHash)) {
      throw new RecoveryIntegrityError("Snapshot root hash is invalid");
    }
    if (typeof locator !== "string" && this.gitRepository) {
      let loaded;
      try {
        loaded = await this.gitRepository.load(
          locator.repositoryId,
          locator.commitOid,
        );
      } catch (error) {
        throw new RecoveryIntegrityError(
          `Unable to load Git recovery checkpoint ${locator.commitOid}`,
          { cause: error },
        );
      }
      if (
        loaded.rootHash !== locator.rootHash ||
        loaded.workspaceTreeOid !== locator.workspaceTreeOid ||
        loaded.manifestBlobOid !== locator.manifestBlobOid
      ) {
        throw new RecoveryIntegrityError(
          "Git recovery checkpoint locator does not match its stored objects",
        );
      }
      return this.validateSnapshot({
        ...loaded.snapshot,
        storage: "git-sha256-v1",
        repositoryId: loaded.repositoryId,
        commitOid: loaded.commitOid,
        controlTreeOid: loaded.controlTreeOid,
        workspaceTreeOid: loaded.workspaceTreeOid,
        manifestBlobOid: loaded.manifestBlobOid,
      });
    }
    if (typeof locator !== "string" && !this.allowTestFileBackend) {
      throw new RecoveryIntegrityError(
        "Git recovery repository is not configured",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.manifestPath(rootHash), "utf8"));
    } catch (error) {
      throw new RecoveryIntegrityError(`Unable to load recovery snapshot ${rootHash}`, {
        cause: error,
      });
    }
    const snapshot = this.validateSnapshot(parsed);
    return typeof locator === "string"
      ? snapshot
      : {
          ...snapshot,
          storage: "git-sha256-v1",
          repositoryId: locator.repositoryId,
          commitOid: locator.commitOid,
          controlTreeOid: locator.rootHash,
          workspaceTreeOid: locator.workspaceTreeOid,
          manifestBlobOid: locator.manifestBlobOid,
        };
  }

  load(locator: string | RecoverySnapshotLocator): Promise<RecoverySnapshot> {
    return this.loadSnapshot(locator);
  }

  async resolveSafetySnapshotId(
    repositoryId: string,
    operationId: string,
    expectedRootHash: string,
  ): Promise<string | null> {
    validateOperationId(operationId);
    if (!SHA256_PATTERN.test(expectedRootHash)) {
      throw new RecoveryIntegrityError("Expected safety snapshot hash is invalid");
    }
    await this.initialize();
    if (!this.gitRepository) return null;
    const commitOid = await this.gitRepository.resolveRef(
      repositoryId,
      `refs/launchpad/safety/${operationId}`,
    );
    const checkpoint = await this.gitRepository.load(repositoryId, commitOid);
    if (checkpoint.rootHash !== expectedRootHash) {
      throw new RecoveryIntegrityError(
        "Recovery safety ref does not match the pre-restore workspace",
      );
    }
    return commitOid;
  }

  async previewRestore(
    request: Omit<RestoreRequest, "operationId">,
  ): Promise<RestorePreview> {
    return this.withWorkspaceLock(request.workspacePath, async () => {
      await this.initialize();
      await this.assertWorkspaceBoundary(request.workspacePath);
      const repositoryId = request.repositoryId ?? null;
      if (!SHA256_PATTERN.test(request.expectedCurrentRootHash)) {
        throw new RecoveryIntegrityError("Expected workspace root hash is invalid");
      }
      const target = this.validateSnapshot(request.snapshot);
      this.assertSnapshotRepository(target, repositoryId);
      const requestedPaths = this.resolveRequestedPaths(request.paths);
      await this.verifySnapshotBlobs(target, requestedPaths, repositoryId);
      const current = await this.captureStable(
        request.workspacePath,
        false,
        repositoryId,
      );
      if (current.rootHash !== request.expectedCurrentRootHash) {
        throw new WorkspaceChangedError(
          request.expectedCurrentRootHash,
          current.rootHash,
        );
      }
      const resulting = this.createRestoreTarget(current, target, requestedPaths);
      return this.createRestorePreview(current, target, resulting, requestedPaths);
    });
  }

  async restore(request: RestoreRequest): Promise<RestoreResult> {
    return this.withWorkspaceLock(request.workspacePath, async () => {
      await this.initialize();
      await this.assertWorkspaceBoundary(request.workspacePath);
      const repositoryId = request.repositoryId ?? null;
      if (!SHA256_PATTERN.test(request.expectedCurrentRootHash)) {
        throw new RecoveryIntegrityError("Expected workspace root hash is invalid");
      }
      const snapshot = this.validateSnapshot(request.snapshot);
      this.assertSnapshotRepository(snapshot, repositoryId);
      const requestedPaths = this.resolveRequestedPaths(request.paths);
      const operationId = validateOperationId(request.operationId ?? randomUUID());
      const workspacePath = path.resolve(request.workspacePath);
      const parent = path.dirname(workspacePath);
      const base = path.basename(workspacePath);
      const stagingPath = path.join(parent, `.${base}.restore-${operationId}.staging`);
      const quarantinePath = path.join(parent, `.${base}.restore-${operationId}.quarantine`);
      await this.assertOperationPathsAvailable(stagingPath, quarantinePath);

      let quarantined = false;
      let published = false;
      let safetySnapshotId = "";
      let journal: RestoreJournal | null = null;
      try {
        let current = await this.captureStable(
          workspacePath,
          true,
          repositoryId,
        );
        if (current.rootHash !== request.expectedCurrentRootHash) {
          throw new WorkspaceChangedError(
            request.expectedCurrentRootHash,
            current.rootHash,
          );
        }
        if (repositoryId && this.gitRepository) {
          const safety = await this.gitRepository.capture(
            repositoryId,
            this.toGitSnapshot(current),
            `refs/launchpad/safety/${operationId}`,
          );
          current = this.withGitCheckpoint(current, safety);
          safetySnapshotId = safety.commitOid;
        } else {
          await this.putManifest(current);
          safetySnapshotId = current.rootHash;
        }
        const resulting = this.createRestoreTarget(current, snapshot, requestedPaths);
        const preview = this.createRestorePreview(
          current,
          snapshot,
          resulting,
          requestedPaths,
        );

        await this.hydrate(stagingPath, resulting, repositoryId);
        const staged = await this.captureStable(
          stagingPath,
          false,
          repositoryId,
        );
        if (staged.rootHash !== resulting.rootHash) {
          throw new RecoveryIntegrityError(
            `Hydrated workspace hash ${staged.rootHash} does not match target ${resulting.rootHash}`,
          );
        }

        const currentBeforeSwap = await this.captureStable(
          workspacePath,
          false,
          repositoryId,
        );
        if (currentBeforeSwap.rootHash !== request.expectedCurrentRootHash) {
          throw new WorkspaceChangedError(
            request.expectedCurrentRootHash,
            currentBeforeSwap.rootHash,
          );
        }
        await this.hooks.afterRestorePreflight?.({ workspacePath, operationId });

        journal = {
          version: 1,
          state: "PREPARED",
          operationId,
          workspacePath,
          stagingPath,
          quarantinePath,
          expectedRootHash: current.rootHash,
          resultingRootHash: resulting.rootHash,
          updatedAt: new Date().toISOString(),
        };
        await this.writeJournal(journal);

        await rename(workspacePath, quarantinePath);
        quarantined = true;
        journal = await this.advanceJournal(journal, "QUARANTINED");
        await this.hooks.afterWorkspaceQuarantined?.({
          workspacePath,
          quarantinePath,
          operationId,
        });

        const quarantinedState = await this.captureStable(
          quarantinePath,
          false,
          repositoryId,
        );
        if (quarantinedState.rootHash !== request.expectedCurrentRootHash) {
          await rename(quarantinePath, workspacePath);
          quarantined = false;
          journal = await this.advanceJournal(journal, "ROLLED_BACK");
          throw new WorkspaceChangedError(
            request.expectedCurrentRootHash,
            quarantinedState.rootHash,
          );
        }

        await rename(stagingPath, workspacePath);
        published = true;
        journal = await this.advanceJournal(journal, "PUBLISHED");
        await this.hooks.afterWorkspacePublished?.({
          workspacePath,
          quarantinePath,
          operationId,
        });
        const restored = await this.captureStable(
          workspacePath,
          false,
          repositoryId,
        );
        if (restored.rootHash !== resulting.rootHash) {
          throw new RecoveryIntegrityError(
            `Restored workspace hash ${restored.rootHash} does not match target ${resulting.rootHash}`,
          );
        }
        if (repositoryId && this.gitRepository) {
          await this.gitRepository.capture(
            repositoryId,
            this.toGitSnapshot(restored),
            `refs/launchpad/restores/${operationId}/result`,
          );
        }
        journal = await this.advanceJournal(journal, "COMMITTED");
        return {
          ...preview,
          operationId,
          previousRootHash: current.rootHash,
          restoredRootHash: restored.rootHash,
          safetySnapshotId,
          quarantinePath,
          restoredPaths: preview.changes.map((change) => change.path),
          restoredEntryCount: preview.changes.length,
        };
      } catch (error) {
        if (journal && (quarantined || published)) {
          try {
            await this.rollbackRestore(journal);
            quarantined = false;
            published = false;
          } catch {
            // The durable journal and quarantine are left for startup reconciliation.
          }
        } else if (journal && journal.state !== "ROLLED_BACK") {
          await this.advanceJournal(journal, "ROLLED_BACK").catch(() => undefined);
        }
        throw error;
      } finally {
        if (!published) {
          await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    });
  }

  private resolveRequestedPaths(paths: string[] | undefined): string[] | null {
    if (paths === undefined) return null;
    const normalized = normalizeSelectionPaths(paths);
    if (normalized.length === 0) {
      throw new RecoveryIntegrityError(
        "Selective recovery requires at least one path; omit paths for a full restore",
      );
    }
    return normalized;
  }

  private createRestoreTarget(
    current: RecoverySnapshot,
    target: RecoverySnapshot,
    requestedPaths: readonly string[] | null,
  ): RecoverySnapshot {
    if (!requestedPaths) return target;
    const merged = new Map(current.entries.map((entry) => [entry.path, entry]));
    for (const relativePath of [...merged.keys()]) {
      if (isSelected(relativePath, requestedPaths)) merged.delete(relativePath);
    }
    for (const entry of target.entries) {
      if (isSelected(entry.path, requestedPaths)) merged.set(entry.path, entry);
    }

    // A selected descendant cannot be hydrated without its directory ancestry.
    // Add only missing target ancestors; an existing file ancestor is a conflict
    // that requires the caller to select that ancestor explicitly.
    for (const entry of [...merged.values()]) {
      if (!isSelected(entry.path, requestedPaths)) continue;
      let parent = path.posix.dirname(entry.path);
      while (parent !== ".") {
        const currentParent = merged.get(parent);
        if (currentParent?.kind === "file") {
          throw new RecoveryIntegrityError(
            `Selective recovery requires replacing file ancestor ${parent}; select that ancestor instead`,
          );
        }
        if (!currentParent) {
          const targetParent = target.entries.find(
            (candidate) => candidate.path === parent,
          );
          if (targetParent?.kind !== "directory") {
            throw new RecoveryIntegrityError(
              `Selective recovery cannot reconstruct parent directory ${parent}`,
            );
          }
          merged.set(parent, targetParent);
        }
        parent = path.posix.dirname(parent);
      }
    }
    const entries = [...merged.values()].sort((left, right) =>
      comparePaths(left.path, right.path),
    );
    let fileCount = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      fileCount += 1;
      totalBytes += entry.size as number;
    }
    return this.validateSnapshot({
      version: SNAPSHOT_VERSION,
      policyId: this.policyId,
      rootHash: calculateRootHash(this.policyId, entries),
      entries,
      fileCount,
      totalBytes,
      ...(current.storage === "git-sha256-v1"
        ? {
            storage: "git-sha256-v1" as const,
            repositoryId: current.repositoryId,
            commitOid: null,
          }
        : {}),
    });
  }

  private createRestorePreview(
    current: RecoverySnapshot,
    target: RecoverySnapshot,
    resulting: RecoverySnapshot,
    requestedPaths: readonly string[] | null,
  ): RestorePreview {
    return {
      mode: requestedPaths ? "selective" : "full",
      requestedPaths: requestedPaths ? [...requestedPaths] : [],
      currentRootHash: current.rootHash,
      targetRootHash: target.rootHash,
      resultingRootHash: resulting.rootHash,
      changes: diffSnapshots(current, resulting),
    };
  }

  private resolveLocation(
    location: string | WorkspaceRecoveryLocation,
  ): { workspacePath: string; repositoryId: string | null } {
    if (typeof location === "string") {
      return { workspacePath: location, repositoryId: null };
    }
    if (
      !location ||
      typeof location.repositoryId !== "string" ||
      location.repositoryId.length === 0 ||
      typeof location.workspacePath !== "string"
    ) {
      throw new RecoveryIntegrityError("Git recovery location is invalid");
    }
    if (!this.gitRepository && !this.allowTestFileBackend) {
      throw new RecoveryIntegrityError("Git recovery repository is not configured");
    }
    return {
      workspacePath: location.workspacePath,
      repositoryId: location.repositoryId,
    };
  }

  private assertSnapshotRepository(
    snapshot: RecoverySnapshot,
    repositoryId: string | null,
  ): void {
    if (repositoryId === null) {
      if (snapshot.storage === "git-sha256-v1" && !this.allowTestFileBackend) {
        throw new RecoveryIntegrityError(
          "A Git recovery snapshot requires its Agent repository ID",
        );
      }
      return;
    }
    if (
      snapshot.storage !== "git-sha256-v1" ||
      snapshot.repositoryId !== repositoryId
    ) {
      throw new RecoveryIntegrityError(
        "Recovery snapshot belongs to a different Agent repository",
      );
    }
    for (const entry of snapshot.entries) {
      if (entry.kind === "file" && !SHA256_PATTERN.test(entry.gitBlobOid ?? "")) {
        throw new RecoveryIntegrityError(
          `Recovery entry is missing its Git blob OID: ${entry.path}`,
        );
      }
    }
  }

  private toGitSnapshot(snapshot: RecoverySnapshot): GitRecoverySnapshot {
    const validated = this.validateSnapshot(snapshot);
    for (const entry of validated.entries) {
      if (entry.kind === "file" && !SHA256_PATTERN.test(entry.gitBlobOid ?? "")) {
        throw new RecoveryIntegrityError(
          `Git blob OID is missing for recovery entry ${entry.path}`,
        );
      }
    }
    return {
      version: validated.version,
      policyId: validated.policyId,
      rootHash: validated.rootHash,
      entries: validated.entries as GitRecoverySnapshot["entries"],
      fileCount: validated.fileCount,
      totalBytes: validated.totalBytes,
    };
  }

  private withGitCheckpoint(
    snapshot: RecoverySnapshot,
    checkpoint: GitRecoveryCheckpoint,
  ): RecoverySnapshot {
    if (snapshot.rootHash !== checkpoint.rootHash) {
      throw new RecoveryIntegrityError(
        "Git recovery checkpoint does not match the captured workspace",
      );
    }
    return {
      ...snapshot,
      storage: "git-sha256-v1",
      repositoryId: checkpoint.repositoryId,
      commitOid: checkpoint.commitOid,
      controlTreeOid: checkpoint.controlTreeOid,
      workspaceTreeOid: checkpoint.workspaceTreeOid,
      manifestBlobOid: checkpoint.manifestBlobOid,
    };
  }

  private withTestCheckpoint(
    snapshot: RecoverySnapshot,
    repositoryId: string,
  ): RecoverySnapshot {
    return {
      ...snapshot,
      storage: "git-sha256-v1",
      repositoryId,
      commitOid: snapshot.rootHash,
      controlTreeOid: snapshot.rootHash,
      workspaceTreeOid: snapshot.rootHash,
      manifestBlobOid: snapshot.rootHash,
    };
  }

  private objectRoot(): string {
    return path.join(path.resolve(this.recoveryRoot), "objects", "sha256");
  }

  private manifestRoot(): string {
    return path.join(path.resolve(this.recoveryRoot), "manifests", "sha256");
  }

  private operationRoot(): string {
    return path.join(path.resolve(this.recoveryRoot), "operations");
  }

  private objectPath(blobHash: string): string {
    return path.join(this.objectRoot(), blobHash.slice(0, 2), blobHash);
  }

  private manifestPath(rootHash: string): string {
    return path.join(this.manifestRoot(), rootHash.slice(0, 2), `${rootHash}.json`);
  }

  private journalPath(operationId: string, state: RestoreJournalState): string {
    return path.join(
      this.operationRoot(),
      `${validateOperationId(operationId)}.${state}.json`,
    );
  }

  private validateJournal(value: unknown): RestoreJournal {
    if (typeof value !== "object" || value === null) {
      throw new RecoveryIntegrityError("Recovery operation journal is invalid");
    }
    const candidate = value as Partial<RestoreJournal>;
    const states = new Set<RestoreJournalState>([
      "PREPARED",
      "QUARANTINED",
      "PUBLISHED",
      "COMMITTED",
      "ROLLED_BACK",
    ]);
    if (
      candidate.version !== 1 ||
      typeof candidate.state !== "string" ||
      !states.has(candidate.state as RestoreJournalState) ||
      typeof candidate.operationId !== "string" ||
      typeof candidate.workspacePath !== "string" ||
      typeof candidate.stagingPath !== "string" ||
      typeof candidate.quarantinePath !== "string" ||
      typeof candidate.expectedRootHash !== "string" ||
      typeof candidate.resultingRootHash !== "string" ||
      typeof candidate.updatedAt !== "string" ||
      !SHA256_PATTERN.test(candidate.expectedRootHash) ||
      !SHA256_PATTERN.test(candidate.resultingRootHash) ||
      !Number.isFinite(Date.parse(candidate.updatedAt))
    ) {
      throw new RecoveryIntegrityError("Recovery operation journal is invalid");
    }
    const operationId = validateOperationId(candidate.operationId);
    const workspacePath = path.resolve(candidate.workspacePath);
    const parent = path.dirname(workspacePath);
    const base = path.basename(workspacePath);
    const stagingPath = path.join(parent, `.${base}.restore-${operationId}.staging`);
    const quarantinePath = path.join(parent, `.${base}.restore-${operationId}.quarantine`);
    if (
      path.resolve(candidate.stagingPath) !== stagingPath ||
      path.resolve(candidate.quarantinePath) !== quarantinePath
    ) {
      throw new RecoveryIntegrityError("Recovery operation journal paths are inconsistent");
    }
    const recovery = path.resolve(this.recoveryRoot);
    if (
      workspacePath === recovery ||
      isPathInside(workspacePath, recovery) ||
      isPathInside(recovery, workspacePath)
    ) {
      throw new RecoveryIntegrityError("Recovery operation journal targets its own storage");
    }
    return {
      version: 1,
      state: candidate.state as RestoreJournalState,
      operationId,
      workspacePath,
      stagingPath,
      quarantinePath,
      expectedRootHash: candidate.expectedRootHash,
      resultingRootHash: candidate.resultingRootHash,
      updatedAt: candidate.updatedAt,
    };
  }

  private async writeJournal(journal: RestoreJournal): Promise<void> {
    const validated = this.validateJournal(journal);
    await this.putImmutable(
      this.journalPath(validated.operationId, validated.state),
      Buffer.from(`${JSON.stringify(validated)}\n`, "utf8"),
    );
  }

  private async advanceJournal(
    journal: RestoreJournal,
    state: RestoreJournalState,
  ): Promise<RestoreJournal> {
    if (journal.state === state) return journal;
    const transitions: Record<RestoreJournalState, ReadonlySet<RestoreJournalState>> = {
      PREPARED: new Set(["QUARANTINED", "ROLLED_BACK"]),
      QUARANTINED: new Set(["PUBLISHED", "ROLLED_BACK"]),
      PUBLISHED: new Set(["COMMITTED", "ROLLED_BACK"]),
      COMMITTED: new Set(),
      ROLLED_BACK: new Set(),
    };
    if (!transitions[journal.state].has(state)) {
      throw new RecoveryIntegrityError(
        `Invalid recovery journal transition ${journal.state} -> ${state}`,
      );
    }
    const next: RestoreJournal = {
      ...journal,
      state,
    };
    await this.writeJournal(next);
    return next;
  }

  private async latestJournals(): Promise<RestoreJournal[]> {
    const names = await readdir(this.operationRoot());
    const priority: Record<RestoreJournalState, number> = {
      PREPARED: 1,
      QUARANTINED: 2,
      PUBLISHED: 3,
      COMMITTED: 4,
      ROLLED_BACK: 4,
    };
    const latest = new Map<string, RestoreJournal>();
    for (const name of names.sort(comparePaths)) {
      if (/\.json\.tmp-[A-Za-z0-9-]+$/.test(name)) {
        await rm(path.join(this.operationRoot(), name), { force: true });
        continue;
      }
      const match = /^(.*)\.(PREPARED|QUARANTINED|PUBLISHED|COMMITTED|ROLLED_BACK)\.json$/.exec(name);
      if (!match) {
        throw new RecoveryIntegrityError(`Unknown recovery operation journal file: ${name}`);
      }
      const operationId = validateOperationId(match[1] as string);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path.join(this.operationRoot(), name), "utf8"));
      } catch (error) {
        throw new RecoveryIntegrityError(`Unable to read recovery journal ${name}`, {
          cause: error,
        });
      }
      const journal = this.validateJournal(parsed);
      if (journal.operationId !== operationId || journal.state !== match[2]) {
        throw new RecoveryIntegrityError(`Recovery journal filename does not match ${name}`);
      }
      const previous = latest.get(operationId);
      if (
        previous &&
        previous.state !== journal.state &&
        priority[previous.state] === 4 &&
        priority[journal.state] === 4
      ) {
        throw new RecoveryIntegrityError(
          `Recovery operation ${operationId} has conflicting terminal journals`,
        );
      }
      if (!previous || priority[journal.state] > priority[previous.state]) {
        latest.set(operationId, journal);
      }
    }
    return [...latest.values()].sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
  }

  private async reconcileOperations(): Promise<void> {
    for (const journal of await this.latestJournals()) {
      if (journal.state === "COMMITTED" || journal.state === "ROLLED_BACK") continue;
      const workspaceExists = await this.pathExists(journal.workspacePath);
      const quarantineExists = await this.pathExists(journal.quarantinePath);
      if (!workspaceExists) {
        if (!quarantineExists) {
          throw new RecoveryIntegrityError(
            `Recovery operation ${journal.operationId} has neither a workspace nor quarantine`,
          );
        }
        await this.rollbackRestore(journal);
        continue;
      }
      const current = await this.captureStable(journal.workspacePath, false);
      if (
        journal.state === "PUBLISHED" &&
        current.rootHash === journal.resultingRootHash
      ) {
        await rm(journal.stagingPath, { recursive: true, force: true });
        await this.advanceJournal(journal, "COMMITTED");
        continue;
      }
      if (current.rootHash === journal.expectedRootHash && !quarantineExists) {
        await rm(journal.stagingPath, { recursive: true, force: true });
        await this.advanceJournal(journal, "ROLLED_BACK");
        continue;
      }
      if (quarantineExists) {
        await this.rollbackRestore(journal);
        continue;
      }
      throw new RecoveryIntegrityError(
        `Recovery operation ${journal.operationId} cannot be reconciled safely`,
      );
    }
  }

  private async rollbackRestore(journal: RestoreJournal): Promise<void> {
    const workspaceExists = await this.pathExists(journal.workspacePath);
    const quarantineExists = await this.pathExists(journal.quarantinePath);
    if (quarantineExists) {
      const quarantined = await this.captureStable(journal.quarantinePath, false);
      if (quarantined.rootHash !== journal.expectedRootHash) {
        throw new RecoveryIntegrityError(
          `Recovery operation ${journal.operationId} quarantine hash ${quarantined.rootHash} does not match expected ${journal.expectedRootHash}`,
        );
      }
    }
    if (workspaceExists) {
      const current = await this.captureStable(journal.workspacePath, false);
      if (current.rootHash === journal.expectedRootHash) {
        await rm(journal.stagingPath, { recursive: true, force: true });
        if (quarantineExists) {
          await rm(journal.quarantinePath, { recursive: true, force: true });
        }
        await this.advanceJournal(journal, "ROLLED_BACK");
        return;
      }
      if (!quarantineExists) {
        throw new RecoveryIntegrityError(
          `Recovery operation ${journal.operationId} has no quarantine to roll back`,
        );
      }
      await rm(journal.stagingPath, { recursive: true, force: true });
      await rename(journal.workspacePath, journal.stagingPath);
    } else if (!quarantineExists) {
      throw new RecoveryIntegrityError(
        `Recovery operation ${journal.operationId} lost both workspace revisions`,
      );
    }
    await rename(journal.quarantinePath, journal.workspacePath);
    const restored = await this.captureStable(journal.workspacePath, false);
    if (restored.rootHash !== journal.expectedRootHash) {
      throw new RecoveryIntegrityError(
        `Recovery operation ${journal.operationId} rollback hash ${restored.rootHash} does not match expected ${journal.expectedRootHash}`,
      );
    }
    await this.advanceJournal(journal, "ROLLED_BACK");
    await rm(journal.stagingPath, { recursive: true, force: true });
  }

  private async assertWorkspaceBoundary(workspacePath: string): Promise<void> {
    const workspace = path.resolve(workspacePath);
    const recovery = path.resolve(this.recoveryRoot);
    let workspaceReal: string;
    try {
      const workspaceState = await lstat(workspace, { bigint: true });
      if (!workspaceState.isDirectory() || workspaceState.isSymbolicLink()) {
        throw new RecoveryIntegrityError("Workspace root must be a real directory");
      }
      workspaceReal = await realpath(workspace);
    } catch (error) {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryIntegrityError(`Unable to inspect workspace root: ${workspace}`, {
        cause: error,
      });
    }
    const recoveryReal = await realpath(recovery);
    if (
      workspaceReal === recoveryReal ||
      isPathInside(workspaceReal, recoveryReal) ||
      isPathInside(recoveryReal, workspaceReal)
    ) {
      throw new RecoveryIntegrityError("Recovery storage must be outside the workspace");
    }
  }

  private async withWorkspaceLock<T>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = path.resolve(workspacePath);
    const previous = this.workspaceLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.workspaceLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.workspaceLocks.get(key) === tail) {
        this.workspaceLocks.delete(key);
      }
    }
  }

  private async captureStable(
    workspacePath: string,
    persistBlobs: boolean,
    repositoryId: string | null = null,
  ): Promise<RecoverySnapshot> {
    let lastCause: unknown;
    for (let attempt = 1; attempt <= this.limits.maxCaptureAttempts; attempt += 1) {
      try {
        const first = await this.scanWorkspace(
          workspacePath,
          persistBlobs,
          repositoryId,
        );
        await this.hooks.afterScanPass?.({
          workspacePath,
          attempt,
          rootHash: first.rootHash,
        });
        const second = await this.scanWorkspace(
          workspacePath,
          persistBlobs,
          repositoryId,
        );
        if (first.rootHash === second.rootHash) return second;
        lastCause = new ScanChangedError("Workspace content changed between scans");
      } catch (error) {
        if (!(error instanceof ScanChangedError) && !isMissing(error)) throw error;
        lastCause = error;
      }
    }
    throw new WorkspaceUnstableError(
      workspacePath,
      this.limits.maxCaptureAttempts,
      lastCause === undefined ? undefined : { cause: lastCause },
    );
  }

  private async scanWorkspace(
    workspacePath: string,
    persistBlobs: boolean,
    repositoryId: string | null,
  ): Promise<RecoverySnapshot> {
    const root = path.resolve(workspacePath);
    const entries: RecoverySnapshotEntry[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    const seenCaseFoldedPaths = new Set<string>();

    const rootBefore = await lstat(root, { bigint: true });
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
      throw new RecoveryIntegrityError("Workspace root must remain a real directory");
    }

    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const directoryBefore = await lstat(directory, { bigint: true });
      if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
        throw new ScanChangedError(`Directory changed while scanning: ${relativeDirectory || "."}`);
      }
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => comparePaths(left.name, right.name));
      for (const child of children) {
        if (child.name.includes("/") || child.name.includes("\\") || child.name.includes("\0")) {
          throw new RecoveryIntegrityError(`Unsupported workspace entry name: ${child.name}`);
        }
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${child.name}`
          : child.name;
        assertSafeRelativePath(relativePath);
        const caseKey = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
        if (seenCaseFoldedPaths.has(caseKey)) {
          throw new RecoveryIntegrityError(`Duplicate workspace path: ${relativePath}`);
        }
        seenCaseFoldedPaths.add(caseKey);

        const absolutePath = path.join(directory, child.name);
        const before = await lstat(absolutePath, { bigint: true });
        if (before.isSymbolicLink()) {
          throw new RecoveryStoreError(
            "RECOVERY_UNSUPPORTED_ENTRY",
            `Symbolic links are not supported in recovery snapshots: ${relativePath}`,
          );
        }
        if (before.isDirectory()) {
          entries.push({
            path: relativePath,
            kind: "directory",
            mode: normalizeMode(before),
          });
          await visit(absolutePath, relativePath);
          const after = await lstat(absolutePath, { bigint: true });
          if (!sameFileState(before, after)) {
            throw new ScanChangedError(`Directory changed while scanning: ${relativePath}`);
          }
          continue;
        }
        if (!before.isFile()) {
          throw new RecoveryStoreError(
            "RECOVERY_UNSUPPORTED_ENTRY",
            `Only regular files and directories can be recovered: ${relativePath}`,
          );
        }

        const bytes = await this.readStableFile(absolutePath, relativePath, before);
        const size = bytes.byteLength;
        fileCount += 1;
        totalBytes += size;
        if (fileCount > this.limits.maxFiles) {
          throw new RecoveryLimitError(`Workspace exceeds ${this.limits.maxFiles} files`);
        }
        if (size > this.limits.maxFileBytes) {
          throw new RecoveryLimitError(
            `Workspace file exceeds ${this.limits.maxFileBytes} bytes: ${relativePath}`,
          );
        }
        if (totalBytes > this.limits.maxTotalBytes) {
          throw new RecoveryLimitError(
            `Workspace exceeds ${this.limits.maxTotalBytes} total bytes`,
          );
        }
        const blobHash = hashBytes(bytes);
        let gitBlobOid: string | undefined;
        if (repositoryId) {
          gitBlobOid =
            persistBlobs && this.gitRepository
              ? await this.gitRepository.writeBlob(repositoryId, bytes)
              : hashGitBlob(bytes);
          if (persistBlobs && !this.gitRepository) {
            await this.putBlob(blobHash, bytes);
          }
        } else if (persistBlobs) {
          await this.putBlob(blobHash, bytes);
        }
        entries.push({
          path: relativePath,
          kind: "file",
          mode: normalizeMode(before),
          size,
          blobHash,
          ...(gitBlobOid === undefined ? {} : { gitBlobOid }),
        });
      }
      const directoryAfter = await lstat(directory, { bigint: true });
      if (!sameFileState(directoryBefore, directoryAfter)) {
        throw new ScanChangedError(
          `Directory changed while scanning: ${relativeDirectory || "."}`,
        );
      }
    };

    await visit(root, "");
    const rootAfter = await lstat(root, { bigint: true });
    if (!sameFileState(rootBefore, rootAfter)) {
      throw new ScanChangedError("Workspace root changed while scanning");
    }
    entries.sort((left, right) => comparePaths(left.path, right.path));
    return {
      version: SNAPSHOT_VERSION,
      policyId: this.policyId,
      rootHash: calculateRootHash(this.policyId, entries),
      entries,
      fileCount,
      totalBytes,
      ...(repositoryId === null
        ? {}
        : {
            storage: "git-sha256-v1" as const,
            repositoryId,
            commitOid: null,
          }),
    };
  }

  private async readStableFile(
    absolutePath: string,
    relativePath: string,
    pathBefore: BigIntStats,
  ): Promise<Buffer> {
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await open(absolutePath, flags);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileState(pathBefore, opened)) {
        throw new ScanChangedError(`File changed before it was read: ${relativePath}`);
      }
      if (opened.size > BigInt(this.limits.maxFileBytes)) {
        throw new RecoveryLimitError(
          `Workspace file exceeds ${this.limits.maxFileBytes} bytes: ${relativePath}`,
        );
      }
      const bytes = await handle.readFile();
      const afterRead = await handle.stat({ bigint: true });
      const pathAfter = await lstat(absolutePath, { bigint: true });
      if (
        bytes.byteLength !== Number(afterRead.size) ||
        !sameFileState(opened, afterRead) ||
        !sameFileState(afterRead, pathAfter)
      ) {
        throw new ScanChangedError(`File changed while it was read: ${relativePath}`);
      }
      return bytes;
    } finally {
      await handle?.close();
    }
  }

  private validateSnapshot(value: unknown): RecoverySnapshot {
    if (!value || typeof value !== "object") {
      throw new RecoveryIntegrityError("Recovery snapshot must be an object");
    }
    const candidate = value as Partial<RecoverySnapshot>;
    if (candidate.version !== SNAPSHOT_VERSION || candidate.policyId !== this.policyId) {
      throw new RecoveryIntegrityError("Recovery snapshot version or policy does not match");
    }
    if (!Array.isArray(candidate.entries) || !SHA256_PATTERN.test(candidate.rootHash ?? "")) {
      throw new RecoveryIntegrityError("Recovery snapshot manifest is malformed");
    }

    const entries: RecoverySnapshotEntry[] = [];
    const byPath = new Map<string, RecoverySnapshotEntry>();
    const seenCaseFoldedPaths = new Set<string>();
    let fileCount = 0;
    let totalBytes = 0;
    for (const rawEntry of candidate.entries as unknown[]) {
      if (!rawEntry || typeof rawEntry !== "object") {
        throw new RecoveryIntegrityError("Recovery snapshot contains an invalid entry");
      }
      const entry = rawEntry as Partial<RecoverySnapshotEntry>;
      if (typeof entry.path !== "string") {
        throw new RecoveryIntegrityError("Recovery snapshot entry path is missing");
      }
      assertSafeRelativePath(entry.path);
      const caseKey = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
      if (byPath.has(entry.path) || seenCaseFoldedPaths.has(caseKey)) {
        throw new RecoveryIntegrityError(`Recovery snapshot path is duplicated: ${entry.path}`);
      }
      seenCaseFoldedPaths.add(caseKey);
      if (!Number.isInteger(entry.mode) || (entry.mode ?? -1) < 0 || (entry.mode ?? 0) > 0o777) {
        throw new RecoveryIntegrityError(`Recovery snapshot mode is invalid: ${entry.path}`);
      }
      if (entry.kind === "directory") {
        if (entry.size !== undefined || entry.blobHash !== undefined) {
          throw new RecoveryIntegrityError(`Directory entry has file metadata: ${entry.path}`);
        }
        const validated: RecoverySnapshotEntry = {
          path: entry.path,
          kind: "directory",
          mode: entry.mode as number,
        };
        entries.push(validated);
        byPath.set(validated.path, validated);
      } else if (entry.kind === "file") {
        if (
          !Number.isSafeInteger(entry.size) ||
          (entry.size ?? -1) < 0 ||
          !SHA256_PATTERN.test(entry.blobHash ?? "") ||
          (entry.gitBlobOid !== undefined &&
            !SHA256_PATTERN.test(entry.gitBlobOid))
        ) {
          throw new RecoveryIntegrityError(`File entry metadata is invalid: ${entry.path}`);
        }
        const size = entry.size as number;
        if (size > this.limits.maxFileBytes) {
          throw new RecoveryLimitError(
            `Snapshot file exceeds ${this.limits.maxFileBytes} bytes: ${entry.path}`,
          );
        }
        fileCount += 1;
        totalBytes += size;
        const validated: RecoverySnapshotEntry = {
          path: entry.path,
          kind: "file",
          mode: entry.mode as number,
          size,
          blobHash: entry.blobHash as string,
          ...(entry.gitBlobOid === undefined
            ? {}
            : { gitBlobOid: entry.gitBlobOid }),
        };
        entries.push(validated);
        byPath.set(validated.path, validated);
      } else {
        throw new RecoveryIntegrityError(`Recovery snapshot kind is invalid: ${entry.path}`);
      }
    }

    entries.sort((left, right) => comparePaths(left.path, right.path));
    if (fileCount > this.limits.maxFiles || totalBytes > this.limits.maxTotalBytes) {
      throw new RecoveryLimitError("Recovery snapshot exceeds configured limits");
    }
    for (const entry of entries) {
      const parent = path.posix.dirname(entry.path);
      if (parent !== "." && byPath.get(parent)?.kind !== "directory") {
        throw new RecoveryIntegrityError(
          `Recovery snapshot is missing parent directory ${parent} for ${entry.path}`,
        );
      }
    }
    const rootHash = calculateRootHash(this.policyId, entries);
    if (rootHash !== candidate.rootHash) {
      throw new RecoveryIntegrityError("Recovery snapshot root hash does not match its entries");
    }
    if (candidate.fileCount !== fileCount || candidate.totalBytes !== totalBytes) {
      throw new RecoveryIntegrityError("Recovery snapshot counters do not match its entries");
    }
    let gitMetadata: Pick<
      RecoverySnapshot,
      | "storage"
      | "repositoryId"
      | "commitOid"
      | "controlTreeOid"
      | "workspaceTreeOid"
      | "manifestBlobOid"
    > | null = null;
    if (candidate.storage !== undefined) {
      if (
        candidate.storage !== "git-sha256-v1" ||
        typeof candidate.repositoryId !== "string" ||
        candidate.repositoryId.length === 0 ||
        (candidate.commitOid !== null &&
          candidate.commitOid !== undefined &&
          !SHA256_PATTERN.test(candidate.commitOid)) ||
        (candidate.controlTreeOid !== undefined &&
          !SHA256_PATTERN.test(candidate.controlTreeOid)) ||
        (candidate.workspaceTreeOid !== undefined &&
          !SHA256_PATTERN.test(candidate.workspaceTreeOid)) ||
        (candidate.manifestBlobOid !== undefined &&
          !SHA256_PATTERN.test(candidate.manifestBlobOid))
      ) {
        throw new RecoveryIntegrityError("Git recovery snapshot metadata is invalid");
      }
      gitMetadata = {
        storage: "git-sha256-v1",
        repositoryId: candidate.repositoryId,
        ...(candidate.commitOid === undefined
          ? {}
          : { commitOid: candidate.commitOid }),
        ...(candidate.controlTreeOid === undefined
          ? {}
          : { controlTreeOid: candidate.controlTreeOid }),
        ...(candidate.workspaceTreeOid === undefined
          ? {}
          : { workspaceTreeOid: candidate.workspaceTreeOid }),
        ...(candidate.manifestBlobOid === undefined
          ? {}
          : { manifestBlobOid: candidate.manifestBlobOid }),
      };
    }
    return {
      version: SNAPSHOT_VERSION,
      policyId: this.policyId,
      rootHash,
      entries,
      fileCount,
      totalBytes,
      ...(gitMetadata ?? {}),
    };
  }

  private async putBlob(blobHash: string, bytes: Buffer): Promise<void> {
    if (hashBytes(bytes) !== blobHash) {
      throw new RecoveryIntegrityError("Blob hash does not match its content");
    }
    await this.putImmutable(this.objectPath(blobHash), bytes);
  }

  private async putManifest(snapshot: RecoverySnapshot): Promise<void> {
    const validated = this.validateSnapshot(snapshot);
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    await this.putImmutable(this.manifestPath(validated.rootHash), bytes);
  }

  private async putImmutable(destination: string, bytes: Buffer): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (await this.pathExists(destination)) {
      const existing = await readFile(destination);
      if (!existing.equals(bytes)) {
        throw new RecoveryIntegrityError(`Immutable recovery object is corrupt: ${destination}`);
      }
      return;
    }

    const temporary = `${destination}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      if (!isAlreadyPresent(error)) throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const stored = await readFile(destination);
    if (!stored.equals(bytes)) {
      throw new RecoveryIntegrityError(`Immutable recovery object is corrupt: ${destination}`);
    }
  }

  private async hydrate(
    stagingPath: string,
    snapshot: RecoverySnapshot,
    repositoryId: string | null,
  ): Promise<void> {
    await mkdir(stagingPath, { recursive: false, mode: 0o700 });
    const directories = snapshot.entries
      .filter((entry) => entry.kind === "directory")
      .sort((left, right) => {
        const depth = left.path.split("/").length - right.path.split("/").length;
        return depth === 0 ? comparePaths(left.path, right.path) : depth;
      });
    for (const entry of directories) {
      const destination = resolveSnapshotPath(stagingPath, entry.path);
      await mkdir(destination, { recursive: false, mode: 0o700 });
    }
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      const bytes = await this.readVerifiedBlob(entry, repositoryId);
      const destination = resolveSnapshotPath(stagingPath, entry.path);
      const handle = await open(destination, "wx", entry.mode);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(destination, entry.mode);
    }
    for (const entry of [...directories].reverse()) {
      await chmod(resolveSnapshotPath(stagingPath, entry.path), entry.mode);
    }
  }

  private async verifySnapshotBlobs(
    snapshot: RecoverySnapshot,
    requestedPaths: readonly string[] | null,
    repositoryId: string | null,
  ): Promise<void> {
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      if (requestedPaths && !isSelected(entry.path, requestedPaths)) continue;
      await this.readVerifiedBlob(entry, repositoryId);
    }
  }

  private async readVerifiedBlob(
    entry: RecoverySnapshotEntry,
    repositoryId: string | null,
  ): Promise<Buffer> {
    if (entry.kind !== "file") {
      throw new RecoveryIntegrityError("Only file entries have recovery blobs");
    }
    const blobHash = entry.blobHash as string;
    let bytes: Buffer;
    try {
      if (repositoryId && this.gitRepository) {
        const gitBlobOid = entry.gitBlobOid;
        if (!gitBlobOid) {
          throw new RecoveryIntegrityError(
            `Recovery entry is missing its Git blob OID: ${entry.path}`,
          );
        }
        bytes = await this.gitRepository.readBlob(repositoryId, gitBlobOid);
      } else {
        bytes = await readFile(this.objectPath(blobHash));
      }
    } catch (error) {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryIntegrityError(`Recovery blob is missing: ${blobHash}`, {
        cause: error,
      });
    }
    if (bytes.byteLength !== entry.size || hashBytes(bytes) !== blobHash) {
      throw new RecoveryIntegrityError(`Recovery blob failed verification: ${blobHash}`);
    }
    if (
      entry.gitBlobOid !== undefined &&
      hashGitBlob(bytes) !== entry.gitBlobOid
    ) {
      throw new RecoveryIntegrityError(
        `Git recovery blob OID failed verification: ${entry.gitBlobOid}`,
      );
    }
    return bytes;
  }

  private async assertOperationPathsAvailable(
    stagingPath: string,
    quarantinePath: string,
  ): Promise<void> {
    if ((await this.pathExists(stagingPath)) || (await this.pathExists(quarantinePath))) {
      throw new RecoveryOperationConflictError(
        "Recovery operation ID already has staging or quarantine data",
      );
    }
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await stat(candidate);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }
}

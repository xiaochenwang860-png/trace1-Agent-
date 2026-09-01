import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const GIT_STORAGE_FORMAT = "git-sha256-v1" as const;
const MANIFEST_VERSION = 1 as const;
const SNAPSHOT_VERSION = 1 as const;
const COMMIT_FORMAT = "launchpad-recovery-commit-v1" as const;
const OID_PATTERN = /^[a-f0-9]{64}$/;
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REF_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;

type GitObjectType = "blob" | "tree" | "commit";

export interface GitRecoveryGitResult {
  stdout: Buffer;
  stderr: Buffer;
}

/** Structural subset implemented by GitClient; kept injectable for deterministic tests. */
export interface GitRecoveryGitClient {
  run(
    args: readonly string[],
    options?: {
      cwd?: string;
      input?: Buffer | string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    },
  ): Promise<GitRecoveryGitResult>;
  assertCapabilities(parentDirectory?: string): Promise<unknown>;
  initializeBareSha256(repositoryPath: string): Promise<void>;
  assertBareSha256Repository(repositoryPath: string): Promise<void>;
}

export interface GitRecoveryDirectoryEntry {
  path: string;
  kind: "directory";
  mode: number;
}

export interface GitRecoveryFileEntry {
  path: string;
  kind: "file";
  mode: number;
  size: number;
  /** SHA-256 of the raw bytes, used by the logical workspace snapshot. */
  blobHash: string;
  /** SHA-256 Git object ID (which also hashes the Git object header). */
  gitBlobOid: string;
}

export type GitRecoveryManifestEntry =
  | GitRecoveryDirectoryEntry
  | GitRecoveryFileEntry;

export interface GitRecoverySnapshot {
  version: typeof SNAPSHOT_VERSION;
  policyId: string;
  rootHash: string;
  entries: GitRecoveryManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

export interface GitRecoveryManifest {
  version: typeof MANIFEST_VERSION;
  storage: typeof GIT_STORAGE_FORMAT;
  repositoryId: string;
  repositoryIdHash: string;
  workspaceTreeOid: string;
  snapshot: GitRecoverySnapshot;
}

export interface GitRecoveryCheckpoint {
  storage: typeof GIT_STORAGE_FORMAT;
  repositoryId: string;
  repositoryPath: string;
  rootHash: string;
  commitOid: string;
  controlTreeOid: string;
  workspaceTreeOid: string;
  manifestBlobOid: string;
  refName: string;
}

export interface LoadedGitRecoveryCheckpoint
  extends Omit<GitRecoveryCheckpoint, "refName"> {
  refName: null;
  manifest: GitRecoveryManifest;
  snapshot: GitRecoverySnapshot;
}

export interface GitRecoveryRepositoryOptions {
  maxManifestBytes?: number;
  maxManifestEntries?: number;
  maxBlobBytes?: number;
  maxTotalBytes?: number;
}

export type GitRecoveryRepositoryErrorCode =
  | "GIT_RECOVERY_CORRUPT"
  | "GIT_RECOVERY_INVALID_OBJECT_ID"
  | "GIT_RECOVERY_INVALID_REFERENCE"
  | "GIT_RECOVERY_INVALID_REPOSITORY_ID";

export class GitRecoveryRepositoryError extends Error {
  constructor(
    public readonly code: GitRecoveryRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitRecoveryRepositoryError";
  }
}

interface ResolvedOptions {
  maxManifestBytes: number;
  maxManifestEntries: number;
  maxBlobBytes: number;
  maxTotalBytes: number;
}

interface TreeNode {
  directories: Map<string, TreeNode>;
  files: Map<string, GitRecoveryFileEntry>;
}

interface ParsedTreeEntry {
  name: string;
  mode: "100644" | "100755" | "40000";
  oid: string;
}

interface CommitMetadata {
  format: typeof COMMIT_FORMAT;
  repositoryIdHash: string;
  rootHash: string;
  manifestBlobOid: string;
  workspaceTreeOid: string;
}

interface StableConfig {
  bytes: Buffer;
  identity: string;
  hash: string;
}

interface VerifiedRepository {
  fingerprint: string;
}

const defaultOptions: ResolvedOptions = {
  maxManifestBytes: 32 * 1024 * 1024,
  maxManifestEntries: 100_000,
  maxBlobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

function corrupt(message: string, options?: ErrorOptions): never {
  throw new GitRecoveryRepositoryError("GIT_RECOVERY_CORRUPT", message, options);
}

function validateLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryIdHash(repositoryId: string): string {
  return sha256(Buffer.from(repositoryId, "utf8"));
}

function gitObjectOid(type: GitObjectType, bytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from(`${type} ${bytes.length}\0`, "ascii"));
  hash.update(bytes);
  return hash.digest("hex");
}

function compareNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareTreeNames(
  left: { name: string; isTree: boolean },
  right: { name: string; isTree: boolean },
): number {
  const leftKey = Buffer.from(`${left.name}${left.isTree ? "/" : ""}`, "utf8");
  const rightKey = Buffer.from(`${right.name}${right.isTree ? "/" : ""}`, "utf8");
  return Buffer.compare(leftKey, rightKey);
}

function assertCanonicalUtf8(value: string, label: string): void {
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    corrupt(`${label} is not canonical UTF-8`);
  }
}

export function validateGitRecoveryRepositoryId(repositoryId: string): string {
  if (!REPOSITORY_ID_PATTERN.test(repositoryId)) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_REPOSITORY_ID",
      "Recovery repository ID must be 1-256 safe ASCII characters",
    );
  }
  return repositoryId;
}

export function gitRecoveryRepositoryDirectoryName(repositoryId: string): string {
  validateGitRecoveryRepositoryId(repositoryId);
  return `${repositoryIdHash(repositoryId)}.git`;
}

export function validateGitRecoveryRef(refName: string): string {
  if (refName.length > 512 || !refName.startsWith("refs/launchpad/")) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_REFERENCE",
      "Recovery refs must be below refs/launchpad/",
    );
  }
  const segments = refName.split("/");
  if (
    segments.length < 4 ||
    segments.some(
      (segment) =>
        !REF_SEGMENT_PATTERN.test(segment) ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.toLowerCase().endsWith(".lock"),
    ) ||
    refName.includes("..") ||
    refName.includes("@{")
  ) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_REFERENCE",
      "Recovery ref contains an unsafe segment",
    );
  }
  return refName;
}

/** Creates an opaque ref without placing a caller-controlled identifier in Git syntax. */
export function createGitRecoveryRef(scope: string, identifier: string): string {
  if (
    !REF_SEGMENT_PATTERN.test(scope) ||
    scope === "." ||
    scope === ".." ||
    scope.includes("..") ||
    scope.endsWith(".") ||
    scope.toLowerCase().endsWith(".lock")
  ) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_REFERENCE",
      "Recovery ref scope contains unsafe characters",
    );
  }
  if (identifier.length === 0 || identifier.length > 4_096 || identifier.includes("\0")) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_REFERENCE",
      "Recovery ref identifier is invalid",
    );
  }
  return validateGitRecoveryRef(
    `refs/launchpad/${scope}/${sha256(Buffer.from(identifier, "utf8"))}`,
  );
}

function assertOid(value: string, label: string): string {
  if (!OID_PATTERN.test(value)) {
    throw new GitRecoveryRepositoryError(
      "GIT_RECOVERY_INVALID_OBJECT_ID",
      `${label} is not a SHA-256 Git object ID`,
    );
  }
  return value;
}

function parseOidOutput(stdout: Buffer, label: string): string {
  const value = stdout.toString("ascii").trim();
  assertOid(value, label);
  if (stdout.toString("ascii").replace(/\r?\n$/, "") !== value) {
    corrupt(`${label} command returned ambiguous output`);
  }
  return value;
}

function assertSafeSnapshotPath(relativePath: string): void {
  assertCanonicalUtf8(relativePath, "Snapshot path");
  if (
    relativePath.length === 0 ||
    relativePath.length > 4_096 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/")
  ) {
    corrupt(`Unsafe snapshot path: ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    corrupt(`Unsafe snapshot path: ${JSON.stringify(relativePath)}`);
  }
}

function calculateRootHash(snapshot: Pick<GitRecoverySnapshot, "policyId" | "entries">): string {
  const hash = createHash("sha256");
  hash.update("workspace-recovery\0");
  hash.update(String(SNAPSHOT_VERSION));
  hash.update("\0");
  hash.update(snapshot.policyId);
  hash.update("\0");
  for (const entry of snapshot.entries) {
    hash.update(entry.kind === "directory" ? "D\0" : "F\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(String(entry.size));
      hash.update("\0");
      hash.update(entry.blobHash);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function validateSnapshot(
  value: unknown,
  maxEntries: number,
  maxBlobBytes: number,
  maxTotalBytes: number,
): GitRecoverySnapshot {
  if (!isRecord(value)) corrupt("Recovery manifest snapshot must be an object");
  assertExactKeys(value, [
    "version",
    "policyId",
    "rootHash",
    "entries",
    "fileCount",
    "totalBytes",
  ], "snapshot");
  if (value.version !== SNAPSHOT_VERSION) corrupt("Unsupported recovery snapshot version");
  if (
    typeof value.policyId !== "string" ||
    value.policyId.length === 0 ||
    value.policyId.length > 256 ||
    value.policyId.includes("\0")
  ) {
    corrupt("Recovery snapshot policy ID is invalid");
  }
  assertCanonicalUtf8(value.policyId, "Recovery snapshot policy ID");
  if (typeof value.rootHash !== "string") corrupt("Recovery snapshot root hash is missing");
  assertOid(value.rootHash, "Recovery snapshot root hash");
  if (!Array.isArray(value.entries) || value.entries.length > maxEntries) {
    corrupt("Recovery snapshot entries are invalid or exceed the configured limit");
  }
  if (!Number.isSafeInteger(value.fileCount) || (value.fileCount as number) < 0) {
    corrupt("Recovery snapshot file count is invalid");
  }
  if (!Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0) {
    corrupt("Recovery snapshot byte count is invalid");
  }

  const entries: GitRecoveryManifestEntry[] = [];
  let previousPath: string | null = null;
  let fileCount = 0;
  let totalBytes = 0;
  const kinds = new Map<string, "file" | "directory">();

  for (const candidate of value.entries) {
    if (!isRecord(candidate)) corrupt("Recovery snapshot entry must be an object");
    if (typeof candidate.path !== "string") corrupt("Recovery snapshot entry path is invalid");
    assertSafeSnapshotPath(candidate.path);
    if (previousPath !== null && compareNames(previousPath, candidate.path) >= 0) {
      corrupt("Recovery snapshot entries must be strictly byte-sorted and unique");
    }
    previousPath = candidate.path;
    if (!Number.isSafeInteger(candidate.mode) || (candidate.mode as number) < 0 || (candidate.mode as number) > 0o777) {
      corrupt(`Recovery snapshot mode is invalid: ${candidate.path}`);
    }

    if (candidate.kind === "directory") {
      assertExactKeys(candidate, ["path", "kind", "mode"], `directory entry ${candidate.path}`);
      const entry: GitRecoveryDirectoryEntry = {
        path: candidate.path,
        kind: "directory",
        mode: candidate.mode as number,
      };
      entries.push(entry);
      kinds.set(entry.path, entry.kind);
      continue;
    }

    if (candidate.kind !== "file") corrupt(`Recovery snapshot kind is invalid: ${candidate.path}`);
    assertExactKeys(
      candidate,
      ["path", "kind", "mode", "size", "blobHash", "gitBlobOid"],
      `file entry ${candidate.path}`,
    );
    if (!Number.isSafeInteger(candidate.size) || (candidate.size as number) < 0) {
      corrupt(`Recovery snapshot file size is invalid: ${candidate.path}`);
    }
    if ((candidate.size as number) > maxBlobBytes) {
      corrupt(`Recovery snapshot file exceeds the configured size limit: ${candidate.path}`);
    }
    if (typeof candidate.blobHash !== "string" || typeof candidate.gitBlobOid !== "string") {
      corrupt(`Recovery snapshot file hashes are invalid: ${candidate.path}`);
    }
    assertOid(candidate.blobHash, `Raw blob hash for ${candidate.path}`);
    assertOid(candidate.gitBlobOid, `Git blob OID for ${candidate.path}`);
    const entry: GitRecoveryFileEntry = {
      path: candidate.path,
      kind: "file",
      mode: candidate.mode as number,
      size: candidate.size as number,
      blobHash: candidate.blobHash,
      gitBlobOid: candidate.gitBlobOid,
    };
    entries.push(entry);
    kinds.set(entry.path, entry.kind);
    fileCount += 1;
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) corrupt("Recovery snapshot byte count overflowed");
  }

  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (kinds.get(parent) !== "directory") {
        corrupt(`Recovery snapshot is missing directory ancestor ${parent}`);
      }
    }
  }

  if (fileCount !== value.fileCount || totalBytes !== value.totalBytes) {
    corrupt("Recovery snapshot aggregate counts do not match its entries");
  }
  if (totalBytes > maxTotalBytes) {
    corrupt("Recovery snapshot exceeds the configured total byte limit");
  }
  const snapshot: GitRecoverySnapshot = {
    version: SNAPSHOT_VERSION,
    policyId: value.policyId,
    rootHash: value.rootHash,
    entries,
    fileCount,
    totalBytes,
  };
  if (calculateRootHash(snapshot) !== snapshot.rootHash) {
    corrupt("Recovery snapshot logical root hash does not match its entries");
  }
  return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    corrupt(`${label} contains unexpected or missing fields`);
  }
}

function validateManifest(
  value: unknown,
  expectedRepositoryId: string,
  expectedWorkspaceTreeOid: string,
  maxEntries: number,
  maxBlobBytes: number,
  maxTotalBytes: number,
): GitRecoveryManifest {
  if (!isRecord(value)) corrupt("Recovery manifest must be an object");
  assertExactKeys(
    value,
    ["version", "storage", "repositoryId", "repositoryIdHash", "workspaceTreeOid", "snapshot"],
    "manifest",
  );
  if (value.version !== MANIFEST_VERSION || value.storage !== GIT_STORAGE_FORMAT) {
    corrupt("Unsupported Git recovery manifest format");
  }
  if (value.repositoryId !== expectedRepositoryId) {
    corrupt("Recovery manifest belongs to a different repository");
  }
  if (
    value.repositoryIdHash !== repositoryIdHash(expectedRepositoryId) ||
    typeof value.repositoryIdHash !== "string"
  ) {
    corrupt("Recovery manifest repository identity hash is invalid");
  }
  if (typeof value.workspaceTreeOid !== "string") {
    corrupt("Recovery manifest workspace tree OID is missing");
  }
  assertOid(value.workspaceTreeOid, "Recovery manifest workspace tree OID");
  if (value.workspaceTreeOid !== expectedWorkspaceTreeOid) {
    corrupt("Recovery manifest does not reference the control workspace tree");
  }
  return {
    version: MANIFEST_VERSION,
    storage: GIT_STORAGE_FORMAT,
    repositoryId: expectedRepositoryId,
    repositoryIdHash: value.repositoryIdHash,
    workspaceTreeOid: value.workspaceTreeOid,
    snapshot: validateSnapshot(value.snapshot, maxEntries, maxBlobBytes, maxTotalBytes),
  };
}

function makeTreeNode(): TreeNode {
  return { directories: new Map(), files: new Map() };
}

function buildExpectedTree(entries: readonly GitRecoveryManifestEntry[]): TreeNode {
  const root = makeTreeNode();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const name = segments.pop();
    if (name === undefined) corrupt("Recovery snapshot contains an empty path");
    let parent = root;
    for (const segment of segments) {
      const child = parent.directories.get(segment);
      if (!child) corrupt(`Recovery snapshot is missing directory ancestor ${segment}`);
      parent = child;
    }
    if (parent.directories.has(name) || parent.files.has(name)) {
      corrupt(`Recovery snapshot path conflicts with another entry: ${entry.path}`);
    }
    if (entry.kind === "directory") {
      parent.directories.set(name, makeTreeNode());
    } else {
      parent.files.set(name, entry);
    }
  }
  return root;
}

function treeInputEntry(mode: string, type: "blob" | "tree", oid: string, name: string): Buffer {
  assertOid(oid, `Tree OID for ${name}`);
  return Buffer.concat([
    Buffer.from(`${mode} ${type} ${oid}\t`, "ascii"),
    Buffer.from(name, "utf8"),
    Buffer.from([0]),
  ]);
}

function parseTree(bytes: Buffer): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = [];
  let offset = 0;
  let previousEntry: ParsedTreeEntry | null = null;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 33 > bytes.length) {
      corrupt("Git tree object has a truncated entry");
    }
    const mode = bytes.subarray(offset, space).toString("ascii");
    if (mode !== "100644" && mode !== "100755" && mode !== "40000") {
      corrupt(`Git tree object contains unsupported mode ${mode}`);
    }
    const nameBytes = bytes.subarray(space + 1, nul);
    const name = nameBytes.toString("utf8");
    if (
      Buffer.from(name, "utf8").compare(nameBytes) !== 0 ||
      name.length === 0 ||
      name === "." ||
      name === ".." ||
      name.includes("/")
    ) {
      corrupt("Git tree object contains an unsafe name");
    }
    const oid = bytes.subarray(nul + 1, nul + 33).toString("hex");
    assertOid(oid, `Git tree OID for ${name}`);
    const parsed: ParsedTreeEntry = { name, mode, oid };
    if (
      previousEntry !== null &&
      compareTreeNames(
        { name: previousEntry.name, isTree: previousEntry.mode === "40000" },
        { name: parsed.name, isTree: parsed.mode === "40000" },
      ) >= 0
    ) {
      corrupt("Git tree object is not strictly byte-sorted");
    }
    previousEntry = parsed;
    entries.push(parsed);
    offset = nul + 33;
  }
  return entries;
}

function parseCommit(bytes: Buffer): { treeOid: string; metadata: CommitMetadata } {
  const separator = bytes.indexOf(Buffer.from("\n\n", "ascii"));
  if (separator < 0) corrupt("Git recovery commit has no message separator");
  const headers = bytes.subarray(0, separator).toString("utf8").split("\n");
  const treeHeaders = headers.filter((header) => header.startsWith("tree "));
  if (treeHeaders.length !== 1) corrupt("Git recovery commit must reference exactly one tree");
  const treeOid = treeHeaders[0]?.slice(5) ?? "";
  assertOid(treeOid, "Git recovery commit tree OID");
  const message = bytes.subarray(separator + 2).toString("utf8").trimEnd();
  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch (error) {
    corrupt("Git recovery commit metadata is not valid JSON", { cause: error });
  }
  if (!isRecord(candidate)) corrupt("Git recovery commit metadata must be an object");
  assertExactKeys(
    candidate,
    ["format", "repositoryIdHash", "rootHash", "manifestBlobOid", "workspaceTreeOid"],
    "commit metadata",
  );
  if (candidate.format !== COMMIT_FORMAT) corrupt("Unsupported Git recovery commit format");
  for (const [key, label] of [
    ["repositoryIdHash", "repository identity hash"],
    ["rootHash", "logical root hash"],
    ["manifestBlobOid", "manifest blob OID"],
    ["workspaceTreeOid", "workspace tree OID"],
  ] as const) {
    const value = candidate[key];
    if (typeof value !== "string") corrupt(`Git recovery commit ${label} is missing`);
    assertOid(value, `Git recovery commit ${label}`);
  }
  const metadata: CommitMetadata = {
    format: COMMIT_FORMAT,
    repositoryIdHash: candidate.repositoryIdHash as string,
    rootHash: candidate.rootHash as string,
    manifestBlobOid: candidate.manifestBlobOid as string,
    workspaceTreeOid: candidate.workspaceTreeOid as string,
  };
  if (message !== JSON.stringify(metadata)) {
    corrupt("Git recovery commit metadata is not in canonical form");
  }
  return { treeOid, metadata };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function statIdentity(value: BigIntStats): string {
  return [
    value.dev,
    value.ino,
    value.mode,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
    value.birthtimeNs,
  ].join(":");
}

function directoryIdentity(value: BigIntStats): string {
  return [value.dev, value.ino, value.mode, value.birthtimeNs].join(":");
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDirectRealChild(parent: string, candidate: string, name: string): void {
  const relative = path.relative(parent, candidate);
  if (relative !== name || path.isAbsolute(relative) || relative.includes(path.sep + "..")) {
    corrupt(`Git recovery path escapes its expected parent: ${candidate}`);
  }
}

function parseNulList(bytes: Buffer, label: string): string[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) {
    corrupt(`${label} is not NUL terminated`);
  }
  const values: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < offset) corrupt(`${label} is truncated`);
    const raw = bytes.subarray(offset, end);
    const value = raw.toString("utf8");
    if (
      value.length === 0 ||
      value.includes("\0") ||
      !Buffer.from(value, "utf8").equals(raw)
    ) {
      corrupt(`${label} contains an invalid value`);
    }
    values.push(value);
    offset = end + 1;
  }
  return values;
}

function assertAllowedLocalConfigKeys(keys: readonly string[]): void {
  for (const original of keys) {
    const key = original.toLowerCase();
    if (
      key === "include.path" ||
      key.startsWith("includeif.") ||
      key === "extensions.partialclone" ||
      key === "extensions.worktreeconfig" ||
      key === "core.worktree" ||
      /^remote\..+\.promisor$/.test(key)
    ) {
      corrupt(`Git recovery repository contains forbidden local config: ${original}`);
    }
  }
}

export class GitRecoveryRepository {
  private readonly repositoriesRoot: string;
  private readonly disabledHooksPath: string;
  private readonly options: ResolvedOptions;
  private readonly pendingInitializations = new Map<string, Promise<string>>();
  private readonly verifiedRepositories = new Map<string, VerifiedRepository>();

  constructor(
    recoveryRoot: string,
    private readonly git: GitRecoveryGitClient,
    options: GitRecoveryRepositoryOptions = {},
  ) {
    this.repositoriesRoot = path.resolve(recoveryRoot, "repositories");
    this.disabledHooksPath = path.resolve(recoveryRoot, "disabled-git-hooks");
    this.options = {
      maxManifestBytes: validateLimit(
        options.maxManifestBytes,
        defaultOptions.maxManifestBytes,
        "maxManifestBytes",
      ),
      maxManifestEntries: validateLimit(
        options.maxManifestEntries,
        defaultOptions.maxManifestEntries,
        "maxManifestEntries",
      ),
      maxBlobBytes: validateLimit(options.maxBlobBytes, defaultOptions.maxBlobBytes, "maxBlobBytes"),
      maxTotalBytes: validateLimit(
        options.maxTotalBytes,
        defaultOptions.maxTotalBytes,
        "maxTotalBytes",
      ),
    };
  }

  repositoryPath(repositoryId: string): string {
    return path.join(this.repositoriesRoot, gitRecoveryRepositoryDirectoryName(repositoryId));
  }

  async probe(): Promise<void> {
    await this.prepareControlDirectories();
    await this.git.assertCapabilities(this.repositoriesRoot);
  }

  async initialize(repositoryId: string): Promise<string> {
    validateGitRecoveryRepositoryId(repositoryId);
    const existing = this.pendingInitializations.get(repositoryId);
    if (existing) return existing;
    const initialization = this.initializeRepository(repositoryId);
    this.pendingInitializations.set(repositoryId, initialization);
    try {
      return await initialization;
    } finally {
      if (this.pendingInitializations.get(repositoryId) === initialization) {
        this.pendingInitializations.delete(repositoryId);
      }
    }
  }

  async writeBlob(repositoryId: string, bytes: Buffer): Promise<string> {
    if (bytes.length > this.options.maxBlobBytes) {
      corrupt("Git recovery blob exceeds the configured size limit");
    }
    const repositoryPath = await this.initialize(repositoryId);
    const result = await this.git.run(
      this.repositoryCommand(
        repositoryPath,
        "hash-object",
        "-w",
        "--no-filters",
        "--stdin",
      ),
      { input: bytes },
    );
    const oid = parseOidOutput(result.stdout, "Written Git blob OID");
    const expected = gitObjectOid("blob", bytes);
    if (oid !== expected) corrupt("Git returned an incorrect SHA-256 blob OID");
    return oid;
  }

  async readBlob(repositoryId: string, oid: string): Promise<Buffer> {
    const repositoryPath = await this.initialize(repositoryId);
    return this.readVerifiedObject(repositoryPath, "blob", oid, this.options.maxBlobBytes);
  }

  async capture(
    repositoryId: string,
    snapshotValue: GitRecoverySnapshot,
    refName: string,
  ): Promise<GitRecoveryCheckpoint> {
    validateGitRecoveryRepositoryId(repositoryId);
    validateGitRecoveryRef(refName);
    const repositoryPath = await this.initialize(repositoryId);
    const snapshot = validateSnapshot(
      snapshotValue,
      this.options.maxManifestEntries,
      this.options.maxBlobBytes,
      this.options.maxTotalBytes,
    );
    const expectedTree = buildExpectedTree(snapshot.entries);

    await this.verifyManifestBlobs(repositoryPath, snapshot.entries);
    const workspaceTreeOid = await this.writeTree(repositoryPath, expectedTree);
    await this.verifyTree(repositoryPath, workspaceTreeOid, expectedTree, "");

    const manifest: GitRecoveryManifest = {
      version: MANIFEST_VERSION,
      storage: GIT_STORAGE_FORMAT,
      repositoryId,
      repositoryIdHash: repositoryIdHash(repositoryId),
      workspaceTreeOid,
      snapshot,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (manifestBytes.length > this.options.maxManifestBytes) {
      corrupt("Git recovery manifest exceeds the configured size limit");
    }
    const manifestBlobOid = await this.writeBlob(repositoryId, manifestBytes);
    const controlTreeOid = await this.writeFlatTree(repositoryPath, [
      { name: "manifest.json", mode: "100644", type: "blob", oid: manifestBlobOid },
      { name: "workspace", mode: "040000", type: "tree", oid: workspaceTreeOid },
    ]);

    const metadata: CommitMetadata = {
      format: COMMIT_FORMAT,
      repositoryIdHash: manifest.repositoryIdHash,
      rootHash: snapshot.rootHash,
      manifestBlobOid,
      workspaceTreeOid,
    };
    const commit = await this.git.run(this.repositoryCommand(
      repositoryPath,
      "-c",
      "user.name=Launchpad Recovery",
      "-c",
      "user.email=recovery@launchpad.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      controlTreeOid,
      "-m",
      JSON.stringify(metadata),
    ));
    const commitOid = parseOidOutput(commit.stdout, "Git recovery commit OID");
    await this.readVerifiedObject(repositoryPath, "commit", commitOid, 1024 * 1024);
    await this.updateRef(repositoryId, refName, commitOid);

    return {
      storage: GIT_STORAGE_FORMAT,
      repositoryId,
      repositoryPath,
      rootHash: snapshot.rootHash,
      commitOid,
      controlTreeOid,
      workspaceTreeOid,
      manifestBlobOid,
      refName,
    };
  }

  async load(repositoryId: string, commitOidValue: string): Promise<LoadedGitRecoveryCheckpoint> {
    validateGitRecoveryRepositoryId(repositoryId);
    const commitOid = assertOid(commitOidValue, "Git recovery commit OID");
    const repositoryPath = await this.initialize(repositoryId);
    const commitBytes = await this.readVerifiedObject(
      repositoryPath,
      "commit",
      commitOid,
      1024 * 1024,
    );
    const { treeOid: controlTreeOid, metadata } = parseCommit(commitBytes);
    if (metadata.repositoryIdHash !== repositoryIdHash(repositoryId)) {
      corrupt("Git recovery commit belongs to a different repository");
    }

    const controlBytes = await this.readVerifiedObject(
      repositoryPath,
      "tree",
      controlTreeOid,
      this.options.maxManifestBytes,
    );
    const controlEntries = parseTree(controlBytes);
    if (
      controlEntries.length !== 2 ||
      controlEntries[0]?.name !== "manifest.json" ||
      controlEntries[0].mode !== "100644" ||
      controlEntries[1]?.name !== "workspace" ||
      controlEntries[1].mode !== "40000"
    ) {
      corrupt("Git recovery control tree does not have the expected shape");
    }
    const manifestBlobOid = controlEntries[0].oid;
    const workspaceTreeOid = controlEntries[1].oid;
    if (
      metadata.manifestBlobOid !== manifestBlobOid ||
      metadata.workspaceTreeOid !== workspaceTreeOid
    ) {
      corrupt("Git recovery commit metadata does not match its control tree");
    }

    const manifestBytes = await this.readVerifiedObject(
      repositoryPath,
      "blob",
      manifestBlobOid,
      this.options.maxManifestBytes,
    );
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(manifestBytes.toString("utf8"));
    } catch (error) {
      corrupt("Git recovery manifest is not valid JSON", { cause: error });
    }
    const manifest = validateManifest(
      manifestValue,
      repositoryId,
      workspaceTreeOid,
      this.options.maxManifestEntries,
      this.options.maxBlobBytes,
      this.options.maxTotalBytes,
    );
    const canonicalManifest = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (!manifestBytes.equals(canonicalManifest)) {
      corrupt("Git recovery manifest is not in canonical form");
    }
    if (metadata.rootHash !== manifest.snapshot.rootHash) {
      corrupt("Git recovery commit logical root hash does not match its manifest");
    }
    const expectedTree = buildExpectedTree(manifest.snapshot.entries);
    await this.verifyTree(repositoryPath, workspaceTreeOid, expectedTree, "");

    return {
      storage: GIT_STORAGE_FORMAT,
      repositoryId,
      repositoryPath,
      rootHash: manifest.snapshot.rootHash,
      commitOid,
      controlTreeOid,
      workspaceTreeOid,
      manifestBlobOid,
      refName: null,
      manifest,
      snapshot: manifest.snapshot,
    };
  }

  async updateRef(
    repositoryId: string,
    refNameValue: string,
    commitOidValue: string,
    expectedOldOid?: string,
  ): Promise<void> {
    const refName = validateGitRecoveryRef(refNameValue);
    const commitOid = assertOid(commitOidValue, "Git recovery commit OID");
    if (expectedOldOid !== undefined) assertOid(expectedOldOid, "Expected Git recovery commit OID");
    const repositoryPath = await this.initialize(repositoryId);
    await this.readVerifiedObject(repositoryPath, "commit", commitOid, 1024 * 1024);
    const args = this.repositoryCommand(
      repositoryPath,
      "update-ref",
      "--no-deref",
      "-m",
      "launchpad recovery checkpoint",
      refName,
      commitOid,
    );
    if (expectedOldOid !== undefined) args.push(expectedOldOid);
    await this.git.run(args);
  }

  async resolveRef(repositoryId: string, refNameValue: string): Promise<string> {
    const refName = validateGitRecoveryRef(refNameValue);
    const repositoryPath = await this.initialize(repositoryId);
    const result = await this.git.run(this.repositoryCommand(
      repositoryPath,
      "rev-parse",
      "--verify",
      `${refName}^{commit}`,
    ));
    return parseOidOutput(result.stdout, "Resolved Git recovery commit OID");
  }

  private async initializeRepository(repositoryId: string): Promise<string> {
    const repositoryPath = this.repositoryPath(repositoryId);
    await this.prepareControlDirectories();
    let created = false;
    try {
      await lstat(repositoryPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.git.initializeBareSha256(repositoryPath);
      created = true;
    }
    await this.assertRepositoryLocation(repositoryPath);
    if (created) {
      await this.git.run(this.repositoryCommand(
        repositoryPath,
        "config",
        "--local",
        "launchpad.repositoryIdHash",
        repositoryIdHash(repositoryId),
      ));
    }
    await chmod(repositoryPath, 0o700);
    await this.validateRepository(repositoryId, repositoryPath);
    return repositoryPath;
  }

  private async validateRepository(
    repositoryId: string,
    repositoryPath: string,
  ): Promise<void> {
    const inspection = await this.inspectRepository(repositoryId, repositoryPath);
    if (this.verifiedRepositories.get(repositoryPath)?.fingerprint === inspection.fingerprint) {
      return;
    }

    await this.validateLocalConfig(repositoryId, repositoryPath, inspection.configPath);
    try {
      await this.git.assertBareSha256Repository(repositoryPath);
    } catch (error) {
      corrupt("Git recovery repository is not a bare SHA-256 repository", { cause: error });
    }

    const confirmation = await this.inspectRepository(repositoryId, repositoryPath);
    if (confirmation.fingerprint !== inspection.fingerprint) {
      corrupt("Git recovery repository changed while it was being validated");
    }
    this.verifiedRepositories.set(repositoryPath, {
      fingerprint: confirmation.fingerprint,
    });
  }

  private async inspectRepository(
    repositoryId: string,
    repositoryPath: string,
  ): Promise<{ fingerprint: string; configPath: string }> {
    const rootState = await lstat(this.repositoriesRoot, { bigint: true });
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
      corrupt("Git recovery repositories root is not a real directory");
    }
    const repositoriesReal = await realpath(this.repositoriesRoot);
    const repositoryState = await lstat(repositoryPath, { bigint: true });
    if (!repositoryState.isDirectory() || repositoryState.isSymbolicLink()) {
      corrupt("Git recovery repository path is not a real directory");
    }
    const repositoryReal = await realpath(repositoryPath);
    assertDirectRealChild(
      repositoriesReal,
      repositoryReal,
      gitRecoveryRepositoryDirectoryName(repositoryId),
    );

    await Promise.all([
      this.assertMissingMarker(path.join(repositoryPath, "commondir"), "commondir"),
      this.assertMissingMarker(path.join(repositoryPath, "shallow"), "shallow"),
    ]);

    const objectsPath = path.join(repositoryPath, "objects");
    const objectsState = await lstat(objectsPath, { bigint: true });
    if (!objectsState.isDirectory() || objectsState.isSymbolicLink()) {
      corrupt("Git recovery objects path is not a real directory");
    }
    const objectsReal = await realpath(objectsPath);
    assertDirectRealChild(repositoryReal, objectsReal, "objects");

    const refsPath = path.join(repositoryPath, "refs");
    const refsState = await lstat(refsPath, { bigint: true });
    if (!refsState.isDirectory() || refsState.isSymbolicLink()) {
      corrupt("Git recovery refs path is not a real directory");
    }
    const refsReal = await realpath(refsPath);
    assertDirectRealChild(repositoryReal, refsReal, "refs");

    const infoPath = path.join(objectsPath, "info");
    const infoReal = await this.assertOptionalRealDirectory(infoPath, objectsReal, "info");
    if (infoReal !== null) {
      await Promise.all([
        this.assertMissingMarker(path.join(infoPath, "alternates"), "objects/info/alternates"),
        this.assertMissingMarker(
          path.join(infoPath, "http-alternates"),
          "objects/info/http-alternates",
        ),
      ]);
    }

    const packPath = path.join(objectsPath, "pack");
    const packReal = await this.assertOptionalRealDirectory(packPath, objectsReal, "pack");
    if (packReal !== null) {
      const packEntries = await readdir(packPath, { withFileTypes: true });
      if (packEntries.some((entry) => entry.name.toLowerCase().endsWith(".promisor"))) {
        corrupt("Git recovery repository contains a promisor pack marker");
      }
    }

    const configPath = path.join(repositoryPath, "config");
    const config = await this.readStableConfig(configPath, repositoryReal);
    const fingerprint = sha256(Buffer.from([
      repositoryIdHash(repositoryId),
      repositoriesReal,
      directoryIdentity(rootState),
      repositoryReal,
      directoryIdentity(repositoryState),
      objectsReal,
      directoryIdentity(objectsState),
      refsReal,
      directoryIdentity(refsState),
      config.identity,
      config.hash,
    ].join("\0"), "utf8"));
    return { fingerprint, configPath };
  }

  private async validateLocalConfig(
    repositoryId: string,
    repositoryPath: string,
    configPath: string,
  ): Promise<void> {
    let keyResult: GitRecoveryGitResult;
    let identityResult: GitRecoveryGitResult;
    try {
      [keyResult, identityResult] = await Promise.all([
        this.git.run(
          this.repositoryCommand(
            repositoryPath,
            "config",
            "--file",
            configPath,
            "--no-includes",
            "--null",
            "--name-only",
            "--list",
          ),
          { maxOutputBytes: MAX_LOCAL_CONFIG_BYTES },
        ),
        this.git.run(
          this.repositoryCommand(
            repositoryPath,
            "config",
            "--file",
            configPath,
            "--no-includes",
            "--null",
            "--get-all",
            "launchpad.repositoryIdHash",
          ),
          { maxOutputBytes: 4_096 },
        ),
      ]);
    } catch (error) {
      corrupt("Unable to inspect Git recovery repository local config", { cause: error });
    }
    assertAllowedLocalConfigKeys(parseNulList(keyResult.stdout, "Git config key list"));
    const identities = parseNulList(identityResult.stdout, "Git repository identity list");
    if (
      identities.length !== 1 ||
      identities[0] !== repositoryIdHash(repositoryId)
    ) {
      corrupt("Git recovery repository identity does not match its Agent");
    }
  }

  private async assertRepositoryLocation(repositoryPath: string): Promise<void> {
    const repositoriesState = await lstat(this.repositoriesRoot);
    const repositoryState = await lstat(repositoryPath);
    if (
      !repositoriesState.isDirectory() ||
      repositoriesState.isSymbolicLink() ||
      !repositoryState.isDirectory() ||
      repositoryState.isSymbolicLink()
    ) {
      corrupt("Git recovery repository path is not a real directory");
    }
    const [repositoriesReal, repositoryReal] = await Promise.all([
      realpath(this.repositoriesRoot),
      realpath(repositoryPath),
    ]);
    assertDirectRealChild(repositoriesReal, repositoryReal, path.basename(repositoryPath));
  }

  private async assertMissingMarker(candidate: string, label: string): Promise<void> {
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    corrupt(`Git recovery repository contains forbidden ${label} metadata`);
  }

  private async assertOptionalRealDirectory(
    candidate: string,
    parentReal: string,
    name: string,
  ): Promise<string | null> {
    let state;
    try {
      state = await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      corrupt(`Git recovery ${name} path is not a real directory`);
    }
    const candidateReal = await realpath(candidate);
    assertDirectRealChild(parentReal, candidateReal, name);
    return candidateReal;
  }

  private async readStableConfig(configPath: string, repositoryReal: string): Promise<StableConfig> {
    const before = await lstat(configPath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_LOCAL_CONFIG_BYTES)
    ) {
      corrupt("Git recovery local config is not a safe regular file");
    }
    const configReal = await realpath(configPath);
    assertDirectRealChild(repositoryReal, configReal, "config");
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW;
    const handle = await open(configPath, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameStableFile(before, opened)) {
        corrupt("Git recovery local config changed before it was read");
      }
      const bytes = await handle.readFile();
      const afterRead = await handle.stat({ bigint: true });
      const pathAfter = await lstat(configPath, { bigint: true });
      if (
        bytes.length !== Number(afterRead.size) ||
        bytes.length > MAX_LOCAL_CONFIG_BYTES ||
        !sameStableFile(opened, afterRead) ||
        !sameStableFile(afterRead, pathAfter)
      ) {
        corrupt("Git recovery local config changed while it was read");
      }
      return {
        bytes,
        identity: statIdentity(afterRead),
        hash: sha256(bytes),
      };
    } finally {
      await handle.close();
    }
  }

  private async readVerifiedObject(
    repositoryPath: string,
    expectedType: GitObjectType,
    oidValue: string,
    maxOutputBytes: number,
  ): Promise<Buffer> {
    const oid = assertOid(oidValue, `Git ${expectedType} OID`);
    const typeResult = await this.git.run(
      this.repositoryCommand(repositoryPath, "cat-file", "-t", oid),
      { maxOutputBytes: 128 },
    );
    const actualType = typeResult.stdout.toString("ascii").trim();
    if (actualType !== expectedType) {
      corrupt(`Git object ${oid} is ${actualType || "unknown"}, expected ${expectedType}`);
    }
    const result = await this.git.run(
      this.repositoryCommand(repositoryPath, "cat-file", expectedType, oid),
      { maxOutputBytes },
    );
    if (gitObjectOid(expectedType, result.stdout) !== oid) {
      corrupt(`Git ${expectedType} object ${oid} failed SHA-256 verification`);
    }
    return result.stdout;
  }

  private async verifyManifestBlobs(
    repositoryPath: string,
    entries: readonly GitRecoveryManifestEntry[],
  ): Promise<void> {
    const verified = new Map<string, { size: number; blobHash: string }>();
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const previous = verified.get(entry.gitBlobOid);
      if (previous) {
        if (previous.size !== entry.size || previous.blobHash !== entry.blobHash) {
          corrupt(`Manifest entries disagree about shared Git blob ${entry.gitBlobOid}`);
        }
        continue;
      }
      const bytes = await this.readVerifiedObject(
        repositoryPath,
        "blob",
        entry.gitBlobOid,
        this.options.maxBlobBytes,
      );
      if (bytes.length !== entry.size || sha256(bytes) !== entry.blobHash) {
        corrupt(`Git blob content does not match manifest entry ${entry.path}`);
      }
      verified.set(entry.gitBlobOid, { size: entry.size, blobHash: entry.blobHash });
    }
  }

  private async writeTree(repositoryPath: string, node: TreeNode): Promise<string> {
    const entries: Array<{
      name: string;
      mode: "100644" | "100755" | "040000";
      type: "blob" | "tree";
      oid: string;
    }> = [];
    for (const [name, directory] of node.directories) {
      entries.push({
        name,
        mode: "040000",
        type: "tree",
        oid: await this.writeTree(repositoryPath, directory),
      });
    }
    for (const [name, file] of node.files) {
      entries.push({
        name,
        mode: (file.mode & 0o111) === 0 ? "100644" : "100755",
        type: "blob",
        oid: file.gitBlobOid,
      });
    }
    return this.writeFlatTree(repositoryPath, entries);
  }

  private async writeFlatTree(
    repositoryPath: string,
    entries: ReadonlyArray<{
      name: string;
      mode: "100644" | "100755" | "040000";
      type: "blob" | "tree";
      oid: string;
    }>,
  ): Promise<string> {
    const ordered = [...entries].sort((left, right) =>
      compareTreeNames(
        { name: left.name, isTree: left.type === "tree" },
        { name: right.name, isTree: right.type === "tree" },
      ),
    );
    const input = Buffer.concat(
      ordered.map((entry) => treeInputEntry(entry.mode, entry.type, entry.oid, entry.name)),
    );
    const result = await this.git.run(
      this.repositoryCommand(repositoryPath, "mktree", "-z"),
      { input },
    );
    return parseOidOutput(result.stdout, "Written Git tree OID");
  }

  private async verifyTree(
    repositoryPath: string,
    treeOid: string,
    expected: TreeNode,
    prefix: string,
  ): Promise<void> {
    const raw = await this.readVerifiedObject(
      repositoryPath,
      "tree",
      treeOid,
      this.options.maxManifestBytes,
    );
    const actual = parseTree(raw);
    const expectedNames = [
      ...[...expected.directories.keys()].map((name) => ({ name, isTree: true })),
      ...[...expected.files.keys()].map((name) => ({ name, isTree: false })),
    ].sort(compareTreeNames);
    if (
      actual.length !== expectedNames.length ||
      actual.some((entry, index) => entry.name !== expectedNames[index]?.name)
    ) {
      corrupt(`Git workspace tree entries do not match the manifest at ${prefix || "/"}`);
    }

    for (const entry of actual) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const directory = expected.directories.get(entry.name);
      if (directory) {
        if (entry.mode !== "40000") {
          corrupt(`Git workspace entry is not a directory: ${relativePath}`);
        }
        await this.verifyTree(repositoryPath, entry.oid, directory, relativePath);
        continue;
      }
      const file = expected.files.get(entry.name);
      if (!file) corrupt(`Git workspace tree contains an unexpected entry: ${relativePath}`);
      const expectedMode = (file.mode & 0o111) === 0 ? "100644" : "100755";
      if (entry.mode !== expectedMode || entry.oid !== file.gitBlobOid) {
        corrupt(`Git workspace file metadata does not match the manifest: ${relativePath}`);
      }
    }
    await this.verifyManifestBlobs(
      repositoryPath,
      [...expected.files.values()],
    );
  }

  private repositoryCommand(repositoryPath: string, ...args: string[]): string[] {
    return [
      "--git-dir",
      repositoryPath,
      "--no-replace-objects",
      "-c",
      `core.hooksPath=${this.disabledHooksPath.replace(/\\/g, "/")}`,
      ...args,
    ];
  }

  private async prepareControlDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.repositoriesRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.disabledHooksPath, { recursive: true, mode: 0o700 }),
    ]);
    const [repositoriesState, hooksState] = await Promise.all([
      lstat(this.repositoriesRoot),
      lstat(this.disabledHooksPath),
    ]);
    if (!repositoriesState.isDirectory() || repositoriesState.isSymbolicLink()) {
      corrupt("Git recovery repositories root is not a real directory");
    }
    if (!hooksState.isDirectory() || hooksState.isSymbolicLink()) {
      corrupt("Disabled Git hooks path is not a real directory");
    }
    await Promise.all([
      chmod(this.repositoriesRoot, 0o700),
      chmod(this.disabledHooksPath, 0o700),
    ]);
    if ((await readdir(this.disabledHooksPath)).length !== 0) {
      corrupt("Disabled Git hooks directory must remain empty");
    }
  }
}

export const GIT_RECOVERY_STORAGE_FORMAT = GIT_STORAGE_FORMAT;

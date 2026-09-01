import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitRecoveryRef,
  GitRecoveryRepository,
  GitRecoveryRepositoryError,
  gitRecoveryRepositoryDirectoryName,
  type GitRecoveryGitClient,
  type GitRecoverySnapshot,
} from "./git-recovery-repository.js";

interface FakeObject {
  type: "blob" | "tree" | "commit";
  bytes: Buffer;
}

interface FakeCall {
  args: string[];
  input?: Buffer | string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function objectOid(type: FakeObject["type"], bytes: Buffer): string {
  return createHash("sha256")
    .update(Buffer.from(`${type} ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function rawHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseFakeConfig(config: string): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  let section = "";
  for (const line of config.split(/\r?\n/)) {
    const sectionMatch = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]\s*$/.exec(line);
    if (sectionMatch) {
      section = `${sectionMatch[1] ?? ""}${
        sectionMatch[2] === undefined ? "" : `.${sectionMatch[2]}`
      }`;
      continue;
    }
    const valueMatch = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (valueMatch && section) {
      entries.push({
        key: `${section}.${valueMatch[1] ?? ""}`,
        value: valueMatch[2] ?? "",
      });
    }
  }
  return entries;
}

function snapshotRootHash(snapshot: Pick<GitRecoverySnapshot, "policyId" | "entries">): string {
  const hash = createHash("sha256");
  hash.update("workspace-recovery\0");
  hash.update("1\0");
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

class FakeGitClient implements GitRecoveryGitClient {
  readonly calls: FakeCall[] = [];
  readonly repositories = new Map<string, Map<string, FakeObject>>();
  readonly refs = new Map<string, Map<string, string>>();
  capabilityChecks = 0;
  repositoryChecks = 0;
  repositoryInitializations = 0;

  async assertCapabilities(): Promise<void> {
    this.capabilityChecks += 1;
  }

  async initializeBareSha256(repositoryPath: string): Promise<void> {
    this.repositoryInitializations += 1;
    await Promise.all([
      mkdir(path.join(repositoryPath, "objects", "info"), { recursive: true }),
      mkdir(path.join(repositoryPath, "objects", "pack"), { recursive: true }),
      mkdir(path.join(repositoryPath, "refs"), { recursive: true }),
    ]);
    await writeFile(
      path.join(repositoryPath, "config"),
      "[core]\n\trepositoryformatversion = 1\n\tbare = true\n" +
        "[extensions]\n\tobjectformat = sha256\n",
      "utf8",
    );
    this.repositories.set(repositoryPath, new Map());
    this.refs.set(repositoryPath, new Map());
  }

  async assertBareSha256Repository(repositoryPath: string): Promise<void> {
    this.repositoryChecks += 1;
    if (!this.repositories.has(repositoryPath)) throw new Error("not a fake repository");
  }

  async run(
    argsValue: readonly string[],
    options: { input?: Buffer | string; maxOutputBytes?: number } = {},
  ): Promise<{ stdout: Buffer; stderr: Buffer }> {
    const args = [...argsValue];
    this.calls.push({
      args,
      ...(options.input === undefined
        ? {}
        : { input: Buffer.isBuffer(options.input) ? Buffer.from(options.input) : options.input }),
    });
    if (args[0] !== "--git-dir" || typeof args[1] !== "string") {
      throw new Error(`unexpected fake Git arguments: ${args.join(" ")}`);
    }
    const repositoryPath = args[1];
    const objects = this.repositories.get(repositoryPath);
    const refs = this.refs.get(repositoryPath);
    if (!objects || !refs) throw new Error("unknown fake repository");

    let commandIndex = 2;
    if (args[commandIndex] === "--no-replace-objects") commandIndex += 1;
    while (args[commandIndex] === "-c") commandIndex += 2;
    const command = args[commandIndex];
    const commandArgs = args.slice(commandIndex + 1);
    const output = (stdout: Buffer | string) => ({
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
      stderr: Buffer.alloc(0),
    });

    if (command === "hash-object") {
      expect(commandArgs).toEqual(["-w", "--no-filters", "--stdin"]);
      const bytes = Buffer.isBuffer(options.input)
        ? Buffer.from(options.input)
        : Buffer.from(options.input ?? "", "utf8");
      const oid = this.putObject(repositoryPath, "blob", bytes);
      return output(`${oid}\n`);
    }

    if (command === "config") {
      if (commandArgs[0] === "--local") {
        const key = commandArgs[1];
        const value = commandArgs[2];
        if (key !== "launchpad.repositoryIdHash" || typeof value !== "string") {
          throw new Error("unexpected fake config write");
        }
        await writeFile(
          path.join(repositoryPath, "config"),
          `[launchpad]\n\trepositoryIdHash = ${value}\n`,
          { encoding: "utf8", flag: "a" },
        );
        return output("");
      }
      const configPath = commandArgs[commandArgs.indexOf("--file") + 1] as string;
      const config = await readFile(configPath, "utf8");
      const parsed = parseFakeConfig(config);
      if (commandArgs.includes("--name-only")) {
        return output(Buffer.from(`${parsed.map((entry) => entry.key).join("\0")}\0`, "utf8"));
      }
      if (commandArgs.includes("--get-all")) {
        const key = commandArgs.at(-1)?.toLowerCase();
        const values = parsed
          .filter((entry) => entry.key.toLowerCase() === key)
          .map((entry) => entry.value);
        return output(Buffer.from(`${values.join("\0")}\0`, "utf8"));
      }
      throw new Error("unexpected fake config query");
    }

    if (command === "mktree") {
      expect(commandArgs).toEqual(["-z"]);
      const input = Buffer.isBuffer(options.input)
        ? options.input
        : Buffer.from(options.input ?? "", "utf8");
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < input.length) {
        const nul = input.indexOf(0, offset);
        if (nul < 0) throw new Error("invalid fake mktree input");
        const record = input.subarray(offset, nul);
        const tab = record.indexOf(0x09);
        const header = record.subarray(0, tab).toString("ascii");
        const name = record.subarray(tab + 1);
        const match = /^(100644|100755|040000) (blob|tree) ([a-f0-9]{64})$/.exec(header);
        if (!match) throw new Error(`invalid fake mktree record: ${header}`);
        const mode = match[1] === "040000" ? "40000" : match[1];
        const type = match[2] as "blob" | "tree";
        const oid = match[3] as string;
        if (objects.get(oid)?.type !== type) throw new Error("fake mktree object type mismatch");
        chunks.push(Buffer.from(`${mode} `, "ascii"), name, Buffer.from([0]), Buffer.from(oid, "hex"));
        offset = nul + 1;
      }
      const oid = this.putObject(repositoryPath, "tree", Buffer.concat(chunks));
      return output(`${oid}\n`);
    }

    if (command === "commit-tree") {
      const treeOid = commandArgs[0] as string;
      const messageIndex = commandArgs.indexOf("-m");
      const message = commandArgs[messageIndex + 1];
      if (objects.get(treeOid)?.type !== "tree" || typeof message !== "string") {
        throw new Error("invalid fake commit-tree input");
      }
      const bytes = Buffer.from(
        `tree ${treeOid}\nauthor Launchpad Recovery <recovery@launchpad.invalid> 0 +0000\n` +
          `committer Launchpad Recovery <recovery@launchpad.invalid> 0 +0000\n\n${message}\n`,
        "utf8",
      );
      const oid = this.putObject(repositoryPath, "commit", bytes);
      return output(`${oid}\n`);
    }

    if (command === "cat-file") {
      if (commandArgs[0] === "-t") {
        const object = objects.get(commandArgs[1] as string);
        if (!object) throw new Error("missing fake object");
        return output(`${object.type}\n`);
      }
      const expectedType = commandArgs[0];
      const object = objects.get(commandArgs[1] as string);
      if (!object || object.type !== expectedType) throw new Error("missing or mistyped fake object");
      return output(Buffer.from(object.bytes));
    }

    if (command === "update-ref") {
      const refIndex = commandArgs.indexOf("launchpad recovery checkpoint") + 1;
      const refName = commandArgs[refIndex] as string;
      const newOid = commandArgs[refIndex + 1] as string;
      const expectedOldOid = commandArgs[refIndex + 2];
      if (expectedOldOid !== undefined && refs.get(refName) !== expectedOldOid) {
        throw new Error("fake update-ref compare-and-swap failed");
      }
      refs.set(refName, newOid);
      return output("");
    }

    if (command === "rev-parse") {
      const expression = commandArgs[1] as string;
      const refName = expression.replace(/\^\{commit\}$/, "");
      const oid = refs.get(refName);
      if (!oid) throw new Error("missing fake ref");
      return output(`${oid}\n`);
    }

    throw new Error(`unsupported fake Git command: ${String(command)}`);
  }

  putObject(repositoryPath: string, type: FakeObject["type"], bytes: Buffer): string {
    const oid = objectOid(type, bytes);
    const objects = this.repositories.get(repositoryPath);
    if (!objects) throw new Error("unknown fake repository");
    objects.set(oid, { type, bytes: Buffer.from(bytes) });
    return oid;
  }

  corruptObject(repositoryPath: string, oid: string, bytes: Buffer): void {
    const object = this.repositories.get(repositoryPath)?.get(oid);
    if (!object) throw new Error("missing fake object");
    object.bytes = Buffer.from(bytes);
  }
}

async function fixture(): Promise<{ root: string; repository: GitRecoveryRepository; git: FakeGitClient }> {
  const root = await mkdtemp(path.join(tmpdir(), "git-recovery-repository-"));
  temporaryDirectories.push(root);
  const git = new FakeGitClient();
  return { root, repository: new GitRecoveryRepository(root, git), git };
}

async function exampleSnapshot(
  repository: GitRecoveryRepository,
  repositoryId: string,
): Promise<{ snapshot: GitRecoverySnapshot; binaryOid: string }> {
  const binary = Buffer.from([0, 255, 13, 10, 42, 128, 7]);
  const executable = Buffer.from("#!/bin/sh\necho ok\n", "utf8");
  const binaryOid = await repository.writeBlob(repositoryId, binary);
  const executableOid = await repository.writeBlob(repositoryId, executable);
  const snapshot: GitRecoverySnapshot = {
    version: 1,
    policyId: "complete-workspace-v1",
    rootHash: "0".repeat(64),
    entries: [
      { path: "empty", kind: "directory", mode: 0o700 },
      { path: "foo", kind: "directory", mode: 0o755 },
      {
        path: "foo.bar",
        kind: "file",
        mode: 0o640,
        size: binary.length,
        blobHash: rawHash(binary),
        gitBlobOid: binaryOid,
      },
      {
        path: "foo/run.sh",
        kind: "file",
        mode: 0o755,
        size: executable.length,
        blobHash: rawHash(executable),
        gitBlobOid: executableOid,
      },
    ],
    fileCount: 2,
    totalBytes: binary.length + executable.length,
  };
  snapshot.rootHash = snapshotRootHash(snapshot);
  return { snapshot, binaryOid };
}

describe("GitRecoveryRepository", () => {
  it("stores and reloads a self-verifying SHA-256 Git object graph", async () => {
    const { root, repository, git } = await fixture();
    const repositoryId = "agent-123";
    const { snapshot, binaryOid } = await exampleSnapshot(repository, repositoryId);
    const refName = createGitRecoveryRef("runs", "run-123:after");

    const checkpoint = await repository.capture(repositoryId, snapshot, refName);
    const loaded = await repository.load(repositoryId, checkpoint.commitOid);

    expect(checkpoint).toMatchObject({
      storage: "git-sha256-v1",
      repositoryId,
      rootHash: snapshot.rootHash,
      refName,
    });
    expect(checkpoint.commitOid).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.controlTreeOid).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.workspaceTreeOid).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.manifestBlobOid).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.snapshot).toEqual(snapshot);
    expect(loaded.manifest).toMatchObject({
      repositoryId,
      repositoryIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      workspaceTreeOid: checkpoint.workspaceTreeOid,
    });
    expect(await repository.resolveRef(repositoryId, refName)).toBe(checkpoint.commitOid);
    expect(await repository.readBlob(repositoryId, binaryOid)).toEqual(
      Buffer.from([0, 255, 13, 10, 42, 128, 7]),
    );

    const expectedRepositoryPath = path.join(
      root,
      "repositories",
      gitRecoveryRepositoryDirectoryName(repositoryId),
    );
    expect(checkpoint.repositoryPath).toBe(expectedRepositoryPath);
    expect(path.basename(expectedRepositoryPath)).toMatch(/^[a-f0-9]{64}\.git$/);
    expect(path.basename(expectedRepositoryPath)).not.toContain(repositoryId);

    const commandNames = git.calls.map((call) =>
      call.args.find((argument) =>
        ["hash-object", "cat-file", "mktree", "commit-tree", "update-ref", "rev-parse"].includes(
          argument,
        ),
      ),
    );
    expect(commandNames).toContain("hash-object");
    expect(commandNames).toContain("mktree");
    expect(commandNames).toContain("commit-tree");
    expect(commandNames).toContain("update-ref");
    const hashCalls = git.calls.filter((call) => call.args.includes("hash-object"));
    expect(hashCalls.every((call) => call.args.includes("--no-filters"))).toBe(true);
    expect(git.calls.every((call) => call.args.includes("--no-replace-objects"))).toBe(true);
    expect(
      git.calls.every((call) =>
        call.args.some((argument) => argument.startsWith("core.hooksPath=")),
      ),
    ).toBe(true);
    expect(
      git.calls
        .find((call) => call.args.includes("commit-tree"))
        ?.args.includes("commit.gpgSign=false"),
    ).toBe(true);
    expect(
      git.calls.some((call) => {
        let commandIndex = 2;
        if (call.args[commandIndex] === "--no-replace-objects") commandIndex += 1;
        while (call.args[commandIndex] === "-c") commandIndex += 2;
        return ["checkout", "reset", "read-tree", "write-tree", "add", "commit"].includes(
          call.args[commandIndex] ?? "",
        );
      }),
    ).toBe(false);
  });

  it("uses Git tree ordering for a directory name next to a dotted file", async () => {
    const { repository, git } = await fixture();
    const { snapshot } = await exampleSnapshot(repository, "agent-tree-order");
    const checkpoint = await repository.capture(
      "agent-tree-order",
      snapshot,
      createGitRecoveryRef("tests", "tree-order"),
    );
    await expect(repository.load("agent-tree-order", checkpoint.commitOid)).resolves.toMatchObject({
      rootHash: snapshot.rootHash,
    });

    const rootTreeCall = git.calls
      .filter((call) => call.args.includes("mktree"))
      .find((call) => Buffer.isBuffer(call.input) && call.input.includes(Buffer.from("foo.bar")));
    expect(rootTreeCall?.input).toBeInstanceOf(Buffer);
    const rootTreeInput = rootTreeCall?.input as Buffer;
    expect(rootTreeInput.indexOf(Buffer.from("foo.bar"))).toBeLessThan(
      rootTreeInput.indexOf(Buffer.from("foo\0")),
    );
  });

  it("keeps repositories isolated and initializes each as an external bare repository", async () => {
    const { repository, git } = await fixture();
    const first = await exampleSnapshot(repository, "agent-one");
    const second = await exampleSnapshot(repository, "agent-two");
    const firstCheckpoint = await repository.capture(
      "agent-one",
      first.snapshot,
      createGitRecoveryRef("tests", "agent-one"),
    );
    const secondCheckpoint = await repository.capture(
      "agent-two",
      second.snapshot,
      createGitRecoveryRef("tests", "agent-two"),
    );

    expect(firstCheckpoint.repositoryPath).not.toBe(secondCheckpoint.repositoryPath);
    await expect(repository.load("agent-one", secondCheckpoint.commitOid)).rejects.toThrow();
    expect(git.repositories.size).toBe(2);
    expect(git.repositoryChecks).toBe(2);
  });

  it("detects corrupted Git object bytes instead of restoring them", async () => {
    const { repository, git } = await fixture();
    const repositoryId = "agent-corrupt";
    const { snapshot, binaryOid } = await exampleSnapshot(repository, repositoryId);
    const checkpoint = await repository.capture(
      repositoryId,
      snapshot,
      createGitRecoveryRef("tests", "corrupt"),
    );
    git.corruptObject(checkpoint.repositoryPath, binaryOid, Buffer.from("tampered", "utf8"));

    await expect(repository.load(repositoryId, checkpoint.commitOid)).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });
  });

  it("rejects unsafe repository IDs, refs, paths, ordering, and logical hashes", async () => {
    const { repository } = await fixture();
    expect(() => repository.repositoryPath("../escape")).toThrowError(GitRecoveryRepositoryError);
    expect(() => createGitRecoveryRef("bad..scope", "id")).toThrowError(
      GitRecoveryRepositoryError,
    );

    const { snapshot } = await exampleSnapshot(repository, "agent-invalid");
    await expect(
      repository.capture("agent-invalid", snapshot, "refs/heads/main"),
    ).rejects.toMatchObject({ code: "GIT_RECOVERY_INVALID_REFERENCE" });

    const badPath: GitRecoverySnapshot = {
      ...snapshot,
      entries: [
        {
          ...(snapshot.entries.find((entry) => entry.kind === "file") as Extract<
            GitRecoverySnapshot["entries"][number],
            { kind: "file" }
          >),
          path: "../escape",
        },
      ],
      fileCount: 1,
      totalBytes: snapshot.entries.find((entry) => entry.kind === "file")?.size ?? 0,
    };
    await expect(repository.capture(
      "agent-invalid",
      badPath,
      createGitRecoveryRef("tests", "bad-path"),
    )).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });

    const reversed: GitRecoverySnapshot = {
      ...snapshot,
      entries: [...snapshot.entries].reverse(),
    };
    await expect(repository.capture(
      "agent-invalid",
      reversed,
      createGitRecoveryRef("tests", "reversed"),
    )).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });

    await expect(
      repository.capture(
        "agent-invalid",
        { ...snapshot, rootHash: "f".repeat(64) },
        createGitRecoveryRef("tests", "bad-root"),
      ),
    ).rejects.toMatchObject({ code: "GIT_RECOVERY_CORRUPT" });
    await expect(repository.readBlob("agent-invalid", "abc")).rejects.toMatchObject({
      code: "GIT_RECOVERY_INVALID_OBJECT_ID",
    });
  });

  it("probes the configured Git client explicitly", async () => {
    const { repository, git } = await fixture();
    await repository.probe();
    expect(git.capabilityChecks).toBe(1);
  });

  it("coalesces only concurrent initialization and keeps format validation cached by identity", async () => {
    const { repository, git } = await fixture();
    await Promise.all([
      repository.initialize("agent-concurrent"),
      repository.initialize("agent-concurrent"),
      repository.initialize("agent-concurrent"),
    ]);
    await repository.writeBlob("agent-concurrent", Buffer.from("one"));
    await repository.writeBlob("agent-concurrent", Buffer.from("two"));

    expect(git.repositoryInitializations).toBe(1);
    expect(git.repositoryChecks).toBe(1);
  });

  it.each([
    ["commondir", async (repositoryPath: string) => writeFile(path.join(repositoryPath, "commondir"), "../shared\n")],
    ["shallow", async (repositoryPath: string) => writeFile(path.join(repositoryPath, "shallow"), "deadbeef\n")],
    ["alternates", async (repositoryPath: string) => writeFile(path.join(repositoryPath, "objects", "info", "alternates"), "../external\n")],
    ["http alternates", async (repositoryPath: string) => writeFile(path.join(repositoryPath, "objects", "info", "http-alternates"), "https://example.invalid/\n")],
    ["promisor pack", async (repositoryPath: string) => writeFile(path.join(repositoryPath, "objects", "pack", "pack-deadbeef.promisor"), "")],
    ["replaced refs path", async (repositoryPath: string) => {
      const refsPath = path.join(repositoryPath, "refs");
      await rm(refsPath, { recursive: true });
      await writeFile(refsPath, "not a refs directory", "utf8");
    }],
    ["include", async (repositoryPath: string) => appendFile(path.join(repositoryPath, "config"), "[include]\n\tpath = ../outside-config\n")],
    ["includeIf", async (repositoryPath: string) => appendFile(path.join(repositoryPath, "config"), "[includeIf \"gitdir:/**\"]\n\tpath = ../outside-config\n")],
    ["partial clone", async (repositoryPath: string) => appendFile(path.join(repositoryPath, "config"), "[extensions]\n\tpartialClone = origin\n")],
    ["promisor remote", async (repositoryPath: string) => appendFile(path.join(repositoryPath, "config"), "[remote \"origin\"]\n\tpromisor = true\n")],
    ["repository identity", async (repositoryPath: string) => {
      const configPath = path.join(repositoryPath, "config");
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, config.replace(/[a-f0-9]{64}/, "f".repeat(64)), "utf8");
    }],
  ] as const)("rejects %s metadata added after the repository was cached", async (_name, mutate) => {
    const { repository, git } = await fixture();
    const repositoryId = `agent-tamper-${createHash("sha256").update(_name).digest("hex").slice(0, 12)}`;
    await repository.writeBlob(repositoryId, Buffer.from("before"));
    const repositoryPath = repository.repositoryPath(repositoryId);
    const writesBefore = git.calls.filter((call) => call.args.includes("hash-object")).length;

    await mutate(repositoryPath);

    await expect(repository.writeBlob(repositoryId, Buffer.from("after"))).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });
    expect(git.calls.filter((call) => call.args.includes("hash-object"))).toHaveLength(writesBefore);
  });

  it("rejects a repository path replaced after its first use", async () => {
    const { repository } = await fixture();
    const repositoryId = "agent-replaced";
    await repository.writeBlob(repositoryId, Buffer.from("before"));
    const repositoryPath = repository.repositoryPath(repositoryId);
    await rm(repositoryPath, { recursive: true });
    await writeFile(repositoryPath, "not a repository", "utf8");

    await expect(repository.writeBlob(repositoryId, Buffer.from("after"))).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });
  });

  it("rejects an oversized aggregate before reading any manifest blob", async () => {
    const { root, git } = await fixture();
    const repository = new GitRecoveryRepository(root, git, { maxTotalBytes: 3 });
    const repositoryId = "agent-total-limit";
    const bytes = Buffer.from("four", "utf8");
    const gitBlobOid = await repository.writeBlob(repositoryId, bytes);
    const snapshot: GitRecoverySnapshot = {
      version: 1,
      policyId: "complete-workspace-v1",
      rootHash: "0".repeat(64),
      entries: [
        {
          path: "value.txt",
          kind: "file",
          mode: 0o644,
          size: bytes.length,
          blobHash: rawHash(bytes),
          gitBlobOid,
        },
      ],
      fileCount: 1,
      totalBytes: bytes.length,
    };
    snapshot.rootHash = snapshotRootHash(snapshot);
    const catFileCallsBefore = git.calls.filter((call) => call.args.includes("cat-file")).length;

    await expect(repository.capture(
      repositoryId,
      snapshot,
      createGitRecoveryRef("tests", "total-limit"),
    )).rejects.toMatchObject({
      code: "GIT_RECOVERY_CORRUPT",
    });
    expect(git.calls.filter((call) => call.args.includes("cat-file"))).toHaveLength(
      catFileCallsBefore,
    );
  });
});

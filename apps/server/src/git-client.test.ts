import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitClient,
  GitClientError,
  isolatedGitEnvironment,
  spawnGitCommand,
  type GitCommandRequest,
  type GitCommandRunner,
} from "./git-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function successful(stdout = "", stderr = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode: 0,
    signal: null,
  } as const;
}

describe("GitClient", () => {
  it("removes inherited Git controls and installs a deterministic non-interactive environment", () => {
    expect(
      isolatedGitEnvironment(
        {
          PATH: "safe-path",
          Git_Dir: "attacker-repository",
          GIT_WORK_TREE: "attacker-worktree",
          GIT_CONFIG_COUNT: "9",
          GIT_OBJECT_DIRECTORY: "attacker-objects",
          LC_ALL: "en_US.UTF-8",
        },
        "/disabled/global/config",
      ),
    ).toEqual({
      PATH: "safe-path",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/disabled/global/config",
    });
  });

  it("passes argv and binary standard input without invoking a shell", async () => {
    const runner = vi.fn<GitCommandRunner>(async (request) => ({
      ...successful(),
      stdout: Buffer.from([0, 1, 2, 255]),
    }));
    const client = new GitClient({
      gitBin: "controlled-git",
      runner,
      baseEnvironment: { PATH: "safe-path", GIT_DIR: "unsafe" },
    });
    const input = Buffer.from([255, 0, 10]);

    const result = await client.run(["hash-object", "-w", "--stdin"], {
      cwd: "workspace",
      input,
    });

    expect(result.stdout).toEqual(Buffer.from([0, 1, 2, 255]));
    const request = runner.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      executable: "controlled-git",
      args: ["hash-object", "-w", "--stdin"],
      cwd: "workspace",
      input,
    });
    expect(request?.env.GIT_DIR).toBeUndefined();
    expect(request?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(request?.env.GIT_NO_LAZY_FETCH).toBe("1");
  });

  it("turns a non-zero exit into a bounded typed error", async () => {
    const runner: GitCommandRunner = async () => ({
      ...successful(),
      stderr: Buffer.from("bad repository\nsecond line"),
      exitCode: 128,
    });
    const client = new GitClient({ runner });

    await expect(client.run(["status"])).rejects.toMatchObject({
      name: "GitClientError",
      kind: "exit",
      message: "Git exited with code 128: bad repository second line",
    });
  });

  it("requires Git 2.29 or newer", async () => {
    const current = new GitClient({
      runner: async () => successful("git version 2.45.2.windows.1\n"),
    });
    await expect(current.assertVersion()).resolves.toEqual({
      raw: "git version 2.45.2.windows.1",
      major: 2,
      minor: 45,
      patch: 2,
    });

    const old = new GitClient({
      runner: async () => successful("git version 2.28.1\n"),
    });
    await expect(old.assertVersion()).rejects.toMatchObject({
      kind: "capability",
      message: expect.stringContaining("2.29 or newer"),
    });
  });

  it("initializes a bare SHA-256 repository and verifies both invariants", async () => {
    const requests: GitCommandRequest[] = [];
    const runner: GitCommandRunner = async (request) => {
      requests.push(request);
      if (request.args.includes("--is-bare-repository")) return successful("true\n");
      if (request.args.includes("--show-object-format=storage")) {
        return successful("sha256\n");
      }
      return successful();
    };
    const parent = await mkdtemp(path.join(tmpdir(), "git-client-test-"));
    temporaryDirectories.push(parent);
    const repository = path.join(parent, "nested", "recovery.git");

    await new GitClient({ runner }).initializeBareSha256(repository);

    expect(requests.map((request) => request.args)).toEqual([
      ["init", "--bare", "--object-format=sha256", "--quiet", path.resolve(repository)],
      [
        "--git-dir=" + path.resolve(repository),
        "rev-parse",
        "--is-bare-repository",
      ],
      [
        "--git-dir=" + path.resolve(repository),
        "rev-parse",
        "--show-object-format=storage",
      ],
    ]);
  });

  it("fails closed for SHA-1 or non-bare repositories", async () => {
    const sha1 = new GitClient({
      runner: async (request) =>
        request.args.includes("--is-bare-repository")
          ? successful("true\n")
          : successful("sha1\n"),
    });
    await expect(sha1.assertBareSha256Repository("repo.git")).rejects.toThrow(
      /must use SHA-256/,
    );

    const worktree = new GitClient({ runner: async () => successful("false\n") });
    await expect(worktree.assertBareSha256Repository("repo.git")).rejects.toThrow(
      /not bare/,
    );
  });

  it("probes SHA-256 support without retaining the temporary repository", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "git-client-probe-test-"));
    temporaryDirectories.push(parent);
    const client = new GitClient({
      runner: async (request) => {
        if (request.args[0] === "--version") return successful("git version 2.39.5\n");
        if (request.args.includes("--is-bare-repository")) return successful("true\n");
        if (request.args.includes("--show-object-format=storage")) {
          return successful("sha256\n");
        }
        return successful();
      },
    });

    await expect(client.assertCapabilities(parent)).resolves.toMatchObject({
      major: 2,
      minor: 39,
    });
  });
});

describe("spawnGitCommand", () => {
  function request(args: string[], overrides: Partial<GitCommandRequest> = {}) {
    return {
      executable: process.execPath,
      args,
      env: { ...process.env },
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      ...overrides,
    } satisfies GitCommandRequest;
  }

  it("enforces the combined stdout and stderr limit", async () => {
    await expect(
      spawnGitCommand(
        request(["-e", "process.stdout.write('x'.repeat(2048))"]),
      ),
    ).rejects.toMatchObject({ kind: "output-limit" });
  });

  it("terminates commands that exceed their deadline", async () => {
    await expect(
      spawnGitCommand(
        request(["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports process startup failures as Git client errors", async () => {
    await expect(
      spawnGitCommand({
        ...request([]),
        executable: path.join(tmpdir(), "missing-git-executable"),
      }),
    ).rejects.toBeInstanceOf(GitClientError);
  });
});

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MINIMUM_GIT_MAJOR = 2;
const MINIMUM_GIT_MINOR = 29;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function resolveGitExecutable(
  configured: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const requested = configured.trim() || "git";
  if (process.platform !== "win32" || !/^git(?:\.exe)?$/i.test(requested)) {
    return requested;
  }

  const candidates: string[] = [];
  const pathValue = environment.Path ?? environment.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    const normalized = directory.trim().replace(/^"|"$/g, "");
    if (normalized) candidates.push(path.join(normalized, "git.exe"));
  }

  const localPrograms = environment.LOCALAPPDATA
    ? path.join(environment.LOCALAPPDATA, "Programs")
    : null;
  if (localPrograms) {
    candidates.push(path.join(localPrograms, "Git", "cmd", "git.exe"));
    try {
      const minGitDirectories = readdirSync(localPrograms, {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory() && /^MinGit-/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));
      for (const directory of minGitDirectories) {
        candidates.push(path.join(localPrograms, directory, "cmd", "git.exe"));
      }
    } catch {
      // The Programs directory is optional; the normal spawn error remains useful.
    }
  }
  if (environment.ProgramFiles) {
    candidates.push(path.join(environment.ProgramFiles, "Git", "cmd", "git.exe"));
  }
  const programFilesX86 = environment["ProgramFiles(x86)"];
  if (programFilesX86) {
    candidates.push(path.join(programFilesX86, "Git", "cmd", "git.exe"));
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? requested;
}

export interface GitCommandRequest {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
  input?: Buffer | string;
}

export interface GitCommandRunnerResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export type GitCommandRunner = (
  request: GitCommandRequest,
) => Promise<GitCommandRunnerResult>;

export interface GitRunOptions {
  cwd?: string;
  input?: Buffer | string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

export interface GitVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export interface GitClientOptions {
  gitBin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  runner?: GitCommandRunner;
  baseEnvironment?: NodeJS.ProcessEnv;
  disabledGlobalConfigPath?: string;
}

export class GitClientError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "spawn"
      | "exit"
      | "timeout"
      | "output-limit"
      | "capability",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitClientError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + " must be a positive integer");
  }
  return value;
}

function disabledGitConfigPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export function isolatedGitEnvironment(
  inherited: NodeJS.ProcessEnv,
  globalConfigPath = disabledGitConfigPath(),
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (!name.toUpperCase().startsWith("GIT_")) {
      result[name] = value;
    }
  }
  result.LANG = "C";
  result.LC_ALL = "C";
  result.GIT_TERMINAL_PROMPT = "0";
  result.GIT_NO_LAZY_FETCH = "1";
  result.GIT_CONFIG_NOSYSTEM = "1";
  result.GIT_CONFIG_GLOBAL = globalConfigPath;
  return result;
}

function appendWithinLimit(
  chunks: Buffer[],
  chunk: Buffer,
  remainingBytes: number,
): void {
  if (remainingBytes <= 0) return;
  chunks.push(chunk.byteLength <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes));
}

export const spawnGitCommand: GitCommandRunner = (request) =>
  new Promise<GitCommandRunnerResult>((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let termination: GitClientError | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const stop = (error: GitClientError) => {
      if (termination) return;
      termination = error;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKillTimer.unref();
      }
    };

    const consume = (chunk: Buffer, destination: Buffer[]) => {
      const previousBytes = outputBytes;
      outputBytes += chunk.byteLength;
      appendWithinLimit(
        destination,
        chunk,
        request.maxOutputBytes - previousBytes,
      );
      if (outputBytes > request.maxOutputBytes) {
        stop(
          new GitClientError(
            "Git output exceeded " + request.maxOutputBytes + " bytes",
            "output-limit",
          ),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, stdout));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, stderr));
    child.stdin.on("error", () => undefined);

    const timeout = setTimeout(
      () =>
        stop(
          new GitClientError(
            "Git command timed out after " + request.timeoutMs + " ms",
            "timeout",
          ),
        ),
      request.timeoutMs,
    );
    timeout.unref();

    const finish = (
      error: Error | null,
      exitCode = 1,
      signal: NodeJS.Signals | null = null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (termination) {
        reject(termination);
      } else if (error) {
        reject(
          new GitClientError("Unable to start Git: " + error.message, "spawn", {
            cause: error,
          }),
        );
      } else {
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
          signal,
        });
      }
    };

    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => finish(null, code ?? 1, signal));
    child.stdin.end(request.input);
  });

function errorDetail(stderr: Buffer): string {
  const detail = stderr.toString("utf8").trim().replace(/[\r\n]+/g, " ");
  return detail ? detail.slice(0, 2_048) : "no error detail";
}

export class GitClient {
  private readonly gitBin: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly runner: GitCommandRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: GitClientOptions = {}) {
    this.gitBin = options.gitBin?.trim() || "git";
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.runner = options.runner ?? spawnGitCommand;
    this.environment = isolatedGitEnvironment(
      options.baseEnvironment ?? process.env,
      options.disabledGlobalConfigPath ?? disabledGitConfigPath(),
    );
  }

  async run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitCommandResult> {
    const request: GitCommandRequest = {
      executable: this.gitBin,
      args: [...args],
      env: { ...this.environment },
      timeoutMs: positiveInteger(options.timeoutMs ?? this.timeoutMs, "timeoutMs"),
      maxOutputBytes: positiveInteger(
        options.maxOutputBytes ?? this.maxOutputBytes,
        "maxOutputBytes",
      ),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.input === undefined ? {} : { input: options.input }),
    };
    let result: GitCommandRunnerResult;
    try {
      result = await this.runner(request);
    } catch (error) {
      if (error instanceof GitClientError) throw error;
      throw new GitClientError(
        "Unable to execute Git: " +
          (error instanceof Error ? error.message : String(error)),
        "spawn",
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      throw new GitClientError(
        "Git exited with code " +
          result.exitCode +
          ": " +
          errorDetail(result.stderr),
        "exit",
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async runText(args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString("utf8");
  }

  async assertVersion(): Promise<GitVersion> {
    const raw = (await this.runText(["--version"], { maxOutputBytes: 4_096 })).trim();
    const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(raw);
    if (!match) {
      throw new GitClientError(
        "Unable to parse Git version output: " + raw.slice(0, 120),
        "capability",
      );
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3] ?? 0);
    if (
      major < MINIMUM_GIT_MAJOR ||
      (major === MINIMUM_GIT_MAJOR && minor < MINIMUM_GIT_MINOR)
    ) {
      throw new GitClientError(
        "Git 2.29 or newer is required; found " + raw,
        "capability",
      );
    }
    return { raw, major, minor, patch };
  }

  async assertBareSha256Repository(repositoryPath: string): Promise<void> {
    const gitDirectoryArgument = "--git-dir=" + path.resolve(repositoryPath);
    const bare = (
      await this.runText(
        [gitDirectoryArgument, "rev-parse", "--is-bare-repository"],
        { maxOutputBytes: 4_096 },
      )
    ).trim();
    if (bare !== "true") {
      throw new GitClientError(
        "Recovery repository is not bare: " + path.resolve(repositoryPath),
        "capability",
      );
    }
    const objectFormat = (
      await this.runText(
        [gitDirectoryArgument, "rev-parse", "--show-object-format=storage"],
        { maxOutputBytes: 4_096 },
      )
    ).trim();
    if (objectFormat !== "sha256") {
      throw new GitClientError(
        "Recovery repository must use SHA-256 objects; found " +
          (objectFormat || "unknown"),
        "capability",
      );
    }
  }

  async initializeBareSha256(repositoryPath: string): Promise<void> {
    const absolutePath = path.resolve(repositoryPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await this.run(
      ["init", "--bare", "--object-format=sha256", "--quiet", absolutePath],
      { maxOutputBytes: 64 * 1024 },
    );
    await this.assertBareSha256Repository(absolutePath);
  }

  async probeSha256Support(parentDirectory?: string): Promise<void> {
    const parent = path.resolve(parentDirectory ?? tmpdir());
    await mkdir(parent, { recursive: true });
    const probeRoot = await mkdtemp(path.join(parent, "launchpad-git-sha256-probe-"));
    try {
      await this.initializeBareSha256(path.join(probeRoot, "repository.git"));
    } catch (error) {
      throw new GitClientError(
        "Git cannot create the required SHA-256 bare repository",
        "capability",
        { cause: error },
      );
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  }

  async assertCapabilities(probeParentDirectory?: string): Promise<GitVersion> {
    const version = await this.assertVersion();
    await this.probeSha256Support(probeParentDirectory);
    return version;
  }
}

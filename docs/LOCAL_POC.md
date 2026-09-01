# Local POC

## Windows local-process profile

Windows can run the React/Fastify application and Codex CLI directly without
Docker. From PowerShell, use the guarded launcher:

```powershell
npm run poc:windows
```

If PowerShell blocks `npm.ps1`, call the checked-in command wrapper instead.
It invokes the same guarded launcher with a process-local execution-policy
bypass and does not change the machine or user policy:

```powershell
.\scripts\start-local-windows.cmd
```

After a successful build, later starts can reuse the existing production
artifacts and avoid waiting for Vite and TypeScript again:

```powershell
.\scripts\start-local-windows.cmd -SkipBuild
```

The equivalent npm command is:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run poc:windows -- -SkipBuild
```

The launcher securely prompts for `ARK_API_KEY`, prompts for `ARK_MODEL`,
resolves the native `codex.exe`, discovers standard Git for Windows and MinGit
installations even when Git is absent from `PATH`, validates Node.js 22+, and
performs a real Git SHA-256 bare-repository probe before starting the server.
It rejects obvious API key values such as `ark-...` or `apikey-...` in
`ARK_MODEL`.

`ARK_MODEL` must be a Responses-capable endpoint or model ID from the Ark
console, commonly `ep-xxxxxxxx`. It is not the API key name. The API key is
kept in the current PowerShell process and is not written to `.env`.

The Windows profile stores local data below `.local/`, uses
`RUNTIME_PROVIDER=local-process`, and prints separate Trace viewer and recovery
operator tokens. Keep the terminal open while using the web UI and press
`Ctrl+C` to stop the server.

The launcher sets `NODE_ENV=production`, so the Fastify process serves both the
API and the built React application on port 3000. Running the server entry file
directly without that setting starts the API but does not mount the production
web assets.

If `npm ci` reports `EPERM` while unlinking `esbuild.exe`, an older Vite build
is still using that exact executable. Close the old Trace1 build terminal,
confirm no Trace1 `esbuild.exe` process remains, and rerun the launcher. Do not
terminate unrelated Node processes from other projects.

To validate tools and configuration without building or starting the server:

```powershell
$env:ARK_API_KEY = "temporary-test-value"
$env:ARK_MODEL = "ep-test"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local-windows.ps1 -ValidateOnly
Remove-Item Env:ARK_API_KEY,Env:ARK_MODEL
```

Do not use a real key in a command that may be saved to shell history. For a
real start, let `npm run poc:windows` prompt for it.

## Container profile

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the Volcengine Ark model API is remote.

## Start

Requirements:

- Node.js 22+
- Git 2.29+ on the control-plane host, with SHA-256 object-format support
- Docker, Colima, or Podman
- An Ark API key and Responses-capable endpoint

Git is used by the Fastify control plane for workspace checkpoints. Installing
Git only in the disposable Agent Runtime image is not sufficient. Set
`GIT_BIN=/absolute/path/to/git` when the desired executable is not named
`git`.

At startup, recovery performs a capability probe rather than relying only on a
version string. It creates a temporary repository with
`git init --bare --object-format=sha256` and verifies that
`rev-parse --show-object-format=storage` reports `sha256`. Readiness fails
closed when that probe fails.

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Recovery data is stored below the persistent data root, outside every Runtime
mount:

```text
recovery/
  repositories/<agentId>.git/   # external bare Git SHA-256 repository
  operations/                   # durable restore transaction journals
```

The platform never creates its recovery `.git` inside an Agent workspace.
Deleting or structurally rewriting workspace files therefore cannot delete the
corresponding pre/post/safety commits.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Check Runtime readiness:

```bash
git --version
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If recovery startup reports a Git capability error, first verify the exact
control-plane executable:

```bash
${GIT_BIN:-git} --version
probe_dir="$(mktemp -d)"
${GIT_BIN:-git} init --bare --object-format=sha256 "$probe_dir/probe.git"
${GIT_BIN:-git} --git-dir="$probe_dir/probe.git" rev-parse --show-object-format=storage
rm -rf "$probe_dir"
```

The last command must print `sha256`. The probe directory above is temporary;
do not point these commands at an Agent repository or workspace.

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```

The Windows profile has been verified against Git for Windows 2.54.0 with a
real SHA-256 checkpoint, delete/create preview, safety snapshot, restore result,
and quarantine-content check. Injected-runner unit tests remain useful, but do
not replace this real-Git integration path.

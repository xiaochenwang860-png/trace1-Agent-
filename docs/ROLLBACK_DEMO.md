# API and Rollback Demo

This runbook verifies four separate behaviors:

1. Ark authentication and model compatibility.
2. Codex file operations inside one Agent workspace.
3. Git checkpoint and created/modified/deleted diff generation.
4. Previewed restore with a safety checkpoint and visible audit result.

## Start on Windows

The first start builds the application:

```powershell
cd D:\kaggle\hacthon\trace1-Agent-
.\scripts\start-local-windows.cmd
```

Later starts can reuse the built files:

```powershell
.\scripts\start-local-windows.cmd -SkipBuild
```

Enter the API key only at the hidden prompt. Enter the Ark endpoint or model ID
at the separate `ARK_MODEL` prompt. Keep the terminal open and retain the Trace
viewer and recovery operator tokens printed by the launcher.

## Run 1: create the baseline

Create or select a dedicated demo Agent, then send this prompt:

```text
This is a controlled API and model smoke test.

Only modify the recovery-smoke-test directory in the current workspace. Do not
modify any other file.

1. Create recovery-smoke-test/important.txt with exactly this content:
   ORIGINAL IMPORTANT CONTENT
2. Create recovery-smoke-test/settings.json with exactly this JSON:
   {"enabled":true,"mode":"stable","version":1}
3. Read both files back and verify their contents.
4. Report the two paths and finish without making other changes.
```

Expected result: the Run completes, the two files exist, and its Trace contains
model, tool, file, checkpoint, and terminal events. This is the remote API
smoke test; server startup alone is not sufficient.

## Run 2: simulate a mistaken change

Send a second prompt to the same Agent:

```text
This is a controlled mistaken-change simulation.

Only modify the recovery-smoke-test directory in the current workspace.

1. Delete recovery-smoke-test/important.txt.
2. Replace recovery-smoke-test/settings.json with exactly this JSON:
   {"enabled":false,"mode":"broken","version":2}
3. Create recovery-smoke-test/unwanted.txt with exactly this content:
   UNWANTED FILE
4. Report the changes and finish. Do not restore the files yourself.
```

Expected recovery summary for Run 2:

| Path | Run change | Restore action |
| --- | --- | --- |
| `recovery-smoke-test/important.txt` | deleted | recreate from checkpoint |
| `recovery-smoke-test/settings.json` | modified | replace with checkpoint copy |
| `recovery-smoke-test/unwanted.txt` | created | delete current file |

## Inspect and restore

1. Open `http://127.0.0.1:3000/developer`.
2. Enter the Trace viewer token printed by the launcher.
3. Select the demo user, Agent, and second Run.
4. Confirm the Run Trace and the `Workspace recovery` summary.
5. Choose `Preview all changes`.
6. Confirm the preview contains three actions and no conflicts.
7. Enter the recovery operator token printed by the launcher.
8. Apply the restore.

The panel must display `Workspace restored` and a safety snapshot ID. After the
restore, `important.txt` and the original `settings.json` are present, while
`unwanted.txt` is absent. A `workspace.restore.completed` Trace event provides
the correlated audit record.

## Filesystem proof

The Agent ID is visible in the Developer Console. Substitute it below to check
the actual workspace rather than relying only on UI status:

```powershell
$agentId = "replace-with-agent-id"
$workspace = "D:\kaggle\hacthon\trace1-Agent-\.local\workspaces\$agentId"

Get-Content "$workspace\recovery-smoke-test\important.txt"
Get-Content "$workspace\recovery-smoke-test\settings.json"
Test-Path "$workspace\recovery-smoke-test\unwanted.txt"
```

Expected final values are `ORIGINAL IMPORTANT CONTENT`, the original stable
JSON, and `False` for `unwanted.txt`.

## Boundary

This restores platform-managed workspace files. It does not reverse external
API calls, database writes, emails, consumed tokens, or other side effects
outside the workspace.

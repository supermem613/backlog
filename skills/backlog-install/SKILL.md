---
name: backlog-install
description: Enable the Copilot CLI backlog /backlog command and sidecar by installing the user-scoped SDK extension shim from the installed plugin.
---

Use this skill when the user asks to install, enable, set up, or repair the Copilot CLI `/backlog` command after installing the plugin.

Goal:

- Locate the installed `copilot-cli-backlog` plugin under the user's Copilot installed plugins directory.
- Run the plugin's deterministic shim installer script.
- Confirm the installer reports `Friction delete smoke check passed.`
- Tell the user to enable or reload the `backlog` user extension in `/extensions` if it is not already running.

Use the command for the user's shell.

PowerShell:

```powershell
$installer = Get-ChildItem "$env:USERPROFILE\.copilot\installed-plugins" -Directory -Recurse |
  Where-Object { Test-Path (Join-Path $_.FullName "scripts\install-extension-shim.mjs") } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $installer) {
  throw "Could not find the installed copilot-cli-backlog plugin. Run: copilot plugin install supermem613/copilot-cli-backlog"
}

node (Join-Path $installer "scripts\install-extension-shim.mjs")
```

Bash/zsh:

```bash
installer="$(find "$HOME/.copilot/installed-plugins" -type f -path '*/scripts/install-extension-shim.mjs' | head -n 1)"
if [ -z "$installer" ]; then
  echo "Could not find the installed copilot-cli-backlog plugin. Run: copilot plugin install supermem613/copilot-cli-backlog" >&2
  exit 1
fi
node "$installer"
```

After the script succeeds, instruct the user:

1. Run `/extensions`.
2. Enable `backlog` under **User**, or toggle it off and on if it was already enabled.
3. Run `/backlog doctor` to confirm the loaded path, version, cascade status, and friction delete smoke check.

Do not overwrite unrelated user extensions. If the installer reports that it refused to overwrite an existing non-backlog extension or a symlink/junction, stop and explain — the user already has a user extension named `backlog` (likely a dev-loop checkout).

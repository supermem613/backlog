# copilot-cli-backlog

A GitHub Copilot CLI extension that gives every session a **persistent task backlog** with deterministic slash commands, in-conversation tools the agent can call, and a chromeless sidecar viewer for one-click control.

The agent and the human share the same backlog: you can `/backlog add` something while the agent is working, the agent can call `backlog_next` after completing a step to pick up the next item, and the sidecar window shows a live, click-to-engage list across all your active Copilot CLI sessions.

Backlog persists in a SQLite database at `~/.backlog/backlog.db` (zero deps — uses Node 24's built-in `node:sqlite`), so items survive across sessions and even across machine restarts.

## Install

### 1. Enable experimental Copilot CLI extensions

In a Copilot CLI session:

```
/experimental
```

Enable the **Extensions** feature. If your Copilot CLI version does not show that option, add `"EXTENSIONS"` to `experimental_flags` in `~/.copilot/config.json` and restart.

### 2. Install the plugin from GitHub

```
copilot plugin install supermem613/copilot-cli-backlog
```

Verify:

```
copilot plugin list
```

### 3. Enable the `/backlog` extension

The plugin install puts the package on disk. The `/backlog` command and sidecar are loaded as a Copilot CLI SDK extension discovered from the user extensions folder.

Easiest path — in a Copilot CLI session, run:

```
Use the backlog-install skill to enable the /backlog command.
```

The skill installs a small user-scoped delegate at `~/.copilot/extensions/backlog/extension.mjs` that imports the SDK extension from the plugin install location.

If you prefer to do it by hand, paste this into your shell after `copilot plugin install` completes:

PowerShell:

```powershell
$installer = Get-ChildItem "$env:USERPROFILE\.copilot\installed-plugins" -Directory -Recurse |
  Where-Object { Test-Path (Join-Path $_.FullName "scripts\install-extension-shim.mjs") } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $installer) { throw "Could not find installed copilot-cli-backlog plugin." }

node (Join-Path $installer "scripts\install-extension-shim.mjs")
```

Bash/zsh:

```bash
installer="$(find "$HOME/.copilot/installed-plugins" -type f -path '*/scripts/install-extension-shim.mjs' | head -n 1)"
if [ -z "$installer" ]; then echo "Could not find installed copilot-cli-backlog plugin." >&2; exit 1; fi
node "$installer"
```

In Copilot CLI:

```
/extensions
```

Enable `backlog` under **User**. Then run `/backlog list` to confirm.

## Use

### Slash commands

```
/backlog add <description>          # append a new item
/backlog add --top <description>    # add as position 1
/backlog list                       # show pending items
/backlog next                       # show the top item
/backlog pending                    # count of pending items
/backlog done <id-or-position>      # mark complete
/backlog remove <id-or-position>    # delete without completing
/backlog top <id-or-position>       # move to position 1
/backlog up <id-or-position>        # move up one position
/backlog down <id-or-position>      # move down one position
/backlog edit <id-or-position> <new-description>
/backlog clear                      # delete every item in this session
/backlog show                       # open the sidecar window
/backlog doctor                     # show runtime provenance and run delete smoke check
/backlog sessions                   # list all sessions with pending items
/backlog prune [days]               # drop sessions not accessed in N days (default 7)
```

Items can be referenced by short ID (e.g. `t1a2b3`) or by position number (e.g. `2`).

`/backlog doctor` reports the loaded extension path, package version, git commit, storage status, and runs an item delete smoke check. Use it after upgrades or extension reloads to confirm the running extension is the one you expect.

### Agent-callable tools

The agent automatically gets these tools and uses them naturally:

- `backlog_next` — fetch the top pending item; the agent calls this after completing a step to know what's next.
- `backlog_list` — list all pending items.
- `backlog_add` — append an item (handy when the user says "add this to the backlog" mid-conversation).
- `backlog_done` — mark an item complete by id or position.
- `backlog_remove` — drop an item without completing it.

### Permission prompts

Backlog avoids elevated extension capabilities: it does not skip tool permissions, register lifecycle hooks, or handle permission requests. The agent-callable tools may still ask for normal per-tool approval under Copilot CLI's standard tool-permission flow.

### Sidecar viewer

`/backlog show` (or any session activity once the sidecar is running) opens a chromeless sidecar window — `msedge --app=` on Windows; falls back to the default browser elsewhere. The viewer shows every active session's backlog in real time, lets you click any item to ask the agent to engage on it, and exposes toolbar controls for burndown mode and viewer refresh.

The top bar shows the loaded package version, git commit, and storage status. Hover it to see the exact extension and package paths.

A single sidecar window is shared across **all** Copilot CLI sessions on the machine — owner election happens via a lock file at `~/.backlog/viewer.lock`. If the owning session goes away, another active session takes over automatically.

## Develop

```bash
git clone https://github.com/supermem613/copilot-cli-backlog.git
cd copilot-cli-backlog
npm run check    # node --check on every .mjs
npm test         # run the extension test suite
```

To run your local working tree as the live extension (instead of the installed plugin), drop a one-line shim at `~/.copilot/extensions/backlog/extension.mjs` that dynamic-imports your working tree. **Do not** point the directory itself at the working tree with a junction or symlink — Copilot CLI's extension loader does not pick those up.

```powershell
# Windows
$ext = "$env:USERPROFILE\.copilot\extensions\backlog"
Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $ext | Out-Null
$target = "$PWD\.github\extensions\backlog\extension.mjs"
@"
import { pathToFileURL } from "node:url";
await import(pathToFileURL($($target | ConvertTo-Json)).href);
"@ | Set-Content -Path "$ext\extension.mjs" -NoNewline
```

```bash
# macOS / Linux
ext="$HOME/.copilot/extensions/backlog"
rm -rf "$ext"
mkdir -p "$ext"
target="$PWD/.github/extensions/backlog/extension.mjs"
cat > "$ext/extension.mjs" <<EOF
import { pathToFileURL } from "node:url";
await import(pathToFileURL("$target").href);
EOF
```

Then `/extensions` → reload `backlog`. Edits to the working tree take effect on the next `extensions reload` (the shim is just a delegate; your working tree is the real source).

## Repo layout

```
copilot-cli-backlog/
├── .github/
│   ├── extensions/backlog/    SDK extension: db, items, sidecar, commands, prompt, extension + viewer.html + favicon.svg + tests
│   └── workflows/ci.yml       Cross-platform CI: node --check + tests on Node 24
├── docs/screenshots/          README images
├── scripts/
│   └── install-extension-shim.mjs   Writes the user-scoped delegate after plugin install
├── skills/
│   └── backlog-install/SKILL.md     Setup skill the user invokes from a Copilot CLI session
├── plugin.json                Plugin metadata (name, version, skills dir)
├── package.json               npm scripts (check, test)
├── LICENSE                    MIT
└── README.md                  (this file)
```

## License

MIT © Marcus Markiewicz

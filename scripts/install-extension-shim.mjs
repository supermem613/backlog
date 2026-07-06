#!/usr/bin/env node
// Installs a user-scoped Copilot CLI extension shim that imports the
// extension code from this plugin's installed location.
//
// Pattern adapted from DamianEdwards/copilot-cli-cost. After the user runs
// `copilot plugin install supermem613/copilot-cli-backlog`, this script
// finds the installed plugin directory under ~/.copilot/installed-plugins
// and writes a tiny delegate at ~/.copilot/extensions/backlog/extension.mjs
// that imports the real extension from the plugin install location.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionName = "backlog";
const extensionRelativePath = path.join(".github", "extensions", extensionName, "extension.mjs");

try {
    const sourceExtension = findInstalledExtension();
    const targetDirectory = path.join(os.homedir(), ".copilot", "extensions", extensionName);
    const targetExtension = path.join(targetDirectory, "extension.mjs");
    const content = `import { pathToFileURL } from "node:url";\n\nawait import(pathToFileURL(${JSON.stringify(sourceExtension)}).href);\n`;

    if (fs.existsSync(targetDirectory)) {
        const dirStat = fs.lstatSync(targetDirectory);
        if (dirStat.isSymbolicLink() || isJunction(dirStat, targetDirectory)) {
            // The user might have a junction or symlink (dev-loop install).
            // Refuse to clobber it.
            throw new Error(`Refusing to overwrite a symlink/junction at ${targetDirectory}. ` +
                `If you want the plugin shim instead, remove the link first.`);
        }
    }

    if (fs.existsSync(targetExtension)) {
        const existing = fs.readFileSync(targetExtension, "utf8");
        if (existing === content) {
            await runSourceSmoke(sourceExtension);
            console.log(`backlog extension shim is already installed at ${targetExtension}`);
            console.log("Item delete smoke check passed.");
            process.exit(0);
        }
        if (!existing.includes(extensionName)) {
            throw new Error(`Refusing to overwrite existing non-backlog extension at ${targetExtension}`);
        }
    }

    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(targetExtension, content);
    await runSourceSmoke(sourceExtension);
    console.log(`Installed backlog extension shim at ${targetExtension}`);
    console.log(`Shim imports ${pathToFileURL(sourceExtension).href}`);
    console.log("Item delete smoke check passed.");
} catch (error) {
    console.error(`install-extension-shim: ${error.message}`);
    process.exitCode = 1;
}

function findInstalledExtension() {
    const installedPluginsDirectory = path.join(os.homedir(), ".copilot", "installed-plugins");
    const matches = findFiles(installedPluginsDirectory, path.basename(extensionRelativePath))
        .filter((file) => path.normalize(file).endsWith(extensionRelativePath));

    if (matches.length === 0) {
        throw new Error(
            `Could not find ${extensionRelativePath} under ${installedPluginsDirectory}. ` +
            `Install the plugin first: copilot plugin install supermem613/copilot-cli-backlog`,
        );
    }

    matches.sort();
    return matches[0];
}

function findFiles(directory, fileName) {
    if (!fs.existsSync(directory)) return [];
    const results = [];
    const stack = [directory];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (entry.isFile() && entry.name === fileName) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

// Windows directory junctions report isDirectory() === true and
// isSymbolicLink() === false from lstat. The reliable cross-platform
// detection is: realpath differs from the original path.
function isJunction(_stat, dirPath) {
    if (process.platform !== "win32") return false;
    try {
        const real = fs.realpathSync(dirPath);
        return path.resolve(real) !== path.resolve(dirPath);
    } catch {
        return false;
    }
}

async function runSourceSmoke(sourceExtension) {
    const extensionDirectory = path.dirname(sourceExtension);
    const dbModule = await import(pathToFileURL(path.join(extensionDirectory, "db.mjs")).href);
    const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-install-smoke-"));
    try {
        dbModule.initBacklog(smokeDir);
        const doctor = await import(pathToFileURL(path.join(extensionDirectory, "doctor.mjs")).href);
        const smoke = doctor.runItemDeleteSmoke("install");
        if (!smoke.ok) {
            throw new Error("item delete smoke failed");
        }
    } finally {
        fs.rmSync(smokeDir, { recursive: true, force: true });
    }
}

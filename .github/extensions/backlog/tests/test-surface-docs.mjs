import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, assertEqual, done } from "./harness.mjs";
import { getSharedCommandDefinitions, getToolDefinitions } from "../command-registry.mjs";

const readmePath = fileURLToPath(new URL("../../../../README.md", import.meta.url));
const readme = readFileSync(readmePath, "utf8");

const slashBlock = readme.match(/### Slash commands\s+```([\s\S]*?)```/)?.[1] || "";
const documentedSlashCommands = [...slashBlock.matchAll(/^\/backlog\s+([a-z]+)/gm)].map((match) => match[1]);
const uniqueDocumentedSlashCommands = [...new Set(documentedSlashCommands)];
const expectedSlashCommands = getSharedCommandDefinitions().map((command) => command.name);

assertEqual(
  uniqueDocumentedSlashCommands.join(","),
  expectedSlashCommands.join(","),
  "README slash command block matches the runnable shared command registry",
);

for (const command of getSharedCommandDefinitions()) {
  assert(new RegExp(`^/backlog\\s+${command.name}(?:\\s|$)`, "m").test(slashBlock), `README documents /backlog ${command.name}`);
}

const toolBlock = readme.match(/### Agent-callable tools\s+([\s\S]*?)(?:\n### |\n## |$)/)?.[1] || "";
const documentedTools = [...toolBlock.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
const expectedTools = getToolDefinitions().map((tool) => tool.name);

assertEqual(
  documentedTools.join(","),
  expectedTools.join(","),
  "README agent tool block matches the tool registry",
);

for (const tool of getToolDefinitions()) {
  assert(new RegExp(`^- \`${tool.name}\``, "m").test(toolBlock), `README documents ${tool.name}`);
  assert(tool.parameters.properties.cwd, `${tool.name} schema exposes cwd for workspace queue resolution`);
}

done("test-surface-docs");

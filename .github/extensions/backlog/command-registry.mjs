export const SCHEMA_VERSION = "1.0.0";

const commandDefinitions = [
  {
    name: "backlog",
    scope: "slash",
    description: "Manage session item backlog and queues.",
    usage: "/backlog <command> [args]",
  },
  {
    name: "add",
    scope: "slash",
    description: "Add a backlog item.",
    usage: "/backlog add <description>",
  },
  {
    name: "list",
    scope: "slash",
    description: "List pending backlog items.",
    usage: "/backlog list",
  },
  {
    name: "done",
    scope: "slash",
    description: "Mark an item as done.",
    usage: "/backlog done <id-or-position>",
  },
  {
    name: "remove",
    scope: "slash",
    description: "Remove an item from the backlog.",
    usage: "/backlog remove <id-or-position>",
  },
  {
    name: "edit",
    scope: "slash",
    description: "Edit a backlog item description.",
    usage: "/backlog edit <id-or-position> <new-description>",
  },
  {
    name: "top",
    scope: "slash",
    description: "Move an item to the top of the queue.",
    usage: "/backlog top <id-or-position>",
  },
  {
    name: "up",
    scope: "slash",
    description: "Move an item up one slot.",
    usage: "/backlog up <id-or-position>",
  },
  {
    name: "down",
    scope: "slash",
    description: "Move an item down one slot.",
    usage: "/backlog down <id-or-position>",
  },
  {
    name: "next",
    scope: "slash",
    description: "Show the next pending item.",
    usage: "/backlog next",
  },
  {
    name: "pending",
    scope: "slash",
    description: "Show the pending item count.",
    usage: "/backlog pending",
  },
  {
    name: "status",
    scope: "slash",
    description: "Inspect backlog queue resolution for the current workspace.",
    usage: "/backlog status",
  },
  {
    name: "sessions",
    scope: "slash",
    description: "List backlog sessions.",
    usage: "/backlog sessions",
  },
  {
    name: "prune",
    scope: "slash",
    description: "Prune inactive sessions.",
    usage: "/backlog prune [days]",
  },
  {
    name: "clear",
    scope: "slash",
    description: "Clear all backlog items from the current session.",
    usage: "/backlog clear",
  },
  {
    name: "queue",
    scope: "slash",
    description: "Create, inspect, and rename backlog queues.",
    usage: "/backlog queue list|add|create|edit|rename",
  },
  {
    name: "show",
    scope: "slash",
    description: "Open the backlog viewer.",
    usage: "/backlog show",
  },
  {
    name: "approve",
    scope: "slash",
    description: "Approve the start gate for an item.",
    usage: "/backlog approve <id>",
  },
  {
    name: "review",
    scope: "slash",
    description: "Inspect and decide on review-gated items.",
    usage: "/backlog review [<id> approve|reject]",
  },
  {
    name: "backup",
    scope: "slash",
    description: "Export a backlog backup.",
    usage: "/backlog backup [path]",
  },
  {
    name: "restore",
    scope: "slash",
    description: "Restore a backlog backup.",
    usage: "/backlog restore <path>",
  },
  {
    name: "loop",
    scope: "slash",
    description: "Control backlog loops.",
    usage: "/backlog loop start|stop|status [queue-id-or-name]",
  },
  {
    name: "doctor",
    scope: "slash",
    description: "Show the backlog doctor report.",
    usage: "/backlog doctor",
  },
  {
    name: "help",
    scope: "cli",
    description: "Show help for the backlog CLI.",
    usage: "backlog help [command]",
  },
  {
    name: "schema",
    scope: "cli",
    description: "Show the backlog command and tool schema.",
    usage: "backlog schema",
  },
];

const toolDefinitions = [
  {
    name: "backlog_next",
    description: "Get the next pending backlog item. Call this after completing an item to check for more work.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "backlog_list",
    description: "List all pending backlog items for the current session.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "backlog_add",
    description: "Add an item to the session backlog.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description" },
        top: { type: "boolean", description: "Add as top priority" },
      },
      required: ["description"],
    },
  },
  {
    name: "backlog_done",
    description: "Mark a backlog item as done by ID or position number.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Item ID or position number" },
      },
      required: ["ref"],
    },
  },
  {
    name: "backlog_remove",
    description: "Remove a backlog item without completing it.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Item ID or position number" },
      },
      required: ["ref"],
    },
  },
  {
    name: "backlog_status",
    description: "Inspect the current backlog queue resolution and item counts for a workspace.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Workspace directory to inspect" },
      },
    },
  },
];

function cloneMetadata(items) {
  return items.map((item) => JSON.parse(JSON.stringify(item)));
}

export function getCommandDefinitions() {
  return cloneMetadata(commandDefinitions);
}

export function getSlashCommandDefinitions() {
  return getCommandDefinitions().filter((command) => command.scope === "slash");
}

export function getCommandDefinition(name) {
  return getCommandDefinitions().find((command) => command.name === name) || null;
}

export function getSlashCommandNames() {
  return getSlashCommandDefinitions().map((command) => command.name);
}

export function getCliCommandNames() {
  return getCommandDefinitions().filter((command) => command.scope === "cli").map((command) => command.name);
}

export function formatCommandHelp(commandName = null) {
  const command = commandName ? getCommandDefinition(commandName) : null;
  if (command) {
    return `${command.name}\n  ${command.description}\n  Usage: ${command.usage}`;
  }

  const lines = ["Usage: backlog <command> [args]", "", "Commands:"]; 
  for (const entry of getSlashCommandDefinitions()) {
    lines.push(`  ${entry.name.padEnd(10)} ${entry.description}`);
  }
  lines.push("", "CLI helpers:");
  for (const entry of getCommandDefinitions().filter((item) => item.scope === "cli")) {
    lines.push(`  ${entry.name.padEnd(10)} ${entry.description}`);
  }
  return lines.join("\n");
}

export function getToolDefinitions() {
  return cloneMetadata(toolDefinitions);
}

export function getToolDefinition(name) {
  return getToolDefinitions().find((tool) => tool.name === name) || null;
}

export function createSchemaEnvelope() {
  return {
    schemaVersion: SCHEMA_VERSION,
    commands: getCommandDefinitions(),
    tools: getToolDefinitions(),
  };
}

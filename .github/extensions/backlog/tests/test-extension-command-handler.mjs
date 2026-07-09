import { assertEqual, done } from "./harness.mjs";
import { createExtensionCommandHandler } from "../extension-command-handler.mjs";

let captured = null;
const handler = createExtensionCommandHandler({
  handleBacklogCommand: async (rawText, options) => {
    captured = { rawText, options };
    return "ok";
  },
});

const result = await handler("init", { cwd: "C:\\repos\\soda" });

assertEqual(result, "ok", "extension command handler returns shared handler output");
assertEqual(captured.rawText, "init", "extension command handler forwards raw text");
assertEqual(captured.options.cwd, "C:\\repos\\soda", "extension command handler preserves command cwd");

done("test-extension-command-handler");

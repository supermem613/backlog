import { assertEqual, done } from "./harness.mjs";
import { createExtensionCommandHandler } from "../extension-command-handler.mjs";

let captured = null;
const runtime = { active: true };
const handler = createExtensionCommandHandler({
  getLoopRuntime: () => runtime,
  handleBacklogCommand: async (sessionId, rawText, options) => {
    captured = { sessionId, rawText, options };
    return "ok";
  },
});

const result = await handler("session-1", "init", { cwd: "C:\\repos\\soda" });

assertEqual(result, "ok", "extension command handler returns shared handler output");
assertEqual(captured.sessionId, "session-1", "extension command handler forwards session id");
assertEqual(captured.rawText, "init", "extension command handler forwards raw text");
assertEqual(captured.options.cwd, "C:\\repos\\soda", "extension command handler preserves command cwd");
assertEqual(captured.options.loopRuntime, runtime, "extension command handler injects loop runtime");

done("test-extension-command-handler");

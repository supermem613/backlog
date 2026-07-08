export function createExtensionCommandHandler({ handleBacklogCommand, getLoopRuntime }) {
  return (sid, rawText, options = {}) => handleBacklogCommand(sid, rawText, {
    ...options,
    loopRuntime: getLoopRuntime(),
  });
}

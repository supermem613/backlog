export function createExtensionCommandHandler({ handleBacklogCommand }) {
  return (rawText, options = {}) => handleBacklogCommand(rawText, options);
}

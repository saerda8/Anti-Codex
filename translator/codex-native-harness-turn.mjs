import { callAntigravityNativeHarness } from "./antigravity-native-harness-upstream.mjs";
import {
  antigravityCompletionToResponses,
  responsesToAntigravityChat,
} from "./codex-native-protocol.mjs";

export async function runCodexNativeHarnessTurn(request = {}, options = {}) {
  const chatBody = responsesToAntigravityChat(request);
  const routing = chatBody._routing;
  delete chatBody._routing;
  const completion = await (options.callUpstream || callAntigravityNativeHarness)(chatBody, options);
  return antigravityCompletionToResponses(completion, request, { routing });
}

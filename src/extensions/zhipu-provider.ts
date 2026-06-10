/**
 * Zhipu AI (智谱) Provider Extension
 *
 * Zhipu AI provides two API endpoints:
 * 1. OpenAI-compatible: https://open.bigmodel.cn/api/paas/v4 (Flash series, etc.)
 * 2. Anthropic-compatible: https://open.bigmodel.cn/api/anthropic/v1 (Flagship models: glm-5.1, glm-5, etc.)
 *
 * Usage:
 *   export ZHIPU_API_KEY=your-api-key
 *   /model zhipu/glm-5.1     # Anthropic endpoint (flagship)
 *   /model zhipu/glm-4.7     # OpenAI endpoint (standard)
 *   /model zhipu/glm-4.7-flash  # OpenAI endpoint (free)
 *
 * Models reference: https://docs.bigmodel.cn/cn/guide/start/model-overview
 * API docs: https://docs.bigmodel.cn/api-reference/模型-api/对话补全
 * Pricing: https://bigmodel.cn/pricing
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Decode Unicode escape sequences (\uXXXX) in a string.
 * Also strips stray backslashes before CJK characters.
 * Zhipu API sometimes returns error messages with Chinese characters
 * escaped as either \uXXXX or plain \ + char.
 */
function decodeUnicodeEscapes(str: string): string {
  return str
    // Step 1: decode \uXXXX Unicode escape sequences
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    )
    // Step 2: strip stray backslashes before CJK characters
    // (e.g. \已\达\到 → 已达到)
    .replace(/\\(?=[一-鿿㐀-䶿　-〿＀-￯])/g, "");
}

export default function zhipuProvider(pi: ExtensionAPI) {
  // Fix: Decode Unicode escape sequences in error messages from Zhipu API
  pi.on("message_end", (event) => {
    if (
      event.message.role === "assistant" &&
      event.message.stopReason === "error" &&
      event.message.errorMessage
    ) {
      const decoded = decodeUnicodeEscapes(event.message.errorMessage);
      if (decoded !== event.message.errorMessage) {
        return {
          message: { ...event.message, errorMessage: decoded },
        };
      }
    }
  });
}

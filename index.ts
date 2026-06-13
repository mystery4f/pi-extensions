import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extraAgentsFiles from "./src/extensions/extra-agents-files.js";
import autoAddDir from "./src/extensions/auto-add-dir.js";
import zhipuProvider from "./src/extensions/zhipu-provider.js";
import routerBridge from "./src/extensions/router-bridge.js";
import { registerPatchTool } from "./src/extensions/patch/index.js";
import codegraphGuidance from "./src/extensions/codegraph-guidance.js";

export default function (pi: ExtensionAPI) {
	// 注册扩展（各自注册事件 handler，但不再各自发 notify）
	extraAgentsFiles(pi);
	autoAddDir(pi);
	zhipuProvider(pi);
	routerBridge(pi);
	// registerPatchTool(pi);
	// codegraphGuidance(pi);
}

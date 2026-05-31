import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extraAgentsFiles from "./src/extensions/extra-agents-files.js";
import autoAddDir from "./src/extensions/auto-add-dir.js";

export default function (pi: ExtensionAPI) {
	extraAgentsFiles(pi);
	autoAddDir(pi);
}

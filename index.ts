import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extraAgentsFiles from "./src/extensions/extra-agents-files.js";

export default function (pi: ExtensionAPI) {
	extraAgentsFiles(pi);
}

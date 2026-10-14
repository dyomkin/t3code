// Packaged app entry. Enables the compile cache before the main bundle loads,
// so the cache also covers main.cjs itself.
// Keep this fork's data and updates independent of the upstream installation.
process.env.T3CODE_HOME ||= require("node:path").join(require("node:os").homedir(), ".t3-qoder");
process.env.T3CODE_DISABLE_AUTO_UPDATE ??= "true";
require("./compileCache.cjs");
require("./main.cjs");

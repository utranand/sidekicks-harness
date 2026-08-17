// lib/package-lifecycle/index.mjs
// Public barrel — re-exports pure engine functions only.
// Verb `run` entries (versions, create, transfer, preview) are NOT re-exported here;
// they are reached exclusively via the dispatcher's lazy import().

export {
  ensureComponentVersions,
  compareVersions,
  checkComponentVersions,
} from "./componentVersions.mjs";

export { generateCleanSettings } from "./config.mjs";
export { generatePackageManifest } from "./manifest.mjs";
export { buildCopyPlan } from "./plan.mjs";
export { assemblePackage } from "./assemble.mjs";
export { validateSource, validatePackage } from "./validate.mjs";
export { overlayPackage } from "./overlay.mjs";
export { computeImportClosure } from "./closure.mjs";

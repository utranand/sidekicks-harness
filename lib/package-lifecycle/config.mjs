// lib/package-lifecycle/config.mjs
// Clean-settings generator for the package assembly engine.
// Produces the settings.json content that boots the package tied to no individual.
// Barrel-exported.

/**
 * Return the clean settings object for a freshly assembled package.
 * The package resets to the root-project default (active_project = "sidekicks",
 * active_service = null) so it is not tied to any individual's workspace.
 * config.yaml is deliberately NOT generated — no secrets, relying on skill defaults.
 *
 * @returns {{ active_project: string, active_service: null }}
 */
export function generateCleanSettings() {
  return {
    active_project: "sidekicks",
    active_service: null,
  };
}

// lib/sk-cli/errors.mjs
// Zero imports — stdlib-only, sanctioned back-edge per architecture §Module Composition Graph rule 3.
// Every other lib/ module imports SidekicksError and EXIT_* constants from here.

export class SidekicksError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "SidekicksError";
    this.exitCode = exitCode;
  }
}

// Canonical exit-code constants — always reference by name, never by bare number.
export const EXIT_OK         = 0;
export const EXIT_USAGE      = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_NOT_FOUND  = 2; // alias of 2 — semantic clarity at call sites
export const EXIT_IO         = 3;
export const EXIT_GIT        = 4;

// `agent wait` / `agent heartbeat` verb-local exit codes (lib/agent-lifecycle/wait.mjs,
// heartbeat.mjs) — these are ordinary (non-throwing) return codes the standby loop
// branches on, not SidekicksError exits, but they alias the same numbers above for
// consistency; named separately here because their semantics are verb-specific.
export const EXIT_AGENT_MESSAGES       = 0; // numeric overload with EXIT_OK
export const EXIT_AGENT_TIMEOUT        = 2; // numeric overload with EXIT_VALIDATION
export const EXIT_AGENT_STOP           = 3; // numeric overload with EXIT_IO
export const EXIT_AGENT_FOREIGN_SESSION = 4; // numeric overload with EXIT_GIT

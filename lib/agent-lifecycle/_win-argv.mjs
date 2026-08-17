// lib/agent-lifecycle/_win-argv.mjs
// The one audited Windows argument boundary for agent launch and delegate wake.
//
// WHY THIS IS HARD, briefly. Windows has TWO parsers, and an argument crosses both:
//
//   1. `cmd.exe` parses the command line for metacharacters — `& | < > ( ) ^ " %` and, with delayed
//      expansion on, `!`. It does this BEFORE anything else, and double quotes do NOT protect
//      `%VAR%` or `!VAR!`; a `&` inside quotes is safe from cmd, but a lone quote earlier in the
//      line silently changes what "inside quotes" even means.
//   2. The C runtime (`CommandLineToArgvW`) then splits the surviving text into argv, with its own
//      rules for `"` and for backslash runs preceding a quote.
//
// The old code did neither: `"${s.replace(/"/g, '\\"')}"` is a partial CRT encoder, and `cmd.exe`
// does not honour backslash-escaped quotes for its own parse at all. Charter and prompt text —
// author-controlled, and reaching this function verbatim — could therefore close the quote and
// append commands to the launch line.
//
// THE ENCODING. Wrap for the CRT (quote the argument, double any internal quote), then caret-escape
// every cmd metacharacter in the whole result INCLUDING the quotes just added. cmd sees no special
// characters, strips the carets, and hands the CRT a well-formed quoted argument. This is the same
// shape as the fix for CVE-2024-24576 (the Rust `.bat` argument-injection advisory), and the reason
// it has to escape the quotes too: leaving them bare lets `%` and a stray quote cooperate to end the
// quoted region early.
//
// Newlines cannot be escaped for cmd at all — they end the command. They are stripped, not encoded.
//
// NOT `shell: true`. That would hand the same text to a shell one layer further out and re-open the
// hole from the other side. Callers pass argv arrays and, where a `.cmd` shim forces a cmd layer,
// build that one line here.
//
// Zero npm dependencies — node:* only (and it imports nothing).

/** Characters cmd.exe acts on. `%` and `!` are included: quotes do not protect either. */
const CMD_META = /[()%!^"<>&|]/g;

/** CR and LF terminate a cmd line; there is no escape for them. */
const CMD_UNENCODABLE = /[\r\n]/g;

/**
 * Encode one argument so `cmd.exe` passes it through to a program's argv unchanged.
 *
 * @param {string} s
 * @returns {string} a token safe to place in a cmd command line
 */
export function cmdEscapeArg(s) {
  const flat = String(s).replace(CMD_UNENCODABLE, ' ');
  // CRT layer: quote the argument; a literal quote is written as "" inside a quoted argument.
  const quoted = `"${flat.replace(/"/g, '""')}"`;
  // cmd layer: caret-escape everything cmd would otherwise act on, the wrapping quotes included.
  return quoted.replace(CMD_META, (c) => `^${c}`);
}

/**
 * Encode a whole argv as one `cmd.exe` command line.
 *
 * The executable name goes through the same encoder as its arguments — a path with a space, an `&`
 * or parentheses (`C:\Program Files (x86)\…`) is the ordinary case on Windows, not an exotic one.
 *
 * @param {string[]} argv - [executable, ...args]
 * @returns {string}
 */
export function cmdCommandLine(argv) {
  return argv.map((a) => cmdEscapeArg(a)).join(' ');
}

/**
 * Spawn options for invoking a `.cmd` / `.bat` shim safely.
 *
 * Node refuses to `spawn()` a `.cmd` directly since the CVE-2024-24576 fix (EINVAL), which is why
 * `resolveHeadlessBin` returning `claude.cmd` produced a delegate wake that could never run: the
 * name resolved, the spawn did not. The shim needs a `cmd.exe` layer — but supplying one with
 * `shell: true` would pass the arguments through Node's own quoting and then through cmd's parser,
 * which is the injection path this module exists to close.
 *
 * Instead: invoke `%ComSpec%` explicitly with `/d` (skip AutoRun, which can otherwise inject
 * commands from the registry), `/s` (take the rest of the line verbatim) and `/c`, hand it ONE
 * pre-encoded line, and set `windowsVerbatimArguments` so Node does not re-quote what is already
 * quoted. Delayed expansion stays off — it is off by default, and `/v:off` is not accepted here —
 * which is why `!` is caret-escaped by the encoder rather than relied on to be inert.
 *
 * @param {string[]} argv - [shimPath, ...args]
 * @returns {{command: string, args: string[], options: {windowsVerbatimArguments: true}}}
 */
export function cmdShimSpawn(argv) {
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return {
    command: comspec,
    // The whole encoded line is ONE token after /c; /s tells cmd to use it verbatim.
    args: ['/d', '/s', '/c', cmdCommandLine(argv)],
    options: { windowsVerbatimArguments: /** @type {true} */ (true) },
  };
}

/**
 * Whether a resolved executable needs the `cmd.exe` layer above.
 *
 * @param {string} bin
 * @returns {boolean}
 */
export function isCmdShim(bin) {
  return /\.(cmd|bat)$/i.test(String(bin));
}

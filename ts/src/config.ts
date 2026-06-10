// Tiny flag/env parser shared by the entrypoints.

export function parseFlags(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) continue;
    const key = a.replace(/^-+/, "");
    if (key.includes("=")) {
      const eq = key.indexOf("=");
      out.set(key.slice(0, eq), key.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.set(key, next);
        i++;
      } else {
        out.set(key, "true");
      }
    }
  }
  return out;
}

export function pick(
  flags: Map<string, string>,
  name: string,
  env: string,
  def: string,
): string {
  return flags.get(name) ?? process.env[env] ?? def;
}

/** Parse a listen address like ":9981" or "0.0.0.0:9981" into host+port. */
export function parseAddr(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(":");
  const host = idx > 0 ? addr.slice(0, idx) : "";
  const port = Number(addr.slice(idx + 1));
  return { host: host || "0.0.0.0", port };
}

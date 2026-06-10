import { basename } from "node:path";
import { parseFlags, pick } from "../config.js";
import { DEFAULT_BLOCK_SIZE } from "../proto.js";
import { Client } from "./client.js";

function usage(): void {
  console.error(`usage: dssctl [--coordinator URL] [--block-size N] <command> [args]

commands:
  upload <localpath> [remotename]
  download <remotename> [localpath]
  ls
  rm <remotename>

env:
  MINIDSS_COORDINATOR  override default coordinator URL`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const coord = pick(flags, "coordinator", "MINIDSS_COORDINATOR", "http://127.0.0.1:9981");
  const blockSize = Number(flags.get("block-size") ?? DEFAULT_BLOCK_SIZE);

  // positional args = argv items that aren't flags or flag-values
  const positional = positionalArgs(process.argv.slice(2));
  if (positional.length === 0) {
    usage();
    process.exit(2);
  }

  const client = new Client(coord, blockSize);
  const cmd = positional[0];

  switch (cmd) {
    case "upload": {
      if (positional.length < 2) return fail();
      const local = positional[1]!;
      const name = positional[2] ?? basename(local);
      await client.upload(local, name);
      break;
    }
    case "download": {
      if (positional.length < 2) return fail();
      const name = positional[1]!;
      const out = positional[2] ?? name;
      const n = await client.download(name, out);
      console.log(`wrote ${n} bytes to ${out}`);
      break;
    }
    case "ls": {
      const files = await client.list();
      if (files.length === 0) {
        console.log("(empty)");
        break;
      }
      console.log("NAME".padEnd(32) + "SIZE".padEnd(12) + "STATE".padEnd(10) + "SHA256");
      for (const f of files) {
        const sha = f.sha256.length > 16 ? f.sha256.slice(0, 16) + "..." : f.sha256;
        console.log(
          f.name.padEnd(32) + String(f.size).padEnd(12) + f.state.padEnd(10) + sha,
        );
      }
      break;
    }
    case "rm": {
      if (positional.length < 2) return fail();
      await client.remove(positional[1]!);
      console.log(`deleted ${positional[1]}`);
      break;
    }
    default:
      return fail();
  }
}

function fail(): never {
  usage();
  process.exit(2);
}

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  const valued = new Set(["coordinator", "block-size"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      const key = a.replace(/^-+/, "").split("=")[0]!;
      // skip the following token if this flag consumes a value and didn't use '='
      if (valued.has(key) && !a.includes("=")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

main().catch((err) => {
  console.error("error:", err instanceof Error ? err.message : err);
  process.exit(1);
});

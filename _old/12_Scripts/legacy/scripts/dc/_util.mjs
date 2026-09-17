import fs from "node:fs";
import path from "node:path";

export function die(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}

export function toRel(p) {
  return path.relative(process.cwd(), p).replace(/\\/g, "/");
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    die(`Invalid JSON: ${toRel(p)}\n${e.message}`);
  }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  console.log("📝 wrote:", toRel(p));
}

export function parseArgsPositional(argv, usage) {
  const args = argv.slice(2).filter(Boolean);
  if (!args.length) die(usage);
  return args;
}

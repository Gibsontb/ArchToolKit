// ATK migrate:report - wrapper for migrate:all (kept for future expansion)
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, ["scripts/migrate/run-all.mjs", ...args], { stdio: "inherit" });
process.exit(res.status ?? 0);

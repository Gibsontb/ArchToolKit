// scripts/package.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const masterPath = path.join(repoRoot, "data", "master", "master-matrix.json");
const distDir = path.join(repoRoot, "dist");
const webDir = path.join(repoRoot, "web");

if (!fs.existsSync(masterPath)) {
  console.error("❌ Missing data/master/master-matrix.json");
  process.exit(1);
}

const master = JSON.parse(fs.readFileSync(masterPath, "utf8"));
const version = master.catalog_version || "unversioned";
fs.mkdirSync(distDir, { recursive: true });

const outZip = path.join(distDir, `ATK-${version}.zip`);

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

if (process.platform === "win32") {
  // PowerShell Compress-Archive
  const ps = [
    `$ErrorActionPreference='Stop'`,
    `if (Test-Path "${outZip}") { Remove-Item "${outZip}" -Force }`,
    // Zip the key folders (data, generated, web) + scripts + schemas + package.json + README
    `Compress-Archive -Path ` +
      `"${path.join(repoRoot, "data")}",` +
      `"${path.join(repoRoot, "generated")}",` +
      `"${webDir}",` +
      `"${path.join(repoRoot, "scripts")}",` +
      `"${path.join(repoRoot, "schemas")}",` +
      `"${path.join(repoRoot, "package.json")}",` +
      `"${path.join(repoRoot, "README.md")}" ` +
      `-DestinationPath "${outZip}" -Force`
  ].join("; ");

  run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`);
} else {
  // zip on mac/linux
  const rel = (p) => path.relative(repoRoot, p).replace(/\\/g, "/");
  const items = [
    "data",
    "generated",
    "web",
    "scripts",
    "schemas",
    "package.json",
    "README.md"
  ].map((x) => `"${x}"`).join(" ");

  // Ensure zip exists
  run(`cd "${repoRoot}" && command -v zip >/dev/null 2>&1 || (echo "zip not installed" && exit 1)`);
  // Recreate archive
  run(`cd "${repoRoot}" && rm -f "${rel(outZip)}" && zip -r "${rel(outZip)}" ${items}`);
}

console.log(`✅ Packaged: ${outZip}`);

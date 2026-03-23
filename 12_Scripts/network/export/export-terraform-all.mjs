import { execSync } from "child_process";
for (const p of ["aws", "azure", "gcp", "oci"]) {
  try {
    execSync(`node 12_Scripts/network/export/export-terraform-${p}.mjs`, { stdio: "inherit" });
  } catch (e) {
    console.error(`Failed export for ${p}`);
    process.exitCode = 1;
  }
}

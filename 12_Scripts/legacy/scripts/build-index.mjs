import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const webDir = path.join(root, "web");
const workspacesPath = path.join(webDir, "workspaces.json");
const indexPath = path.join(webDir, "index.html");

if (!fs.existsSync(workspacesPath)) {
  console.error("Missing web/workspaces.json");
  process.exit(1);
}
if (!fs.existsSync(indexPath)) {
  console.error("Missing web/index.html");
  process.exit(1);
}

const workspaces = JSON.parse(fs.readFileSync(workspacesPath, "utf-8"));

function renderLink(w){
  const cls = w.style === "primary" ? "tool-button" : "tool-button secondary";
  const label = String(w.label || w.id || "Workspace");
  const href = String(w.href || "#");
  // Keep exact markup/style used by ATK index
  return `
              <!-- ${label} -->
              <a class="${cls}" href="${href}">
                <span class="label">${label.replace(/&/g,"&amp;")}</span>
                <span>↗</span>
              </a>`;
}

const html = fs.readFileSync(indexPath, "utf-8");

// Find the "Your Workspaces" button-row and replace its contents only.
const reBlock = /(Your Workspaces<\/h2>[\s\S]*?<div class="button-row">)([\s\S]*?)(<\/div>)/i;
const m = html.match(reBlock);
if (!m){
  console.error("Could not find 'Your Workspaces' button-row in index.html");
  process.exit(1);
}

const links = workspaces.map(renderLink).join("\n\n");
const out = html.replace(reBlock, `$1\n\n${links}\n\n            $3`);

fs.writeFileSync(indexPath, out, "utf-8");
console.log("Rebuilt web/index.html from web/workspaces.json");

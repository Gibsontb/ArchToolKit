import fs from "fs";
import path from "path";

const generatedDir = path.resolve("13_Web/static/generated");

function fileForProvider(provider) {
  return path.join(generatedDir, `${provider}.services.generated.json`);
}

export function loadCatalog(provider) {
  const f = fileForProvider(provider);
  if (!fs.existsSync(f)) return { provider, found: false, regions: [], services: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    return { provider, found: true, raw, regions: extractRegions(raw), services: extractServices(raw) };
  } catch (err) {
    return { provider, found: true, error: String(err), regions: [], services: [] };
  }
}

export function extractRegions(raw) {
  const found = new Set();
  const add = v => { if (typeof v === "string" && v.trim()) found.add(v.trim()); };

  if (Array.isArray(raw?.regions)) raw.regions.forEach(add);
  if (Array.isArray(raw?.metadata?.regions)) raw.metadata.regions.forEach(add);
  if (Array.isArray(raw?.infrastructure?.regions)) raw.infrastructure.regions.forEach(add);

  const arrs = [];
  if (Array.isArray(raw?.services)) arrs.push(raw.services);
  if (Array.isArray(raw?.items)) arrs.push(raw.items);
  if (Array.isArray(raw)) arrs.push(raw);

  for (const arr of arrs) {
    for (const item of arr) {
      if (Array.isArray(item?.regions)) item.regions.forEach(add);
      add(item?.region);
      add(item?.location);
    }
  }
  return Array.from(found).sort();
}

export function extractServices(raw) {
  const normalize = item => ({
    id: item?.id || item?.service_id || item?.name || "",
    name: item?.name || item?.service_name || item?.displayName || "",
    category: item?.category || item?.type || item?.family || "",
    capability_name: item?.capability_name || item?.capability || "",
    regions: item?.regions || (item?.region ? [item.region] : [])
  });

  if (Array.isArray(raw?.services)) return raw.services.map(normalize);
  if (Array.isArray(raw?.items)) return raw.items.map(normalize);
  if (Array.isArray(raw)) return raw.map(normalize);
  return [];
}

export function suggestServices(provider, logicalType) {
  const catalog = loadCatalog(provider);
  const services = catalog.services || [];
  const keywords = {
    internet_gateway: ["internet gateway", "gateway", "front door", "lb"],
    nat_gateway: ["nat gateway", "nat"],
    transit_router: ["transit", "router", "route server", "virtual wan", "drg", "cloud router"],
    firewall: ["firewall", "network firewall", "waf", "security"],
    edge_lb: ["load balancer", "application gateway", "front door", "alb", "nlb", "external lb"],
    internal_lb: ["internal load balancer", "load balancer"],
    dns: ["dns", "resolver", "private dns", "route 53", "cloud dns"],
    hybrid: ["vpn", "direct connect", "expressroute", "interconnect", "fastconnect"],
    cache: ["cache", "redis", "cdn", "cloudfront", "memorystore"]
  };
  const terms = keywords[logicalType] || [logicalType.replace(/_/g, " ")];
  return services.filter(s => {
    const hay = `${s.name} ${s.category} ${s.capability_name}`.toLowerCase();
    return terms.some(k => hay.includes(k));
  }).slice(0, 8);
}

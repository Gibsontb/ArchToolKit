// web/migrate/catalog-matcher.js
// Loads provider catalogs from ../cloud-decision-logic-kit/data/*-services.js and performs fuzzy matching.
//
// IMPORTANT:
// Your provider files are "browser globals" (they attach to window.CDK.providers.<id>),
// not ES module exports. So we import them for side-effects, then read window.CDK.

const PROVIDER_FILES = {
  "AWS": "../cloud-decision-logic-kit/data/aws-services.js",
  "AZURE": "../cloud-decision-logic-kit/data/azure-services.js",
  "GCP": "../cloud-decision-logic-kit/data/gcp-services.js",
  "OCI": "../cloud-decision-logic-kit/data/oci-services.js",
};

const PROVIDER_IDS = {
  "AWS": "aws",
  "AZURE": "azure",
  "GCP": "gcp",
  "OCI": "oci",
};

const CAPABILITY_SYNONYMS = {
  iam: ["iam","identity","access","entra","directory","id"],
  monitoring: ["monitor","monitoring","metrics","logs","logging","observability","apm"],
  secrets: ["secrets","key","vault","kms","hsm","credentials"],
  objectStorage: ["object","blob","s3","storage","bucket"],
  computeVm: ["compute","vm","virtual machine","instance","ec2","compute engine"],
  blockStorage: ["block","disk","volume","ebs","managed disk"],
  fileStorage: ["file","nfs","efs","fsx","file storage","filestore"],
  managedDb: ["database","db","rds","sql","postgres","mysql","oracle","managed database"],
  networking: ["vpc","vnet","network","subnet","routing","gateway","load balancer","lb"],
  security: ["security","waf","firewall","defender","guard","ddos"],
};

function tokenize(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function flattenProviderServices(providerObj){
  // Expected shape (your catalogs):
  // window.CDK.providers.<id> = { serviceCategories: { "<cat>": { services: [ {name,...}, ... ] } } }
  const out = [];
  if (!providerObj) return out;

  const cats = providerObj.serviceCategories || {};
  for (const k of Object.keys(cats)){
    const cat = cats[k] || {};
    const services = Array.isArray(cat.services) ? cat.services : [];
    for (const s of services){
      if (typeof s === "string"){
        out.push({ name: s, category: k, keywords: tokenize(s + " " + k) });
      } else if (s && typeof s === "object"){
        const name = s.name || s.service || s.title || s.product || "";
        if (!name) continue;
        const keywords = []
          .concat(tokenize(name))
          .concat(tokenize(s.category || ""))
          .concat(tokenize(k))
          .concat(tokenize((s.tags||[]).join(" ")))
          .concat(tokenize((s.keywords||[]).join(" ")));
        out.push({ ...s, name, keywords });
      }
    }
  }
  return out;
}

const cache = new Map();

export async function loadProviderCatalog(provider){
  const p = String(provider||"").toUpperCase();
  if (cache.has(p)) return cache.get(p);

  const file = PROVIDER_FILES[p];
  const id = PROVIDER_IDS[p];
  if (!file || !id) throw new Error("Unknown provider: " + provider);

  // Import for side-effects: populates window.CDK.providers[id]
  await import(file);

  const root = (window.CDK && window.CDK.providers) ? window.CDK.providers : null;
  if (!root || !root[id]) throw new Error("Provider catalog not found on window.CDK.providers." + id);

  const normalized = flattenProviderServices(root[id]).filter(x=>x && x.name);
  cache.set(p, normalized);
  return normalized;
}

function scoreMatch(service, queryTokens){
  const set = new Set(service.keywords || []);
  let overlap = 0;

  for (const t of queryTokens){
    if (set.has(t)) overlap += 3;
    else {
      for (const kw of set){
        if (kw.startsWith(t) || t.startsWith(kw)) { overlap += 1; break; }
      }
    }
  }

  // bonus: shorter names tend to be more "core" products
  const len = tokenize(service.name).length;
  overlap += Math.max(0, 4 - len);

  return overlap;
}

export async function findClosestServices(provider, capabilityKey, extraTerms=[]){
  const catalog = await loadProviderCatalog(provider);
  const cap = CAPABILITY_SYNONYMS[capabilityKey] || [capabilityKey];
  const queryTokens = tokenize(cap.join(" ") + " " + (extraTerms||[]).join(" "));

  const scored = catalog.map(s=>({ s, score: scoreMatch(s, queryTokens) }))
    .filter(x=>x.score > 0)
    .sort((a,b)=>b.score-a.score);

  return scored.slice(0, 6).map(x=>x.s.name || "Unknown");
}

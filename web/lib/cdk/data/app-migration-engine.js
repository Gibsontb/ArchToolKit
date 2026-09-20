// Copyright Theodore B C Gibson, Cloud Agnostic Architect
// 02/12/2026
// Version 1.0
// Application Migration & Modernization Engine (EAMME)
// Plugs into the existing Cloud Decision Kit (CDK) provider service catalogs.
// Exposes: window.CDK.appMigration (score + classify + cloudTarget + playbook + export helpers)

(function () {
  "use strict";

  window.CDK = window.CDK || {};
  window.CDK.providers = window.CDK.providers || {};

  const CDK = window.CDK;

  // -------- Utilities --------
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function asNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function normStr(s) { return String(s || "").trim(); }
  function lower(s) { return normStr(s).toLowerCase(); }

  function uniq(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr || []) {
      const k = String(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  }

  // Deterministic core service mapping per provider (fallback to fuzzy if not found)
  const DETERMINISTIC_CORE = {
    azure: {
      iam: ["Microsoft Entra ID", "Azure Active Directory"],
      monitoring: ["Azure Monitor", "Log Analytics", "Application Insights"],
      secrets: ["Azure Key Vault"],
      objectStorage: ["Azure Blob Storage", "Blob Storage", "ADLS", "Data Lake Storage"],
      blockStorage: ["Azure Managed Disks", "Managed Disks"],
      fileStorage: ["Azure Files", "Azure NetApp Files"],
      backupArchive: ["Azure Backup", "Recovery Services Vault", "Backup"],
      storageTransfer: ["Azure Data Box", "Storage Mover", "Data Factory"],
      computeVm: ["Azure Virtual Machines", "Virtual Machines", "VM"],
      managedDb: ["Azure SQL Managed Instance", "Azure SQL Database", "PostgreSQL", "MySQL"]
    },
    aws: {
      iam: ["IAM"],
      monitoring: ["CloudWatch"],
      secrets: ["Secrets Manager", "KMS", "SSM Parameter Store"],
      objectStorage: ["S3", "Glacier", "S3 Glacier", "Glacier Deep Archive"],
      blockStorage: ["EBS", "Elastic Block Store"],
      fileStorage: ["EFS", "FSx", "FSx for Windows", "FSx for Lustre", "FSx for NetApp ONTAP", "FSx for OpenZFS"],
      backupArchive: ["AWS Backup", "Backup", "Snapshot", "Glacier"],
      storageTransfer: ["DataSync", "Transfer Family", "Snowball", "Storage Gateway"],
      computeVm: ["EC2"],
      managedDb: ["RDS", "Aurora", "RDS for SQL Server"]
    },
    gcp: {
      iam: ["Cloud IAM"],
      monitoring: ["Cloud Monitoring", "Cloud Logging", "Operations"],
      secrets: ["Secret Manager", "KMS"],
      objectStorage: ["Cloud Storage", "GCS"],
      blockStorage: ["Persistent Disk"],
      fileStorage: ["Filestore"],
      backupArchive: ["Backup and DR", "Backup", "Archive"],
      storageTransfer: ["Storage Transfer Service", "Transfer Appliance"],
      computeVm: ["Compute Engine"],
      managedDb: ["Cloud SQL", "AlloyDB", "Spanner"]
    },
    oci: {
      iam: ["Identity"],
      monitoring: ["Monitoring", "Logging"],
      secrets: ["Vault"],
      objectStorage: ["Object Storage", "Archive Storage"],
      blockStorage: ["Block Volume"],
      fileStorage: ["File Storage"],
      backupArchive: ["Backup", "Recovery", "Archive"],
      storageTransfer: ["Data Transfer", "Transfer"],
      computeVm: ["Compute"],
      managedDb: ["Autonomous Database", "Database"]
    }
  };

  function deterministicMatch(providerId, capabilityKey, serviceList, limit = 8) {
    const preferred = (DETERMINISTIC_CORE[providerId] || {})[capabilityKey] || [];
    const out = [];
    for (const p of preferred) {
      const hit = (serviceList || []).find(s => String(s).toLowerCase().includes(String(p).toLowerCase()));
      if (hit && !out.some(x => String(x).toLowerCase() === String(hit).toLowerCase())) {
        out.push(hit);
        if (out.length >= limit) break;
      }
    }
    return out.length ? out : null;
  }

  // Route-aware capability sets (keeps the list relevant to the chosen course of action)
  function getCapabilitiesForRoute(route, app) {
    const r = String(route || "").toLowerCase();
    const stack = String(app.primaryStack || "").toLowerCase();
    const db = String(app.database || "").toLowerCase();

    // Base set always recommended
    const base = ["iam","monitoring","secrets","objectStorage","computeVm","blockStorage","fileStorage","managedDb"];

    if (r === "rehost") {
      // Focus on IaaS basics for lift-and-shift
      return ["iam","monitoring","secrets","computeVm","blockStorage","fileStorage","networking","objectStorage","security","backupArchive","storageTransfer"];
    }
    if (r === "replatform") {
      // Managed services + platform improvements
      return ["iam","monitoring","secrets","managedDb","containers","objectStorage","networking","security","integration","ciCd","backupArchive","storageTransfer"];
    }
    if (r === "refactor") {
      // App modernization capabilities
      return ["iam","monitoring","secrets","containers","apiGateway","integration","eventing","managedDb","objectStorage","ciCd","security","backupArchive","storageTransfer"];
    }
    if (r === "repurchase") {
      // SaaS shift: identity + integration + data
      return ["iam","monitoring","secrets","integration","apiGateway","objectStorage","security"];
    }
    if (r === "retain" || r === "retire") {
      return base;
    }
    return base;
  }

  // Optional compliance guardrails: if catalogs include compliance tags, prefer matches that satisfy them.
  function normalizeComplianceList(list){
    const arr = Array.isArray(list) ? list : String(list||"").split(/[;,]/);
    return arr.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean);
  }

  function complianceIsRegulated(c){
    return ["fedramp_low","fedramp_moderate","fedramp_high","cjis","itar","itars","cmmc","fisma"].includes(c);
  }

  // If we can detect compliance metadata on service objects, filter/boost them.
  function filterByComplianceIfPossible(providerObj, capabilityKey, matches, compliance){
    // If matches are strings, we can't filter by metadata.
    // Return as-is (safe fallback).
    if (!providerObj) return matches;

    // Build a name->serviceObj map for services in this capability category.
    const cats = providerObj.serviceCategories || {};
    const catList = Array.isArray(cats) ? cats : (cats && typeof cats==="object" ? Object.values(cats) : []);

    const svcObjs = [];
    for (const cat of catList){
      const services = (cat && Array.isArray(cat.services)) ? cat.services : [];
      for (const s of services){
        if (s && typeof s === "object" && s.name) svcObjs.push(s);
      }
    }
    if (!svcObjs.length) return matches;

    const regulated = normalizeComplianceList(compliance).some(complianceIsRegulated);
    if (!regulated) return matches;

    // If service has fields like fedramp/cjis/itar or tags containing those, prefer those first.
    const norm = normalizeComplianceList(compliance);
    const want = new Set(norm);

    const scoreSvc = (s)=>{
      let score = 0;
      const tags = []
        .concat(Array.isArray(s.tags) ? s.tags : [])
        .concat(Array.isArray(s.compliance) ? s.compliance : [])
        .concat(Array.isArray(s.frameworks) ? s.frameworks : [])
        .map(x=>String(x||"").toLowerCase());

      for (const w of want){
        if (tags.includes(w)) score += 3;
        // common alias
        if (w.startsWith("fedramp") && tags.includes("fedramp")) score += 2;
        if (w === "itars" && tags.includes("itar")) score += 2;
      }
      if (s.fedramp === true && norm.some(x=>x.startsWith("fedramp"))) score += 3;
      return score;
    };

    const ranked = matches.map(name=>{
      const obj = svcObjs.find(o=>String(o.name).toLowerCase() === String(name).toLowerCase());
      return { name, score: obj ? scoreSvc(obj) : 0 };
    }).sort((a,b)=>b.score-a.score);

    return ranked.map(x=>x.name);
  }

  // DB-aware deterministic overrides (refines managedDb picks)
  function refineDeterministicForDb(providerId, app, serviceList, currentMatch){
    const db = String(app.database || "").toLowerCase();

    // Azure: SQL Server Always On -> SQL Managed Instance preferred
    if (providerId === "azure" && db.includes("sql server")){
      const preferred = ["Azure SQL Managed Instance", "Azure SQL Database", "SQL Managed Instance"];
      for (const p of preferred){
        const hit = serviceList.find(s => String(s).toLowerCase().includes(String(p).toLowerCase()));
        if (hit) return [hit];
      }
    }
    // AWS: SQL Server -> RDS for SQL Server preferred if catalog includes it
    if (providerId === "aws" && db.includes("sql server")){
      const preferred = ["RDS for SQL Server", "Amazon RDS"];
      for (const p of preferred){
        const hit = serviceList.find(s => String(s).toLowerCase().includes(String(p).toLowerCase()));
        if (hit) return [hit];
      }
    }
    return currentMatch;
  }

  // Flatten provider services into a single list for matching
  function getProviderServiceList(providerId) {
    const p = (CDK.providers || {})[providerId];
    if (!p) return [];

    const cats = p.serviceCategories;

    // ATK provider catalogs use an object map:
    // serviceCategories: { "<Category>": { services: [ {name,...}, ... ] } }
    // but older variants may use an array. Support both.
    const catList = Array.isArray(cats)
      ? cats
      : (cats && typeof cats === "object" ? Object.values(cats) : []);

    const all = [];
    for (const cat of (catList || [])) {
      const services = (cat && Array.isArray(cat.services)) ? cat.services : [];
      for (const svc of services) {
        if (typeof svc === "string") {
          all.push(svc);
        } else if (svc && typeof svc === "object") {
          const name = svc.name || svc.service || svc.title || svc.product || svc.id || "";
          if (name) all.push(String(name));
        } else {
          all.push(String(svc));
        }
      }
    }
    return uniq(all);
  }

  // Basic keyword scorer for "closest matches" against the master catalog
  function bestMatches(services, keywords, limit = 8) {
    const kws = (Array.isArray(keywords) ? keywords : [keywords]).map(k => lower(k)).filter(Boolean);
    if (!kws.length) return [];
    const scored = [];
    const svcList = services || [];
    for (const s of svcList) {
      const t = lower(s);
      let score = 0;
      for (const k of kws) {
        if (!k) continue;
        if (t === k) score += 25;
        if (t.includes(k)) score += 12;
        // bonus for word boundaries-ish
        if (new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(t)) score += 6;
      }
      if (score > 0) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => x.s);
  }

  function normalizeCompliance(list) {
    const raw = Array.isArray(list) ? list : String(list || "").split(/[;,]/);
    const cleaned = raw.map(x => lower(String(x))).map(x => x.replace(/\s+/g, "_")).filter(Boolean);

    const out = new Set(cleaned);

    // Back-compat aliases
    if (out.has("fedramp")) out.add("fedramp_moderate");

    // FedRAMP implies commercial cloud boundary (FedRAMP authorized offering)
    if (out.has("fedramp_low") || out.has("fedramp_moderate") || out.has("fedramp_high")) {
      out.add("commercial");
    }

    // Normalize common variants
    if (out.has("pci")) { out.delete("pci"); out.add("pci_dss"); }
    if (out.has("iso_27001")) { out.delete("iso_27001"); out.add("iso27001"); }
    if (out.has("soc_2")) { out.delete("soc_2"); out.add("soc2"); }

    return Array.from(out);
  }

  // -------- Scoring Model (0-100) --------
  // User supplies 1-5 ratings; we weight and produce a 0-100 readiness score.
  const WEIGHTS = {
    cloudCompatibility: 20,
    technicalDebt: 20,
    vendorLockRisk: 10,
    complianceComplexity: 15,
    architectureModularity: 15,
    refactorEffort: 20
  };

  function ratingToPct(r) {
    // 1..5 => 0..100 (1=0, 5=100)
    const x = clamp(asNumber(r, 3), 1, 5);
    return ((x - 1) / 4) * 100;
  }

  function computeReadinessScore(ratings) {
    const r = ratings || {};
    const cc = ratingToPct(r.cloudCompatibility);
    const td = ratingToPct(r.technicalDebt);
    const vl = ratingToPct(r.vendorLockRisk);
    const cx = ratingToPct(r.complianceComplexity);
    const am = ratingToPct(r.architectureModularity);
    const re = ratingToPct(r.refactorEffort);

    // Invert "technicalDebt" and "complianceComplexity" and "refactorEffort" for readiness.
    const tdInv = 100 - td;
    const cxInv = 100 - cx;
    const reInv = 100 - re;

    const totalW = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    const weighted =
      (cc * WEIGHTS.cloudCompatibility) +
      (tdInv * WEIGHTS.technicalDebt) +
      ((100 - vl) * WEIGHTS.vendorLockRisk) +
      (cxInv * WEIGHTS.complianceComplexity) +
      (am * WEIGHTS.architectureModularity) +
      (reInv * WEIGHTS.refactorEffort);

    return Math.round(weighted / totalW);
  }

  // -------- 7R + Expanded Course-of-Action --------
  function classifyCourse(app) {
    const a = app || {};
    const flags = a.flags || {};
    const readiness = asNumber(a.readinessScore, 0);

    if (flags.isObsolete || flags.noLongerUsed) {
      return { route: "Retire", rationale: "App appears obsolete/unused; retire to reduce cost/risk." };
    }
    if (flags.vendorSaaSAvailable && !flags.mustStayOnPrem) {
      return { route: "Repurchase", rationale: "Vendor-supported SaaS exists; repurchase reduces ops burden." };
    }
    if (flags.mustStayOnPrem || flags.hardwareBound || flags.mainframeBound) {
      return { route: "Retain", rationale: "Hard dependency (hardware/mainframe/policy) blocks migration now." };
    }

    if (readiness >= 80) return { route: "Refactor", rationale: "High readiness; refactor/modernize to maximize cloud benefits." };
    if (readiness >= 60) return { route: "Replatform", rationale: "Good readiness; replatform to managed services with minimal code change." };
    if (readiness >= 40) return { route: "Rehost", rationale: "Moderate readiness; rehost (lift-and-shift) to reduce data center footprint quickly." };
    if (readiness >= 20) return { route: "Retain", rationale: "Low readiness; retain for now while addressing blockers." };
    return { route: "Retire", rationale: "Very low readiness; retire unless strong business justification exists." };
  }

  // -------- Cloud Targeting --------
  function targetCloud(app) {
    const a = app || {};
    const stack = lower(a.primaryStack || a.language || "");
    const db = lower(a.database || "");
    const vendor = lower(a.vendor || "");
    const compliance = normalizeCompliance(a.compliance || []).map(lower);
    const preference = lower(a.enterpriseStandardCloud || "");
    const sovereignty = !!a.dataSovereigntyRequired;
    const oracleHeavy = db.includes("oracle") || vendor.includes("oracle");
    const microsoftHeavy = stack.includes("c#") || stack.includes(".net") || stack.includes("windows") || db.includes("sql server") || vendor.includes("microsoft");
    const analyticsHeavy = stack.includes("spark") || stack.includes("hadoop") || stack.includes("bigquery") || lower(a.workloadType||"").includes("analytics");
    const aiHeavy = lower(a.workloadType||"").includes("ai") || lower(a.workloadType||"").includes("ml");

    if (preference === "aws" || preference === "azure" || preference === "gcp" || preference === "oci") {
      return { cloud: preference.toUpperCase(), rationale: "Enterprise cloud standard selected." };
    }

    if (sovereignty || compliance.includes("cjis") || compliance.includes("fedramp_low") || compliance.includes("fedramp_moderate") || compliance.includes("fedramp_high") || compliance.includes("itars")) {
      if (microsoftHeavy) return { cloud: "AZURE", rationale: "Regulated/sovereign needs + Microsoft-heavy workload favors Azure." };
      return { cloud: "AWS", rationale: "Regulated/sovereign needs favor mature compliance footprints; AWS is a default fit." };
    }

    if (oracleHeavy) return { cloud: "OCI", rationale: "Oracle-heavy workload favors OCI for licensing/DB alignment." };
    if (microsoftHeavy) return { cloud: "AZURE", rationale: "Microsoft-heavy workload favors Azure integration and licensing alignment." };
    if (analyticsHeavy || aiHeavy) return { cloud: "GCP", rationale: "Analytics/AI workload signals favor GCP’s managed analytics stack." };

    return { cloud: "AWS", rationale: "Default landing zone when no stronger signal is present." };
  }

  // -------- Playbooks (Step-by-step) --------
  const PLAYBOOKS = {
    Rehost: [
      "1) Inventory & dependency map (apps, ports, DNS, AD, certs, integrations).",
      "2) Landing zone alignment (networking, IAM, logging, guardrails).",
      "3) Image/VM strategy (gold images, hardened baselines, patch posture).",
      "4) Data migration approach (block/file/object, replication, cutover plan).",
      "5) Build target environment (subnets, security groups/NSGs, routing).",
      "6) Migration rehearsal (pilot, performance baseline, rollback).",
      "7) Cutover (freeze, final sync, switch DNS, validate).",
      "8) Stabilization (monitoring, backups, DR, incident runbooks).",
      "9) Decommission on-prem (licenses, contracts, CMDB updates)."
    ],
    Replatform: [
      "1) Inventory & dependency map; identify refactor-avoid opportunities.",
      "2) Select managed equivalents (DB, cache, messaging, identity).",
      "3) App/runtime upgrades (OS, language runtime, framework).",
      "4) Externalize state (sessions, files, secrets).",
      "5) CI/CD onboarding (build, test, deploy, IaC).",
      "6) Observability (logs/metrics/traces, SLOs).",
      "7) Migration rehearsal and phased cutover.",
      "8) Optimization (scaling policies, right-sizing, cost controls)."
    ],
    Refactor: [
      "1) Domain decomposition (bounded contexts, service boundaries).",
      "2) Strangler pattern plan (route-by-route replacement).",
      "3) Containerize or serverless design (statelessness, config/secrets).",
      "4) Build platform (Kubernetes or managed runtime + CI/CD).",
      "5) Data strategy (schema evolution, CDC, eventing).",
      "6) Identity modernization (OIDC/OAuth2, centralized IAM).",
      "7) API gateway + contract management (versioning, throttling).",
      "8) Observability & resilience (timeouts, retries, circuit breakers).",
      "9) Progressive delivery (canary/blue-green) and cutover.",
      "10) Post-migration hardening (security, DR, chaos tests)."
    ],
    Repurchase: [
      "1) Validate SaaS fit (features, roadmap, integrations, compliance).",
      "2) Contracting & security review (SSP/SOC2, data residency, SLAs).",
      "3) Data migration plan (export/import, mapping, validation).",
      "4) Identity integration (SSO, MFA, RBAC).",
      "5) Phased rollout (pilot, training, change management).",
      "6) Decommission legacy (archive, legal hold, terminate licenses)."
    ],
    Retain: [
      "1) Document blockers (hardware, latency, policy, vendor constraints).",
      "2) Stabilize and reduce risk (patching, monitoring, backup/DR).",
      "3) Create a modernization backlog (remove coupling, improve modularity).",
      "4) Reassess on a fixed cadence (quarterly/biannually)."
    ],
    Retire: [
      "1) Confirm decommission approval and stakeholder sign-off.",
      "2) Data retention & legal hold review (records schedules).",
      "3) Archive/export data (immutable storage, checksum verification).",
      "4) Turn down services in stages (disable writes, then reads).",
      "5) Remove infra & close contracts/licenses.",
      "6) Update CMDB, diagrams, and runbooks."
    ]
  };

  // -------- Service Mapping Helpers --------
  const INTENTS = {
    computeVm: ["vm", "virtual machine", "compute", "ec2", "compute engine", "instances"],
    managedK8s: ["kubernetes", "k8s", "eks", "aks", "gke", "oke"],
    containerRegistry: ["container registry", "ecr", "acr", "artifact registry", "ocir"],
    objectStorage: ["object storage", "s3", "blob", "cloud storage"],
    blockStorage: ["block", "disk", "volume", "ebs", "managed disk", "persistent disk"],
    fileStorage: ["file", "nfs", "efs", "files", "filestore"],
    managedDb: ["managed database", "sql", "postgres", "mysql", "database", "cloud sql", "autonomous"],
    cache: ["redis", "cache", "memorystore", "elasticache"],
    messaging: ["queue", "messaging", "pub/sub", "service bus", "kafka"],
    monitoring: ["monitor", "logging", "cloudwatch", "monitor", "stackdriver", "observability"],
    secrets: ["secrets", "key vault", "secret manager", "kms"],
    iam: ["iam", "identity", "active directory", "rbac", "oauth", "oidc"],
    apiGateway: ["api gateway", "gateway", "apim", "endpoints"],
    serverless: ["serverless", "functions", "lambda", "cloud functions", "functions"],
    backupArchive: ["backup", "archive", "snapshot", "recovery", "vault", "glacier"],
    storageTransfer: ["transfer", "datasync", "storage gateway", "snowball", "data box", "storage mover", "storage transfer"]
  };

  // CCSM mapping: intent/capability -> CCSM enterprise taxonomy categoryId
  const CCSM_MAP = {
    iam: "identity_iam",
    monitoring: "observability_monitoring",
    secrets: "security_secrets",
    objectStorage: "storage_object",
    computeVm: "compute_vm",
    blockStorage: "storage_block",
    fileStorage: "storage_file",
    managedDb: "database_relational_managed",
    cache: "database_cache",
    messaging: "integration_messaging_queue",
    eventing: "integration_event_bus",
    apiGateway: "integration_api_gateway",
    managedK8s: "containers_kubernetes",
    containerRegistry: "containers_registry",
    serverless: "serverless_functions",
    networking: "networking_vpc_vnet",
    security: "security_waf_ddos",
    backup: "storage_backup_archive",
    dr: "storage_backup_archive",
    backupArchive: "storage_backup_archive",
    storageTransfer: "storage_transfer",
    integration: "integration_workflow_orchestration",
    ciCd: "devops_ci_cd",
    containers: "containers_kubernetes"
  };

  function getCcsCandidates(providerId, capabilityKey) {
    const idx = (CDK && CDK.ccsmIndex) ? CDK.ccsmIndex : null;
    if (!idx || !idx.index) return [];
    const catId = CCSM_MAP[capabilityKey] || null;
    if (!catId) return [];
    const cat = idx.index[catId];
    if (!cat || !cat.providers) return [];
    const list = cat.providers[providerId] || [];
    return (list || []).map(x => x && x.name ? String(x.name) : "").filter(Boolean);
  }

  function intersectByName(preferred, providerServiceList) {
    const set = new Map();
    for (const s of providerServiceList || []) {
      set.set(String(s).toLowerCase(), String(s));
    }
    const out = [];
    for (const p of preferred || []) {
      const hit = set.get(String(p).toLowerCase());
      if (hit) out.push(hit);
    }
    return uniq(out);
  }

  function recommendServices(providerId, route, app) {
    const services = getProviderServiceList(providerId);
    const providerObj = (CDK.providers || {})[providerId];
    const rec = {};
    const methods = {};

    const a = app || {};
    const compliance = a.compliance || [];

    // Prefer route-aware capability set if available (keeps the list relevant)
    let intents = [];
    if (typeof getCapabilitiesForRoute === "function") {
      intents = getCapabilitiesForRoute(route, a);
    }

    // Fallback to prior fixed sets
    if (!Array.isArray(intents) || !intents.length) {
      const baseIntents = ["iam", "monitoring", "secrets", "objectStorage"];
      const rehostIntents = ["computeVm", "blockStorage", "fileStorage", "managedDb"];
      const replatformIntents = ["computeVm", "managedDb", "cache", "messaging", "apiGateway"];
      const refactorIntents = ["managedK8s", "containerRegistry", "serverless", "apiGateway", "managedDb", "messaging", "cache"];
      if (route === "Rehost") intents = baseIntents.concat(rehostIntents);
      else if (route === "Replatform") intents = baseIntents.concat(replatformIntents);
      else if (route === "Refactor") intents = baseIntents.concat(refactorIntents);
      else intents = baseIntents;
    }

    for (const key of intents) {
      let matches = [];

      const isStorageFamily = ["objectStorage","blockStorage","fileStorage","backupArchive","storageTransfer"].includes(String(key));
      const limit = isStorageFamily ? 10 : 6;

      // 1) Deterministic core (fast, obvious picks like S3/EC2/etc.)
      const det = deterministicMatch(providerId, key, services, limit);
      if (det && det.length) {
        matches = det;
        if (key === "managedDb") {
          matches = refineDeterministicForDb(providerId, a, services, matches);
        }
        methods[key] = "deterministic core";
      } else {
        // 2) CCSM-first (canonical category -> provider services)
        const ccsm = getCcsCandidates(providerId, key);
        const intersect = intersectByName(ccsm, services);
        if (intersect.length) {
          matches = intersect.slice(0, limit);
          methods[key] = "CCSM match";
        } else if (ccsm.length) {
          matches = uniq(ccsm).slice(0, limit);
          methods[key] = "CCSM candidates";
        } else {
          // 3) Fuzzy fallback (existing behavior)
          matches = bestMatches(services, INTENTS[key], limit);
          methods[key] = "closest matches";
        }
      }

      // Optional compliance boost when metadata exists
      if (matches.length) {
        matches = filterByComplianceIfPossible(providerObj, key, matches, compliance);
      }

      // UI-safe: keep arrays of strings for current renderers.
      // For storage family capabilities, prefix first item as PRIMARY and remaining as RELATED.
      if (matches.length && isStorageFamily) {
        const formatted = [];
        const first = String(matches[0] || "");
        formatted.push(first.startsWith("PRIMARY:") ? first : ("PRIMARY: " + first));
        for (const m of matches.slice(1)) {
          const s = String(m || "");
          formatted.push(s.startsWith("RELATED:") ? s : ("RELATED: " + s));
        }
        matches = formatted;
      }

      rec[key] = matches.length ? matches : ["(No close match found in catalog)"];
    }

    rec._meta = { methods };
    return rec;
  }

  // -------- Export --------
  function buildRecord(app, results) {
    return {
      meta: {
        engine: "CDK EAMME",
        version: "1.0",
        generatedAt: new Date().toISOString()
      },
      application: app,
      results
    };
  }

  function downloadJson(filename, obj) {
    const data = JSON.stringify(obj, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // -------- Public API --------
  CDK.appMigration = {
    computeReadinessScore,
    normalizeCompliance,
    classifyCourse,
    targetCloud,
    playbooks: PLAYBOOKS,
    recommendServices,
    buildRecord,
    downloadJson
  };
})();

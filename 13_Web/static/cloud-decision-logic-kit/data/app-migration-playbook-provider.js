// app-migration-playbook-provider.js
// Add-on: provider-specific playbook steps without modifying the core engine file.
(function(){
  "use strict";
  const CDK = window.CDK = window.CDK || {};
  CDK.appMigration = CDK.appMigration || {};

  function norm(list){
    const arr = Array.isArray(list) ? list : String(list||"").split(/[;,]/);
    return arr.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean);
  }
  function isRegulated(c){
    return ["fedramp_low","fedramp_moderate","fedramp_high","cjis","itar","itars","cmmc","fisma"].includes(c);
  }

  function providerBullets(providerId, key){
    const p = String(providerId||"").toLowerCase();
    const map = {
      aws: {
        landing: ["Control Tower/Organizations", "IAM Identity Center", "CloudTrail + Config", "GuardDuty (baseline)"],
        images: ["AMI pipeline (EC2 Image Builder)", "SSM Patch Manager", "Inspector baseline"],
        data: ["DMS (DB)", "DataSync (file)", "Snowball (bulk)"],
        net: ["VPC/Subnets/RTs", "Security Groups + NACLs", "PrivateLink where needed"],
        ops: ["CloudWatch alarms/dashboards", "AWS Backup", "DR: pilot light / warm standby"]
      },
      azure: {
        landing: ["Azure Landing Zone", "Management Groups", "Azure Policy baseline", "Entra ID + Log Analytics/Sentinel"],
        images: ["Azure Image Builder", "Update Manager", "Defender for Cloud baseline"],
        data: ["Database Migration Service", "AzCopy/ADF", "Azure File Sync (file)"],
        net: ["VNet/Subnets", "NSGs + UDRs", "Private Endpoints where needed"],
        ops: ["Azure Monitor alerts", "Azure Backup", "Site Recovery (where applicable)"]
      },
      gcp: {
        landing: ["Org/Folders + Projects", "IAM baseline", "Cloud Logging", "Security Command Center; VPC-SC if needed"],
        images: ["Image families", "OS Config", "patch management policy"],
        data: ["Database Migration Service", "Storage Transfer Service", "Transfer Appliance (bulk)"],
        net: ["VPC/Subnets", "Firewall rules", "Cloud NAT; PSC where needed"],
        ops: ["Cloud Monitoring alerts", "Backup strategy", "multi-zone/regional DR patterns"]
      },
      oci: {
        landing: ["Compartments", "IAM baseline", "Logging", "Cloud Guard"],
        images: ["Custom images", "OS Management Service", "vuln scanning"],
        data: ["OCI Database Migration", "Object Storage bulk transfer", "Data Transfer Appliance"],
        net: ["VCN/Subnets", "NSGs/Security Lists", "Service Gateway where needed"],
        ops: ["Monitoring + Alarms", "Backups", "multi-AD/region DR patterns"]
      }
    };
    const m = map[p] || map.aws;
    return m[key] || [];
  }

  function getPlaybook(providerId, route, app){
    const p = String(providerId||"").toLowerCase();
    const r = String(route||"").toLowerCase();
    const regulated = norm(app && app.compliance).some(isRegulated);

    const steps = [];
    const add = (title, bullets)=>{
      steps.push(title);
      (bullets||[]).forEach(b => steps.push("   • " + b));
    };

    add("1) Inventory & dependency map (apps, ports, DNS, AD, certs, integrations).", [
      "Confirm workload context: users, peak windows, batch schedules",
      "Map dependencies; document ports, DNS, certs, service accounts, integrations",
      "Capture runtime needs: OS baseline, middleware versions, JVM/.NET versions, agents"
    ]);

    add("2) Landing zone alignment (networking, IAM, logging, guardrails).", [
      regulated ? "Enable regulated guardrails early: central logging, tight egress, strong IAM, evidence retention." :
                  "Establish org/subscriptions/projects, IAM baseline, logging, guardrails.",
      ...providerBullets(p, "landing")
    ]);

    add("3) Image/VM strategy (gold images, hardened baselines, patch posture).", [
      ...providerBullets(p, "images"),
      "Hardened baseline aligned to STIG/CIS where applicable"
    ]);

    add("4) Data migration approach (block/file/object, replication, cutover plan).", [
      "Choose replication: online (continuous) vs offline (bulk) vs hybrid",
      "Define cutover: freeze window, final sync, verification, rollback criteria",
      ...providerBullets(p, "data")
    ]);

    add("5) Build target environment (subnets, security groups/NSGs, routing).", [
      ...providerBullets(p, "net"),
      regulated ? "Prefer private connectivity (DX/ExpressRoute/Interconnect/FastConnect); minimize public endpoints" : null
    ].filter(Boolean));

    add("6) Migration rehearsal (pilot, performance baseline, rollback).", [
      "Pilot first: non-prod or low-risk slice",
      "Record baselines: latency, throughput, job duration, error rates",
      "Validate rollback: snapshots/backups, DNS revert, traffic shift reversal"
    ]);

    add("7) Cutover (freeze, final sync, switch DNS, validate).", [
      "Execute runbook: freeze, final sync, promote primary, switch endpoints",
      "Smoke tests + business validation; confirm monitoring/alerts"
    ]);

    add("8) Stabilization (monitoring, backups, DR, incident runbooks).", [
      ...providerBullets(p, "ops"),
      regulated ? "Centralize logs and retain per policy; document IR runbooks and evidence collection" : null
    ].filter(Boolean));

    add("9) Decommission on-prem (licenses, contracts, CMDB updates).", [
      "Validate retention and legal holds before shutdown",
      "Update CMDB/contracts/monitoring; reclaim IPs and DNS records"
    ]);

    if (r === "refactor"){
      add("Modernization addendum (Refactor).", [
        "Strangler pattern: carve domains, define API contracts, iterate safely",
        "Adopt containers/platform; build CI/CD with automated tests and gates",
        "Eventing/integration: queues/topics/event bus; retries + idempotency"
      ]);
    } else if (r === "replatform"){
      add("Platform addendum (Replatform).", [
        "Move to managed DB/queue/cache where possible; reduce ops burden",
        "Standardize observability: logs/metrics/traces; define SLOs"
      ]);
    } else if (r === "rehost"){
      add("Lift-and-shift addendum (Rehost).", [
        "Prioritize speed: replicate VMs, keep OS/app stack initially",
        "Plan post-migration hardening: patching, right-sizing, managed services later"
      ]);
    }

    return steps;
  }

  // Non-breaking: only add if missing
  if (!CDK.appMigration.getPlaybook){
    CDK.appMigration.getPlaybook = getPlaybook;
  }
})();

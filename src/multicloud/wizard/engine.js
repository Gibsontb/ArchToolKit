/**
 * The decision wizard's recommendation engine.
 *
 * Ported from the previous toolkit's multi-cloud-decision-matrix.html. The
 * logic is the original, unchanged: the same per-cloud service selection, the
 * same cyber checklist, DR patterns, sizing plan and onboarding playbook, and
 * the same Word export.
 *
 * This file is JavaScript rather than TypeScript on purpose. It IS the original
 * JavaScript, and annotating ninety-seven kilobytes of it would have meant
 * touching every function — each touch a chance to change what one produces.
 * The boundary is typed instead, in engine.d.ts, so everything that calls into
 * it is checked even though the inside is not. The build copies this through
 * untouched.
 *
 * Two mechanical changes, and no others:
 *
 *  - The DOM lookups go through the three helpers below, so this file has no
 *    hidden dependency on being inside a particular page.
 *  - Step navigation, header text and path-group visibility are not here. Those
 *    are page mechanics, and the page controller owns them so this page looks
 *    and behaves like the rest of the toolkit.
 *
 * The functions read their inputs from the DOM by element id, so the page must
 * render the inputs with the ids these expect. WIZARD_STEPS in ./steps.ts is
 * the single list of those, which is why the two cannot drift apart.
 */

const byId = (id) => document.getElementById(id);
const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => Array.from(document.querySelectorAll(selector));

/** Which cloud the wizard is designing for. Set by the page controller. */
export let currentCloud = 'azure';

export function setCurrentCloud(cloud) {
  currentCloud = cloud;
}

/** Which step is showing. The validator reads it. */
export let currentStep = 1;

export function setCurrentStep(step) {
  currentStep = step;
}

export function getMultiSelectValues(select) {
      if (!select) return [];
      return Array.from(select.options)
        .filter(o => o.selected)
        .map(o => o.value);
    }

export function getCheckedValues(name) {
      const nodes = qsa('input[name="' + name + '"]:checked');
      return Array.from(nodes).map(n => n.value);
    }

export function clearErrors() {
      ["error-step-1", "error-step-2", "error-step-3", "error-step-4"].forEach(id => {
        const el = byId(id);
        if (el) el.textContent = "";
      });
    }

export function validateStep(step) {
      clearErrors();
      let missing = [];

      if (step === 1) {
        const initiativeType = byId("initiativeType").value;
        const workloadName = byId("workloadName").value.trim();
        const architectureType = byId("architectureType").value;
        const trafficPattern = byId("trafficPattern").value;
        const latencySensitivity = byId("latencySensitivity").value;
        const teamSkills = getMultiSelectValues(byId("teamSkills"));

        if (!initiativeType) missing.push("Initiative type");
        if (!workloadName) missing.push("Workload / initiative name");
        if (!architectureType) missing.push("Architecture type");
        if (!trafficPattern) missing.push("Traffic pattern");
        if (!latencySensitivity) missing.push("Latency sensitivity");
        if (teamSkills.length === 0) missing.push("Team strengths");

        if (missing.length > 0) {
          const el = byId("error-step-1");
          if (el) el.textContent =
            "Missing: " + missing.join(", ") + ". You can continue, but recommendations will be more generic.";
        }

      } else if (step === 2) {
        const dataType = byId("dataType").value;
        const dataSensitivity = byId("dataSensitivity").value;

        if (!dataType || !dataSensitivity) {
          const el = byId("error-step-2");
          if (el) el.textContent =
            "Set at least primary data pattern and data sensitivity / sector for better recommendations.";
        }

      } else if (step === 3) {
        const criticality = byId("criticality").value;
        const iaCTools = getMultiSelectValues(byId("iaCTools"));

        if (!criticality || iaCTools.length === 0) {
          const el = byId("error-step-3");
          if (el) el.textContent =
            "Business criticality and IaC / automation tooling are empty. Set them to drive HA/DR, migration and automation guidance.";
        }

      } else if (step === 4) {
        const envChecked = qsa('input[name="envScope"]:checked').length;
        if (!envChecked) {
          const el = byId("error-step-4");
          if (el) el.textContent =
            "Select at least one environment (typically Prod plus Dev/Test) for meaningful sizing guidance.";
        }
      }

      return true; // soft validation only
    }

export function buildSummaryPills(state) {
      const pills = [];

      if (state.workloadName) pills.push("Workload: " + state.workloadName);

      const pathMap = {
        "new-service": "New service",
        "existing-service": "Existing service change",
        "maintenance": "Maintenance / operations",
        "migration": "Migration"
      };
      if (state.initiativeType) {
        const label = pathMap[state.initiativeType] || state.initiativeType;
        pills.push("Path: " + label);
      }

      // Path-specific detail
      if (state.initiativeType === "new-service" && state.newServiceType) {
        const nsMap = {
          "customer-facing": "Customer-facing app",
          "internal-lob": "Internal LOB app",
          "data-analytics-platform": "Data / analytics platform",
          "integration-hub": "Integration / API hub",
          "shared-platform": "Shared platform"
        };
        pills.push("New type: " + (nsMap[state.newServiceType] || state.newServiceType));
      }
      if (state.initiativeType === "existing-service" && state.existingChangeType) {
        const ecMap = {
          "scale-ha": "Scale / resilience",
          "features": "New features",
          "compliance": "Compliance & security",
          "cost": "Cost optimization",
          "modernization": "Modernization",
          "customer-facing": "Customer-facing app",
          "internal-lob": "Internal LOB app",
          "data-analytics-platform": "Data / analytics platform",
          "integration-hub": "Integration / API hub",
          "shared-platform": "Shared platform"
        };
        pills.push("Change: " + (ecMap[state.existingChangeType] || state.existingChangeType));
      }
      if (state.initiativeType === "maintenance" && state.maintenanceFocus) {
        const mfMap = {
          "patching": "Patching & updates",
          "performance": "Performance tuning",
          "incident-reduction": "Incident reduction",
          "cost": "Cost & housekeeping",
          "slo-reporting": "SLOs & reporting"
        };
        pills.push("Ops focus: " + (mfMap[state.maintenanceFocus] || state.maintenanceFocus));
      }
      if (state.initiativeType === "migration" && state.migrationScope) {
        const msMap = {
          "single-app": "Single app",
          "portfolio": "App portfolio",
          "dc-estate": "DC / estate",
          "db-only": "DB/data-only"
        };
        pills.push("Migration scope: " + (msMap[state.migrationScope] || state.migrationScope));
      }

      if (state.architectureType) pills.push("Architecture: " + state.architectureType);
      if (state.dataType) pills.push("Data: " + state.dataType);
      if (state.dataSensitivity) pills.push("Sensitivity: " + state.dataSensitivity);
      if (state.criticality) pills.push("Criticality: " + state.criticality);
      if (state.sourceEnv) pills.push("Source: " + state.sourceEnv);
      if (state.migrationApproach) pills.push("7R: " + state.migrationApproach);
      if (state.iaCTools && state.iaCTools.length > 0) pills.push("IaC: " + state.iaCTools.join(", "));
      return pills;
    }

export function buildSizingPlan(cloud, state) {
      const {
        peakUsers,
        peakRps,
        dataVolumeBand,
        dailyIngestBand,
        retentionPeriod,
        envScope = [],
        nonProdScale,
        regionCount,
        trafficPattern,
        criticality,
        dataType,
        dataSensitivity,
        geoPattern,
        latencySensitivity
      } = state;

      const users = Number(peakUsers) || 0;
      const rps = Number(peakRps) || 0;
      const envs = Array.isArray(envScope) ? envScope : [];

      let trafficBand = "moderate";
      if (rps >= 2000 || users >= 50000 || trafficPattern === "spiky") {
        trafficBand = "high";
      } else if ((rps && rps <= 100) || (users && users <= 5000) || trafficPattern === "low") {
        trafficBand = "low";
      }

      let computeSize = "Small–medium footprint";
      if (trafficBand === "low") computeSize = "Small footprint";
      if (trafficBand === "high") computeSize = "Medium–large footprint";

      if (criticality === "tier0" || criticality === "tier1") {
        computeSize += ", multi-AZ / multi-zone for HA";
      }

      let dataBandLabel = "";
      switch (dataVolumeBand) {
        case "xs": dataBandLabel = "sub-100 GB"; break;
        case "s": dataBandLabel = "100 GB – 1 TB"; break;
        case "m": dataBandLabel = "1 – 5 TB"; break;
        case "l": dataBandLabel = "5 – 20 TB"; break;
        case "xl": dataBandLabel = "20 TB+"; break;
      }

      let ingestLabel = "";
      switch (dailyIngestBand) {
        case "light": ingestLabel = "light daily change"; break;
        case "medium": ingestLabel = "moderate daily change"; break;
        case "heavy": ingestLabel = "heavy daily ingest"; break;
        case "very-heavy": ingestLabel = "very heavy streaming / ingest"; break;
      }

      let retentionLabel = "";
      switch (retentionPeriod) {
        case "short": retentionLabel = "short-term retention"; break;
        case "standard": retentionLabel = "standard (months–couple of years) retention"; break;
        case "long": retentionLabel = "long-term (multi-year) retention"; break;
        case "very-long": retentionLabel = "very long / archival retention"; break;
      }

      let storageTier;
      if (!retentionPeriod) {
        storageTier = "Mix of hot and cool storage tiers based on access patterns.";
      } else if (retentionPeriod === "short" || retentionPeriod === "standard") {
        storageTier = "Primarily hot / warm storage, with some cool tiering for older data.";
      } else {
        storageTier = "Hot storage for active data plus aggressive use of cool / archive tiers for retained data.";
      }

      if (
        dataSensitivity === "regulated" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6"
      ) {
        storageTier += " Ensure encryption-at-rest, KMS/HSM key management and retention policies aligned to regulatory requirements.";
      }

      let networkTier = "Standard regional connectivity.";
      if (
        geoPattern === "multi-region" ||
        regionCount === "2" ||
        regionCount === "2-active" ||
        regionCount === "3plus"
      ) {
        networkTier = "Multi-region design with private connectivity and global entry points (front door / anycast / global load balancer).";
      } else if (latencySensitivity === "ultra-low") {
        networkTier = "Single-region, low-latency design with zonal redundancy and careful placement.";
      }

      const envLabels = {
        dev: "Dev",
        test: "Test",
        stage: "Pre-prod / Stage",
        prod: "Prod",
        dr: "DR"
      };

      let nonProdFactor = 0.5;
      switch (nonProdScale) {
        case "full": nonProdFactor = 1; break;
        case "half": nonProdFactor = 0.5; break;
        case "quarter": nonProdFactor = 0.25; break;
        case "minimal": nonProdFactor = 0.1; break;
      }

      const rows = [];
      envs.forEach(env => {
        const isProd = env === "prod";
        const factor = isProd ? 1 : nonProdFactor;
        const sizeLabel =
          trafficBand === "low" ? "Small" :
          trafficBand === "high" ? "Large" :
          "Medium";

        const envCompute = isProd ? sizeLabel : sizeLabel + " × " + factor;
        const envNotes = isProd
          ? "Primary live workload."
          : "Scaled to ~" + Math.round(factor * 100) + "% of prod capacity.";

        rows.push(
          "<tr>" +
            "<td>" + (envLabels[env] || env) + "</td>" +
            "<td>" + envCompute + "</td>" +
            "<td>" + envNotes + "</td>" +
          "</tr>"
        );
      });

      let matrixHtml;
      if (rows.length) {
        matrixHtml = `
          <table class="sizing-table">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Relative size</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${rows.join("")}
            </tbody>
          </table>
        `;
      } else {
        matrixHtml = "<p>No environments selected yet. Tick at least Prod plus relevant non-prod environments in Step 4.</p>";
      }

      const providerName =
        cloud === "azure" ? "Azure" :
        cloud === "aws"   ? "AWS" :
        cloud === "gcp"   ? "Google Cloud" :
                            "Oracle Cloud Infrastructure";

      const main = `
        <p>This is a <strong>${trafficBand}</strong> traffic workload on <strong>${providerName}</strong> with a <strong>${computeSize}</strong>.</p>
        <p>Data footprint: ${dataBandLabel || "not specified"}; ${ingestLabel || "ingest not specified"}; ${retentionLabel || "retention not specified"}.</p>
      `;

      const notes = `
        <p>${storageTier}</p>
        <p>${networkTier}</p>
        <p>Use this as the starting point for T-shirt sizing, cost estimation, and environment build-out in your landing zones.</p>
      `;

      return {
        main,
        notes,
        matrixHtml
      };
    }

export function buildDrPatternCard(state, cloud) {
      const {
        geoPattern,
        regionCount,
        rto,
        rpo,
        criticality,
        sourceEnv,
        migrationApproach,
        iaCTools
      } = state;

      const lines = [];

      const multiRegion =
        geoPattern === "multi-region" ||
        regionCount === "2" ||
        regionCount === "2-active" ||
        regionCount === "3plus";

      const tightRto = rto === "mins" || rto === "hour";
      const tightRpo = rpo === "zero" || rpo === "15min";

      let patternLabel = "Backup & restore";
      if (multiRegion && tightRto && tightRpo) {
        patternLabel = "Active-active multi-region";
      } else if (multiRegion && (tightRto || tightRpo)) {
        patternLabel = "Warm standby / active-passive";
      } else if (!multiRegion && (criticality === "tier0" || criticality === "tier1")) {
        patternLabel = "Single-region Tier 0/1 (risk accepted)";
      }

      const base =
        "Recommended DR pattern: " +
        patternLabel +
        " based on your RTO/RPO targets and regional footprint.";

      lines.push(base);

      const key = (cloud || "").toLowerCase();
      if (key === "aws") {
        lines.push(
          "AWS: use a primary + secondary region with Route 53, multi-AZ data stores, cross-region replication, and runbooks for promotion/failback."
        );
      } else if (key === "azure") {
        lines.push(
          "Azure: pair regions with Front Door/Traffic Manager, zone-redundant data, Geo-replication, and documented failover workflows."
        );
      } else if (key === "gcp") {
        lines.push(
          "GCP: use multi-region or paired regional setup with global load balancing, regional SLOs, and tested failover playbooks."
        );
      }

      if (sourceEnv || migrationApproach || (iaCTools && iaCTools.length)) {
        lines.push(
          "Bake DR changes into your CI/CD pipeline and infrastructure-as-code templates so that failover paths, health checks, and runbooks stay in sync with production."
        );
      } else {
        lines.push(
          "Capture DR patterns as code (IaC) and include DR checks in your CI/CD pipelines so deployments and failover plans stay aligned."
        );
      }

      return "<p>" + lines.join(" ") + "</p>";
    }

export function buildCyberChecklist(state, cloud) {
      const {
        criticality,
        dataSensitivity,
        securityBaseline,
        secOpsMaturity,
        geoPattern,
        regionCount,
        rto,
        rpo,
        dataProtection,
        perimeterPattern,
        f5Usage,
        iaCTools,
        ciCdTools
      } = state;

      const items = [];

      const regulated =
        dataSensitivity === "regulated" ||
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      const isPublicSector =
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      const multiRegion =
        geoPattern === "multi-region" ||
        regionCount === "2" ||
        regionCount === "2-active" ||
        regionCount === "3plus";

      const tightRto = rto === "mins" || rto === "hour";
      const tightRpo = rpo === "zero" || rpo === "15min";

      const baselineLabel =
        securityBaseline === "minimal"
          ? "minimal"
          : securityBaseline === "standard"
          ? "standard enterprise"
          : securityBaseline === "regulated"
          ? "regulated / high-sensitivity"
          : securityBaseline === "stig"
          ? "DoD/STIG-aligned"
          : securityBaseline || "unspecified";

      if (regulated || isPublicSector) {
        if (securityBaseline === "minimal") {
          items.push(
            "⚠️ Update the security baseline from minimal to CIS/STIG or an equivalent regulated control set for this data."
          );
        } else {
          items.push(
            "✅ Security baseline set to " +
              baselineLabel +
              " for regulated / public-sector data."
          );
        }
      } else if (securityBaseline && securityBaseline !== "minimal") {
        items.push(
          "✅ Security baseline set to " + baselineLabel + " for this workload."
        );
      }

      if (secOpsMaturity === "basic") {
        items.push(
          "⚠️ Logging & SecOps are basic – centralize cloud and F5 logs, define alert routing, and create at least minimal runbooks."
        );
      } else if (secOpsMaturity === "central-siem") {
        items.push(
          "✅ Central SIEM/SOC in place – ensure this workload and F5 telemetry are onboarded with clear owners for critical alerts."
        );
      } else if (secOpsMaturity === "mature-devsecops") {
        items.push(
          "✅ Mature DevSecOps – keep SAST/DAST, IaC scanning, and policy-as-code in the CI/CD pipeline for this workload."
        );
      }

      if (perimeterPattern === "cloud-plus-f5") {
        items.push(
          "✅ Perimeter: cloud-native firewalls plus F5 WAAP/API security at the edge for critical internet-facing endpoints."
        );
      } else if (perimeterPattern === "f5-centric") {
        items.push(
          "✅ Perimeter: F5 as the primary WAAP/perimeter tier, with cloud-native network controls as a second layer."
        );
      } else {
        items.push(
          "⚠️ Confirm perimeter: rely on cloud-native firewalls/WAF and consider F5 for Tier 0/1 and regulated public endpoints."
        );
      }

      if (Array.isArray(f5Usage) && f5Usage.length) {
        items.push(
          "✅ F5 usage focus identified (" +
            f5Usage.join(", ") +
            ") – align policies, logging, and runbooks to these entry points."
        );
      }

      if (dataProtection === "field-level") {
        items.push(
          "✅ Data protection: field-level protection / tokenization for sensitive fields with isolated key management."
        );
      } else if (dataProtection === "in-transit-and-at-rest") {
        items.push(
          "✅ Data protection: encryption in transit and at rest enabled for all core services."
        );
      } else if (dataProtection === "at-rest") {
        items.push(
          "⚠️ Extend protection: ensure TLS for internal APIs, messaging, and F5 front doors – not just at-rest encryption."
        );
      }

      if (multiRegion && tightRto && tightRpo) {
        items.push(
          "✅ DR: active–active multi-region with aggressive RTO/RPO – verify game days and failover automation."
        );
      } else if (multiRegion && (tightRto || tightRpo)) {
        items.push(
          "✅ DR: warm standby or active–passive multi-region – verify promotion and DNS/traffic failover steps."
        );
      } else if (!multiRegion && (criticality === "tier0" || criticality === "tier1")) {
        items.push(
          "⚠️ DR: Tier 0/1 in a single region – either accept single-region risk explicitly or add a DR region."
        );
      } else {
        items.push(
          "✅ DR: backup-and-restore–centric pattern is acceptable for this criticality and RTO/RPO band."
        );
      }

      if ((iaCTools && iaCTools.length) || (ciCdTools && ciCdTools.length)) {
        items.push(
          "✅ IaC/CI-CD: capture guardrails as code – enforce security baselines, tagging, and perimeter rules through pipelines."
        );
      } else {
        items.push(
          "⚠️ IaC/CI-CD: consider managing landing zone controls and guardrails via infrastructure-as-code and CI/CD pipelines."
        );
      }

      if (!items.length) {
        return "Controls and DR posture look broadly consistent with the selected criticality, data sensitivity, and SecOps maturity.";
      }

      const html = items.map(function (i) { return "<li>" + i + "</li>"; }).join("");
      return "<ul>" + html + "</ul>";
    }

export function buildAssumptionsAndGaps(state, cloud) {
      const {
        criticality,
        uptimeTarget,
        rto,
        rpo,
        dataSensitivity,
        securityBaseline,
        secOpsMaturity,
        geoPattern,
        regionCount
      } = state;

      const bullets = [];

      // Criticality vs availability
      if ((criticality === "tier0" || criticality === "tier1") && (!uptimeTarget || uptimeTarget === "99.9")) {
        bullets.push("High criticality (Tier 0/1) with a relatively weak uptime target – confirm if HA and DR are sufficient.");
      }

      // DR vs geography
      const multiRegion =
        geoPattern === "multi-region" ||
        regionCount === "2" ||
        regionCount === "2-active" ||
        regionCount === "3plus";

      if ((criticality === "tier0" || criticality === "tier1") && !multiRegion) {
        bullets.push("Tier 0/1 without multi-region or an explicit DR region – confirm that single-region risk is acceptable.");
      }

      // Regulated vs baseline / SecOps
      const regulated =
        dataSensitivity === "regulated" ||
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      if (regulated && securityBaseline === "minimal") {
        bullets.push("Regulated or public-sector data with a minimal security baseline – likely not acceptable; align to CIS/STIG or an equivalent control set.");
      }

      if (regulated && secOpsMaturity === "basic") {
        bullets.push("Regulated data with only basic logging – SOC/SIEM coverage, alerting, and runbooks likely need to be strengthened.");
      }

      if (!bullets.length) {
        return "Assumptions look consistent with the selected criticality, DR, and security posture. Use this as a starting point for deeper design reviews.";
      }

      const items = bullets.map(b => "<li>" + b + "</li>").join("");
      return "<ul>" + items + "</ul>";
    }

export function buildHowToPlaybook(cloud, state) {
      const {
        initiativeType,
        newServiceType,
        existingChangeType,
        maintenanceFocus,
        migrationScope,
        workloadName,
        architectureType,
        dataSensitivity,
        criticality,
        sourceEnv,
        migrationApproach,
        iaCTools
      } = state;

      const workloadLabel = workloadName || "this workload";
      const isPublicSector =
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      const isPrivateSectorLabel =
        dataSensitivity === "public" ||
        dataSensitivity === "internal" ||
        dataSensitivity === "confidential" ||
        dataSensitivity === "regulated";

      const sectorLabel =
        isPublicSector
          ? "public sector / impact-level workload"
          : dataSensitivity === "regulated"
          ? "regulated private-sector (financial/PHI) workload"
          : isPrivateSectorLabel
          ? "commercial private-sector workload"
          : "general commercial workload";

      const cloudLabel =
        cloud === "azure" ? "Azure"
        : cloud === "aws" ? "AWS"
        : cloud === "gcp" ? "Google Cloud"
        : "Oracle Cloud Infrastructure";

      const iaCLabel = iaCTools.length > 0
        ? iaCTools.join(", ")
        : "Terraform + cloud-native templates";

      const initLabelMap = {
        "new-service": "new service",
        "existing-service": "change to an existing service",
        "maintenance": "maintenance / operations initiative",
        "migration": "migration initiative"
      };
      const initiativeLabel = initLabelMap[initiativeType] || "cloud initiative";

      let initiativeDetail = "";
      if (initiativeType === "new-service" && newServiceType) {
        const nsMap = {
          "customer-facing": "customer-facing product",
          "internal-lob": "internal line-of-business system",
          "data-analytics-platform": "data / analytics platform",
          "integration-hub": "integration / API hub",
          "shared-platform": "shared platform capability"
        };
        initiativeDetail = nsMap[newServiceType] || newServiceType;
      } else if (initiativeType === "existing-service" && existingChangeType) {
        const ecMap = {
          "scale-ha": "scale & resilience",
          "features": "new feature delivery",
          "compliance": "compliance & security hardening",
          "cost": "cost optimization",
          "modernization": "modernization / tech-refresh"
        };
        initiativeDetail = ecMap[existingChangeType] || existingChangeType;
      } else if (initiativeType === "maintenance" && maintenanceFocus) {
        const mfMap = {
          "patching": "patching & updates",
          "performance": "performance tuning & capacity",
          "incident-reduction": "incident reduction / reliability",
          "cost": "cost optimization & housekeeping",
          "slo-reporting": "SLOs, reporting & governance"
        };
        initiativeDetail = mfMap[maintenanceFocus] || maintenanceFocus;
      } else if (initiativeType === "migration" && migrationScope) {
        const msMap = {
          "single-app": "single-application migration",
          "portfolio": "portfolio migration",
          "dc-estate": "data center / infrastructure estate migration",
          "db-only": "database / data-only migration"
        };
        initiativeDetail = msMap[migrationScope] || migrationScope;
      }

      const sourcePrettyMap = {
        "onprem-vmware": "on-prem VMware estate",
        "onprem-baremetal": "on-prem bare metal / mixed hypervisors",
        "existing-dc": "hosted / co-lo data center",
        "existing-cloud": "existing cloud environment",
        "saas": "SaaS-centric landscape",
        "hybrid": "hybrid on-prem + cloud environment"
      };
      let sourceLabel;
      if (sourceEnv) {
        sourceLabel = sourcePrettyMap[sourceEnv] || sourceEnv;
      } else if (initiativeType === "new-service") {
        sourceLabel = "no existing environment (greenfield)";
      } else {
        sourceLabel = "mixed on-prem / legacy environment";
      }

      const approachPrettyMap = {
        "rehost": "rehost (lift & shift)",
        "replatform": "replatform (minor cloud optimization)",
        "refactor": "refactor / modernize",
        "repurchase": "repurchase (SaaS)",
        "retain": "retain (stay where it is)",
        "retire": "retire (decommission)",
        "relocate": "relocate (VMware-as-a-Service)"
      };
      const approachLabel = migrationApproach
        ? approachPrettyMap[migrationApproach] || migrationApproach
        : "mix of rehost, replatform, and refactor where appropriate";

      return `
        <ol class="howto-list">
          <li>
            <strong>Phase 1 – Intake & discovery.</strong><br>
            Run a kickoff with business, security, and operations. Capture mission and business outcomes for this <em>${initiativeLabel}</em>
            for <em>${workloadLabel}</em>${initiativeDetail ? " focused on <em>" + initiativeDetail + "</em>" : ""}.
            Classify it as a ${sectorLabel}, and document the current hosting situation (${sourceLabel}), including dependencies,
            data flows, and any existing ATO / audit findings.
          </li>
          <li>
            <strong>Phase 2 – Requirements & readiness.</strong><br>
            Define non-functional targets (SLOs/RTO/RPO for the chosen tier ${criticality || "(set tier)"}), compliance scope
            (GLBA, PCI, SOX, NIST 800-53, FedRAMP / DoD SRG, FFIEC as applicable), data residency, and identity/SSO requirements.
            Decide the primary migration or change approach (${approachLabel}) per component and confirm which parts will be retained or retired.
          </li>
          <li>
            <strong>Phase 3 – Landing zone & architecture on ${cloudLabel}.</strong><br>
            Design a secure landing zone: management hierarchy (accounts/subscriptions/projects/tenancies),
            network topology (hub–spoke or mesh), connectivity into CHEDC / enterprise core
            (ExpressRoute / Direct Connect / Interconnect / FastConnect + VPN),
            and baseline guardrails (policies, configuration rules, encryption standards).
            Produce a reference architecture for <em>${workloadLabel}</em> (compute pattern, data services, integration and observability)
            using your cross-cloud service catalog and impact-level rules.
          </li>
          <li>
            <strong>Phase 4 – IaC, automation, and pipelines.</strong><br>
            Implement the landing zone, guardrails, and core shared services using <strong>${iaCLabel}</strong>.
            Stand up CI/CD pipelines (Azure DevOps / GitHub Actions / CodePipeline / Cloud Build / OCI DevOps) for both
            infrastructure and application code. Integrate secret management, image scanning, policy-as-code, and test gates into the pipelines
            so every change to ${workloadLabel} is repeatable and auditable.
          </li>
          <li>
            <strong>Phase 5 – Migration / change planning & wave design.</strong><br>
            ${
              initiativeType === "migration"
                ? "Group systems into migration waves (pilot → early adopters → bulk waves) according to dependency and risk. "
                : "Group work into waves (pilot → early adopters → broader rollout) so you can de-risk changes before full scale. "
            }
            For VMware-heavy estates, plan which systems use native ${cloudLabel} services vs the cloud’s VMware offering.
            Define cutover strategy per wave (blue/green, canary, phased, or big-bang), rollback plans, and detailed runbooks
            for both technical tasks and communications.
          </li>
          <li>
            <strong>Phase 6 – Security, RMF/ATO & controls.</strong><br>
            Map controls to ${cloudLabel} services: identity, network segmentation, key management, logging, vulnerability management,
            and endpoint protection. For IL and financial workloads, inherit CSP controls where allowed and add overlays for gaps.
            Build your control implementation statements, diagrams, test plans, and evidence collection up front, so ATO / audit
            runs in parallel with build and migration rather than after the fact.
          </li>
          <li>
            <strong>Phase 7 – Implementation, rollout & cutover.</strong><br>
            Provision target environments via IaC; harden baselines using Ansible or equivalent configuration management; execute data migrations
            (DB migration services, bulk object transfers, replication). Run rehearsals in lower environments, then execute production wave cutovers
            according to your chosen strategy, with practiced rollbacks. Validate stability, data integrity, and control effectiveness before
            decommissioning legacy environments.
          </li>
          <li>
            <strong>Phase 8 – Monitoring, FinOps & sustainment.</strong><br>
            Turn on full observability (metrics, logs, traces) and wire them into your central SIEM/SOC.
            Implement tagging and cost allocation for FinOps reporting; set budgets and alerts by business service.
            Establish SRE/operations runbooks, on-call rotations, and continuous improvement loops.
            Every quarter, revisit architecture decisions, optimize cost/performance, and incorporate lessons learned into the next wave or initiative.
          </li>
        </ol>
        <p style="margin-top:6px;font-size:0.8rem;color:#9ca3af;">
          Use this playbook as the narrative section in your Word documents and CCoE artifacts.
          For each phase, attach the concrete evidence (diagrams, Terraform plans, Ansible playbooks, migration runbooks, control mappings, and sign-off sheets).
        </p>
      `;
    }

export function generateCloudRecommendation(cloud, state) {
      const {
        initiativeType,
        newServiceType,
        newServiceStage,
        existingChangeType,
        maintenanceFocus,
        migrationScope,
        cutoverStrategy,
        architectureType,
        trafficPattern,
        latencySensitivity,
        teamSkills,
        dataType,
        dataSensitivity,
        writePattern,
        geoPattern,
        integrations,
        criticality,
        uptimeTarget,
        rto,
        rpo,
        timeToMarket,
        opsMaturity,
        securityBaseline,
        identityModel,
        secretsModel,
        dataProtection,
        perimeterPattern,
        f5Usage,
        secOpsMaturity,
        sourceEnv,
        migrationApproach,
        iaCTools
      } = state;

      const hasSkill = s => teamSkills.indexOf(s) !== -1;
      const usesIaC = t => iaCTools.indexOf(t) !== -1;

      const regulated =
        dataSensitivity === "regulated" ||
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      const isPublicSector =
        dataSensitivity === "ps-l2" ||
        dataSensitivity === "ps-l4" ||
        dataSensitivity === "ps-l5" ||
        dataSensitivity === "ps-l6";

      const isPrivateSector =
        dataSensitivity === "public" ||
        dataSensitivity === "internal" ||
        dataSensitivity === "confidential" ||
        dataSensitivity === "regulated";

      const tierLabel =
        criticality === "tier0"
          ? "Tier 0 – mission critical"
          : criticality === "tier1"
          ? "Tier 1 – important internal"
          : criticality === "tier2"
          ? "Tier 2/3 – supporting / batch"
          : "Unspecified";

      const providerName =
        cloud === "azure" ? "Azure" :
        cloud === "aws"   ? "AWS" :
        cloud === "gcp"   ? "Google Cloud" :
                            "Oracle Cloud Infrastructure";

      let computeMain = "General-purpose compute with managed load balancing.";
      let computeNotes = "";
      let dataMain = "Baseline managed data services.";
      let dataNotes = "";
      let integMain = "Standard API gateway and messaging services.";
      let integNotes = "";
      let opsMain = "Baseline observability, security, and governance for this tier.";
      let opsNotes = "";
      let migrationMain = providerName + " migration & onboarding focus.";
      let migrationNotes = "Use native migration tooling and IaC-driven landing zones.";
      let securityMain = "Security and network posture aligned to this workload.";
      let securityNotes = "";
      let drPatternLabel = "";

      /* ===================== AZURE ===================== */
      if (cloud === "azure") {
        // Compute
        if (architectureType === "web-api" || architectureType === "") {
          if ((trafficPattern === "low" || trafficPattern === "medium") && hasSkill("paas")) {
            computeMain =
              "Use <strong>Azure App Service</strong> for the web/API layer, fronted by " +
              "<strong>Azure Application Gateway (WAF)</strong> and optionally <strong>Azure Front Door</strong>.";
            computeNotes =
              "App Service gives managed runtimes and autoscale. Application Gateway provides WAF and TLS offload; Front Door adds global routing.";
          } else if (trafficPattern === "spiky" && hasSkill("serverless")) {
            computeMain =
              "Use <strong>Azure Functions</strong> behind <strong>Azure API Management</strong>.";
            computeNotes =
              "Good for bursty traffic. Use Premium Functions to avoid cold starts. API Management handles auth, quotas, and versioning.";
          } else if (hasSkill("containers")) {
            computeMain =
              "Use <strong>Azure Kubernetes Service (AKS)</strong> or <strong>Azure Container Apps</strong> behind Application Gateway.";
            computeNotes =
              "Container Apps gives simpler PaaS experience; AKS is the full Kubernetes platform. Use node pools, autoscaling, and zones for HA.";
          } else {
            computeMain =
              "Use <strong>Azure Virtual Machines</strong> with <strong>Virtual Machine Scale Sets</strong> behind Application Gateway.";
            computeNotes =
              "Lift & shift baseline. Use availability zones, managed disks, and autoscale rules.";
          }
        } else if (architectureType === "microservices") {
          if (hasSkill("containers")) {
            computeMain =
              "Run microservices on <strong>AKS</strong> with <strong>Azure CNI</strong> networking, fronted by Application Gateway / Front Door.";
            computeNotes =
              "Use GitOps (Flux/Argo), Azure Policy, and Key Vault for config & secrets.";
          } else {
            computeMain =
              "Use <strong>Azure Container Apps</strong> with Dapr for microservices patterns.";
            computeNotes =
              "Container Apps abstracts Kubernetes; use revisions, autoscale, and Dapr building blocks for pub/sub, service discovery, etc.";
          }
        } else if (architectureType === "batch") {
          computeMain =
            "Use <strong>Azure Batch</strong> or <strong>Synapse/Fabric pipelines</strong> scheduled via <strong>Azure Data Factory</strong> or Logic Apps.";
          computeNotes =
            "Batch manages pools of compute VMs; Synapse/Fabric covers ELT/analytics-style jobs.";
        } else if (architectureType === "event-driven") {
          computeMain =
            "Use <strong>Azure Functions</strong> with <strong>Event Grid</strong> / <strong>Event Hubs</strong> triggers.";
          computeNotes =
            "Serverless consumers for events; Event Hubs for high-throughput streams, Event Grid for discrete events.";
        } else if (architectureType === "legacy-vm") {
          computeMain =
            "Lift & shift to <strong>Azure VMs / VM Scale Sets</strong>, or use <strong>Azure VMware Solution (AVS)</strong> if staying on VMware.";
          computeNotes =
            "For on-prem VMware with minimal change, AVS + HCX gives low-friction relocation; otherwise migrate VMs to native Azure with Azure Migrate.";
        } else if (architectureType === "data-analytics") {
          computeMain =
            "Use <strong>Azure Synapse Analytics</strong> or <strong>Microsoft Fabric</strong> with <strong>Azure Data Lake Storage Gen2</strong>.";
          computeNotes =
            "Data flows via Azure Data Factory / Synapse pipelines; consider serverless SQL pools, Spark pools, and Power BI.";
        }

        // Data
        if (dataType === "relational" || dataType === "") {
          dataMain =
            "Use <strong>Azure SQL Database</strong> or <strong>Azure SQL Managed Instance</strong> for core OLTP, with " +
            "<strong>Azure Database for PostgreSQL / MySQL</strong> as needed.";
          dataNotes =
            "Choose single/elastic pools vs managed instance based on compatibility and isolation. Always-on encryption, TDE, and private endpoints for regulated data.";
        } else if (dataType === "nosql") {
          dataMain =
            "Use <strong>Azure Cosmos DB</strong> (Core API, Mongo API, or Cassandra API) for low-latency, globally distributed data.";
          dataNotes =
            "Cosmos DB gives multi-region writes and global distribution. Combine with Azure Functions/Event Grid for reactive patterns.";
        } else if (dataType === "files") {
          dataMain =
            "Use <strong>Azure Blob Storage</strong> or <strong>Azure Data Lake Storage Gen2</strong>, plus <strong>Azure Files</strong> for SMB workloads.";
          dataNotes =
            "Enable private endpoints, lifecycle policies, and immutability (WORM) for regulated/financial data.";
        } else if (dataType === "streaming") {
          dataMain =
            "Use <strong>Azure Event Hubs</strong> or <strong>Azure IoT Hub</strong> for ingestion, landing into Data Lake Storage and/or Synapse.";
          dataNotes =
            "Process streams with Azure Stream Analytics or Synapse/Fabric streaming workloads.";
        } else if (dataType === "analytics-lake") {
          dataMain =
            "Use <strong>Data Lake Storage Gen2</strong> as the lake and <strong>Synapse / Fabric</strong> for lakehouse & analytics.";
          dataNotes =
            "Use Data Factory / Synapse pipelines for ingestion, Microsoft Purview for governance/catalog, and Power BI for BI.";
        }

        if (regulated) {
          dataNotes +=
            (dataNotes ? " " : "") +
            "For regulated workloads, prefer <strong>Azure Government</strong> or appropriately scoped commercial regions, " +
            "with Key Vault / Managed HSM, private endpoints, and Microsoft Purview classification.";
        }

        // Integration
        if (integrations === "simple-http" || integrations === "") {
          integMain =
            "Expose APIs via <strong>Azure API Management</strong> in front of App Service, Functions, or AKS/Container Apps.";
          integNotes =
            "Use JWT / OAuth, rate limiting, and policies. For internal-only APIs, combine with Application Gateway and private endpoints.";
        } else if (integrations === "enterprise-messaging") {
          integMain =
            "Use <strong>Azure Service Bus</strong> (queues/topics) for enterprise messaging.";
          integNotes =
            "Good for ordered, durable messaging between services; pair with Functions or Logic Apps for handlers.";
        } else if (integrations === "event-streaming") {
          integMain = "Use <strong>Event Hubs</strong> with <strong>Stream Analytics</strong> / Synapse.";
          integNotes =
            "Event Hubs for high-throughput event streams; Stream Analytics / Synapse for near-real-time processing.";
        } else if (integrations === "orchestration") {
          integMain =
            "Use <strong>Logic Apps</strong> and/or <strong>Durable Functions</strong> for orchestration of complex workflows.";
          integNotes =
            "Logic Apps offers connectors to SaaS; Durable Functions for stateful orchestration in code.";
        }

        // Ops / resilience
        opsMain =
          "Treat this as <strong>" + tierLabel + "</strong> on Azure and design HA/DR accordingly.";
        if (criticality === "tier0") {
          opsMain +=
            " Use multi-zone deployments and consider active-active or active-passive across paired regions.";
        } else if (criticality === "tier1") {
          opsMain +=
            " Use zone-redundant services and regular backup + DR tests, potentially with secondary region failover.";
        } else if (criticality === "tier2") {
          opsMain +=
            " Single-region with strong backups is often sufficient, but consider zones for key components.";
        }

        opsNotes =
          "Use <strong>Azure Monitor</strong>, <strong>Log Analytics</strong>, and <strong>Application Insights</strong> for observability; " +
          "<strong>Microsoft Sentinel</strong> for SIEM; <strong>Defender for Cloud</strong> and Azure Policy/Blueprints for security posture.";

        if (regulated) {
          opsNotes +=
            " For public sector IL workloads, deploy into <strong>Azure Government</strong> with ExpressRoute + VPN, Entra ID federation, and IL5/IL6-aligned logging to your central SIEM.";
        }

        migrationMain = "Azure migration & onboarding focus.";
        migrationNotes =
          "Use <strong>Azure Migrate</strong> to discover and assess on-prem estates. " +
          "For VMware-heavy environments and 'relocate/rehost' strategies, use <strong>Azure VMware Solution (AVS)</strong> with HCX. " +
          "Provision landing zones with IaC (Terraform or Bicep/ARM) and enforce guardrails via Management Groups and Policy.";

        if (usesIaC("terraform") || usesIaC("cloud-native")) {
          migrationNotes +=
            " Standardize on Terraform and/or Bicep templates for landing zones, VNets, NSGs, and PaaS services, integrating with Azure DevOps or GitHub Actions for CI/CD.";
        }
        if (usesIaC("ansible")) {
          migrationNotes +=
            " Use <strong>Ansible</strong> for OS configuration, middleware setup, and application deployments on Azure VMs / AVS.";
        }

        migrationNotes +=
          " For connectivity into CHEDC or central data centers, use <strong>ExpressRoute + VPN</strong>; send logs to your central SIEM per IL guidance.";
      }

      /* ===================== AWS ===================== */
      else if (cloud === "aws") {
        if (architectureType === "web-api" || architectureType === "") {
          if ((trafficPattern === "low" || trafficPattern === "medium") && hasSkill("serverless")) {
            computeMain =
              "Use <strong>AWS Lambda</strong> behind <strong>Amazon API Gateway</strong>.";
            computeNotes =
              "Great for spiky traffic and pay-per-use. Use provisioned concurrency for strict latency.";
          } else if (hasSkill("paas")) {
            computeMain = "Use <strong>AWS Elastic Beanstalk</strong> or <strong>AWS App Runner</strong>.";
            computeNotes =
              "Beanstalk / App Runner give managed application runtimes with autoscaling, fronted by <strong>Application Load Balancer (ALB)</strong>.";
          } else if (hasSkill("containers")) {
            computeMain =
              "Use <strong>Amazon ECS</strong> (Fargate) or <strong>Amazon EKS</strong> with ALB and AWS App Mesh if needed.";
            computeNotes =
              "Fargate reduces ops burden; EKS for full Kubernetes. Use target groups, autoscaling, and multi-AZ.";
          } else {
            computeMain =
              "Use <strong>Amazon EC2</strong> instances in Auto Scaling groups behind an Application Load Balancer.";
            computeNotes =
              "Baseline lift & shift pattern. Spread across multiple AZs for availability.";
          }
        } else if (architectureType === "microservices") {
          computeMain =
            "Run microservices on <strong>EKS</strong> or <strong>ECS on Fargate</strong> with a shared ALB/API Gateway front end.";
          computeNotes =
            "Use service discovery (Cloud Map), App Mesh (if needed), and GitOps/CI pipelines for deployments.";
        } else if (architectureType === "batch") {
          computeMain =
            "Use <strong>AWS Batch</strong> or <strong>Step Functions + Lambda/ECS</strong> for scheduled jobs.";
          computeNotes =
            "Batch orchestrates jobs over EC2/Fargate. Step Functions for complex stateful workflows.";
        } else if (architectureType === "event-driven") {
          computeMain =
            "Use <strong>Lambda</strong> with <strong>Amazon EventBridge</strong>, <strong>SQS</strong>, and <strong>SNS</strong>.";
          computeNotes =
            "EventBridge for event bus, SQS for queues, SNS for fan-out notifications.";
        } else if (architectureType === "legacy-vm") {
          computeMain =
            "Lift & shift with <strong>AWS Application Migration Service (MGN)</strong> to EC2, or use <strong>VMware Cloud on AWS</strong> for minimal change.";
          computeNotes =
            "MGN for rehost; VMware Cloud on AWS for relocate. Combine with AWS Systems Manager for patching.";
        } else if (architectureType === "data-analytics") {
          computeMain =
            "Use <strong>Amazon Redshift</strong> or <strong>Athena + Glue Data Catalog</strong> over data in <strong>Amazon S3</strong>.";
          computeNotes =
            "Glue ETL/ELT, EMR or Glue for Spark jobs, QuickSight for BI.";
        }

        if (dataType === "relational" || dataType === "") {
          dataMain =
            "Use <strong>Amazon RDS</strong> (PostgreSQL/MySQL/SQL Server/Oracle) or <strong>Amazon Aurora</strong> for OLTP.";
          dataNotes =
            "Multi-AZ for HA, read replicas for scale. Use KMS for encryption and Secrets Manager for creds.";
        } else if (dataType === "nosql") {
          dataMain =
            "Use <strong>Amazon DynamoDB</strong> or <strong>Amazon DocumentDB</strong> for NoSQL workloads.";
          dataNotes =
            "DynamoDB for key-value / document with global tables; DocumentDB for Mongo-compatible workloads.";
        } else if (dataType === "files") {
          dataMain =
            "Use <strong>Amazon S3</strong> for object storage, <strong>Amazon EFS</strong> for shared POSIX, and <strong>Amazon FSx</strong> (NetApp/Windows) when needed.";
          dataNotes =
            "Use S3 bucket policies, encryption, and lifecycle management; Glacier for archives.";
        } else if (dataType === "streaming") {
          dataMain =
            "Use <strong>Amazon Kinesis</strong> or <strong>Amazon MSK (Managed Kafka)</strong> for streaming data.";
          dataNotes =
            "Kinesis Data Streams + Firehose into S3/Redshift; MSK for Kafka-based ecosystems.";
        } else if (dataType === "analytics-lake") {
          dataMain =
            "Use <strong>Amazon S3</strong> as the data lake with <strong>Athena</strong>, <strong>Redshift</strong>, and <strong>Glue</strong>.";
          dataNotes =
            "Glue Data Catalog for metadata, Lake Formation for governance, QuickSight for BI.";
        }

        if (regulated) {
          dataNotes +=
            (dataNotes ? " " : "") +
            "For financial or IL workloads, prefer <strong>AWS GovCloud (US)</strong> or appropriately scoped regions; " +
            "enforce encryption, VPC endpoints, and IAM least privilege.";
        }

        if (integrations === "simple-http" || integrations === "") {
          integMain =
            "Expose APIs via <strong>Amazon API Gateway</strong> or <strong>AWS Application Load Balancer</strong> (HTTP).";
          integNotes =
            "API Gateway for rich API management; ALB for simpler L7 routing direct to services.";
        } else if (integrations === "enterprise-messaging") {
          integMain =
            "Use <strong>SQS</strong> (queues) and <strong>SNS</strong> (pub/sub) as the core messaging layer.";
          integNotes =
            "Durable, decoupled messaging patterns between services and workloads.";
        } else if (integrations === "event-streaming") {
          integMain =
            "Use <strong>Amazon EventBridge</strong> and/or <strong>Kinesis</strong> / <strong>MSK</strong>.";
          integNotes =
            "EventBridge for SaaS and AWS service events; Kinesis/MSK for higher-volume event streams.";
        } else if (integrations === "orchestration") {
          integMain =
            "Use <strong>AWS Step Functions</strong> to orchestrate complex workflows across Lambda, ECS, and other AWS services.";
          integNotes =
            "Visual, state-machine-based orchestration with retries, error handling, and parallelism.";
        }

        opsMain =
          "Treat this as <strong>" + tierLabel + "</strong> on AWS and design HA/DR across AZs (and regions if needed).";
        if (criticality === "tier0") {
          opsMain +=
            " Use multi-AZ + possibly multi-region with Route 53 and global services.";
        } else if (criticality === "tier1") {
          opsMain +=
            " Use multi-AZ for core services with regular DR tests and backups.";
        } else if (criticality === "tier2") {
          opsMain +=
            " Single region with backups may be enough; still consider multi-AZ for stateless tiers.";
        }

        opsNotes =
          "Use <strong>Amazon CloudWatch</strong> for metrics/logs, <strong>AWS X-Ray</strong> for tracing, " +
          "<strong>AWS Config</strong> and <strong>CloudTrail</strong> for governance/audit, and <strong>AWS Security Hub</strong> / <strong>GuardDuty</strong> for security posture.";

        if (regulated) {
          opsNotes +=
            " Connect via <strong>AWS Direct Connect + VPN</strong> into CHEDC or central networks; send logs to IL5/IL6 SIEM per your policy.";
        }

        migrationMain = "AWS migration & onboarding focus.";
        migrationNotes =
          "Use <strong>AWS Migration Hub</strong> and <strong>AWS Application Migration Service (MGN)</strong> for discovery and rehost; " +
          "<strong>AWS Database Migration Service (DMS)</strong> for database moves. " +
          "For 'relocate' VMware workloads, use <strong>VMware Cloud on AWS</strong>.";

        if (usesIaC("terraform") || usesIaC("cloud-native")) {
          migrationNotes +=
            " Provision landing zones and guardrails with <strong>Terraform</strong> and/or <strong>CloudFormation</strong>, " +
            "using Control Tower and Organizations for multi-account structures.";
        }
        if (usesIaC("ansible")) {
          migrationNotes +=
            " Use <strong>Ansible</strong> for OS/middleware configuration, integrated with SSM Session Manager & Run Command.";
        }

        migrationNotes +=
          " For DevSecOps, use <strong>CodePipeline</strong> + <strong>CodeBuild</strong> or your preferred CI/CD, pushing logs into CloudWatch and your central SIEM.";
      }

      /* ===================== GCP ===================== */
      else if (cloud === "gcp") {
        if (architectureType === "web-api" || architectureType === "") {
          if (hasSkill("serverless")) {
            computeMain =
              "Use <strong>Cloud Run</strong> or <strong>Cloud Functions</strong> behind <strong>API Gateway</strong> or <strong>External HTTP(S) Load Balancing</strong>.";
            computeNotes =
              "Cloud Run (containers) and Cloud Functions (functions) both scale to zero; Cloud Run often best for web APIs.";
          } else if (hasSkill("containers")) {
            computeMain =
              "Use <strong>Google Kubernetes Engine (GKE)</strong> behind global HTTP(S) Load Balancing.";
            computeNotes =
              "Use regional clusters with multiple zones; autopilot mode for reduced ops overhead.";
          } else {
            computeMain =
              "Use <strong>Compute Engine</strong> managed instance groups behind HTTP(S) load balancers.";
            computeNotes =
              "Lift & shift baseline with autoscaling and multi-zone deployments.";
          }
        } else if (architectureType === "microservices") {
          computeMain =
            "Run microservices on <strong>GKE</strong> or <strong>Cloud Run</strong> with service-to-service auth via IAM and mTLS.";
          computeNotes =
            "Use Anthos/GKE for hybrid environments if needed; integrate with Config Sync / GitOps.";
        } else if (architectureType === "batch") {
          computeMain =
            "Use <strong>Cloud Run jobs</strong>, <strong>Cloud Functions</strong>, or <strong>Compute Engine with Cloud Scheduler</strong>.";
          computeNotes =
            "For heavy data workloads, combine with Dataflow or Dataproc.";
        } else if (architectureType === "event-driven") {
          computeMain =
            "Use <strong>Cloud Functions</strong> or <strong>Cloud Run</strong> triggered by <strong>Pub/Sub</strong> and <strong>Eventarc</strong>.";
          computeNotes =
            "Pub/Sub + Eventarc capture events from GCP services and custom apps.";
        } else if (architectureType === "legacy-vm") {
          computeMain =
            "Lift & shift to <strong>Compute Engine</strong> (managed instance groups) or use <strong>Google Cloud VMware Engine</strong> for VMware relocation.";
          computeNotes =
            "Combine with Migrate to Virtual Machines or Cloud VMware Engine HCX for minimal-change moves.";
        } else if (architectureType === "data-analytics") {
          computeMain =
            "Use <strong>BigQuery</strong> over data in <strong>Cloud Storage</strong> with <strong>Dataproc</strong> / <strong>Dataflow</strong> for processing.";
          computeNotes =
            "This is the standard lakehouse pattern on GCP.";
        }

        if (dataType === "relational" || dataType === "") {
          dataMain =
            "Use <strong>Cloud SQL</strong> (PostgreSQL/MySQL/SQL Server) or <strong>Cloud Spanner</strong> when you need global consistency and horizontal scale.";
          dataNotes =
            "Private Service Connect for private access, CMEK for encryption, backups and read replicas for HA.";
        } else if (dataType === "nosql") {
          dataMain =
            "Use <strong>Cloud Firestore</strong> or <strong>Cloud Bigtable</strong> depending on your access pattern.";
          dataNotes =
            "Firestore for document-style; Bigtable for high-throughput time-series or wide-column workloads.";
        } else if (dataType === "files") {
          dataMain =
            "Use <strong>Cloud Storage</strong> buckets for objects; <strong>Filestore</strong> for NFS where needed.";
          dataNotes =
            "Use bucket IAM, VPC Service Controls, and Object Lifecycle policies.";
        } else if (dataType === "streaming") {
          dataMain =
            "Use <strong>Pub/Sub</strong> with <strong>Dataflow</strong> for streaming pipelines.";
          dataNotes =
            "Pub/Sub provides durable queues; Dataflow handles transformations, windowing, and loading into BigQuery / Cloud Storage.";
        } else if (dataType === "analytics-lake") {
          dataMain =
            "Use <strong>Cloud Storage</strong> as the lake and <strong>BigQuery</strong> as the analytics engine.";
          dataNotes =
            "Use Dataplex/Data Catalog for governance, Looker for BI, and Dataflow/Dataproc for ETL.";
        }

        if (regulated) {
          dataNotes +=
            (dataNotes ? " " : "") +
            "For public sector or high-sensitivity workloads, use <strong>Assured Workloads</strong> / regulated regions, VPC Service Controls, and CMEK everywhere.";
        }

        if (integrations === "simple-http" || integrations === "") {
          integMain =
            "Expose APIs via <strong>API Gateway</strong> or <strong>Cloud Endpoints</strong>.";
          integNotes =
            "Front door for Cloud Run, GKE, or Functions with auth, quota, and monitoring.";
        } else if (integrations === "enterprise-messaging") {
          integMain =
            "Use <strong>Pub/Sub</strong> as the main asynchronous messaging layer.";
          integNotes =
            "Use multiple subscriptions for fan-out; pair with Functions/Cloud Run and Dataflow.";
        } else if (integrations === "event-streaming") {
          integMain =
            "Use <strong>Pub/Sub</strong> with <strong>Dataflow</strong> or <strong>Eventarc</strong>.";
          integNotes =
            "Pub/Sub for events; Dataflow/Dataproc for processing; Eventarc for routing events from Google services.";
        } else if (integrations === "orchestration") {
          integMain =
            "Use <strong>Workflows</strong> for service orchestration and <strong>Cloud Composer</strong> (Airflow) for data pipelines.";
          integNotes =
            "Workflows for API/service compositions; Composer for DAG-based ETL.";
        }

        opsMain =
          "Treat this as <strong>" + tierLabel + "</strong> on Google Cloud and design HA/DR accordingly.";
        if (criticality === "tier0") {
          opsMain +=
            " Use multi-zonal and potentially multi-regional deployments with global HTTP(S) load balancing.";
        } else if (criticality === "tier1") {
          opsMain +=
            " Use regional multi-zonal deployments with tested backup/restore and failover.";
        } else if (criticality === "tier2") {
          opsMain +=
            " Single-region is often fine, but maintain backups and DR runbooks.";
        }

        opsNotes =
          "Use <strong>Cloud Monitoring</strong> and <strong>Cloud Logging</strong> for observability; " +
          "<strong>Error Reporting</strong>, <strong>Cloud Trace</strong>, and <strong>Profiler</strong> for diagnostics; " +
          "<strong>Security Command Center</strong> for security posture and threat detection.";

        if (regulated) {
          opsNotes +=
            " For IL and public sector workloads, ensure appropriate organizational policies, VPC Service Controls, and restricted regions.";
        }

        migrationMain = "GCP migration & onboarding focus.";
        migrationNotes =
          "Use <strong>Migrate to Virtual Machines</strong> or <strong>Google Cloud VMware Engine</strong> for VMware estates; " +
          "<strong>Database Migration Service</strong> for relational moves; <strong>Transfer Appliance</strong> / Storage Transfer Service for large data sets.";

        if (usesIaC("terraform") || usesIaC("cloud-native")) {
          migrationNotes +=
            " Provision landing zones, VPCs, firewall rules, and projects with <strong>Terraform</strong> and/or <strong>Deployment Manager</strong>, integrated into Cloud Build / your CI/CD.";
        }
        if (usesIaC("ansible")) {
          migrationNotes +=
            " Use <strong>Ansible</strong> to configure Compute Engine instances and on-prem nodes during hybrid migrations.";
        }

        migrationNotes +=
          " For connectivity, use <strong>Cloud Interconnect + VPN</strong> into CHEDC or central sites; federate identities via IAP + Context-Aware Access.";
      }

      /* ===================== OCI ===================== */
      else if (cloud === "oci") {
        if (architectureType === "web-api" || architectureType === "") {
          if (hasSkill("serverless")) {
            computeMain =
              "Use <strong>Oracle Functions</strong> (Fn) behind <strong>OCI API Gateway</strong>.";
            computeNotes =
              "Good for bursty HTTP APIs; integrate with Object Storage, Streaming, and DB services.";
          } else if (hasSkill("containers")) {
            computeMain =
              "Use <strong>Oracle Container Engine for Kubernetes (OKE)</strong> behind Load Balancers.";
            computeNotes =
              "OKE is the managed Kubernetes service; use node pools, autoscaling, and NSGs for isolation.";
          } else {
            computeMain =
              "Use <strong>OCI Compute instances</strong> with autoscaling and <strong>OCI Load Balancing</strong>.";
            computeNotes =
              "Baseline for VM-centric workloads; spread across fault domains and ADs.";
          }
        } else if (architectureType === "microservices") {
          computeMain =
            "Run microservices on <strong>OKE</strong>, combined with API Gateway and Service Mesh (where available) for east-west traffic.";
          computeNotes =
            "Use Helm/Argo/etc. for deployments and observability via OCI Monitoring + Logging.";
        } else if (architectureType === "batch") {
          computeMain =
            "Use <strong>OCI Container Engine</strong> or Compute with <strong>Resource Manager</strong>-provisioned clusters and scheduled jobs.";
          computeNotes =
            "Combine with Events + Functions for triggers.";
        } else if (architectureType === "event-driven") {
          computeMain =
            "Use <strong>Oracle Functions</strong> and <strong>OCI Streaming</strong> triggered by Events.";
          computeNotes =
            "Events + Streaming + Functions pattern for asynchronous processing.";
        } else if (architectureType === "legacy-vm") {
          computeMain =
            "Lift & shift to <strong>OCI Compute</strong> or use <strong>Oracle Cloud VMware Solution (OCVS)</strong> for VMware relocation.";
          computeNotes =
            "OCVS gives dedicated VMware SDDCs on OCI for minimal-change migrations.";
        } else if (architectureType === "data-analytics") {
          computeMain =
            "Use <strong>Oracle Autonomous Data Warehouse</strong> and <strong>Object Storage</strong> for lakehouse-style analytics.";
          computeNotes =
            "GoldenGate for replication, Data Integration / Data Flow (Spark) for pipelines, and Oracle Analytics for BI.";
        }

        if (dataType === "relational" || dataType === "") {
          dataMain =
            "Use <strong>Oracle Autonomous Transaction Processing (ATP)</strong> or <strong>Autonomous Database</strong>, and/or <strong>Oracle Database Cloud Service</strong>.";
          dataNotes =
            "Autonomous DB handles patching and tuning; use Data Guard for HA/DR and Transparent Data Encryption.";
        } else if (dataType === "nosql") {
          dataMain =
            "Use <strong>Oracle NoSQL Database Cloud Service</strong> or <strong>Autonomous JSON Database</strong>.";
          dataNotes =
            "Appropriate for key-value/document workloads needing Oracle integration.";
        } else if (dataType === "files") {
          dataMain =
            "Use <strong>OCI Object Storage</strong> and <strong>File Storage Service</strong> for POSIX-style workloads.";
          dataNotes =
            "Enable encryption, replication, and lifecycle policies for financial/regulated data.";
        } else if (dataType === "streaming") {
          dataMain =
            "Use <strong>OCI Streaming</strong> service for Kafka-like streaming.";
          dataNotes =
            "Combine with Functions, Data Flow, or external consumers for processing.";
        } else if (dataType === "analytics-lake") {
          dataMain =
            "Use <strong>Object Storage</strong> as the lake and <strong>Autonomous Data Warehouse</strong> / <strong>Big Data Service</strong> for analytics.";
          dataNotes =
            "Use Data Catalog and Data Integration to govern and ingest.";
        }

        if (regulated) {
          dataNotes +=
            (dataNotes ? " " : "") +
            "For national security or IL-equivalent workloads, use <strong>Oracle National Security Regions (NSR)</strong> or appropriate government regions, with Cloud Guard and Vault.";
        }

        if (integrations === "simple-http" || integrations === "") {
          integMain =
            "Expose APIs via <strong>OCI API Gateway</strong> in front of Functions, OKE, or Compute.";
          integNotes =
            "Use JWT/identity integration with IDCS and WAF policies.";
        } else if (integrations === "enterprise-messaging") {
          integMain =
            "Use <strong>OCI Streaming</strong> plus <strong>OCI Queue</strong> (where available) and <strong>Integration Cloud (OIC)</strong> for SaaS/ERP integration.";
          integNotes =
            "Useful for complex integrations across Oracle SaaS, on-prem, and third-party systems.";
        } else if (integrations === "event-streaming") {
          integMain =
            "Use <strong>OCI Streaming</strong> with Functions or Data Flow for event processing.";
          integNotes =
            "Pattern similar to Kafka + serverless / Spark processing.";
        } else if (integrations === "orchestration") {
          integMain =
            "Use <strong>Oracle Integration Cloud (OIC)</strong> for rich workflow/orchestration and SaaS integration patterns.";
          integNotes =
            "Good for ERP/HCM/financial package integration flows.";
        }

        opsMain =
          "Treat this as <strong>" + tierLabel + "</strong> on OCI and design HA/DR with fault domains, availability domains, and regions.";
        if (criticality === "tier0") {
          opsMain +=
            " Use multi-AD or region-to-region replication for critical systems.";
        } else if (criticality === "tier1") {
          opsMain +=
            " Use multiple fault domains and Data Guard / backups for key databases.";
        } else if (criticality === "tier2") {
          opsMain +=
            " Single region is often acceptable with robust backup and DR runbooks.";
        }

        opsNotes =
          "Use <strong>OCI Monitoring</strong>, <strong>Logging</strong>, and <strong>Events</strong> for observability; " +
          "<strong>Cloud Guard</strong> for posture management; <strong>Security Zones</strong> and IAM policies/dynamic groups for controls.";

        if (regulated) {
          opsNotes +=
            " For IL-equivalent workloads, use NSR/government regions, FastConnect + VPN to CHEDC, and log forwarding into centralized SIEM.";
        }

        migrationMain = "OCI migration & onboarding focus.";
        migrationNotes =
          "For VMware-heavy estates, use <strong>Oracle Cloud VMware Solution (OCVS)</strong> as a relocation target. " +
          "Use <strong>OCI Database Migration</strong> and Data Pump/GoldenGate for DB moves; " +
          "<strong>Data Transfer Service</strong> / FastConnect for large data sets.";

        if (usesIaC("terraform") || usesIaC("cloud-native")) {
          migrationNotes +=
            " Use <strong>Terraform</strong> (with OCI provider) or <strong>OCI Resource Manager</strong> to define landing zones, VCNs, security lists, and services as code.";
        }
        if (usesIaC("ansible")) {
          migrationNotes +=
            " Use <strong>Ansible</strong> for guest OS and middleware configuration on OCI Compute and OCVS.";
        }

        migrationNotes +=
          " Connect into CHEDC or central networks with <strong>FastConnect + VPN</strong>; integrate IDCS SAML federation and OCI DevOps Pipelines for CI/CD.";
      }

      // Generic initiative-type adjustments
      if (initiativeType === "new-service") {
        migrationNotes +=
          " Because this is a <strong>new service</strong>, emphasize greenfield landing zones, DevSecOps pipelines, and fast iteration, " +
          "with clear guardrails so future migrations can reuse this pattern.";
      } else if (initiativeType === "existing-service") {
        migrationNotes +=
          " Because this is a change to an <strong>existing service</strong>, run side-by-side testing, performance baselines, and audit of legacy controls " +
          "so you can show improvement against current issues.";
      } else if (initiativeType === "maintenance") {
        opsNotes +=
          " Because this is a <strong>maintenance / operations</strong> initiative, focus heavily on patch automation, SLO dashboards, incident reduction, and FinOps (cost reporting & cleanup).";
      } else if (initiativeType === "migration") {
        migrationNotes +=
          " Because this is a <strong>migration</strong> initiative, design waves, cutover rehearsals, and rollback plans around your chosen cutover strategy.";
        if (migrationScope) {
          migrationNotes += " Scope: <em>" + migrationScope + "</em>.";
        }
        if (cutoverStrategy) {
          migrationNotes += " Cutover strategy: <em>" + cutoverStrategy + "</em>.";
        }
      }

      
      // Security & network controls (deck-ready wording)
      const baselineLabel =
        securityBaseline === "stig"
          ? "DoD/STIG-aligned hardening"
          : securityBaseline === "regulated"
          ? "strict regulated baseline (PCI/PHI/SOX-like)"
          : securityBaseline === "standard"
          ? "standard enterprise baseline (CIS / internal security baseline)"
          : securityBaseline === "minimal"
          ? "minimal baseline (best-effort hardening only)"
          : null;

      const perimeterHint =
        perimeterPattern === "cloud-plus-f5"
          ? "Use cloud-native firewalls for north–south and east–west segmentation, and layer <strong>F5 services</strong> at the edge for advanced WAAP, bot, and API protection."
          : perimeterPattern === "f5-centric"
          ? "Position <strong>F5 (BIG-IP / NGINX / Distributed Cloud)</strong> as the primary perimeter and WAAP tier, complemented by cloud-native network security groups and firewalls."
          : perimeterPattern === "legacy-fw"
          ? "Retain the existing on-prem firewall in the near term, but plan to move toward cloud-native firewalls and/or F5 services to reduce hairpin/backhaul and improve agility."
          : "Lead with cloud-native firewalls, WAF, and private endpoints as the default perimeter and segmentation controls.";

      const identityHint =
        identityModel === "cloud-iam-only"
          ? "Standardize on cloud-native IAM roles and groups, avoid long-lived keys, and minimize local accounts."
          : identityModel === "hybrid-ad-entra"
          ? "Treat AD / Entra as a Tier 0 dependency; harden sync paths, use privileged access workstations, and prefer group-based RBAC for cloud resources."
          : identityModel === "external-idp-plus-iam"
          ? "Use the external IdP for SSO and workforce auth, and cloud IAM roles for workload access; keep privilege boundaries clear between the two."
          : null;

      const secretsHint =
        secretsModel === "basic"
          ? "Move application secrets out of code/config and into a managed secrets store with rotation policies."
          : secretsModel === "secrets-manager"
          ? "Standardize on a cloud-native secrets manager for all app credentials, API keys, and connection strings."
          : secretsModel === "hsm-backed"
          ? "Use HSM-backed keys for critical and regulated workloads, with strong separation of duties for key administration."
          : null;

      const dataProtectionHint =
        dataProtection === "at-rest"
          ? "Ensure encryption-at-rest for all managed data services and disks, and document who owns the keys."
          : dataProtection === "in-transit-and-at-rest"
          ? "Enforce TLS for all traffic (internal and external), align on modern cipher policies, and ensure encryption-at-rest everywhere."
          : dataProtection === "field-level"
          ? "Introduce tokenization, field-level encryption, and/or anonymization for sensitive fields, with isolated key management for those datasets."
          : null;

      securityMain =
        "Apply " +
        (baselineLabel || "an appropriate security baseline") +
        " with opinionated identity, secrets management, network segmentation, and perimeter controls for this workload.";

      securityNotes = perimeterHint;

      if (identityHint) {
        securityNotes += (securityNotes ? " " : "") + identityHint;
      }
      if (secretsHint) {
        securityNotes += (securityNotes ? " " : "") + secretsHint;
      }
      if (dataProtectionHint) {
        securityNotes += (securityNotes ? " " : "") + dataProtectionHint;
      }

      if (Array.isArray(f5Usage) && f5Usage.length) {
        const f5Parts = [];

        if (f5Usage.indexOf("waap-web") !== -1) {
          f5Parts.push("Use F5 WAAP/WAF (BIG-IP Advanced WAF, NGINX App Protect, or Distributed Cloud WAAP) in front of public web and portal endpoints.");
        }
        if (f5Usage.indexOf("api-security") !== -1) {
          f5Parts.push("Standardize on F5 for API gateway and API security for critical APIs – for example Distributed Cloud API Security or an NGINX-based gateway.");
        }
        if (f5Usage.indexOf("ddos") !== -1) {
          f5Parts.push("Use F5 DDoS protections (on-prem BIG-IP or Distributed Cloud DDoS) for internet-facing Tier 0/1 properties.");
        }
        if (f5Usage.indexOf("gslb") !== -1) {
          f5Parts.push("Use F5 DNS / GSLB to steer traffic across regions and improve availability and latency.");
        }
        if (f5Usage.indexOf("service-mesh") !== -1) {
          f5Parts.push("Consider F5 for service-mesh-style L7 control in front of microservices and Kubernetes workloads.");
        }
        if (f5Usage.indexOf("remote-access") !== -1) {
          f5Parts.push("Use F5 for secure remote access / ZTNA as you transition away from legacy VPN patterns.");
        }

        if (f5Parts.length) {
          securityNotes += (securityNotes ? " " : "") + f5Parts.join(" ");
        }
      }

      if (secOpsMaturity === "basic") {
        securityNotes +=
          (securityNotes ? " " : "") +
          "Turn on platform logs and WAF/F5 telemetry, ship them to at least one central log store, and define a minimal alert set and owners.";
      } else if (secOpsMaturity === "central-siem") {
        securityNotes +=
          (securityNotes ? " " : "") +
          "Integrate cloud, application, and F5 telemetry into a central SIEM/SOC with clear runbooks for high-severity alerts.";
      } else if (secOpsMaturity === "mature-devsecops") {
        securityNotes +=
          (securityNotes ? " " : "") +
          "Embed security into CI/CD with SAST/DAST, policy-as-code, and automated deployment of firewall/WAF/F5 policies (AS3/DO/XC APIs).";
      }

      if (regulated) {
        securityNotes +=
          (securityNotes ? " " : "") +
          "Enforce private endpoints or service endpoints, customer-managed keys, and strict change control for security configuration.";
      }

      if (isPublicSector) {
        securityNotes +=
          (securityNotes ? " " : "") +
          "For public-sector impact levels (L2/L4/L5/L6), align to the relevant control framework and prefer government/sovereign regions where required.";
      }

      if (criticality === "tier0") {
        securityNotes +=
          (securityNotes ? " " : "") +
          "For Tier 0 workloads, design for zero-trust access, strong MFA, and defense-in-depth at identity, network, and application layers.";
      }

      // DR pattern label for deck summaries
      const tightRto = rto === "mins" || rto === "hour";
      const tightRpo = rpo === "zero" || rpo === "15min";
      const multiRegion =
        geoPattern === "multi-region" ||
        regionCount === "2" ||
        regionCount === "2-active" ||
        regionCount === "3plus";

      if (multiRegion && tightRto && tightRpo) {
        drPatternLabel = "Active–active multi-region with aggressive RTO/RPO.";
      } else if (multiRegion && (tightRto || tightRpo)) {
        drPatternLabel = "Warm standby or active–passive multi-region.";
      } else if (!multiRegion && (criticality === "tier0" || criticality === "tier1")) {
        drPatternLabel = "Multi-AZ in a single region; consider adding a DR region.";
      } else {
        drPatternLabel = "Backup-and-restore–centric DR pattern with relaxed RTO/RPO.";
      }

      if (drPatternLabel && opsNotes.indexOf("DR pattern:") === -1) {
        opsNotes += (opsNotes ? " " : "") + "DR pattern: " + drPatternLabel;
      }

return {
        computeMain,
        computeNotes,
        dataMain,
        dataNotes,
        integMain,
        integNotes,
        opsMain,
        opsNotes,
        migrationMain,
        migrationNotes,
        securityMain,
        securityNotes
      };
    }

export function generateRecommendation() {
      const envScope = Array.from(
        qsa('input[name="envScope"]:checked')
      ).map(c => c.value);

      const state = {
        initiativeType: byId("initiativeType").value,
        newServiceType: byId("newServiceType").value,
        newServiceStage: byId("newServiceStage").value,
        existingChangeType: byId("existingChangeType").value,
        existingPainPoints: (byId("existingPainPoints").value || "").trim(),
        maintenanceFocus: byId("maintenanceFocus").value,
        maintenanceCadence: byId("maintenanceCadence").value,
        migrationScope: byId("migrationScope").value,
        cutoverStrategy: byId("cutoverStrategy").value,

        workloadName: (byId("workloadName").value || "").trim(),
        architectureType: byId("architectureType").value,
        trafficPattern: byId("trafficPattern").value,
        latencySensitivity: byId("latencySensitivity").value,
        teamSkills: getMultiSelectValues(byId("teamSkills")),
        description: (byId("description").value || "").trim(),

        dataType: byId("dataType").value,
        dataSensitivity: byId("dataSensitivity").value,
        writePattern: byId("writePattern").value,
        geoPattern: byId("geoPattern").value,
        integrations: byId("integrations").value,
        complianceNotes: (byId("complianceNotes").value || "").trim(),

        criticality: byId("criticality").value,
        uptimeTarget: byId("uptimeTarget").value,
        rto: byId("rto").value,
        rpo: byId("rpo").value,
        timeToMarket: byId("timeToMarket").value,
        opsMaturity: byId("opsMaturity").value,
        securityBaseline: byId("securityBaseline").value,
        identityModel: byId("identityModel").value,
        secretsModel: byId("secretsModel").value,
        dataProtection: byId("dataProtection").value,
        perimeterPattern: byId("perimeterPattern").value,
        f5Usage: getCheckedValues("f5Usage"),
        secOpsMaturity: byId("secOpsMaturity").value,

        sourceEnv: byId("sourceEnv").value,
        migrationApproach: byId("migrationApproach").value,
        iaCTools: getMultiSelectValues(byId("iaCTools")),

        peakUsers: Number(byId("peakUsers").value || 0),
        peakRps: Number(byId("peakRps").value || 0),
        dataVolumeBand: byId("dataVolumeBand").value,
        dailyIngestBand: byId("dailyIngestBand").value,
        retentionPeriod: byId("retentionPeriod").value,
        envScope,
        nonProdScale: byId("nonProdScale").value,
        regionCount: byId("regionCount").value
      };

      const pillRow = byId("summaryPills");
      if (pillRow) {
        pillRow.innerHTML = "";
        const pills = buildSummaryPills(state);
        pills.forEach(text => {
          const span = document.createElement("span");
          span.className = "pill";
          span.textContent = text;
          pillRow.appendChild(span);
        });
      }

      const rec = generateCloudRecommendation(currentCloud, state);
      const howTo = buildHowToPlaybook(currentCloud, state);
      const sizing = buildSizingPlan(currentCloud, state);
      const assumptions = buildAssumptionsAndGaps(state, currentCloud);
      const drPattern = buildDrPatternCard(state, currentCloud);
      const controlsChecklist = buildCyberChecklist(state, currentCloud);

      const resultsContent = byId("resultsContent");
      if (resultsContent) resultsContent.style.display = "block";
      const fullBtn = byId("fullViewBtn");
      const printBtn = byId("printBtn");
      const wordBtn = byId("exportWordBtn");
      [fullBtn, printBtn, wordBtn].forEach(btn => {
        if (btn) btn.disabled = false;
      });


      const mapping = [
        ["computeMain", rec.computeMain],
        ["computeNotes", rec.computeNotes],
        ["dataMain", rec.dataMain],
        ["dataNotes", rec.dataNotes],
        ["integrationMain", rec.integMain],
        ["integrationNotes", rec.integNotes],
        ["opsMain", rec.opsMain],
        ["opsNotes", rec.opsNotes],
        ["securityMain", rec.securityMain],
        ["securityNotes", rec.securityNotes],
        ["controlsMain", controlsChecklist],
        ["migrationMain", rec.migrationMain],
        ["migrationNotes", rec.migrationNotes],
        ["drPatternMain", drPattern],
        ["sizingMain", sizing.main],
        ["sizingNotes", sizing.notes],
        ["sizingMatrix", sizing.matrixHtml],
        ["howToMain", howTo],
        ["assumptionsMain", assumptions]
      ];

      mapping.forEach(([id, html]) => {
        const el = byId(id);
        if (el) el.innerHTML = html || "";
      });
    }

export function buildRecommendationDocumentHtml() {
      const providerSelect = byId("cloudProvider");
      const providerLabel = providerSelect
        ? providerSelect.options[providerSelect.selectedIndex].text
        : "";
      const workloadNameInput = byId("workloadName");
      const workloadName = workloadNameInput && workloadNameInput.value
        ? workloadNameInput.value
        : "Cloud workload";
      const summaryPills = byId("summaryPills");
      const resultsContent = byId("resultsContent");
      const now = new Date();
      const generatedAt = now.toLocaleString();

      // Pull current wizard state for brief F5 posture line
      const state = (function () {
        const envScope = Array.from(
          qsa('input[name="envScope"]:checked')
        ).map(c => c.value);

        return {
          f5Usage: window.getCheckedValues
            ? window.getCheckedValues("f5Usage")
            : [],
          perimeterPattern: byId("perimeterPattern")
            ? byId("perimeterPattern").value
            : "",
          criticality: byId("criticality")
            ? byId("criticality").value
            : "",
          dataSensitivity: byId("dataSensitivity")
            ? byId("dataSensitivity").value
            : "",
          envScope
        };
      })();

      let pillsLine = "";
      if (summaryPills) {
        const spans = Array.from(summaryPills.querySelectorAll("span"));
        pillsLine = spans.map(s => s.textContent).join(" | ");
      }

      const resultsHtml = resultsContent && resultsContent.style.display !== "none"
        ? resultsContent.innerHTML
        : "<p>No recommendation has been generated yet.</p>";

      
      let f5PostureLine = "";
      if (state) {
        const usage = Array.isArray(state.f5Usage) ? state.f5Usage : [];
        const postureBits = [];

        const isRegulated =
          state.dataSensitivity === "regulated" ||
          state.dataSensitivity === "ps-l2" ||
          state.dataSensitivity === "ps-l4" ||
          state.dataSensitivity === "ps-l5" ||
          state.dataSensitivity === "ps-l6";

        if (usage.indexOf("waap-web") !== -1 || usage.indexOf("api-security") !== -1) {
          postureBits.push("F5 front-door protection for web and/or API traffic");
        }
        if (usage.indexOf("ddos") !== -1) {
          postureBits.push("F5 DDoS protection on critical internet-facing endpoints");
        }
        if (usage.indexOf("gslb") !== -1) {
          postureBits.push("F5 DNS / GSLB for cross-region traffic steering");
        }
        if (usage.indexOf("service-mesh") !== -1) {
          postureBits.push("F5 applied to east–west / service-mesh traffic patterns");
        }
        if (usage.indexOf("remote-access") !== -1) {
          postureBits.push("F5 secure remote access / ZTNA as VPN successor");
        }

        if (!postureBits.length && state.perimeterPattern === "cloud-plus-f5") {
          postureBits.push("F5 layered with cloud-native firewalls as part of the perimeter");
        } else if (!postureBits.length && state.perimeterPattern === "f5-centric") {
          postureBits.push("F5 as the primary perimeter / WAAP tier");
        }

        if (postureBits.length) {
          const focus = postureBits.join("; ");
          const criticalityLabel =
            state.criticality === "tier0"
              ? "Tier 0"
              : state.criticality === "tier1"
              ? "Tier 1"
              : state.criticality === "tier2"
              ? "Tier 2/3"
              : "mixed criticality";

          const sectorTag = isRegulated ? "regulated / public-sector context" : "commercial context";

          f5PostureLine =
            "<p><strong>F5 posture:</strong> " +
            focus +
            " (" +
            criticalityLabel +
            ", " +
            sectorTag +
            ").</p>";
        }
      }

      const docBody = `
        <h1>Cloud Recommendation for ${workloadName}</h1>
        <p><strong>Cloud:</strong> ${providerLabel}</p>
        <p><strong>Generated:</strong> ${generatedAt}</p>
        ${pillsLine ? `<p><strong>Summary:</strong> ${pillsLine}</p>` : ""}
        ${f5PostureLine || ""}
        ${resultsHtml}
      `;

      const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Cloud Recommendation</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.4; margin: 20px; }
    h1 { font-size: 20pt; margin-bottom: 8px; }
    h3 { margin-top: 18px; font-size: 12pt; }
    p { margin: 4px 0; }
    table { border-collapse: collapse; margin-top: 6px; }
    table, th, td { border: 1px solid #555; }
    th, td { padding: 4px 6px; }
  </style>
</head>
<body>
${docBody}
</body>
</html>`;
      return fullHtml;
    }

export function openFullViewWindow() {
      const html = buildRecommendationDocumentHtml();
      const w = window.open("", "_blank");
      if (!w) return;
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
    }

export function openPrintView() {
      const html = buildRecommendationDocumentHtml();
      const w = window.open("", "_blank");
      if (!w) return;
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      w.print();
    }

export function exportRecommendationAsWord() {
      const html = buildRecommendationDocumentHtml();
      const blob = new Blob(['\ufeff', html], { type: "application/msword" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const workloadNameInput = byId("workloadName");
      let fileBase = workloadNameInput && workloadNameInput.value
        ? workloadNameInput.value
        : "cloud-recommendation";
      fileBase = fileBase.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      a.href = url;
      a.download = (fileBase || "cloud-recommendation") + "-recommendation.doc";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }


import path from "path";
import { ts, writeJson, fetchJson, normalizeName } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const RAW = path.join(ROOT, "data/raw/provider-inventory/aws.index.json");
const OUT = path.join(ROOT, "data/imports/provider-inventory/aws.normalized.json");
const AWS_INDEX_URL = process.env.AWS_INDEX_URL || "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json";

function prettifyAwsOfferCode(offerCode){
  const raw = String(offerCode || "").trim();
  if (!raw) return "";

  // Common shortnames / acronyms (keeps UI sane, helps deterministic + fuzzy match)
  const special = {
    AmazonS3: "Amazon S3",
    AmazonEC2: "Amazon EC2",
    AmazonRDS: "Amazon RDS",
    AWSLambda: "AWS Lambda",
    AWSCloudTrail: "AWS CloudTrail",
    AWSCloudWatch: "Amazon CloudWatch",
    AWSKeyManagementService: "AWS Key Management Service (KMS)",
    AWSSecretsManager: "AWS Secrets Manager",
    AmazonEBS: "Amazon EBS",
    AmazonEFS: "Amazon EFS",
    AmazonVPC: "Amazon VPC",
    AmazonRoute53: "Amazon Route 53",
    AWSIAM: "AWS IAM",
  };
  if (special[raw]) return special[raw];

  // Generic camel-case splitter with acronym preservation
  // Example: AmazonElasticFileSystem -> Amazon Elastic File System
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  // Fix some common AWS acronyms if they ended up split oddly
  return spaced
    .replace(/\bE C 2\b/g, "EC2")
    .replace(/\bS 3\b/g, "S3")
    .replace(/\bR D S\b/g, "RDS")
    .replace(/\bI A M\b/g, "IAM")
    .replace(/\bE B S\b/g, "EBS")
    .replace(/\bE F S\b/g, "EFS")
    .replace(/\bV P C\b/g, "VPC")
    .replace(/\bK M S\b/g, "KMS");
}

function toRecords(indexJson){
  // AWS pricing index uses an object map: { "AmazonEC2": { offerCode, versionIndexUrl, ... }, ... }
  const offersObj = (indexJson && typeof indexJson.offers === "object") ? indexJson.offers : null;
  const offersArr = Array.isArray(indexJson?.offers) ? indexJson.offers : null;

  const offers = [];
  if (offersArr) offers.push(...offersArr);
  else if (offersObj) {
    for (const k of Object.keys(offersObj)) offers.push(offersObj[k]);
  }

  return offers.map(o=>{
    const offerCode = normalizeName(o?.offerCode || "");
    const id = offerCode;
    const pretty = prettifyAwsOfferCode(offerCode) || offerCode;
    const aliases = [offerCode, pretty].filter(Boolean);
    // Also add a short alias for common Amazon* services (e.g., "S3", "EC2")
    if (/S3/i.test(offerCode)) aliases.push("S3");
    if (/EC2/i.test(offerCode)) aliases.push("EC2");
    if (/RDS/i.test(offerCode)) aliases.push("RDS");
    if (/EBS/i.test(offerCode)) aliases.push("EBS");
    if (/EFS/i.test(offerCode)) aliases.push("EFS");
    if (/IAM/i.test(offerCode)) aliases.push("IAM");

    return {
      provider: "aws",
      serviceId: id,
      name: pretty,
      aliases: Array.from(new Set(aliases.map(x=>String(x)))).filter(Boolean),
      source: { type: "aws_pricing_index", url: AWS_INDEX_URL },
      raw: o
    };
  }).filter(x=>x.serviceId);
}

async function main(){
  const indexJson = await fetchJson(AWS_INDEX_URL);
  writeJson(RAW,{ pulledAt: ts(), url: AWS_INDEX_URL, ...indexJson });

  const records = toRecords(indexJson);
  writeJson(OUT,{ pulledAt: ts(), provider:"aws", count: records.length, services: records });

  console.log(`[aws] services=${records.length}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });

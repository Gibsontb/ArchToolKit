
//Copyright Theodore B C Gibson, Cloud Agnostic Architect
//11/14/2025
//Version 5.1
// AWS services derived from "Master Reference Cloud Services 2025 v2.5"
// Grouped by category; names are exactly as in the reference.
// This file wires AWS into the Cloud Decision Kit namespace.

window.CDK = window.CDK || {};
window.CDK.providers = window.CDK.providers || {};

window.CDK.providers.aws = {
  id: "aws",
  displayName: "Amazon Web Services (AWS)",
  serviceCategories: {
    // ---------------------------
    // AI and Machine Learning
    // ---------------------------
    "ai-ml": {
      label: "AI & Machine Learning",
      services: [
        { id: "ai-containers",          category: "AI CONTAINERS",                name: "Deep Learning Containers", consolePath: "AWS Console → Services → Machine Learning → Deep Learning Containers" },
        { id: "ai-powered-assistant",   category: "AI-POWERED ASSISTANT",         name: "Amazon Q", consolePath: "AWS Console → Services → Machine Learning → Amazon Q" },
        { id: "human-review",           category: "HUMAN REVIEW/MODERATION",      name: "Amazon Augmented AI (A2I)", consolePath: "AWS Console → Services → Machine Learning → Amazon Augmented AI (A2I)" },
        { id: "chatbot-builder",        category: "CHATBOT BUILDER",              name: "Amazon Lex", consolePath: "AWS Console → Services → Machine Learning → Amazon Lex" },
        { id: "data-labeling",          category: "DATA LABELING",                name: "SageMaker Ground Truth", consolePath: "AWS Console → Services → Machine Learning → SageMaker Ground Truth" },
        { id: "document-extraction",    category: "DOCUMENT EXTRACTION",          name: "Amazon Textract", consolePath: "AWS Console → Services → Machine Learning → Amazon Textract" },
        { id: "generative-platforms",   category: "GENERATIVE AI PLATFORMS",      name: "Amazon Bedrock", consolePath: "AWS Console → Services → Machine Learning → Amazon Bedrock" },
        { id: "image-recognition",      category: "IMAGE RECOGNITION",            name: "Amazon Rekognition", consolePath: "AWS Console → Services → Machine Learning → Amazon Rekognition" },
        { id: "inference-acceleration", category: "INFERENCE ACCELERATION",       name: "AWS Inferentia, Elastic Inference", consolePath: "AWS Console → Services → Machine Learning → AWS Inferentia, Elastic Inference" },
        { id: "language-translation",   category: "LANGUAGE TRANSLATION",         name: "Amazon Translate", consolePath: "AWS Console → Services → Machine Learning → Amazon Translate" },
        { id: "ml-ai-chips",            category: "ML/AI CHIPS",                  name: "Inferentia, Trainium", consolePath: "AWS Console → Services → Machine Learning → Inferentia, Trainium" },
        { id: "managed-ml-platform",    category: "MANAGED ML PLATFORM",          name: "Amazon SageMaker", consolePath: "AWS Console → Services → Machine Learning → Amazon SageMaker" },
        { id: "notebooks",              category: "NOTEBOOKS",                    name: "EMR Notebooks", consolePath: "AWS Console → Services → Machine Learning → EMR Notebooks" },
        { id: "online-fraud",           category: "ONLINE FRAUD DETECTION",       name: "Amazon Fraud Detector", consolePath: "AWS Console → Services → Machine Learning → Amazon Fraud Detector" },
        { id: "preconfigured-ml-vms",   category: "PRECONFIGURED ML VMS",         name: "Deep Learning AMIs", consolePath: "AWS Console → Services → Machine Learning → Deep Learning AMIs" },
        { id: "recommendation-engine",  category: "RECOMMENDATION ENGINE",        name: "Amazon Personalize", consolePath: "AWS Console → Services → Machine Learning → Amazon Personalize" },
        { id: "speech-services",        category: "SPEECH RECOGNITION/SYNTHESIS", name: "Amazon Transcribe, Polly", consolePath: "AWS Console → Services → Machine Learning → Amazon Transcribe, Polly" },
        { id: "text-analysis",          category: "TEXT ANALYSIS",                name: "Amazon Comprehend", consolePath: "AWS Console → Services → Machine Learning → Amazon Comprehend" },
        { id: "time-series-forecasting",category: "TIME-SERIES FORECASTING",      name: "Amazon Forecast", consolePath: "AWS Console → Services → Machine Learning → Amazon Forecast" },
        { id: "video-analysis",         category: "VIDEO ANALYSIS",               name: "Rekognition Video", consolePath: "AWS Console → Services → Machine Learning → Rekognition Video" },
        { id: "visual-inspection",      category: "VISUAL INSPECTION",            name: "Lookout for Vision", consolePath: "AWS Console → Services → Machine Learning → Lookout for Vision" }
      ]
    },

    // ---------------------------
    // Analytics
    // ---------------------------
    "analytics": {
      label: "Analytics",
      services: [
        { id: "big-data-processing",    category: "BIG DATA PROCESSING",          name: "Amazon EMR, AWS Glue", consolePath: "AWS Console → Services → Analytics → Amazon EMR, AWS Glue" },
        { id: "business-analytics",     category: "BUSINESS ANALYTICS",           name: "Amazon QuickSight, Amazon FinSpace", consolePath: "AWS Console → Services → Analytics → Amazon QuickSight, Amazon FinSpace" },
        { id: "data-exploration",       category: "DATA EXPLORATION/CATALOG",     name: "Amazon Athena, AWS Glue Data Catalog", consolePath: "AWS Console → Services → Analytics → Amazon Athena, AWS Glue Data Catalog" },
        { id: "data-lake-creation",     category: "DATA LAKE CREATION",           name: "AWS Lake Formation", consolePath: "AWS Console → Services → Analytics → AWS Lake Formation" },
        { id: "data-sharing",           category: "DATA SHARING/EXCHANGE",        name: "AWS Data Exchange, Lake Formation, AMB", consolePath: "AWS Console → Services → Analytics → AWS Data Exchange, Lake Formation, AMB" },
        { id: "data-streaming",         category: "DATA STREAMING",               name: "Amazon Kinesis, Data Firehose, Kinesis Analytics", consolePath: "AWS Console → Services → Analytics → Amazon Kinesis, Data Firehose, Kinesis Analytics" },
        { id: "data-warehousing",       category: "DATA WAREHOUSING",             name: "Amazon Redshift", consolePath: "AWS Console → Services → Analytics → Amazon Redshift" },
        { id: "data-wrangling",         category: "DATA WRANGLING",               name: "AWS Glue DataBrew, SageMaker Data Wrangler", consolePath: "AWS Console → Services → Analytics → AWS Glue DataBrew, SageMaker Data Wrangler" },
        { id: "etl",                    category: "ETL",                           name: "AWS Glue, AWS Data Pipeline", consolePath: "AWS Console → Services → Analytics → AWS Glue, AWS Data Pipeline" },
        { id: "hosted-hadoop-spark",    category: "HOSTED HADOOP/SPARK",          name: "Amazon EMR", consolePath: "AWS Console → Services → Analytics → Amazon EMR" },
        { id: "managed-kafka",          category: "MANAGED KAFKA",                name: "Amazon MSK (Managed Streaming for Kafka)", consolePath: "AWS Console → Services → Analytics → Amazon MSK (Managed Streaming for Kafka)" },
        { id: "managed-search",         category: "MANAGED SEARCH",               name: "Amazon OpenSearch, CloudSearch", consolePath: "AWS Console → Services → Analytics → Amazon OpenSearch, CloudSearch" },
        { id: "query-service",          category: "QUERY SERVICE",                name: "Amazon Athena, Redshift Spectrum", consolePath: "AWS Console → Services → Analytics → Amazon Athena, Redshift Spectrum" }
      ]
    },

    // ---------------------------
    // Application Integration
    // ---------------------------
    "app-integration": {
      label: "Application Integration",
      services: [
        { id: "api-management",         category: "API MANAGEMENT",               name: "Amazon API Gateway, AWS AppSync", consolePath: "AWS Console → Services → Application Integration → Amazon API Gateway, AWS AppSync" },
        { id: "distributed-coordination",category: "DISTRIBUTED COORDINATION",    name: "AWS Step Functions, Simple Workflow (SWF)", consolePath: "AWS Console → Services → Application Integration → AWS Step Functions, Simple Workflow (SWF)" },
        { id: "event-handling",         category: "EVENT HANDLING",               name: "Amazon EventBridge", consolePath: "AWS Console → Services → Application Integration → Amazon EventBridge" },
        { id: "integration-service",    category: "INTEGRATION SERVICE",          name: "AWS AppFlow, Step Functions", consolePath: "AWS Console → Services → Application Integration → AWS AppFlow, Step Functions" },
        { id: "messaging",              category: "MESSAGING",                    name: "Amazon SQS, SNS, MQ", consolePath: "AWS Console → Services → Application Integration → Amazon SQS, SNS, MQ" },
        { id: "service-discovery",      category: "SERVICE DISCOVERY",            name: "AWS Cloud Map", consolePath: "AWS Console → Services → Application Integration → AWS Cloud Map" },
        { id: "service-mesh",           category: "SERVICE MESH",                 name: "AWS App Mesh", consolePath: "AWS Console → Services → Application Integration → AWS App Mesh" },
        { id: "workflow-orchestration", category: "WORKFLOW ORCHESTRATION",       name: "AWS Managed Workflows for Apache Airflow (MWAA), Step Functions", consolePath: "AWS Console → Services → Application Integration → AWS Managed Workflows for Apache Airflow (MWAA), Step Functions" }
      ]
    },

    // ---------------------------
    // Business Applications
    // ---------------------------
    "business-apps": {
      label: "Business Applications",
      services: [
        // COLLABORATION SUITE: no AWS entry in the reference ("—"), so omitted.
        { id: "doc-sharing",        category: "DOCUMENT SHARING",                 name: "Amazon WorkDocs", consolePath: "AWS Console → Services → Business Applications → Amazon WorkDocs" },
        { id: "email-calendar",     category: "EMAIL AND CALENDAR",              name: "Amazon WorkMail", consolePath: "AWS Console → Services → Business Applications → Amazon WorkMail" },
        { id: "low-code",           category: "LOW-CODE/NO-CODE TOOLS",          name: "AWS Amplify, App Runner, QuickSight", consolePath: "AWS Console → Services → Business Applications → AWS Amplify, App Runner, QuickSight" },
        { id: "video-calls-chat",   category: "VIDEO CALLS AND CHAT",            name: "Amazon Chime", consolePath: "AWS Console → Services → Business Applications → Amazon Chime" },
        { id: "voice-assistant",    category: "VOICE ASSISTANT",                 name: "Amazon Alexa, Amazon Lex", consolePath: "AWS Console → Services → Business Applications → Amazon Alexa, Amazon Lex" }
      ]
    },

    // ---------------------------
    // Compute
    // ---------------------------
    "compute": {
      label: "Compute",
      services: [
        { id: "autoscaling",        category: "AUTOSCALING",                     name: "EC2 Auto Scaling, AWS Auto Scaling", consolePath: "AWS Console → Services → Compute → EC2 Auto Scaling, AWS Auto Scaling" },
        { id: "batch-processing",   category: "BATCH PROCESSING",                name: "AWS Batch", consolePath: "AWS Console → Services → Compute → AWS Batch" },
        { id: "hybrid-extended",    category: "HYBRID/EXTENDED INFRA",           name: "AWS Outposts, ECS Anywhere, EKS Anywhere", consolePath: "AWS Console → Services → Compute → AWS Outposts, ECS Anywhere, EKS Anywhere" },
        { id: "serverless-compute", category: "SERVERLESS COMPUTE",              name: "AWS Lambda", consolePath: "AWS Console → Services → Compute → AWS Lambda" },
        { id: "hpc-management",     category: "HPC MANAGEMENT",                  name: "AWS ParallelCluster", consolePath: "AWS Console → Services → Compute → AWS ParallelCluster" },
        { id: "dedicated-servers",  category: "DEDICATED SERVERS",               name: "EC2 Dedicated Hosts", consolePath: "AWS Console → Services → Compute → EC2 Dedicated Hosts" },
        { id: "paas-web-hosting",   category: "PAAS WEB HOSTING",                name: "Elastic Beanstalk, Lightsail", consolePath: "AWS Console → Services → Compute → Elastic Beanstalk, Lightsail" },
        { id: "quantum-computing",  category: "QUANTUM COMPUTING",               name: "Amazon Braket", consolePath: "AWS Console → Services → Compute → Amazon Braket" },
        { id: "virtual-machines",   category: "VIRTUAL MACHINES",                name: "EC2", consolePath: "AWS Console → Services → Compute → EC2" },
        { id: "vm-image-builder",   category: "VM IMAGE BUILDER",                name: "EC2 Image Builder", consolePath: "AWS Console → Services → Compute → EC2 Image Builder" },
        { id: "vmware-integration", category: "VMWARE INTEGRATION",              name: "VMware Cloud on AWS", consolePath: "AWS Console → Services → Compute → VMware Cloud on AWS" }
      ]
    },

    // ---------------------------
    // Containers
    // ---------------------------
    "containers": {
      label: "Containers",
      services: [
        { id: "container-migration",   category: "CONTAINER MIGRATION",          name: "App2Container (A2C)", consolePath: "AWS Console → Services → Containers → App2Container (A2C)" },
        { id: "container-registry",    category: "CONTAINER REGISTRY",           name: "Amazon ECR, AWS CodeArtifact", consolePath: "AWS Console → Services → Containers → Amazon ECR, AWS CodeArtifact" },
        { id: "managed-containers",    category: "MANAGED CONTAINERS",           name: "ECS, AWS Copilot", consolePath: "AWS Console → Services → Containers → ECS, AWS Copilot" },
        { id: "managed-kubernetes",    category: "MANAGED KUBERNETES",           name: "Amazon EKS", consolePath: "AWS Console → Services → Containers → Amazon EKS" },
        { id: "serverless-containers", category: "SERVERLESS CONTAINERS",        name: "AWS Fargate, App Runner", consolePath: "AWS Console → Services → Containers → AWS Fargate, App Runner" }
      ]
    },

    // ---------------------------
    // Cost Controls
    // ---------------------------
    "cost-controls": {
      label: "Cost Controls",
      services: [
        { id: "architecture-review",   category: "ARCHITECTURE REVIEW",          name: "AWS Well-Architected Tool", consolePath: "AWS Console → Services → Billing & Cost Management → AWS Well-Architected Tool" },
        { id: "billing-budgeting",     category: "BILLING AND BUDGETING TOOLS",  name: "AWS Budgets, AWS Cost and Usage Reports (CUR)", consolePath: "AWS Console → Services → Billing & Cost Management → AWS Budgets, AWS Cost and Usage Reports (CUR)" },
        { id: "optimization",          category: "OPTIMIZATION & RECOMMENDATIONS", name: "AWS Trusted Advisor, Compute Optimizer", consolePath: "AWS Console → Services → Billing & Cost Management → AWS Trusted Advisor, Compute Optimizer" },
        { id: "commitment-discounts",  category: "COMMITMENT DISCOUNTS",         name: "EC2 Reserved Instances, Compute Savings Plans", consolePath: "AWS Console → Services → Billing & Cost Management → EC2 Reserved Instances, Compute Savings Plans" },
        { id: "spot-vms",              category: "SPOT/PREEMPTIBLE VMS",         name: "Amazon EC2 Spot Instances", consolePath: "AWS Console → Services → Billing & Cost Management → Amazon EC2 Spot Instances" },
        { id: "cost-anomaly-detect",   category: "COST ANOMALY DETECTION",       name: "AWS Cost Anomaly Detection", consolePath: "AWS Console → Services → Billing & Cost Management → AWS Cost Anomaly Detection" }
      ]
    },

    // ---------------------------
    // Databases
    // ---------------------------
    "databases": {
      label: "Databases",
      services: [
        { id: "blockchain",        category: "BLOCKCHAIN",                       name: "Amazon Managed Blockchain, QLDB", consolePath: "AWS Console → Services → Databases → Amazon Managed Blockchain, QLDB" },
        { id: "in-memory-cache",   category: "IN-MEMORY CACHE",                  name: "Amazon ElastiCache, Amazon MemoryDB", consolePath: "AWS Console → Services → Databases → Amazon ElastiCache, Amazon MemoryDB" },
        { id: "nosql-column",      category: "NOSQL (COLUMN-FAMILY)",            name: "Amazon Keyspaces (for Cassandra)", consolePath: "AWS Console → Services → Databases → Amazon Keyspaces (for Cassandra)" },
        { id: "nosql-document",    category: "NOSQL (DOCUMENT)",                 name: "Amazon DocumentDB", consolePath: "AWS Console → Services → Databases → Amazon DocumentDB" },
        { id: "nosql-graph",       category: "NOSQL (GRAPH)",                    name: "Amazon Neptune", consolePath: "AWS Console → Services → Databases → Amazon Neptune" },
        { id: "nosql-keyvalue",    category: "NOSQL (KEY-VALUE)",                name: "Amazon DynamoDB", consolePath: "AWS Console → Services → Databases → Amazon DynamoDB" },
        { id: "relational-rdbms",  category: "RELATIONAL (RDBMS)",               name: "RDS, Amazon Aurora, Amazon Redshift", consolePath: "AWS Console → Services → Databases → RDS, Amazon Aurora, Amazon Redshift" },
        { id: "time-series-db",    category: "TIME-SERIES",                      name: "Amazon Timestream", consolePath: "AWS Console → Services → Databases → Amazon Timestream" }
      ]
    },

    // ---------------------------
    // Developer Tools
    // ---------------------------
    "devtools": {
      label: "Developer Tools",
      services: [
        { id: "app-config",        category: "APP CONFIGURATION",                name: "AWS AppConfig", consolePath: "AWS Console → Services → Developer Tools → AWS AppConfig" },
        { id: "artifact-mgmt",     category: "ARTIFACT MANAGEMENT",              name: "AWS CodeArtifact", consolePath: "AWS Console → Services → Developer Tools → AWS CodeArtifact" },
        { id: "ci-cd",             category: "CI/CD",                            name: "CodePipeline, CodeBuild, CodeDeploy", consolePath: "AWS Console → Services → Developer Tools → CodePipeline, CodeBuild, CodeDeploy" },
        { id: "cli-tools",         category: "CLI TOOLS",                        name: "AWS CLI", consolePath: "AWS Console → Services → Developer Tools → AWS CLI" },
        { id: "code-debugging",    category: "CODE DEBUGGING",                   name: "AWS X-Ray", consolePath: "AWS Console → Services → Developer Tools → AWS X-Ray" },
        { id: "sdks-devkits",      category: "SDKS AND DEV KITS",                name: "AWS SDKs, CDK, Corretto", consolePath: "AWS Console → Services → Developer Tools → AWS SDKs, CDK, Corretto" },
        { id: "git-repos",         category: "GIT REPOSITORIES",                 name: "AWS CodeCommit", consolePath: "AWS Console → Services → Developer Tools → AWS CodeCommit" },
        { id: "web-mobile-dev",    category: "WEB/MOBILE APP DEV",               name: "AWS Amplify", consolePath: "AWS Console → Services → Developer Tools → AWS Amplify" },
        { id: "powershell",        category: "POWERSHELL",                       name: "AWS Tools for PowerShell", consolePath: "AWS Console → Services → Developer Tools → AWS Tools for PowerShell" },
        { id: "scheduling",        category: "SCHEDULING",                       name: "Amazon EventBridge, CloudWatch Events", consolePath: "AWS Console → Services → Developer Tools → Amazon EventBridge, CloudWatch Events" },
        { id: "testing",           category: "TESTING",                          name: "AWS Device Farm, AWS Fault Injection Service (FIS)", consolePath: "AWS Console → Services → Developer Tools → AWS Device Farm, AWS Fault Injection Service (FIS)" }
      ]
    },

    // ---------------------------
    // IoT
    // ---------------------------
    "iot": {
      label: "IoT",
      services: [
        { id: "iot-device-connectivity", category: "DEVICE CONNECTIVITY",        name: "AWS IoT Core, IoT Device Management, SiteWise", consolePath: "AWS Console → Services → Internet of Things → AWS IoT Core, IoT Device Management, SiteWise" },
        { id: "iot-edge",                category: "EDGE COMPUTING",             name: "AWS IoT Greengrass", consolePath: "AWS Console → Services → Internet of Things → AWS IoT Greengrass" },
        { id: "iot-security",            category: "IOT SECURITY",               name: "AWS IoT Device Defender", consolePath: "AWS Console → Services → Internet of Things → AWS IoT Device Defender" },
        { id: "virtual-modeling",        category: "VIRTUAL MODELING",           name: "AWS IoT Things Graph, TwinMaker", consolePath: "AWS Console → Services → Internet of Things → AWS IoT Things Graph, TwinMaker" },
        { id: "iot-gateways",            category: "IOT GATEWAYS",               name: "AWS IoT Core", consolePath: "AWS Console → Services → Internet of Things → AWS IoT Core" }
      ]
    },

    // ---------------------------
    // Management and Governance
    // ---------------------------
    "management-governance": {
      label: "Management and Governance",
      services: [
        { id: "mgmt-anomaly",       category: "ANOMALY DETECTION",               name: "Amazon Lookout for Metrics, CloudWatch Anomaly", consolePath: "AWS Console → Services → Management & Governance → Amazon Lookout for Metrics, CloudWatch Anomaly" },
        { id: "app-data-catalog",   category: "APP/DATA CATALOG",                name: "AWS Service Catalog, AWS Glue Data Catalog", consolePath: "AWS Console → Services → Management & Governance → AWS Service Catalog, AWS Glue Data Catalog" },
        { id: "automation-orch",    category: "AUTOMATION/ORCHESTRATION",        name: "AWS CloudFormation, OpsWorks, Proton", consolePath: "AWS Console → Services → Management & Governance → AWS CloudFormation, OpsWorks, Proton" },
        { id: "config-management",  category: "CONFIG MANAGEMENT",               name: "AWS Config", consolePath: "AWS Console → Services → Management & Governance → AWS Config" },
        { id: "monitoring",         category: "MONITORING",                      name: "Amazon CloudWatch", consolePath: "AWS Console → Services → Management & Governance → Amazon CloudWatch" },
        { id: "health-dashboards",  category: "HEALTH DASHBOARDS",               name: "AWS Health Dashboard", consolePath: "AWS Console → Services → Management & Governance → AWS Health Dashboard" },
        { id: "hybrid-multi-cloud", category: "HYBRID/MULTI-CLOUD MGMT",         name: "AWS Outposts, ECS Anywhere, Control Tower", consolePath: "AWS Console → Services → Management & Governance → AWS Outposts, ECS Anywhere, Control Tower" },
        { id: "license-mgmt",       category: "LICENSE MANAGEMENT",              name: "AWS License Manager", consolePath: "AWS Console → Services → Management & Governance → AWS License Manager" },
        { id: "logging",            category: "LOGGING",                         name: "AWS CloudTrail, CloudWatch Logs", consolePath: "AWS Console → Services → Management & Governance → AWS CloudTrail, CloudWatch Logs" },
        { id: "admin-console",      category: "ADMIN CONSOLE",                   name: "AWS Management Console", consolePath: "AWS Console → Services → Management & Governance → AWS Management Console" },
        { id: "multi-account-mgmt", category: "MULTI-ACCOUNT MGMT",              name: "AWS Organizations, Control Tower", consolePath: "AWS Console → Services → Management & Governance → AWS Organizations, Control Tower" },
        { id: "network-monitoring", category: "NETWORK MONITORING",              name: "AWS Network Manager", consolePath: "AWS Console → Services → Management & Governance → AWS Network Manager" },
        { id: "policy-enforcement", category: "POLICY ENFORCEMENT",              name: "AWS Organizations, SCPs", consolePath: "AWS Console → Services → Management & Governance → AWS Organizations, SCPs" }
      ]
    },

    // ---------------------------
    // Migration
    // ---------------------------
    "migration": {
      label: "Migration",
      services: [
        { id: "db-migration",       category: "DATABASE MIGRATION",              name: "AWS Database Migration Service (DMS)", consolePath: "AWS Console → Services → Migration & Transfer → AWS Database Migration Service (DMS)" },
        { id: "data-transfer-appl", category: "DATA TRANSFER APPLIANCES",        name: "AWS Snowball, Snowcone", consolePath: "AWS Console → Services → Migration & Transfer → AWS Snowball, Snowcone" },
        { id: "migration-accelerators", category: "MIGRATION ACCELERATORS",      name: "AWS Migration Acceleration Program (MAP)", consolePath: "AWS Console → Services → Migration & Transfer → AWS Migration Acceleration Program (MAP)" },
        { id: "online-transfer-sync", category: "ONLINE TRANSFER & SYNC",        name: "AWS DataSync, AWS Transfer Family", consolePath: "AWS Console → Services → Migration & Transfer → AWS DataSync, AWS Transfer Family" },
        { id: "on-prem-discovery",  category: "ON-PREMISE DISCOVERY",            name: "AWS Migration Evaluator, Application Discovery", consolePath: "AWS Console → Services → Migration & Transfer → AWS Migration Evaluator, Application Discovery" },
        { id: "vm-migration",       category: "VM MIGRATION",                    name: "AWS Application Migration Service (MGN)", consolePath: "AWS Console → Services → Migration & Transfer → AWS Application Migration Service (MGN)" }
      ]
    },

    // ---------------------------
    // Miscellaneous
    // ---------------------------
    "misc": {
      label: "Miscellaneous",
      services: [
        { id: "customer-contact",   category: "CUSTOMER MULTICHANNEL CONTACT",   name: "Amazon Connect, Contact Lens", consolePath: "AWS Console → search bar → \"Amazon Connect, Contact Lens\"" },
        { id: "marketing-notifs",   category: "MARKETING & NOTIFICATIONS",       name: "Amazon Pinpoint, SES", consolePath: "AWS Console → search bar → \"Amazon Pinpoint, SES\"" },
        { id: "healthcare-fhir",    category: "HEALTHCARE (FHIR)",               name: "AWS HealthLake", consolePath: "AWS Console → search bar → \"AWS HealthLake\"" },
        { id: "gaming",             category: "GAMING",                          name: "Amazon GameLift, Lumberyard", consolePath: "AWS Console → search bar → \"Amazon GameLift, Lumberyard\"" },
        { id: "genomics",           category: "GENOMICS",                        name: "Amazon Genomics CLI", consolePath: "AWS Console → search bar → \"Amazon Genomics CLI\"" },
        { id: "geolocation",        category: "GEOLOCATION SERVICES",            name: "Amazon Location Service", consolePath: "AWS Console → search bar → \"Amazon Location Service\"" },
        { id: "media-services",     category: "MEDIA SERVICES",                  name: "AWS Elemental, IVS, Nimble Studio", consolePath: "AWS Console → search bar → \"AWS Elemental, IVS, Nimble Studio\"" },
        { id: "robotics",           category: "ROBOTICS",                        name: "AWS RoboMaker", consolePath: "AWS Console → search bar → \"AWS RoboMaker\"" },
        { id: "satellite-ground",   category: "SATELLITE GROUND STATIONS",       name: "AWS Ground Station", consolePath: "AWS Console → search bar → \"AWS Ground Station\"" },
        { id: "virtual-desktops",   category: "VIRTUAL DESKTOP INFRASTRUCTURE",  name: "Amazon WorkSpaces, AppStream 2.0", consolePath: "AWS Console → search bar → \"Amazon WorkSpaces, AppStream 2.0\"" }
      ]
    },

    // ---------------------------
    // Networking and Content Delivery
    // ---------------------------
    "networking-cdn": {
      label: "Networking and Content Delivery",
      services: [
        { id: "5g-edge-infra",      category: "5G EDGE INFRA",                   name: "AWS Wavelength, Private 5G", consolePath: "AWS Console → Services → Networking & Content Delivery → AWS Wavelength, Private 5G" },
        { id: "net-api-management", category: "API MANAGEMENT",                  name: "Amazon API Gateway", consolePath: "AWS Console → Services → Networking & Content Delivery → Amazon API Gateway" },
        { id: "cdn",                category: "CDN",                             name: "Amazon CloudFront", consolePath: "AWS Console → Services → Networking & Content Delivery → Amazon CloudFront" },
        { id: "dedicated-connect",  category: "DEDICATED CONNECTION",            name: "AWS Direct Connect", consolePath: "AWS Console → Services → Networking & Content Delivery → AWS Direct Connect" },
        { id: "dns",                category: "DNS",                             name: "Amazon Route 53", consolePath: "AWS Console → Services → Networking & Content Delivery → Amazon Route 53" },
        { id: "load-balancing",     category: "LOAD BALANCING",                  name: "ELB (ALB/NLB/CLB)", consolePath: "AWS Console → Services → Networking & Content Delivery → ELB (ALB/NLB/CLB)" },
        { id: "global-acceleration",category: "GLOBAL TRAFFIC ACCELERATION",     name: "AWS Global Accelerator", consolePath: "AWS Console → Services → Networking & Content Delivery → AWS Global Accelerator" },
        { id: "nat",                category: "NAT",                             name: "NAT Gateway", consolePath: "AWS Console → Services → Networking & Content Delivery → NAT Gateway" },
        { id: "vpc-peering",        category: "VPC PEERING",                     name: "VPC Peering", consolePath: "AWS Console → Services → Networking & Content Delivery → VPC Peering" },
        { id: "private-connectivity",category: "PRIVATE CONNECTIVITY",           name: "AWS PrivateLink", consolePath: "AWS Console → Services → Networking & Content Delivery → AWS PrivateLink" },
        { id: "svc-discovery-net",  category: "SERVICE DISCOVERY",               name: "Cloud Map, VPC Lattice", consolePath: "AWS Console → Services → Networking & Content Delivery → Cloud Map, VPC Lattice" },
        { id: "svc-mesh-net",       category: "SERVICE MESH",                    name: "App Mesh", consolePath: "AWS Console → Services → Networking & Content Delivery → App Mesh" },
        { id: "wan-vpn",            category: "WAN/VPN",                         name: "AWS Cloud WAN, AWS VPN", consolePath: "AWS Console → Services → Networking & Content Delivery → AWS Cloud WAN, AWS VPN" },
        { id: "vpc",                category: "VPC",                             name: "Amazon VPC", consolePath: "AWS Console → Services → Networking & Content Delivery → Amazon VPC" }
      ]
    },

    // ---------------------------
    // Security
    // ---------------------------
    "security": {
      label: "Security",
      services: [
        { id: "audit-compliance",   category: "AUDIT AND COMPLIANCE",            name: "AWS Artifact, AWS Audit Manager", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Artifact, AWS Audit Manager" },
        { id: "central-security-mgmt", category: "CENTRALIZED SECURITY MGMT",    name: "AWS Security Hub", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Security Hub" },
        { id: "cert-management",    category: "CERTIFICATE MANAGEMENT",          name: "AWS Certificate Manager", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Certificate Manager" },
        { id: "confidential-compute",category: "CONFIDENTIAL COMPUTING",         name: "AWS Nitro Enclaves", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Nitro Enclaves" },
        { id: "container-security", category: "CONTAINER SECURITY",              name: "Amazon ECR, Inspector", consolePath: "AWS Console → Services → Security, Identity & Compliance → Amazon ECR, Inspector" },
        { id: "data-discovery",     category: "DATA DISCOVERY/CLASSIFICATION",   name: "Amazon Macie", consolePath: "AWS Console → Services → Security, Identity & Compliance → Amazon Macie" },
        { id: "ddos-protection",    category: "DDOS PROTECTION",                 name: "AWS Shield, AWS WAF", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Shield, AWS WAF" },
        { id: "iam",                category: "IDENTITY & ACCESS MGMT (IAM)",    name: "AWS IAM", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS IAM" },
        { id: "key-management",     category: "CERTIFICATE/KEY MANAGEMENT",      name: "AWS KMS, CloudHSM", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS KMS, CloudHSM" },
        { id: "microsoft-ad",       category: "MICROSOFT AD SUPPORT",            name: "AWS Directory Service for Microsoft AD", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Directory Service for Microsoft AD" },
        { id: "regulated-cloud",    category: "REGULATED CLOUD ZONES",           name: "AWS GovCloud", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS GovCloud" },
        { id: "resource-access",    category: "RESOURCE ACCESS POLICIES",        name: "AWS Resource Access Manager", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Resource Access Manager" },
        { id: "secrets-management", category: "SECRETS MANAGEMENT",              name: "AWS Secrets Manager", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Secrets Manager" },
        { id: "context-access",     category: "CONTEXT-BASED ACCESS",            name: "AWS Verified Access", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS Verified Access" },
        // APPROVAL WORKFLOWS: reference shows no AWS equivalent ("—"), so omitted.
        { id: "sso",                category: "SSO",                             name: "AWS IAM Identity Center", consolePath: "AWS Console → Services → Security, Identity & Compliance → AWS IAM Identity Center" },
        { id: "threat-detection",   category: "THREAT DETECTION",                name: "Amazon GuardDuty, Detective", consolePath: "AWS Console → Services → Security, Identity & Compliance → Amazon GuardDuty, Detective" },
        { id: "vulnerability-scan", category: "VULNERABILITY SCANNING",          name: "Amazon Inspector", consolePath: "AWS Console → Services → Security, Identity & Compliance → Amazon Inspector" }
      ]
    }
  }
};
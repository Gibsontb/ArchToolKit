// generated/catalog.generated.js
// Auto-generated. Do not edit by hand.
window.ATK = window.ATK || {};
window.ATK.catalog = {
  "catalog_version": "2025-v2.5",
  "generated_at": "2026-01-08T19:32:58.186Z",
  "providers": [
    "aws",
    "azure",
    "gcp",
    "oci"
  ],
  "rows": [
    {
      "domain": "AI and Machine Learning",
      "capability_name": "AI CONTAINERS",
      "capability_id": "ai_and_machine_learning.ai_containers",
      "used_for": "Run prebuilt ML/AI container images for training and inference on managed container runtimes.",
      "providers": {
        "aws": [
          "Deep Learning Containers"
        ],
        "azure": [
          "GPU support on AKS"
        ],
        "gcp": [
          "Deep Learning Containers"
        ],
        "oci": [
          "Data Science Container Images"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "HUMAN REVIEW/MODERATION",
      "capability_id": "ai_and_machine_learning.human_review_moderation",
      "used_for": "Human moderation/review workflows for AI outputs or sensitive decisions.",
      "providers": {
        "aws": [
          "Augmented AI (A2I)"
        ],
        "azure": [
          "Azure AI Content Safety"
        ],
        "gcp": [],
        "oci": [
          "OCI AI Services (Vision",
          "Text",
          "Language)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "DATA LABELING",
      "capability_id": "ai_and_machine_learning.data_labeling",
      "used_for": "Label and curate training datasets with human-in-the-loop workflows.",
      "providers": {
        "aws": [
          "SageMaker Ground Truth"
        ],
        "azure": [
          "Azure ML Data Labeling"
        ],
        "gcp": [
          "Vertex AI Data Labeling"
        ],
        "oci": [
          "OCI Data Labeling"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "GENERATIVE AI",
      "capability_id": "ai_and_machine_learning.generative_ai",
      "used_for": "Build, host, and operate generative AI applications (foundation models, prompt orchestration, and managed inference).",
      "providers": {
        "aws": [
          "Amazon Bedrock"
        ],
        "azure": [
          "Azure OpenAI"
        ],
        "gcp": [
          "Vertex AI"
        ],
        "oci": [
          "OCI Generative AI"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "INFERENCE ACCELERATION",
      "capability_id": "ai_and_machine_learning.inference_acceleration",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "AWS Inferentia",
          "Elastic Inference"
        ],
        "azure": [
          "GPU support on AKS"
        ],
        "gcp": [
          "Cloud TPU",
          "Edge TPU"
        ],
        "oci": [
          "OCI AI GPU Instances"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "ML/AI CHIPS",
      "capability_id": "ai_and_machine_learning.ml_ai_chips",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "Inferentia",
          "Trainium"
        ],
        "azure": [
          "Maia 100"
        ],
        "gcp": [
          "Cloud TPU",
          "Trillium TPU"
        ],
        "oci": [
          "NVIDIA A100",
          "H100 GPU on OCI"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "NOTEBOOKS",
      "capability_id": "ai_and_machine_learning.notebooks",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "EMR Notebooks"
        ],
        "azure": [
          "Notebooks"
        ],
        "gcp": [
          "Vertex AI Workbench",
          "Colab"
        ],
        "oci": [
          "OCI Data Science Notebooks"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "PRECONFIGURED ML VMS",
      "capability_id": "ai_and_machine_learning.preconfigured_ml_vms",
      "used_for": "Provision and run virtual machine workloads.",
      "providers": {
        "aws": [
          "Deep Learning AMIs"
        ],
        "azure": [
          "Data Science VM"
        ],
        "gcp": [
          "Deep Learning VM Image"
        ],
        "oci": [
          "OCI Marketplace ML Images"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "SPEECH",
      "capability_id": "ai_and_machine_learning.speech",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "Transcribe",
          "Polly"
        ],
        "azure": [
          "Azure Speech"
        ],
        "gcp": [
          "Speech-to-Text & Text-to-Speech API"
        ],
        "oci": [
          "OCI Speech AI"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "TIME-SERIES FORECASTING",
      "capability_id": "ai_and_machine_learning.time_series_forecasting",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "Forecast"
        ],
        "azure": [
          "Azure AutoML Forecasting"
        ],
        "gcp": [
          "TimesFM",
          "Vertex AI Forecasting"
        ],
        "oci": [
          "OCI Forecasting AI"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "AI and Machine Learning",
      "capability_name": "VISUAL INSPECTION",
      "capability_id": "ai_and_machine_learning.visual_inspection",
      "used_for": "Enable machine learning and AI workloads including training, inference, and supporting MLOps.",
      "providers": {
        "aws": [
          "Lookout for Vision"
        ],
        "azure": [
          "Azure Custom Vision"
        ],
        "gcp": [
          "Visual Inspection AI"
        ],
        "oci": [
          "OCI Vision Custom Models"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "BIG DATA PROCESSING",
      "capability_id": "analytics.big_data_processing",
      "used_for": "Managed Hadoop/Spark-style processing for large datasets.",
      "providers": {
        "aws": [
          "Amazon EMR",
          "AWS Glue"
        ],
        "azure": [
          "Azure HDInsight",
          "Data Lake Analytics"
        ],
        "gcp": [
          "Dataproc"
        ],
        "oci": [
          "Oracle Big Data Service"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "DATA EXPLORATION/CATALOG",
      "capability_id": "analytics.data_exploration_catalog",
      "used_for": "Enable data ingestion, storage, processing, and analytics to derive insights and support reporting/ML.",
      "providers": {
        "aws": [
          "Amazon Athena",
          "AWS Glue Data Catalog"
        ],
        "azure": [
          "Azure Data Explorer",
          "Azure Data Catalog"
        ],
        "gcp": [
          "Dataplex",
          "Data Catalog"
        ],
        "oci": [
          "Oracle Data Catalog"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "DATA SHARING/EXCHANGE",
      "capability_id": "analytics.data_sharing_exchange",
      "used_for": "Enable data ingestion, storage, processing, and analytics to derive insights and support reporting/ML.",
      "providers": {
        "aws": [
          "AWS Data Exchange",
          "Lake Formation",
          "AMB"
        ],
        "azure": [
          "Azure Data Share"
        ],
        "gcp": [
          "Analytics Hub",
          "Datashare"
        ],
        "oci": [
          "Oracle Data Integration",
          "Oracle Data Safe"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "DATA WAREHOUSING",
      "capability_id": "analytics.data_warehousing",
      "used_for": "Centralized analytic warehouse for SQL analytics and BI at scale.",
      "providers": {
        "aws": [
          "Amazon Redshift"
        ],
        "azure": [
          "Azure Synapse Analytics",
          "Azure Databricks"
        ],
        "gcp": [
          "BigQuery"
        ],
        "oci": [
          "Oracle Autonomous Data Warehouse"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "ETL",
      "capability_id": "analytics.etl",
      "used_for": "Extract, transform, and load data between systems; build data pipelines.",
      "providers": {
        "aws": [
          "AWS Glue",
          "AWS Data Pipeline"
        ],
        "azure": [
          "Azure Data Factory",
          "Synapse Pipelines"
        ],
        "gcp": [
          "Dataflow",
          "Cloud Data Fusion"
        ],
        "oci": [
          "Oracle Data Integrator",
          "Oracle Cloud Infrastructure"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "MANAGED KAFKA",
      "capability_id": "analytics.managed_kafka",
      "used_for": "Enable data ingestion, storage, processing, and analytics to derive insights and support reporting/ML.",
      "providers": {
        "aws": [
          "Amazon MSK (Managed Streaming for Kafka)"
        ],
        "azure": [
          "Azure Event Hubs for Kafka"
        ],
        "gcp": [
          "Confluent Cloud"
        ],
        "oci": [
          "OCI Streaming (Kafka- Compatible)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Analytics",
      "capability_name": "QUERY SERVICE",
      "capability_id": "analytics.query_service",
      "used_for": "Enable data ingestion, storage, processing, and analytics to derive insights and support reporting/ML.",
      "providers": {
        "aws": [
          "Amazon Athena",
          "Redshift Spectrum"
        ],
        "azure": [
          "Synapse Analytics",
          "Azure Data Lake Analytics"
        ],
        "gcp": [
          "BigQuery SQL"
        ],
        "oci": [
          "Oracle Autonomous Database with SQL"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "API MANAGEMENT",
      "capability_id": "application_integration.api_management",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon API Gateway",
          "AWS AppSync"
        ],
        "azure": [
          "Azure API Management",
          "Azure API Apps"
        ],
        "gcp": [
          "Apigee API Management",
          "API Gateway"
        ],
        "oci": [
          "Oracle API Gateway"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "EVENT HANDLING",
      "capability_id": "application_integration.event_handling",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon EventBridge"
        ],
        "azure": [
          "Azure Event Grid"
        ],
        "gcp": [
          "Eventarc"
        ],
        "oci": [
          "OCI Events and Service Connectors"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "MESSAGING",
      "capability_id": "application_integration.messaging",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon SQS",
          "SNS",
          "MQ"
        ],
        "azure": [
          "Azure Service Bus",
          "Queue Storage",
          "Web PubSub"
        ],
        "gcp": [
          "Pub",
          "Sub"
        ],
        "oci": [
          "Oracle Cloud Infrastructure Queue Service"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "SERVICE MESH",
      "capability_id": "application_integration.service_mesh",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS App Mesh"
        ],
        "azure": [
          "Open Service Mesh (OSM)",
          "AKS"
        ],
        "gcp": [
          "Istio",
          "Anthos Service Mesh"
        ],
        "oci": [
          "Oracle Cloud Service Mesh"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "COLLABORATION",
      "capability_id": "application_integration.collaboration",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [],
        "azure": [
          "Microsoft 365",
          "Azure FluidRelay"
        ],
        "gcp": [
          "Workspace"
        ],
        "oci": [
          "Oracle Content & Experience Cloud"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "EMAIL AND",
      "capability_id": "application_integration.email_and",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon WorkMail"
        ],
        "azure": [
          "Microsoft Outlook"
        ],
        "gcp": [
          "Gmail",
          "Google Calendar"
        ],
        "oci": [
          "Oracle Cloud Email Delivery"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Application Integration",
      "capability_name": "VIDEO CALLS AND",
      "capability_id": "application_integration.video_calls_and",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Chime"
        ],
        "azure": [
          "Microsoft Teams"
        ],
        "gcp": [
          "Google Meet"
        ],
        "oci": [
          "Oracle Web Conferencing (limited)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "AUTOSCALING",
      "capability_id": "compute_and_infrastructure.autoscaling",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "EC2 Auto Scaling",
          "AWS Auto Scaling"
        ],
        "azure": [
          "Virtual Machine Scale Sets",
          "Autoscale"
        ],
        "gcp": [
          "Managed Instance Groups (MIGs)"
        ],
        "oci": [
          "OCI Compute Autoscaling"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "HYBRID/EXTENDED INFRA",
      "capability_id": "compute_and_infrastructure.hybrid_extended_infra",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "AWS Outposts",
          "ECS Anywhere",
          "EKS Anywhere"
        ],
        "azure": [
          "Azure Stack"
        ],
        "gcp": [
          "Google Distributed Cloud"
        ],
        "oci": [
          "Oracle Dedicated Region",
          "Oracle Alloy"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "HPC MANAGEMENT",
      "capability_id": "compute_and_infrastructure.hpc_management",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "AWS ParallelCluster"
        ],
        "azure": [
          "Azure CycleCloud"
        ],
        "gcp": [
          "Cluster Toolkit"
        ],
        "oci": [
          "OCI HPC and Cluster Networking"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "PAAS WEB HOSTING",
      "capability_id": "compute_and_infrastructure.paas_web_hosting",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "Elastic Beanstalk",
          "Lightsail"
        ],
        "azure": [
          "Azure App Service"
        ],
        "gcp": [
          "App Engine"
        ],
        "oci": [
          "Oracle Application Container Cloud"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "VIRTUAL MACHINES",
      "capability_id": "compute_and_infrastructure.virtual_machines",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "EC2"
        ],
        "azure": [
          "Azure Virtual Machines"
        ],
        "gcp": [
          "Compute Engine"
        ],
        "oci": [
          "OCI Compute Instances"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "VMWARE INTEGRATION",
      "capability_id": "compute_and_infrastructure.vmware_integration",
      "used_for": "Provision and run virtual machine workloads.",
      "providers": {
        "aws": [
          "VMware Cloud on AWS"
        ],
        "azure": [
          "Azure VMware Solution"
        ],
        "gcp": [
          "Google Cloud VMware Engine"
        ],
        "oci": [
          "Oracle Cloud VMware Solution (OCVS)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "CONTAINER",
      "capability_id": "compute_and_infrastructure.container",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "App2Container (A2C)"
        ],
        "azure": [
          "Azure Migrate"
        ],
        "gcp": [
          "Migrate to Containers"
        ],
        "oci": [
          "OCI Container Engine & App migration tools"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "MANAGED",
      "capability_id": "compute_and_infrastructure.managed",
      "used_for": "Run application workloads on scalable compute using the appropriate execution model.",
      "providers": {
        "aws": [
          "ECS",
          "AWS Copilot"
        ],
        "azure": [
          "Azure Container Apps"
        ],
        "gcp": [],
        "oci": [
          "Oracle Cloud Native Environment"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Compute and Infrastructure",
      "capability_name": "SERVERLESS",
      "capability_id": "compute_and_infrastructure.serverless",
      "used_for": "Run code without managing servers; event-driven compute.",
      "providers": {
        "aws": [
          "AWS Fargate",
          "App Runner"
        ],
        "azure": [
          "Azure Container Instances"
        ],
        "gcp": [
          "Cloud Run"
        ],
        "oci": [
          "OKE with Virtual Nodes or Functions support"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "ARCHITECTURE REVIEW",
      "capability_id": "cost_controls_and_platforms.architecture_review",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Well- Architected Tool"
        ],
        "azure": [
          "Azure Well- Architected Review"
        ],
        "gcp": [
          "Architecture Framework"
        ],
        "oci": [
          "Oracle Cloud Advisor"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "OPTIMIZATION & RECOMMENDATIONS",
      "capability_id": "cost_controls_and_platforms.optimization_and_recommendations",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Trusted Advisor",
          "Compute Optimizer"
        ],
        "azure": [
          "Azure Advisor"
        ],
        "gcp": [
          "Recommenders"
        ],
        "oci": [
          "Oracle Cloud Advisor"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "SPOT/PREEMPTIBLE VMS",
      "capability_id": "cost_controls_and_platforms.spot_preemptible_vms",
      "used_for": "Provision and run virtual machine workloads.",
      "providers": {
        "aws": [
          "Amazon EC2 Spot Instances"
        ],
        "azure": [
          "Azure Spot Virtual Machines"
        ],
        "gcp": [
          "Google Preemptible VMs",
          "Spot VMs"
        ],
        "oci": [
          "OCI Preemptible Instances"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "BLOCKCHAIN",
      "capability_id": "cost_controls_and_platforms.blockchain",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Managed Blockchain",
          "QLDB"
        ],
        "azure": [
          "Azure Confidential Ledger"
        ],
        "gcp": [
          "Blockchain Node Engine"
        ],
        "oci": [
          "Oracle Blockchain Platform"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "NOSQL",
      "capability_id": "cost_controls_and_platforms.nosql",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Keyspaces (for Cassandra)"
        ],
        "azure": [
          "Azure Cosmos DB"
        ],
        "gcp": [
          "Bigtable"
        ],
        "oci": [
          "Oracle NoSQL"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "NOSQL (GRAPH)",
      "capability_id": "cost_controls_and_platforms.nosql_graph",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Neptune"
        ],
        "azure": [
          "Cosmos DB (Gremlin API)"
        ],
        "gcp": [
          "Neo4j on GCP"
        ],
        "oci": [
          "Oracle Spatial and Graph"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Cost Controls and Platforms",
      "capability_name": "RELATIONAL (RDBMS)",
      "capability_id": "cost_controls_and_platforms.relational_rdbms",
      "used_for": "Managed relational database service for transactional workloads.",
      "providers": {
        "aws": [
          "RDS",
          "Amazon Aurora",
          "Amazon Redshift"
        ],
        "azure": [
          "Azure SQL Database",
          "PostgreSQL",
          "MariaDB",
          "Synapse"
        ],
        "gcp": [
          "Cloud SQL",
          "AlloyDB",
          "Cloud Spanner"
        ],
        "oci": [
          "Oracle Autonomous Database",
          "Oracle Exadata"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "APP",
      "capability_id": "devops_and_developer_tools.app",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS AppConfig"
        ],
        "azure": [
          "Azure App Configuration"
        ],
        "gcp": [
          "Firebase Remote Config"
        ],
        "oci": [
          "Oracle Application Configuration Service"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "CI/CD",
      "capability_id": "devops_and_developer_tools.ci_cd",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "CodePipeline",
          "CodeBuild",
          "CodeDeploy"
        ],
        "azure": [
          "Azure Pipelines",
          "Azure DevOps"
        ],
        "gcp": [
          "Cloud Build",
          "Cloud Deploy"
        ],
        "oci": [
          "OCI DevOps Pipelines"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "CODE DEBUGGING",
      "capability_id": "devops_and_developer_tools.code_debugging",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS X-Ray"
        ],
        "azure": [
          "Azure Monitor",
          "App Insights"
        ],
        "gcp": [
          "Cloud Trace",
          "Firebase Crashlytics"
        ],
        "oci": [
          "OCI Logging Analytics with Trace Viewer"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "GIT REPOSITORIES",
      "capability_id": "devops_and_developer_tools.git_repositories",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS CodeCommit"
        ],
        "azure": [
          "Azure Repos"
        ],
        "gcp": [
          "Cloud Source Repositories"
        ],
        "oci": [
          "OCI DevOps Code Repositories"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "POWERSHELL",
      "capability_id": "devops_and_developer_tools.powershell",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Tools for PowerShell"
        ],
        "azure": [
          "Azure PowerShell"
        ],
        "gcp": [
          "Cloud Tools for PowerShell"
        ],
        "oci": [
          "Oracle OCI PowerShell Modules"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "TESTING",
      "capability_id": "devops_and_developer_tools.testing",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Device Farm",
          "AWS Fault Injection Service (FIS)"
        ],
        "azure": [
          "Azure DevTest Labs",
          "Azure Test Plans"
        ],
        "gcp": [
          "Firebase Test Lab"
        ],
        "oci": [
          "OCI DevOps and Test Automation with Oracle Cloud Testing"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "DevOps and Developer Tools",
      "capability_name": "DEVICE",
      "capability_id": "devops_and_developer_tools.device",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS IoT Core",
          "IoT Device Management",
          "SiteWise"
        ],
        "azure": [
          "Azure IoT Hub",
          "Azure IoT Central"
        ],
        "gcp": [
          "Leverege Connect",
          "IoT Core"
        ],
        "oci": [
          "Oracle IoT Cloud Service"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "IOT SECURITY",
      "capability_id": "iot.iot_security",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS IoT Device Defender"
        ],
        "azure": [
          "Microsoft Defender for IoT"
        ],
        "gcp": [],
        "oci": [
          "Oracle IoT Security Integration"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "IOT GATEWAYS",
      "capability_id": "iot.iot_gateways",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS IoT Core"
        ],
        "azure": [
          "Azure IoT Hub"
        ],
        "gcp": [],
        "oci": [
          "Oracle IoT Cloud Gateway"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "ANOMALY DETECTION",
      "capability_id": "iot.anomaly_detection",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Lookout for Metrics",
          "CloudWatch Anomaly"
        ],
        "azure": [
          "Azure AI Anomaly Detector"
        ],
        "gcp": [
          "Apigee Anomaly Detection"
        ],
        "oci": [
          "OCI Budgets with Alerts",
          "Logging Analytics"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "AUTOMATION/ORCHESTRATION",
      "capability_id": "iot.automation_orchestration",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "CloudFormation",
          "OpsWorks",
          "Proton"
        ],
        "azure": [
          "Azure Resource Manager",
          "Azure Automation",
          "Bicep"
        ],
        "gcp": [
          "Deployment Manager",
          "Cloud Scheduler"
        ],
        "oci": [
          "Oracle Resource Manager",
          "Oracle Stack Management"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "MONITORING",
      "capability_id": "iot.monitoring",
      "used_for": "Metrics collection, alerting, and health monitoring.",
      "providers": {
        "aws": [
          "Amazon CloudWatch"
        ],
        "azure": [
          "Azure Monitor",
          "Log Analytics"
        ],
        "gcp": [
          "Cloud Monitoring"
        ],
        "oci": [
          "Oracle Logging Analytics",
          "OCI Monitoring"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "HYBRID/MULTI-CLOUD MGMT",
      "capability_id": "iot.hybrid_multi_cloud_mgmt",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Outposts",
          "ECS Anywhere",
          "Control Tower"
        ],
        "azure": [
          "Azure Arc",
          "Azure Stack"
        ],
        "gcp": [
          "Anthos",
          "Google Distributed Cloud"
        ],
        "oci": [
          "Oracle Cloud Bridge",
          "Oracle Cloud Observability"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "LOGGING",
      "capability_id": "iot.logging",
      "used_for": "Centralized log collection, retention, and search.",
      "providers": {
        "aws": [
          "AWS CloudTrail",
          "CloudWatch Logs"
        ],
        "azure": [
          "Azure Monitor Logs"
        ],
        "gcp": [
          "Cloud Logging",
          "Cloud Audit Logs"
        ],
        "oci": [
          "Oracle Logging"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "MULTI-ACCOUNT MGMT",
      "capability_id": "iot.multi_account_mgmt",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Organizations",
          "Control Tower"
        ],
        "azure": [
          "Azure Lighthouse",
          "Management Groups"
        ],
        "gcp": [
          "Resource Manager"
        ],
        "oci": [
          "Compartments",
          "Tenancy Management"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "IoT",
      "capability_name": "POLICY ENFORCEMENT",
      "capability_id": "iot.policy_enforcement",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Organizations",
          "SCPs"
        ],
        "azure": [
          "Azure Policy"
        ],
        "gcp": [
          "Organization Policy Service"
        ],
        "oci": [
          "OCI IAM Policies",
          "Governance Rules"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "DATABASE MIGRATION",
      "capability_id": "migration_and_industry.database_migration",
      "used_for": "Managed databases (relational, NoSQL, in-memory) for application data.",
      "providers": {
        "aws": [
          "AWS Database Migration Service (DMS)"
        ],
        "azure": [
          "Azure Database Migration Service"
        ],
        "gcp": [
          "Database Migration Service"
        ],
        "oci": [
          "OCI Database Migration Service"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "MIGRATION ACCELERATORS",
      "capability_id": "migration_and_industry.migration_accelerators",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Migration Acceleration Program (MAP)"
        ],
        "azure": [
          "Azure Migrate & Modernize",
          "FastTrack for Azure"
        ],
        "gcp": [
          "Rapid Migration and Modernization Program (RaMP)"
        ],
        "oci": [
          "Oracle Cloud Lift Services"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "ON-PREMISE DISCOVERY",
      "capability_id": "migration_and_industry.on_premise_discovery",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Migration Evaluator",
          "Application Discovery"
        ],
        "azure": [
          "Azure Migrate"
        ],
        "gcp": [],
        "oci": [
          "Oracle Cloud Migration Planning Tools"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "CUSTOMER",
      "capability_id": "migration_and_industry.customer",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Connect",
          "Contact Lens"
        ],
        "azure": [
          "Azure Communication Services"
        ],
        "gcp": [
          "Contact Center AI"
        ],
        "oci": [
          "Oracle Service Cloud",
          "B2C Service",
          "Digital Assistant"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "HEALTHCARE (FHIR)",
      "capability_id": "migration_and_industry.healthcare_fhir",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS HealthLake"
        ],
        "azure": [
          "Azure Health Data Services"
        ],
        "gcp": [
          "Cloud Healthcare API",
          "Apigee HealthAPIx"
        ],
        "oci": [
          "Oracle Healthcare Data Platform",
          "Oracle Health FHIR"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "GENOMICS",
      "capability_id": "migration_and_industry.genomics",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "Amazon Genomics CLI"
        ],
        "azure": [
          "Microsoft Genomics"
        ],
        "gcp": [
          "Cloud Life Sciences Batch"
        ],
        "oci": [
          "Oracle Genomics Cloud Services (via OCI Marketplace)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "MEDIA SERVICES",
      "capability_id": "migration_and_industry.media_services",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Elemental",
          "IVS",
          "Nimble Studio"
        ],
        "azure": [
          "Azure Video Indexer",
          "Azure Media Services"
        ],
        "gcp": [
          "Video AI",
          "Live Stream API",
          "Transcoder API"
        ],
        "oci": [
          "Oracle Cloud Media Streams",
          "Media Cloud"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Migration and Industry",
      "capability_name": "SATELLITE GROUND STATIONS",
      "capability_id": "migration_and_industry.satellite_ground_stations",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [
          "AWS Ground Station"
        ],
        "azure": [
          "Azure Orbital"
        ],
        "gcp": [],
        "oci": [
          "Oracle Space-Based Data Integration (3rd- party reliant)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "5G EDGE INFRA",
      "capability_id": "networking_and_edge.5g_edge_infra",
      "used_for": "Provide core networking capability to connect, segment, secure, and route traffic for workloads.",
      "providers": {
        "aws": [
          "AWS Wavelength",
          "Private 5G"
        ],
        "azure": [
          "Azure Private 5G Core",
          "Azure MEC"
        ],
        "gcp": [],
        "oci": [
          "Oracle MEC (via partner integrations)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "CDN",
      "capability_id": "networking_and_edge.cdn",
      "used_for": "Content delivery network for low-latency content distribution.",
      "providers": {
        "aws": [
          "CloudFront"
        ],
        "azure": [
          "Azure Front Door",
          "Azure CDN"
        ],
        "gcp": [
          "Cloud CDN",
          "Media CDN"
        ],
        "oci": [
          "OCI Content Delivery Network"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "DNS",
      "capability_id": "networking_and_edge.dns",
      "used_for": "Domain name resolution and traffic routing.",
      "providers": {
        "aws": [
          "Amazon Route 53"
        ],
        "azure": [
          "Azure DNS"
        ],
        "gcp": [
          "Cloud DNS"
        ],
        "oci": [
          "OCI DNS"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "GLOBAL TRAFFIC",
      "capability_id": "networking_and_edge.global_traffic",
      "used_for": "Provide core networking capability to connect, segment, secure, and route traffic for workloads.",
      "providers": {
        "aws": [
          "AWS Global Accelerator"
        ],
        "azure": [
          "Azure Front Door"
        ],
        "gcp": [
          "Premium Network Tier"
        ],
        "oci": [
          "OCI Traffic Management"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "VPC PEERING",
      "capability_id": "networking_and_edge.vpc_peering",
      "used_for": "Isolated virtual network segmentation and routing.",
      "providers": {
        "aws": [
          "VPC Peering"
        ],
        "azure": [
          "Azure VNet Peering"
        ],
        "gcp": [
          "VPC Peering"
        ],
        "oci": [
          "VCN Peering (Virtual Cloud Network Peering)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "SERVICE DISCOVERY",
      "capability_id": "networking_and_edge.service_discovery",
      "used_for": "Provide core networking capability to connect, segment, secure, and route traffic for workloads.",
      "providers": {
        "aws": [
          "Cloud Map",
          "VPC Lattice"
        ],
        "azure": [
          "Azure App Config",
          "Azure Sphere (DNS- SD)"
        ],
        "gcp": [
          "Service Directory"
        ],
        "oci": [
          "Oracle Cloud Service Discovery"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Networking and Edge",
      "capability_name": "WAN/VPN",
      "capability_id": "networking_and_edge.wan_vpn",
      "used_for": "Encrypted site-to-site or client VPN connectivity.",
      "providers": {
        "aws": [
          "AWS Cloud WAN",
          "AWS VPN"
        ],
        "azure": [
          "Azure Virtual WAN",
          "VPN Gateway"
        ],
        "gcp": [
          "Network Connectivity Center",
          "Cloud VPN"
        ],
        "oci": [
          "Oracle Cloud WAN",
          "OCI VPN Connect"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "AUDIT AND COMPLIANCE",
      "capability_id": "security.audit_and_compliance",
      "used_for": "Assess, report, and enforce compliance against standards/policies.",
      "providers": {
        "aws": [
          "AWS Artifact",
          "AWS Audit Manager"
        ],
        "azure": [
          "Microsoft Service Trust Portal"
        ],
        "gcp": [
          "Assured Workloads"
        ],
        "oci": [
          "Oracle Risk Management Cloud",
          "OCI Audit Logs"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "CERTIFICATE MANAGEMENT",
      "capability_id": "security.certificate_management",
      "used_for": "Issue and manage TLS certificates and private CAs.",
      "providers": {
        "aws": [
          "AWS Certificate Manager"
        ],
        "azure": [
          "Azure App Service Certificates"
        ],
        "gcp": [
          "Certificate Authority Service"
        ],
        "oci": [
          "Oracle Certificate Management (OCI Certificates)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "CONTAINER SECURITY",
      "capability_id": "security.container_security",
      "used_for": "Provide security controls to protect identities, data, workloads, and meet compliance requirements.",
      "providers": {
        "aws": [
          "Amazon ECR",
          "Inspector"
        ],
        "azure": [
          "Microsoft Defender for Containers"
        ],
        "gcp": [
          "Binary Authorization",
          "Artifact Analysis"
        ],
        "oci": [
          "Oracle Container Security in OCI DevOps"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "DDOS PROTECTION",
      "capability_id": "security.ddos_protection",
      "used_for": "Protect against distributed denial-of-service attacks.",
      "providers": {
        "aws": [
          "AWS Shield",
          "AWS WAF"
        ],
        "azure": [
          "Azure DDoS Protection",
          "Azure WAF"
        ],
        "gcp": [
          "Google Cloud Armor"
        ],
        "oci": [
          "Oracle Web Application Firewall (WAF)"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "CERTIFICATE/KEY MANAGEMENT",
      "capability_id": "security.certificate_key_management",
      "used_for": "Manage encryption keys, rotation, and access controls.",
      "providers": {
        "aws": [
          "AWS KMS",
          "CloudHSM"
        ],
        "azure": [
          "Azure Key Vault",
          "Azure Dedicated HSM"
        ],
        "gcp": [
          "Cloud KMS",
          "Cloud HSM"
        ],
        "oci": [
          "Oracle Cloud Infrastructure Vault"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "REGULATED CLOUD ZONES",
      "capability_id": "security.regulated_cloud_zones",
      "used_for": "Provide security controls to protect identities, data, workloads, and meet compliance requirements.",
      "providers": {
        "aws": [
          "AWS GovCloud"
        ],
        "azure": [
          "Azure Government"
        ],
        "gcp": [
          "Assured Workloads"
        ],
        "oci": [
          "Oracle Government Cloud Regions"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Security",
      "capability_name": "SECRETS MANAGEMENT",
      "capability_id": "security.secrets_management",
      "used_for": "Store and rotate secrets (passwords, tokens, API keys) securely.",
      "providers": {
        "aws": [
          "AWS Secrets Manager"
        ],
        "azure": [
          "Azure Key Vault (Secrets)"
        ],
        "gcp": [
          "Secret Manager"
        ],
        "oci": [
          "Oracle Secrets in OCI Vault"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Governance and Access",
      "capability_name": "APPROVAL WORKFLOWS",
      "capability_id": "governance_and_access.approval_workflows",
      "used_for": "Provide a cloud capability used in architecture decisions; mapped to provider-native services for implementation.",
      "providers": {
        "aws": [],
        "azure": [
          "Customer Lockbox for Microsoft Azure"
        ],
        "gcp": [
          "Access Transparency",
          "Access Approval"
        ],
        "oci": [
          "Oracle Approval Workflows in Governance"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    },
    {
      "domain": "Governance and Access",
      "capability_name": "THREAT DETECTION",
      "capability_id": "governance_and_access.threat_detection",
      "used_for": "Detect threats, anomalies, and malicious activity.",
      "providers": {
        "aws": [
          "GuardDuty",
          "Detective"
        ],
        "azure": [
          "Microsoft Defender for Cloud",
          "Sentinel"
        ],
        "gcp": [
          "SCC",
          "Event Threat Detection"
        ],
        "oci": [
          "Oracle Cloud Guard",
          "Logging Analytics Threat Detection"
        ]
      },
      "notes": "",
      "status": "active",
      "last_reviewed": "2025-01-01"
    }
  ]
};

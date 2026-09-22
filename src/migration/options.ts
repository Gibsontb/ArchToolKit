/**
 * The answer sets the application intake offers.
 *
 * Every one of these was a datalist or a dropdown on the ported page; they are
 * here so the form, the CSV import and the tests all read the same list. The
 * free-text fields keep their suggestions as a combo: the list is what people
 * usually answer, not everything they may.
 */

export const CRITICALITY = ['Low', 'Medium', 'High', 'Mission Critical'] as const;
export type Criticality = (typeof CRITICALITY)[number];

export const WORKLOAD_TYPES = [
  'General LOB App',
  'Public Web',
  'Internal Web',
  'Batch',
  'Analytics',
  'AI/ML',
  'ETL / Data Movement',
  'Messaging / Integration',
] as const;

export const CLOUDS = ['aws', 'azure', 'gcp', 'oci'] as const;
export type Cloud = (typeof CLOUDS)[number];

export const CLOUD_LABELS: Readonly<Record<Cloud, string>> = {
  aws: 'AWS',
  azure: 'Azure',
  gcp: 'Google Cloud',
  oci: 'Oracle Cloud',
};

/** Compliance scopes, with what each one means in a sentence. */
export const COMPLIANCE: readonly { value: string; label: string; hint: string }[] = [
  { value: 'commercial', label: 'Commercial', hint: 'Standard commercial cloud controls' },
  { value: 'fedramp_low', label: 'FedRAMP Low', hint: 'Federal ATO baseline (Low)' },
  { value: 'fedramp_moderate', label: 'FedRAMP Moderate', hint: 'Federal ATO baseline (Moderate)' },
  { value: 'fedramp_high', label: 'FedRAMP High', hint: 'Federal ATO baseline (High)' },
  { value: 'cjis', label: 'CJIS', hint: 'Criminal justice information' },
  { value: 'hipaa', label: 'HIPAA', hint: 'PHI / healthcare' },
  { value: 'pci', label: 'PCI DSS', hint: 'Payment card data' },
  { value: 'sox', label: 'SOX', hint: 'Financial reporting controls' },
  { value: 'fisma', label: 'FISMA', hint: 'Federal information system controls' },
  { value: 'cmmc', label: 'CMMC', hint: 'Defense supply chain requirements' },
  { value: 'itars', label: 'ITAR', hint: 'Export-controlled data' },
  { value: 'gdpr', label: 'GDPR', hint: 'EU personal data protections' },
  { value: 'ferpa', label: 'FERPA', hint: 'Student education records' },
  { value: 'soc2', label: 'SOC 2', hint: 'Trust services criteria' },
  { value: 'iso27001', label: 'ISO 27001', hint: 'ISMS certification' },
];

/** The constraints that decide the route on their own, whatever the score says. */
export const GATES: readonly { id: string; label: string; hint: string }[] = [
  { id: 'isObsolete', label: 'Obsolete / no longer used', hint: 'Candidate for retirement' },
  { id: 'vendorSaaSAvailable', label: 'Vendor SaaS replacement exists', hint: 'Candidate for repurchase' },
  { id: 'mustStayOnPrem', label: 'Must stay on-premises (policy)', hint: 'Retain for now' },
  { id: 'hardwareBound', label: 'Hardware bound / appliance dependency', hint: 'Retain until decoupled' },
  { id: 'mainframeBound', label: 'Mainframe dependency', hint: 'Retain until a strategy is defined' },
  { id: 'dataSovereigntyRequired', label: 'Data sovereignty required', hint: 'Sovereign or regulated landing zone' },
];


export const SUGGESTED_STACKS: readonly string[] = [
  ".NET Framework",
  ".NET (Core/Modern)",
  "C#",
  "F#",
  "ASP.NET MVC",
  "ASP.NET WebForms",
  "Java 8",
  "Java 11",
  "Java 17+",
  "Spring",
  "JBoss/WildFly",
  "WebLogic",
  "Node.js",
  "Express",
  "NestJS",
  "Python",
  "Django",
  "Flask",
  "FastAPI",
  "Go",
  "Gin",
  "PHP",
  "Laravel",
  "Symfony",
  "Ruby",
  "Rails",
  "C/C++",
  "Rust",
  "COBOL",
  "Mainframe",
  "PowerBuilder",
  "VB6",
  "Delphi",
  "ColdFusion",
  "SharePoint",
  "Dynamics",
  "SAP ABAP",
  "Microservices",
  "SOA",
  "Monolith (single deployable)",
  "Mixed / Hybrid",
  "Other",
];

export const SUGGESTED_OS_RUNTIMES: readonly string[] = [
  "Windows Server 2008 R2",
  "Windows Server 2012",
  "Windows Server 2016",
  "Windows Server 2019",
  "Windows Server 2022",
  "RHEL 6",
  "RHEL 7",
  "RHEL 8",
  "RHEL 9",
  "Ubuntu 16.04",
  "Ubuntu 18.04",
  "Ubuntu 20.04",
  "Ubuntu 22.04",
  "Ubuntu 24.04",
  "SUSE SLES 12",
  "SUSE SLES 15",
  "Amazon Linux 2",
  "Amazon Linux 2023",
  "Debian",
  "CentOS",
  "AIX",
  "HP-UX",
  "Solaris",
  "Mainframe z/OS",
  "VMware Appliance",
  "Bare Metal",
  "Containerized Runtime",
  "Kubernetes",
  "Serverless Runtime",
  "Other",
];

export const SUGGESTED_DATABASES: readonly string[] = [
  "SQL Server",
  "SQL Server Always On",
  "Oracle",
  "Oracle RAC",
  "PostgreSQL",
  "MySQL",
  "MariaDB",
  "DB2",
  "MongoDB",
  "Cassandra",
  "Couchbase",
  "Redis",
  "SQLite",
  "Teradata",
  "Netezza",
  "Vertica",
  "Snowflake",
  "No Database",
  "Other",
];

export const SUGGESTED_HOSTING: readonly string[] = [
  "VMware vSphere",
  "Hyper-V",
  "Bare Metal",
  "KVM",
  "Mainframe",
  "On-Prem Kubernetes",
  "On-Prem PaaS",
  "Already in Cloud",
  "Other",
];

export const SUGGESTED_INTEGRATIONS: readonly string[] = [
  "REST API",
  "SOAP",
  "Message Queue (MQ)",
  "Kafka",
  "File Drop (SFTP/FTPS)",
  "Database Link / Replication",
  "Email",
  "EDI",
  "Custom TCP/UDP",
];

export const SUGGESTED_PATTERNS: readonly string[] = [
  "Monolith",
  "3-tier",
  "N-tier",
  "SOA",
  "Microservices",
  "Event-driven",
  "Client/Server",
  "Batch",
  "Other",
];

export const SUGGESTED_VENDORS: readonly string[] = [
  "Custom Built",
  "Open Source",
  "Microsoft",
  "Oracle",
  "IBM",
  "SAP",
  "VMware",
  "Red Hat",
  "Broadcom",
  "Cisco",
  "Salesforce",
  "ServiceNow",
  "Workday",
  "Atlassian",
  "Infor",
  "Epic",
  "Cerner",
  "Tyler Technologies",
  "OpenText",
  "Micro Focus",
  "Other Vendor",
];

export const SUGGESTED_IDENTITY: readonly string[] = [
  "Active Directory (AD)",
  "LDAP",
  "Kerberos",
  "Azure AD / Entra ID",
  "Okta",
  "Ping Identity",
  "ADFS",
  "SAML",
  "OIDC",
  "OAuth2",
  "RADIUS",
  "CAC/PIV",
  "Local Accounts",
  "Custom Auth",
  "Other",
];

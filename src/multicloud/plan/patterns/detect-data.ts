/**
 * Workload-type detection data (addendum A.3.7): the evidence per type, from
 * five signals, each weighted:
 *
 * | Signal                               | Weight            |
 * |--------------------------------------|-------------------|
 * | installed software / services        | 0.6               |
 * | listening ports                      | 0.3               |
 * | name / annotation                    | 0.2               |
 * | appliance guest id / annotation      | 0.4               |
 * | OS / origin                          | decisive (non-x86)|
 *
 * A type's confidence is the sum of the weights of the signals that matched
 * (each signal counted once), capped at 1. Ports and names are the vendors'
 * documented defaults; each detector carries the source it was taken from.
 */

import type { WorkloadType } from '../types.ts';

export const SIGNAL_WEIGHTS = Object.freeze({ software: 0.6, ports: 0.3, name: 0.2, appliance: 0.4, os: 1 });
export type Signal = keyof typeof SIGNAL_WEIGHTS;

/** At or above: detected (confirm to keep). */
export const DETECTED_THRESHOLD = 0.7;
/** At or above (and below detected): "unknown — confirm". Below: the generic type by OS. */
export const CONFIRM_THRESHOLD = 0.4;

/** A port predicate: one port, an inclusive range, or a test. */
export type PortMatch = number | readonly [number, number] | ((port: number) => boolean);

export interface Detector {
  readonly type: WorkloadType;
  /** Installed software display names or package names. */
  readonly software?: readonly RegExp[];
  /** Service / daemon / process names. */
  readonly services?: readonly RegExp[];
  readonly ports?: readonly PortMatch[];
  /** Extra facts a port match needs (e.g. RDS: more than 2 sessions on 3389). */
  readonly portsNeed?: 'sessions>2' | 'shares>10';
  /** Hostname / annotation pattern. */
  readonly name?: RegExp;
  /** vSphere guest id, guest OS text or annotation of a vendor appliance (OVA). */
  readonly appliance?: RegExp;
  readonly source: string;
}

/** HANA ports: 3<NN>13 / 3<NN>15 (instance number NN). */
const hanaPort = (p: number): boolean => p >= 30000 && p <= 39999 && (p % 100 === 13 || p % 100 === 15);

const SAP_PORTS = 'https://help.sap.com/docs/Security/575a9f0e56f34c6e8138439eefc32b16/616a3c0b1cc748238de9c0341b15c63c.html';

export const DETECTORS: readonly Detector[] = [
  { type: 'sap-hana', software: [/sap hana database/i], services: [/^hdb(indexserver|nameserver|daemon)$/i, /sapstartsrv.*hdb/i], ports: [hanaPort], name: /(^|[-_.])(hana|hdb)/i, source: SAP_PORTS },
  { type: 'sap-netweaver', software: [/sap netweaver/i, /sap kernel/i], services: [/^sapstartsrv$/i, /^disp\+work/i], ports: [[3200, 3299], [3300, 3399]], name: /(^|[-_.])(sap|s4|ecc|pas|aas)/i, source: SAP_PORTS },
  { type: 'sap-java', software: [/sap netweaver.*java/i, /sap j2ee/i], services: [/^jstart$/i], ports: [[50000, 50099]], name: /(^|[-_.])(sapj|po|pi)(\d+|[-_.]|$)/i, source: SAP_PORTS },
  { type: 'oracle-ebs', software: [/oracle e-business suite/i], services: [/adstrtal/i, /adadmin/i], name: /(^|[-_.])ebs/i, source: 'https://docs.oracle.com/cd/E26401_01/doc.122/e22953/T174296T174302.htm' },
  { type: 'peoplesoft', software: [/peoplesoft/i, /peopletools/i], services: [/psadmin/i], name: /(^|[-_.])(psft|peoplesoft)/i, source: 'https://docs.oracle.com/cd/F52214_01/psft/pdf/psadmin.pdf' },
  { type: 'jd-edwards', software: [/jd edwards/i, /enterpriseone/i], services: [/^jde/i], name: /(^|[-_.])(jde|e1)/i, source: 'https://docs.oracle.com/cd/E84502_01/learnjde/index.html' },
  { type: 'siebel', software: [/siebel/i], services: [/siebsrvr/i, /siebel server/i], name: /(^|[-_.])sbl/i, source: 'https://docs.oracle.com/cd/F26413_01/index.html' },
  { type: 'weblogic', software: [/weblogic/i], services: [/weblogic/i, /nodemanager/i], ports: [7001, 7002], name: /(^|[-_.])(wls|weblogic)/i, source: 'https://docs.oracle.com/en/middleware/standalone/weblogic-server/14.1.1.0/' },
  { type: 'exchange', software: [/microsoft exchange server/i], services: [/^msexchange(transport|is|frontendtransport|mailboxassistants)$/i], ports: [25, 587], name: /(^|[-_.])(exch|mbx|mail|cas)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/exchange/plan-and-deploy/deployment-ref/network-ports' },
  { type: 'sharepoint', software: [/sharepoint server/i], services: [/^sptimerv4$/i, /^spsearch/i], ports: [32843, 32844], name: /(^|[-_.])sp(web|app|wfe|srch)/i, source: 'https://learn.microsoft.com/en-us/sharepoint/install/installation-and-configuration-overview' },
  { type: 'dynamics-crm', software: [/dynamics (crm|365).*server/i], services: [/mscrmasyncservice/i], name: /(^|[-_.])crm/i, source: 'https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/deploy/microsoft-dynamics-365-server-roles' },
  { type: 'iis-dotnet', software: [/internet information services/i, /\.net framework/i], services: [/^w3svc$/i, /^was$/i], ports: [80, 443], name: /(^|[-_.])(web|iis|www)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/iis/get-started/introduction-to-iis/iis-web-server-overview' },
  { type: 'citrix-vda', software: [/citrix virtual delivery agent/i, /citrix vda/i], services: [/^brokeragent$/i, /^picasvc/i], ports: [1494, 2598], name: /(^|[-_.])(ctx|xa|vda|xd)(\d+|[-_.]|$)/i, source: 'https://docs.citrix.com/en-us/tech-zone/build/tech-papers/citrix-communication-ports.html' },
  { type: 'citrix-infra', software: [/citrix (delivery controller|storefront|director|license server)/i], services: [/citrixbrokerservice/i, /citrix storefront/i], ports: [27000, 7279], name: /(^|[-_.])(ddc|sf|ctxdc|storefront)(\d+|[-_.]|$)/i, source: 'https://docs.citrix.com/en-us/tech-zone/build/tech-papers/citrix-communication-ports.html' },
  { type: 'rds-host', software: [/remote desktop session host/i], services: [/^termservice$/i], ports: [3389], portsNeed: 'sessions>2', name: /(^|[-_.])(rds|rdsh|ts)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/welcome-to-rds' },
  { type: 'horizon', software: [/(vmware|omnissa) horizon agent/i, /horizon connection server/i], services: [/wsnm/i, /blast/i], ports: [22443, 4172], name: /(^|[-_.])(hzn|horizon|vdi)(\d+|[-_.]|$)/i, source: 'https://docs.omnissa.com/bundle/HorizonNetworkPortsV2212' },
  { type: 'file-server', software: [/file server resource manager/i, /dfs namespaces/i], services: [/^lanmanserver$/i, /^dfs$/i], ports: [445], portsNeed: 'shares>10', name: /(^|[-_.])(fs|file|nas)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/windows-server/storage/file-server/file-server-smb-overview' },
  { type: 'nas-gateway', software: [/nfs server/i, /nfs-kernel-server/i, /nfs-utils/i], services: [/^nfs-server$/i, /^nfsd$/i], ports: [2049], name: /(^|[-_.])(nas|nfs)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/windows-server/storage/nfs/nfs-overview' },
  { type: 'print', software: [/print and document services/i], services: [/^spooler$/i], name: /(^|[-_.])(prt|print|ps)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/printing/back-up-restore-printers' },
  { type: 'websphere', software: [/websphere application server/i], services: [/websphere/i, /was\d*server/i], ports: [9043, 9060, 9080], name: /(^|[-_.])was(\d+|[-_.]|$)/i, source: 'https://www.ibm.com/docs/en/was/9.0.5' },
  { type: 'jboss', software: [/jboss eap/i, /wildfly/i], services: [/jboss/i, /wildfly/i], ports: [9990], name: /(^|[-_.])(jboss|eap|wildfly)/i, source: 'https://docs.redhat.com/en/documentation/red_hat_jboss_enterprise_application_platform/' },
  { type: 'tomcat', software: [/apache tomcat/i, /^tomcat\d*/i], services: [/^tomcat\d*$/i], ports: [8080, 8005], name: /(^|[-_.])tomcat/i, source: 'https://tomcat.apache.org/tomcat-10.1-doc/config/http.html' },
  { type: 'ibm-mq', software: [/ibm mq/i, /websphere mq/i], services: [/^mqm$/i, /amqzxma0/i], ports: [1414], name: /(^|[-_.])(mq|qmgr)(\d+|[-_.]|$)/i, source: 'https://www.ibm.com/docs/en/ibm-mq/9.4' },
  { type: 'rabbitmq', software: [/rabbitmq/i], services: [/rabbitmq/i, /beam\.smp/i], ports: [5672, 15672], name: /(^|[-_.])(rmq|rabbit)/i, source: 'https://www.rabbitmq.com/docs/networking' },
  { type: 'kafka', software: [/kafka/i, /confluent/i], services: [/kafka/i], ports: [9092], name: /(^|[-_.])(kafka|kfk|broker)(\d+|[-_.]|$)/i, source: 'https://kafka.apache.org/documentation/' },
  { type: 'ad-ds', software: [/active directory domain services/i], services: [/^ntds$/i, /^netlogon$/i, /^kdc$/i], ports: [88, 389, 636, 3268], name: /(^|[-_.])(dc|adc|ad)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/service-overview-and-network-port-requirements' },
  { type: 'dns', software: [/dns server/i, /^bind\d*/i], services: [/^dns$/i, /^named$/i], ports: [53], name: /(^|[-_.])(dns|ns)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/windows-server/networking/dns/dns-overview' },
  { type: 'dhcp', software: [/dhcp server/i, /isc-dhcp-server/i, /kea/i], services: [/^dhcpserver$/i, /^dhcpd$/i], ports: [67], name: /(^|[-_.])dhcp(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/powershell/module/dhcpserver/export-dhcpserver' },
  { type: 'adcs', software: [/active directory certificate services/i], services: [/^certsvc$/i], name: /(^|[-_.])(ca|pki|adcs)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/troubleshoot/windows-server/certificates-and-public-key-infrastructure-pki/move-certification-authority-to-another-server' },
  { type: 'ntp', software: [/^ntp$/i, /chrony/i], services: [/^ntpd$/i, /^chronyd$/i], ports: [123], name: /(^|[-_.])(ntp|time)(\d+|[-_.]|$)/i, source: 'https://www.ntp.org/documentation/' },
  { type: 'jump-host', name: /(^|[-_.])(jump|jmp|bastion|jh)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/azure/bastion/bastion-overview' },
  { type: 'k8s-node', software: [/kubelet/i, /kubeadm/i, /rke2/i, /k3s/i], services: [/^kubelet$/i, /^containerd$/i], ports: [6443, 10250], name: /(^|[-_.])(k8s|kube|node|worker|master)(\d+|[-_.]|$)/i, source: 'https://kubernetes.io/docs/reference/networking/ports-and-protocols/' },
  { type: 'openshift-node', software: [/openshift/i, /cri-o/i], services: [/^crio$/i, /openshift/i], ports: [6443, 22623], name: /(^|[-_.])(ocp|openshift)/i, source: 'https://docs.redhat.com/en/documentation/openshift_container_platform/' },
  { type: 'docker-host', software: [/docker(-ce|-engine| engine)?$/i, /docker-ce/i], services: [/^dockerd?$/i], ports: [2375, 2376], name: /(^|[-_.])(docker|dkr)(\d+|[-_.]|$)/i, source: 'https://docs.docker.com/engine/security/protect-access/' },
  { type: 'db-host', software: [/sql server/i, /oracle database/i, /postgresql/i, /mysql server/i, /mariadb/i, /db2/i, /mongodb/i, /redis/i, /cassandra/i, /elasticsearch/i, /informix/i, /sybase|adaptive server/i], services: [/^mssqlserver$/i, /^mssql\$/i, /^ora_pmon/i, /^postgres/i, /^mysqld$/i, /^mongod$/i, /^redis-server$/i, /^db2sysc$/i], ports: [1521, 1433, 5432, 3306, 50000, 5000, 9088, 27017, 6379, 9042, 9200], name: /(^|[-_.])(db|sql|ora|pg|mysql|mongo)(\d+|[-_.]|$)/i, source: 'https://learn.microsoft.com/en-us/sql/sql-server/install/configure-the-windows-firewall-to-allow-sql-server-access' },
  { type: 'batch', software: [/control-m/i, /autosys/i, /tivoli workload scheduler/i], services: [/ctmag/i, /autosys/i], name: /(^|[-_.])(batch|sched|ctm)(\d+|[-_.]|$)/i, source: 'https://documents.bmc.com/supportu/9.0.21/en-US/Documentation/Control-M_Agent.htm' },
  { type: 'appliance-f5', appliance: /big-?ip|\bf5\b/i, ports: [8443], name: /(^|[-_.])(f5|bigip|ltm|gtm)(\d+|[-_.]|$)/i, source: 'https://my.f5.com/manage/s/article/K46122561' },
  { type: 'appliance-paloalto', appliance: /pan-?os|palo ?alto|vm-series/i, ports: [3978], name: /(^|[-_.])(pa|pan|palo)(\d+|[-_.]|$)/i, source: 'https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-admin/firewall-administration/reference-port-number-usage' },
  { type: 'appliance-fortinet', appliance: /forti(gate|os)/i, ports: [541, 703], name: /(^|[-_.])(fgt|forti|fortigate)(\d+|[-_.]|$)/i, source: 'https://docs.fortinet.com/document/fortigate/latest/fortigate-ports/303168/fortigate-open-ports' },
  { type: 'appliance-checkpoint', appliance: /check ?point|gaia/i, ports: [18190, 18191, 18192, 257], name: /(^|[-_.])(cp|chkp|gw)(\d+|[-_.]|$)/i, source: 'https://support.checkpoint.com/results/sk/sk52421' },
  { type: 'appliance-cisco', appliance: /cisco|csr1000v|c8000v|asav|ios-?xe/i, name: /(^|[-_.])(asa|csr|c8k|rtr)(\d+|[-_.]|$)/i, source: 'https://www.cisco.com/c/en/us/products/routers/catalyst-8000v-edge-software/index.html' },
];

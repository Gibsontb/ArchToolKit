/**
 * Hand-written containers playbooks: a Docker host with an app on it, a
 * Compose project, a Podman service under systemd, and the Kubernetes and
 * OpenShift jobs an engineer reaches for — an app with its Service and
 * Ingress, a Helm release, config and secrets, and a cluster report.
 *
 * Host-level modules (Docker, Podman) run against an inventory group; the
 * Kubernetes API modules run on localhost against the current kubeconfig.
 */

import type { Blueprint, BlueprintInput } from '../../kit/blueprint.ts';
import { HOSTS_INPUT } from './common.ts';
import { items, on, pairs, playbookScenario } from './scenario.ts';

const hosts = (group: string): BlueprintInput => ({ ...HOSTS_INPUT, default: group });

/** `KEY=value` lines as a mapping, values kept as strings. */
function envMap(value: unknown): Record<string, string> {
  return Object.fromEntries(pairs(value).filter(([k]) => k));
}

/** A name safe to use inside a variable name. */
const varSafe = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const K8S_LOCAL = { hosts: 'localhost', connection: 'local', gather_facts: false } as const;

const docker_host_app = playbookScenario({
  id: 'ctr_docker_host_app',
  label: 'Docker host with an app container',
  group: 'Playbooks · Docker',
  description:
    'Install and start Docker Engine, write daemon.json, add users to the docker group, then run a container on its own network with a named volume.',
  inputs: [
    hosts('docker_hosts'),
    {
      id: 'distro',
      label: 'Host OS family',
      control: 'select',
      default: 'debian',
      options: [
        { value: 'debian', label: 'Debian / Ubuntu (distro docker.io packages)' },
        { value: 'rhel', label: 'RHEL / Rocky / Alma (Docker CE repository)' },
      ],
    },
    { id: 'log_max_size', label: 'Container log max size', control: 'text', default: '50m', hint: 'json-file log rotation, e.g. 10m, 50m' },
    { id: 'log_max_file', label: 'Container log files kept', control: 'number', default: 3, min: 1, max: 20 },
    { id: 'docker_users', label: 'Users in the docker group', control: 'textarea', default: 'deploy', hint: 'One per line; they must already exist' },
    { id: 'container_name', label: 'Container name', control: 'text', default: 'web' },
    { id: 'image', label: 'Image', control: 'text', default: 'nginx:1.27-alpine', hint: 'Pin a tag, not latest' },
    { id: 'ports', label: 'Published ports', control: 'textarea', default: '8080:80', hint: 'One per line, host:container (or ip:host:container)' },
    { id: 'env', label: 'Environment', control: 'textarea', default: 'TZ=UTC', hint: 'One KEY=value per line' },
    { id: 'network_name', label: 'Network', control: 'text', default: 'app_net', hint: 'User-defined bridge network' },
    { id: 'volume_name', label: 'Named volume', control: 'text', default: 'web_data', hint: 'Leave empty for none' },
    { id: 'volume_mount', label: 'Mounted at', control: 'text', default: '/usr/share/nginx/html', showWhen: { input: 'volume_name', notEquals: [''] } },
    {
      id: 'restart_policy',
      label: 'Restart policy',
      control: 'select',
      default: 'unless-stopped',
      options: [
        { value: 'unless-stopped', label: 'unless-stopped' },
        { value: 'always', label: 'always' },
        { value: 'on-failure', label: 'on-failure' },
        { value: 'no', label: 'no' },
      ],
    },
  ],
  plays: (v) => {
    const rhel = v.distro === 'rhel';
    const volume = String(v.volume_name ?? '').trim();
    const users = items(v.docker_users);
    return [
      {
        name: 'Install and configure Docker Engine',
        hosts: v.hosts,
        become: true,
        tasks: [
          ...(rhel
            ? [
                {
                  name: 'Add the Docker CE repository',
                  'ansible.builtin.yum_repository': {
                    name: 'docker-ce-stable',
                    description: 'Docker CE Stable - $basearch',
                    baseurl: 'https://download.docker.com/linux/rhel/$releasever/$basearch/stable',
                    gpgcheck: true,
                    gpgkey: 'https://download.docker.com/linux/rhel/gpg',
                  },
                },
              ]
            : []),
          {
            name: 'Install Docker packages',
            'ansible.builtin.package': {
              name: rhel
                ? ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-compose-plugin', 'python3-requests']
                : ['docker.io', 'python3-requests'],
              state: 'present',
            },
          },
          {
            name: 'Write /etc/docker/daemon.json',
            'ansible.builtin.copy': {
              dest: '/etc/docker/daemon.json',
              content: '{{ docker_daemon_config | to_nice_json }}\n',
              owner: 'root',
              group: 'root',
              mode: '0644',
            },
            notify: 'Restart docker',
          },
          {
            name: 'Start and enable Docker',
            'ansible.builtin.service': { name: 'docker', state: 'started', enabled: true },
          },
          ...(users.length > 0
            ? [
                {
                  name: 'Add users to the docker group',
                  'ansible.builtin.user': { name: '{{ item }}', groups: 'docker', append: true },
                  loop: users,
                },
              ]
            : []),
        ],
        handlers: [{ name: 'Restart docker', 'ansible.builtin.service': { name: 'docker', state: 'restarted' } }],
        vars: {
          docker_daemon_config: {
            'log-driver': 'json-file',
            'log-opts': { 'max-size': String(v.log_max_size), 'max-file': String(v.log_max_file) },
            'live-restore': true,
          },
        },
      },
      {
        name: `Run the ${v.container_name} container`,
        hosts: v.hosts,
        become: true,
        tasks: [
          {
            name: 'Create the application network',
            'community.docker.docker_network': { name: v.network_name, driver: 'bridge', state: 'present' },
          },
          ...(volume
            ? [{ name: 'Create the data volume', 'community.docker.docker_volume': { volume_name: volume, state: 'present' } }]
            : []),
          {
            name: `Run ${v.container_name}`,
            'community.docker.docker_container': {
              name: v.container_name,
              image: v.image,
              state: 'started',
              pull: 'missing',
              restart_policy: v.restart_policy,
              published_ports: items(v.ports),
              env: envMap(v.env),
              volumes: volume ? [`${volume}:${v.volume_mount}`] : undefined,
              networks: [{ name: v.network_name }],
              networks_cli_compatible: true,
            },
          },
        ],
      },
    ];
  },
});

const DEFAULT_COMPOSE = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    restart: unless-stopped
    depends_on:
      - cache
  cache:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - cache_data:/data
volumes:
  cache_data: {}
`;

const compose_project = playbookScenario({
  id: 'ctr_compose_project',
  label: 'Docker Compose v2 project',
  group: 'Playbooks · Docker',
  description:
    'Bring up a Compose project with the Compose v2 plugin, either copying the compose file to the host or passing it inline as a definition.',
  inputs: [
    hosts('docker_hosts'),
    { id: 'project_name', label: 'Project name', control: 'text', default: 'webstack' },
    { id: 'project_dir', label: 'Project directory on the host', control: 'text', default: '/opt/compose/webstack' },
    {
      id: 'source',
      label: 'How the compose file reaches the host',
      control: 'select',
      default: 'file',
      options: [
        { value: 'file', label: 'Copy compose.yaml into the project directory' },
        { value: 'inline', label: 'Inline definition (read from files/compose.yaml here)' },
      ],
    },
    { id: 'compose', label: 'compose.yaml', control: 'textarea', default: DEFAULT_COMPOSE, hint: 'Written to files/compose.yaml beside the playbook' },
    {
      id: 'pull',
      label: 'Pull images',
      control: 'select',
      default: 'missing',
      options: [
        { value: 'missing', label: 'When missing' },
        { value: 'always', label: 'Always' },
        { value: 'policy', label: 'Per service pull_policy' },
        { value: 'never', label: 'Never' },
      ],
    },
    { id: 'remove_orphans', label: 'Remove orphan containers', control: 'toggle', default: true },
    { id: 'wait', label: 'Wait for services to be healthy', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const inline = v.source === 'inline';
    return [
      {
        name: `Deploy the ${v.project_name} Compose project`,
        hosts: v.hosts,
        become: true,
        tasks: [
          ...(inline
            ? []
            : [
                {
                  name: 'Create the project directory',
                  'ansible.builtin.file': { path: v.project_dir, state: 'directory', owner: 'root', group: 'root', mode: '0755' },
                },
                {
                  name: 'Copy compose.yaml',
                  'ansible.builtin.copy': { src: 'files/compose.yaml', dest: `${v.project_dir}/compose.yaml`, owner: 'root', group: 'root', mode: '0644' },
                },
              ]),
          {
            name: 'Bring the project up',
            'community.docker.docker_compose_v2': {
              project_src: inline ? undefined : v.project_dir,
              project_name: v.project_name,
              definition: inline ? "{{ lookup('ansible.builtin.file', 'files/compose.yaml') | from_yaml }}" : undefined,
              state: 'present',
              pull: v.pull,
              remove_orphans: on(v.remove_orphans),
              wait: on(v.wait),
              wait_timeout: on(v.wait) ? 300 : undefined,
            },
            register: 'compose_result',
          },
        ],
      },
    ];
  },
  extraFiles: (v) => ({ 'files/compose.yaml': String(v.compose ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n') }),
});

const podman_systemd = playbookScenario({
  id: 'ctr_podman_systemd',
  label: 'Podman container as a systemd service',
  group: 'Playbooks · Podman',
  description:
    'Install Podman and run a container that systemd starts at boot, either as a Quadlet unit or a unit generated with podman generate systemd.',
  inputs: [
    hosts('podman_hosts'),
    { id: 'container_name', label: 'Container name', control: 'text', default: 'web' },
    { id: 'image', label: 'Image', control: 'text', default: 'docker.io/library/nginx:1.27-alpine', hint: 'Fully qualified — Podman has no default registry' },
    { id: 'ports', label: 'Published ports', control: 'textarea', default: '8080:80', hint: 'One per line, host:container' },
    { id: 'env', label: 'Environment', control: 'textarea', default: 'TZ=UTC', hint: 'One KEY=value per line' },
    { id: 'volumes', label: 'Volumes', control: 'textarea', default: 'web_data:/usr/share/nginx/html:Z', hint: 'One per line, source:target[:options]' },
    {
      id: 'unit_mode',
      label: 'systemd unit',
      control: 'select',
      default: 'quadlet',
      options: [
        { value: 'quadlet', label: 'Quadlet (.container file, Podman 4.4+)' },
        { value: 'generate', label: 'podman generate systemd (older hosts)' },
      ],
    },
    { id: 'auto_update', label: 'Allow podman auto-update', control: 'toggle', default: false, hint: 'Adds the io.containers.autoupdate=registry label' },
  ],
  plays: (v) => {
    const quadlet = v.unit_mode !== 'generate';
    const name = String(v.container_name);
    const label = on(v.auto_update) ? { 'io.containers.autoupdate': 'registry' } : undefined;
    const container = {
      name,
      image: v.image,
      publish: items(v.ports),
      env: envMap(v.env),
      volume: items(v.volumes),
      label,
    };
    return [
      {
        name: `Run ${name} under systemd with Podman`,
        hosts: v.hosts,
        become: true,
        tasks: [
          { name: 'Install Podman', 'ansible.builtin.package': { name: 'podman', state: 'present' } },
          ...(quadlet
            ? [
                {
                  name: 'Write the Quadlet unit',
                  'containers.podman.podman_container': {
                    ...container,
                    state: 'quadlet',
                    quadlet_dir: '/etc/containers/systemd',
                    quadlet_options: ['[Service]', 'Restart=always', '[Install]', 'WantedBy=multi-user.target default.target'],
                  },
                },
                {
                  // Quadlet units are generated at daemon-reload and cannot be enabled; [Install] starts them at boot.
                  name: 'Start the generated service',
                  'ansible.builtin.systemd_service': { name: `${name}.service`, state: 'started', daemon_reload: true },
                },
              ]
            : [
                {
                  name: 'Create the container',
                  'containers.podman.podman_container': { ...container, state: 'created' },
                },
                {
                  name: 'Generate the systemd unit',
                  'containers.podman.podman_generate_systemd': {
                    name,
                    dest: '/etc/systemd/system',
                    new: true,
                    no_header: true,
                    restart_policy: 'always',
                  },
                },
                {
                  name: 'Enable and start the service',
                  'ansible.builtin.systemd_service': { name: `container-${name}.service`, state: 'started', enabled: true, daemon_reload: true },
                },
              ]),
          ...(on(v.auto_update)
            ? [{ name: 'Enable the auto-update timer', 'ansible.builtin.systemd_service': { name: 'podman-auto-update.timer', state: 'started', enabled: true } }]
            : []),
        ],
      },
    ];
  },
});

const k8s_app = playbookScenario({
  id: 'ctr_k8s_app',
  label: 'Kubernetes app: namespace, Deployment, Service, Ingress',
  group: 'Playbooks · Kubernetes',
  description:
    'Create a namespace, a Deployment with probes and resources, a Service and optionally an Ingress, then wait for the rollout to become Available.',
  inputs: [
    { id: 'namespace', label: 'Namespace', control: 'text', default: 'web' },
    { id: 'app_name', label: 'App name', control: 'text', default: 'web', hint: 'Deployment, Service and app label' },
    { id: 'image', label: 'Image', control: 'text', default: 'nginx:1.27-alpine' },
    { id: 'replicas', label: 'Replicas', control: 'number', default: 2, min: 0, max: 100 },
    { id: 'container_port', label: 'Container port', control: 'number', default: 80, min: 1, max: 65535 },
    { id: 'env', label: 'Environment', control: 'textarea', default: 'TZ=UTC', hint: 'One KEY=value per line' },
    { id: 'cpu_request', label: 'CPU request', control: 'text', default: '100m' },
    { id: 'memory_limit', label: 'Memory request and limit', control: 'text', default: '256Mi' },
    {
      id: 'service_type',
      label: 'Service type',
      control: 'select',
      default: 'ClusterIP',
      options: [
        { value: 'ClusterIP', label: 'ClusterIP' },
        { value: 'NodePort', label: 'NodePort' },
        { value: 'LoadBalancer', label: 'LoadBalancer' },
      ],
    },
    { id: 'service_port', label: 'Service port', control: 'number', default: 80, min: 1, max: 65535 },
    { id: 'ingress', label: 'Add an Ingress', control: 'toggle', default: true },
    { id: 'ingress_host', label: 'Ingress host', control: 'text', default: 'web.example.com', showWhen: { input: 'ingress', equals: ['true'] } },
    { id: 'ingress_class', label: 'Ingress class', control: 'combo', default: 'nginx', options: [{ value: 'nginx', label: 'nginx' }, { value: 'traefik', label: 'traefik' }, { value: 'alb', label: 'alb' }], showWhen: { input: 'ingress', equals: ['true'] } },
    { id: 'tls_secret', label: 'TLS secret', control: 'text', default: '', hint: 'Existing kubernetes.io/tls secret; empty for plain HTTP', showWhen: { input: 'ingress', equals: ['true'] } },
    { id: 'wait_timeout', label: 'Rollout wait (seconds)', control: 'number', default: 300, min: 30 },
  ],
  plays: (v) => {
    const labels = { 'app.kubernetes.io/name': v.app_name };
    const port = Number(v.container_port);
    const env = pairs(v.env).map(([name, value]) => ({ name, value }));
    const tls = String(v.tls_secret ?? '').trim();
    const deployment = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: v.app_name, namespace: v.namespace, labels },
      spec: {
        replicas: Number(v.replicas),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: v.app_name,
                image: v.image,
                ports: [{ name: 'http', containerPort: port }],
                env: env.length > 0 ? env : undefined,
                resources: {
                  requests: { cpu: v.cpu_request, memory: v.memory_limit },
                  limits: { memory: v.memory_limit },
                },
                readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 10 },
                livenessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 15, periodSeconds: 20 },
              },
            ],
          },
        },
      },
    };
    const service = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: v.app_name, namespace: v.namespace, labels },
      spec: { type: v.service_type, selector: labels, ports: [{ name: 'http', port: Number(v.service_port), targetPort: 'http' }] },
    };
    const ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: v.app_name, namespace: v.namespace, labels },
      spec: {
        ingressClassName: v.ingress_class,
        tls: tls ? [{ hosts: [v.ingress_host], secretName: tls }] : undefined,
        rules: [
          {
            host: v.ingress_host,
            http: {
              paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: v.app_name, port: { name: 'http' } } } }],
            },
          },
        ],
      },
    };
    return [
      {
        name: `Deploy ${v.app_name} to Kubernetes`,
        ...K8S_LOCAL,
        tasks: [
          {
            name: 'Create the namespace',
            'kubernetes.core.k8s': { state: 'present', definition: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: v.namespace } } },
          },
          {
            name: 'Apply the Deployment and wait for the rollout',
            'kubernetes.core.k8s': {
              state: 'present',
              definition: deployment,
              wait: true,
              wait_condition: { type: 'Available', status: 'True' },
              wait_timeout: Number(v.wait_timeout),
            },
          },
          { name: 'Apply the Service', 'kubernetes.core.k8s': { state: 'present', definition: service } },
          ...(on(v.ingress) ? [{ name: 'Apply the Ingress', 'kubernetes.core.k8s': { state: 'present', definition: ingress } }] : []),
        ],
      },
    ];
  },
});

const DEFAULT_VALUES = `controller:
  replicaCount: 2
  service:
    type: LoadBalancer
  metrics:
    enabled: true
`;

const helm_release = playbookScenario({
  id: 'ctr_helm_release',
  label: 'Helm repository and release',
  group: 'Playbooks · Kubernetes',
  description: 'Add a Helm chart repository and install or upgrade a pinned chart release with a values file.',
  inputs: [
    { id: 'repo_name', label: 'Repository name', control: 'text', default: 'ingress-nginx' },
    { id: 'repo_url', label: 'Repository URL', control: 'text', default: 'https://kubernetes.github.io/ingress-nginx' },
    { id: 'chart_ref', label: 'Chart', control: 'text', default: 'ingress-nginx/ingress-nginx', hint: 'repo/chart' },
    { id: 'chart_version', label: 'Chart version', control: 'text', default: '4.11.3', hint: 'Pin it; empty takes the latest' },
    { id: 'release_name', label: 'Release name', control: 'text', default: 'ingress-nginx' },
    { id: 'namespace', label: 'Namespace', control: 'text', default: 'ingress-nginx' },
    { id: 'create_namespace', label: 'Create the namespace', control: 'toggle', default: true },
    { id: 'values', label: 'values.yaml', control: 'textarea', default: DEFAULT_VALUES, hint: 'Written to files/<release>-values.yaml' },
    { id: 'wait', label: 'Wait for resources to be ready', control: 'toggle', default: true },
    { id: 'timeout', label: 'Wait timeout', control: 'text', default: '10m0s', hint: 'Go duration', showWhen: { input: 'wait', equals: ['true'] } },
  ],
  plays: (v) => [
    {
      name: `Install the ${v.release_name} Helm release`,
      ...K8S_LOCAL,
      tasks: [
        {
          name: `Add the ${v.repo_name} chart repository`,
          'kubernetes.core.helm_repository': { repo_name: v.repo_name, repo_url: v.repo_url, repo_state: 'present' },
        },
        {
          name: `Install or upgrade ${v.release_name}`,
          'kubernetes.core.helm': {
            release_name: v.release_name,
            release_namespace: v.namespace,
            create_namespace: on(v.create_namespace),
            chart_ref: v.chart_ref,
            chart_version: String(v.chart_version ?? '').trim() || undefined,
            update_repo_cache: true,
            values_files: [`{{ playbook_dir }}/files/${v.release_name}-values.yaml`],
            wait: on(v.wait),
            timeout: on(v.wait) ? v.timeout : undefined,
            release_state: 'present',
          },
        },
      ],
    },
  ],
  extraFiles: (v) => ({ [`files/${v.release_name}-values.yaml`]: String(v.values ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n') }),
});

const DEFAULT_MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: ghcr.io/example/api:1.4.2
          envFrom:
            - configMapRef:
                name: api-config
            - secretRef:
                name: api-secrets
`;

const k8s_config = playbookScenario({
  id: 'ctr_k8s_config_secret',
  label: 'Kubernetes ConfigMap, Secret and manifest',
  group: 'Playbooks · Kubernetes',
  description:
    'Create a ConfigMap from key/value pairs and a Secret whose values come from ansible-vault, then apply a manifest file that uses them.',
  inputs: [
    { id: 'namespace', label: 'Namespace', control: 'text', default: 'api' },
    { id: 'configmap_name', label: 'ConfigMap name', control: 'text', default: 'api-config' },
    { id: 'config_data', label: 'ConfigMap data', control: 'textarea', default: 'LOG_LEVEL=info\nFEATURE_FLAGS=search,export', hint: 'One KEY=value per line' },
    { id: 'secret_name', label: 'Secret name', control: 'text', default: 'api-secrets' },
    {
      id: 'secret_keys',
      label: 'Secret keys',
      control: 'textarea',
      default: 'DATABASE_PASSWORD\nAPI_TOKEN',
      hint: 'One per line; each value is read from vault_<key> in vault.yml',
    },
    { id: 'apply_manifest', label: 'Apply a manifest file too', control: 'toggle', default: true },
    { id: 'manifest', label: 'Manifest', control: 'textarea', default: DEFAULT_MANIFEST, hint: 'Written to files/manifest.yaml; may hold several documents', showWhen: { input: 'apply_manifest', equals: ['true'] } },
  ],
  plays: (v) => {
    const keys = items(v.secret_keys);
    return [
      {
        name: `Configure ${v.namespace} with a ConfigMap and Secret`,
        ...K8S_LOCAL,
        tasks: [
          {
            name: 'Create the namespace',
            'kubernetes.core.k8s': { state: 'present', definition: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: v.namespace } } },
          },
          {
            name: 'Apply the ConfigMap',
            'kubernetes.core.k8s': {
              state: 'present',
              definition: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: v.configmap_name, namespace: v.namespace }, data: envMap(v.config_data) },
            },
          },
          {
            name: 'Apply the Secret',
            'kubernetes.core.k8s': {
              state: 'present',
              definition: {
                apiVersion: 'v1',
                kind: 'Secret',
                type: 'Opaque',
                metadata: { name: v.secret_name, namespace: v.namespace },
                stringData: Object.fromEntries(keys.map((k) => [k, `{{ vault_${varSafe(k)} }}`])),
              },
            },
            no_log: true,
          },
          ...(on(v.apply_manifest)
            ? [
                {
                  name: 'Apply files/manifest.yaml',
                  'kubernetes.core.k8s': { state: 'present', namespace: v.namespace, src: '{{ playbook_dir }}/files/manifest.yaml' },
                },
              ]
            : []),
        ],
      },
    ];
  },
  needs: (v) => Object.fromEntries(items(v.secret_keys).map((k) => [`vault_${varSafe(k)}`, `Value of ${k} in the ${v.secret_name} Secret`])),
  extraFiles: (v) =>
    on(v.apply_manifest) ? { 'files/manifest.yaml': String(v.manifest ?? '').replace(/\r\n/g, '\n').replace(/\n*$/, '\n') } : {},
});

const REPORT_TEMPLATE = `# Kubernetes report

Generated {{ now(utc=true).strftime('%Y-%m-%d %H:%M UTC') }}

## Nodes

| Node | Ready | Kubelet | OS image |
| --- | --- | --- | --- |
{% for n in cluster_nodes.resources %}
| {{ n.metadata.name }} | {{ (n.status.conditions | selectattr('type', 'equalto', 'Ready') | map(attribute='status') | first) | default('?') }} | {{ n.status.nodeInfo.kubeletVersion }} | {{ n.status.nodeInfo.osImage }} |
{% endfor %}

## Pods{{ ' in ' ~ report_namespace if report_namespace else '' }}

| Namespace | Pod | Phase | Restarts | Node |
| --- | --- | --- | --- | --- |
{% for p in cluster_pods.resources | sort(attribute='metadata.namespace') %}
| {{ p.metadata.namespace }} | {{ p.metadata.name }} | {{ p.status.phase }} | {{ p.status.containerStatuses | default([]) | map(attribute='restartCount') | sum }} | {{ p.spec.nodeName | default('-') }} |
{% endfor %}

{{ cluster_pods.resources | rejectattr('status.phase', 'in', ['Running', 'Succeeded']) | list | length }} pod(s) not Running or Succeeded.
`;

const k8s_report = playbookScenario({
  id: 'ctr_k8s_report',
  label: 'Kubernetes nodes and pods report',
  group: 'Playbooks · Kubernetes',
  description: 'Read nodes and pods with k8s_info and write a Markdown or JSON report on the control node. Changes nothing in the cluster.',
  inputs: [
    { id: 'namespace', label: 'Namespace', control: 'text', default: '', hint: 'Empty for every namespace' },
    { id: 'label_selector', label: 'Pod label selector', control: 'text', default: '', placeholder: 'app.kubernetes.io/part-of=shop' },
    {
      id: 'format',
      label: 'Report format',
      control: 'select',
      default: 'markdown',
      options: [
        { value: 'markdown', label: 'Markdown tables' },
        { value: 'json', label: 'JSON' },
      ],
    },
    { id: 'report_dir', label: 'Report directory', control: 'text', default: '{{ playbook_dir }}/reports' },
  ],
  plays: (v) => {
    const ns = String(v.namespace ?? '').trim();
    const selector = String(v.label_selector ?? '').trim();
    const markdown = v.format !== 'json';
    const file = `${v.report_dir}/k8s-report-{{ now(utc=true).strftime('%Y%m%dT%H%M') }}.${markdown ? 'md' : 'json'}`;
    return [
      {
        name: 'Report Kubernetes nodes and pods',
        ...K8S_LOCAL,
        vars: { report_namespace: ns },
        tasks: [
          { name: 'Read nodes', 'kubernetes.core.k8s_info': { kind: 'Node' }, register: 'cluster_nodes' },
          {
            name: 'Read pods',
            'kubernetes.core.k8s_info': { kind: 'Pod', namespace: ns || undefined, label_selectors: selector ? [selector] : undefined },
            register: 'cluster_pods',
          },
          { name: 'Create the report directory', 'ansible.builtin.file': { path: v.report_dir, state: 'directory', mode: '0755' } },
          markdown
            ? { name: 'Write the report', 'ansible.builtin.template': { src: 'templates/k8s-report.md.j2', dest: file, mode: '0644' } }
            : {
                name: 'Write the report',
                'ansible.builtin.copy': {
                  dest: file,
                  mode: '0644',
                  content:
                    "{{ {'nodes': cluster_nodes.resources, 'pods': cluster_pods.resources} | to_nice_json }}\n",
                },
              },
          {
            name: 'Summarise',
            'ansible.builtin.debug': {
              msg: '{{ cluster_nodes.resources | length }} node(s), {{ cluster_pods.resources | length }} pod(s)',
            },
          },
        ],
      },
    ];
  },
  extraFiles: (v) => (v.format !== 'json' ? { 'templates/k8s-report.md.j2': REPORT_TEMPLATE } : {}),
});

const openshift_app = playbookScenario({
  id: 'ctr_openshift_app_route',
  label: 'OpenShift project, app and Route',
  group: 'Playbooks · OpenShift',
  description: 'Create an OpenShift project, deploy an app with its Service, and expose it with a Route.',
  inputs: [
    { id: 'project', label: 'Project', control: 'text', default: 'web' },
    { id: 'app_name', label: 'App name', control: 'text', default: 'web' },
    { id: 'image', label: 'Image', control: 'text', default: 'registry.access.redhat.com/ubi9/nginx-122:latest', hint: 'Must run as an arbitrary UID' },
    { id: 'replicas', label: 'Replicas', control: 'number', default: 2, min: 0, max: 100 },
    { id: 'container_port', label: 'Container port', control: 'number', default: 8080, min: 1, max: 65535 },
    { id: 'hostname', label: 'Route hostname', control: 'text', default: '', hint: 'Empty lets the router generate one' },
    {
      id: 'termination',
      label: 'TLS termination',
      control: 'select',
      default: 'edge',
      options: [
        { value: 'edge', label: 'Edge (router terminates TLS)' },
        { value: 'insecure', label: 'None (plain HTTP)' },
        { value: 'passthrough', label: 'Passthrough (pod terminates TLS)' },
        { value: 'reencrypt', label: 'Re-encrypt' },
      ],
    },
    {
      id: 'insecure_policy',
      label: 'Plain HTTP requests',
      control: 'select',
      default: 'redirect',
      options: [
        { value: 'redirect', label: 'Redirect to HTTPS' },
        { value: 'disallow', label: 'Refuse' },
        { value: 'allow', label: 'Allow' },
      ],
      showWhen: { input: 'termination', equals: ['edge', 'reencrypt'] },
    },
  ],
  plays: (v) => {
    const labels = { app: v.app_name };
    const tlsTerm = v.termination !== 'insecure';
    const hostname = String(v.hostname ?? '').trim();
    return [
      {
        name: `Deploy ${v.app_name} to OpenShift`,
        ...K8S_LOCAL,
        tasks: [
          {
            name: 'Create the project',
            'community.okd.k8s': {
              state: 'present',
              definition: { apiVersion: 'project.openshift.io/v1', kind: 'Project', metadata: { name: v.project } },
            },
          },
          {
            name: 'Apply the Deployment and wait for it',
            'community.okd.k8s': {
              state: 'present',
              wait: true,
              wait_condition: { type: 'Available', status: 'True' },
              definition: {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                metadata: { name: v.app_name, namespace: v.project, labels },
                spec: {
                  replicas: Number(v.replicas),
                  selector: { matchLabels: labels },
                  template: {
                    metadata: { labels },
                    spec: { containers: [{ name: v.app_name, image: v.image, ports: [{ name: 'http', containerPort: Number(v.container_port) }] }] },
                  },
                },
              },
            },
          },
          {
            name: 'Apply the Service',
            'community.okd.k8s': {
              state: 'present',
              definition: {
                apiVersion: 'v1',
                kind: 'Service',
                metadata: { name: v.app_name, namespace: v.project, labels },
                spec: { selector: labels, ports: [{ name: 'http', port: Number(v.container_port), targetPort: 'http' }] },
              },
            },
          },
          {
            name: 'Expose it with a Route',
            'community.okd.openshift_route': {
              service: v.app_name,
              namespace: v.project,
              name: v.app_name,
              hostname: hostname || undefined,
              port: 'http',
              termination: v.termination,
              tls: tlsTerm && v.termination !== 'passthrough' ? { insecure_policy: v.insecure_policy } : undefined,
              state: 'present',
            },
            register: 'route',
          },
          { name: 'Show the Route host', 'ansible.builtin.debug': { msg: '{{ route.result.spec.host }}' } },
        ],
      },
    ];
  },
});

export const CONTAINERS_PLAYBOOKS: readonly Blueprint[] = [
  docker_host_app,
  compose_project,
  podman_systemd,
  k8s_app,
  helm_release,
  k8s_config,
  k8s_report,
  openshift_app,
];

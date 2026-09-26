/**
 * The jobs inventory (addendum A.5.5, Operations): every scheduled job, and
 * what it becomes in the target.
 *
 *   cron            → `ansible.builtin.cron` on the target host;
 *   Task Scheduler  → `community.windows.win_scheduled_task` on the target host
 *                     (community.windows is in the toolkit's module index, so a
 *                     real module is used rather than a PowerShell wrapper);
 *   SQL Agent       → moves with the database: dbatools `Copy-DbaAgentJob` for
 *                     a database on a VM, kept by SQL Managed Instance (which has
 *                     SQL Agent), and flagged for every other managed service;
 *   Control-M       → a runbook to re-point the agent;
 *   other           → a runbook.
 * Cloud-native schedulers are offered per job as the target instead:
 * EventBridge Scheduler (`aws_scheduler_schedule`), Cloud Scheduler
 * (`google_cloud_scheduler_job`) and OCI Resource Scheduler
 * (`oci_resource_scheduler_schedule`, which starts and stops resources rather
 * than running commands).
 *
 * Job facts (InfraItem `category: 'job'`): `scheduler`, `host`, `schedule`
 * (five-field cron, or `@daily` style), `command`, `runsAs`, `app`, and
 * `target` (`same-host`, `eventbridge-scheduler`, `cloud-scheduler`,
 * `oci-resource-scheduler`); `dbTarget` (`vm`, `managed-instance`, `paas`)
 * for SQL Agent jobs.
 */

import { renderYaml, type YamlValue } from '../../../ansible/yaml.ts';
import { info, warning, type Finding } from '../../../core/findings.ts';
import type { InfraItem } from '../types.ts';

export type Scheduler = 'control-m' | 'cron' | 'task-scheduler' | 'sql-agent' | 'other';
export const SCHEDULERS: readonly Scheduler[] = ['control-m', 'cron', 'task-scheduler', 'sql-agent', 'other'];
export type JobTarget = 'same-host' | 'eventbridge-scheduler' | 'cloud-scheduler' | 'oci-resource-scheduler';
export const JOB_TARGETS: readonly JobTarget[] = ['same-host', 'eventbridge-scheduler', 'cloud-scheduler', 'oci-resource-scheduler'];

export type JobMechanism =
  | 'ansible.builtin.cron'
  | 'community.windows.win_scheduled_task'
  | 'dbatools-copy-agent-job'
  | 'managed-instance-agent'
  | 'runbook'
  | 'aws_scheduler_schedule'
  | 'google_cloud_scheduler_job'
  | 'oci_resource_scheduler_schedule';

export interface JobPlan {
  readonly id: string;
  readonly name: string;
  readonly scheduler: Scheduler;
  readonly host: string;
  readonly schedule: string;
  readonly command: string;
  readonly runsAs?: string;
  readonly app?: string;
  readonly mechanism: JobMechanism;
  /** What happens, in a line. */
  readonly how: string;
}

const CLOUD: Readonly<Record<Exclude<JobTarget, 'same-host'>, JobMechanism>> = {
  'eventbridge-scheduler': 'aws_scheduler_schedule',
  'cloud-scheduler': 'google_cloud_scheduler_job',
  'oci-resource-scheduler': 'oci_resource_scheduler_schedule',
};

/** Every job item, with the mechanism that carries it to the target. */
export function planJobs(items: readonly InfraItem[]): { readonly jobs: readonly JobPlan[]; readonly findings: readonly Finding[] } {
  const findings: Finding[] = [];
  const jobs: JobPlan[] = [];
  for (const item of items) {
    if (item.category !== 'job') continue;
    const f = item.facts;
    const scheduler = (SCHEDULERS.find((s) => s === f.scheduler) ?? 'other') as Scheduler;
    const target = (JOB_TARGETS.find((t) => t === f.target) ?? 'same-host') as JobTarget;
    const base = { id: item.id, name: item.name, scheduler, host: f.host ?? '', schedule: f.schedule ?? '', command: f.command ?? '', ...(f.runsAs ? { runsAs: f.runsAs } : {}), ...(f.app ? { app: f.app } : {}) };
    let mechanism: JobMechanism;
    let how: string;
    if (target !== 'same-host') {
      mechanism = CLOUD[target];
      how =
        target === 'oci-resource-scheduler'
          ? 'OCI Resource Scheduler starts and stops resources; it does not run commands, so only a start/stop job fits it.'
          : `The job becomes a ${target === 'eventbridge-scheduler' ? 'EventBridge Scheduler schedule' : 'Cloud Scheduler job'} that invokes the command's new home (a function, a container job or an HTTP endpoint).`;
      findings.push(info('dc.job-cloud', `Job ${item.name}: ${how}`, { path: `infra.${item.id}` }));
    } else if (scheduler === 'cron') {
      mechanism = 'ansible.builtin.cron';
      how = 'An ansible.builtin.cron entry on the target host, with the same schedule and user.';
    } else if (scheduler === 'task-scheduler') {
      mechanism = 'community.windows.win_scheduled_task';
      how = 'A community.windows.win_scheduled_task on the target host, with the same trigger and account.';
    } else if (scheduler === 'sql-agent') {
      const db = f.dbTarget ?? 'vm';
      if (db === 'managed-instance') {
        mechanism = 'managed-instance-agent';
        how = 'SQL Managed Instance keeps SQL Agent: the job moves with the database (Copy-DbaAgentJob to the instance).';
      } else if (db === 'vm') {
        mechanism = 'dbatools-copy-agent-job';
        how = 'dbatools Copy-DbaAgentJob copies the job to the target SQL Server with the database.';
      } else {
        mechanism = 'runbook';
        how = 'The managed database service has no SQL Agent: the job needs a new scheduler (Elastic Jobs, a cloud scheduler, or an app-side schedule).';
        findings.push(warning('dc.job-sql-agent', `Job ${item.name}: SQL Agent does not exist on the target database service; ${how}`, { path: `infra.${item.id}` }));
      }
    } else if (scheduler === 'control-m') {
      mechanism = 'runbook';
      how = 'Re-point the Control-M agent: install it on the target host, move the job definitions, and retire the old agent.';
    } else {
      mechanism = 'runbook';
      how = 'Recreate the job in the target by hand; the scheduler is not one the toolkit knows.';
    }
    if (!base.host && mechanism !== 'aws_scheduler_schedule' && mechanism !== 'google_cloud_scheduler_job') {
      findings.push(warning('dc.job-host', `Job ${item.name} has no host.`, { path: `infra.${item.id}` }));
    }
    jobs.push({ ...base, mechanism, how });
  }
  return { jobs, findings };
}

/* ------------------------------------------------------------------ cron --- */

const SPECIAL = new Set(['reboot', 'yearly', 'annually', 'monthly', 'weekly', 'daily', 'hourly']);

/** Five-field cron (or `@daily`) → `ansible.builtin.cron` options. */
export function cronOptions(schedule: string): Record<string, string> | null {
  const s = schedule.trim();
  if (s.startsWith('@')) return SPECIAL.has(s.slice(1)) ? { special_time: s.slice(1) } : null;
  const f = s.split(/\s+/);
  if (f.length !== 5 || f.some((x) => !/^[\d*/,\-A-Za-z]+$/.test(x))) return null;
  const [minute, hour, day, month, weekday] = f as [string, string, string, string, string];
  return { minute, hour, day, month, weekday };
}

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Five-field cron → a Task Scheduler trigger, for the shapes Task Scheduler
 * has: daily at a time, weekly on days at a time, or monthly on days at a
 * time. Anything else is null (the job is flagged, not guessed).
 */
export function taskTrigger(schedule: string): Record<string, string> | null {
  const c = cronOptions(schedule);
  if (!c) return null;
  if (c.special_time === 'daily') return { type: 'daily', start_boundary: '2000-01-01T00:00:00' };
  if (c.special_time) return null;
  const { minute = '', hour = '', day = '', month = '', weekday = '' } = c;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') return null;
  const at = `2000-01-01T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00`;
  if (day === '*' && weekday === '*') return { type: 'daily', start_boundary: at };
  if (day === '*' && /^[0-7](,[0-7])*$/.test(weekday)) {
    return { type: 'weekly', start_boundary: at, days_of_week: [...new Set(weekday.split(',').map((d) => DOW[Number(d) % 7] as string))].join(',') };
  }
  if (weekday === '*' && /^\d+(,\d+)*$/.test(day)) return { type: 'monthly', start_boundary: at, days_of_month: day };
  return null;
}

const SERVICE_ACCOUNTS = /^(nt authority\\)?(system|local ?service|network ?service)$/i;
const varName = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The playbook that recreates cron and Task Scheduler jobs on their target
 * hosts: one play per host. A Windows job run as a named account takes its
 * password from a vault variable (`vault_job_<id>_password`, `no_log`).
 */
export function jobsPlaybook(jobs: readonly JobPlan[]): { readonly text: string; readonly findings: readonly Finding[]; readonly vaultVars: readonly string[] } {
  const findings: Finding[] = [];
  const vaultVars: string[] = [];
  const byHost = new Map<string, YamlValue[]>();
  for (const j of jobs) {
    if (j.mechanism === 'ansible.builtin.cron') {
      const opts = cronOptions(j.schedule);
      if (!opts) {
        findings.push(warning('dc.job-schedule', `Job ${j.name}: "${j.schedule}" is not a cron schedule; the entry is not generated.`, { path: `infra.${j.id}` }));
        continue;
      }
      const task: YamlValue = {
        name: `Job ${j.name}`,
        'ansible.builtin.cron': { name: j.name, job: j.command, ...opts, ...(j.runsAs ? { user: j.runsAs } : {}), state: 'present' },
      };
      byHost.set(j.host, [...(byHost.get(j.host) ?? []), task]);
    } else if (j.mechanism === 'community.windows.win_scheduled_task') {
      const trigger = taskTrigger(j.schedule);
      if (!trigger) {
        findings.push(warning('dc.job-schedule', `Job ${j.name}: "${j.schedule}" has no Task Scheduler trigger the toolkit writes (daily, weekly or monthly at a time); set the trigger by hand.`, { path: `infra.${j.id}` }));
        continue;
      }
      const [exe = '', ...args] = j.command.match(/"[^"]*"|\S+/g) ?? [];
      const account = j.runsAs ?? 'SYSTEM';
      const service = SERVICE_ACCOUNTS.test(account);
      const secret = `vault_job_${varName(j.id)}_password`;
      if (!service) vaultVars.push(secret);
      const task: YamlValue = {
        name: `Job ${j.name}`,
        'community.windows.win_scheduled_task': {
          name: j.name,
          path: '\\Migrated',
          actions: [{ path: exe.replace(/^"|"$/g, ''), ...(args.length ? { arguments: args.join(' ') } : {}) }],
          triggers: [trigger],
          username: account,
          ...(service ? { logon_type: 'service_account' } : { logon_type: 'password', password: `{{ ${secret} }}` }),
          enabled: true,
          state: 'present',
        },
        ...(service ? {} : { no_log: true }),
      };
      byHost.set(j.host, [...(byHost.get(j.host) ?? []), task]);
    }
  }
  const plays: YamlValue[] = [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, tasks]) => ({ name: `Scheduled jobs on ${host}`, hosts: host, gather_facts: false, tasks }));
  return { text: renderYaml(plays.length ? plays : [], { header: 'Scheduled jobs recreated on their target hosts (data-centre exit, jobs inventory).' }), findings, vaultVars };
}

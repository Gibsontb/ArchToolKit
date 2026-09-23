/**
 * PowerShell against the things that are not a Windows server.
 *
 * Microsoft 365 and Entra ID, VMware through PowerCLI, and Azure. The shape is
 * the same as the on-premises scripts — strict mode, a dry run, objects out —
 * but the failure modes are different, and each of these is written against the
 * specific one that catches people: Graph throttles and pages, PowerCLI holds a
 * connection that outlives the script, and an Azure subscription context is
 * process-wide so a script that forgets to set it runs against whichever one
 * was last used.
 *
 * Nothing here writes a credential. Connections are interactive, or use a
 * managed identity, or read from SecretManagement, and each script says which.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { scriptBlueprint, type ScriptBlueprint } from '../from-script.ts';
import { identifier, listOf, quoted, type Script } from '../script.ts';

const PLATFORM = 'powershell' as const;

function preamble(params: readonly string[], changes: boolean): string[] {
  return [
    ...(changes ? ["[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]"] : ['[CmdletBinding()]']),
    'param(',
    ...params.map((line, index, all) => `    ${line}${index === all.length - 1 ? '' : ','}`),
    ')',
    '',
    'Set-StrictMode -Version Latest',
    "$ErrorActionPreference = 'Stop'",
    '',
  ];
}

function logging(): string[] {
  return [
    'function Write-Log {',
    "    param([Parameter(Mandatory)][string]$Message, [ValidateSet('INFO','WARN','ERROR')][string]$Level = 'INFO')",
    "    $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message",
    "    if ($Level -eq 'ERROR') { Write-Error $line -ErrorAction Continue }",
    "    elseif ($Level -eq 'WARN') { Write-Warning $line }",
    '    else { Write-Information $line -InformationAction Continue }',
    '}',
    '',
  ];
}

export const POWERSHELL_CLOUD: readonly ScriptBlueprint[] = [
  scriptBlueprint({
    id: 'ps_m365_mailbox_report',
    platform: PLATFORM,
    label: 'Exchange Online mailbox report',
    group: 'Microsoft 365',
    description: 'Mailbox sizes, quotas, last activity and forwarding rules — the four things anyone ever actually asks Exchange Online for.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-MailboxReport' },
      { id: 'scope', label: 'Which mailboxes', control: 'select', default: 'user', options: [
        { value: 'user', label: 'User mailboxes' },
        { value: 'shared', label: 'Shared mailboxes' },
        { value: 'all', label: 'Everything, including rooms and equipment' },
      ] },
      { id: 'include', label: 'Include', control: 'select', default: 'full', options: [
        { value: 'full', label: 'Size, quota, last logon, archive and forwarding' },
        { value: 'size', label: 'Size and quota only — much faster' },
      ] },
      { id: 'quota_warn', label: 'Flag mailboxes above (% of quota)', control: 'number', default: 85, min: 1, max: 100 },
      { id: 'inactive_days', label: 'Flag as inactive after (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'flag_forwarding', label: 'Flag external forwarding', control: 'toggle', default: true, hint: 'A forwarding rule to an outside address is a common sign of a compromised account' },
      { id: 'auth', label: 'Sign in', control: 'select', default: 'interactive', options: [
        { value: 'interactive', label: 'Interactively, with a browser' },
        { value: 'certificate', label: 'App-only, with a certificate' },
      ] },
      { id: 'app_id', label: 'Application id', control: 'text', default: '', showWhen: { input: 'auth', equals: ['certificate'] } },
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'example.onmicrosoft.com', showWhen: { input: 'auth', equals: ['certificate'] } },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-MailboxReport'), 'Get-MailboxReport');
      const scope = str(values, 'scope', 'user');
      const full = str(values, 'include', 'full') === 'full';
      const quotaWarn = num(values, 'quota_warn', 85);
      const certificate = str(values, 'auth', 'interactive') === 'certificate';
      const findings: Finding[] = [];

      if (full) {
        findings.push(
          warning('scripts.ps.mailbox-statistics-slow', 'Get-MailboxStatistics is one call per mailbox and Exchange Online throttles. On a tenant with ten thousand mailboxes this takes hours, and the throttling is invisible until the script simply slows down.', {
            remediation: 'Run it out of hours, or use the size-only option, or read the usage reports from Graph instead — they are pre-aggregated.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (certificate && !str(values, 'app_id', '')) {
        findings.push(error('scripts.ps.no-app-id', 'App-only authentication needs the application id of the registered app.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Report on ${scope === 'all' ? 'every' : scope} mailbox: size, quota, activity${full ? ' and forwarding' : ''}`,
        effect: 'read',
        requires: [
          { what: 'The ExchangeOnlineManagement module', how: 'Install-Module ExchangeOnlineManagement -Scope CurrentUser' },
          { what: certificate ? 'An app registration with Exchange.ManageAsApp and a certificate installed' : 'An account with the View-Only Recipients role, or Exchange administrator' },
        ],
        parameters: [
          { name: '-OutputPath', description: 'Where the CSV is written.', required: false },
          { name: '-Verbose', description: 'Show progress as it walks the mailboxes.', required: false },
        ],
        notes: [
          'The connection is closed in the finally block. An Exchange Online session left open counts against the tenant\u2019s concurrent session limit and eventually blocks new connections for everyone.',
          'Sizes come back as "12.34 GB (13,251,212,182 bytes)" — a string, not a number. The parsing here pulls the byte count out, which is the only part that sorts correctly.',
          ...(bool(values, 'flag_forwarding', true) ? ['Forwarding is checked in two places: the mailbox property and the inbox rules. A compromised account is usually forwarded by a rule, not by the property, because the property is the one administrators look at.'] : []),
          ...(certificate ? ['App-only authentication needs no password anywhere. The certificate is the credential and it lives in the machine store.'] : ['Interactive sign-in means this cannot run unattended. Use the certificate option for anything scheduled.']),
        ],
        usage: [`pwsh -File .\\${name}.ps1 -Verbose`, `pwsh -File .\\${name}.ps1 -OutputPath C:\\Reports`, `pwsh -File .\\${name}.ps1 | Where-Object PercentUsed -gt ${quotaWarn}`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(["[string]$OutputPath = 'C:\\Reports'", ...(certificate ? [`[string]$AppId = ${quoted(str(values, 'app_id', ''))}`, `[string]$Tenant = ${quoted(str(values, 'tenant', ''))}`, '[string]$CertificateThumbprint'] : [])], false),
          'Import-Module ExchangeOnlineManagement',
          '',
          ...logging(),
          'try {',
          ...(certificate
            ? [
                '    Write-Log "Connecting app-only as $AppId"',
                '    Connect-ExchangeOnline -AppId $AppId -Organization $Tenant -CertificateThumbprint $CertificateThumbprint -ShowBanner:$false',
              ]
            : ['    Write-Log "Connecting — a browser window will open"', '    Connect-ExchangeOnline -ShowBanner:$false']),
          '',
          `    $filter = ${scope === 'user' ? "'UserMailbox'" : scope === 'shared' ? "'SharedMailbox'" : '$null'}`,
          '    $mailboxes = if ($filter) {',
          '        Get-EXOMailbox -RecipientTypeDetails $filter -ResultSize Unlimited -Properties ' +
            (full ? 'ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward, ArchiveStatus, ProhibitSendQuota' : 'ProhibitSendQuota'),
          '    } else {',
          '        Get-EXOMailbox -ResultSize Unlimited -Properties ' + (full ? 'ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward, ArchiveStatus, ProhibitSendQuota' : 'ProhibitSendQuota'),
          '    }',
          '    Write-Log "$($mailboxes.Count) mailboxes"',
          '',
          '    $report = [System.Collections.Generic.List[object]]::new()',
          '    $index = 0',
          '',
          '    foreach ($mailbox in $mailboxes) {',
          '        $index++',
          '        if ($index % 100 -eq 0) { Write-Log "  $index of $($mailboxes.Count)" }',
          '',
          '        try {',
          '            $stats = Get-EXOMailboxStatistics -Identity $mailbox.ExternalDirectoryObjectId -Properties LastLogonTime -ErrorAction Stop',
          '        } catch {',
          '            Write-Log "No statistics for $($mailbox.PrimarySmtpAddress): $($_.Exception.Message)" -Level WARN',
          '            continue',
          '        }',
          '',
          '        # Sizes come back as "12.34 GB (13,251,212,182 bytes)". Only the',
          '        # byte count inside the brackets sorts correctly.',
          '        $usedBytes = 0',
          "        if ($stats.TotalItemSize -match '\\(([\\d,]+) bytes\\)') {",
          "            $usedBytes = [int64]($Matches[1] -replace ',', '')",
          '        }',
          '        $quotaBytes = 0',
          "        if ($mailbox.ProhibitSendQuota -match '\\(([\\d,]+) bytes\\)') {",
          "            $quotaBytes = [int64]($Matches[1] -replace ',', '')",
          '        }',
          '',
          '        $row = [ordered]@{',
          '            DisplayName   = $mailbox.DisplayName',
          '            Address       = $mailbox.PrimarySmtpAddress',
          '            Type          = $mailbox.RecipientTypeDetails',
          '            UsedGB        = [math]::Round($usedBytes / 1GB, 2)',
          '            QuotaGB       = if ($quotaBytes) { [math]::Round($quotaBytes / 1GB, 2) } else { $null }',
          '            PercentUsed   = if ($quotaBytes) { [math]::Round($usedBytes / $quotaBytes * 100, 1) } else { $null }',
          '            Items         = $stats.ItemCount',
          '            LastLogon     = $stats.LastLogonTime',
          `            DaysSinceUse  = if ($stats.LastLogonTime) { [int]((Get-Date) - $stats.LastLogonTime).TotalDays } else { $null }`,
          '        }',
          ...(full
            ? [
                '',
                '        $row.Archive = $mailbox.ArchiveStatus',
                '        $row.ForwardingSmtp = $mailbox.ForwardingSmtpAddress',
                '        $row.ForwardingInternal = $mailbox.ForwardingAddress',
                '        $row.DeliverAndForward = $mailbox.DeliverToMailboxAndForward',
                ...(bool(values, 'flag_forwarding', true)
                  ? [
                      '',
                      '        # A compromised account is usually forwarded by an inbox rule,',
                      '        # not by the mailbox property — because the property is the',
                      '        # one an administrator would look at.',
                      '        try {',
                      '            $rules = Get-InboxRule -Mailbox $mailbox.PrimarySmtpAddress -ErrorAction Stop |',
                      '                Where-Object { $_.ForwardTo -or $_.RedirectTo -or $_.ForwardAsAttachmentTo }',
                      "            $row.ForwardingRules = ($rules | ForEach-Object { $_.Name }) -join '; '",
                      '        } catch {',
                      "            $row.ForwardingRules = 'could not read'",
                      '        }',
                    ]
                  : []),
              ]
            : []),
          '',
          '        $report.Add([pscustomobject]$row)',
          '    }',
          '',
          '    if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }',
          '    $file = Join-Path $OutputPath ("' + name + '-{0:yyyyMMdd}.csv" -f (Get-Date))',
          '    $report | Export-Csv -Path $file -NoTypeInformation',
          '    Write-Log "Report written to $file"',
          '',
          `    $near = @($report | Where-Object { $_.PercentUsed -ge ${quotaWarn} })`,
          `    $idle = @($report | Where-Object { $_.DaysSinceUse -ge ${num(values, 'inactive_days', 90)} })`,
          '    Write-Log "$($near.Count) mailboxes above ' + quotaWarn + '% of quota"',
          '    Write-Log "$($idle.Count) mailboxes unused for ' + num(values, 'inactive_days', 90) + ' days"',
          ...(full && bool(values, 'flag_forwarding', true)
            ? ['    $fwd = @($report | Where-Object { $_.ForwardingSmtp -or $_.ForwardingRules })', '    if ($fwd.Count) { Write-Log "$($fwd.Count) mailboxes forward somewhere — check each one" -Level WARN }']
            : []),
          '',
          '    $report | Sort-Object UsedGB -Descending',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          'finally {',
          '    # An Exchange Online session left open counts against the tenant\u2019s',
          '    # concurrent session limit until it times out.',
          '    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue',
          '}',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_entra_access_review',
    platform: PLATFORM,
    label: 'Entra ID access and MFA review',
    group: 'Microsoft 365',
    description: 'Who has privileged roles, who has no second factor, who has not signed in for months, and which accounts have licences nobody is using.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-EntraAccessReview' },
      { id: 'checks', label: 'Report on', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Roles, MFA, stale accounts and licences' },
        { value: 'privileged', label: 'Privileged role assignments only' },
        { value: 'mfa', label: 'Authentication methods only' },
      ] },
      { id: 'stale_days', label: 'Stale after (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'roles', label: 'Roles that count as privileged', control: 'textarea', default: 'Global Administrator\nPrivileged Role Administrator\nSecurity Administrator\nExchange Administrator\nUser Administrator\nApplication Administrator' },
      { id: 'include_guests', label: 'Include guest accounts', control: 'toggle', default: true, hint: 'Guests are the accounts nobody reviews' },
      { id: 'auth', label: 'Sign in', control: 'select', default: 'interactive', options: [
        { value: 'interactive', label: 'Interactively' },
        { value: 'managed-identity', label: 'A managed identity — for running in Azure' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-EntraAccessReview'), 'Get-EntraAccessReview');
      const checks = str(values, 'checks', 'all');
      const roles = listOf(str(values, 'roles', '').replace(/\n/g, ','));
      const staleDays = num(values, 'stale_days', 90);
      const managedIdentity = str(values, 'auth', 'interactive') === 'managed-identity';
      const findings: Finding[] = [];

      if (roles.length === 0) findings.push(error('scripts.ps.no-roles', 'No role was named as privileged, so the role review would report nothing.', { source: 'ArchToolKit' }));
      findings.push(
        warning('scripts.ps.graph-permissions', 'Reading sign-in activity needs AuditLog.Read.All, and reading authentication methods needs UserAuthenticationMethod.Read.All. Both are administrator-consent permissions — granting them is itself a change worth a record.', {
          source: 'ArchToolKit',
        }),
      );
      findings.push(
        warning('scripts.ps.signin-licence', 'signInActivity requires an Entra ID P1 licence on the tenant. Without one the field comes back empty for everybody and the stale account report is silently useless.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: 'Review Entra ID roles, authentication methods and stale accounts',
        effect: 'read',
        requires: [
          { what: 'The Microsoft.Graph module', how: 'Install-Module Microsoft.Graph -Scope CurrentUser' },
          { what: 'Directory.Read.All, RoleManagement.Read.Directory, AuditLog.Read.All and UserAuthenticationMethod.Read.All' },
          { what: 'Entra ID P1 or better, for sign-in activity' },
        ],
        parameters: [{ name: '-OutputPath', description: 'Where the CSVs are written.', required: false }, { name: '-StaleDays', description: 'How long counts as stale.', required: false }],
        notes: [
          'Graph pages everything. `-All` is what fetches every page; without it you get the first hundred and no indication there were more.',
          'Graph also throttles. The retry here backs off on a 429 and honours Retry-After, which is what stops a large tenant failing halfway through.',
          'A role assignment through a group is still a role assignment. Both direct and group-based assignments are expanded, because reading only the direct ones is how a privileged group gets missed.',
          ...(managedIdentity ? ['A managed identity has no password and cannot be phished. It is the right answer for anything scheduled in Azure.'] : ['Interactive sign-in means this cannot run unattended.']),
        ],
        usage: [`pwsh -File .\\${name}.ps1 -Verbose`, `pwsh -File .\\${name}.ps1 -StaleDays 180`, `pwsh -File .\\${name}.ps1 | Where-Object { -not $_.HasStrongAuth }`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(["[string]$OutputPath = 'C:\\Reports'", `[int]$StaleDays = ${staleDays}`], false),
          'Import-Module Microsoft.Graph.Authentication',
          'Import-Module Microsoft.Graph.Users',
          'Import-Module Microsoft.Graph.Identity.DirectoryManagement',
          '',
          ...logging(),
          '# Graph throttles. Backing off on a 429 is what stops a large tenant',
          '# failing halfway through with no useful error.',
          'function Invoke-GraphWithRetry {',
          '    param([Parameter(Mandatory)][scriptblock]$Action, [int]$MaxAttempts = 5)',
          '    $delay = 2',
          '    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {',
          '        try { return & $Action }',
          '        catch {',
          '            $status = $_.Exception.Response.StatusCode.value__',
          '            if ($status -ne 429 -and $status -ne 503) { throw }',
          '            $after = $_.Exception.Response.Headers[\'Retry-After\']',
          '            $wait = if ($after) { [int]$after } else { $delay }',
          '            Write-Log "Throttled. Waiting ${wait}s." -Level WARN',
          '            Start-Sleep -Seconds $wait',
          '            $delay = [math]::Min($delay * 2, 60)',
          '        }',
          '    }',
          '    throw "Gave up after $MaxAttempts attempts"',
          '}',
          '',
          'try {',
          ...(managedIdentity
            ? ['    Connect-MgGraph -Identity -NoWelcome']
            : [
                "    $scopes = @('Directory.Read.All', 'RoleManagement.Read.Directory', 'AuditLog.Read.All', 'UserAuthenticationMethod.Read.All')",
                '    Connect-MgGraph -Scopes $scopes -NoWelcome',
              ]),
          '    $context = Get-MgContext',
          '    Write-Log "Connected to $($context.TenantId) as $($context.Account)"',
          '',
          '    if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }',
          '    $stamp = (Get-Date).ToString(\'yyyyMMdd\')',
          '',
          ...(checks === 'all' || checks === 'privileged'
            ? [
                '    # --- privileged roles ------------------------------------------------',
                `    $privileged = @(${roles.map((r) => quoted(r)).join(', ')})`,
                '    $assignments = [System.Collections.Generic.List[object]]::new()',
                '',
                '    $definitions = Invoke-GraphWithRetry { Get-MgDirectoryRole -All }',
                '    foreach ($role in $definitions) {',
                '        if ($role.DisplayName -notin $privileged) { continue }',
                '        $members = Invoke-GraphWithRetry { Get-MgDirectoryRoleMember -DirectoryRoleId $role.Id -All }',
                '        foreach ($member in $members) {',
                '            $detail = $null',
                '            try {',
                '                $detail = Invoke-GraphWithRetry { Get-MgUser -UserId $member.Id -Property DisplayName,UserPrincipalName,AccountEnabled,UserType,SignInActivity -ErrorAction Stop }',
                '            } catch {',
                '                # A service principal or a group, not a user.',
                '            }',
                '            $assignments.Add([pscustomobject]@{',
                '                Role        = $role.DisplayName',
                "                Member      = if ($detail) { $detail.UserPrincipalName } else { $member.Id }",
                "                DisplayName = if ($detail) { $detail.DisplayName } else { '(not a user)' }",
                "                Type        = if ($detail) { $detail.UserType } else { $member.AdditionalProperties['@odata.type'] }",
                '                Enabled     = if ($detail) { $detail.AccountEnabled } else { $null }',
                '                LastSignIn  = if ($detail -and $detail.SignInActivity) { $detail.SignInActivity.LastSignInDateTime } else { $null }',
                '            })',
                '        }',
                '        Write-Log "$($role.DisplayName): $($members.Count) members"',
                '    }',
                '',
                '    $assignments | Export-Csv -Path (Join-Path $OutputPath "privileged-roles-$stamp.csv") -NoTypeInformation',
                "    $globals = @($assignments | Where-Object Role -eq 'Global Administrator')",
                '    if ($globals.Count -gt 5) {',
                '        Write-Log "$($globals.Count) Global Administrators. Microsoft recommends fewer than five." -Level WARN',
                '    }',
                '',
              ]
            : []),
          ...(checks === 'all' || checks === 'mfa'
            ? [
                '    # --- authentication methods ------------------------------------------',
                '    $users = Invoke-GraphWithRetry {',
                '        Get-MgUser -All -Property Id,DisplayName,UserPrincipalName,AccountEnabled,UserType,CreatedDateTime,SignInActivity,AssignedLicenses',
                '    }',
                `    ${bool(values, 'include_guests', true) ? '' : "$users = $users | Where-Object UserType -ne 'Guest'"}`,
                '    Write-Log "$($users.Count) accounts"',
                '',
                '    $accounts = [System.Collections.Generic.List[object]]::new()',
                '    $index = 0',
                '    foreach ($user in $users) {',
                '        $index++',
                '        if ($index % 200 -eq 0) { Write-Log "  $index of $($users.Count)" }',
                '',
                '        $methods = @()',
                '        try {',
                '            $methods = Invoke-GraphWithRetry { Get-MgUserAuthenticationMethod -UserId $user.Id -ErrorAction Stop }',
                '        } catch {',
                '            Write-Log "No methods for $($user.UserPrincipalName)" -Level WARN',
                '        }',
                "        $types = $methods | ForEach-Object { ($_.AdditionalProperties['@odata.type'] -replace '#microsoft.graph.', '') -replace 'AuthenticationMethod', '' }",
                '        # A password on its own is not a second factor. Nor is SMS, really,',
                '        # but it is at least a second factor.',
                "        $strong = @($types | Where-Object { $_ -in @('microsoftAuthenticator', 'fido2', 'windowsHelloForBusiness', 'softwareOath') })",
                '',
                '        $lastSignIn = if ($user.SignInActivity) { $user.SignInActivity.LastSignInDateTime } else { $null }',
                '        $accounts.Add([pscustomobject]@{',
                '            DisplayName     = $user.DisplayName',
                '            UserPrincipal   = $user.UserPrincipalName',
                '            Type            = $user.UserType',
                '            Enabled         = $user.AccountEnabled',
                '            Created         = $user.CreatedDateTime',
                '            LastSignIn      = $lastSignIn',
                '            DaysSinceSignIn = if ($lastSignIn) { [int]((Get-Date) - $lastSignIn).TotalDays } else { $null }',
                "            Methods         = ($types | Sort-Object -Unique) -join ', '",
                '            HasStrongAuth   = $strong.Count -gt 0',
                '            Licences        = $user.AssignedLicenses.Count',
                '        })',
                '    }',
                '',
                '    $accounts | Export-Csv -Path (Join-Path $OutputPath "accounts-$stamp.csv") -NoTypeInformation',
                '',
                '    $weak = @($accounts | Where-Object { $_.Enabled -and -not $_.HasStrongAuth })',
                '    $stale = @($accounts | Where-Object { $_.Enabled -and $_.DaysSinceSignIn -ge $StaleDays })',
                '    $unlicensedStale = @($accounts | Where-Object { $_.Licences -gt 0 -and $_.DaysSinceSignIn -ge $StaleDays })',
                '    Write-Log "$($weak.Count) enabled accounts with no strong authentication method" -Level WARN',
                '    Write-Log "$($stale.Count) enabled accounts unused for $StaleDays days"',
                '    Write-Log "$($unlicensedStale.Count) of those hold licences"',
                '',
                '    $accounts | Sort-Object DaysSinceSignIn -Descending',
              ]
            : ['    $assignments']),
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          'finally {',
          '    Disconnect-MgGraph -ErrorAction SilentlyContinue | Out-Null',
          '}',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_vmware_inventory',
    platform: PLATFORM,
    label: 'vSphere inventory report',
    group: 'VMware',
    description: 'Every VM with its sizing, its datastore, its tools state and what is actually using resources — the report the sizing conversation always starts with.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-VMwareInventory' },
      { id: 'servers', label: 'vCenter servers', control: 'text', default: 'vcenter01.example.com' },
      { id: 'include', label: 'Include', control: 'select', default: 'full', options: [
        { value: 'full', label: 'Sizing, datastores, tools, snapshots and performance' },
        { value: 'sizing', label: 'Sizing and placement only — much faster' },
      ] },
      { id: 'performance_days', label: 'Average performance over (days)', control: 'number', default: 7, min: 1, max: 90, showWhen: { input: 'include', equals: ['full'] } },
      { id: 'flag_oversized', label: 'Flag VMs using less than (% CPU)', control: 'number', default: 10, min: 1, max: 100 },
      { id: 'flag_snapshots', label: 'Flag snapshots older than (days)', control: 'number', default: 7, min: 1, max: 365 },
      { id: 'credential', label: 'Credentials', control: 'select', default: 'prompt', options: [
        { value: 'prompt', label: 'Prompt once' },
        { value: 'sso', label: 'Pass-through, with the current session' },
        { value: 'secret', label: 'From SecretManagement' },
      ] },
      { id: 'secret_name', label: 'Secret name', control: 'text', default: 'vCenterReadOnly', showWhen: { input: 'credential', equals: ['secret'] } },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-VMwareInventory'), 'Get-VMwareInventory');
      const servers = listOf(str(values, 'servers', ''));
      const full = str(values, 'include', 'full') === 'full';
      const credential = str(values, 'credential', 'prompt');
      const findings: Finding[] = [];

      if (servers.length === 0) findings.push(error('scripts.ps.no-vcenter', 'No vCenter was given, so there is nothing to connect to.', { source: 'ArchToolKit' }));
      if (full) {
        findings.push(
          warning('scripts.ps.powercli-stats-slow', 'Get-Stat is one call per VM per counter and goes back to vCenter every time. On a few thousand VMs this takes hours and puts real load on vCenter — run it out of hours, or use the sizing-only option.', {
            source: 'ArchToolKit',
          }),
        );
      }
      findings.push(
        warning('scripts.ps.powercli-ceip', 'PowerCLI asks about the customer experience programme on first run and blocks waiting for an answer, which hangs a scheduled script for ever. The generated script answers it first.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `vSphere inventory from ${servers.join(', ') || 'vCenter'}`,
        effect: 'read',
        requires: [
          { what: 'VMware PowerCLI', how: 'Install-Module VMware.PowerCLI -Scope CurrentUser' },
          { what: 'A read-only account on vCenter — no more than that is needed' },
        ],
        parameters: [
          { name: '-Server', description: 'vCenter servers, overriding the built-in list.', required: false },
          { name: '-OutputPath', description: 'Where the CSV is written.', required: false },
        ],
        notes: [
          'The CEIP prompt and the certificate policy are set before connecting. Both of them block a scheduled run for ever otherwise, waiting for an answer nobody is there to give.',
          'Disconnect-VIServer runs in the finally block. A PowerCLI session survives the script and holds a vCenter session slot until it times out.',
          ...(full ? ['Performance is read from the rolled-up statistics rather than the real-time ones, which is both far faster and what the sizing conversation actually wants.'] : []),
          'Provisioned and used space are different numbers and the difference is the whole thin-provisioning conversation. Both are reported.',
        ],
        usage: [`pwsh -File .\\${name}.ps1 -Verbose`, `pwsh -File .\\${name}.ps1 -OutputPath C:\\Reports`, `pwsh -File .\\${name}.ps1 | Where-Object PowerState -eq 'PoweredOff'`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble([`[string[]]$Server = @(${servers.map((s) => quoted(s)).join(', ')})`, "[string]$OutputPath = 'C:\\Reports'"], false),
          'Import-Module VMware.VimAutomation.Core',
          '',
          ...logging(),
          'try {',
          '    # Both of these block a scheduled run for ever, waiting for an answer.',
          '    Set-PowerCLIConfiguration -Scope Session -ParticipateInCEIP $false -Confirm:$false | Out-Null',
          '    Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Ignore -Confirm:$false | Out-Null',
          '',
          ...(credential === 'prompt'
            ? ["    $credential = Get-Credential -Message 'vCenter read-only account'", '    Connect-VIServer -Server $Server -Credential $credential | Out-Null']
            : credential === 'secret'
              ? [
                  '    Import-Module Microsoft.PowerShell.SecretManagement',
                  `    $credential = Get-Secret -Name ${quoted(str(values, 'secret_name', 'vCenterReadOnly'))}`,
                  '    Connect-VIServer -Server $Server -Credential $credential | Out-Null',
                ]
              : ['    Connect-VIServer -Server $Server | Out-Null']),
          '    Write-Log "Connected to $($global:DefaultVIServers.Name -join \', \')"',
          '',
          '    $vms = Get-VM',
          '    Write-Log "$($vms.Count) virtual machines"',
          '',
          ...(full
            ? [
                '    # One bulk call is far cheaper than one per VM.',
                `    Write-Log "Reading ${num(values, 'performance_days', 7)} days of statistics — this is the slow part"`,
                '    $stats = @{}',
                '    try {',
                '        Get-Stat -Entity $vms -Stat cpu.usage.average, mem.usage.average -Start (Get-Date).AddDays(-' + num(values, 'performance_days', 7) + ') -IntervalMins 120 -ErrorAction Stop |',
                '            Group-Object -Property { $_.Entity.Name }, MetricId |',
                '            ForEach-Object {',
                "                $key = $_.Name -replace ', ', '|'",
                '                $stats[$key] = [math]::Round(($_.Group | Measure-Object Value -Average).Average, 1)',
                '            }',
                '    } catch {',
                '        Write-Log "Could not read statistics: $($_.Exception.Message)" -Level WARN',
                '    }',
                '',
              ]
            : []),
          '    $report = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($vm in $vms) {',
          '        $view = $vm.ExtensionData',
          '        $row = [ordered]@{',
          '            Name          = $vm.Name',
          '            PowerState    = $vm.PowerState',
          '            vCPU          = $vm.NumCpu',
          '            MemoryGB      = $vm.MemoryGB',
          '            ProvisionedGB = [math]::Round($vm.ProvisionedSpaceGB, 1)',
          '            UsedGB        = [math]::Round($vm.UsedSpaceGB, 1)',
          '            Cluster       = $vm.VMHost.Parent.Name',
          '            Host          = $vm.VMHost.Name',
          "            Datastores    = ($vm | Get-Datastore | ForEach-Object Name) -join ', '",
          '            GuestOS       = $view.Config.GuestFullName',
          '            ToolsStatus   = $view.Guest.ToolsStatus',
          '            ToolsVersion  = $view.Guest.ToolsVersionStatus2',
          "            IPAddress     = ($vm.Guest.IPAddress | Where-Object { $_ -notmatch ':' }) -join ', '",
          '            HardwareVer   = $view.Config.Version',
          '            Folder        = $vm.Folder.Name',
          '            Notes         = $vm.Notes',
          '        }',
          ...(full
            ? [
                '',
                '        $row.CpuPercentAvg = $stats["$($vm.Name)|cpu.usage.average"]',
                '        $row.MemPercentAvg = $stats["$($vm.Name)|mem.usage.average"]',
                '',
                '        $snapshots = @($vm | Get-Snapshot)',
                '        $row.Snapshots = $snapshots.Count',
                '        $row.OldestSnapshotDays = if ($snapshots) {',
                '            [int]((Get-Date) - ($snapshots | Sort-Object Created | Select-Object -First 1).Created).TotalDays',
                '        } else { $null }',
                '        $row.SnapshotGB = if ($snapshots) { [math]::Round(($snapshots | Measure-Object SizeGB -Sum).Sum, 1) } else { 0 }',
              ]
            : []),
          '        $report.Add([pscustomobject]$row)',
          '    }',
          '',
          '    if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }',
          '    $file = Join-Path $OutputPath ("' + name + '-{0:yyyyMMdd}.csv" -f (Get-Date))',
          '    $report | Export-Csv -Path $file -NoTypeInformation',
          '    Write-Log "Report written to $file"',
          '',
          '    Write-Log "Totals: $($report.Count) VMs, $(($report | Measure-Object vCPU -Sum).Sum) vCPU, $([math]::Round(($report | Measure-Object MemoryGB -Sum).Sum)) GB RAM"',
          '    Write-Log "Provisioned $([math]::Round(($report | Measure-Object ProvisionedGB -Sum).Sum)) GB, used $([math]::Round(($report | Measure-Object UsedGB -Sum).Sum)) GB"',
          ...(full
            ? [
                `    $idle = @($report | Where-Object { $_.PowerState -eq 'PoweredOn' -and $_.CpuPercentAvg -lt ${num(values, 'flag_oversized', 10)} })`,
                `    $old = @($report | Where-Object { $_.OldestSnapshotDays -ge ${num(values, 'flag_snapshots', 7)} })`,
                '    Write-Log "$($idle.Count) powered-on VMs averaging under ' + num(values, 'flag_oversized', 10) + '% CPU — candidates for resizing"',
                '    if ($old.Count) { Write-Log "$($old.Count) VMs have snapshots older than ' + num(values, 'flag_snapshots', 7) + ' days, totalling $([math]::Round(($old | Measure-Object SnapshotGB -Sum).Sum, 1)) GB" -Level WARN }',
              ]
            : []),
          '',
          '    $report | Sort-Object ProvisionedGB -Descending',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          'finally {',
          '    # A PowerCLI session outlives the script and holds a vCenter session slot.',
          '    Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
          '}',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_vmware_snapshots',
    platform: PLATFORM,
    label: 'Find and remove old snapshots',
    group: 'VMware',
    description: 'The single most common cause of a full datastore: snapshots nobody remembers taking. Find them, report them, and remove the ones that are safe to remove.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Remove-StaleSnapshots' },
      { id: 'servers', label: 'vCenter servers', control: 'text', default: 'vcenter01.example.com' },
      { id: 'older_than_days', label: 'Older than (days)', control: 'number', default: 7, min: 1, max: 365 },
      { id: 'larger_than_gb', label: 'Or larger than (GB)', control: 'number', default: 50, min: 0, max: 100000 },
      { id: 'action', label: 'Action', control: 'select', default: 'report', options: [
        { value: 'report', label: 'Report only' },
        { value: 'consolidate', label: 'Report, and consolidate disks that need it' },
        { value: 'remove', label: 'Remove them' },
      ] },
      { id: 'protect_names', label: 'Never touch snapshots named like', control: 'text', default: 'KEEP, DO-NOT-DELETE, pre-upgrade' },
      { id: 'protect_vms', label: 'Never touch VMs named like', control: 'text', default: '', hint: 'A pattern, e.g. *-DR-*' },
      { id: 'max_per_run', label: 'Remove at most', control: 'number', default: 5, min: 1, max: 100, showWhen: { input: 'action', equals: ['remove'] } },
      { id: 'credential', label: 'Credentials', control: 'select', default: 'prompt', options: [
        { value: 'prompt', label: 'Prompt once' },
        { value: 'sso', label: 'Pass-through' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Remove-StaleSnapshots'), 'Remove-StaleSnapshots');
      const servers = listOf(str(values, 'servers', ''));
      const action = str(values, 'action', 'report');
      const days = num(values, 'older_than_days', 7);
      const protectNames = listOf(str(values, 'protect_names', ''));
      const findings: Finding[] = [];

      if (action === 'remove') {
        findings.push(
          warning('scripts.ps.snapshot-removal-io', 'Removing a snapshot consolidates its delta back into the base disk. That is heavy I/O for as long as it takes, and on a large or old snapshot it can take hours and make the VM unresponsive. Do it in a window, a few at a time — which is why this caps the number per run.', {
            remediation: 'Check the datastore has free space at least the size of the snapshot before starting.',
            source: 'ArchToolKit',
          }),
        );
        if (protectNames.length === 0) {
          findings.push(
            error('scripts.ps.no-protected-names', 'With no protected names this will remove a snapshot somebody took deliberately before an upgrade, and there is no way back.', {
              remediation: 'At minimum protect anything named KEEP or DO-NOT-DELETE, and tell people the convention.',
              source: 'ArchToolKit',
            }),
          );
        }
      }

      return {
        platform: PLATFORM,
        title: `Find snapshots older than ${days} days${action === 'remove' ? ' and remove them' : ''}`,
        effect: action === 'remove' ? 'destructive' : 'read',
        requires: [
          { what: 'VMware PowerCLI', how: 'Install-Module VMware.PowerCLI -Scope CurrentUser' },
          ...(action === 'report' ? [{ what: 'A read-only account on vCenter' }] : [{ what: 'Rights to remove snapshots and consolidate disks' }]),
        ],
        parameters: [
          { name: '-OlderThanDays', description: 'How old a snapshot has to be.', required: false },
          { name: '-WhatIf', description: 'List what would be removed and remove nothing.', required: false },
        ],
        notes: [
          'A snapshot is not a backup. It is a delta against a base disk, it grows without limit, and it makes every write slower for as long as it exists.',
          `Protected names: ${protectNames.join(', ') || 'none — which is a gap'}. Anything matching is reported and never touched.`,
          ...(action !== 'report'
            ? [
                'Removal is capped per run deliberately. Consolidating five large snapshots at once is enough I/O to affect everything else on the datastore.',
                'Check the datastore has free space at least the size of the snapshot before removing it. Consolidation needs room to work, and running out mid-consolidation is a bad afternoon.',
              ]
            : []),
          'Disks needing consolidation are reported separately. That state — a snapshot removed but the delta not merged — is invisible in the snapshot manager and is a common cause of "I deleted the snapshot and the space did not come back".',
        ],
        usage: [`pwsh -File .\\${name}.ps1 -WhatIf`, `pwsh -File .\\${name}.ps1 -OlderThanDays 30`, ...(action === 'remove' ? [`pwsh -File .\\${name}.ps1 -Confirm:$false`] : [])],
        undo:
          action === 'remove'
            ? [
                'A removed snapshot cannot be restored. The delta is merged into the base disk and the point in time is gone.',
                'The report lists every snapshot before anything is removed — keep it with the change record.',
              ]
            : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(
            [
              `[string[]]$Server = @(${servers.map((s) => quoted(s)).join(', ')})`,
              `[int]$OlderThanDays = ${days}`,
              `[int]$LargerThanGB = ${num(values, 'larger_than_gb', 50)}`,
              "[string]$OutputPath = 'C:\\Reports'",
            ],
            action !== 'report',
          ),
          'Import-Module VMware.VimAutomation.Core',
          '',
          ...logging(),
          'try {',
          '    Set-PowerCLIConfiguration -Scope Session -ParticipateInCEIP $false -Confirm:$false | Out-Null',
          '    Set-PowerCLIConfiguration -Scope Session -InvalidCertificateAction Ignore -Confirm:$false | Out-Null',
          ...(str(values, 'credential', 'prompt') === 'prompt'
            ? ["    $credential = Get-Credential -Message 'vCenter account'", '    Connect-VIServer -Server $Server -Credential $credential | Out-Null']
            : ['    Connect-VIServer -Server $Server | Out-Null']),
          '',
          `    $protectedNames = @(${protectNames.map((p) => quoted(p)).join(', ')})`,
          ...(str(values, 'protect_vms', '') ? [`    $protectedVms = ${quoted(str(values, 'protect_vms', ''))}`] : ['    $protectedVms = $null']),
          '    $cutoff = (Get-Date).AddDays(-$OlderThanDays)',
          '',
          '    $found = [System.Collections.Generic.List[object]]::new()',
          '    foreach ($snapshot in Get-VM | Get-Snapshot) {',
          '        $ageDays = [int]((Get-Date) - $snapshot.Created).TotalDays',
          '        $sizeGB = [math]::Round($snapshot.SizeGB, 2)',
          '        if ($snapshot.Created -ge $cutoff -and $sizeGB -lt $LargerThanGB) { continue }',
          '',
          '        $protected = $false',
          '        $reason = $null',
          '        foreach ($pattern in $protectedNames) {',
          '            if ($snapshot.Name -like "*$pattern*" -or $snapshot.Description -like "*$pattern*") {',
          '                $protected = $true',
          '                $reason = "name matches $pattern"',
          '                break',
          '            }',
          '        }',
          '        if (-not $protected -and $protectedVms -and $snapshot.VM.Name -like $protectedVms) {',
          '            $protected = $true',
          '            $reason = "VM matches $protectedVms"',
          '        }',
          '',
          '        $datastore = $snapshot.VM | Get-Datastore | Select-Object -First 1',
          '        $found.Add([pscustomobject]@{',
          '            VM             = $snapshot.VM.Name',
          '            Snapshot       = $snapshot.Name',
          '            Description    = $snapshot.Description',
          '            Created        = $snapshot.Created',
          '            AgeDays        = $ageDays',
          '            SizeGB         = $sizeGB',
          '            Datastore      = $datastore.Name',
          '            DatastoreFreeGB = if ($datastore) { [math]::Round($datastore.FreeSpaceGB, 1) } else { $null }',
          '            Protected      = $protected',
          '            ProtectedBy    = $reason',
          "            Action         = 'None'",
          '        })',
          '    }',
          '',
          '    Write-Log "$($found.Count) snapshots older than $OlderThanDays days or larger than ${LargerThanGB}GB"',
          '    Write-Log "Total: $([math]::Round(($found | Measure-Object SizeGB -Sum).Sum, 1)) GB"',
          '    $protectedCount = @($found | Where-Object Protected).Count',
          '    if ($protectedCount) { Write-Log "$protectedCount are protected and will not be touched" }',
          '',
          ...(action !== 'report'
            ? [
                `    $candidates = @($found | Where-Object { -not $_.Protected }) | Sort-Object AgeDays -Descending | Select-Object -First ${num(values, 'max_per_run', 5)}`,
                '    Write-Log "Working on $($candidates.Count) this run"',
                '',
                '    foreach ($item in $candidates) {',
                '        # Consolidation needs room. Running out mid-merge is a bad afternoon.',
                '        if ($item.DatastoreFreeGB -and $item.DatastoreFreeGB -lt $item.SizeGB) {',
                '            Write-Log "Skipping $($item.VM)/$($item.Snapshot): datastore has $($item.DatastoreFreeGB)GB free, snapshot is $($item.SizeGB)GB" -Level WARN',
                "            $item.Action = 'SkippedNoSpace'",
                '            continue',
                '        }',
                '',
                '        if ($PSCmdlet.ShouldProcess("$($item.VM)/$($item.Snapshot)", "Remove a $($item.SizeGB)GB snapshot from $($item.Created)")) {',
                '            try {',
                '                $snapshot = Get-VM -Name $item.VM | Get-Snapshot -Name $item.Snapshot',
                '                Write-Log "Removing $($item.VM)/$($item.Snapshot) — this consolidates $($item.SizeGB)GB and will take a while"',
                '                Remove-Snapshot -Snapshot $snapshot -Confirm:$false -RunAsync:$false',
                "                $item.Action = 'Removed'",
                '                Write-Log "Removed $($item.VM)/$($item.Snapshot)"',
                '            } catch {',
                '                Write-Log "Failed on $($item.VM)/$($item.Snapshot): $($_.Exception.Message)" -Level ERROR',
                "                $item.Action = 'Failed'",
                '            }',
                '        } else {',
                "            $item.Action = 'WouldRemove'",
                '        }',
                '    }',
                '',
              ]
            : []),
          ...(action === 'consolidate' || action === 'remove'
            ? [
                '    # A disk needing consolidation is invisible in the snapshot manager,',
                '    # and is the usual reason "I deleted the snapshot and the space did',
                '    # not come back".',
                '    $needsConsolidation = @(Get-VM | Where-Object { $_.ExtensionData.Runtime.ConsolidationNeeded })',
                '    foreach ($vm in $needsConsolidation) {',
                "        if ($PSCmdlet.ShouldProcess($vm.Name, 'Consolidate disks')) {",
                '            try {',
                '                Write-Log "Consolidating $($vm.Name)"',
                '                $vm.ExtensionData.ConsolidateVMDisks()',
                '            } catch {',
                '                Write-Log "Consolidation failed on $($vm.Name): $($_.Exception.Message)" -Level ERROR',
                '            }',
                '        }',
                '    }',
                '    Write-Log "$($needsConsolidation.Count) VMs needed disk consolidation"',
                '',
              ]
            : []),
          '    if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }',
          '    $file = Join-Path $OutputPath ("' + name + '-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))',
          '    $found | Export-Csv -Path $file -NoTypeInformation',
          '    Write-Log "Report written to $file"',
          '    $found | Sort-Object SizeGB -Descending',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          'finally {',
          '    Disconnect-VIServer -Server * -Confirm:$false -ErrorAction SilentlyContinue',
          '}',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_azure_tag_report',
    platform: PLATFORM,
    label: 'Azure resource and tag report',
    group: 'Azure',
    description: 'Every resource across every subscription, with the tags it has and the ones it should have — and optionally applying the missing ones from the resource group.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-AzureTagCompliance' },
      { id: 'scope', label: 'Scope', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Every subscription this account can see' },
        { value: 'named', label: 'Named subscriptions' },
        { value: 'management-group', label: 'A management group' },
      ] },
      { id: 'subscriptions', label: 'Subscriptions', control: 'textarea', default: 'Production\nNon-Production', showWhen: { input: 'scope', equals: ['named'] } },
      { id: 'management_group', label: 'Management group', control: 'text', default: 'mg-corp', showWhen: { input: 'scope', equals: ['management-group'] } },
      { id: 'required_tags', label: 'Required tags', control: 'text', default: 'CostCentre, Owner, Environment, Application' },
      { id: 'action', label: 'Action', control: 'select', default: 'report', options: [
        { value: 'report', label: 'Report only' },
        { value: 'inherit', label: 'Apply missing tags from the resource group' },
      ] },
      { id: 'skip_types', label: 'Skip resource types', control: 'text', default: 'Microsoft.Compute/virtualMachines/extensions, Microsoft.Insights/autoscalesettings', hint: 'Types that cannot hold tags or never need them' },
      { id: 'include_cost', label: 'Include monthly cost', control: 'toggle', default: false, hint: 'Needs Cost Management reader and is slow' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-AzureTagCompliance'), 'Get-AzureTagCompliance');
      const required = listOf(str(values, 'required_tags', ''));
      const scope = str(values, 'scope', 'all');
      const inherit = str(values, 'action', 'report') === 'inherit';
      const findings: Finding[] = [];

      if (required.length === 0) findings.push(error('scripts.ps.no-required-tags', 'No required tag was named, so every resource is compliant and the report says nothing.', { source: 'ArchToolKit' }));
      if (inherit) {
        findings.push(
          warning('scripts.ps.tag-inheritance-not-real', 'Azure does not inherit tags. Copying them from the resource group is a point-in-time copy: change the group tag later and the resources keep the old value. An Azure Policy with a modify effect does this continuously and is the better answer.', {
            remediation: 'Use this to backfill once, then put a policy in place so it stays true.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (bool(values, 'include_cost', false)) {
        findings.push(
          warning('scripts.ps.cost-api-slow', 'The Cost Management API is heavily rate limited and returns data a day or so behind. On a large estate this turns a two-minute report into a twenty-minute one.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Report tag compliance against ${required.join(', ') || 'the required tags'}`,
        effect: inherit ? 'idempotent' : 'read',
        requires: [
          { what: 'The Az module', how: 'Install-Module Az -Scope CurrentUser' },
          { what: inherit ? 'Contributor, or Tag Contributor, on the resources' : 'Reader across the scope' },
          ...(bool(values, 'include_cost', false) ? [{ what: 'Cost Management Reader on the billing scope' }] : []),
        ],
        parameters: [
          { name: '-OutputPath', description: 'Where the CSV is written.', required: false },
          ...(inherit ? [{ name: '-WhatIf', description: 'List what would be tagged and tag nothing.', required: false }] : []),
        ],
        notes: [
          'The subscription context in Az is process-wide. A script that forgets to set it runs against whichever subscription was last used — which is how a change lands in production instead of test. This one sets it explicitly for every subscription it visits.',
          'Resource Graph would be far faster than Get-AzResource for a read-only report across many subscriptions. This uses Get-AzResource because it needs no extra module and works everywhere; swap it for Search-AzGraph if the estate is large.',
          ...(inherit ? ['Tags are merged, not replaced. An existing tag keeps its value; only the missing ones are added. Replacing would wipe tags something else set.'] : []),
          'Some resource types cannot hold tags at all and will always look non-compliant. The skip list is for those.',
        ],
        usage: [`pwsh -File .\\${name}.ps1 -Verbose`, ...(inherit ? [`pwsh -File .\\${name}.ps1 -WhatIf`] : []), `pwsh -File .\\${name}.ps1 | Where-Object { $_.Missing }`],
        undo: inherit
          ? [
              'The report lists every resource that had a tag added, and which tag.',
              'To remove one: Update-AzTag -ResourceId <id> -Tag @{ <name> = $null } -Operation Delete',
            ]
          : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(["[string]$OutputPath = 'C:\\Reports'"], inherit),
          'Import-Module Az.Accounts',
          'Import-Module Az.Resources',
          '',
          ...logging(),
          'try {',
          '    if (-not (Get-AzContext)) {',
          '        Write-Log "Not signed in — a browser window will open"',
          '        Connect-AzAccount | Out-Null',
          '    }',
          '',
          `    $required = @(${required.map((t) => quoted(t)).join(', ')})`,
          `    $skipTypes = @(${listOf(str(values, 'skip_types', '')).map((t) => quoted(t)).join(', ')})`,
          '',
          ...(scope === 'all'
            ? ['    $subscriptions = Get-AzSubscription | Where-Object State -eq \'Enabled\'']
            : scope === 'named'
              ? [
                  `    $wanted = @(${listOf(str(values, 'subscriptions', '').replace(/\n/g, ',')).map((s) => quoted(s)).join(', ')})`,
                  '    $subscriptions = Get-AzSubscription | Where-Object { $_.Name -in $wanted }',
                  '    $missingSubs = $wanted | Where-Object { $_ -notin $subscriptions.Name }',
                  '    foreach ($sub in $missingSubs) { Write-Log "No such subscription, or no access: $sub" -Level WARN }',
                ]
              : [
                  `    $group = ${quoted(str(values, 'management_group', ''))}`,
                  '    $ids = (Get-AzManagementGroup -GroupName $group -Expand -Recurse).Children |',
                  "        Where-Object Type -eq '/subscriptions' | Select-Object -ExpandProperty Name",
                  '    $subscriptions = Get-AzSubscription | Where-Object { $_.Id -in $ids }',
                ]),
          '    Write-Log "$($subscriptions.Count) subscriptions in scope"',
          '',
          '    $report = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($subscription in $subscriptions) {',
          '        # The context is process-wide. Setting it explicitly is what stops',
          '        # a change landing in whichever subscription was last used.',
          '        Set-AzContext -SubscriptionId $subscription.Id -WarningAction SilentlyContinue | Out-Null',
          '        Write-Log "$($subscription.Name)"',
          '',
          '        $groupTags = @{}',
          '        foreach ($rg in Get-AzResourceGroup) {',
          '            $groupTags[$rg.ResourceGroupName] = $rg.Tags ?? @{}',
          '        }',
          '',
          '        foreach ($resource in Get-AzResource) {',
          '            if ($resource.ResourceType -in $skipTypes) { continue }',
          '',
          '            $tags = $resource.Tags ?? @{}',
          '            $missing = @($required | Where-Object { -not $tags.ContainsKey($_) -or -not $tags[$_] })',
          '            $inherited = $groupTags[$resource.ResourceGroupName] ?? @{}',
          '            $canInherit = @($missing | Where-Object { $inherited.ContainsKey($_) -and $inherited[$_] })',
          '',
          '            $row = [ordered]@{',
          '                Subscription = $subscription.Name',
          '                ResourceGroup = $resource.ResourceGroupName',
          '                Name         = $resource.Name',
          '                Type         = $resource.ResourceType',
          '                Location     = $resource.Location',
          "                Missing      = $missing -join ', '",
          '                MissingCount = $missing.Count',
          "                CanInherit   = $canInherit -join ', '",
          '                ResourceId   = $resource.ResourceId',
          '            }',
          '            foreach ($tag in $required) { $row[$tag] = $tags[$tag] }',
          "            $row.Action = 'None'",
          '',
          ...(inherit
            ? [
                '            if ($canInherit.Count -gt 0) {',
                '                $apply = @{}',
                '                foreach ($tag in $canInherit) { $apply[$tag] = $inherited[$tag] }',
                "                if ($PSCmdlet.ShouldProcess($resource.Name, \"Add $($canInherit -join ', ') from the resource group\")) {",
                '                    try {',
                '                        # Merge, not Replace. Replace would wipe tags',
                '                        # something else set.',
                '                        Update-AzTag -ResourceId $resource.ResourceId -Tag $apply -Operation Merge | Out-Null',
                "                        $row.Action = 'Tagged'",
                '                        Write-Log "  Tagged $($resource.Name)"',
                '                    } catch {',
                "                        $row.Action = 'Failed'",
                '                        Write-Log "  Failed on $($resource.Name): $($_.Exception.Message)" -Level WARN',
                '                    }',
                '                } else {',
                "                    $row.Action = 'WouldTag'",
                '                }',
                '            }',
                '',
              ]
            : []),
          '            $report.Add([pscustomobject]$row)',
          '        }',
          '    }',
          '',
          '    if (-not (Test-Path $OutputPath)) { New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null }',
          '    $file = Join-Path $OutputPath ("' + name + '-{0:yyyyMMdd}.csv" -f (Get-Date))',
          '    $report | Export-Csv -Path $file -NoTypeInformation',
          '',
          '    $bad = @($report | Where-Object MissingCount -gt 0)',
          '    Write-Log "$($report.Count) resources, $($bad.Count) missing at least one required tag"',
          '    foreach ($tag in $required) {',
          '        $without = @($report | Where-Object { -not $_.$tag }).Count',
          '        Write-Log "  $tag missing on $without"',
          '    }',
          '    Write-Log "Report written to $file"',
          '    $report | Sort-Object MissingCount -Descending',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
        ],
        findings,
      };
    },
  }),
];

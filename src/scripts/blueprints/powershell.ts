/**
 * PowerShell: the scripts people actually end up writing.
 *
 * Active Directory, Windows servers, certificates, event logs and running
 * something across a list of machines. Every one of them is generated with the
 * same skeleton — strict mode, stop on error, `-WhatIf` wired through
 * `ShouldProcess`, a transcript, structured objects out rather than
 * `Write-Host` strings — because that skeleton is the difference between a
 * script you can run against two thousand accounts and one you can run once.
 *
 * No credential is ever written in. Where one is needed the script prompts, or
 * reads it from SecretManagement, and says which.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { scriptBlueprint, type ScriptBlueprint } from '../from-script.ts';
import { identifier, listOf, pascal, quoted, type Script } from '../script.ts';

const PLATFORM = 'powershell' as const;

/**
 * The opening every generated script shares.
 *
 * `SupportsShouldProcess` is what gives the script `-WhatIf` and `-Confirm` for
 * free, and it only works if the changing lines are inside `ShouldProcess`.
 * Strict mode turns a typo in a variable name into an error rather than an
 * empty string, which is the single most common way a PowerShell script does
 * something surprising.
 */
function preamble(params: readonly string[], opts: { readonly changes: boolean; readonly confirm?: 'Low' | 'Medium' | 'High' } = { changes: true }): string[] {
  return [
    ...(opts.changes ? [`[CmdletBinding(SupportsShouldProcess, ConfirmImpact = '${opts.confirm ?? 'Medium'}')]`] : ['[CmdletBinding()]']),
    'param(',
    ...params.map((line, index, all) => `    ${line}${index === all.length - 1 ? '' : ','}`),
    ')',
    '',
    'Set-StrictMode -Version Latest',
    "$ErrorActionPreference = 'Stop'",
    '',
  ];
}

/** A log function every script uses, so the output is the same shape each time. */
function logging(): string[] {
  return [
    'function Write-Log {',
    '    [CmdletBinding()]',
    '    param(',
    '        [Parameter(Mandatory)][string]$Message,',
    "        [ValidateSet('INFO', 'WARN', 'ERROR', 'WHATIF')][string]$Level = 'INFO'",
    '    )',
    "    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')",
    '    $line = "$stamp [$Level] $Message"',
    '    switch ($Level) {',
    "        'ERROR' { Write-Error $line -ErrorAction Continue }",
    "        'WARN'  { Write-Warning $line }",
    '        default { Write-Information $line -InformationAction Continue }',
    '    }',
    '}',
    '',
  ];
}

/** Every script writes a transcript, because "what did it do" is asked later. */
function transcript(name: string): string[] {
  return [
    '$script:LogFile = Join-Path -Path $LogPath -ChildPath ("' + name + '-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))',
    'if (-not (Test-Path -Path $LogPath)) { New-Item -Path $LogPath -ItemType Directory -Force | Out-Null }',
    'Start-Transcript -Path $script:LogFile -Append | Out-Null',
    '',
  ];
}

const CLOSE = ['', 'finally {', '    Stop-Transcript | Out-Null', '}'];

export const POWERSHELL_BASE: readonly ScriptBlueprint[] = [
  /* ------------------------------------------------------------ Active Directory */
  scriptBlueprint({
    id: 'ps_ad_bulk_users',
    platform: PLATFORM,
    label: 'Create AD users from a CSV',
    group: 'Active Directory',
    description: 'Read a CSV of people and create their accounts — with the duplicate check, the naming rule and the dry run that a hand-written version of this never has.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'New-StarterAccounts' },
      { id: 'ou', label: 'Target OU', control: 'text', default: 'OU=Starters,OU=Users,DC=example,DC=com' },
      { id: 'upn_suffix', label: 'UPN suffix', control: 'text', default: 'example.com' },
      { id: 'naming', label: 'Account naming', control: 'select', default: 'first.last', options: [
        { value: 'first.last', label: 'first.last' },
        { value: 'flast', label: 'f + lastname' },
        { value: 'firstl', label: 'firstname + l' },
        { value: 'employeeid', label: 'Employee id' },
      ] },
      { id: 'default_groups', label: 'Groups every starter joins', control: 'text', default: 'All Staff, VPN Users' },
      { id: 'password_mode', label: 'Initial password', control: 'select', default: 'random', options: [
        { value: 'random', label: 'Random per user, written to a separate file' },
        { value: 'prompt', label: 'One password, prompted for once' },
      ] },
      { id: 'require_change', label: 'Must change at first logon', control: 'toggle', default: true },
      { id: 'enabled', label: 'Create the accounts enabled', control: 'toggle', default: false, hint: 'Off means the account exists but cannot be used until someone enables it' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'New-StarterAccounts'), 'New-StarterAccounts');
      const ou = str(values, 'ou', '');
      const suffix = str(values, 'upn_suffix', 'example.com');
      const naming = str(values, 'naming', 'first.last');
      const groups = listOf(str(values, 'default_groups', ''));
      const random = str(values, 'password_mode', 'random') === 'random';
      const findings: Finding[] = [];
      if (!ou.toUpperCase().startsWith('OU=')) {
        findings.push(error('scripts.ps.bad-ou', 'The target OU is not a distinguished name, so every account creation will fail on the first line.', { remediation: 'Copy it from Active Directory Users and Computers, or from `Get-ADOrganizationalUnit`.', source: 'ArchToolKit' }));
      }
      if (bool(values, 'enabled', false)) {
        findings.push(
          warning('scripts.ps.enabled-on-create', 'Creating accounts enabled means they are usable from the moment this finishes, including any that were created from a bad row in the CSV. Creating them disabled gives you a checkpoint.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (!random) {
        findings.push(
          warning('scripts.ps.shared-password', 'One password for a batch of starters means every one of them is reachable by anyone who knows it, until each one logs in and changes it. A per-user random password costs nothing extra here.', {
            source: 'ArchToolKit',
          }),
        );
      }

      const samRule =
        naming === 'first.last'
          ? '"{0}.{1}" -f $row.FirstName, $row.LastName'
          : naming === 'flast'
            ? '"{0}{1}" -f $row.FirstName.Substring(0,1), $row.LastName'
            : naming === 'firstl'
              ? '"{0}{1}" -f $row.FirstName, $row.LastName.Substring(0,1)'
              : '$row.EmployeeId';

      return {
        platform: PLATFORM,
        title: `Create Active Directory accounts from a CSV, into ${ou || 'the target OU'}`,
        effect: 'repeat-unsafe',
        requires: [
          { what: 'The ActiveDirectory module', how: 'Install-WindowsFeature RSAT-AD-PowerShell   # or the RSAT optional feature on a workstation' },
          { what: 'Rights to create user objects in the target OU' },
          { what: 'A CSV with the columns: FirstName, LastName, EmployeeId, JobTitle, Department, Manager' },
        ],
        parameters: [
          { name: '-CsvPath', description: 'The CSV of people to create.', required: true, example: '.\\starters-2026-10.csv' },
          { name: '-LogPath', description: 'Where the transcript and the results file are written.', required: false, example: 'C:\\Logs' },
          { name: '-WhatIf', description: 'List what would be created and create nothing.', required: false },
        ],
        notes: [
          'Run it with -WhatIf first and read every line. A CSV with a stray blank row, a trailing space or a duplicate name is the normal case, not the exception.',
          'Accounts that already exist are skipped and reported, not overwritten. That is what makes it safe to re-run after fixing a few rows.',
          ...(random ? ['The per-user passwords are written to a separate file beside the transcript. Treat that file as a credential: hand it over by whatever means your organisation uses for one, then delete it.'] : []),
          'Nothing here sets a manager or a licence. Those are separate steps and belong in separate scripts, so a failure in one does not leave the other half done.',
        ],
        usage: [
          `pwsh -File .\\${name}.ps1 -CsvPath .\\starters.csv -WhatIf`,
          `pwsh -File .\\${name}.ps1 -CsvPath .\\starters.csv`,
          `pwsh -File .\\${name}.ps1 -CsvPath .\\starters.csv -Verbose`,
        ],
        undo: [
          'Every account created is listed in the results CSV beside the transcript.',
          'To remove them: Import-Csv .\\results.csv | Where-Object Status -eq "Created" | ForEach-Object { Remove-ADUser -Identity $_.SamAccountName -WhatIf }',
          'Drop the -WhatIf once the list is the one you expected.',
        ],
        body: [
          ...preamble(
            [
              '[Parameter(Mandatory)][ValidateScript({ Test-Path $_ })][string]$CsvPath',
              "[string]$LogPath = 'C:\\Logs'",
              `[string]$TargetOu = ${quoted(ou)}`,
              `[string]$UpnSuffix = ${quoted(suffix)}`,
            ],
            { changes: true, confirm: 'High' },
          ),
          'Import-Module ActiveDirectory',
          '',
          ...logging(),
          ...transcript(name),
          'try {',
          '    $rows = Import-Csv -Path $CsvPath',
          "    Write-Log \"Read $($rows.Count) rows from $CsvPath\"",
          '',
          '    $required = @(\'FirstName\', \'LastName\', \'EmployeeId\')',
          '    $columns = $rows | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name',
          '    $missing = $required | Where-Object { $_ -notin $columns }',
          '    if ($missing) {',
          '        throw "The CSV is missing these columns: $($missing -join \', \')"',
          '    }',
          '',
          '    if (-not (Get-ADOrganizationalUnit -Identity $TargetOu -ErrorAction SilentlyContinue)) {',
          '        throw "The target OU does not exist: $TargetOu"',
          '    }',
          '',
          '    $results = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($row in $rows) {',
          '        if ([string]::IsNullOrWhiteSpace($row.LastName)) {',
          "            Write-Log \"Skipping a row with no surname\" -Level WARN",
          '            continue',
          '        }',
          '',
          `        $sam = (${samRule}).ToLower() -replace '[^a-z0-9.]', ''`,
          '        if ($sam.Length -gt 20) { $sam = $sam.Substring(0, 20) }',
          '        $upn = "$sam@$UpnSuffix"',
          '        $display = "$($row.FirstName) $($row.LastName)"',
          '',
          '        $existing = Get-ADUser -Filter "SamAccountName -eq \'$sam\'" -ErrorAction SilentlyContinue',
          '        if ($existing) {',
          '            Write-Log "Exists already, skipping: $sam" -Level WARN',
          "            $results.Add([pscustomobject]@{ SamAccountName = $sam; DisplayName = $display; Status = 'Skipped'; Detail = 'Already exists' })",
          '            continue',
          '        }',
          '',
          ...(random
            ? [
                '        $plain = -join ((65..90) + (97..122) + (48..57) + (33, 35, 37, 64) | Get-Random -Count 20 | ForEach-Object { [char]$_ })',
                '        $password = ConvertTo-SecureString -String $plain -AsPlainText -Force',
              ]
            : ['        $password = $script:SharedPassword', "        $plain = '(shared, prompted for at the start)'"]),
          '',
          '        if ($PSCmdlet.ShouldProcess($sam, "Create user in $TargetOu")) {',
          '            try {',
          '                New-ADUser `',
          '                    -Name $display `',
          '                    -SamAccountName $sam `',
          '                    -UserPrincipalName $upn `',
          '                    -GivenName $row.FirstName `',
          '                    -Surname $row.LastName `',
          '                    -DisplayName $display `',
          '                    -Path $TargetOu `',
          '                    -AccountPassword $password `',
          `                    -ChangePasswordAtLogon $${bool(values, 'require_change', true)} `,
          `                    -Enabled $${bool(values, 'enabled', false)} `,
          '                    -EmployeeID $row.EmployeeId `',
          '                    -Title $row.JobTitle `',
          '                    -Department $row.Department',
          '',
          ...(groups.length > 0
            ? [
                `                foreach ($group in @(${groups.map((g) => quoted(g)).join(', ')})) {`,
                '                    try {',
                '                        Add-ADGroupMember -Identity $group -Members $sam',
                '                    } catch {',
                '                        Write-Log "Created $sam but could not add it to ${group}: $($_.Exception.Message)" -Level WARN',
                '                    }',
                '                }',
              ]
            : []),
          '',
          '                Write-Log "Created $sam"',
          "                $results.Add([pscustomobject]@{ SamAccountName = $sam; DisplayName = $display; Status = 'Created'; Detail = $plain })",
          '            } catch {',
          '                Write-Log "Failed to create ${sam}: $($_.Exception.Message)" -Level ERROR',
          "                $results.Add([pscustomobject]@{ SamAccountName = $sam; DisplayName = $display; Status = 'Failed'; Detail = $_.Exception.Message })",
          '            }',
          '        } else {',
          "            $results.Add([pscustomobject]@{ SamAccountName = $sam; DisplayName = $display; Status = 'WouldCreate'; Detail = $upn })",
          '        }',
          '    }',
          '',
          '    $resultsPath = Join-Path $LogPath ("' + name + '-results-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))',
          '    $results | Export-Csv -Path $resultsPath -NoTypeInformation',
          '    Write-Log "Results written to $resultsPath"',
          '    $results | Group-Object Status | ForEach-Object { Write-Log "$($_.Name): $($_.Count)" }',
          '    $results',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_ad_stale_accounts',
    platform: PLATFORM,
    label: 'Find and disable stale AD accounts',
    group: 'Active Directory',
    description: 'Report the user and computer accounts nobody has used for months, and optionally disable and move them — in that order, with a report between the two.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Disable-StaleAccounts' },
      { id: 'target', label: 'Look at', control: 'select', default: 'users', options: [
        { value: 'users', label: 'User accounts' },
        { value: 'computers', label: 'Computer accounts' },
        { value: 'both', label: 'Both' },
      ] },
      { id: 'days', label: 'Days since last logon', control: 'number', default: 90, min: 30, max: 1095 },
      { id: 'search_base', label: 'Search base', control: 'text', default: 'DC=example,DC=com' },
      { id: 'action', label: 'Action', control: 'select', default: 'report', options: [
        { value: 'report', label: 'Report only' },
        { value: 'disable', label: 'Disable and describe' },
        { value: 'disable-move', label: 'Disable, describe and move to a holding OU' },
      ] },
      { id: 'holding_ou', label: 'Holding OU', control: 'text', default: 'OU=Disabled,DC=example,DC=com', showWhen: { input: 'action', equals: ['disable-move'] } },
      { id: 'exclude_groups', label: 'Never touch members of', control: 'text', default: 'Domain Admins, Service Accounts, Break Glass' },
      { id: 'exclude_never_logged', label: 'Skip accounts that have never logged on', control: 'toggle', default: true, hint: 'They are usually new, not stale' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Disable-StaleAccounts'), 'Disable-StaleAccounts');
      const days = num(values, 'days', 90);
      const target = str(values, 'target', 'users');
      const action = str(values, 'action', 'report');
      const excludes = listOf(str(values, 'exclude_groups', ''));
      const findings: Finding[] = [];
      if (days < 60) {
        findings.push(
          warning('scripts.ps.stale-threshold', `${days} days will catch people on parental leave, long sabbaticals and seasonal staff. Ninety days is the usual floor, and even then somebody always comes back.`, {
            source: 'ArchToolKit',
          }),
        );
      }
      if (excludes.length === 0) {
        findings.push(
          error('scripts.ps.no-exclusions', 'With no exclusion list this will disable service accounts and break-glass accounts along with everything else, and those are exactly the ones nobody logs into interactively.', {
            remediation: 'Exclude at least the administrative groups, the service accounts and any break-glass account.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (action !== 'report') {
        findings.push(
          warning('scripts.ps.lastlogon-replication', 'LastLogonDate comes from lastLogonTimestamp, which replicates lazily — it can be up to 14 days behind reality. An account that looks 90 days stale may be 76. Add the replication window to the threshold, or read lastLogon from every domain controller.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Find Active Directory ${target === 'both' ? 'accounts' : target} unused for ${days} days${action === 'report' ? ' and report them' : ' and disable them'}`,
        effect: action === 'report' ? 'read' : 'idempotent',
        requires: [
          { what: 'The ActiveDirectory module', how: 'Install-WindowsFeature RSAT-AD-PowerShell' },
          ...(action === 'report' ? [{ what: 'Read access to the directory' }] : [{ what: 'Rights to disable and modify the accounts in scope' }]),
        ],
        parameters: [
          { name: '-Days', description: 'How long an account must have been unused to count as stale.', required: false, example: String(days) },
          { name: '-ReportPath', description: 'Where the CSV report is written.', required: false },
          { name: '-WhatIf', description: 'List what would be disabled and disable nothing.', required: false },
        ],
        notes: [
          'Run it as a report first, for at least one cycle. Circulate the list to whoever owns the accounts and let them object before anything is disabled.',
          'The description on each disabled account records the date and why, so the next person to find it knows what happened rather than guessing.',
          ...(action === 'disable-move' ? ['Moving an account can break anything that referenced it by distinguished name — some applications and some group policies do. Disabling without moving is the safer first step.'] : []),
          'Disabling is reversible. Deleting is not, and this script never deletes: the account sits disabled until someone decides, deliberately, that it can go.',
        ],
        usage: [
          `pwsh -File .\\${name}.ps1 -Days ${days} -WhatIf`,
          `pwsh -File .\\${name}.ps1 -Days ${days}`,
          `pwsh -File .\\${name}.ps1 -Days 180 -ReportPath C:\\Reports`,
        ],
        undo:
          action === 'report'
            ? ['Nothing to undo — it reads and reports.']
            : [
                'Every account changed is in the CSV report.',
                'To re-enable them: Import-Csv .\\report.csv | Where-Object Action -eq "Disabled" | ForEach-Object { Enable-ADAccount -Identity $_.DistinguishedName -WhatIf }',
                ...(action === 'disable-move' ? ['The report records the original OU, so a move can be reversed with Move-ADObject and that value.'] : []),
              ],
        body: [
          ...preamble(
            [
              `[int]$Days = ${days}`,
              `[string]$SearchBase = ${quoted(str(values, 'search_base', ''))}`,
              "[string]$ReportPath = 'C:\\Reports'",
              "[string]$LogPath = 'C:\\Logs'",
            ],
            { changes: action !== 'report', confirm: 'High' },
          ),
          'Import-Module ActiveDirectory',
          '',
          ...logging(),
          ...transcript(name),
          'try {',
          '    $cutoff = (Get-Date).AddDays(-$Days)',
          '    Write-Log "Anything not used since $($cutoff.ToString(\'yyyy-MM-dd\')) counts as stale"',
          '',
          '    # Work out who is protected first, so a mistake below cannot reach them.',
          '    $protected = [System.Collections.Generic.HashSet[string]]::new()',
          ...(excludes.length > 0
            ? [
                `    foreach ($group in @(${excludes.map((g) => quoted(g)).join(', ')})) {`,
                '        try {',
                '            Get-ADGroupMember -Identity $group -Recursive |',
                '                ForEach-Object { [void]$protected.Add($_.distinguishedName) }',
                '        } catch {',
                '            Write-Log "Could not read the group ${group}: $($_.Exception.Message)" -Level WARN',
                '        }',
                '    }',
                '    Write-Log "$($protected.Count) accounts are protected by the exclusion list"',
                '    if ($protected.Count -eq 0) {',
                "        throw 'The exclusion list resolved to nothing. Refusing to continue, because that is almost certainly a typo in a group name rather than an empty group.'",
                '    }',
              ]
            : []),
          '',
          '    $stale = [System.Collections.Generic.List[object]]::new()',
          '',
          ...(target === 'users' || target === 'both'
            ? [
                '    $users = Get-ADUser -SearchBase $SearchBase -Filter { Enabled -eq $true } -Properties LastLogonDate, whenCreated, Description, DistinguishedName',
                '    foreach ($user in $users) {',
                '        if ($protected.Contains($user.DistinguishedName)) { continue }',
                ...(bool(values, 'exclude_never_logged', true)
                  ? ['        if ($null -eq $user.LastLogonDate) { continue }']
                  : ['        if ($null -eq $user.LastLogonDate -and $user.whenCreated -gt $cutoff) { continue }']),
                '        if ($user.LastLogonDate -and $user.LastLogonDate -ge $cutoff) { continue }',
                "        $stale.Add([pscustomobject]@{ Type = 'User'; Name = $user.SamAccountName; DistinguishedName = $user.DistinguishedName; LastLogon = $user.LastLogonDate; Created = $user.whenCreated; Action = 'None' })",
                '    }',
              ]
            : []),
          ...(target === 'computers' || target === 'both'
            ? [
                '    $computers = Get-ADComputer -SearchBase $SearchBase -Filter { Enabled -eq $true } -Properties LastLogonDate, whenCreated, Description, DistinguishedName, OperatingSystem',
                '    foreach ($computer in $computers) {',
                '        if ($protected.Contains($computer.DistinguishedName)) { continue }',
                '        if ($computer.LastLogonDate -and $computer.LastLogonDate -ge $cutoff) { continue }',
                ...(bool(values, 'exclude_never_logged', true) ? ['        if ($null -eq $computer.LastLogonDate) { continue }'] : []),
                "        $stale.Add([pscustomobject]@{ Type = 'Computer'; Name = $computer.Name; DistinguishedName = $computer.DistinguishedName; LastLogon = $computer.LastLogonDate; Created = $computer.whenCreated; Action = 'None' })",
                '    }',
              ]
            : []),
          '',
          '    Write-Log "$($stale.Count) stale accounts found"',
          '',
          ...(action !== 'report'
            ? [
                '    foreach ($item in $stale) {',
                '        if ($PSCmdlet.ShouldProcess($item.Name, "Disable (last used $($item.LastLogon))")) {',
                '            try {',
                '                Disable-ADAccount -Identity $item.DistinguishedName',
                '                $note = "Disabled by ' + name + ' on $((Get-Date).ToString(\'yyyy-MM-dd\')) — unused since $($item.LastLogon)"',
                '                Set-ADObject -Identity $item.DistinguishedName -Description $note',
                ...(action === 'disable-move'
                  ? [
                      `                Move-ADObject -Identity $item.DistinguishedName -TargetPath ${quoted(str(values, 'holding_ou', ''))}`,
                      "                $item.Action = 'DisabledAndMoved'",
                    ]
                  : ["                $item.Action = 'Disabled'"]),
                '                Write-Log "Disabled $($item.Name)"',
                '            } catch {',
                '                Write-Log "Failed on $($item.Name): $($_.Exception.Message)" -Level ERROR',
                "                $item.Action = 'Failed'",
                '            }',
                '        } else {',
                "            $item.Action = 'WouldDisable'",
                '        }',
                '    }',
              ]
            : []),
          '',
          '    if (-not (Test-Path $ReportPath)) { New-Item -Path $ReportPath -ItemType Directory -Force | Out-Null }',
          '    $reportFile = Join-Path $ReportPath ("' + name + '-{0:yyyyMMdd}.csv" -f (Get-Date))',
          '    $stale | Sort-Object LastLogon | Export-Csv -Path $reportFile -NoTypeInformation',
          '    Write-Log "Report written to $reportFile"',
          '    $stale | Sort-Object LastLogon',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_ad_group_audit',
    platform: PLATFORM,
    label: 'Group membership audit',
    group: 'Active Directory',
    description: 'Expand the groups that actually matter — administrators, anything privileged — through every level of nesting, and show what changed since last time.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-PrivilegedGroupMembership' },
      { id: 'groups', label: 'Groups to audit', control: 'textarea', default: 'Domain Admins\nEnterprise Admins\nSchema Admins\nAdministrators\nAccount Operators\nBackup Operators' },
      { id: 'expand_nested', label: 'Expand nested groups', control: 'toggle', default: true },
      { id: 'include_details', label: 'Include for each member', control: 'select', default: 'full', options: [
        { value: 'full', label: 'Last logon, password age, enabled, and how they got in' },
        { value: 'minimal', label: 'Name and type only' },
      ] },
      { id: 'compare', label: 'Compare against the last run', control: 'toggle', default: true, hint: 'Writes a baseline the first time, differences after that' },
      { id: 'alert_on_change', label: 'Exit non-zero when membership changed', control: 'toggle', default: true, hint: 'So a scheduled task or a pipeline notices' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-PrivilegedGroupMembership'), 'Get-PrivilegedGroupMembership');
      const groups = listOf(str(values, 'groups', '').replace(/\n/g, ','));
      const nested = bool(values, 'expand_nested', true);
      const findings: Finding[] = [];
      if (groups.length === 0) findings.push(error('scripts.ps.no-groups', 'No group was named, so this would audit nothing.', { source: 'ArchToolKit' }));
      if (!nested) {
        findings.push(
          warning('scripts.ps.no-nesting', 'Without expanding nested groups this reports the direct members only. Privileged access is almost always granted through a nested group, so the interesting members are exactly the ones this would miss.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Audit membership of ${groups.length} privileged group${groups.length === 1 ? '' : 's'}`,
        effect: 'read',
        requires: [
          { what: 'The ActiveDirectory module', how: 'Install-WindowsFeature RSAT-AD-PowerShell' },
          { what: 'Read access to the directory — no privileged rights needed' },
        ],
        parameters: [
          { name: '-ReportPath', description: 'Where the report and the baseline are kept.', required: false },
          { name: '-BaselinePath', description: 'The previous run to compare against. Defaults to the newest in ReportPath.', required: false },
        ],
        notes: [
          'This reads only. It is safe to run on a schedule, and it is most useful when it is: the value is in the difference between one week and the next.',
          ...(nested ? ['A member reported through nesting shows the path it came in by, which is the thing that takes twenty minutes to work out by hand.'] : []),
          'An account appearing in a privileged group without a change record is the finding. Everything else is inventory.',
        ],
        usage: [`pwsh -File .\\${name}.ps1`, `pwsh -File .\\${name}.ps1 -ReportPath C:\\Reports\\Privileged`, `pwsh -File .\\${name}.ps1 -Verbose`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble([`[string]$ReportPath = 'C:\\Reports'`, '[string]$BaselinePath', "[string]$LogPath = 'C:\\Logs'"], { changes: false }),
          'Import-Module ActiveDirectory',
          '',
          ...logging(),
          ...transcript(name),
          'try {',
          `    $groups = @(${groups.map((g) => quoted(g)).join(', ')})`,
          '    $members = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($groupName in $groups) {',
          '        try {',
          '            $group = Get-ADGroup -Identity $groupName -Properties Members',
          '        } catch {',
          '            Write-Log "No such group: $groupName" -Level WARN',
          '            continue',
          '        }',
          '',
          `        $found = Get-ADGroupMember -Identity $group${nested ? ' -Recursive' : ''}`,
          '        foreach ($member in $found) {',
          ...(str(values, 'include_details', 'full') === 'full'
            ? [
                "            $detail = $null",
                "            if ($member.objectClass -eq 'user') {",
                '                $detail = Get-ADUser -Identity $member.distinguishedName -Properties LastLogonDate, PasswordLastSet, Enabled, whenCreated',
                '            }',
                '            $members.Add([pscustomobject]@{',
                '                Group           = $groupName',
                '                Member          = $member.SamAccountName',
                '                Name            = $member.name',
                '                Type            = $member.objectClass',
                '                Enabled         = if ($detail) { $detail.Enabled } else { $null }',
                '                LastLogon       = if ($detail) { $detail.LastLogonDate } else { $null }',
                '                PasswordLastSet = if ($detail) { $detail.PasswordLastSet } else { $null }',
                '                Created         = if ($detail) { $detail.whenCreated } else { $null }',
                '                Path            = $member.distinguishedName',
                '            })',
              ]
            : [
                '            $members.Add([pscustomobject]@{ Group = $groupName; Member = $member.SamAccountName; Name = $member.name; Type = $member.objectClass })',
              ]),
          '        }',
          '        Write-Log "${groupName}: $($found.Count) members"',
          '    }',
          '',
          '    if (-not (Test-Path $ReportPath)) { New-Item -Path $ReportPath -ItemType Directory -Force | Out-Null }',
          '    $reportFile = Join-Path $ReportPath ("' + name + '-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))',
          '    $members | Sort-Object Group, Member | Export-Csv -Path $reportFile -NoTypeInformation',
          '    Write-Log "Report written to $reportFile"',
          '',
          ...(bool(values, 'compare', true)
            ? [
                '    if (-not $BaselinePath) {',
                '        $previous = Get-ChildItem -Path $ReportPath -Filter "' + name + '-*.csv" |',
                '            Where-Object FullName -ne $reportFile |',
                '            Sort-Object LastWriteTime -Descending |',
                '            Select-Object -First 1',
                '        if ($previous) { $BaselinePath = $previous.FullName }',
                '    }',
                '',
                '    $changed = $false',
                '    if ($BaselinePath -and (Test-Path $BaselinePath)) {',
                '        $before = Import-Csv -Path $BaselinePath | ForEach-Object { "$($_.Group)\\$($_.Member)" }',
                '        $after = $members | ForEach-Object { "$($_.Group)\\$($_.Member)" }',
                '        $added = $after | Where-Object { $_ -notin $before }',
                '        $removed = $before | Where-Object { $_ -notin $after }',
                '        foreach ($entry in $added) { Write-Log "ADDED: $entry" -Level WARN; $changed = $true }',
                '        foreach ($entry in $removed) { Write-Log "REMOVED: $entry" -Level WARN; $changed = $true }',
                '        if (-not $changed) { Write-Log "No change since $([IO.Path]::GetFileName($BaselinePath))" }',
                '    } else {',
                '        Write-Log "No earlier report to compare against. This run is the baseline."',
                '    }',
                '',
                ...(bool(values, 'alert_on_change', true)
                  ? ['    if ($changed) {', '        $members | Sort-Object Group, Member', '        exit 1', '    }']
                  : []),
              ]
            : []),
          '    $members | Sort-Object Group, Member',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  /* ------------------------------------------------------------------- Windows */
  scriptBlueprint({
    id: 'ps_service_health',
    platform: PLATFORM,
    label: 'Service health check and restart',
    group: 'Windows servers',
    description: 'Check that the services that matter are running across a list of machines, restart the ones that are not, and report what it found — with a limit on how often it will keep doing that.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Test-ServiceHealth' },
      { id: 'services', label: 'Services', control: 'text', default: 'W3SVC, MSSQLSERVER, Spooler' },
      { id: 'computers_from', label: 'Machines come from', control: 'select', default: 'parameter', options: [
        { value: 'parameter', label: 'A parameter or a text file' },
        { value: 'ad', label: 'An Active Directory OU' },
        { value: 'local', label: 'This machine only' },
      ] },
      { id: 'ou', label: 'OU', control: 'text', default: 'OU=Servers,DC=example,DC=com', showWhen: { input: 'computers_from', equals: ['ad'] } },
      { id: 'action', label: 'When a service is stopped', control: 'select', default: 'report', options: [
        { value: 'report', label: 'Report it' },
        { value: 'restart', label: 'Try to start it, then report' },
      ] },
      { id: 'max_restarts', label: 'Give up after this many attempts', control: 'number', default: 2, min: 1, max: 5, showWhen: { input: 'action', equals: ['restart'] } },
      { id: 'parallel', label: 'Machines at a time', control: 'number', default: 10, min: 1, max: 100 },
      { id: 'exit_code', label: 'Exit non-zero if anything is down', control: 'toggle', default: true },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Test-ServiceHealth'), 'Test-ServiceHealth');
      const services = listOf(str(values, 'services', ''));
      const restart = str(values, 'action', 'report') === 'restart';
      const source = str(values, 'computers_from', 'parameter');
      const findings: Finding[] = [];
      if (services.length === 0) findings.push(error('scripts.ps.no-services', 'No service was named, so this checks nothing.', { source: 'ArchToolKit' }));
      if (restart) {
        findings.push(
          warning('scripts.ps.restart-masks-cause', 'Restarting a stopped service hides the reason it stopped. Run it as a report for a week first — a service that this restarts every night is a fault, not a maintenance task.', {
            remediation: 'Keep the report even after enabling restarts, and put anything restarting repeatedly on a list someone reads.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Check ${services.join(', ') || 'services'} across a list of machines`,
        effect: restart ? 'idempotent' : 'read',
        requires: [
          { what: 'PowerShell remoting to the target machines', how: 'Test-WSMan -ComputerName <name>' },
          { what: 'Rights to query, and to start, services on them' },
          ...(source === 'ad' ? [{ what: 'The ActiveDirectory module, to list the machines' }] : []),
        ],
        parameters: [
          { name: '-ComputerName', description: 'One or more machines, or a path to a text file of them.', required: source === 'parameter' },
          { name: '-WhatIf', description: 'Report what would be started and start nothing.', required: false },
        ],
        notes: [
          'Machines that cannot be reached are reported as Unreachable rather than passing silently, which is the failure mode of most scripts like this.',
          'Everything is queried in parallel but the results come back as one ordered table, so the output is the same whatever order they answered in.',
          ...(restart ? [`A service that is already starting is left alone. Only a genuinely stopped service is started, and only ${num(values, 'max_restarts', 2)} times.`] : []),
        ],
        usage: [
          `pwsh -File .\\${name}.ps1 -ComputerName SRV01, SRV02 -WhatIf`,
          `pwsh -File .\\${name}.ps1 -ComputerName (Get-Content .\\servers.txt)`,
          `pwsh -File .\\${name}.ps1 | Where-Object Status -ne 'Running' | Format-Table`,
        ],
        undo: restart
          ? ['Any service this started can be stopped again: Stop-Service -Name <service> -Force', 'The report lists exactly which ones were started, and on which machine.']
          : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(
            [
              ...(source === 'parameter' ? ['[Parameter(Mandatory)][string[]]$ComputerName'] : []),
              ...(source === 'ad' ? [`[string]$SearchBase = ${quoted(str(values, 'ou', ''))}`] : []),
              `[int]$ThrottleLimit = ${num(values, 'parallel', 10)}`,
              "[string]$LogPath = 'C:\\Logs'",
            ],
            { changes: restart },
          ),
          ...logging(),
          ...transcript(name),
          'try {',
          `    $services = @(${services.map((s) => quoted(s)).join(', ')})`,
          ...(source === 'ad'
            ? [
                '    Import-Module ActiveDirectory',
                '    $ComputerName = Get-ADComputer -SearchBase $SearchBase -Filter { Enabled -eq $true } | Select-Object -ExpandProperty Name',
              ]
            : source === 'local'
              ? ['    $ComputerName = @($env:COMPUTERNAME)']
              : [
                  '    # A single argument that is a path means "the machines are in this file".',
                  '    if ($ComputerName.Count -eq 1 -and (Test-Path -Path $ComputerName[0] -PathType Leaf)) {',
                  '        $ComputerName = Get-Content -Path $ComputerName[0] | Where-Object { $_.Trim() }',
                  '    }',
                ]),
          '    Write-Log "Checking $($services.Count) services on $($ComputerName.Count) machines"',
          '',
          '    $results = $ComputerName | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {',
          '        $computer = $_',
          '        $wanted = $using:services',
          '        $out = [System.Collections.Generic.List[object]]::new()',
          '',
          '        if (-not (Test-Connection -ComputerName $computer -Count 1 -Quiet -TimeoutSeconds 2)) {',
          "            $out.Add([pscustomobject]@{ Computer = $computer; Service = '-'; Status = 'Unreachable'; Action = 'None'; Detail = 'No response to ping' })",
          '            return $out',
          '        }',
          '',
          '        foreach ($wantedService in $wanted) {',
          '            try {',
          '                $service = Get-Service -ComputerName $computer -Name $wantedService -ErrorAction Stop',
          "                $out.Add([pscustomobject]@{ Computer = $computer; Service = $wantedService; Status = $service.Status.ToString(); Action = 'None'; Detail = $service.DisplayName })",
          '            } catch {',
          "                $out.Add([pscustomobject]@{ Computer = $computer; Service = $wantedService; Status = 'NotInstalled'; Action = 'None'; Detail = $_.Exception.Message })",
          '            }',
          '        }',
          '        return $out',
          '    }',
          '',
          '    $results = $results | Sort-Object Computer, Service',
          '',
          ...(restart
            ? [
                "    foreach ($result in $results | Where-Object Status -eq 'Stopped') {",
                '        if ($PSCmdlet.ShouldProcess("$($result.Computer)/$($result.Service)", \'Start the service\')) {',
                `            for ($attempt = 1; $attempt -le ${num(values, 'max_restarts', 2)}; $attempt++) {`,
                '                try {',
                '                    Get-Service -ComputerName $result.Computer -Name $result.Service | Start-Service',
                '                    Start-Sleep -Seconds 5',
                '                    $now = Get-Service -ComputerName $result.Computer -Name $result.Service',
                '                    $result.Status = $now.Status.ToString()',
                "                    if ($now.Status -eq 'Running') {",
                '                        $result.Action = "Started (attempt $attempt)"',
                '                        Write-Log "Started $($result.Service) on $($result.Computer)"',
                '                        break',
                '                    }',
                '                } catch {',
                '                    $result.Action = "FailedToStart"',
                '                    $result.Detail = $_.Exception.Message',
                '                    Write-Log "Could not start $($result.Service) on $($result.Computer): $($_.Exception.Message)" -Level ERROR',
                '                }',
                '            }',
                '        } else {',
                "            $result.Action = 'WouldStart'",
                '        }',
                '    }',
              ]
            : []),
          '',
          "    $bad = @($results | Where-Object { $_.Status -notin @('Running', 'WouldStart') })",
          '    Write-Log "$($bad.Count) of $($results.Count) checks are not healthy"',
          '    $results',
          '',
          ...(bool(values, 'exit_code', true) ? ['    if ($bad.Count -gt 0) { exit 1 }'] : []),
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_certificate_expiry',
    platform: PLATFORM,
    label: 'Certificate expiry report',
    group: 'Windows servers',
    description: 'Find the certificates about to expire — in the machine store, bound to a website, or answering on a TLS port — before the outage does it for you.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-ExpiringCertificates' },
      { id: 'sources', label: 'Look at', control: 'select', default: 'store-and-endpoints', options: [
        { value: 'store', label: 'The machine certificate store' },
        { value: 'endpoints', label: 'TLS endpoints over the network' },
        { value: 'store-and-endpoints', label: 'Both' },
      ] },
      { id: 'computers', label: 'Machines', control: 'textarea', default: 'SRV01\nSRV02', showWhen: { input: 'sources', equals: ['store', 'store-and-endpoints'] } },
      { id: 'endpoints', label: 'TLS endpoints', control: 'textarea', default: 'www.example.com:443\napi.example.com:443', showWhen: { input: 'sources', equals: ['endpoints', 'store-and-endpoints'] } },
      { id: 'warn_days', label: 'Warn when this many days remain', control: 'number', default: 45, min: 1, max: 365 },
      { id: 'critical_days', label: 'Critical at', control: 'number', default: 14, min: 1, max: 180 },
      { id: 'ignore_self_signed', label: 'Ignore self-signed certificates', control: 'toggle', default: false, hint: 'They expire too, and they are usually the forgotten ones' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-ExpiringCertificates'), 'Get-ExpiringCertificates');
      const sources = str(values, 'sources', 'store-and-endpoints');
      const computers = listOf(str(values, 'computers', '').replace(/\n/g, ','));
      const endpoints = listOf(str(values, 'endpoints', '').replace(/\n/g, ','));
      const warn = num(values, 'warn_days', 45);
      const critical = num(values, 'critical_days', 14);
      const findings: Finding[] = [];
      if (critical >= warn) {
        findings.push(error('scripts.ps.thresholds-inverted', 'The critical threshold is not below the warning threshold, so every certificate will be reported at the same level.', { source: 'ArchToolKit' }));
      }
      if (warn < 30) {
        findings.push(
          warning('scripts.ps.short-warning', `${warn} days is not long enough to get a certificate issued in most organisations — between the request, the approval and the change window, 45 to 60 days is the realistic floor.`, {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'Report certificates near expiry',
        effect: 'read',
        requires: [
          ...(sources !== 'endpoints' ? [{ what: 'PowerShell remoting to the machines whose store is read' }] : []),
          ...(sources !== 'store' ? [{ what: 'Network access to each TLS endpoint on its port' }] : []),
        ],
        parameters: [
          { name: '-WarnDays', description: 'How many days of remaining life counts as a warning.', required: false, example: String(warn) },
          { name: '-ReportPath', description: 'Where the CSV is written.', required: false },
        ],
        notes: [
          'A certificate in the store is not necessarily in use, and a certificate in use is not necessarily in the store — a load balancer in front holds its own. Checking the endpoint is what tells you what clients actually see.',
          'The endpoint check reads the certificate the server presents without validating the chain, so it reports on an endpoint whose chain is already broken rather than failing on it.',
          'Run it weekly on a schedule. A certificate expiry is only ever a surprise because nobody was looking.',
        ],
        usage: [`pwsh -File .\\${name}.ps1`, `pwsh -File .\\${name}.ps1 -WarnDays 60`, `pwsh -File .\\${name}.ps1 | Where-Object Level -eq 'Critical'`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble([`[int]$WarnDays = ${warn}`, `[int]$CriticalDays = ${critical}`, "[string]$ReportPath = 'C:\\Reports'", "[string]$LogPath = 'C:\\Logs'"], { changes: false }),
          ...logging(),
          ...transcript(name),
          'try {',
          '    $found = [System.Collections.Generic.List[object]]::new()',
          '    $now = Get-Date',
          '',
          ...(sources !== 'endpoints' && computers.length > 0
            ? [
                `    foreach ($computer in @(${computers.map((c) => quoted(c)).join(', ')})) {`,
                '        try {',
                '            $certificates = Invoke-Command -ComputerName $computer -ScriptBlock {',
                "                Get-ChildItem -Path Cert:\\LocalMachine\\My |",
                '                    Select-Object Subject, Issuer, NotAfter, Thumbprint, FriendlyName',
                '            } -ErrorAction Stop',
                '        } catch {',
                '            Write-Log "Could not read the store on ${computer}: $($_.Exception.Message)" -Level WARN',
                "            $found.Add([pscustomobject]@{ Source = 'Store'; Where = $computer; Subject = '-'; Issuer = '-'; NotAfter = $null; DaysLeft = $null; Level = 'Unreachable'; Thumbprint = '-' })",
                '            continue',
                '        }',
                '',
                '        foreach ($certificate in $certificates) {',
                ...(bool(values, 'ignore_self_signed', false) ? ['            if ($certificate.Subject -eq $certificate.Issuer) { continue }'] : []),
                '            $days = [int]($certificate.NotAfter - $now).TotalDays',
                '            if ($days -gt $WarnDays) { continue }',
                '            $found.Add([pscustomobject]@{',
                "                Source     = 'Store'",
                '                Where      = $computer',
                '                Subject    = $certificate.Subject',
                '                Issuer     = $certificate.Issuer',
                '                NotAfter   = $certificate.NotAfter',
                '                DaysLeft   = $days',
                "                Level      = if ($days -lt 0) { 'Expired' } elseif ($days -le $CriticalDays) { 'Critical' } else { 'Warning' }",
                '                Thumbprint = $certificate.Thumbprint',
                '            })',
                '        }',
                '        Write-Log "Read the certificate store on $computer"',
                '    }',
              ]
            : []),
          '',
          ...(sources !== 'store' && endpoints.length > 0
            ? [
                `    foreach ($endpoint in @(${endpoints.map((e) => quoted(e)).join(', ')})) {`,
                "            $parts = $endpoint -split ':'",
                '            $endpointHost = $parts[0]',
                '            $port = if ($parts.Count -gt 1) { [int]$parts[1] } else { 443 }',
                '            $client = $null',
                '            try {',
                '                $client = [System.Net.Sockets.TcpClient]::new()',
                '                $connect = $client.ConnectAsync($endpointHost, $port)',
                '                if (-not $connect.Wait(5000)) { throw "Timed out connecting to ${endpointHost}:$port" }',
                '                # Validate nothing: the point is to read what is presented, even when the chain is broken.',
                '                $stream = [System.Net.Security.SslStream]::new($client.GetStream(), $false, { $true })',
                '                $stream.AuthenticateAsClient($endpointHost)',
                '                $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]$stream.RemoteCertificate',
                '                $days = [int]($certificate.NotAfter - $now).TotalDays',
                '                if ($days -le $WarnDays) {',
                '                    $found.Add([pscustomobject]@{',
                "                        Source     = 'Endpoint'",
                '                        Where      = $endpoint',
                '                        Subject    = $certificate.Subject',
                '                        Issuer     = $certificate.Issuer',
                '                        NotAfter   = $certificate.NotAfter',
                '                        DaysLeft   = $days',
                "                        Level      = if ($days -lt 0) { 'Expired' } elseif ($days -le $CriticalDays) { 'Critical' } else { 'Warning' }",
                '                        Thumbprint = $certificate.Thumbprint',
                '                    })',
                '                }',
                '                Write-Log "$endpoint presents a certificate expiring $($certificate.NotAfter.ToString(\'yyyy-MM-dd\')) ($days days)"',
                '            } catch {',
                '                Write-Log "Could not read ${endpoint}: $($_.Exception.Message)" -Level WARN',
                "                $found.Add([pscustomobject]@{ Source = 'Endpoint'; Where = $endpoint; Subject = '-'; Issuer = '-'; NotAfter = $null; DaysLeft = $null; Level = 'Unreachable'; Thumbprint = '-' })",
                '            } finally {',
                '                if ($client) { $client.Dispose() }',
                '            }',
                '    }',
              ]
            : []),
          '',
          '    if (-not (Test-Path $ReportPath)) { New-Item -Path $ReportPath -ItemType Directory -Force | Out-Null }',
          '    $reportFile = Join-Path $ReportPath ("' + name + '-{0:yyyyMMdd}.csv" -f (Get-Date))',
          '    $found | Sort-Object DaysLeft | Export-Csv -Path $reportFile -NoTypeInformation',
          '    Write-Log "$($found.Count) certificates within $WarnDays days. Report: $reportFile"',
          '    $found | Sort-Object DaysLeft',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_eventlog_report',
    platform: PLATFORM,
    label: 'Event log report',
    group: 'Windows servers',
    description: 'Pull the errors worth looking at from a list of machines, group them so the same message a thousand times is one line, and leave the rest out.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-EventSummary' },
      { id: 'logs', label: 'Logs', control: 'text', default: 'System, Application' },
      { id: 'levels', label: 'Levels', control: 'select', default: 'error-critical', options: [
        { value: 'error-critical', label: 'Error and Critical' },
        { value: 'warning-up', label: 'Warning, Error and Critical' },
        { value: 'critical', label: 'Critical only' },
      ] },
      { id: 'hours', label: 'Look back (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'computers', label: 'Machines', control: 'textarea', default: 'SRV01\nSRV02' },
      { id: 'ignore_ids', label: 'Event ids to ignore', control: 'text', default: '', hint: 'The ones you have already decided are noise' },
      { id: 'group_by', label: 'Group by', control: 'select', default: 'id-source', options: [
        { value: 'id-source', label: 'Event id and source — one line per distinct problem' },
        { value: 'none', label: 'Every event, in time order' },
      ] },
      { id: 'top', label: 'Show the top', control: 'number', default: 25, min: 1, max: 500 },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-EventSummary'), 'Get-EventSummary');
      const logs = listOf(str(values, 'logs', ''));
      const computers = listOf(str(values, 'computers', '').replace(/\n/g, ','));
      const hours = num(values, 'hours', 24);
      const ignore = listOf(str(values, 'ignore_ids', '')).filter((i) => /^\d+$/.test(i));
      const levels = str(values, 'levels', 'error-critical');
      const levelList = levels === 'critical' ? '1' : levels === 'warning-up' ? '1,2,3' : '1,2';
      const findings: Finding[] = [];
      if (logs.length === 0) findings.push(error('scripts.ps.no-logs', 'No log was named, so this reads nothing.', { source: 'ArchToolKit' }));
      if (hours > 168) {
        findings.push(
          warning('scripts.ps.long-window', `Reading ${hours} hours of events from several machines is slow and can be a lot of data. The event log may also have rolled over well before that, so the window may be longer than the data.`, {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Summarise ${levels.replace('-', ' and ')} events from the last ${hours} hours`,
        effect: 'read',
        requires: [
          { what: 'Rights to read the event log on the target machines — membership of Event Log Readers is enough' },
          { what: 'PowerShell remoting, or the Remote Event Log Management firewall rule' },
        ],
        parameters: [
          { name: '-Hours', description: 'How far back to look.', required: false, example: String(hours) },
          { name: '-ComputerName', description: 'Machines to read, overriding the built-in list.', required: false },
        ],
        notes: [
          'Grouping is what makes this readable. One service failing every thirty seconds produces two thousand events and one line here.',
          'A machine that cannot be read is reported rather than skipped, because a machine that has stopped logging is itself worth knowing about.',
          'Add ids to the ignore list as you decide they are noise, and keep that list in the script rather than in someone’s head.',
        ],
        usage: [`pwsh -File .\\${name}.ps1`, `pwsh -File .\\${name}.ps1 -Hours 72`, `pwsh -File .\\${name}.ps1 | Export-Csv .\\events.csv -NoTypeInformation`],
        undo: ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble([`[int]$Hours = ${hours}`, '[string[]]$ComputerName', "[string]$LogPath = 'C:\\Logs'"], { changes: false }),
          ...logging(),
          ...transcript(name),
          'try {',
          `    if (-not $ComputerName) { $ComputerName = @(${computers.map((c) => quoted(c)).join(', ')}) }`,
          `    $logs = @(${logs.map((l) => quoted(l)).join(', ')})`,
          `    $ignore = @(${ignore.join(', ')})`,
          '    $since = (Get-Date).AddHours(-$Hours)',
          '    Write-Log "Reading $($logs -join \', \') on $($ComputerName.Count) machines since $since"',
          '',
          '    $events = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($computer in $ComputerName) {',
          '        foreach ($log in $logs) {',
          '            try {',
          '                $filter = @{',
          '                    LogName   = $log',
          `                    Level     = @(${levelList})`,
          '                    StartTime = $since',
          '                }',
          '                $raw = Get-WinEvent -ComputerName $computer -FilterHashtable $filter -ErrorAction Stop',
          '                foreach ($item in $raw) {',
          '                    if ($item.Id -in $ignore) { continue }',
          '                    $events.Add([pscustomobject]@{',
          '                        Computer = $computer',
          '                        Log      = $log',
          '                        Time     = $item.TimeCreated',
          '                        Id       = $item.Id',
          '                        Level    = $item.LevelDisplayName',
          '                        Source   = $item.ProviderName',
          "                        Message  = ($item.Message -split \"`n\")[0].Trim()",
          '                    })',
          '                }',
          '                Write-Log "$computer/${log}: $($raw.Count) events"',
          '            } catch [Exception] {',
          "                if ($_.Exception.Message -match 'No events were found') {",
          '                    Write-Log "$computer/${log}: nothing in the window"',
          '                } else {',
          '                    Write-Log "$computer/${log}: $($_.Exception.Message)" -Level WARN',
          '                }',
          '            }',
          '        }',
          '    }',
          '',
          ...(str(values, 'group_by', 'id-source') === 'id-source'
            ? [
                '    $summary = $events |',
                '        Group-Object Computer, Id, Source |',
                '        ForEach-Object {',
                '            $first = $_.Group[0]',
                '            [pscustomobject]@{',
                '                Computer = $first.Computer',
                '                Id       = $first.Id',
                '                Level    = $first.Level',
                '                Source   = $first.Source',
                '                Count    = $_.Count',
                '                First    = ($_.Group | Sort-Object Time | Select-Object -First 1).Time',
                '                Last     = ($_.Group | Sort-Object Time | Select-Object -Last 1).Time',
                '                Message  = $first.Message',
                '            }',
                '        } |',
                `        Sort-Object Count -Descending | Select-Object -First ${num(values, 'top', 25)}`,
              ]
            : [`    $summary = $events | Sort-Object Time -Descending | Select-Object -First ${num(values, 'top', 25)}`]),
          '',
          '    Write-Log "$($events.Count) events, $(@($summary).Count) rows after grouping"',
          '    $summary',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_remote_invoke',
    platform: PLATFORM,
    label: 'Run something across a list of machines',
    group: 'Windows servers',
    description: 'The pattern for doing anything to many machines at once: in parallel, with a timeout, collecting the failures rather than stopping at the first one.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Invoke-AcrossEstate' },
      { id: 'command', label: 'What to run on each machine', control: 'textarea', default: 'Get-CimInstance Win32_OperatingSystem |\n    Select-Object CSName, Caption, Version, LastBootUpTime, @{ n = "FreeGB"; e = { [math]::Round($_.FreePhysicalMemory / 1MB, 1) } }', hint: 'PowerShell, run inside Invoke-Command on each machine' },
      { id: 'computers_from', label: 'Machines from', control: 'select', default: 'file', options: [
        { value: 'file', label: 'A text file' },
        { value: 'ad', label: 'An Active Directory OU' },
        { value: 'parameter', label: 'A parameter' },
      ] },
      { id: 'ou', label: 'OU', control: 'text', default: 'OU=Servers,DC=example,DC=com', showWhen: { input: 'computers_from', equals: ['ad'] } },
      { id: 'parallel', label: 'Machines at a time', control: 'number', default: 20, min: 1, max: 200 },
      { id: 'timeout', label: 'Timeout per machine (seconds)', control: 'number', default: 60, min: 5, max: 3600 },
      { id: 'credential', label: 'Credentials', control: 'select', default: 'current', options: [
        { value: 'current', label: 'The account running the script' },
        { value: 'prompt', label: 'Prompt once at the start' },
        { value: 'secret', label: 'From SecretManagement' },
      ] },
      { id: 'secret_name', label: 'Secret name', control: 'text', default: 'EstateAdmin', showWhen: { input: 'credential', equals: ['secret'] } },
      { id: 'changes', label: 'This command changes things', control: 'toggle', default: false, hint: 'Adds -WhatIf and a confirmation before anything runs' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Invoke-AcrossEstate'), 'Invoke-AcrossEstate');
      const command = str(values, 'command', 'Get-Date')
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''));
      const credential = str(values, 'credential', 'current');
      const changes = bool(values, 'changes', false);
      const source = str(values, 'computers_from', 'file');
      const findings: Finding[] = [];
      if (/Remove-|Uninstall-|Format-Volume|Clear-Disk|Reset-/.test(command.join('\n')) && !changes) {
        findings.push(
          error('scripts.ps.destructive-not-declared', 'The command contains something that removes or resets, but "this command changes things" is off — so the script will run it everywhere with no dry run and no confirmation.', {
            remediation: 'Turn on "This command changes things".',
            source: 'ArchToolKit',
          }),
        );
      }
      if (num(values, 'parallel', 20) > 50) {
        findings.push(
          warning('scripts.ps.parallel-high', 'Running against more than about fifty machines at once puts real load on whatever they all depend on — a domain controller, a file server, a licence server. Start lower and raise it once you know what the command costs.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'Run one command across many machines, and collect what came back',
        effect: changes ? 'repeat-unsafe' : 'read',
        requires: [
          { what: 'PowerShell remoting enabled on the targets', how: 'Enable-PSRemoting -Force   # run on each target, or by Group Policy' },
          { what: 'PowerShell 7 or later on the machine running this, for -Parallel' },
          ...(credential === 'secret' ? [{ what: 'The SecretManagement module and a registered vault', how: 'Install-Module Microsoft.PowerShell.SecretManagement -Scope CurrentUser' }] : []),
          ...(source === 'ad' ? [{ what: 'The ActiveDirectory module, to list the machines' }] : []),
        ],
        parameters: [
          ...(source === 'file' ? [{ name: '-ComputerListPath', description: 'A text file with one machine name per line.', required: true, example: '.\\servers.txt' }] : []),
          ...(source === 'parameter' ? [{ name: '-ComputerName', description: 'The machines to run against.', required: true }] : []),
          { name: '-ThrottleLimit', description: 'How many machines to work on at once.', required: false },
          ...(changes ? [{ name: '-WhatIf', description: 'List the machines it would run against and run nothing.', required: false }] : []),
        ],
        notes: [
          'A machine that fails does not stop the run. Failures are collected and reported at the end with the reason, which is the only way to work across an estate where something is always broken.',
          'Every result carries the machine name, so the output can be sorted, filtered and exported without losing track of where a row came from.',
          ...(credential === 'prompt' ? ['The credential is prompted for once and held in memory for the run. It is never written to disk and never appears in the transcript.'] : []),
          ...(credential === 'secret' ? ['The credential comes from SecretManagement, so it is not in this file and not in the command line history.'] : []),
          ...(changes ? ['This has been marked as changing things, so it asks before it starts and supports -WhatIf. Use it.'] : []),
        ],
        usage: [
          ...(changes ? [`pwsh -File .\\${name}.ps1 -WhatIf`] : []),
          `pwsh -File .\\${name}.ps1${source === 'file' ? ' -ComputerListPath .\\servers.txt' : source === 'parameter' ? ' -ComputerName SRV01, SRV02' : ''}`,
          `pwsh -File .\\${name}.ps1 | Export-Csv .\\results.csv -NoTypeInformation`,
        ],
        undo: changes
          ? ['This depends entirely on what the command does — write the undo for it here, in this file, before running it.', 'The results file lists every machine the command succeeded on, which is the list an undo has to cover.']
          : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(
            [
              ...(source === 'file' ? ['[Parameter(Mandatory)][ValidateScript({ Test-Path $_ })][string]$ComputerListPath'] : []),
              ...(source === 'parameter' ? ['[Parameter(Mandatory)][string[]]$ComputerName'] : []),
              ...(source === 'ad' ? [`[string]$SearchBase = ${quoted(str(values, 'ou', ''))}`] : []),
              `[int]$ThrottleLimit = ${num(values, 'parallel', 20)}`,
              `[int]$TimeoutSeconds = ${num(values, 'timeout', 60)}`,
              "[string]$LogPath = 'C:\\Logs'",
            ],
            { changes, confirm: 'High' },
          ),
          ...logging(),
          ...transcript(name),
          'try {',
          ...(source === 'file' ? ['    $ComputerName = Get-Content -Path $ComputerListPath | Where-Object { $_.Trim() -and -not $_.StartsWith(\'#\') }'] : []),
          ...(source === 'ad'
            ? ['    Import-Module ActiveDirectory', '    $ComputerName = Get-ADComputer -SearchBase $SearchBase -Filter { Enabled -eq $true } | Select-Object -ExpandProperty Name']
            : []),
          '    Write-Log "$($ComputerName.Count) machines in scope"',
          '',
          ...(credential === 'prompt'
            ? ["    $credential = Get-Credential -Message 'Account to run this as on each machine'"]
            : credential === 'secret'
              ? [
                  '    Import-Module Microsoft.PowerShell.SecretManagement',
                  `    $credential = Get-Secret -Name ${quoted(str(values, 'secret_name', 'EstateAdmin'))}`,
                  '    if ($credential -isnot [pscredential]) { throw "The secret is not a credential object" }',
                ]
              : ['    $credential = $null']),
          '',
          ...(changes
            ? [
                "    if (-not $PSCmdlet.ShouldProcess(\"$($ComputerName.Count) machines\", 'Run the command')) {",
                '        Write-Log "Would run against: $($ComputerName -join \', \')" -Level WHATIF',
                '        $ComputerName | ForEach-Object { [pscustomobject]@{ Computer = $_; Status = \'WouldRun\' } }',
                '        return',
                '    }',
                '',
              ]
            : []),
          '    $results = $ComputerName | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {',
          '        $computer = $_',
          '        $timeout = $using:TimeoutSeconds',
          '        $cred = $using:credential',
          '',
          '        $invoke = @{ ComputerName = $computer; ErrorAction = \'Stop\' }',
          '        if ($cred) { $invoke.Credential = $cred }',
          '        $invoke.ScriptBlock = {',
          ...command.map((line) => `            ${line}`),
          '        }',
          '',
          '        try {',
          '            $job = Invoke-Command @invoke -AsJob',
          '            if (Wait-Job -Job $job -Timeout $timeout) {',
          '                $output = Receive-Job -Job $job',
          '                foreach ($item in $output) {',
          "                    $item | Add-Member -NotePropertyName 'Computer' -NotePropertyValue $computer -Force -PassThru |",
          "                        Add-Member -NotePropertyName 'Status' -NotePropertyValue 'OK' -Force -PassThru",
          '                }',
          '            } else {',
          '                Stop-Job -Job $job',
          "                [pscustomobject]@{ Computer = $computer; Status = 'Timeout'; Detail = \"No answer within $timeout seconds\" }",
          '            }',
          '            Remove-Job -Job $job -Force',
          '        } catch {',
          "            [pscustomobject]@{ Computer = $computer; Status = 'Failed'; Detail = $_.Exception.Message }",
          '        }',
          '    }',
          '',
          "    $failed = @($results | Where-Object Status -in @('Failed', 'Timeout'))",
          '    Write-Log "$($results.Count) results, $($failed.Count) machines failed"',
          '    foreach ($failure in $failed) { Write-Log "$($failure.Computer): $($failure.Status) — $($failure.Detail)" -Level WARN }',
          '    $results',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_disk_report',
    platform: PLATFORM,
    label: 'Disk space report and cleanup',
    group: 'Windows servers',
    description: 'Find what is full and what is filling it — then clear the things that are always safe to clear, and only those.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'Get-DiskPressure' },
      { id: 'computers', label: 'Machines', control: 'textarea', default: 'SRV01\nSRV02' },
      { id: 'warn_percent', label: 'Warn below (% free)', control: 'number', default: 15, min: 1, max: 90 },
      { id: 'critical_percent', label: 'Critical below (% free)', control: 'number', default: 5, min: 1, max: 90 },
      { id: 'find_large', label: 'Also list the largest files', control: 'toggle', default: true },
      { id: 'large_count', label: 'How many', control: 'number', default: 20, min: 1, max: 200, showWhen: { input: 'find_large', equals: ['true'] } },
      { id: 'cleanup', label: 'Clean up', control: 'select', default: 'none', options: [
        { value: 'none', label: 'Report only' },
        { value: 'safe', label: 'Windows temp, user temp, CCM cache and the update download folder' },
      ] },
      { id: 'older_than', label: 'Only remove files older than (days)', control: 'number', default: 7, min: 1, max: 365, showWhen: { input: 'cleanup', equals: ['safe'] } },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'Get-DiskPressure'), 'Get-DiskPressure');
      const computers = listOf(str(values, 'computers', '').replace(/\n/g, ','));
      const warn = num(values, 'warn_percent', 15);
      const critical = num(values, 'critical_percent', 5);
      const cleanup = str(values, 'cleanup', 'none') === 'safe';
      const findings: Finding[] = [];
      if (critical >= warn) findings.push(error('scripts.ps.thresholds-inverted', 'The critical threshold is not below the warning threshold.', { source: 'ArchToolKit' }));
      if (cleanup) {
        findings.push(
          warning('scripts.ps.cleanup-scope', 'Only the folders listed here are touched, and only files older than the threshold. That is deliberate: a cleanup script that takes a path as a parameter is a delete script waiting for a typo.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'Report disk pressure across a list of machines' + (cleanup ? ', and clear the safe caches' : ''),
        effect: cleanup ? 'destructive' : 'read',
        requires: [
          { what: 'PowerShell remoting to the target machines' },
          ...(cleanup ? [{ what: 'Local administrator on the targets, to clear the system temp folders' }] : [{ what: 'Rights to query CIM on the targets' }]),
        ],
        parameters: [
          { name: '-WarnPercent', description: 'Free space below this is a warning.', required: false, example: String(warn) },
          ...(cleanup ? [{ name: '-WhatIf', description: 'List what would be deleted and delete nothing.', required: false }] : []),
        ],
        notes: [
          'The largest-files list is what makes this useful. "C: is 94% full" is not actionable; "one log file is 60GB" is.',
          ...(cleanup
            ? [
                'The folders cleared are the ones that are safe to clear on any Windows machine: the system temp folder, each profile’s temp folder, the Configuration Manager cache and the Windows Update download folder. Nothing else, ever.',
                'Windows Update will re-download what it needs. The CCM cache will refill. That is the point — these are caches, not data.',
                'A file in use is skipped and reported rather than forced.',
              ]
            : []),
        ],
        usage: [
          `pwsh -File .\\${name}.ps1`,
          ...(cleanup ? [`pwsh -File .\\${name}.ps1 -WhatIf`, `pwsh -File .\\${name}.ps1 -Confirm:$false`] : []),
          `pwsh -File .\\${name}.ps1 | Where-Object Level -ne 'OK' | Format-Table`,
        ],
        undo: cleanup
          ? [
              'Deleted cache files cannot be restored, and do not need to be: Windows Update re-downloads what it needs, and the Configuration Manager cache refills on the next deployment.',
              'The report lists every file removed and its size, so the space recovered can be accounted for.',
            ]
          : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(
            [`[int]$WarnPercent = ${warn}`, `[int]$CriticalPercent = ${critical}`, "[string]$ReportPath = 'C:\\Reports'", "[string]$LogPath = 'C:\\Logs'"],
            { changes: cleanup, confirm: 'High' },
          ),
          ...logging(),
          ...transcript(name),
          'try {',
          `    $computers = @(${computers.map((c) => quoted(c)).join(', ')})`,
          '    $report = [System.Collections.Generic.List[object]]::new()',
          '',
          '    foreach ($computer in $computers) {',
          '        try {',
          "            $disks = Get-CimInstance -ComputerName $computer -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' -ErrorAction Stop",
          '        } catch {',
          '            Write-Log "Could not query ${computer}: $($_.Exception.Message)" -Level WARN',
          "            $report.Add([pscustomobject]@{ Computer = $computer; Drive = '-'; SizeGB = $null; FreeGB = $null; PercentFree = $null; Level = 'Unreachable' })",
          '            continue',
          '        }',
          '',
          '        foreach ($disk in $disks) {',
          '            if (-not $disk.Size) { continue }',
          '            $percent = [math]::Round(($disk.FreeSpace / $disk.Size) * 100, 1)',
          "            $level = if ($percent -le $CriticalPercent) { 'Critical' } elseif ($percent -le $WarnPercent) { 'Warning' } else { 'OK' }",
          '            $report.Add([pscustomobject]@{',
          '                Computer    = $computer',
          '                Drive       = $disk.DeviceID',
          '                SizeGB      = [math]::Round($disk.Size / 1GB, 1)',
          '                FreeGB      = [math]::Round($disk.FreeSpace / 1GB, 1)',
          '                PercentFree = $percent',
          '                Level       = $level',
          '            })',
          "            if ($level -ne 'OK') { Write-Log \"$computer $($disk.DeviceID) is $percent% free\" -Level WARN }",
          '        }',
          '    }',
          '',
          ...(bool(values, 'find_large', true)
            ? [
                "    foreach ($row in $report | Where-Object { $_.Level -in @('Warning', 'Critical') }) {",
                '        try {',
                '            $largest = Invoke-Command -ComputerName $row.Computer -ScriptBlock {',
                '                param($drive, $count)',
                '                Get-ChildItem -Path "$drive\\" -Recurse -File -ErrorAction SilentlyContinue |',
                '                    Sort-Object Length -Descending |',
                '                    Select-Object -First $count FullName, @{ n = \'SizeGB\'; e = { [math]::Round($_.Length / 1GB, 2) } }, LastWriteTime',
                `            } -ArgumentList $row.Drive, ${num(values, 'large_count', 20)} -ErrorAction Stop`,
                '            Write-Log "Largest files on $($row.Computer) $($row.Drive):"',
                '            foreach ($file in $largest) { Write-Log "  $($file.SizeGB) GB  $($file.FullName)" }',
                '        } catch {',
                '            Write-Log "Could not list files on $($row.Computer): $($_.Exception.Message)" -Level WARN',
                '        }',
                '    }',
                '',
              ]
            : []),
          ...(cleanup
            ? [
                "    foreach ($row in $report | Where-Object { $_.Level -in @('Warning', 'Critical') -and $_.Drive -eq 'C:' }) {",
                '        if (-not $PSCmdlet.ShouldProcess($row.Computer, \'Clear the safe caches on C:\')) { continue }',
                '        try {',
                '            $freed = Invoke-Command -ComputerName $row.Computer -ScriptBlock {',
                '                param($olderThanDays)',
                '                $cutoff = (Get-Date).AddDays(-$olderThanDays)',
                '                $paths = @(',
                "                    \"$env:SystemRoot\\Temp\",",
                "                    \"$env:SystemRoot\\SoftwareDistribution\\Download\",",
                "                    \"$env:SystemRoot\\CCM\\Cache\",",
                "                    \"$env:SystemRoot\\ccmcache\"",
                '                )',
                "                $paths += Get-ChildItem 'C:\\Users' -Directory -ErrorAction SilentlyContinue |",
                "                    ForEach-Object { Join-Path $_.FullName 'AppData\\Local\\Temp' }",
                '',
                '                $bytes = 0',
                '                $removed = 0',
                '                $skipped = 0',
                '                foreach ($path in $paths) {',
                '                    if (-not (Test-Path $path)) { continue }',
                '                    Get-ChildItem -Path $path -Recurse -File -ErrorAction SilentlyContinue |',
                '                        Where-Object LastWriteTime -lt $cutoff |',
                '                        ForEach-Object {',
                '                            try {',
                '                                $size = $_.Length',
                '                                Remove-Item -Path $_.FullName -Force -ErrorAction Stop',
                '                                $bytes += $size',
                '                                $removed++',
                '                            } catch { $skipped++ }',
                '                        }',
                '                }',
                '                [pscustomobject]@{ FreedGB = [math]::Round($bytes / 1GB, 2); Removed = $removed; Skipped = $skipped }',
                `            } -ArgumentList ${num(values, 'older_than', 7)} -ErrorAction Stop`,
                '            Write-Log "$($row.Computer): freed $($freed.FreedGB) GB, removed $($freed.Removed) files, skipped $($freed.Skipped) in use"',
                '        } catch {',
                '            Write-Log "Cleanup failed on $($row.Computer): $($_.Exception.Message)" -Level ERROR',
                '        }',
                '    }',
                '',
              ]
            : []),
          '    if (-not (Test-Path $ReportPath)) { New-Item -Path $ReportPath -ItemType Directory -Force | Out-Null }',
          '    $reportFile = Join-Path $ReportPath ("' + name + '-{0:yyyyMMdd-HHmmss}.csv" -f (Get-Date))',
          '    $report | Export-Csv -Path $reportFile -NoTypeInformation',
          '    Write-Log "Report written to $reportFile"',
          '    $report | Sort-Object PercentFree',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),

  /* --------------------------------------------------------------- Scaffolding */
  scriptBlueprint({
    id: 'ps_advanced_function',
    platform: PLATFORM,
    label: 'Advanced function skeleton',
    group: 'Scaffolding',
    description: 'A function written the way a module function should be: comment-based help, parameter validation, pipeline input, ShouldProcess, begin/process/end, and objects out.',
    inputs: [
      { id: 'verb', label: 'Verb', control: 'select', default: 'Get', options: [
        { value: 'Get', label: 'Get — retrieves something' },
        { value: 'Set', label: 'Set — changes something that exists' },
        { value: 'New', label: 'New — creates something' },
        { value: 'Remove', label: 'Remove — deletes something' },
        { value: 'Test', label: 'Test — returns true or false' },
        { value: 'Invoke', label: 'Invoke — performs an action' },
      ] },
      { id: 'noun', label: 'Noun', control: 'text', default: 'ApplicationHealth', hint: 'Singular, PascalCase — PowerShell convention, and Get-Verb explains why' },
      { id: 'pipeline', label: 'Accepts pipeline input', control: 'toggle', default: true },
      { id: 'pipeline_parameter', label: 'Pipeline parameter', control: 'text', default: 'Name', showWhen: { input: 'pipeline', equals: ['true'] } },
      { id: 'parameter_sets', label: 'Parameter sets', control: 'toggle', default: false, hint: 'Two mutually exclusive ways to call it' },
      { id: 'output_type', label: 'Returns', control: 'text', default: 'PSCustomObject' },
      { id: 'include_tests', label: 'Include a Pester test file', control: 'toggle', default: true },
    ],
    script: (values: BlueprintValues): Script => {
      const verb = str(values, 'verb', 'Get');
      const noun = pascal(str(values, 'noun', 'Thing'), 'Thing');
      const fn = `${verb}-${noun}`;
      const pipeline = bool(values, 'pipeline', true);
      const pipeParam = pascal(str(values, 'pipeline_parameter', 'Name'), 'Name');
      const changes = verb !== 'Get' && verb !== 'Test';
      const sets = bool(values, 'parameter_sets', false);
      const findings: Finding[] = [];
      if (!/^[A-Z][a-zA-Z]*$/.test(noun)) {
        findings.push(warning('scripts.ps.noun-shape', 'A PowerShell noun is singular and PascalCase — Get-Service, not Get-services. It is the difference between a function that reads like a cmdlet and one that reads like a script.', { source: 'ArchToolKit' }));
      }
      if (noun.endsWith('s')) {
        findings.push(
          warning('scripts.ps.plural-noun', `"${noun}" is plural. PowerShell nouns are singular even when the function returns many — Get-Process returns all of them.`, { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${fn} — an advanced function, written the way a module function should be`,
        effect: 'read',
        requires: [{ what: 'PowerShell 5.1 or later' }, ...(bool(values, 'include_tests', true) ? [{ what: 'Pester, for the test file', how: 'Install-Module Pester -Scope CurrentUser -Force' }] : [])],
        parameters: [
          { name: `-${pipeline ? pipeParam : 'Name'}`, description: 'The thing to act on.' + (pipeline ? ' Accepts pipeline input by value and by property name.' : ''), required: true },
          ...(changes ? [{ name: '-WhatIf', description: 'Report what it would do and do nothing.', required: false }] : []),
          { name: '-Verbose', description: 'Show what it is doing as it goes.', required: false },
        ],
        notes: [
          'Comment-based help is what makes Get-Help work on this function. Written at the top, it is documentation people will actually find.',
          ...(pipeline ? ['The begin/process/end structure is what makes the pipeline work properly: begin runs once, process runs per item. Putting setup in process is the usual bug.'] : []),
          ...(changes ? ['Every changing line is inside ShouldProcess, which is what gives the function -WhatIf and -Confirm. A change outside it ignores both.'] : []),
          'It returns objects, not formatted text. Whoever calls it can sort, filter and export; Write-Host would take that away.',
          'Drop this into a .psm1 and export it, or dot-source it while developing.',
        ],
        usage: [
          `. .\\${fn}.ps1`,
          `Get-Help ${fn} -Full`,
          ...(pipeline ? [`'thing1', 'thing2' | ${fn} -Verbose`] : [`${fn} -${pipeline ? pipeParam : 'Name'} thing1`]),
          ...(changes ? [`${fn} -${pipeParam} thing1 -WhatIf`] : []),
        ],
        undo: ['Nothing to undo — this is a function definition. What the function itself does when called is up to the body you fill in.'],
        body: [
          `function ${fn} {`,
          '    <#',
          '    .SYNOPSIS',
          `        One line saying what ${fn} does.`,
          '',
          '    .DESCRIPTION',
          '        A paragraph or two. Say what it is for, what it assumes, and anything',
          '        surprising about how it behaves — this is what Get-Help shows.',
          '',
          `    .PARAMETER ${pipeline ? pipeParam : 'Name'}`,
          '        What this parameter is, and what happens if it is wrong.',
          '',
          '    .EXAMPLE',
          `        ${fn} -${pipeline ? pipeParam : 'Name'} 'example'`,
          '',
          '        What that does, and what comes back.',
          '',
          ...(pipeline
            ? [
                '    .EXAMPLE',
                `        Get-Content .\\names.txt | ${fn} -Verbose`,
                '',
                '        Reads names from a file and processes each one.',
                '',
              ]
            : []),
          '    .OUTPUTS',
          `        ${str(values, 'output_type', 'PSCustomObject')}`,
          '',
          '    .NOTES',
          '        Generated by ArchToolKit.',
          '    #>',
          `    [CmdletBinding(${changes ? "SupportsShouldProcess, ConfirmImpact = 'Medium'" : ''}${sets ? `${changes ? ', ' : ''}DefaultParameterSetName = 'ByName'` : ''})]`,
          `    [OutputType([${str(values, 'output_type', 'PSCustomObject')}])]`,
          '    param(',
          `        [Parameter(Mandatory${pipeline ? ', ValueFromPipeline, ValueFromPipelineByPropertyName' : ''}${sets ? ", ParameterSetName = 'ByName'" : ''}, Position = 0)]`,
          '        [ValidateNotNullOrEmpty()]',
          `        [string[]]$${pipeline ? pipeParam : 'Name'},`,
          '',
          ...(sets
            ? [
                "        [Parameter(Mandatory, ParameterSetName = 'ById')]",
                '        [ValidateRange(1, [int]::MaxValue)]',
                '        [int[]]$Id,',
                '',
              ]
            : []),
          '        [ValidateRange(1, 3600)]',
          '        [int]$TimeoutSeconds = 30,',
          '',
          '        [switch]$Force',
          '    )',
          '',
          '    begin {',
          '        Set-StrictMode -Version Latest',
          '        # Runs once, before anything from the pipeline arrives. Set up here:',
          '        # connections, lookups, anything expensive that should happen once.',
          '        Write-Verbose "Starting $($MyInvocation.MyCommand.Name)"',
          '        $processed = 0',
          '    }',
          '',
          '    process {',
          '        # Runs once per pipeline item. Everything per-item goes here.',
          `        foreach ($item in $${pipeline ? pipeParam : 'Name'}) {`,
          '            Write-Verbose "Working on $item"',
          '            try {',
          ...(changes
            ? [
                `                if ($PSCmdlet.ShouldProcess($item, '${verb} ${noun}')) {`,
                '                    # The work goes here. Anything outside ShouldProcess',
                '                    # ignores -WhatIf and -Confirm, which defeats the point.',
                '                    $result = [pscustomobject]@{',
                '                        Name      = $item',
                "                        Status    = 'Done'",
                '                        Timestamp = Get-Date',
                '                    }',
                '                    $processed++',
                '                    $result',
                '                }',
              ]
            : [
                '                # The work goes here.',
                '                $result = [pscustomobject]@{',
                '                    Name      = $item',
                "                    Status    = 'OK'",
                '                    Timestamp = Get-Date',
                '                }',
                '                $processed++',
                '                $result',
              ]),
          '            }',
          '            catch {',
          '                # One bad item should not stop the pipeline. Write an error',
          '                # for it and carry on, unless the caller asked otherwise.',
          '                $record = [System.Management.Automation.ErrorRecord]::new(',
          '                    $_.Exception,',
          `                    '${fn}Failed',`,
          '                    [System.Management.Automation.ErrorCategory]::NotSpecified,',
          '                    $item',
          '                )',
          '                $PSCmdlet.WriteError($record)',
          '            }',
          '        }',
          '    }',
          '',
          '    end {',
          '        # Runs once, after the pipeline is exhausted. Clean up here.',
          '        Write-Verbose "$processed item(s) processed"',
          '    }',
          '}',
          ...(bool(values, 'include_tests', true)
            ? [
                '',
                '# ---------------------------------------------------------------------------',
                `# Save the block below as ${fn}.Tests.ps1 and run: Invoke-Pester`,
                '#',
                `# Describe '${fn}' {`,
                `#     BeforeAll { . $PSScriptRoot/${fn}.ps1 }`,
                '#',
                "#     It 'returns one object per input' {",
                `#         $result = ${fn} -${pipeline ? pipeParam : 'Name'} 'a', 'b'`,
                '#         $result.Count | Should -Be 2',
                '#     }',
                '#',
                ...(pipeline
                  ? [
                      "#     It 'accepts pipeline input' {",
                      `#         $result = 'a', 'b' | ${fn}`,
                      '#         $result.Count | Should -Be 2',
                      '#     }',
                      '#',
                    ]
                  : []),
                ...(changes
                  ? [
                      "#     It 'changes nothing with -WhatIf' {",
                      `#         $result = ${fn} -${pipeline ? pipeParam : 'Name'} 'a' -WhatIf`,
                      '#         $result | Should -BeNullOrEmpty',
                      '#     }',
                      '#',
                    ]
                  : []),
                "#     It 'rejects an empty name' {",
                `#         { ${fn} -${pipeline ? pipeParam : 'Name'} '' } | Should -Throw`,
                '#     }',
                '# }',
              ]
            : []),
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'ps_scheduled_task',
    platform: PLATFORM,
    label: 'Install a script as a scheduled task',
    group: 'Scaffolding',
    description: 'Register a script to run on a schedule, under an account that is not someone’s, with the logging and failure handling that makes it noticeable when it stops working.',
    inputs: [
      { id: 'task_name', label: 'Task name', control: 'text', default: 'ArchToolKit-DailyReport' },
      { id: 'script_path', label: 'Script to run', control: 'text', default: 'C:\\Scripts\\Get-DailyReport.ps1' },
      { id: 'arguments', label: 'Arguments', control: 'text', default: '-ReportPath C:\\Reports' },
      { id: 'schedule', label: 'Schedule', control: 'select', default: 'daily', options: [
        { value: 'daily', label: 'Daily' },
        { value: 'hourly', label: 'Every N hours' },
        { value: 'weekly', label: 'Weekly' },
        { value: 'startup', label: 'At startup' },
      ] },
      { id: 'time', label: 'Time', control: 'text', default: '06:00', showWhen: { input: 'schedule', equals: ['daily', 'weekly'] } },
      { id: 'interval_hours', label: 'Every N hours', control: 'number', default: 4, min: 1, max: 23, showWhen: { input: 'schedule', equals: ['hourly'] } },
      { id: 'day', label: 'Day', control: 'select', default: 'Monday', options: [
        { value: 'Monday', label: 'Monday' },
        { value: 'Tuesday', label: 'Tuesday' },
        { value: 'Wednesday', label: 'Wednesday' },
        { value: 'Thursday', label: 'Thursday' },
        { value: 'Friday', label: 'Friday' },
        { value: 'Saturday', label: 'Saturday' },
        { value: 'Sunday', label: 'Sunday' },
      ], showWhen: { input: 'schedule', equals: ['weekly'] } },
      { id: 'run_as', label: 'Run as', control: 'select', default: 'gmsa', options: [
        { value: 'gmsa', label: 'A group managed service account' },
        { value: 'system', label: 'SYSTEM — local rights only' },
        { value: 'service-account', label: 'A named service account, prompted for' },
      ] },
      { id: 'gmsa_name', label: 'gMSA', control: 'text', default: 'EXAMPLE\\svc-reports$', showWhen: { input: 'run_as', equals: ['gmsa'] } },
      { id: 'timeout_hours', label: 'Kill it after (hours)', control: 'number', default: 2, min: 1, max: 72 },
    ],
    script: (values: BlueprintValues): Script => {
      const task = identifier(str(values, 'task_name', 'ArchToolKit-Task'), 'ArchToolKit-Task');
      const schedule = str(values, 'schedule', 'daily');
      const runAs = str(values, 'run_as', 'gmsa');
      const findings: Finding[] = [];
      if (runAs === 'service-account') {
        findings.push(
          warning('scripts.ps.stored-password', 'A named service account means a password stored in the task. It never expires on its own, it is rarely rotated, and it is readable by anyone who is local administrator on the machine. A group managed service account avoids all of that.', {
            remediation: 'Use a gMSA where the domain supports it — Windows Server 2012 or later, with the KDS root key created.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (runAs === 'system') {
        findings.push(
          warning('scripts.ps.system-account', 'SYSTEM has full rights on the local machine and none on the network — it authenticates as the computer account. A script that reaches anything remote will fail in a way that looks like a permissions problem on the far end.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Register ${task} as a scheduled task`,
        effect: 'idempotent',
        requires: [
          { what: 'Local administrator on the machine the task runs on' },
          ...(runAs === 'gmsa'
            ? [
                { what: 'A group managed service account, and this machine permitted to use it', how: 'Install-ADServiceAccount -Identity svc-reports; Test-ADServiceAccount -Identity svc-reports' },
              ]
            : []),
          { what: 'The script itself, already on the machine at the path below' },
        ],
        parameters: [
          { name: '-ScriptPath', description: 'The script the task runs.', required: false },
          { name: '-WhatIf', description: 'Show what would be registered and register nothing.', required: false },
        ],
        notes: [
          'An existing task with the same name is replaced, not duplicated — so this can be re-run to change the schedule.',
          'The task is set to stop if it runs longer than the timeout. A scheduled task with no timeout that hangs will simply never run again, and nothing will say so.',
          'PowerShell is invoked with -NonInteractive and -ExecutionPolicy Bypass, because a task has nobody to answer a prompt and the execution policy is not a security boundary.',
          'Check it actually runs. Register-ScheduledTask succeeding says nothing about whether the account can read the script.',
        ],
        usage: [`pwsh -File .\\Install-${task}.ps1 -WhatIf`, `pwsh -File .\\Install-${task}.ps1`, `Get-ScheduledTask -TaskName '${task}' | Get-ScheduledTaskInfo`],
        undo: [`Unregister-ScheduledTask -TaskName '${task}' -Confirm:$false`, 'The script itself is left on disk — removing the task does not remove it.'],
        body: [
          ...preamble(
            [
              `[string]$TaskName = ${quoted(task)}`,
              `[string]$ScriptPath = ${quoted(str(values, 'script_path', ''))}`,
              `[string]$Arguments = ${quoted(str(values, 'arguments', ''))}`,
              "[string]$LogPath = 'C:\\Logs'",
            ],
            { changes: true, confirm: 'Medium' },
          ),
          ...logging(),
          ...transcript(`Install-${task}`),
          'try {',
          '    if (-not (Test-Path -Path $ScriptPath)) {',
          '        throw "The script does not exist at $ScriptPath. Put it there first — a task pointing at nothing registers happily and fails silently every night."',
          '    }',
          '',
          '    $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source',
          '    if (-not $pwshPath) { $pwshPath = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }',
          '    Write-Log "Running the task with $pwshPath"',
          '',
          '    $action = New-ScheduledTaskAction -Execute $pwshPath `',
          '        -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments"',
          '',
          ...(schedule === 'daily'
            ? [`    $trigger = New-ScheduledTaskTrigger -Daily -At ${quoted(str(values, 'time', '06:00'))}`]
            : schedule === 'weekly'
              ? [`    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${str(values, 'day', 'Monday')} -At ${quoted(str(values, 'time', '06:00'))}`]
              : schedule === 'hourly'
                ? [
                    '    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `',
                    `        -RepetitionInterval (New-TimeSpan -Hours ${num(values, 'interval_hours', 4)}) \``,
                    '        -RepetitionDuration ([TimeSpan]::MaxValue)',
                  ]
                : ['    $trigger = New-ScheduledTaskTrigger -AtStartup']),
          '',
          ...(runAs === 'gmsa'
            ? [
                `    $principal = New-ScheduledTaskPrincipal -UserId ${quoted(str(values, 'gmsa_name', ''))} -LogonType Password -RunLevel Highest`,
                '    Write-Log "Running as a group managed service account — no password is stored"',
              ]
            : runAs === 'system'
              ? ["    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest"]
              : [
                  "    $credential = Get-Credential -Message 'Service account for the scheduled task'",
                  '    $principal = New-ScheduledTaskPrincipal -UserId $credential.UserName -LogonType Password -RunLevel Highest',
                ]),
          '',
          '    $settings = New-ScheduledTaskSettingsSet `',
          '        -AllowStartIfOnBatteries `',
          '        -DontStopIfGoingOnBatteries `',
          '        -StartWhenAvailable `',
          '        -MultipleInstances IgnoreNew `',
          `        -ExecutionTimeLimit (New-TimeSpan -Hours ${num(values, 'timeout_hours', 2)}) \``,
          '        -RestartCount 2 `',
          '        -RestartInterval (New-TimeSpan -Minutes 10)',
          '',
          '    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue',
          '    if ($existing) { Write-Log "A task called $TaskName exists already and will be replaced" -Level WARN }',
          '',
          "    if ($PSCmdlet.ShouldProcess($TaskName, 'Register the scheduled task')) {",
          '        $register = @{',
          '            TaskName    = $TaskName',
          '            Action      = $action',
          '            Trigger     = $trigger',
          '            Principal   = $principal',
          '            Settings    = $settings',
          '            Description = "Runs $ScriptPath. Registered by ArchToolKit on $((Get-Date).ToString(\'yyyy-MM-dd\'))."',
          '            Force       = $true',
          '        }',
          ...(runAs === 'service-account' ? ['        $register.User = $credential.UserName', '        $register.Password = $credential.GetNetworkCredential().Password'] : []),
          '        Register-ScheduledTask @register | Out-Null',
          '        Write-Log "Registered $TaskName"',
          '',
          '        $info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo',
          '        Write-Log "Next run: $($info.NextRunTime)"',
          '        [pscustomobject]@{',
          '            TaskName    = $TaskName',
          '            ScriptPath  = $ScriptPath',
          '            NextRunTime = $info.NextRunTime',
          "            RunAs       = $principal.UserId",
          '        }',
          '    }',
          '}',
          'catch {',
          '    Write-Log $_.Exception.Message -Level ERROR',
          '    throw',
          '}',
          ...CLOSE,
        ],
        findings,
      };
    },
  }),
];

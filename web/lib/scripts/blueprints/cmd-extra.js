/**
 * Windows batch: the rest of it.
 *
 * A machine inventory, installing software silently and checking it worked,
 * registering a scheduled task, cleaning up profiles and temporary files, and
 * capturing a diagnostics bundle when something is wrong and nobody can reach
 * the machine remotely.
 *
 * These are the batch files that survive because something else calls them: an
 * imaging task sequence, a software deployment, a helpdesk instruction that
 * says "run this and send me the file". Each one says in its header where
 * PowerShell would be better.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { familyOf } from '../../core/ip.js';
import { scriptBlueprint,                      } from '../from-script.js';
import { identifier, listOf,             } from '../script.js';

const PLATFORM = 'cmd'         ;

function preamble()           {
  return [
    '@echo off',
    'setlocal EnableDelayedExpansion EnableExtensions',
    '',
    'set "SCRIPT_NAME=%~n0"',
    'set "SCRIPT_DIR=%~dp0"',
    'set "EXIT_CODE=0"',
    '',
    'call :timestamp STARTED_AT',
    '',
  ];
}

function helpers()           {
  return [
    ':timestamp',
    'rem WMIC gives a sortable, locale-independent timestamp. %DATE% does not.',
    'for /f "tokens=2 delims==" %%I in (\'wmic os get localdatetime /value 2^>nul\') do set "_ldt=%%I"',
    'if defined _ldt ( set "%~1=!_ldt:~0,8!-!_ldt:~8,6!" ) else ( set "%~1=unknown" )',
    'goto :eof',
    '',
    ':log',
    'echo [%~1] %TIME:~0,8% %~2',
    'if defined LOG_FILE echo [%~1] %DATE% %TIME:~0,8% %~2 >> "%LOG_FILE%"',
    'goto :eof',
    '',
    ':die',
    'call :log ERROR "%~1"',
    'set "EXIT_CODE=1"',
    'goto :finish',
    '',
  ];
}

export const CMD_EXTRA                             = [
  scriptBlueprint({
    id: 'cmd_system_inventory',
    platform: PLATFORM,
    label: 'Machine inventory',
    group: 'Operations',
    description: 'Hardware, operating system, disks, network, installed software and patches, written to a CSV that can be collected from every machine and merged.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'inventory' },
      { id: 'output', label: 'Write to', control: 'select', default: 'share', options: [
        { value: 'share', label: 'A network share, one file per machine' },
        { value: 'local', label: 'Locally, for collecting later' },
      ] },
      { id: 'share_path', label: 'Share', control: 'text', default: '\\\\files01\\Inventory$', showWhen: { input: 'output', equals: ['share'] } },
      { id: 'sections', label: 'Include', control: 'select', default: 'all', options: [
        { value: 'all', label: 'Everything, including installed software' },
        { value: 'hardware', label: 'Hardware and operating system only — much faster' },
      ] },
      { id: 'format', label: 'Format', control: 'select', default: 'csv', options: [
        { value: 'csv', label: 'One CSV row per machine, for merging' },
        { value: 'text', label: 'A readable text file per machine' },
      ] },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'inventory'), 'inventory');
      const toShare = str(values, 'output', 'share') === 'share';
      const full = str(values, 'sections', 'all') === 'all';
      const csv = str(values, 'format', 'csv') === 'csv';
      const findings            = [];

      findings.push(
        warning('scripts.cmd.wmic-deprecated', 'WMIC is deprecated and is being removed from Windows. It still works on everything in service today, and it is the only inventory tool guaranteed present on a machine with no PowerShell execution policy — which is why it is here. Anywhere PowerShell can run, use Get-CimInstance instead.', {
          source: 'ArchToolKit',
        }),
      );
      if (full) {
        findings.push(
          warning('scripts.cmd.installed-software-slow', 'Enumerating installed software through Win32_Product triggers a consistency check on every installed MSI, which is slow and writes an event log entry for each one. This reads the uninstall registry keys instead, which is both faster and harmless.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (toShare) {
        findings.push(
          warning('scripts.cmd.share-write-access', 'Every machine running this needs write access to the share. Grant Create Files rather than Modify, so a machine can drop its own file and cannot read or delete anybody else\u2019s.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'Collect a machine inventory',
        effect: 'read',
        requires: [
          { what: 'Windows, cmd.exe' },
          { what: 'Local administrator, for some of the hardware detail — it degrades without it' },
          ...(toShare ? [{ what: 'Write access to the share, for the computer account or the logged-on user' }] : []),
        ],
        parameters: [
          { name: '/OUT:path', description: 'Override where the file is written.', required: false },
          { name: '/QUIET', description: 'No console output — for running from a task sequence.', required: false },
        ],
        notes: [
          'Written as batch deliberately: it runs from a task sequence, a logon script or a helpdesk instruction, on a machine where PowerShell may be restricted. Anywhere PowerShell runs, it would be a better tool.',
          ...(full ? ['Installed software is read from the uninstall registry keys, not from Win32_Product. Querying Win32_Product triggers a consistency check on every MSI, which takes minutes and writes an event for each one.'] : []),
          ...(csv ? ['One row per machine, with a header. Collect them all and `copy *.csv merged.csv` gives a single file — though the headers repeat, so a real merge is a one-line PowerShell command.'] : []),
          'Both 32-bit and 64-bit uninstall keys are read. Reading only one misses about half the software on a 64-bit machine.',
          'The first IPv4 address and the first global IPv6 address are both recorded; temporary (privacy) and link-local IPv6 addresses are left out because they change or mean nothing off the local link. The labels are read from ipconfig, which is localised: on a non-English Windows both columns come back empty.',
        ],
        usage: [`${name}.cmd`, `${name}.cmd /QUIET`, `rem From a task sequence: cmd /c "%~dp0${name}.cmd" /QUIET`],
        undo: ['Nothing to undo — it reads and writes one file.'],
        body: [
          ...preamble(),
          ...(toShare ? [`set "OUT_DIR=${str(values, 'share_path', '')}"`] : ['set "OUT_DIR=%ProgramData%\\Inventory"']),
          'set "QUIET=0"',
          '',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'echo %~1 | findstr /i /b /c:"/OUT:" >nul && ( set "_a=%~1" & set "OUT_DIR=!_a:~5!" & shift & goto :parse_args )',
          'if /i "%~1"=="/QUIET" ( set "QUIET=1" & shift & goto :parse_args )',
          'if /i "%~1"=="/?" ( echo Usage: %SCRIPT_NAME% [/OUT:path] [/QUIET] & goto :finish )',
          'shift',
          'goto :parse_args',
          ':args_done',
          '',
          'if not exist "%OUT_DIR%" md "%OUT_DIR%" 2>nul',
          'if not exist "%OUT_DIR%" (',
          '    rem The share may be unreachable. Fall back rather than losing the run.',
          '    set "OUT_DIR=%TEMP%"',
          ')',
          `set "OUT_FILE=%OUT_DIR%\\%COMPUTERNAME%${csv ? '.csv' : '-%STARTED_AT%.txt'}"`,
          'set "LOG_FILE=%TEMP%\\%SCRIPT_NAME%.log"',
          '',
          'call :log INFO "Collecting inventory for %COMPUTERNAME%"',
          '',
          'rem --- facts ----------------------------------------------------------------',
          'set "OS_NAME=" & set "OS_VERSION=" & set "OS_BUILD=" & set "OS_ARCH=" & set "INSTALL_DATE="',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get Caption /value 2^>nul ^| findstr "="\') do set "OS_NAME=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get Version /value 2^>nul ^| findstr "="\') do set "OS_VERSION=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get BuildNumber /value 2^>nul ^| findstr "="\') do set "OS_BUILD=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get OSArchitecture /value 2^>nul ^| findstr "="\') do set "OS_ARCH=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get InstallDate /value 2^>nul ^| findstr "="\') do set "INSTALL_DATE=%%I"',
          '',
          'set "MANUFACTURER=" & set "MODEL=" & set "SERIAL=" & set "MEMORY_MB=" & set "CPU_NAME=" & set "CPU_CORES="',
          'for /f "tokens=2 delims==" %%I in (\'wmic computersystem get Manufacturer /value 2^>nul ^| findstr "="\') do set "MANUFACTURER=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic computersystem get Model /value 2^>nul ^| findstr "="\') do set "MODEL=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic bios get SerialNumber /value 2^>nul ^| findstr "="\') do set "SERIAL=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic computersystem get TotalPhysicalMemory /value 2^>nul ^| findstr "="\') do set /a "MEMORY_MB=%%I/1048576" 2>nul',
          'for /f "tokens=2 delims==" %%I in (\'wmic cpu get Name /value 2^>nul ^| findstr "="\') do set "CPU_NAME=%%I"',
          'for /f "tokens=2 delims==" %%I in (\'wmic cpu get NumberOfCores /value 2^>nul ^| findstr "="\') do set "CPU_CORES=%%I"',
          '',
          'set "DOMAIN=%USERDNSDOMAIN%"',
          'if not defined DOMAIN set "DOMAIN=WORKGROUP"',
          '',
          'set "IP_ADDRESS="',
          'for /f "tokens=2 delims=:" %%I in (\'ipconfig ^| findstr /c:"IPv4 Address"\') do (',
          '    if not defined IP_ADDRESS set "IP_ADDRESS=%%I"',
          ')',
          'set "IP_ADDRESS=%IP_ADDRESS: =%"',
          '',
          'rem The global IPv6 address. It has colons of its own, so everything after',
          'rem the label\'s colon is kept, and the "(Preferred)" suffix cut off. Only',
          'rem lines that start with "IPv6 Address": the temporary and link-local',
          'rem ones are not the address anybody looks the machine up by.',
          'set "IPV6_ADDRESS="',
          'for /f "tokens=1,* delims=:" %%I in (\'ipconfig ^| findstr /r /c:"^ *IPv6 Address"\') do (',
          '    for /f "tokens=1 delims=( " %%A in ("%%J") do if not defined IPV6_ADDRESS set "IPV6_ADDRESS=%%A"',
          ')',
          '',
          'set "DISK_TOTAL_GB=0" & set "DISK_FREE_GB=0"',
          'for /f "tokens=2,3" %%A in (\'wmic logicaldisk where "DriveType=3" get Size^,FreeSpace 2^>nul ^| findstr /r "[0-9]"\') do (',
          '    set /a "DISK_FREE_GB+=%%A/1073741824" 2>nul',
          '    set /a "DISK_TOTAL_GB+=%%B/1073741824" 2>nul',
          ')',
          '',
          'set "LAST_BOOT="',
          'for /f "tokens=2 delims==" %%I in (\'wmic os get LastBootUpTime /value 2^>nul ^| findstr "="\') do set "LAST_BOOT=%%I"',
          '',
          'set "BITLOCKER=Unknown"',
          'for /f "tokens=2 delims=:" %%I in (\'manage-bde -status C: 2^>nul ^| findstr /c:"Conversion Status"\') do set "BITLOCKER=%%I"',
          'set "BITLOCKER=%BITLOCKER: =%"',
          '',
          ...(csv
            ? [
                'rem --- one row per machine, for merging --------------------------------------',
                '(',
                '  echo ComputerName,Domain,IPAddress,IPv6Address,Manufacturer,Model,Serial,CPU,Cores,MemoryMB,DiskTotalGB,DiskFreeGB,OS,Version,Build,Architecture,InstallDate,LastBoot,BitLocker,Collected',
                '  echo %COMPUTERNAME%,%DOMAIN%,%IP_ADDRESS%,%IPV6_ADDRESS%,"%MANUFACTURER%","%MODEL%",%SERIAL%,"%CPU_NAME%",%CPU_CORES%,%MEMORY_MB%,%DISK_TOTAL_GB%,%DISK_FREE_GB%,"%OS_NAME%",%OS_VERSION%,%OS_BUILD%,%OS_ARCH%,%INSTALL_DATE:~0,8%,%LAST_BOOT:~0,8%,%BITLOCKER%,%STARTED_AT%',
                ') > "%OUT_FILE%"',
              ]
            : [
                'rem --- a readable report -----------------------------------------------------',
                '(',
                '  echo Inventory for %COMPUTERNAME%',
                '  echo Collected %DATE% %TIME%',
                '  echo.',
                '  echo === System ===',
                '  echo Domain:        %DOMAIN%',
                '  echo IP address:    %IP_ADDRESS%',
                '  echo IPv6 address:  %IPV6_ADDRESS%',
                '  echo Manufacturer:  %MANUFACTURER%',
                '  echo Model:         %MODEL%',
                '  echo Serial:        %SERIAL%',
                '  echo.',
                '  echo === Operating system ===',
                '  echo Name:          %OS_NAME%',
                '  echo Version:       %OS_VERSION% build %OS_BUILD%',
                '  echo Architecture:  %OS_ARCH%',
                '  echo Installed:     %INSTALL_DATE:~0,8%',
                '  echo Last boot:     %LAST_BOOT:~0,8%',
                '  echo.',
                '  echo === Hardware ===',
                '  echo CPU:           %CPU_NAME% ^(%CPU_CORES% cores^)',
                '  echo Memory:        %MEMORY_MB% MB',
                '  echo Disk:          %DISK_FREE_GB% GB free of %DISK_TOTAL_GB% GB',
                '  echo BitLocker:     %BITLOCKER%',
                '  echo.',
                '  echo === Disks ===',
                '  wmic logicaldisk where "DriveType=3" get DeviceID^,Size^,FreeSpace^,FileSystem 2^>nul',
                '  echo.',
                '  echo === Network ===',
                '  ipconfig /all',
                ') > "%OUT_FILE%"',
              ]),
          '',
          ...(full
            ? [
                'rem --- installed software ----------------------------------------------------',
                'rem From the uninstall keys, not Win32_Product. Querying Win32_Product',
                'rem triggers a consistency check on every MSI: slow, and it writes an',
                'rem event log entry for each one.',
                'set "SOFTWARE_FILE=%OUT_DIR%\\%COMPUTERNAME%-software.csv"',
                '(',
                '  echo Name,Version,Publisher,InstallDate',
                '  rem Both hives: reading only the 64-bit one misses about half the software.',
                '  for %%K in (',
                '    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"',
                '    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"',
                '  ) do (',
                '    for /f "tokens=*" %%S in (\'reg query %%K 2^>nul\') do (',
                '      set "DISPLAY_NAME=" & set "DISPLAY_VERSION=" & set "PUBLISHER=" & set "INSTALLED="',
                '      for /f "tokens=2,*" %%A in (\'reg query "%%S" /v DisplayName 2^>nul ^| findstr "REG_SZ"\') do set "DISPLAY_NAME=%%B"',
                '      for /f "tokens=2,*" %%A in (\'reg query "%%S" /v DisplayVersion 2^>nul ^| findstr "REG_SZ"\') do set "DISPLAY_VERSION=%%B"',
                '      for /f "tokens=2,*" %%A in (\'reg query "%%S" /v Publisher 2^>nul ^| findstr "REG_SZ"\') do set "PUBLISHER=%%B"',
                '      for /f "tokens=2,*" %%A in (\'reg query "%%S" /v InstallDate 2^>nul ^| findstr "REG_SZ"\') do set "INSTALLED=%%B"',
                '      if defined DISPLAY_NAME echo "!DISPLAY_NAME!","!DISPLAY_VERSION!","!PUBLISHER!",!INSTALLED!',
                '    )',
                '  )',
                ') > "%SOFTWARE_FILE%"',
                'call :log INFO "Software written to %SOFTWARE_FILE%"',
                '',
                'rem --- patches ---------------------------------------------------------------',
                'set "PATCH_FILE=%OUT_DIR%\\%COMPUTERNAME%-patches.csv"',
                '(',
                '  echo HotFixID,InstalledOn,Description',
                '  for /f "skip=1 tokens=1,2,3 delims=," %%A in (\'wmic qfe get HotFixID^,InstalledOn^,Description /format:csv 2^>nul\') do (',
                '    if not "%%B"=="" echo %%B,%%C,%%D',
                '  )',
                ') > "%PATCH_FILE%"',
                'call :log INFO "Patches written to %PATCH_FILE%"',
                '',
              ]
            : []),
          'call :log INFO "Inventory written to %OUT_FILE%"',
          'if "%QUIET%"=="0" type "%OUT_FILE%"',
          'goto :finish',
          '',
          ...helpers(),
          ':finish',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'cmd_silent_install',
    platform: PLATFORM,
    label: 'Silent install with verification',
    group: 'Deployment',
    description: 'Install something without a prompt, read the exit code properly, and confirm afterwards that it is actually there — which an installer returning 0 does not prove.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'install-app' },
      { id: 'installer', label: 'Installer', control: 'text', default: 'AppSetup.msi' },
      { id: 'type', label: 'Type', control: 'select', default: 'msi', options: [
        { value: 'msi', label: 'MSI' },
        { value: 'exe', label: 'EXE with silent switches' },
        { value: 'msu', label: 'MSU — a Windows update package' },
      ] },
      { id: 'arguments', label: 'Arguments', control: 'text', default: 'ALLUSERS=1 REBOOT=ReallySuppress', hint: 'Beyond the silent switches' },
      { id: 'verify_by', label: 'Confirm it installed by', control: 'select', default: 'registry', options: [
        { value: 'registry', label: 'The uninstall registry key' },
        { value: 'file', label: 'A file existing' },
        { value: 'service', label: 'A service existing' },
      ] },
      { id: 'verify_value', label: 'Look for', control: 'text', default: 'Example Application', hint: 'A display name, a file path or a service name' },
      { id: 'min_version', label: 'Minimum version', control: 'text', default: '', hint: 'Skip when this version or later is already installed' },
      { id: 'prerequisites', label: 'Check first', control: 'text', default: '', hint: 'Files or services that must exist before installing' },
      { id: 'reboot', label: 'If a reboot is needed', control: 'select', default: 'suppress', options: [
        { value: 'suppress', label: 'Suppress it and report' },
        { value: 'allow', label: 'Let the installer reboot' },
      ] },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'install-app'), 'install-app');
      const type = str(values, 'type', 'msi');
      const verifyBy = str(values, 'verify_by', 'registry');
      const findings            = [];

      findings.push(
        warning('scripts.cmd.msi-exit-codes', 'An MSI returns 0 for success, 1641 and 3010 for "succeeded, a reboot is needed", and 1618 for "another installation is in progress". Treating anything non-zero as a failure is how a perfectly good install gets reported as broken — and how a retry loop fights the Windows Installer mutex.', {
          source: 'ArchToolKit',
        }),
      );
      if (type === 'exe') {
        findings.push(
          warning('scripts.cmd.exe-silent-switches', 'Every EXE installer has its own silent switch, and some have none. /S, /silent, /quiet, /verysilent and -s are all used by different vendors. Check the documentation, and test on a machine you can rebuild.', {
            source: 'ArchToolKit',
          }),
        );
      }
      findings.push(
        warning('scripts.cmd.exit-code-is-not-proof', 'An installer returning 0 means the installer finished, not that the software works. The verification step afterwards is what makes this a deployment rather than a hope.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `Install ${str(values, 'installer', 'the package')} silently and confirm it worked`,
        effect: 'idempotent',
        requires: [
          { what: 'An elevated prompt, or a deployment system that runs as SYSTEM' },
          { what: 'The installer beside this script, or at the path given' },
          { what: 'No other installation in progress — the script waits for the Windows Installer mutex' },
        ],
        parameters: [
          { name: '/WHATIF', description: 'Show what would be installed and install nothing.', required: false },
          { name: '/FORCE', description: 'Install even when it appears to be there already.', required: false },
          { name: '/SOURCE:path', description: 'Where the installer is.', required: false },
        ],
        notes: [
          'It checks whether the software is already installed first, so re-running it is safe. A deployment system that runs the same command every day should not reinstall every day.',
          'Exit codes are read properly: 0, 1641 and 3010 are all success, 3010 meaning a reboot is pending. Anything else is a failure with the code reported.',
          'The Windows Installer mutex is waited for rather than fought with. Two MSIs at once fail with 1618, and a retry loop makes that worse.',
          `Verification is by ${verifyBy === 'registry' ? 'the uninstall registry key' : verifyBy === 'file' ? 'the file existing' : 'the service existing'}, after the install, because an exit code of 0 only means the installer finished.`,
          'The full installer log is kept. When something fails, that log is the only thing that says why — and it is the first thing anyone asks for.',
        ],
        usage: [`${name}.cmd /WHATIF`, `${name}.cmd`, `${name}.cmd /SOURCE:\\\\files01\\Software$\\App`, `echo %ERRORLEVEL%`],
        undo: [
          type === 'msi'
            ? 'msiexec /x {ProductCode} /qn — the product code is in the log and in the uninstall key.'
            : 'Run the uninstall string from the registry key the verification step reads.',
          'The installer log is kept whatever happens, and it records what was changed.',
        ],
        body: [
          ...preamble(),
          `set "INSTALLER=${str(values, 'installer', '')}"`,
          'set "SOURCE=%SCRIPT_DIR%"',
          'set "WHATIF=0"',
          'set "FORCE=0"',
          'set "LOG_DIR=C:\\Logs"',
          '',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'if /i "%~1"=="/WHATIF" ( set "WHATIF=1" & shift & goto :parse_args )',
          'if /i "%~1"=="/FORCE" ( set "FORCE=1" & shift & goto :parse_args )',
          'echo %~1 | findstr /i /b /c:"/SOURCE:" >nul && ( set "_a=%~1" & set "SOURCE=!_a:~8!" & shift & goto :parse_args )',
          'if /i "%~1"=="/?" ( echo Usage: %SCRIPT_NAME% [/WHATIF] [/FORCE] [/SOURCE:path] & goto :finish )',
          'call :die "Unknown argument: %~1"',
          '',
          ':args_done',
          'if not exist "%LOG_DIR%" md "%LOG_DIR%" 2>nul',
          'set "LOG_FILE=%LOG_DIR%\\%SCRIPT_NAME%-%STARTED_AT%.log"',
          'set "INSTALL_LOG=%LOG_DIR%\\%SCRIPT_NAME%-installer-%STARTED_AT%.log"',
          '',
          'net session >nul 2>&1',
          'if errorlevel 1 call :die "This needs an elevated prompt."',
          '',
          'rem --- is it there already? --------------------------------------------------',
          'set "ALREADY=0"',
          'set "FOUND_VERSION="',
          'call :check_installed',
          '',
          'if "%ALREADY%"=="1" if "%FORCE%"=="0" (',
          '    call :log INFO "Already installed!FOUND_VERSION! — nothing to do. Use /FORCE to reinstall."',
          '    goto :finish',
          ')',
          '',
          ...(str(values, 'prerequisites', '')
            ? [
                'rem --- prerequisites ---------------------------------------------------------',
                ...listOf(str(values, 'prerequisites', '')).flatMap((p) => [
                  `if not exist "${p}" call :die "Prerequisite missing: ${p}"`,
                ]),
                '',
              ]
            : []),
          'rem --- the installer ---------------------------------------------------------',
          'set "PACKAGE=%SOURCE%\\%INSTALLER%"',
          'if not exist "%PACKAGE%" call :die "No installer at %PACKAGE%"',
          '',
          'rem Two MSIs at once fail with 1618. Wait rather than fight the mutex.',
          'set /a "_waited=0"',
          ':wait_for_installer',
          'tasklist /fi "IMAGENAME eq msiexec.exe" 2>nul | find /i "msiexec.exe" >nul',
          'if errorlevel 1 goto :installer_free',
          'if !_waited! GEQ 300 call :die "Another installation has been running for 5 minutes. Not starting."',
          'call :log INFO "Another installation is running. Waiting..."',
          'timeout /t 10 /nobreak >nul',
          'set /a "_waited+=10"',
          'goto :wait_for_installer',
          ':installer_free',
          '',
          'if "%WHATIF%"=="1" (',
          '    call :log WHATIF "Would install %PACKAGE%"',
          '    goto :finish',
          ')',
          '',
          'call :log INFO "Installing %PACKAGE%"',
          ...(type === 'msi'
            ? [
                `msiexec /i "%PACKAGE%" /qn /norestart /l*v "%INSTALL_LOG%" ${str(values, 'arguments', '')}`,
              ]
            : type === 'msu'
              ? ['wusa "%PACKAGE%" /quiet /norestart /log:"%INSTALL_LOG%"']
              : [`"%PACKAGE%" ${str(values, 'arguments', '/S')} > "%INSTALL_LOG%" 2>&1`]),
          'set "RC=!ERRORLEVEL!"',
          '',
          'rem 0 succeeded. 1641 and 3010 succeeded with a reboot pending. Treating',
          'rem anything non-zero as a failure is how a good install is reported broken.',
          'set "REBOOT_PENDING=0"',
          'if "!RC!"=="0" (',
          '    call :log INFO "Installed successfully"',
          ') else if "!RC!"=="3010" (',
          '    call :log INFO "Installed successfully. A reboot is required."',
          '    set "REBOOT_PENDING=1"',
          ') else if "!RC!"=="1641" (',
          '    call :log INFO "Installed successfully. The installer initiated a reboot."',
          '    set "REBOOT_PENDING=1"',
          ') else if "!RC!"=="1618" (',
          '    call :die "Another installation is in progress (1618). Try again later."',
          ') else if "!RC!"=="1603" (',
          '    call :log ERROR "Fatal installer error (1603). The reason is in %INSTALL_LOG% — search it for \'Return value 3\'."',
          '    set "EXIT_CODE=1"',
          '    goto :finish',
          ') else (',
          '    call :die "The installer returned !RC!. See %INSTALL_LOG%."',
          ')',
          '',
          'rem --- verify ----------------------------------------------------------------',
          'rem An exit code of 0 means the installer finished, not that the software',
          'rem is there. This is what makes it a deployment rather than a hope.',
          'timeout /t 5 /nobreak >nul',
          'set "ALREADY=0"',
          'call :check_installed',
          'if "%ALREADY%"=="0" (',
          '    call :log ERROR "The installer reported success but the software cannot be found. See %INSTALL_LOG%."',
          '    set "EXIT_CODE=1"',
          '    goto :finish',
          ')',
          'call :log INFO "Verified: installed!FOUND_VERSION!"',
          '',
          ...(str(values, 'reboot', 'suppress') === 'suppress'
            ? ['if "%REBOOT_PENDING%"=="1" call :log WARN "A reboot is pending. The software may not work until it happens."']
            : ['if "%REBOOT_PENDING%"=="1" ( call :log WARN "Rebooting in 60 seconds" & shutdown /r /t 60 /c "Reboot required by %SCRIPT_NAME%" )']),
          'goto :finish',
          '',
          'rem --- subroutines -----------------------------------------------------------',
          ':check_installed',
          ...(verifyBy === 'registry'
            ? [
                'rem Both hives: reading only one misses about half the software.',
                'for %%K in (',
                '  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"',
                '  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"',
                ') do (',
                `  reg query %%K /s /f "${str(values, 'verify_value', '')}" /d 2>nul | findstr /i "${str(values, 'verify_value', '')}" >nul && set "ALREADY=1"`,
                ')',
                ...(str(values, 'min_version', '')
                  ? [
                      'if "%ALREADY%"=="1" (',
                      `    call :log INFO "Found an existing installation. Required version: ${str(values, 'min_version', '')}"`,
                      '    set "FOUND_VERSION= (version check is by hand — read the log)"',
                      ')',
                    ]
                  : []),
              ]
            : verifyBy === 'file'
              ? [`if exist "${str(values, 'verify_value', '')}" set "ALREADY=1"`]
              : [
                  `sc query "${str(values, 'verify_value', '')}" >nul 2>&1`,
                  'if not errorlevel 1 set "ALREADY=1"',
                ]),
          'goto :eof',
          '',
          ...helpers(),
          ':finish',
          'call :log INFO "%SCRIPT_NAME% finished with code %EXIT_CODE%"',
          'if exist "%INSTALL_LOG%" call :log INFO "Installer log: %INSTALL_LOG%"',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'cmd_diagnostics',
    platform: PLATFORM,
    label: 'Diagnostics capture',
    group: 'Operations',
    description: 'One file to send when something is wrong: event logs, network state, running processes, recent errors and the configuration of whatever is broken.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'collect-diagnostics' },
      { id: 'focus', label: 'Focus on', control: 'select', default: 'general', options: [
        { value: 'general', label: 'General — events, processes, services, disk' },
        { value: 'network', label: 'Network — routes, DNS, connections, a trace' },
        { value: 'performance', label: 'Performance — what is using CPU, memory and disk' },
      ] },
      { id: 'event_hours', label: 'Events from the last (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'target_host', label: 'Test connectivity to', control: 'text', default: '', hint: 'A host name, IPv4 or IPv6 address that should be reachable', showWhen: { input: 'focus', equals: ['network', 'general'] } },
      { id: 'services', label: 'Report on these services', control: 'text', default: '', hint: 'The ones related to the problem' },
      { id: 'compress', label: 'Zip it up', control: 'toggle', default: true },
      { id: 'output', label: 'Write to', control: 'text', default: '%USERPROFILE%\\Desktop', hint: 'Somewhere the person can find it' },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'collect-diagnostics'), 'collect-diagnostics');
      const focus = str(values, 'focus', 'general');
      const services = listOf(str(values, 'services', ''));
      const findings            = [];

      findings.push(
        warning('scripts.cmd.diagnostics-are-sensitive', 'A diagnostics bundle contains hostnames, addresses, user names, running processes and event log text — which can include file paths and, occasionally, credentials that something logged by mistake. Treat it as sensitive and send it the way your organisation sends sensitive things.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `Collect ${focus} diagnostics into one file`,
        effect: 'read',
        requires: [
          { what: 'Windows, cmd.exe' },
          { what: 'An elevated prompt for the full set — it degrades without it' },
        ],
        parameters: [
          { name: '/OUT:path', description: 'Where the bundle is written.', required: false },
          { name: '/NOZIP', description: 'Leave it as a folder rather than zipping it.', required: false },
        ],
        notes: [
          'Written to be run by whoever is in front of the machine, from a helpdesk instruction: double-click, wait, send the file on the desktop. That is why it is batch and why it says what it is doing.',
          'Every command is guarded and its output kept separately, so one failing tool does not lose the rest of the bundle.',
          `Events are taken from the last ${num(values, 'event_hours', 24)} hours. Longer than that and the file gets too large to send by email, which is how it will be sent.`,
          'Nothing is changed and nothing is fixed. This collects, and collecting first is what stops a fix being applied to the wrong problem.',
        ],
        usage: [`${name}.cmd`, `rem Right-click, Run as administrator, for the full set`, `${name}.cmd /OUT:C:\\Temp`],
        undo: ['Nothing to undo — it reads and writes one bundle. Delete it when it is no longer needed.'],
        body: [
          ...preamble(),
          `set "OUT_ROOT=${str(values, 'output', '%USERPROFILE%\\Desktop')}"`,
          'set "DO_ZIP=1"',
          '',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'echo %~1 | findstr /i /b /c:"/OUT:" >nul && ( set "_a=%~1" & set "OUT_ROOT=!_a:~5!" & shift & goto :parse_args )',
          'if /i "%~1"=="/NOZIP" ( set "DO_ZIP=0" & shift & goto :parse_args )',
          'if /i "%~1"=="/?" ( echo Usage: %SCRIPT_NAME% [/OUT:path] [/NOZIP] & goto :finish )',
          'shift',
          'goto :parse_args',
          ':args_done',
          '',
          'set "BUNDLE=%OUT_ROOT%\\diagnostics-%COMPUTERNAME%-%STARTED_AT%"',
          'md "%BUNDLE%" 2>nul',
          'if not exist "%BUNDLE%" (',
          '    set "BUNDLE=%TEMP%\\diagnostics-%COMPUTERNAME%-%STARTED_AT%"',
          '    md "!BUNDLE!" 2>nul',
          ')',
          'set "LOG_FILE=%BUNDLE%\\collection.log"',
          '',
          'echo.',
          'echo Collecting diagnostics. This takes a minute or two.',
          'echo Please leave this window open.',
          'echo.',
          '',
          'net session >nul 2>&1',
          'if errorlevel 1 (',
          '    call :log WARN "Not running as administrator — some sections will be incomplete."',
          '    echo   [!] Not running as administrator. Some information will be missing.',
          '    echo       For the full set, right-click and Run as administrator.',
          '    echo.',
          ')',
          '',
          'rem --- always ---------------------------------------------------------------',
          'call :capture "system-info" systeminfo',
          'call :capture "running-processes" tasklist /v /fo table',
          'call :capture "services" sc query type= service state= all',
          'call :capture "disk" wmic logicaldisk get DeviceID^,Size^,FreeSpace^,FileSystem^,VolumeName',
          'call :capture "installed-patches" wmic qfe list brief',
          'call :capture "startup" wmic startup get Caption^,Command^,Location',
          'call :capture "scheduled-tasks" schtasks /query /fo list /v',
          '',
          ...(focus === 'general' || focus === 'network'
            ? [
                'rem --- network ---------------------------------------------------------------',
                'call :capture "ipconfig" ipconfig /all',
                'call :capture "routes" route print',
                'call :capture "connections" netstat -ano',
                'call :capture "arp" arp -a',
                'rem arp is IPv4 only; the IPv6 neighbour cache is here.',
                'call :capture "ipv6-neighbours" netsh interface ipv6 show neighbors',
                'call :capture "dns-cache" ipconfig /displaydns',
                'call :capture "firewall" netsh advfirewall show allprofiles',
                'call :capture "firewall-rules" netsh advfirewall firewall show rule name=all',
                'call :capture "winhttp-proxy" netsh winhttp show proxy',
                ...(str(values, 'target_host', '')
                  ? [
                      `call :capture "ping-target" ping -n 10 ${str(values, 'target_host', '')}`,
                      // A name: try each family on its own, since a dual-stack
                      // client uses IPv6 first and a broken AAAA path looks like a slow network.
                      ...(familyOf(str(values, 'target_host', '')) === null
                        ? [
                            `call :capture "ping-target-ipv4" ping -4 -n 4 ${str(values, 'target_host', '')}`,
                            `call :capture "ping-target-ipv6" ping -6 -n 4 ${str(values, 'target_host', '')}`,
                          ]
                        : []),
                      `call :capture "tracert-target" tracert -d -w 1000 -h 20 ${str(values, 'target_host', '')}`,
                      `call :capture "nslookup-target" nslookup ${str(values, 'target_host', '')}`,
                    ]
                  : []),
                '',
              ]
            : []),
          ...(focus === 'performance'
            ? [
                'rem --- performance -----------------------------------------------------------',
                'call :capture "cpu-usage" wmic path Win32_PerfFormattedData_PerfProc_Process get Name^,PercentProcessorTime^,WorkingSet',
                'call :capture "memory" wmic OS get FreePhysicalMemory^,TotalVisibleMemorySize^,FreeVirtualMemory',
                'call :capture "pagefile" wmic pagefileset get Name^,InitialSize^,MaximumSize',
                'call :capture "top-memory" tasklist /fo csv /nh',
                'call :capture "disk-queue" wmic path Win32_PerfFormattedData_PerfDisk_LogicalDisk get Name^,CurrentDiskQueueLength^,PercentIdleTime',
                '',
              ]
            : []),
          'rem --- event logs --------------------------------------------------------------',
          'rem Longer than this and the bundle is too large to email, which is how it',
          'rem will be sent.',
          `set "EVENT_HOURS=${num(values, 'event_hours', 24)}"`,
          'set /a "EVENT_MS=EVENT_HOURS*3600000"',
          'call :log INFO "Collecting events from the last %EVENT_HOURS% hours"',
          'wevtutil qe System /q:"*[System[(Level=1 or Level=2 or Level=3) and TimeCreated[timediff(@SystemTime) <= %EVENT_MS%]]]" /f:text /c:300 > "%BUNDLE%\\events-system.txt" 2>&1',
          'wevtutil qe Application /q:"*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= %EVENT_MS%]]]" /f:text /c:300 > "%BUNDLE%\\events-application.txt" 2>&1',
          '',
          ...(services.length > 0
            ? [
                'rem --- named services ----------------------------------------------------------',
                ...services.flatMap((service) => [
                  `call :capture "service-${service}" sc qc "${service}"`,
                  `sc query "${service}" >> "%BUNDLE%\\service-${service}.txt" 2>&1`,
                ]),
                '',
              ]
            : []),
          'rem --- a summary the person can read -------------------------------------------',
          '(',
          '  echo Diagnostics for %COMPUTERNAME%',
          '  echo Collected %DATE% %TIME% by %USERNAME%',
          '  echo.',
          '  echo This bundle contains:',
          '  dir /b "%BUNDLE%"',
          '  echo.',
          '  echo It includes hostnames, addresses, user names and event log text.',
          '  echo Treat it as sensitive.',
          ') > "%BUNDLE%\\README.txt"',
          '',
          'if "%DO_ZIP%"=="1" (',
          '    call :log INFO "Compressing"',
          '    rem tar has been in Windows since 1803 and needs nothing installed.',
          '    tar -a -c -f "%BUNDLE%.zip" -C "%OUT_ROOT%" "diagnostics-%COMPUTERNAME%-%STARTED_AT%" 2>nul',
          '    if exist "%BUNDLE%.zip" (',
          '        rd /s /q "%BUNDLE%" 2>nul',
          '        set "BUNDLE=%BUNDLE%.zip"',
          '    ) else (',
          '        call :log WARN "Could not compress — the folder has been left as it is."',
          '    )',
          ')',
          '',
          'echo.',
          'echo ================================================================',
          'echo  Done. Send this file:',
          'echo.',
          'echo    %BUNDLE%',
          'echo.',
          'echo  It contains system information about this machine.',
          'echo  Send it the way your organisation sends sensitive files.',
          'echo ================================================================',
          'echo.',
          'goto :finish',
          '',
          'rem --- subroutines -------------------------------------------------------------',
          ':capture',
          'rem :capture NAME command... — each output in its own file, so one failing',
          'rem tool does not lose the rest of the bundle.',
          'set "_name=%~1"',
          'shift',
          'set "_cmd=%1"',
          ':capture_args',
          'shift',
          'if not "%~1"=="" ( set "_cmd=!_cmd! %1" & goto :capture_args )',
          'echo   collecting %_name%...',
          '!_cmd! > "%BUNDLE%\\%_name%.txt" 2>&1',
          'if errorlevel 1 echo (command failed or is unavailable) >> "%BUNDLE%\\%_name%.txt"',
          'goto :eof',
          '',
          ...helpers(),
          ':finish',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),
];

/**
 * Windows batch: the scripts that still run because something old calls them.
 *
 * Batch is a poor language and it is not going away — a logon script, a
 * scheduled task on a machine with no PowerShell execution policy, a wrapper
 * some installer expects. So these are written the way a batch file has to be
 * written to be reliable: `setlocal` so it does not leak variables into the
 * session, delayed expansion where a variable is set and read inside a loop,
 * `errorlevel` checked after every call rather than at the end, and every path
 * quoted because Program Files has a space in it.
 *
 * Where PowerShell would be better, the generated file says so in its header
 * rather than pretending otherwise.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { scriptBlueprint,                      } from '../from-script.js';
import { identifier, listOf,             } from '../script.js';

const PLATFORM = 'cmd'         ;

/**
 * The opening every generated batch file shares.
 *
 * `setlocal EnableDelayedExpansion` is the one that matters: without it, a
 * variable set inside a `for` loop reads as its value from before the loop
 * started, which is the single most confusing behaviour in the language.
 */
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

/** The subroutines every script needs, since batch has no functions worth the name. */
function helpers(logDir        )           {
  return [
    ':timestamp',
    'rem WMIC gives a sortable, locale-independent timestamp. %DATE% does not:',
    'rem it is formatted differently on a machine set to a different region.',
    'for /f "tokens=2 delims==" %%I in (\'wmic os get localdatetime /value 2^>nul\') do set "_ldt=%%I"',
    'if defined _ldt (',
    '    set "%~1=!_ldt:~0,8!-!_ldt:~8,6!"',
    ') else (',
    '    set "%~1=unknown"',
    ')',
    'goto :eof',
    '',
    ':log',
    'rem :log LEVEL message',
    'echo [%~1] %TIME:~0,8% %~2',
    ...(logDir ? [`if defined LOG_FILE echo [%~1] %DATE% %TIME:~0,8% %~2 >> "%LOG_FILE%"`] : []),
    'goto :eof',
    '',
    ':die',
    'call :log ERROR "%~1"',
    'set "EXIT_CODE=1"',
    'goto :finish',
    '',
  ];
}

export const CMD_BASE                             = [
  scriptBlueprint({
    id: 'cmd_skeleton',
    platform: PLATFORM,
    label: 'Batch file skeleton',
    group: 'Scaffolding',
    description: 'A batch file written the way one has to be: setlocal, delayed expansion, argument parsing, error level checked after every step, logging and a single exit path.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'maintenance' },
      { id: 'summary', label: 'What it does', control: 'text', default: 'Runs the nightly maintenance steps' },
      { id: 'arguments', label: 'Arguments it takes', control: 'text', default: 'target, environment', hint: 'Named as /TARGET:value' },
      { id: 'require_admin', label: 'Require administrator', control: 'toggle', default: false },
      { id: 'log_dir', label: 'Log directory', control: 'text', default: 'C:\\Logs', hint: 'Empty for console only' },
      { id: 'dry_run', label: 'Include /WHATIF', control: 'toggle', default: true },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'script'), 'script');
      const args = listOf(str(values, 'arguments', ''));
      const logDir = str(values, 'log_dir', '');
      const dryRun = bool(values, 'dry_run', true);
      const findings            = [];
      findings.push(
        warning('scripts.cmd.prefer-powershell', 'Batch has no error handling worth the name, no data types and no way to work with structured output. Unless something specifically requires a .cmd file — an installer wrapper, a logon script on a machine with no PowerShell — PowerShell will be easier to write and far easier to debug.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `${name} — ${str(values, 'summary', 'a batch file')}`,
        effect: dryRun ? 'idempotent' : 'read',
        requires: [
          { what: 'Windows, cmd.exe — nothing else' },
          ...(bool(values, 'require_admin', false) ? [{ what: 'An elevated prompt (Run as administrator)' }] : []),
        ],
        parameters: [
          ...args.map((argument) => ({ name: `/${argument.toUpperCase()}:value`, description: `The ${argument}.`, required: false })),
          ...(dryRun ? [{ name: '/WHATIF', description: 'Show what would happen and do nothing.', required: false }] : []),
          { name: '/VERBOSE', description: 'Echo each command as it runs.', required: false },
          { name: '/?', description: 'Usage.', required: false },
        ],
        notes: [
          '`setlocal` keeps variables out of the calling session. Without it, a batch file run twice in the same window behaves differently the second time.',
          'Delayed expansion — the `!variable!` form — is needed for anything set and read inside a `for` loop. `%variable%` inside a loop reads the value from before the loop started, which looks like the script ignoring its own assignments.',
          'Every path is quoted. `C:\\Program Files\\...` unquoted becomes two arguments, and the error it produces never mentions the space.',
          'There is a single exit path through :finish, so cleanup always runs and the exit code is always set.',
        ],
        usage: [`${name}.cmd /?`, ...(dryRun ? [`${name}.cmd /WHATIF /VERBOSE`] : []), `${name}.cmd${args[0] ? ` /${args[0].toUpperCase()}:value` : ''}`],
        undo: dryRun ? ['What there is to undo depends on what goes in :main. Write it here as that is filled in.', '/WHATIF changes nothing, so it is always safe.'] : ['Nothing to undo — this skeleton reads and reports.'],
        body: [
          ...preamble(),
          ...args.map((argument) => `set "${argument.toUpperCase()}="`),
          ...(dryRun ? ['set "WHATIF=0"'] : []),
          'set "VERBOSE=0"',
          '',
          'rem --- arguments ----------------------------------------------------------',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          ...args.flatMap((argument) => {
            const upper = argument.toUpperCase();
            return [
              `echo %~1 | findstr /i /b /c:"/${upper}:" >nul && (`,
              `    set "_arg=%~1"`,
              `    set "${upper}=!_arg:~${upper.length + 2}!"`,
              '    shift',
              '    goto :parse_args',
              ')',
            ];
          }),
          ...(dryRun ? ['if /i "%~1"=="/WHATIF" ( set "WHATIF=1" & shift & goto :parse_args )'] : []),
          'if /i "%~1"=="/VERBOSE" ( set "VERBOSE=1" & echo on & shift & goto :parse_args )',
          'if /i "%~1"=="/?" goto :usage',
          'if /i "%~1"=="--help" goto :usage',
          'call :log ERROR "Unknown argument: %~1"',
          'goto :usage',
          '',
          ':args_done',
          '',
          ...(logDir
            ? [
                `set "LOG_DIR=${logDir}"`,
                'if not exist "%LOG_DIR%" md "%LOG_DIR%" 2>nul',
                'set "LOG_FILE=%LOG_DIR%\\%SCRIPT_NAME%-%STARTED_AT%.log"',
                '',
              ]
            : []),
          ...(bool(values, 'require_admin', false)
            ? [
                'rem Elevation: net session fails for a non-elevated prompt.',
                'net session >nul 2>&1',
                'if errorlevel 1 (',
                '    call :log ERROR "This needs an elevated prompt. Right-click and Run as administrator."',
                '    set "EXIT_CODE=1"',
                '    goto :finish',
                ')',
                '',
              ]
            : []),
          'call :log INFO "%SCRIPT_NAME% starting"',
          ...args.map((argument) => `call :log INFO "${argument.toUpperCase()}=!${argument.toUpperCase()}!"`),
          '',
          'call :main',
          'goto :finish',
          '',
          'rem --- the work -----------------------------------------------------------',
          ':main',
          'rem Put the work here. After every external command, check errorlevel',
          'rem immediately — it is overwritten by the next command that sets it.',
          'rem',
          'rem     call :run robocopy "%SOURCE%" "%DEST%" /MIR',
          'rem     if errorlevel 1 call :die "The copy failed"',
          'goto :eof',
          '',
          'rem --- helpers ------------------------------------------------------------',
          ':run',
          ...(dryRun
            ? ['if "%WHATIF%"=="1" (', '    call :log WHATIF "%*"', '    goto :eof', ')']
            : []),
          'call :log INFO "+ %*"',
          '%*',
          'goto :eof',
          '',
          ...helpers(logDir),
          ':usage',
          `echo ${str(values, 'summary', '')}`,
          'echo.',
          'echo Usage: %SCRIPT_NAME% [options]',
          'echo.',
          'echo Options:',
          ...args.map((argument) => `echo   /${argument.toUpperCase()}:value${' '.repeat(Math.max(1, 16 - argument.length))}TODO: describe it`),
          ...(dryRun ? ['echo   /WHATIF              show what would happen and do nothing'] : []),
          'echo   /VERBOSE             echo each command',
          'echo   /?                   this',
          'set "EXIT_CODE=0"',
          'goto :finish',
          '',
          ':finish',
          'call :log INFO "%SCRIPT_NAME% finished with code %EXIT_CODE%"',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'cmd_robocopy_backup',
    platform: PLATFORM,
    label: 'Robocopy backup or sync',
    group: 'Operations',
    description: 'Copy or mirror a folder with robocopy — and handle its exit codes properly, which almost nothing does, because anything below 8 is a success and every script treats it as a failure.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'backup-data' },
      { id: 'source', label: 'Source', control: 'text', default: 'D:\\Data' },
      { id: 'destination', label: 'Destination', control: 'text', default: '\\\\backup01\\Backups$\\Data' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'mirror', options: [
        { value: 'mirror', label: 'Mirror — the destination becomes identical, deletions included' },
        { value: 'copy', label: 'Copy — add and update, never delete' },
        { value: 'move', label: 'Move — copy, then remove the source' },
      ] },
      { id: 'exclude_dirs', label: 'Exclude folders', control: 'text', default: 'Temp, Cache, $RECYCLE.BIN' },
      { id: 'exclude_files', label: 'Exclude files', control: 'text', default: '*.tmp, thumbs.db, ~$*' },
      { id: 'threads', label: 'Threads', control: 'number', default: 16, min: 1, max: 128 },
      { id: 'retries', label: 'Retries per file', control: 'number', default: 2, min: 0, max: 10 },
      { id: 'copy_flags', label: 'What to copy', control: 'select', default: 'dat', options: [
        { value: 'dat', label: 'Data, attributes and timestamps' },
        { value: 'datso', label: 'Also security, owner and auditing — needs backup rights' },
      ] },
      { id: 'keep_log', label: 'Keep the robocopy log', control: 'toggle', default: true },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'backup'), 'backup');
      const mode = str(values, 'mode', 'mirror');
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const excludeDirs = listOf(str(values, 'exclude_dirs', ''));
      const excludeFiles = listOf(str(values, 'exclude_files', ''));
      const findings            = [];
      if (mode === 'mirror') {
        findings.push(
          warning('scripts.cmd.mirror-deletes', '/MIR deletes anything in the destination that is not in the source. If the source is empty or unmounted when this runs, the destination is emptied — and robocopy reports that as a success.', {
            remediation: 'The generated script checks the source exists and is not empty before running. Keep that check.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (mode === 'move') {
        findings.push(
          warning('scripts.cmd.move-is-destructive', '/MOVE removes the source files once they are copied. There is no undo, and a destination that turns out to be wrong has already taken the originals with it.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (destination.startsWith('\\\\') && source.startsWith('\\\\')) {
        findings.push(
          warning('scripts.cmd.unc-to-unc', 'Copying between two UNC paths sends every byte through this machine, twice. If both ends are servers, running it on one of them halves the traffic.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${mode} ${source || 'a folder'} to ${destination || 'a destination'}`,
        effect: mode === 'copy' ? 'idempotent' : 'destructive',
        requires: [
          { what: 'robocopy — included with Windows' },
          { what: 'Read access to the source, write access to the destination' },
          ...(str(values, 'copy_flags', 'dat') === 'datso'
            ? [{ what: 'The Backup Operators right, or equivalent, to copy security descriptors', how: 'Copying ACLs needs SeBackupPrivilege and SeRestorePrivilege' }]
            : []),
        ],
        parameters: [
          { name: '/WHATIF', description: 'Run robocopy in list-only mode: it reports every file it would touch and copies nothing.', required: false },
          { name: '/SOURCE:path', description: 'Override the source.', required: false },
          { name: '/DEST:path', description: 'Override the destination.', required: false },
        ],
        notes: [
          'Robocopy exit codes are a bit field, not a status: 0 nothing to do, 1 files copied, 2 extra files in the destination, 4 mismatched, 8 or above a real failure. Anything below 8 is success. Treating a non-zero exit code as a failure is the classic robocopy scripting mistake, and this script does not make it.',
          ...(mode === 'mirror' ? ['The source is checked before the copy: if it does not exist or contains no files, the script stops rather than mirroring emptiness over the backup.'] : []),
          '/WHATIF passes /L to robocopy, which lists what it would do and copies nothing. Use it the first time, every time.',
          '/Z is not used. It makes a copy restartable and costs a great deal of speed; /ZB is worse. Use them only over a link that genuinely drops.',
        ],
        usage: [`${name}.cmd /WHATIF`, `${name}.cmd`, `${name}.cmd /SOURCE:E:\\Other /DEST:\\\\backup01\\Other$`, 'rem As a scheduled task, run it with: cmd /c "path\\to\\' + name + '.cmd"'],
        undo:
          mode === 'copy'
            ? ['Nothing is deleted, so nothing needs undoing — remove the copied files from the destination if they are not wanted.']
            : mode === 'mirror'
              ? ['A mirror deletes. Whatever the destination held before is gone unless there is a snapshot or an older backup of it.', 'This is why the run is preceded by a check and why /WHATIF exists.']
              : ['A move deletes the source. The only way back is from the destination — copy them back before doing anything else.'],
        body: [
          ...preamble(),
          `set "SOURCE=${source}"`,
          `set "DEST=${destination}"`,
          'set "WHATIF=0"',
          'set "ROBO_EXTRA="',
          '',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'if /i "%~1"=="/WHATIF" ( set "WHATIF=1" & shift & goto :parse_args )',
          'echo %~1 | findstr /i /b /c:"/SOURCE:" >nul && ( set "_a=%~1" & set "SOURCE=!_a:~8!" & shift & goto :parse_args )',
          'echo %~1 | findstr /i /b /c:"/DEST:" >nul && ( set "_a=%~1" & set "DEST=!_a:~6!" & shift & goto :parse_args )',
          'if /i "%~1"=="/?" ( echo Usage: %SCRIPT_NAME% [/WHATIF] [/SOURCE:path] [/DEST:path] & goto :finish )',
          'call :die "Unknown argument: %~1"',
          '',
          ':args_done',
          `set "LOG_DIR=C:\\Logs"`,
          'if not exist "%LOG_DIR%" md "%LOG_DIR%" 2>nul',
          'set "LOG_FILE=%LOG_DIR%\\%SCRIPT_NAME%-%STARTED_AT%.log"',
          ...(bool(values, 'keep_log', true) ? ['set "ROBO_LOG=%LOG_DIR%\\%SCRIPT_NAME%-robocopy-%STARTED_AT%.log"'] : ['set "ROBO_LOG="']),
          '',
          'call :log INFO "Source:      %SOURCE%"',
          'call :log INFO "Destination: %DEST%"',
          '',
          'rem --- checks before anything is copied -----------------------------------',
          'if not exist "%SOURCE%" call :die "The source does not exist: %SOURCE%"',
          '',
          ...(mode === 'mirror'
            ? [
                'rem A mirror of an empty or unmounted source empties the destination,',
                'rem and robocopy calls that a success. Refuse instead.',
                'set "FILE_COUNT=0"',
                'for /f %%C in (\'dir /a-d /s /b "%SOURCE%" 2^>nul ^| find /c /v ""\') do set "FILE_COUNT=%%C"',
                'if "!FILE_COUNT!"=="0" call :die "The source contains no files. Refusing to mirror an empty folder over the destination."',
                'call :log INFO "Source holds !FILE_COUNT! file(s)"',
                '',
              ]
            : []),
          'if not exist "%DEST%" (',
          '    call :log INFO "Creating the destination: %DEST%"',
          '    md "%DEST%" 2>nul',
          '    if errorlevel 1 call :die "Could not create the destination: %DEST%"',
          ')',
          '',
          'rem --- the copy -----------------------------------------------------------',
          ...(mode === 'mirror' ? ['set "ROBO_MODE=/MIR"'] : mode === 'move' ? ['set "ROBO_MODE=/E /MOVE"'] : ['set "ROBO_MODE=/E"']),
          `set "ROBO_OPTS=/COPY:${str(values, 'copy_flags', 'dat').toUpperCase()} /R:${num(values, 'retries', 2)} /W:5 /MT:${num(values, 'threads', 16)} /NP /TEE"`,
          ...(excludeDirs.length > 0 ? [`set "ROBO_XD=/XD ${excludeDirs.map((d) => `"${d}"`).join(' ')}"`] : ['set "ROBO_XD="']),
          ...(excludeFiles.length > 0 ? [`set "ROBO_XF=/XF ${excludeFiles.map((f) => `"${f}"`).join(' ')}"`] : ['set "ROBO_XF="']),
          'if "%WHATIF%"=="1" (',
          '    set "ROBO_EXTRA=/L"',
          '    call :log WHATIF "Listing only. Nothing will be copied."',
          ')',
          ...(bool(values, 'keep_log', true) ? ['if defined ROBO_LOG set "ROBO_EXTRA=!ROBO_EXTRA! /LOG+:!ROBO_LOG!"'] : []),
          '',
          'call :log INFO "Running robocopy"',
          'robocopy "%SOURCE%" "%DEST%" %ROBO_MODE% %ROBO_OPTS% %ROBO_XD% %ROBO_XF% !ROBO_EXTRA!',
          'set "ROBO_RC=!ERRORLEVEL!"',
          '',
          'rem Robocopy exit codes are a bit field, not a status. Below 8 is success.',
          'rem   1 files copied   2 extra files in the destination',
          'rem   4 mismatched     8 some files failed to copy    16 fatal',
          'if !ROBO_RC! GEQ 16 (',
          '    call :die "Robocopy failed fatally (code !ROBO_RC!). Check the log."',
          ')',
          'if !ROBO_RC! GEQ 8 (',
          '    call :log ERROR "Some files could not be copied (code !ROBO_RC!). Check the log."',
          '    set "EXIT_CODE=1"',
          '    goto :finish',
          ')',
          'if !ROBO_RC! EQU 0 call :log INFO "Nothing to do — already identical"',
          'if !ROBO_RC! GEQ 1 if !ROBO_RC! LSS 8 call :log INFO "Completed successfully (code !ROBO_RC!)"',
          '',
          ...(bool(values, 'keep_log', true) ? ['if defined ROBO_LOG call :log INFO "Robocopy log: !ROBO_LOG!"'] : []),
          'goto :finish',
          '',
          ...helpers('C:\\Logs'),
          ':finish',
          'call :log INFO "%SCRIPT_NAME% finished with code %EXIT_CODE%"',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'cmd_service_control',
    platform: PLATFORM,
    label: 'Stop and start services in order',
    group: 'Operations',
    description: 'Bring a set of services down and back up in a defined order, waiting for each one rather than assuming — the wrapper an installer or a maintenance window needs.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'cycle-app-services' },
      { id: 'services', label: 'Services, in start order', control: 'text', default: 'MSSQLSERVER, AppService, W3SVC', hint: 'Stopped in reverse, started in this order' },
      { id: 'action', label: 'Action', control: 'select', default: 'restart', options: [
        { value: 'restart', label: 'Stop all, then start all' },
        { value: 'stop', label: 'Stop only' },
        { value: 'start', label: 'Start only' },
      ] },
      { id: 'wait_seconds', label: 'Wait for each (seconds)', control: 'number', default: 60, min: 5, max: 600 },
      { id: 'force_kill', label: 'Kill a service that will not stop', control: 'toggle', default: false },
      { id: 'run_between', label: 'Run this while they are stopped', control: 'text', default: '', showWhen: { input: 'action', equals: ['restart'] } },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'cycle-services'), 'cycle-services');
      const services = listOf(str(values, 'services', ''));
      const action = str(values, 'action', 'restart');
      const findings            = [];
      if (services.length === 0) findings.push(error('scripts.cmd.no-services', 'No service was named.', { source: 'ArchToolKit' }));
      if (bool(values, 'force_kill', false)) {
        findings.push(
          warning('scripts.cmd.taskkill-service', 'Killing a service process skips whatever it does on shutdown — flushing to disk, closing a transaction, releasing a lock. A database killed this way may take far longer to start than it would have taken to stop.', {
            remediation: 'Raise the timeout first. Kill only when you know what the service does on shutdown.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${action} ${services.join(', ') || 'services'} in order`,
        effect: 'repeat-unsafe',
        requires: [{ what: 'An elevated prompt (Run as administrator)' }, { what: 'Rights to control the named services' }],
        parameters: [
          { name: '/WHATIF', description: 'Show what would be stopped and started, and do neither.', required: false },
          { name: '/WAIT:n', description: 'Override the wait, in seconds.', required: false },
        ],
        notes: [
          'Services are stopped in reverse order and started in the given order, because dependencies run one way. Getting that backwards is why a restart script sometimes leaves something down.',
          '`net stop` returns before the service has finished stopping. The script polls `sc query` until the state is actually STOPPED, which is the difference between a working script and one that works most of the time.',
          'A service that is already in the wanted state is left alone and reported, not restarted.',
          'A service that does not exist on this machine is a warning rather than a failure — the same script often runs across machines with slightly different roles.',
        ],
        usage: [`${name}.cmd /WHATIF`, `${name}.cmd`, `${name}.cmd /WAIT:180`],
        undo:
          action === 'stop'
            ? [`Start them again in order: ${services.join(', ')}`, `net start <service>`]
            : action === 'start'
              ? ['Stop them in reverse order if they should not have been started.']
              : ['The services end up where they started, running. If one failed to come back, the log says which and `sc query <service>` says why.'],
        body: [
          ...preamble(),
          `set "SERVICES=${services.join(' ')}"`,
          `set "WAIT_SECONDS=${num(values, 'wait_seconds', 60)}"`,
          'set "WHATIF=0"',
          '',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'if /i "%~1"=="/WHATIF" ( set "WHATIF=1" & shift & goto :parse_args )',
          'echo %~1 | findstr /i /b /c:"/WAIT:" >nul && ( set "_a=%~1" & set "WAIT_SECONDS=!_a:~6!" & shift & goto :parse_args )',
          'if /i "%~1"=="/?" ( echo Usage: %SCRIPT_NAME% [/WHATIF] [/WAIT:seconds] & goto :finish )',
          'call :die "Unknown argument: %~1"',
          '',
          ':args_done',
          'set "LOG_DIR=C:\\Logs"',
          'if not exist "%LOG_DIR%" md "%LOG_DIR%" 2>nul',
          'set "LOG_FILE=%LOG_DIR%\\%SCRIPT_NAME%-%STARTED_AT%.log"',
          '',
          'net session >nul 2>&1',
          'if errorlevel 1 call :die "This needs an elevated prompt."',
          '',
          ...(action === 'restart' || action === 'stop'
            ? [
                'rem --- stop, in reverse order --------------------------------------------',
                'call :log INFO "Stopping services in reverse order"',
                'set "REVERSED="',
                'for %%S in (%SERVICES%) do set "REVERSED=%%S !REVERSED!"',
                'for %%S in (!REVERSED!) do call :stop_service %%S',
                'if not "%EXIT_CODE%"=="0" goto :finish',
                '',
              ]
            : []),
          ...(action === 'restart' && str(values, 'run_between', '')
            ? [
                'call :log INFO "Running the between-step while everything is stopped"',
                'if "%WHATIF%"=="1" (',
                `    call :log WHATIF "${str(values, 'run_between', '')}"`,
                ') else (',
                `    ${str(values, 'run_between', '')}`,
                '    if errorlevel 1 call :log ERROR "The between-step failed. Starting the services again anyway."',
                ')',
                '',
              ]
            : []),
          ...(action === 'restart' || action === 'start'
            ? [
                'rem --- start, in order ----------------------------------------------------',
                'call :log INFO "Starting services in order"',
                'for %%S in (%SERVICES%) do call :start_service %%S',
                '',
              ]
            : []),
          'call :log INFO "Final state:"',
          'for %%S in (%SERVICES%) do call :report %%S',
          'goto :finish',
          '',
          'rem --- subroutines --------------------------------------------------------',
          ':stop_service',
          'set "SVC=%~1"',
          'sc query "%SVC%" >nul 2>&1',
          'if errorlevel 1 (',
          '    call :log WARN "%SVC% is not installed on this machine. Skipping it."',
          '    goto :eof',
          ')',
          'call :state "%SVC%" CURRENT',
          'if /i "!CURRENT!"=="STOPPED" (',
          '    call :log INFO "%SVC% is already stopped"',
          '    goto :eof',
          ')',
          'if "%WHATIF%"=="1" (',
          '    call :log WHATIF "Would stop %SVC% (currently !CURRENT!)"',
          '    goto :eof',
          ')',
          'call :log INFO "Stopping %SVC%"',
          'net stop "%SVC%" /y >nul 2>&1',
          'rem net stop returns before the service has actually stopped, so poll.',
          'set /a "_waited=0"',
          ':wait_stop',
          'call :state "%SVC%" CURRENT',
          'if /i "!CURRENT!"=="STOPPED" (',
          '    call :log INFO "%SVC% stopped after !_waited!s"',
          '    goto :eof',
          ')',
          'if !_waited! GEQ %WAIT_SECONDS% goto :stop_timeout',
          'timeout /t 2 /nobreak >nul',
          'set /a "_waited+=2"',
          'goto :wait_stop',
          '',
          ':stop_timeout',
          ...(bool(values, 'force_kill', false)
            ? [
                'call :log WARN "%SVC% did not stop within %WAIT_SECONDS%s. Killing it."',
                'for /f "tokens=3" %%P in (\'sc queryex "%SVC%" ^| findstr /i "PID"\') do set "_pid=%%P"',
                'if defined _pid if not "!_pid!"=="0" taskkill /F /PID !_pid! >nul 2>&1',
                'timeout /t 3 /nobreak >nul',
                'call :state "%SVC%" CURRENT',
                'if /i not "!CURRENT!"=="STOPPED" call :die "%SVC% could not be stopped, even by killing it."',
                'call :log WARN "%SVC% was killed"',
                'goto :eof',
              ]
            : ['call :die "%SVC% did not stop within %WAIT_SECONDS%s. Nothing else has been touched."']),
          '',
          ':start_service',
          'set "SVC=%~1"',
          'sc query "%SVC%" >nul 2>&1',
          'if errorlevel 1 (',
          '    call :log WARN "%SVC% is not installed on this machine. Skipping it."',
          '    goto :eof',
          ')',
          'call :state "%SVC%" CURRENT',
          'if /i "!CURRENT!"=="RUNNING" (',
          '    call :log INFO "%SVC% is already running"',
          '    goto :eof',
          ')',
          'if "%WHATIF%"=="1" (',
          '    call :log WHATIF "Would start %SVC% (currently !CURRENT!)"',
          '    goto :eof',
          ')',
          'call :log INFO "Starting %SVC%"',
          'net start "%SVC%" >nul 2>&1',
          'set /a "_waited=0"',
          ':wait_start',
          'call :state "%SVC%" CURRENT',
          'if /i "!CURRENT!"=="RUNNING" (',
          '    call :log INFO "%SVC% started after !_waited!s"',
          '    goto :eof',
          ')',
          'if !_waited! GEQ %WAIT_SECONDS% (',
          '    call :log ERROR "%SVC% did not start within %WAIT_SECONDS%s (state !CURRENT!)"',
          '    set "EXIT_CODE=1"',
          '    goto :eof',
          ')',
          'timeout /t 2 /nobreak >nul',
          'set /a "_waited+=2"',
          'goto :wait_start',
          '',
          ':state',
          'rem :state SERVICE OUTVAR — reads the current state from sc query',
          'set "%~2=UNKNOWN"',
          'for /f "tokens=3" %%X in (\'sc query "%~1" ^| findstr /i "STATE"\') do set "%~2=%%X"',
          'goto :eof',
          '',
          ':report',
          'call :state "%~1" CURRENT',
          'call :log INFO "  %~1 = !CURRENT!"',
          'goto :eof',
          '',
          ...helpers('C:\\Logs'),
          ':finish',
          'call :log INFO "%SCRIPT_NAME% finished with code %EXIT_CODE%"',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'cmd_logon_script',
    platform: PLATFORM,
    label: 'Logon script: drives and printers',
    group: 'Configuration',
    description: 'Map drives and printers by group membership at logon — the thing that is still a batch file in most organisations, written so a failure does not hold up the logon.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'logon' },
      { id: 'drives', label: 'Drive mappings', control: 'textarea', default: 'H: \\\\files\\home\\%USERNAME%\nS: \\\\files\\shared\nF: \\\\files\\finance : Finance-Users', hint: 'LETTER: path [: group]' },
      { id: 'printers', label: 'Printers', control: 'textarea', default: '\\\\print01\\HP-Floor2\n\\\\print01\\Finance-Colour : Finance-Users', hint: 'path [: group]' },
      { id: 'default_printer', label: 'Default printer', control: 'text', default: '\\\\print01\\HP-Floor2' },
      { id: 'remove_stale', label: 'Remove existing mappings first', control: 'toggle', default: true },
      { id: 'timeout', label: 'Give up on a mapping after (seconds)', control: 'number', default: 10, min: 2, max: 60 },
    ],
    script: (values                 )         => {
      const name = identifier(str(values, 'script_name', 'logon'), 'logon');
      const drives = str(values, 'drives', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [mapping, group] = line.split(/\s*:\s*(?=[^\\])/);
          const parts = (mapping ?? '').trim().split(/\s+/);
          return { letter: (parts[0] ?? '').replace(/:$/, ''), path: parts.slice(1).join(' '), group: (group ?? '').trim() };
        })
        .filter((d) => d.letter && d.path);
      const printers = str(values, 'printers', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [path, group] = line.split(/\s*:\s*(?=[^\\])/);
          return { path: (path ?? '').trim(), group: (group ?? '').trim() };
        })
        .filter((p) => p.path);
      const findings            = [];
      findings.push(
        warning('scripts.cmd.logon-script-alternatives', 'Group Policy Preferences map drives and printers by group without a script, retry on their own, and can be reported on centrally. A logon script is the fallback for what Preferences cannot express — not the default choice.', {
          source: 'ArchToolKit',
        }),
      );
      if (drives.length === 0 && printers.length === 0) {
        findings.push(error('scripts.cmd.nothing-to-map', 'No drive and no printer was given, so this does nothing.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Map ${drives.length} drive(s) and ${printers.length} printer(s) at logon`,
        effect: 'idempotent',
        requires: [{ what: 'A domain-joined machine, run in the user’s own context' }, { what: 'The shares and print queues already existing and permissioned' }],
        parameters: [
          { name: '/VERBOSE', description: 'Show each mapping. Normally the script is silent.', required: false },
          { name: '/WHATIF', description: 'List the mappings it would make and make none.', required: false },
        ],
        notes: [
          'It never stops on a failure. A share that is down must not stop the rest of the logon — the failure is logged to the user’s temp folder and the script carries on.',
          'Group membership is read once, from `whoami /groups`, rather than by querying the directory per mapping. That is one call instead of ten, and the difference is visible in the logon time.',
          'Every mapping is checked before it is made, so a re-run does not produce errors about drives that already exist.',
          'The window is hidden by the policy that calls it, not by the script. If it flashes, the Group Policy setting "Run logon scripts synchronously" or the task’s window style is what to change.',
        ],
        usage: [
          `${name}.cmd /WHATIF /VERBOSE`,
          `rem As a user logon script, via Group Policy: User Configuration > Policies > Windows Settings > Scripts`,
          `${name}.cmd /VERBOSE`,
          `rem Log: %TEMP%\\${name}-<date>.log`,
        ],
        undo: [
          `Drives: net use <letter>: /delete`,
          `Printers: rundll32 printui.dll,PrintUIEntry /dn /n "<printer>"`,
          'Neither survives a logoff anyway unless the mapping was made persistent, which this does not do.',
        ],
        body: [
          ...preamble(),
          'set "VERBOSE=0"',
          'set "WHATIF=0"',
          ':parse_args',
          'if "%~1"=="" goto :args_done',
          'if /i "%~1"=="/VERBOSE" ( set "VERBOSE=1" & shift & goto :parse_args )',
          'if /i "%~1"=="/WHATIF" ( set "WHATIF=1" & shift & goto :parse_args )',
          'shift',
          'goto :parse_args',
          ':args_done',
          '',
          'rem The log goes in the user profile: a logon script cannot rely on being',
          'rem able to write anywhere else.',
          'set "LOG_DIR=%TEMP%"',
          `set "LOG_FILE=%LOG_DIR%\\${name}-%STARTED_AT%.log"`,
          '',
          'call :log INFO "Logon script for %USERNAME% on %COMPUTERNAME%"',
          '',
          'rem Read group membership once. Ten directory queries at logon is ten too many.',
          'set "MY_GROUPS="',
          'for /f "tokens=1 delims= " %%G in (\'whoami /groups /fo csv /nh 2^>nul\') do set "MY_GROUPS=!MY_GROUPS! %%~G"',
          '',
          ...(bool(values, 'remove_stale', true)
            ? [
                'rem Clear existing mappings so a changed path takes effect. Errors here',
                'rem are expected and ignored — there may be nothing to remove.',
                'if "%WHATIF%"=="1" goto :skip_unmap',
                ...drives.map((d) => `net use ${d.letter}: /delete /y >nul 2>&1`),
                ':skip_unmap',
                '',
              ]
            : []),
          ...drives.flatMap((drive) => {
            const lines           = [];
            if (drive.group) {
              lines.push(`echo !MY_GROUPS! | findstr /i /c:"${drive.group}" >nul`);
              lines.push('if not errorlevel 1 (');
              lines.push(`    call :map_drive "${drive.letter}" "${drive.path}"`);
              lines.push(') else (');
              lines.push(`    call :verbose "Not a member of ${drive.group} — skipping ${drive.letter}:"`);
              lines.push(')');
            } else {
              lines.push(`call :map_drive "${drive.letter}" "${drive.path}"`);
            }
            lines.push('');
            return lines;
          }),
          ...printers.flatMap((printer) => {
            const lines           = [];
            if (printer.group) {
              lines.push(`echo !MY_GROUPS! | findstr /i /c:"${printer.group}" >nul`);
              lines.push('if not errorlevel 1 (');
              lines.push(`    call :add_printer "${printer.path}"`);
              lines.push(') else (');
              lines.push(`    call :verbose "Not a member of ${printer.group} — skipping ${printer.path}"`);
              lines.push(')');
            } else {
              lines.push(`call :add_printer "${printer.path}"`);
            }
            lines.push('');
            return lines;
          }),
          ...(str(values, 'default_printer', '')
            ? [
                `call :verbose "Setting the default printer"`,
                `rundll32 printui.dll,PrintUIEntry /y /n "${str(values, 'default_printer', '')}" >nul 2>&1`,
                '',
              ]
            : []),
          'call :log INFO "Logon script finished"',
          'goto :finish',
          '',
          ':map_drive',
          'set "LETTER=%~1"',
          'set "UNC=%~2"',
          'rem Already mapped to the right place? Leave it alone.',
          'net use %LETTER%: 2>nul | findstr /i /c:"%UNC%" >nul',
          'if not errorlevel 1 (',
          '    call :verbose "%LETTER%: is already mapped to %UNC%"',
          '    goto :eof',
          ')',
          'if "%WHATIF%"=="1" (',
          '    call :log WHATIF "Would map %LETTER%: to %UNC%"',
          '    goto :eof',
          ')',
          'call :verbose "Mapping %LETTER%: to %UNC%"',
          'net use %LETTER%: "%UNC%" /persistent:no >nul 2>&1',
          'if errorlevel 1 (',
          '    rem Logged, not fatal. A share being down must not hold up the logon.',
          '    call :log WARN "Could not map %LETTER%: to %UNC%"',
          ') else (',
          '    call :verbose "Mapped %LETTER%:"',
          ')',
          'goto :eof',
          '',
          ':add_printer',
          'set "PRINTER=%~1"',
          'if "%WHATIF%"=="1" (',
          '    call :log WHATIF "Would add the printer %PRINTER%"',
          '    goto :eof',
          ')',
          'rundll32 printui.dll,PrintUIEntry /ga /n "%PRINTER%" >nul 2>&1',
          'if errorlevel 1 (',
          '    call :log WARN "Could not add the printer %PRINTER%"',
          ') else (',
          '    call :verbose "Added %PRINTER%"',
          ')',
          'goto :eof',
          '',
          ':verbose',
          'if "%VERBOSE%"=="1" call :log INFO "%~1"',
          'if not "%VERBOSE%"=="1" if defined LOG_FILE echo [INFO] %TIME:~0,8% %~1 >> "%LOG_FILE%"',
          'goto :eof',
          '',
          ...helpers('%TEMP%'),
          ':finish',
          'endlocal & exit /b %EXIT_CODE%',
        ],
        findings,
      };
    },
  }),
];

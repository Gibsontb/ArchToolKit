@echo off
rem ---------------------------------------------------------------------------
rem  Run the whole update with no questions: every area (Terraform, Ansible,
rem  Network, Splunk, Data Editor, VCF, catalogs, cloud services), no prompts,
rem  no pauses. It commits and pushes only if every step and the tests pass;
rem  otherwise the summary lists what failed and nothing is committed.
rem
rem  This is update.bat in its unattended mode, so the two never drift apart.
rem ---------------------------------------------------------------------------
call "%~dp0update.bat" all /yes
exit /b %errorlevel%

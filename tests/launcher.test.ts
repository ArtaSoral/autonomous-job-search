import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")(
  "only recognizes launcher processes with a matching readable start time and command",
  () => {
    const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:LAUNCHER_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher failed to parse' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedProcess' }, $true)
Invoke-Expression $definition.Extent.Text
$runScript = 'C:\\Job Finder\\scripts\\run.ps1'
$started = [datetime]::UtcNow
$entry = @{ id = 123; started = $started.ToUniversalTime().Ticks.ToString() }

function Get-Process {
  param($Id, $ErrorAction)
  return $script:candidate
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  $script:commandChecks++
  if ($script:commandFails) { throw 'Process exited or access denied' }
  return [pscustomobject]@{ CommandLine = $script:command }
}
function Assert-Owned([string]$Name, [bool]$Expected) {
  $actual = Get-OwnedProcess $entry
  if ([bool]$actual -ne $Expected) { throw "Unexpected ownership: $Name" }
  if ($Expected -and -not [object]::ReferenceEquals($actual, $script:candidate)) { throw 'Returned the wrong process' }
}

$script:commandChecks = 0
$script:candidate = $null
Assert-Owned 'missing PID' $false
$script:candidate = [pscustomobject]@{ StartTime = $null }
Assert-Owned 'reused PID with inaccessible start time' $false
$script:candidate = [pscustomobject]@{ StartTime = $started.AddSeconds(-1) }
Assert-Owned 'reused PID with different start time' $false
$script:candidate = New-Object PSObject
$script:candidate | Add-Member ScriptProperty StartTime { throw 'Access denied' }
Assert-Owned 'start time getter fails' $false
if ($script:commandChecks -ne 0) { throw 'Queried commands for an unverified start time' }

$script:candidate = [pscustomobject]@{ StartTime = $started }
$script:command = $null
Assert-Owned 'unavailable command' $false
$script:command = 'powershell.exe other.ps1'
Assert-Owned 'unrelated command' $false
$script:command = 'powershell.exe -File "' + $runScript + '" start'
Assert-Owned 'matching launcher' $true
$script:commandFails = $true
Assert-Owned 'command query fails' $false
Write-Output 'Launcher ownership checks passed.'
`;
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, LAUNCHER_SCRIPT: resolve("scripts/launch.ps1") },
      },
    );
    expect(output).toContain("Launcher ownership checks passed.");
  },
  30_000,
);

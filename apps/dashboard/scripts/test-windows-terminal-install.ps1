# Native smoke for a disposable Windows runner. Fetch real prerequisites and the real published CLI.
# Intercept only the last CLI handoff so a successful test cannot register a project with any dashboard.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Run in Windows PowerShell 5.1.' }
$version = '0.119.0-139'
$origin = 'https://install.example.test'
$code = 'a' * 26
$template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\src\domain\registration\install-scripts\install.ps1'))
$rendered = $template.Replace('__PTBK_VERSION__', $version).Replace('__PTBK_ORIGIN__', $origin)
function Invoke-RestMethod($Uri) {
    if ($Uri -ne "$origin/install.ps1") { throw "Unexpected script: $Uri" }
    $rendered
}
$before = [Environment]::GetEnvironmentVariable('Path', 'User')
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('ptbk test [01] & ' + [char]0x17D + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testDir) | Out-Null
try {
    $env:LOCALAPPDATA = $testDir
    $env:PATH = "$env:SystemRoot\system32;$PSHOME"
    if (Get-Command git.exe,node.exe,npm.cmd,ptbk.cmd -ErrorAction SilentlyContinue) { throw 'Expected a clean terminal.' }
    $env:PTBK_TEST_RECORD = Join-Path $testDir 'pair.json'
    $preload = Join-Path $testDir 'record-pair.cjs'
    [IO.File]::WriteAllText($preload, @'
if (require('node:path').basename(process.argv[1] || '') === 'ptbk.js' && process.argv[2] === 'init') {
    const fs = require('node:fs');
    if (process.env.PTBK_LINK || !process.argv.includes('--link-stdin')) process.exit(17);
    fs.writeFileSync(process.env.PTBK_TEST_RECORD, JSON.stringify({
        args: process.argv.slice(2), link: fs.readFileSync(0, 'utf8').trim(), cli: process.argv[1]
    }));
    process.exit(0);
}
'@)
    $env:NODE_OPTIONS = '--require="' + $preload.Replace('\', '/') + '"'
    for ($i = 0; $i -lt 2; $i++) {
        if ([IO.File]::Exists($env:PTBK_TEST_RECORD)) { [IO.File]::Delete($env:PTBK_TEST_RECORD) }
        $env:PTBK_LINK = $code; irm https://install.example.test/install.ps1 | iex
        $record = [IO.File]::ReadAllText($env:PTBK_TEST_RECORD) | ConvertFrom-Json
        if (($record.args -join ' ') -ne 'init --prepare-only --link-stdin' -or $record.link -cne "$origin/link#$code") { throw 'Incorrect handoff.' }
        $expected = Join-Path $testDir "Promptbook\terminal\cli\$version\node_modules\ptbk\bin\ptbk.js"
        if ($record.cli -ne $expected) { throw 'Used a CLI outside the selected installation.' }
        if ((& ptbk.cmd --version) -cne $version -or $LASTEXITCODE -ne 0) { throw 'Launcher version mismatch.' }
        if ((& git.exe --version) -notmatch '^git version ' -or $LASTEXITCODE -ne 0) { throw 'Git unavailable.' }
        if ((& node.exe --version) -notmatch '^v24\.' -or $LASTEXITCODE -ne 0) { throw 'Node.js unavailable.' }
    }
    $bin = Join-Path $testDir 'Promptbook\terminal\bin'
    $saved = [Environment]::GetEnvironmentVariable('Path', 'User').Split(';')
    if (@($saved | Where-Object { $_ -eq $bin }).Count -ne 1) { throw 'User PATH is missing or duplicates the launcher.' }
    Write-Host "Windows PowerShell 5.1 installed and reused the real ptbk $version and handed off the test link twice."
} finally {
    [Environment]::SetEnvironmentVariable('Path', $before, 'User')
    Remove-Item -LiteralPath $testDir -Recurse -Force -ErrorAction SilentlyContinue
}

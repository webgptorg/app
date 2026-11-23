# Promptbook for Windows x64: downloads the exact setup EXE, verifies its SHA-256, waits for its wizard and pairs the
# installed CLI.
#   $env:PTBK_LINK='<pairing code>'; irm __PTBK_ORIGIN__/install.ps1 | iex
# Served per request with the current release filled in; it carries no pairing data. Invoke-Expression parses the whole
# script block before running any of it, so a download cut short fails to parse. Errors throw instead of `exit`, which
# would close the window the person pasted into.
& {
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell 5.1 downloads the large EXE many times slower while drawing progress.
    $ProgressPreference = 'SilentlyContinue'
    $version = '__PTBK_VERSION__'
    $code = $env:PTBK_LINK
    Remove-Item -LiteralPath Env:PTBK_LINK -ErrorAction SilentlyContinue
    if ($code -cnotmatch '^[a-z2-7]{25}[aeimquy4]$') { throw 'Set PTBK_LINK to the pairing code shown in Promptbook App.' }
    $link = '__PTBK_ORIGIN__/link#' + $code
    $file = Join-Path ([IO.Path]::GetTempPath()) ('ptbk-' + [guid]::NewGuid() + '.exe')
    try {
        Invoke-WebRequest -UseBasicParsing -OutFile $file `
            -Uri "https://github.com/webgptorg/promptbook/releases/download/v$version/Promptbook-Setup-$version-windows-x64.exe"
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne '__PTBK_WINDOWS_SHA256__') { throw 'Installer checksum mismatch.' }
        $setup = Start-Process -FilePath $file -ArgumentList '/PrepareOnly=yes','/NORESTART' -Wait -PassThru
        if ($setup.ExitCode -ne 0) { throw 'Promptbook installation did not finish.' }
    } finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    $env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'), $env:Path) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
    # Always the installed executable, and never pair with a failed or stale installation.
    $cli = (Get-Command ptbk.cmd -CommandType Application -ErrorAction Stop).Source
    $installed = & $cli --version
    if ($LASTEXITCODE -ne 0 -or $installed -ne $version) { throw 'Promptbook version mismatch.' }
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
        & $cli init --prepare-only --link $link
    } else { $link | & $cli init --prepare-only --link-stdin }
    if ($LASTEXITCODE -ne 0) { throw 'Promptbook pairing failed.' }
}

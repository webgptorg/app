# Windows PowerShell 5.1 and PowerShell 7. The dashboard supplies the release, never the pairing code.
#   $env:PTBK_LINK='<pairing code>'; irm __PTBK_ORIGIN__/install.ps1 | iex
# A truncated download cannot run this enclosing script block. Throwing leaves the caller's console open.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $version = '__PTBK_VERSION__'
    $code = $env:PTBK_LINK
    Remove-Item -LiteralPath Env:PTBK_LINK -ErrorAction SilentlyContinue
    if ($code -cnotmatch '\A[a-z2-7]{25}[aeimquy4]\z') { throw 'Set PTBK_LINK to the pairing code shown in Promptbook App.' }
    $link = '__PTBK_ORIGIN__/link#' + $code
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # An x86 PowerShell on 64-bit Windows reports the native architecture in PROCESSOR_ARCHITEW6432.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    # SHA-256 from nodejs.org/dist/v24.22.3/SHASUMS256.txt and the Git for Windows v2.56.1.windows.1 release.
    switch ($arch) {
        'AMD64' {
            $nodeArch = 'x64'; $gitArch = '64-bit'
            $nodeHash = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
            $gitHash = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd'
        }
        'ARM64' {
            $nodeArch = 'arm64'; $gitArch = 'arm64'
            $nodeHash = 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14'
            $gitHash = '96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c'
        }
        default { throw 'The Windows terminal installer supports x64 and ARM64.' }
    }
    $nodeName = "node-v24.22.3-win-$nodeArch"
    $gitName = "MinGit-2.56.1-$gitArch"
    $root = Join-Path $env:LOCALAPPDATA 'Promptbook\terminal'
    $tools = Join-Path $root 'tools'
    $cliRoot = Join-Path $root 'cli'
    $bin = Join-Path $root 'bin'
    $entry = 'node_modules\ptbk\bin\ptbk.js'
    $npmEntry = 'node_modules\npm\bin\npm-cli.js'

    function Get-ProgramVersion($program, [string[]]$arguments) {
        # Redirected native stderr on Windows PowerShell must not terminate a probe of a broken tool.
        $ErrorActionPreference = 'Continue'
        try {
            $outputLines = @(& $program @arguments 2>$null)
            if ($LASTEXITCODE -eq 0 -and $outputLines.Count -eq 1) { return ([string]$outputLines[0]).Trim() }
        } catch { return }
    }

    function Test-NodeRuntime($node, $npm) {
        if (-not $node -or -not $npm -or -not [IO.File]::Exists($npm)) { return $false }
        $reported = Get-ProgramVersion $node @('--version')
        if ($reported -notmatch '^v(\d+)\.(\d+)\.\d+$') { return $false }
        $major = [int]$Matches[1]; $minor = [int]$Matches[2]
        if ($major -lt 24 -and -not ($major -eq 22 -and $minor -ge 13)) { return $false }
        return (Get-ProgramVersion $node @($npm, '--version')) -match '^[1-9]\d+\.\d+\.\d+$'
    }

    function Install-Archive($name, $url, $hash, $inner, [scriptblock]$ready) {
        $target = Join-Path $tools $name
        if ([IO.Directory]::Exists($target) -and (& $ready $target)) { return }
        Write-Host "Downloading $name..."
        $zip = Join-Path $work "$name.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash) { throw "Checksum mismatch for $name." }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $unpacked = Join-Path $work $name
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)
        if ($inner) { $unpacked = Join-Path $unpacked $inner }
        if (-not (& $ready $unpacked)) { throw "The verified $name archive did not provide working tools." }
        $previous = Join-Path $work "$name.previous"
        if ([IO.Directory]::Exists($target)) { [IO.Directory]::Move($target, $previous) }
        try { [IO.Directory]::Move($unpacked, $target) }
        catch {
            if ([IO.Directory]::Exists($previous)) { [IO.Directory]::Move($previous, $target) }
            throw
        }
    }

    function Add-PathEntries([string]$old, [string[]]$directories) {
        $sep = [IO.Path]::PathSeparator
        $existing = @($old.Split($sep) | Where-Object { $_ -and $directories -notcontains $_ })
        return (@($directories) + $existing) -join $sep
    }

    foreach ($directory in @($tools, $cliRoot, $bin)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    # Concurrent pastes, including from different Windows sessions, share the install, never the pairing link.
    $lockPath = Join-Path $root 'install.lock'
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    while ($true) {
        try {
            $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
            break
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 500
        }
    }
    $work = Join-Path $root ('.install-' + [guid]::NewGuid().ToString('N'))
    $originalPath = $env:PATH
    try {
        [IO.Directory]::CreateDirectory($work) | Out-Null
        $privateDirs = @()
        Write-Host 'Checking Git, Node.js and npm...'
        $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git -or (Get-ProgramVersion $git.Source @('--version')) -notmatch '^git version ') {
            Install-Archive $gitName "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/$gitName.zip" $gitHash '' {
                param($directory)
                (Get-ProgramVersion (Join-Path $directory 'cmd\git.exe') @('--version')) -match '^git version '
            }
            $gitDir = Join-Path (Join-Path $tools $gitName) 'cmd'
            $privateDirs += $gitDir
        } else { $gitDir = Split-Path -LiteralPath $git.Source }
        $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        $node = if ($systemNode) { $systemNode.Source }
        $npm = if ($node) { Join-Path (Split-Path -LiteralPath $node) $npmEntry }
        if ($node -and -not [IO.File]::Exists($npm)) {
            $npmShim = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($npmShim) { $npm = Join-Path (Split-Path -LiteralPath $npmShim.Source) $npmEntry }
        }
        if (-not (Test-NodeRuntime $node $npm)) {
            Install-Archive $nodeName "https://nodejs.org/dist/v24.22.3/$nodeName.zip" $nodeHash $nodeName {
                param($directory)
                Test-NodeRuntime (Join-Path $directory 'node.exe') (Join-Path $directory $npmEntry)
            }
            $nodeDir = Join-Path $tools $nodeName
            $node = Join-Path $nodeDir 'node.exe'
            $npm = Join-Path $nodeDir $npmEntry
            $privateDirs += $nodeDir
        } else { $nodeDir = Split-Path -LiteralPath $node }
        $env:PATH = Add-PathEntries $originalPath $privateDirs

        # A project can update its own CLI in place. Preserve it and install the requested version alongside it.
        $prefix = Join-Path $cliRoot $version
        while ([IO.Directory]::Exists($prefix)) {
            $cli = Join-Path $prefix $entry
            if ([IO.File]::Exists($cli) -and (Get-ProgramVersion $node @($cli, '--version')) -ceq $version) { break }
            $prefix += '.retry'
        }
        if (-not [IO.Directory]::Exists($prefix)) {
            Write-Host "Installing Promptbook $version..."
            $stage = Join-Path $work 'package'
            [IO.Directory]::CreateDirectory($stage) | Out-Null
            [IO.File]::WriteAllText((Join-Path $stage 'package.json'), '{"private":true}')
            # Invoke npm with Node so shell execution policies and cmd.exe quoting do not apply to user paths.
            & $node $npm install --global=false --save-exact --prefix $stage --registry=https://registry.npmjs.org/ --no-audit --no-fund "ptbk@$version"
            if ($LASTEXITCODE -ne 0) { throw "npm could not install ptbk@$version (exit $LASTEXITCODE)." }
            $cli = Join-Path $stage $entry
            if (-not [IO.File]::Exists($cli) -or (Get-ProgramVersion $node @($cli, '--version')) -cne $version) { throw 'Promptbook version mismatch. Pairing stopped.' }
            [IO.Directory]::Move($stage, $prefix)
        }
        $cli = Join-Path $prefix $entry
        # ASCII launchers relative to their own folder work on non-ASCII Windows profiles too.
        $launcher = Join-Path $bin 'ptbk.cmd'
        $candidate = Join-Path $work 'ptbk.cmd'
        $prefixName = [IO.Path]::GetFileName($prefix)
        $lines = @('@echo off', 'setlocal DisableDelayedExpansion')
        if ($gitDir -eq (Join-Path $tools "$gitName\cmd")) { $lines += ('set "PATH=%~dp0..\tools\{0}\cmd;%PATH%"' -f $gitName) }
        if ($nodeDir -eq (Join-Path $tools $nodeName)) { $lines += ('set "PATH=%~dp0..\tools\{0};%PATH%"' -f $nodeName) }
        $lines += ('node.exe "%~dp0..\cli\{0}\{1}" %*' -f $prefixName, $entry)
        [IO.File]::WriteAllText($candidate, ($lines -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
        if ([IO.File]::Exists($launcher)) { [IO.File]::Replace($candidate, $launcher, (Join-Path $work 'previous.cmd')) }
        else { [IO.File]::Move($candidate, $launcher) }
        $paths = @($bin) + $privateDirs
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $updated = Add-PathEntries $userPath $paths
        if ($updated -cne $userPath) { [Environment]::SetEnvironmentVariable('Path', $updated, 'User') }
        $env:PATH = Add-PathEntries $originalPath $paths
    } catch {
        $env:PATH = $originalPath
        throw
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        $lock.Dispose()
    }

    Write-Host 'Connecting the project...'
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
        & $node $cli init --prepare-only --link $link
    } else { $link | & $node $cli init --prepare-only --link-stdin }
    if ($LASTEXITCODE -ne 0) { throw "Promptbook pairing failed (exit $LASTEXITCODE)." }
}

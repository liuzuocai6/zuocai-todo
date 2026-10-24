[CmdletBinding()]
param([ValidateSet('help','test','build')][string]$Action='help')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$localRoot=Join-Path $projectRoot '.local'
$previousLocation=Get-Location
$names=@('JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_USER_HOME','GRADLE_USER_HOME','PATH','TEMP','TMP')
$old=@{};foreach($n in $names){$old[$n]=[Environment]::GetEnvironmentVariable($n,'Process')}
function Run($cmd,[string[]]$args){& $cmd @args;if($LASTEXITCODE -ne 0){throw "$cmd failed with exit code $LASTEXITCODE"}}
try {
 if($Action -eq 'help'){Write-Output 'Use .\scripts\dev.ps1 test for tests, or .\scripts\dev.ps1 build for a full Android build.';return}
 $tmp=Join-Path $localRoot 'tmp';New-Item -ItemType Directory -Path $tmp -Force|Out-Null;$env:TEMP=$tmp;$env:TMP=$tmp;Set-Location $projectRoot
 Run 'pnpm' @('run','test');Run 'pnpm' @('run','check');if($Action -eq 'test'){return}
 Run 'pnpm' @('run','build')
 $env:JAVA_HOME=Join-Path $localRoot 'tools/jdk21/jdk-21.0.4';$env:ANDROID_HOME=Join-Path $localRoot 'tools/android-sdk';$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME;$env:ANDROID_USER_HOME=Join-Path $localRoot 'android-user';$env:GRADLE_USER_HOME=Join-Path $localRoot 'cache/gradle';$env:PATH=(Join-Path $env:JAVA_HOME 'bin')+[IO.Path]::PathSeparator+$env:PATH
 if(-not(Test-Path (Join-Path $env:JAVA_HOME 'bin/java.exe'))){throw 'JDK 21 is missing.'};if(-not(Test-Path (Join-Path $env:ANDROID_USER_HOME 'debug.keystore'))){throw 'The existing signing key is missing.'}
 Run 'pnpm' @('exec','cap','sync','android');Set-Location (Join-Path $projectRoot 'android');$sdk=$env:ANDROID_HOME.Replace('\','/');[IO.File]::WriteAllText((Join-Path $PWD 'local.properties'),"sdk.dir=$sdk`n",[Text.UTF8Encoding]::new($false));Run '.\gradlew.bat' @('assembleDebug','--offline','--console','plain','--no-daemon');Write-Output ('Build complete: '+(Join-Path $projectRoot 'android/app/build/outputs/apk/debug/app-debug.apk'))
} finally {Set-Location $previousLocation;foreach($n in $names){[Environment]::SetEnvironmentVariable($n,$old[$n],'Process')}}
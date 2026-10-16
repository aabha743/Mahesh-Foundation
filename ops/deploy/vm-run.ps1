param(
    [Parameter(Mandatory = $true)][string]$Script,
    [hashtable]$Vars = @{},
    [switch]$Sudo,
    [string]$Instance = "instance-20260730-111750",
    [string]$Project = "mf-medical-equipment-seva",
    [string]$Zone = "us-central1-a"
)
# Runs one of the scripts in this folder on the production VM over gcloud:
#   ./vm-run.ps1 -Script preflight.sh -Sudo -Vars @{ RELEASE = '<full sha>'; BUNDLE_SHA256 = '<sha256>' }
# What runs: "export NAME='value'" for each -Vars entry, then lib.sh, then the script. The combined script is
# copied to ~/mes-deploy/ and run from there (gcloud.cmd goes through cmd, which cannot pass long scripts inline),
# then deleted. No secrets are involved.
$ErrorActionPreference = "Stop"
$gcloud = (Get-Command gcloud.cmd -ErrorAction SilentlyContinue).Source
if (-not $gcloud) { $gcloud = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = if (Test-Path $Script) { $Script } else { Join-Path $here $Script }

$parts = @()
foreach ($name in ($Vars.Keys | Sort-Object)) {
    $value = [string]$Vars[$name]
    if ($name -notmatch '^[A-Z_][A-Z0-9_]*$' -or $value -notmatch '^[A-Za-z0-9._:/,+=-]*$') {
        throw "Refusing variable $name : only letters, digits and ._:/,+=- are allowed in values."
    }
    $parts += "export $name='$value'"
}
$parts += Get-Content -Raw -Path (Join-Path $here "lib.sh")
$parts += Get-Content -Raw -Path $scriptPath
$text = ($parts -join "`n") -replace "`r`n", "`n"

$remoteName = "vm-run-$([IO.Path]::GetFileNameWithoutExtension($scriptPath))-$([guid]::NewGuid().ToString('N').Substring(0, 8)).sh"
$local = Join-Path ([IO.Path]::GetTempPath()) $remoteName
[IO.File]::WriteAllText($local, $text, (New-Object Text.UTF8Encoding $false))
$runner = if ($Sudo) { "sudo bash" } else { "bash" }
$noise = "Store key in cache|host key is not cached|no guarantee that the server|think it is|ssh-ed25519|If you trust this host|add the key to Plink|carry on connecting|without adding|the key to the cache|do not trust this host|abandon the|^\s*\d+\.\d+\.\d+\.\d+ \(port 22\)|^\s*SHA256:|\|\s*\d+ kB \||100%"

$ErrorActionPreference = "Continue"
try {
    # Home-relative destination: pscp does not expand "~".
    & $gcloud compute scp $local "${Instance}:mes-deploy/$remoteName" --project $Project --zone $Zone --quiet 2>&1 |
        Where-Object { $_ -notmatch $noise } | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "upload of $remoteName failed" }
    & $gcloud compute ssh $Instance --project $Project --zone $Zone --quiet --strict-host-key-checking=no `
        --command "$runner mes-deploy/$remoteName; rc=`$?; rm -f mes-deploy/$remoteName; exit `$rc" 2>&1 |
        Where-Object { $_ -notmatch $noise } | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $local -ErrorAction SilentlyContinue
}
exit $code

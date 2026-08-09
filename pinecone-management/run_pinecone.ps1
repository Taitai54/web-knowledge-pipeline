param(
    [Parameter(Mandatory=$true)]
    [string]$Folder,
    [Parameter(Mandatory=$true)]
    [string]$IndexName,
    [string]$Namespace = "",
    [string]$DocType = "",
    [string]$Tags = "",
    [switch]$DryRun,
    [switch]$NoRecursive
)

$env:PINECONE_API_KEY = [System.Environment]::GetEnvironmentVariable('PINECONE_API_KEY', 'User')
$env:PYTHONIOENCODING = 'utf-8'

$args_list = @($Folder, "--index-name", $IndexName)
if ($Namespace) { $args_list += "--namespace"; $args_list += $Namespace }
if ($DocType)   { $args_list += "--doc-type";   $args_list += $DocType }
if ($Tags)      { $args_list += "--tags";       $args_list += $Tags }
if ($DryRun)    { $args_list += "--dry-run" }
if ($NoRecursive) { $args_list += "--no-recursive" }

python "$PSScriptRoot\pinecone_bulk.py" @args_list

param(
    [parameter(Mandatory = $true)]
    $privateIpAddress,
    [parameter(Mandatory = $true)]
    $friendlyName,
    [parameter(Mandatory = $true)]
    $username,
    [parameter(Mandatory = $true)]
    $password
)

$ErrorActionPreference = "Stop"

$msdeploy = "C:\Program Files\IIS\Microsoft Web Deploy V3\msdeploy.exe"

$arguments = [string[]]@(
    "-verb:sync",
    "-allowUntrusted",
    "-source:recycleApp",
    "-dest:recycleApp=`"$friendlyName`",computerName=`"https://$($privateIpAddress):8172/msdeploy.axd?site=$friendlyName`",recycleMode=`"StopAppPool`",AuthType=`"Basic`",UserName=`"$username`",Password=`"$password`"")
    
Start-Process $msdeploy -ArgumentList $arguments -NoNewWindow -Wait
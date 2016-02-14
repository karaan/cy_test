param(
    [parameter(Mandatory = $true)]
    $serverWinRm,
    [parameter(Mandatory = $true)]
    $deploymentName,
    [parameter(Mandatory = $true)]
    $friendlyName,
    [parameter(Mandatory = $true)]
    $roleProcess_id,
    [parameter(Mandatory = $true)]
    $set_id,
    [parameter(Mandatory = $true)]
    $versionType,
    [parameter(Mandatory = $true)]
    $roleType,
    [parameter(Mandatory = $true)]
    $cyvisor,
    [parameter(Mandatory = $true)]
    $deployPassword,
    [parameter(Mandatory = $true)]
    $adminPassword,
    [parameter(Mandatory = $true)]
    $rebootRequired
)

$ErrorActionPreference = "Stop"

import-module ".\cycligent\server\configScripts\windows\shared.psm1"

$newCycligentSiteText = Get-Content "C:\cycligent\scripts\New-CycligentSite.ps1"

$argList = @($deploymentName, $friendlyName, $roleProcess_id, $set_id, $versionType, $roleType, $cyvisor, $deployPassword, $rebootRequired, $newCycligentSiteText)
Invoke-RemoteCommand $serverWinRm "MicrosoftAccount\Administrator" $adminPassword {
    param(
        [parameter(Mandatory = $true)]
        $deploymentName,
        [parameter(Mandatory = $true)]
        $friendlyName,
        [parameter(Mandatory = $true)]
        $roleProcess_id,
        [parameter(Mandatory = $true)]
        $set_id,
        [parameter(Mandatory = $true)]
        $versionType,
        [parameter(Mandatory = $true)]
        $roleType,
        [parameter(Mandatory = $true)]
        $cyvisor,
        [parameter(Mandatory = $true)]
        $deployPassword,
        [parameter(Mandatory = $true)]
        $rebootRequired,
        [parameter(Mandatory = $true)]
        $newCycligentSiteText
    )
    
    echo $newCycligentSiteText | Out-File "C:\cycligent\scripts\New-CycligentSite.ps1" -Encoding UTF8

    # We do this instead of using something like $hostname because it's possible this script will be called immediately after a rename that hasn't taken effect yet.
    $hostname = (Get-Item HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName).GetValue("ComputerName")

    $roleProcesses = [ordered]@{}
    $roleProcesses[$roleProcess_id] = @{
            "deploymentName"= "$deploymentName";
            "friendlyName"= "$friendlyName";
            "set_id" = "$set_id";
            "versionType" = "$versionType";
            "roleType" = "$roleType";
            "cyvisor" = $cyvisor;
        };

    $sitePort = 80
    foreach ($h in $roleProcesses.GetEnumerator())
    {
        $roleProcess_id = $h.Name
        $settings = $h.Value


        powershell c:\cycligent\scripts\New-CycligentSite.ps1 -deploymentUserName "deploy" -deploymentName $settings.deploymentName -roleProcess_id $roleProcess_id -set_id $settings.set_id -versionType $settings.versionType -roleType $settings.roleType -cyvisor $settings.cyvisor -siteName $settings.friendlyName -sitePhysicalPath "c:\cycligent\$($settings.friendlyName)" -siteAppPoolName "$($settings.friendlyName)" -sitePort $sitePort -dnsDomain "cmmn-cyv-01" -appPoolUserName "$hostname\deploy" -appPoolPassword $deployPassword -iisManagerUserName "$hostname\deploy" -appVirtualDirectoryPassword $deployPassword
        $sitePort++
        if ($sitePort -eq 88) # Port 88 is already taken.
        {
            $sitePort++
        }
    }

    if ($rebootRequired)
    {
        Restart-Computer
    }
} @(,$argList)
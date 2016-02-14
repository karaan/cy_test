param(
    [parameter(Mandatory = $true)]
    $serverWinRm,
    [parameter(Mandatory = $true)]
    $oldAdminPassword,
    [parameter(Mandatory = $true)]
    $adminPassword,
    [parameter(Mandatory = $true)]
    $deployPassword,
    [parameter(Mandatory = $true)]
    $wDeployAdminPassword,
    [parameter(Mandatory = $true)]
    $cyvisorAddress,
    [parameter(Mandatory = $true)]
    $newHostname,
    [parameter(Mandatory = $true)]
    $rebootRequired
)

$ErrorActionPreference = "Stop"

import-module ".\cycligent\server\configScripts\windows\shared.psm1"

$newCycligentSiteText = Get-Content "C:\cycligent\scripts\New-CycligentSite.ps1"

$argList = @($adminPassword, $deployPassword, $wDeployAdminPassword, $cyvisorAddress, $newHostname, $rebootRequired, $newCycligentSiteText)
Invoke-RemoteCommand $serverWinRm "MicrosoftAccount\Administrator" $oldAdminPassword {
    param(
        [parameter(Mandatory = $true)]
        $adminPassword,
        [parameter(Mandatory = $true)]
        $deployPassword,
        [parameter(Mandatory = $true)]
        $wDeployAdminPassword,
        [parameter(Mandatory = $true)]
        $cyvisorAddress,
        [parameter(Mandatory = $true)]
        $newHostname,
        [parameter(Mandatory = $true)]
        $rebootRequired,
        [parameter(Mandatory = $true)]
        $newCycligentSiteText
    )

    Add-Content "C:\Windows\System32\drivers\etc\hosts" "`r`n$cyvisorAddress cmmn-cyv-01" -Encoding ascii
    net user deploy $deployPassword /add /y
    net localgroup IIS_IUSRS deploy /add
    
    echo $newCycligentSiteText | Out-File "C:\cycligent\scripts\New-CycligentSite.ps1" -Encoding UTF8

    # Update the WDeployAdmin password for IIS
    $inetsrvPath = ${env:windir} + "\system32\inetsrv\"
    [System.Reflection.Assembly]::LoadFrom( $inetsrvPath + "Microsoft.Web.Administration.dll" ) > $null
    [System.Reflection.Assembly]::LoadFrom( $inetsrvPath + "Microsoft.Web.Management.dll" )   > $null
    $serverManager = (New-Object Microsoft.Web.Administration.ServerManager)

    $rules = $serverManager.GetAdministrationConfiguration().GetSection("system.webServer/management/delegation").GetCollection()
    $rulesIndex = 0;
    $ruleCurrent = $rules[$rulesIndex]
    while ($ruleCurrent -ne $null)
    {
        if ($ruleCurrent.GetAttribute("providers").Value -eq "recycleApp")
        {
            break;
        }
        $rulesIndex++;
        $ruleCurrent = $rules[$rulesIndex]
    }
    $runAs = $ruleCurrent.GetChildElement("runAs")
    $runAs.SetAttributeValue("identityType", 3);
    $runAs.SetAttributeValue("userName", "WDeployAdmin")
    $runAs.SetAttributeValue("password", $wDeployAdminPassword)

    $serverManager.CommitChanges();
    ([adsi]"WinNT://$($env:COMPUTERNAME)/WDeployAdmin").SetPassword($wDeployAdminPassword)

    ([adsi]"WinNT://$($env:COMPUTERNAME)/Administrator").SetPassword($adminPassword)

    Rename-Computer "$newHostname"

    if ($rebootRequired)
    {
        Restart-Computer
    }
} @(,$argList)
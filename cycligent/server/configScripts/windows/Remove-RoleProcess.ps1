param(
    [parameter(Mandatory = $true)]
    $serverWinRm,
    [parameter(Mandatory = $true)]
    $friendlyName,
    [parameter(Mandatory = $true)]
    $adminPassword
)

$ErrorActionPreference = "Stop"

import-module ".\cycligent\server\configScripts\windows\shared.psm1"

$argList = @($friendlyName)
Invoke-RemoteCommand $serverWinRm "MicrosoftAccount\Administrator" $adminPassword {
    param(
        [parameter(Mandatory = $true)]
        $friendlyName
    )

    $inetsrvPath = ${env:windir} + "\system32\inetsrv\"

    [System.Reflection.Assembly]::LoadFrom( $inetsrvPath + "Microsoft.Web.Administration.dll" ) > $null
    [System.Reflection.Assembly]::LoadFrom( $inetsrvPath + "Microsoft.Web.Management.dll" )   > $null

    $serverManager = (New-Object Microsoft.Web.Administration.ServerManager)

    $serverManager.Sites[$friendlyName].Delete()
    $serverManager.ApplicationPools[$friendlyName].Delete()

    $serverManager.CommitChanges()

    # Remove-Item -Recurse -Force "C:\cycligent\$friendlyName"
    # Using rd instead of Remove-Item because for some reason Remove-Item was choking on links created by mklink.
    cmd /c "rd /s /q `"C:\cycligent\$friendlyName`""
} @(,$argList)
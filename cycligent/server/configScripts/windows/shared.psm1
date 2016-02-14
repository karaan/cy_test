function New-Credential(
	[Parameter(Mandatory=$true)][string] $userName,
	[Parameter(Mandatory=$true)][string] $passwordPlain
){

	$passwordSecure = ConvertTo-SecureString $passwordPlain -AsPlainText -Force 
	$credential = New-Object System.Management.Automation.PSCredential -ArgumentList $userName,$passwordSecure
	
	return $credential
}

Function Invoke-RemoteCommand
{
    [CmdletBinding()]
    Param(
    [Parameter(Mandatory=$true)][string] $uri,
    [Parameter(Mandatory=$true)][string] $username,
    [Parameter(Mandatory=$true)][string] $password,
    [Parameter(Mandatory=$true)][ScriptBlock] $scriptBlock,
    [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]] $argumentList
    )
    process {
        $credential = New-Credential $username $password
        Invoke-Command -ConnectionUri $uri.ToString() -Credential $credential -ScriptBlock $scriptBlock -ArgumentList $argumentList[0]
    }
}
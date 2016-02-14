var url = require('url');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var child_process = require('child_process');

var agent = require('../agent.js');
var cyvisor = require('../cyvisor.js');
var hypervisor = require("./hypervisor.js");
var hypervisorProductionCommonAws = require('./hypervisorProductionCommonAws.js');
var config = require('../configProcess.js');

var AWS = require('aws-sdk');
AWS.config.update({region: "us-west-2"});
//noinspection JSUnresolvedFunction
var ec2 = new AWS.EC2();
//noinspection JSUnresolvedFunction
var elb = new AWS.ELB();
//noinspection JSUnresolvedFunction
var rds = new AWS.RDS();

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
    hypervisorProductionCommonAws.roleProcessesCollectionSet(roleProcesses, sets);
};

var instanceIdsCollection;
exports.instanceIdsCollectionSet = function(collection){
    instanceIdsCollection = collection;
    hypervisorProductionCommonAws.instanceIdsCollectionSet(collection);
};

var cycligentDb;
exports.cycligentDbSet = function(db){
    cycligentDb = db;
    hypervisorProductionCommonAws.cycligentDbSet(db);
};

function action(state, data, callback){

    // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
    switch(data.action) {
        // ===== MACHINE-LEVEL ACTIONS =====

        case "Create machine":
            hypervisorProductionCommonAws.createMachine(state, data, callback);
            break;

        case "Delete machine":      // Machine may actually be responsive, but will no longer be probed so we don't have to worry about race conditions
            hypervisorProductionCommonAws.deleteMachine(state, data, callback);
            break;

        case "Shut down machine":
            hypervisorProductionCommonAws.shutdownMachine(state, data, callback);
            break;

        case "Start machine":
            hypervisorProductionCommonAws.startMachine(state, data, callback);
            break;

        case "Restart machine":
            hypervisorProductionCommonAws.restartMachine(state, data, callback);
            break;

        case "Resize machine":
            hypervisorProductionCommonAws.resizeMachine(state, data, callback);
            break;

        // ===== ROLE-INSTANCE-LEVEL ACTIONS =====

        case "Create role process":
            createRoleProcess(state, data, callback);
            break;

        case "Delete role process":
            deleteRoleProcess(state, data, callback);
            break;

        case "Start role process":
            startApp(state, data, callback);
            break;

        case "Stop role process":
            stopApp(state, data, callback);
            break;

        case "Restart role process":
            restartApp(state, data, callback);
            break;
    }

}
exports.action = action;

function restartApp(state, data, callback){
    stopStartOrRestartApp("restartApp", state, data, callback);
}

function startApp(state, data, callback){
    stopStartOrRestartApp("startApp", state, data, callback);
}

function stopApp(state, data, callback){
    stopStartOrRestartApp("stopApp", state, data, callback);
}

function stopStartOrRestartApp(what, state, data, callback) {
    var script;
    if (what == "stopApp") {
        script = "./cycligent/server/configScripts/windows/Stop-AppPool.ps1";
    } else if (what == "startApp") {
        script = "./cycligent/server/configScripts/windows/Start-AppPool.ps1";
    } else if (what == "restartApp") {
        script = "./cycligent/server/configScripts/windows/Recycle-AppPool.ps1";
    } else {
        state.target.status = "error";
        state.target.error = "stopStartOrRestartApp: Unknown choice '" + what + "'.";
        callback();
        return;
    }

    hypervisorProductionCommonAws.roleProcessDocFindWithAwsInstanceId(what, state, data, callback, function(roleProcessDoc, machineDoc) {

        //noinspection JSUnresolvedFunction
        ec2.describeInstances({
            InstanceIds: [machineDoc.awsInstanceId]
        }, function(err, data) {
            if (err) {
                console.error(what + ": An error occurred while trying to get instance status information from AWS. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = what + ": An error occurred while trying to get instance status information " +
                    "from AWS. Error message was: " + err.message;
                callback();
                return;
            }

            //noinspection JSUnresolvedVariable
            var instanceData = data.Reservations[0].Instances[0];
            //noinspection JSUnresolvedVariable
            var privateIpAddress = instanceData.PrivateIpAddress;

            powershellHelper([script,
                "-privateIpAddress", privateIpAddress,
                "-friendlyName", roleProcessDoc.friendlyName,
                "-username", 'deploy',
                "-password", machineDoc.users['deploy']
            ], function(errorDetected, powershellOutput) {
                if (errorDetected) {
                    console.error(what + ": Error occurred while running powershell script.");
                    console.error("Powershell output:");
                    console.error(powershellOutput);
                    state.target.status = "error";
                    state.target.error = what + ": An error occurred while trying to stop the app.";
                    state.target.powershellOutput = powershellOutput;
                    callback();
                    return;
                }

                state.target.status = "success";
                callback();
            });
        });
    });
}

exports.probeSql = hypervisorProductionCommonAws.probeSql;
exports.probeMongo = hypervisorProductionCommonAws.probeMongo;

function configureMachine(machineDoc, setDoc, callback) {
    if (setDoc.machineSpec.serviceType == "ec2") {
        //noinspection JSUnresolvedFunction
        ec2.describeInstanceStatus({
            IncludeAllInstances: true,
            InstanceIds: [machineDoc.awsInstanceId]
        }, function (err, data) {
            if (err) {
                console.error("An error occurred while trying to get instance status information from AWS. Error was:");
                console.error(err);
                callback();
                return;
            }

            //noinspection JSUnresolvedVariable
            var instanceStatus = data.InstanceStatuses[0];
            //noinspection JSUnresolvedVariable
            if (instanceStatus.InstanceState.Name == "running"
                && instanceStatus.SystemStatus.Status == "ok"
                && instanceStatus.InstanceStatus.Status == "ok") {

                ec2ConfigureMachine(machineDoc, setDoc, callback);
            } else {
                callback();
            }
        });
    } else if (setDoc.machineSpec.serviceType == "rds") {
        hypervisorProductionCommonAws.rdsConfigureMachine(machineDoc, callback);
    } else {
        callback();
    }
}
exports.configureMachine = configureMachine;

function ec2ConfigureMachine(machineDoc, setDoc, callback) {
    //noinspection JSUnresolvedFunction
    ec2.describeInstances({
        InstanceIds: [machineDoc.awsInstanceId]
    }, function(err, data) {
        if (err) {
            console.error("ec2ConfigureMachine: An error occurred while trying to get instance status information from AWS. Error was:");
            console.error(err);
            callback();
            return;
        }

        hypervisorProductionCommonAws.passwordGenerate(30, function(err, adminPassword) {
            if (err) {
                console.error("ec2ConfigureMachine: An error occurred while trying to generate a password. Error was:");
                console.error(err);
                callback();
                return;
            }

            hypervisorProductionCommonAws.passwordGenerate(30, function(err, wDeployAdminPassword) {
                if (err) {
                    console.error("ec2ConfigureMachine: An error occurred while trying to generate a password. Error was:");
                    console.error(err);
                    callback();
                    return;
                }

                hypervisorProductionCommonAws.passwordGenerate(11, function(err, hostname) {
                    if (err) {
                        console.error("ec2ConfigureMachine: An error occurred while trying to generate a hostname. Error was:");
                        console.error(err);
                        callback();
                        return;
                    }

                    hostname = "cyc-" + hostname.toLowerCase();

                    setsCollection.findOne({_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62")}, {
                        fields: {
                            "machines": {$slice: 1},
                            "machines.users.deploy": 1
                        }
                    }, function(err, cyvisorDoc) {
                        if (err) {
                            console.error("ec2ConfigureMachine: An error occurred while trying to find the deploy password. Error was:");
                            console.error(err);
                            callback();
                            return;
                        }

                        cyvisorDoc = cyvisorDoc.machines[0];

                        if (!cyvisorDoc.users.deploy) {
                            console.error("configureMachine2: Could not find the deploy password.");
                            callback();
                            return;
                        }


                        var roleSpec = setDoc.roleSpec.versionedRoles.concat(setDoc.roleSpec.otherRoles)[0];

                        var deployPassword = cyvisorDoc.users.deploy;
                        //noinspection JSUnresolvedVariable
                        var instanceData = data.Reservations[0].Instances[0];
                        var cyvisorAddress = agent.networkAddressesGet()[0].address;
                        //noinspection JSUnresolvedVariable
                        powershellHelper(["./cycligent/server/configScripts/windows/Configure-ProductionWebServerInstance.ps1",
                            "-serverWinRm", "http://" + instanceData.PrivateIpAddress + ":5985",
                            "-oldAdminPassword", "BzCtH?@WNP6",
                            "-adminPassword", adminPassword,
                            "-deployPassword", deployPassword,
                            "-wDeployAdminPassword", wDeployAdminPassword,
                            "-cyvisorAddress", cyvisorAddress,
                            "-newHostname", hostname,
                            "-rebootRequired", (roleSpec == undefined)?"$true":"$false"
                        ], function(errorDetected, powershellOutput) {

                            if (errorDetected) {
                                errorDbUpdate(powershellOutput);
                                return;
                            }

                            if (roleSpec) {
                                var commonCreateData = {
                                    friendlyName: roleSpec.friendlyName,
                                    roleSpec_id: roleSpec._id,
                                    machine_id: machineDoc._id,
                                    set_id: setDoc._id,
                                    roleType: roleSpec.roleType,
                                    versionType: roleSpec.versionType,
                                    size: setDoc.machineSpec.size,
                                    urls: machineDoc.urls
                                };

                                hypervisor.commonCreate(null, commonCreateData, function() {
                                    errorDbUpdate();
                                }, function() {
                                    createRoleProcessPowershell(
                                        "http://" + instanceData.PrivateIpAddress + ":5985",
                                        roleSpec.friendlyName,
                                        commonCreateData.roleProcess_id,
                                        setDoc._id,
                                        roleSpec.versionType,
                                        roleSpec.roleType,
                                        deployPassword,
                                        adminPassword,
                                        true,
                                        function(powershellErrorOutput) {

                                            if (powershellErrorOutput) {
                                                errorDbUpdate(powershellErrorOutput);
                                            } else if (roleSpec.roleType == "web") {
                                                hypervisorProductionCommonAws.ec2ConfigureWebServerWithLoadBalancer(machineDoc, function(err) {
                                                    if (err) {
                                                        console.error("ec2ConfigureMachine: An error occurred while trying to configure the machine " +
                                                            "with the load balancer. Error message was: " + err.message);
                                                        callback();
                                                    } else {
                                                        finalDbUpdate(adminPassword, deployPassword, hostname);
                                                    }
                                                });
                                            } else {
                                                finalDbUpdate(adminPassword, deployPassword, hostname);
                                            }
                                        });
                                });
                            } else {
                                finalDbUpdate(adminPassword, deployPassword, hostname);
                            }
                        });
                    });
                });
            });
        });
    });

    function errorDbUpdate(powershellOutput) {
        if (powershellOutput) {
            console.error("ec2ConfigureMachine: Error occurred while running powershell script.");
            console.error("Powershell output:");
            console.error(powershellOutput);
        }

        setsCollection.updateOne({"machines._id": machineDoc._id}, {
            $set: {
                "machines.$.status.needsConfiguration": false,
                "machines.$.status.major": "Unresponsive",
                "machines.$.status.minor": "Configuration error",
                "machines.$.status.modAt": new Date(),
                modAt: new Date()
            },
            $inc: {
                modVersion: 1
            }
        }, function(err) {
            if (err) {
                console.error("ec2ConfigureMachine: An error occurred while trying to update server data. " +
                    "Error message was: " + err.message);
                callback();
            } else {
                callback();
            }
        });
    }

    function finalDbUpdate(adminPassword, deployPassword, hostname) {
        setsCollection.updateOne({"machines._id": machineDoc._id}, {
            $set: {
                "machines.$.status.major": "Online",
                "machines.$.status.minor": "Healthy",
                "machines.$.status.needsConfiguration": false,
                "machines.$.users" : {
                    "Administrator": adminPassword,
                    "deploy": deployPassword
                },
                "machines.$.hostname": hostname,
                "machines.$.status.modAt": new Date(),
                modAt: new Date()
            },
            $inc: {
                modVersion: 1
            }
        }, function(err) {
            if (err) {
                console.error("ec2ConfigureMachine: An error occurred while trying to update server data. " +
                "Error message was: " + err.message);
                callback();
            } else {
                callback();
            }
        });
    }
}

function createRoleProcess(state, data, callback){
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "createRoleProcess: machine_id was malformed.";
        callback();
        return;
    }

    hypervisorProductionCommonAws.machineDocAndInstanceInfoFind(
        "createRoleProcess", state, data, callback, function(machineDoc, instanceData) {
            data.urls = machineDoc.urls;

            hypervisor.commonCreate(state, data, callback, function(){
                if (data.roleType == "sql") {
                    state.target.status = "error";
                    state.target.error = "createRoleProcess: Cannot create the role process for an RDS set.";
                    callback();
                } else {
                    createRoleProcessPowershell(
                        "http://" + instanceData.PrivateIpAddress + ":5985",
                        data.friendlyName,
                        data.roleProcess_id,
                        data.set_id,
                        data.versionType,
                        data.roleType,
                        machineDoc.users["deploy"],
                        machineDoc.users["Administrator"],
                        false,
                        function(powershellErrorOutput) {
                            if (powershellErrorOutput) {
                                console.error("createRoleProcess: Error occurred while running powershell script.");
                                console.error("powershell output:");
                                console.error(powershellErrorOutput);
                                state.target.status = "error";
                                state.target.error = "createRoleProcess: An error occurred while trying to create the role process.";
                                state.target.powershellOutput = powershellErrorOutput;
                                callback();
                                return;
                            }

                            if (data.roleType != "web") {
                                state.target.status = "success";
                                callback();
                                return;
                            }

                            hypervisorProductionCommonAws.ec2ConfigureWebServerWithLoadBalancer(machineDoc, function(err) {
                                if (err) {
                                    console.error("createRoleProcess: An error occurred while trying to configure the machine " +
                                        "with the load balancer. Error message was: " + err.message);
                                    callback();
                                } else {
                                    state.target.status = "success";
                                    callback();
                                }
                            });
                        }
                    );
                }
            });
        });
}

function createRoleProcessPowershell(serverWinRm, friendlyName, roleProcess_id, set_id, versionType, roleType,
                                      deployPassword, adminPassword, rebootRequired, callback) {
    powershellHelper(["./cycligent/server/configScripts/windows/Configure-NewRoleProcess.ps1",
        "-serverWinRm", serverWinRm,

        "-deploymentName", config.deploymentName,
        "-friendlyName", friendlyName,
        "-roleProcess_id", roleProcess_id,
        "-set_id", set_id,
        "-versionType", versionType,
        "-roleType", roleType,
        "-cyvisor", (roleType == "cyvisor"? "$true" : "$false"),

        "-deployPassword", deployPassword,
        "-adminPassword", adminPassword,

        "-rebootRequired", (rebootRequired? "$true" : "$false")
    ], function(errorDetected, powershellOutput) {
        if (errorDetected) {
            callback(powershellOutput);
        } else {
            callback(null);
        }
    });
}

function deleteRoleProcess(state, data, callback) {
    roleProcessesCollection.findOne({
        roleSpec_id: data.roleSpec_id,
        machine_id: data.machine_id
    }, function(err, roleProcess) {
        if (roleProcess.roleType == "sql") {
            state.target.status = "error";
            state.target.error = "deleteRoleProcess: Cannot remove the role process for an RDS set.";
            callback();
        } else {
            hypervisorProductionCommonAws.machineDocAndInstanceInfoFind(
                "deleteRoleProcess", state, data, callback, function(machineDoc, instanceData) {

                    powershellHelper(["./cycligent/server/configScripts/windows/Remove-RoleProcess.ps1",
                        "-serverWinRm", "http://" + instanceData.PrivateIpAddress + ":5985",
                        "-friendlyName", roleProcess.friendlyName,
                        "-adminPassword", machineDoc.users["Administrator"]
                    ], function(errorDetected, powershellOutput) {
                        if (errorDetected) {
                            console.error("deleteRoleProcess: Error occurred while running powershell script.");
                            console.error("powershell output:");
                            console.error(powershellOutput);
                            state.target.status = "error";
                            state.target.error = "deleteRoleProcess: An error occurred while trying to remove the role process.";
                            state.target.powershellOutput = powershellOutput;
                            callback();
                            return;
                        }

                        roleProcessesCollection.remove({_id: roleProcess._id}, function(err) {
                            if (err) {
                                state.target.status = "error";
                                state.target.error = "deleteRoleProcess: A database error occurred while trying to remove the role process.";
                                callback();
                                return;
                            }

                            if (roleProcess.roleType != "web") {
                                state.target.status = "success";
                                callback();
                                return;
                            }

                            hypervisorProductionCommonAws.ec2DeregisterWebServerFromLoadBalancer(machineDoc, function(err) {
                                if (err) {
                                    state.target.status = "error";
                                    state.target.error = "deleteRoleProcess: An EC2 error occurred while trying to " +
                                        "remove the role process from the load balancer.";
                                    callback();
                                    return;
                                }

                                state.target.status = "success";
                                callback();
                            });
                        });
                    });
                });
        }
    });
}

/**
 * A helper function for spawning powershell scripts as child processes.
 *
 * @param {String[]} args
 * @param {Function} done
 */
function powershellHelper(args, done) {
    args.splice(0, 0, "-NonInteractive", "-ExecutionPolicy", "RemoteSigned");
    //noinspection JSUnresolvedFunction
    var child = child_process.spawn("powershell", args);
    var stdoutData = "";
    var stderrData = "";
    var allData = "";
    var detectedError = false;
    child.stdout.on('data', function(data) {
        data = data.toString();
        stdoutData += data;
        allData += data;
    });
    child.stderr.on('data', function(data) {
        data = data.toString();
        stderrData += data;
        allData += data;
        detectedError = true;
    });
    child.on('close', function() {
        if (allData.toLowerCase().indexOf("error") != -1) {
            detectedError = true;
        }

        done(detectedError, allData, stdoutData, stderrData);
    });
}
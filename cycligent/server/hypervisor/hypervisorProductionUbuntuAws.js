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
            startRoleProcess(state, data, callback);
            break;

        case "Stop role process":
            stopRoleProcess(state, data, callback);
            break;

        case "Restart role process":
            restartRoleProcess(state, data, callback);
            break;
    }
}
exports.action = action;

function restartRoleProcess(state, data, callback){
    stopStartOrRestartRoleProcess("restartRoleProcess", state, data, callback);
}

function startRoleProcess(state, data, callback){
    stopStartOrRestartRoleProcess("startRoleProcess", state, data, callback);
}

function stopRoleProcess(state, data, callback){
    stopStartOrRestartRoleProcess("stopRoleProcess", state, data, callback);
}

function stopStartOrRestartRoleProcess(what, state, data, callback) {
    var script;
    if (what == "stopRoleProcess") {
        script = "./cycligent/server/configScripts/ubuntu/Stop-RoleProcess.bash";
    } else if (what == "startRoleProcess") {
        script = "./cycligent/server/configScripts/ubuntu/Start-RoleProcess.bash";
    } else if (what == "restartRoleProcess") {
        script = "./cycligent/server/configScripts/ubuntu/Recycle-RoleProcess.bash";
    } else {
        state.target.status = "error";
        state.target.error = "stopStartOrRestartRoleProcess: Unknown choice '" + what + "'.";
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

            bashHelper([script,
                privateIpAddress, // IP_ADDRESS
                'ubuntu', // USERNAME
                roleProcessDoc.friendlyName, // FRIENDLY_NAME
                machineDoc.users['ubuntu'] // PRIVATE_KEY
            ], function(errorDetected, bashOutput) {
                if (errorDetected) {
                    console.error(what + ": Error occurred while running bash script.");
                    console.error("bash output:");
                    console.error(bashOutput);
                    state.target.status = "error";
                    state.target.error = what + ": An error occurred while trying to stop the app.";
                    state.target.bashOutput = bashOutput;
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

        setsCollection.findOne({_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62")}, {
            fields: {
                "machines": {$slice: 1},
                "machines.users.samba": 1,
                "machines.newMachineKey": 1
            }
        }, function(err, cyvisorDoc) {
            if (err) {
                console.error("ec2ConfigureMachine: An error occurred while trying to find the deploy password. Error was:");
                console.error(err);
                callback();
                return;
            }

            cyvisorDoc = cyvisorDoc.machines[0];

            if (!cyvisorDoc.users.samba) {
                console.error("configureMachine2: Could not find the samba password.");
                callback();
                return;
            }

            var sambaPassword = cyvisorDoc.users.samba;
            //noinspection JSUnresolvedVariable
            var instanceData = data.Reservations[0].Instances[0];
            var cyvisorAddress = agent.networkAddressesGet()[0].address;
            //noinspection JSUnresolvedVariable
            bashHelper(["./cycligent/server/configScripts/ubuntu/Configure-ProductionWebServerInstance.bash",
                instanceData.PrivateIpAddress, // NEW_SERVER_IP_ADDRESS
                "ubuntu", // USERNAME
                cyvisorAddress, // CYVISOR_PUBLIC_DNS
                sambaPassword, // CYVISOR_SAMBA_PASSWORD
                cyvisorDoc.newMachineKey.material // PRIVATE_KEY
            ], function(errorDetected, bashOutput) {
                if (errorDetected) {
                    errorDbUpdate(bashOutput);
                    return;
                }

                var results = /-----BEGIN RSA PRIVATE KEY-----[\s\S]+-----END RSA PRIVATE KEY-----/m.exec(bashOutput);

                if (!results) {
                    console.error("ec2ConfigureMachine: Unable to parse private key of new machine.");
                    callback();
                    return;
                }
                var privateKey = results[0];

                var roleSpec = setDoc.roleSpec.versionedRoles.concat(setDoc.roleSpec.otherRoles)[0];
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
                        createRoleProcessBash(
                            instanceData.PrivateIpAddress,
                            roleSpec.friendlyName,
                            commonCreateData.roleProcess_id,
                            setDoc._id,
                            roleSpec.versionType,
                            roleSpec.roleType,
                            privateKey,
                            function(bashErrorOutput) {
                                if (bashErrorOutput) {
                                    errorDbUpdate(bashErrorOutput);
                                } else if (roleSpec.roleType == "web") {
                                    hypervisorProductionCommonAws.ec2ConfigureWebServerWithLoadBalancer(machineDoc, function(err) {
                                        if (err) {
                                            console.error("ec2ConfigureMachine: An error occurred while trying to configure the machine " +
                                                "with the load balancer. Error message was: " + err.message);
                                            callback();
                                        } else {
                                            finalDbUpdate(privateKey, sambaPassword);
                                        }
                                    });
                                } else {
                                    finalDbUpdate(privateKey, sambaPassword);
                                }
                            });
                    });
                } else {
                    finalDbUpdate(privateKey, sambaPassword);
                }
            });
        });
    });

    function errorDbUpdate(bashOutput) {
        if (bashOutput) {
            console.error("ec2ConfigureMachine: Error occurred while running bash script.");
            console.error("bash output:");
            console.error(bashOutput);
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

    function finalDbUpdate(privateKey, sambaPassword) {
        setsCollection.updateOne({"machines._id": machineDoc._id}, {
            $set: {
                "machines.$.status.major": "Online",
                "machines.$.status.minor": "Healthy",
                "machines.$.status.needsConfiguration": false,
                "machines.$.users" : {
                    "ubuntu": privateKey,
                    "samba": sambaPassword
                },
                "machines.$.status.modAt": new Date(),
                modAt: new Date()
            },
            $inc: {
                modVersion: 1
            }
        }, function(err) {
            if (err) {
                console.error("ec2ConfigureMachine: An error occurred while trying to update machine data. " +
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
                    createRoleProcessBash(
                        instanceData.PrivateIpAddress, // NEW_SERVER_IP_ADDRESS
                        data.friendlyName, // NEW_SERVER_FRIENDLY_NAME
                        data.roleProcess_id, // NEW_SERVER_UNFRIENDLY_NAME
                        data.set_id, // SET_NAME
                        data.versionType, // VERSION_TYPE
                        data.roleType, // ROLE
                        machineDoc.users.ubuntu,
                        function(bashErrorOutput) {
                            if (bashErrorOutput) {
                                console.error("createRoleProcess: Error occurred while running bash script.");
                                console.error("bash output:");
                                console.error(bashErrorOutput);
                                state.target.status = "error";
                                state.target.error = "createRoleProcess: An error occurred while trying to create the role process.";
                                state.target.bashOutput = bashErrorOutput;
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

function createRoleProcessBash(privateIpAddress, friendlyName, unfriendlyName, set_id, versionType, roleType, privateKey, callback) {
    bashHelper(["./cycligent/server/configScripts/ubuntu/Configure-NewRoleProcess.bash",
        privateIpAddress, // NEW_SERVER_IP_ADDRESS
        "ubuntu", // USERNAME
        config.deploymentName, // DEPLOYMENT_NAME
        friendlyName, // FRIENDLY_NAME
        unfriendlyName, // ROLE_PROCESS_ID
        set_id, // SET_ID
        versionType, // VERSION_TYPE
        roleType, // ROLE_TYPE
        (roleType == "cyvisor"? "true" : "false"), // IS_CYVISOR
        privateKey
    ], function(errorDetected, bashOutput) {
        if (errorDetected) {
            callback(bashOutput);
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

                    bashHelper(["./cycligent/server/configScripts/ubuntu/Remove-RoleProcess.bash",
                        instanceData.PrivateIpAddress, // SERVER_IP_ADDRESS
                        "ubuntu", // USERNAME
                        roleProcess.friendlyName, // NEW_SERVER_FRIENDLY_NAME
                        machineDoc.users.ubuntu // PRIVATE_KEY
                    ], function(errorDetected, bashOutput) {
                        if (errorDetected) {
                            console.error("deleteRoleProcess: Error occurred while running bash script.");
                            console.error("bash output:");
                            console.error(bashOutput);
                            state.target.status = "error";
                            state.target.error = "deleteRoleProcess: An error occurred while trying to remove the role process.";
                            state.target.bashOutput = bashOutput;
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
 * A helper function for spawning bash scripts as child processes.
 *
 * @param {String[]} args
 * @param {Function} done
 */
function bashHelper(args, done) {
    //noinspection JSUnresolvedFunction
    var child = child_process.spawn("bash", args);
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
        //detectedError = true;
    });
    child.on('close', function() {
        if (allData.toLowerCase().indexOf("error") != -1) {
            detectedError = true;
        }

        done(detectedError, allData, stdoutData, stderrData);
    });
}
var url = require('url');
var http = require('http');
var https = require('https');

var cyvisor = require('./../cyvisor.js');
var hypervisor = require("./hypervisor.js");
var config = require('./../configProcess.js');
var hypervisorDemoCommonAws = require('./hypervisorDemoCommonAws.js');

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
    hypervisorDemoCommonAws.roleProcessesCollectionSet(roleProcesses, sets);
};

function action(state, data, callback){

    // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
    switch(data.action) {

        // ===== MACHINE-LEVEL ACTIONS =====

        case "Create machine":
            createMachine(state, data, callback);
            break;

        case "Delete machine":      // Machine may actually be responsive, but will no longer be probed so we don't have to worry about race conditions
            deleteMachine(state, data, callback);
            break;

        case "Shut down machine":
            state.target.status = "error";
            state.target.error = "Machines cannot be shut down in the demo!";
            callback();
            break;

        case "Start machine":
            hypervisorDemoCommonAws.startMachine(state, data, callback);
            break;

        case "Restart machine":
            restartMachine(state, data, callback);
            break;

        case "Resize machine":
            hypervisorDemoCommonAws.resizeMachine(state, data, callback);
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

        // Stop role process is handled through Cycligent Agent.
        //case "Stop role process":
            //break;

        case "Restart role process":
            restartRoleProcess(state, data, callback);
            break;
    }

}
exports.action = action;

function createMachine(state, data, callback) {
    setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "createMachine: An error occurred while trying to access the database.";
            callback();
            return;
        }

        if (!setDoc) {
            state.target.status = "error";
            state.target.error = "createMachine: No such set found.";
            callback();
            return;
        }

        if (setDoc.machineSpec.serviceType == "rds") {
            hypervisorDemoCommonAws.demoSubscriptionSQLServerAdd(state, "rds:" + setDoc.machineSpec.engine, function() {
                if (state.target.status != "success") {
                    callback();
                } else {
                    setsCollection.updateOne({_id: data.set_id}, {
                        $push: {
                            machines: {
                                _id: new state.mongodb.ObjectID(),
                                status: {
                                    major: "Online",
                                    minor: "Healthy",
                                    needsConfiguration: false,
                                    modAt: new Date()
                                }
                            }
                        },
                        $set: {
                            modAt: new Date()
                        },
                        $inc: {
                            modVersion: 1
                        }
                    }, function(err) {
                        if (err) {
                            state.target.status = "error";
                            state.target.error = "createMachine: An error occurred while trying to update machine data. " +
                                "Error message was: " + err.message;
                            callback();
                        } else {
                            cyvisor.environmentInfoUpdate();
                            state.target.status = "success";
                            callback();
                        }
                    });
                }
            });
        } else {
            state.target.status = "error";
            state.target.error = "Machines cannot be created in the demo!";
            callback();
        }
    });
}

function deleteMachine(state, data, callback) {
    setsCollection.findOne({"machines._id": data.machine_id}, function(err, setDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "deleteMachine: An error occurred while trying to access the database.";
            callback();
            return;
        }

        if (!setDoc) {
            state.target.status = "error";
            state.target.error = "deleteMachine: No set containing that machine found.";
            callback();
            return;
        }

        if (setDoc.machineSpec.serviceType == "rds") {
            hypervisorDemoCommonAws.demoSubscriptionSQLServerDelete(state, function() {
                if (state.target.status != "success") {
                    callback();
                } else {
                    setsCollection.updateOne({_id: data.set_id}, {
                        $pull: {
                            "machines": {_id: data.machine_id}
                        }
                    }, function(err) {
                        if (err) {
                            state.target.status = "error";
                            state.target.error = "deleteMachine: A database error occurred when trying to remove the machine.";
                            callback();
                            return;
                        }

                        cyvisor.environmentInfoUpdate();
                        state.target.status = "success";
                        callback();
                    });
                }
            });
        } else {
            state.target.status = "error";
            state.target.error = "deleteMachine: Machines cannot be deleted in the demo!";
            callback();
        }
    });
}

function deleteRoleProcess(state, data, callback){
    roleProcessesCollection.findOne({
        machine_id: data.machine_id,
        roleSpec_id: data.roleSpec_id
    }, function(err, roleProcessDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "deleteRoleProcess: Error accessing the database.";
            callback();
            return;
        }

        if (roleProcessDoc == null) {
            state.target.status = "error";
            state.target.error = "deleteRoleProcess: No role process doc found.";
            callback();
            return;
        }

        data.roleProcess_id = roleProcessDoc._id;

        if (!roleProcessDoc.friendlyName) {
            state.target.status = "error";
            state.target.error = "deleteRoleProcess: No friendlyName defined for the role process.";
            callback();
            return;
        }

        // Send command to Ec2 trial deployment admin process
        var req = http.get("http://127.0.0.1:9876/delete?name=" + roleProcessDoc.friendlyName, function(res) {

            var output = "";

            res.on('data', function(chunk) {
                output += chunk.toString();
            });

            res.on('end', function() {
                hypervisorDemoCommonAws.roleProcessRemoveFromDb(state, data, output, callback);
            });
        });

        req.on('error', function(e) {
            new Error(e.message);
            state.target.status = "error";
            state.target.error = e.message;
            callback();
        });
    });
}

function restartRoleProcess(state, data, callback){
    roleProcessesCollection.findOne({_id: data.roleProcess_id}, function(err, roleProcessDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "restartRoleProcess: Error accessing the database.";
            callback();
            return;
        }

        if (!roleProcessDoc) {
            state.target.status = "error";
            state.target.error = "restartRoleProcess: Could not find the specified role process.";
            callback();
            return;
        }

        if (!roleProcessDoc.friendlyName) {
            state.target.status = "error";
            state.target.error = "restartRoleProcess: No friendlyName defined for the role process.";
            callback();
            return;
        }

        // Send command to Ec2 trial deployment admin process
        var req = http.get("http://127.0.0.1:9876/appPoolRestart?name=" + roleProcessDoc.friendlyName, function(res) {
            var output = "";
            res.on('data', function(chunk) {
                output += chunk.toString();
            });
            res.on('end', function() {
                state.target.status = "success";
                state.target.message = output;
                callback();
            });
        });
        req.on('error', function(e) {
            state.target.status = "error";
            state.target.error = e.message;
            callback();
        });
    });
}

function restartMachine(state, data, callback){
    setsCollection.findOne({"machines._id": data.machine_id}, function(err, setDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "restartMachine: An error occurred while trying to access the database.";
            callback();
            return;
        }

        if (!setDoc) {
            state.target.status = "error";
            state.target.error = "restartMachine: No set containing that machine found.";
            callback();
            return;
        }

        if (setDoc.machineSpec.serviceType == "rds") {
            hypervisorDemoCommonAws.demoSubscriptionSQLServerRestart(state, callback);
        } else {
            var req = http.get("http://127.0.0.1:9876/restart", function(res) {
                var output = "";
                res.on('data', function(chunk) {
                    output += chunk.toString();
                });
                res.on('end', function() {
                    state.target.status = "success";
                    state.target.message = output;
                    callback();
                });
            });
            req.on('error', function(e) {
                state.target.status = "error";
                state.target.error = e.message;
                callback();
            });
        }
    });
}

function startRoleProcess(state, data, callback){
    roleProcessesCollection.findOne({_id: data.roleProcess_id}, function(err, roleProcessDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "startRoleProcess: Error accessing the database.";
            callback();
            return;
        }

        if (!roleProcessDoc.friendlyName) {
            state.target.status = "error";
            state.target.error = "startRoleProcess: No friendlyName defined for the role process.";
            callback();
            return;
        }

        // Send command to Ec2 trial deployment admin process
        var req = http.get("http://127.0.0.1:9876/start?name=" + roleProcessDoc.friendlyName, function(res) {

            var output = "";

            res.on('data', function(chunk) {
                output += chunk.toString();
            });

            res.on('end', function() {
                state.target.status = "success";
                state.target.message = output;
                callback();
            });
        });

        req.on('error', function(e) {
            state.target.status = "error";
            state.target.error = e.message;
            callback();

        });
    });
}

function createRoleProcess(state, data, callback) {

    if (data.roleType == "sql") {
        state.target.status = "error";
        state.target.error = "createRoleProcess: Cannot create a role process for a SQL server.";
        callback();
        return;
    }

    hypervisor.commonCreate(state, data, callback, function(){

        // Send command to Ec2 trial deployment admin process
        var deploymentName = config.deploymentName;
        var roleProcess_id = data.roleProcess_id;
        var friendlyName = data.friendlyName;
        var set_id = data.set_id;
        var roleType = data.roleType;
        var versionType = data.versionType;
        var url = "http://127.0.0.1:9876/create?deploymentName=" + deploymentName +
            "&roleProcess_id=" + roleProcess_id + "&friendlyName=" + friendlyName +
            "&set_id=" + set_id + "&roleType=" + roleType + "&versionType=" + versionType;

        if (data.cyvisor) {
            url += "&cyvisor=" + data.cyvisor;
        }

        var req = http.get(url, function(res) {

            var output = "";
            res.on('data', function(chunk) {
                output += chunk.toString();
            });
            res.on('end', function() {
                cyvisor.environmentInfoUpdate();
                callback(null, output);
            });
        });

        req.on('error', function(e) {
            callback(new Error(e.message));
        });
    });
}

var agent = require("./../agent.js");
var cyvisor = require("./../cyvisor.js");
var hypervisor = require("./hypervisor.js");
var child_process = require('child_process');

var config = require('../configProcess.js');

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
};

function action(state, data, callback) {

    // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
    switch(data.action) {
        // ===== MACHINE-LEVEL ACTIONS =====

        case "Create machine":
            createMachine(state, data, callback);
            break;

        case "Delete machine":
            deleteMachine(state, data, callback);
            break;

        case "Shut down machine":
            shutdownMachine(state, data, callback);
            break;

        case "Start machine":
            startMachine(state, data, callback);
            break;

        case "Restart machine":
            restartMachine(state, data, callback);
            break;

        case "Resize machine": //- Doesn't happen for a local deployment!
            state.target.status = "error";
            state.target.error = "Machines cannot be resized in the local deployment!";
            callback();
            break;

        // ===== ROLE-INSTANCE-LEVEL ACTIONS =====

        case "Create role process":
            createRoleProcess(state, data, callback);
            break;

        case "Delete role process":
            data.removeDocOnStop = true;
            data.specifcRoleSpec_id = data.roleSpec_id;
            stopRoleProcessesForMachine(state, data, callback);
            break;

        case "Start role process":
            spawn(state, data, callback);
            break;

        case "Stop role process":
            stopRoleProcess(state, data, callback);
            break;

        case "Restart role process":
            restartApp(state, data, callback);
            break;
    }

}
exports.action = action;

function createMachine(state, data, callback) {
    var machine_id = new state.mongodb.ObjectID();
    setsCollection.updateOne({_id: data.set_id}, {
        $push: {
            machines: {
                _id: machine_id,
                status: {
                    major: "Pending",
                    minor: "Create machine",
                    needsConfiguration: true,
                    modAt: new Date()
                }
            }
        }
    }, function(err) {
        if (err) {
            state.target.status = "error";
            state.target.error = "createMachine: A database occurred when trying to add a machine.";
            callback();
            return;
        }

        setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "createMachine: A database occurred when trying to add a machine.";
                callback();
                return;
            }

            var roleSpecs = setDoc.roleSpec.versionedRoles.concat(setDoc.roleSpec.otherRoles);

            function roleProcessShiftAndGo() {
                var roleSpec = roleSpecs.shift();

                if (!roleSpec) {
                    state.target.status = "success";
                    state.target.machine_id = machine_id;
                    callback();
                    return;
                }

                if (['mongo', 'sql', 'dir'].indexOf(roleSpec.roleType) != -1) {
                    roleProcessShiftAndGo();
                    return;
                }

                createRoleProcess(state, {
                    friendlyName: roleSpec.friendlyName,
                    roleSpec_id: roleSpec._id,
                    machine_id: machine_id,
                    set_id: setDoc._id,
                    roleType: roleSpec.roleType,
                    versionType: roleSpec.versionType
                }, function() {
                    if (state.target.status != "success") {
                        callback();
                    } else {
                        roleProcessShiftAndGo();
                    }
                });
            }

            roleProcessShiftAndGo();
        });
    });
}

function deleteMachine(state, data, callback) {
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "deleteMachine: machine_id was malformed.";
        callback();
        return;
    }

    data.removeDocOnStop = true;
    stopRoleProcessesForMachine(state, data, function() {
        if (state.target.status != "success") {
            callback();
            return;
        }

        setsCollection.updateOne({_id: data.set_id}, {
            $pull: {
                "machines": {_id: data.machine_id}
            }
        }, function(err) {
            if (err) {
                state.target.status = "error";
                state.target.error = "deleteMachine: A database occurred when trying to remove a machine.";
                callback();
                return;
            }

            state.target.status = "success";
            callback();
        });
    });
}

function stopRoleProcessesForMachine(state, data, callback) {
    roleProcessesCollection.find({machine_id: data.machine_id}).toArray(function(err, roleProcesses) {
        if (err) {
            state.target.status = "error";
            state.target.error = "stopRoleProcessesForMachine: A database occurred when trying to stop a role process.";
            callback();
            return;
        }

        function roleProcessShiftAndGo() {
            var roleProcess = roleProcesses.shift();

            if (!roleProcess) {
                state.target.status = "success";
                callback();
                return;
            }

            if (data.specifcRoleSpec_id && !data.specifcRoleSpec_id.equals(roleProcess.roleSpec_id)) {
                roleProcessShiftAndGo();
                return;
            }

            stopRoleProcess(state, {
                roleProcess_id: roleProcess._id,
                machine_id: roleProcess.machine_id,
                set_id: roleProcess.set_id,
                roleType: roleProcess.roleType,
                versionType: roleProcess.versionType,
                removeDocOnStop: data.removeDocOnStop
            }, function() {
                if (state.target.status != "success") {
                    callback();
                } else {
                    roleProcessShiftAndGo();
                }
            });
        }

        roleProcessShiftAndGo();
    });
}

function startAllRoleProcessesForMachine(state, data, callback) {
    roleProcessesCollection.find({machine_id: data.machine_id}).toArray(function(err, roleProcesses) {
        if (err) {
            state.target.status = "error";
            state.target.error = "startAllRoleProcessesForMachine: A database occurred when trying to start a role process.";
            callback();
            return;
        }

        function roleProcessShiftAndGo() {
            var roleProcess = roleProcesses.shift();

            if (!roleProcess) {
                state.target.status = "success";
                callback();
                return;
            }

            spawn(state, {
                roleProcess_id: roleProcess._id,
                machine_id: roleProcess.machine_id,
                set_id: roleProcess.set_id,
                roleType: roleProcess.roleType,
                versionType: roleProcess.versionType
            }, function() {
                if (state.target.status != "success") {
                    callback();
                } else {
                    roleProcessShiftAndGo();
                }
            });
        }

        roleProcessShiftAndGo();
    });
}

function shutdownMachine(state, data, callback) {
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "shutdownMachine: machine_id was malformed.";
        callback();
        return;
    }

    setsCollection.updateOne({
        _id: data.set_id,
        "machines._id": data.machine_id
    }, {
        $set: {
            "machines.$.status.major": "Pending",
            "machines.$.status.minor": "Shut down machine"
        }
    }, function(err) {
        if (err) {
            state.target.status = "error";
            state.target.error = "shutdownMachine: A database occurred when trying to shut down a machine.";
            callback();
        } else {
            stopRoleProcessesForMachine(state, data, callback);
        }
    });
}

function startMachine(state, data, callback) {
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "startMachine: machine_id was malformed.";
        callback();
        return;
    }

    startAllRoleProcessesForMachine(state, data, function() {
        if (state.target.status != "success") {
            callback();
            return;
        }

        setsCollection.updateOne({
            _id: data.set_id,
            "machines._id": data.machine_id
        }, {
            $set: {
                "machines.$.status.major": "Online",
                "machines.$.status.minor": "Healthy"
            }
        }, function(err) {
            if (err) {
                state.target.status = "error";
                state.target.error = "startMachine: A database occurred when trying to shut down a machine.";
                callback();
            } else {
                state.target.status = "success";
                callback();
            }
        });
    });
}

function configureMachine(machineDoc, setDoc, callback) {
    setsCollection.updateOne({
        "machines._id": machineDoc._id
    }, {
        $set: {
            "machines.$.status.major": "Online",
            "machines.$.status.minor": "Healthy",
            "machines.$.status.needsConfiguration": false,
            "machines.$.status.modAt": new Date()
        }
    }, function(err) {
        if (err) {
            console.error("configureMachine: Database error occurred while updating database:");
            console.error(err);
            callback();
        } else {
            callback();
        }
    });
}
exports.configureMachine = configureMachine;

function createRoleProcess(state, data, callback){
    hypervisor.commonCreate(state, data, callback, function(){
        if (data.roleType == "sql") {
            cyvisor.demoHasSQLServerSet(data.type);
            state.target.status = "success";
            callback();
        } else {
            spawn(state, data, callback);
        }
    });
}

function stopRoleProcess(state, data, callback){
    data.action = "Stop role process";

    if (data.roleType == "sql") {
        cyvisor.demoHasSQLServerSet(null);
        state.target.status = "success";
        callback();
    } else {
        cyvisor.agentActionSend(state.request.headers.cookie, data, function (err, response) {
            if (err
                && err.code != "noUrlsFound"
                && err.message.indexOf("ECONNREFUSED") == -1
                && err.message.indexOf("ETIMEDOUT") == -1) { // Ignore failed connections, it means it's already dead.
                state.target.status = "error";
                state.target.error = err.message;
                callback();
            } else {

                if (data.removeDocOnStop) {
                    roleProcessesCollection.removeOne({_id: data.roleProcess_id}, function (err) {
                        if (err) {
                            state.target.status = "error";
                            state.target.error = "An error occurred when trying to remove the role process from the 'roleProcesses' collection.";
                            callback();
                        } else {
                            state.target.status = "success";
                            state.target.reponse = response;
                            callback();
                        }
                    });
                } else {
                    state.target.status = "success";
                    state.target.reponse = response;
                    callback();
                }
            }
        });
    }
}

function restartApp(state, data, callback){

    data.action = "Stop role process";

    cyvisor.agentActionSend(state.request.headers.cookie, data, function (err) {

        if (err && err.message.indexOf("ECONNREFUSED") == -1 && err.message.indexOf("ETIMEDOUT") == -1) { // Ignore failed connections, it means it's already dead.

            state.target.status = "error";
            state.target.error = err.message;
            callback();

        } else {

            data.action = "Start role process";

            // Wait to see the machine go unresponsive
            var PROBE_INTERVAL = agent.probeIntervalGet();
            var triesLeft = 1000 * 60 * 3 / PROBE_INTERVAL;

            var interval = setInterval(function () {

                if (--triesLeft < 0) {
                    clearInterval(interval);
                    callback(new Error("Restart app: app did not stop."));
                }

                cyvisor.machineStatus(data.roleProcess_id, function (err, doc) {
                    if (err) {
                        clearInterval(interval);
                        callback(err);
                    } else {
                        if (doc.major == "Unresponsive") {

                            // App is down so bring it back up!
                            clearInterval(interval);
                            spawn(state, data, callback);
                        }
                    }

                });

            }, PROBE_INTERVAL);

        }
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

        if (setDoc.machineSpec.serviceType == "rds") {
            state.target.status = "success";
            callback();
        } else {
            stopRoleProcessesForMachine(state, data, function() {
                if (state.target.status != "success") {
                    callback();
                    return;
                }

                startAllRoleProcessesForMachine(state, data, callback);
            });
        }
    });
}

function spawn(state, data, callback) {
    var env = JSON.parse(JSON.stringify(process.env));
    env["PORT"] = "0";
    var args = ['server.js', config.deploymentName, data.roleProcess_id, '-debug'];

    var child = child_process.spawn(process.argv[0], args, {
        env: env,
        detached: true
    });
    child.unref();
    child.on('error', function(err) {
        state.target.status = "error";
        state.target.error = "Spawning the server failed with the error: " + err.message;
        child.removeListener("error", earlyExitListener);
        clearListenersAndCallback();
    });
    child.stdout.on('data', function(chunk) {
        chunk = chunk.toString();
        if (chunk.indexOf("CYCLIGENT SERVER READY") != -1) {
            state.target.status = "success";
            child.removeListener("error", earlyExitListener);
            clearListenersAndCallback();
        }
    });
    var stderr = "";
    child.stderr.on('data', function(chunk) {
        stderr += chunk.toString();
    });
    child.on('exit', earlyExitListener);
    function earlyExitListener() {
        state.target.status = "error";
        state.target.error = "The spawned server exited before starting up fully. stderr was: " + stderr;
        clearListenersAndCallback();
    }

    function clearListenersAndCallback() {
        child.removeAllListeners();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        //TODO: 2. Error messages are not getting back to cloud control!
        callback();
    }
}


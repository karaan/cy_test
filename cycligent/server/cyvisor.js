var config;
var authorize = require('./authorize.js');
var hypervisor = require("./hypervisor/hypervisor.js");
var cycligentMongo = require('./cycligentMongo');
var users = require('./users.js');
var State = require('./state.js');
var crypto = require("crypto");
var https = require('https');
var http = require("http");
var path = require("path");
var url = require("url");
var fs = require('fs');

var AWS = require('aws-sdk');
AWS.config.update({region: "us-west-2"});
var ec2 = new AWS.EC2();
var elb = new AWS.ELB();
var rds = new AWS.RDS();

var roleProcessesCollection = null;
var setsCollection = null;
var versionTypesCollection = null;
var instanceIdsCollection = null;
var demoHasSQLServer = null;
var instanceId = null;
var accountStatus;
var deploymentLastCompletedDate = null;
var machinesConfiguring = {};

exports.demoHasSQLServerSet = function(newVal) {
    demoHasSQLServer = newVal;
};

exports.accountStatusGet = function() {
    return accountStatus;
};

function configSet(configArg){
    config = configArg;
    hypervisor.configSet(config);
    if (config.isCyvisor) {
        setInterval(function() {
            certificatesFetch();
        }, 1000 * 60 * 60);

        if (config.deploymentName != "minimal" && config.deploymentName != "local") {
            var metadataService = new AWS.MetadataService();
            metadataService.request('/2014-11-05/meta-data/instance-id', function(err, data) {
                if (err) {
                    console.error("An error occurred while trying to find the AWS instance ID:");
                    console.error(err);
                } else {
                    instanceId = data;
                }

                certificatesFetch();
                deploymentLastCompletedDateFetch();
                accountCheck(function() {
                    hypervisor.accountChecked(accountStatus);
                });
            });
        } else {
            accountStatus = "trial";
            hypervisor.accountChecked(accountStatus);
        }
    }
}
exports.configSet = configSet;

function roleProcessDbSet(db) {
    db.collection('roleProcesses',function(err, collectionArg){
        if(err){ throw err; }
        roleProcessesCollection = collectionArg;

        // TODO: 1. Tyler - This likely needs to gain it's own function (think about it, maybe rename):
        db.collection('sets', function(err, collectionArg) {
            if(err){ throw err; }
            setsCollection = collectionArg;

            hypervisor.roleProcessesCollectionSet(roleProcessesCollection, setsCollection);
            hypervisor.cycligentDbSet(db);
        });

        // TODO: 1. Tyler - This likely needs to gain it's own function (think about it, maybe rename):
        db.collection('versionTypes', function(err, collectionArg) {
            if(err) { throw err; }

            versionTypesCollection = collectionArg;
        });
    });
}
exports.roleProcessDbSet = roleProcessDbSet;

function instanceIdsDBSet(db) {
    db.collection('instanceIds',function(err, collectionArg){
        if(err){ throw err; }
        instanceIdsCollection = collectionArg;
        hypervisor.instanceIdsCollectionSet(instanceIdsCollection);
    });
}
exports.instanceIdsDBSet = instanceIdsDBSet;

function joinedSubscription(state) {
    certificatesFetch(function(err) {
        if (err) {
            state.response.writeHead(500, {'Content-Type': 'text/plain'});
            state.response.end("error");
        } else {
            state.response.writeHead(200, {'Content-Type': 'text/plain'});
            state.response.end("success");
        }
    });
}
exports.joinedSubscription = joinedSubscription;

var rollingRestartProgressData = {};
function deploymentCompleted(state) {
    deploymentLastCompletedDateFetch(function(err, deploymentLastCompleted) {
        if (err) {
            state.response.writeHead(500, {'Content-Type': 'text/plain'});
            state.response.end("error");
        } else {
            state.response.writeHead(200, {'Content-Type': 'text/plain'});
            if (deploymentLastCompleted
                && deploymentLastCompleted.date != null
                && deploymentLastCompletedDate < deploymentLastCompleted.date) {
                deploymentLastCompletedDate = deploymentLastCompleted.date;
            } else {
                state.response.end("success");
                return;
            }

            crypto.randomBytes(32, function(err, randomBytes) {
                if (err) {
                    state.response.writeHead(500, {'Content-Type': 'text/plain'});
                    state.response.end("error");
                    return;
                }

                var token = randomBytes.toString('hex');
                var progressData = {};
                rollingRestartProgressData[token] = progressData;
                state.response.writeHead(200, {'Content-Type': 'text/plain'});
                state.response.end("success\n" + token);

                var roleTypes;
                if (deploymentLastCompleted.cyvisorAffected) {
                    roleTypes = ['cyvisor'];
                    // TODO: 5. Revisit this for redundant cyvisors.
                    // This is a workaround to get the cyvisor to recycle after it gets updated,
                    // currently if it tries to recycle itself the normal way, msdeploy returns
                    // ERROR_EXCEEDED_MAX_SITE_CONNECTIONS. We will want to revisit this code when
                    // we have redudant cyvisors.
                    process.exit(0);
                    return;
                } else {
                    roleTypes = ["web", "worker", "longWorker"];
                }

                roleProcessesCollection.find({
                    versionType: {$in: deploymentLastCompleted.versionTypesAffected},
                    roleType: {$in: roleTypes}
                }).toArray(function(err, roleProcessDocs) {
                    if (err) {
                        console.error("deploymentCompleted: There was an error accessing the database. Error was:");
                        console.error(err);
                        return;
                    }

                    roleProcessDocs = roleProcessDocs.filter(function(roleProcessDoc) {
                        statusNormalize(roleProcessDoc);
                        return (roleProcessDoc.status.major == "Online" && roleProcessDoc.status.minor == "Healthy");
                    });

                    var roleProcessRollingRestartGroups = {};
                    for (var i = 0; i < roleProcessDocs.length; i++) {
                        var roleProcess = roleProcessDocs[i];
                        var groupNum = roleProcess.friendlyName.split('-');
                        groupNum = parseInt(groupNum[groupNum.length-1]);
                        if (isNaN(groupNum)) {
                            groupNum = 1;
                        }
                        if (!roleProcessRollingRestartGroups[groupNum]) {
                            roleProcessRollingRestartGroups[groupNum] = [];
                        }
                        roleProcessRollingRestartGroups[groupNum].push(roleProcess);
                        progressData[roleProcess._id] = "waiting";
                    }

                    var groupNums = Object.keys(roleProcessRollingRestartGroups).sort();
                    rollingRestart(state, roleProcessRollingRestartGroups, groupNums, progressData);
                })
            });
        }
    });
}
exports.deploymentCompleted = deploymentCompleted;

function rollingRestart(state, roleProcessRollingRestartGroups, groupNums, progressData) {
    var groupNum = groupNums.shift();
    if (groupNum === undefined) {
        return;
    }

    var roleProcesses = roleProcessRollingRestartGroups[groupNum];
    var waitingFor = roleProcesses.length;
    var sawWebRouter = false;
    for (var i = 0; i < roleProcesses.length; i++) {
        var roleProcess = roleProcesses[i];
        progressData[roleProcess._id] = "in-progress";
        var newState = new State(config, state.request, state.response, state.parsedUrl, state.pathName);
        if (roleProcess.roleType == "web") {
            sawWebRouter = true;
        }
        (function(roleProcess, newState) {
            roleProcessesCollection.updateOne({_id: roleProcess._id},
                {$set: {
                    "status.setByCyvisor": true,
                    "status.major": "Pending",
                    "status.minor": "Restart role process"
                }}, function(error){
                    if (error) {
                        console.error("rollingRestart: A database error occurred. Error was:");
                        console.error(error);
                    }

                    machineWillTransitionThroughUnresponsiveAction(newState, {
                        roleProcess_id: roleProcess._id,
                        set_id: roleProcess.set_id,
                        roleType: roleProcess.roleType,
                        action: "Restart role process"
                    }, function() {
                        waitingFor--;

                        if (newState.target.status != "success") {
                            console.error("rollingRestart: Encountered non-success status during rolling restart of " + roleProcess._id + ". state.target was:");
                            console.error(newState.target);
                            progressData[roleProcess._id] = "error";
                        } else {
                            progressData[roleProcess._id] = "success";
                        }

                        if (waitingFor == 0) {
                            //noinspection JSReferencingMutableVariableFromClosure
                            if (sawWebRouter && groupNum == 1) {
                                // Make sure we give the load balancer time to recognize the web server is back online
                                // before recycling the other ones (otherwise the load balancer will start returning 503
                                // because it thinks all instances are down):
                                setTimeout(function() {
                                    rollingRestart(state, roleProcessRollingRestartGroups, groupNums, progressData);
                                }, 24 * 1000);
                            } else {
                                rollingRestart(state, roleProcessRollingRestartGroups, groupNums, progressData);
                            }
                        }
                    });
                });
        })(roleProcess, newState);
    }
}

function rollingRestartStatus(state) {
    if (!state.post.token) {
        state.response.writeHead(500, {'Content-Type': 'application/json'});
        state.response.end(JSON.stringify({error: "rollingRestartStatus: Expected token."}));
        return;
    }

    if (!rollingRestartProgressData[state.post.token]) {
        state.response.writeHead(500, {'Content-Type': 'application/json'});
        state.response.end(JSON.stringify({error: "rollingRestartStatus: Invalid token."}));
    } else {
        state.response.writeHead(200, {'Content-Type': 'application/json'});
        state.response.end(JSON.stringify(rollingRestartProgressData[state.post.token]));
    }
}
exports.rollingRestartStatus = rollingRestartStatus;

function fakeRoleProcessesGetBySetId(ids) {
    var roleProcesses = [];
    if (ids.indexOf("mongoSet") != -1) {
        roleProcesses.push({
            _id: new config.mongodb.ObjectID("559d9e4359a680437cd0a918"),
            friendlyName: "common-mongo-01",
            roleSpec_id: new config.mongodb.ObjectID("559d526259a680437cd0a913"),
            set_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62"),
            machine_id: new config.mongodb.ObjectID("55863ae9c7c5ae4056fe615b"),
            size: "m3.medium",
            roleType: 'mongo'
        });
    }
    if (ids.indexOf("dirSet") != -1) {
        roleProcesses.push({
            _id: new config.mongodb.ObjectID("559d9e5159a680437cd0a919"),
            friendlyName: "common-dir-01",
            roleSpec_id: new config.mongodb.ObjectID("559d526859a680437cd0a914"),
            set_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62"),
            machine_id: new config.mongodb.ObjectID("55863ae9c7c5ae4056fe615b"),
            size: "t2.micro",
            roleType: 'dir'
        });
    }
    if (ids.indexOf("sqlSet") != -1) {
        roleProcesses.push({
            _id: new config.mongodb.ObjectID("559d9e6659a680437cd0a91a"),
            friendlyName: "common-sql-01",
            roleSpec_id: new config.mongodb.ObjectID("559d527a59a680437cd0a915"),
            set_id: new config.mongodb.ObjectID("559587a159ddac18f6923948"),
            machine_id: new config.mongodb.ObjectID("559586bb59ddac18f6923947"),
            size: "db.m3.medium",
            roleType: 'sql'
        });
    }
    return roleProcesses;
}

function cycligentAgentFetchSetList(callback) {
    setsCollection.find({}).toArray(function(err, results) {
        if (err) {
            callback(err);
        } else {
            callback(null, results);
        }
    });
}

function cycligentAgentFetchRoleProcessList(callback) {
    roleProcessesCollection.find({}).toArray(function(err, results) {
        if (err) {
            callback(err);
        } else {
            callback(null, results);
        }
    });
}
exports.cycligentAgentFetchRoleProcessList = cycligentAgentFetchRoleProcessList;

function instancesIdsFetch(callback) {
    instanceIdsCollection.find({}).toArray(function(err, results) {
        if (err) {
            callback(err);
        } else {
            callback(null, results);
        }
    });
}

function instanceIdsInsert(instanceIds) {
    instanceIdsCollection.insertMany(instanceIds, function(err) {
        if (err) {
            console.error("instanceIdsInsert: An MongoDB error occurred while inserting some instanceIds:");
            console.error(err);
        }
    });
}

function environmentInfoUpdate() {
    cycligentAgentFetchRoleProcessList(function(err, roleProcesses) {
        if (err) {
            console.error("environmentInfoUpdate: Error occurred while trying to get the list of role processes.");
            console.error(err);
            return;
        }

        cycligentAgentFetchSetList(function(err, sets) {
            if (err) {
                console.error("environmentInfoUpdate: Error occurred while trying to get the list of sets.");
                console.error(err);
                return;
            }

            instancesIdsFetch(function(err, instanceIds) {
                if (err) {
                    console.error("environmentInfoUpdate: Error occurred while trying to get the list of instance ids.");
                    console.error(err);
                    return;
                }

                var byAwsInstanceId = {};
                instanceIds.map(function(info) {
                    byAwsInstanceId[info._id] = info;
                });
                var instanceIdsToAdd = [];

                var roleProcessesToSend = [];
                for (var i = 0; i < roleProcesses.length; i++) {
                    var roleProcess = roleProcesses[i];

                    // Restore if we ever add a role process for the load balancer:
                    /*if (roleProcess.roleType == "loadBalancer") {
                        continue;
                    }*/

                    var roleProcessToSend = {
                        roleProcess_id: roleProcess._id,
                        friendlyName: roleProcess.friendlyName,
                        roleSpec_id: roleProcess.roleSpec_id,
                        set_id: roleProcess.set_id,
                        versionType: roleProcess.versionType,
                        roleType: roleProcess.roleType,
                        cyvisor: false
                    };

                    roleProcessesToSend.push(roleProcessToSend);
                }

                var setsToSend = [];

                for (i = 0; i < sets.length; i++) {
                    var setDoc = sets[i];

                    // Might want to make sure we don't send the loadBalancer instanceIds either...
                    if (setDoc.roleSpec.otherRoles[0]
                        && setDoc.roleSpec.otherRoles[0].roleType == "loadBalancer") {
                        continue;
                    }

                    for (var j = 0; j < setDoc.machines.length; j++) {
                        var machine = setDoc.machines[j];

                        if (machine.awsInstanceId && !byAwsInstanceId[machine.awsInstanceId]) {
                            var instanceIdToAdd = {
                                "_id": machine.awsInstanceId,
                                "machineSpec": setDoc.machineSpec,
                                "modAt": new Date(),
                                "modVersion": 0
                            };

                            instanceIdsToAdd.push(instanceIdToAdd);
                            instanceIds.push(instanceIdToAdd);
                        }
                    }

                    setsToSend.push({
                        _id: setDoc._id,
                        title: setDoc.title,
                        roleSpec: setDoc.roleSpec,
                        machineSpec: setDoc.machineSpec
                    });
                }

                if (instanceIdsToAdd.length > 0) {
                    instanceIdsInsert(instanceIdsToAdd);
                }

                environmentInfoUpdateSendRequest(roleProcessesToSend, setsToSend, instanceIds);
            });
        });
    });
}
exports.environmentInfoUpdate = environmentInfoUpdate;

function environmentInfoUpdateSendRequest(roleProcesses, sets, instanceIds) {
    var postData = JSON.stringify({
        roleProcesses: roleProcesses,
        sets: sets,
        instanceIds: instanceIds,
        instanceId: instanceId
    });

    var postOptions = url.parse("https://www.cycligent.com/account/environmentInfoUpdate");
    //var postOptions = url.parse("http://localhost:1337/account/environmentInfoUpdate");
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "environmentInfoUpdateSendRequest: Server returned non-success status code: " + response.statusCode;
        }
        var data = '';
        response.on('data', function(chunk) {
            data += chunk;
        }).on('end', function() {
            try {
                data = JSON.parse(data);
                for (var i = 0; i < data.length; i++) {
                    var datum = data[i];
                    if (datum.target == "cycligentCall") {
                        status = datum.status;
                        error = datum.error;
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "environmentInfoUpdateSendRequest: Unable to parse the response from www.cycligent.com.";
                }
            }

            if (error || status != "success") {
                console.error("environmentInfoUpdateSendRequest: An error occurred:");
                console.error(error);
                console.error(data);
            } else {
                console.error("environmentInfoUpdateSendRequest: Successfully updated the build server's list of servers to deploy to.");
            }
        });
    });

    req.on('error', function(e) {
        console.error("environmentInfoUpdateSendRequest: Error connecting to www.cycligent.com:");
        console.error(e);
    });

    req.end(postData);
}

function deploymentLastCompletedDateFetch(callback) {
    if (config.deploymentName == "minimal" || config.deploymentName == "local") {
        return;
    }

    var origCallback = callback;
    var calledBack = false;
    callback = function(err, dataWeWant) {
        if (origCallback) {
            calledBack = true;
            origCallback(err, dataWeWant);
        }
    };

    var postOptions = url.parse("https://www.cycligent.com/account/cyvisorDeploymentLastCompletedFetch");
    //var postOptions = url.parse("http://localhost:1337/account/cyvisorDeploymentLastCompletedFetch");
    var sendingData = JSON.stringify({instanceId: instanceId});
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': sendingData.length
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "deploymentCompletedDateFetch: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
        response.on('data', function(chunk) {
            responseData += chunk;
        }).on('end', function() {
            try {
                responseData = JSON.parse(responseData);
                var dataWeWant;
                for (var i = 0; i < responseData.length; i++) {
                    var datum = responseData[i];
                    if (datum.target == "cycligentCall") {
                        status = datum.status;
                        error = datum.error;
                        dataWeWant = datum;
                        break;
                    }
                }
            } catch (e) {
                if (!error) {
                    status = "error";
                    error = "deploymentCompletedDateFetch: Unable to parse the response from www.cycligent.com.";
                }
            }

            if (!dataWeWant) {
                error = "deploymentCompletedDateFetch: No cycligentCall data returned from www.cycligent.com";
            }

            if (error || status != "success") {
                console.error("deploymentCompletedDateFetch: An error occurred:");
                console.error(error);
                console.error(responseData);
                callback(new Error(error));
            } else {
                if (dataWeWant.deploymentLastCompleted
                    && dataWeWant.deploymentLastCompleted.date) {
                    dataWeWant.deploymentLastCompleted.date = new Date(dataWeWant.deploymentLastCompleted.date);

                    if (!origCallback) {
                        deploymentLastCompletedDate = dataWeWant.deploymentLastCompleted.date;
                    }
                }

                callback(null, dataWeWant.deploymentLastCompleted);
            }
        });
    });

    req.on('error', function(e) {
        console.error("deploymentCompletedDateFetch: Error connecting to www.cycligent.com:");
        console.error(e);
        callback(e);
    });

    req.end(sendingData);
}

function certificatesFetch(callback) {
    if (config.deploymentName == "minimal" || config.deploymentName == "local") {
        return;
    }

    var origCallback = callback;
    var calledBack = false;
    callback = function(err) {
        if (origCallback) {
            calledBack = true;
            origCallback(err);
        }
    };

    var postOptions = url.parse("https://www.cycligent.com/account/cyvisorCertificatesFetch");
    //var postOptions = url.parse("http://localhost:1337/account/cyvisorCertificatesFetch");
    var sendingData = JSON.stringify({instanceId: instanceId});
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': sendingData.length
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "certificatesFetch: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
        response.on('data', function(chunk) {
            responseData += chunk;
        }).on('end', function() {
            try {
                responseData = JSON.parse(responseData);
                var dataWeWant;
                for (var i = 0; i < responseData.length; i++) {
                    var datum = responseData[i];
                    if (datum.target == "cycligentCall") {
                        status = datum.status;
                        error = datum.error;
                        dataWeWant = datum;
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "certificatesFetch: Unable to parse the response from www.cycligent.com.";
                }
            }

            if (error || status != "success") {
                console.error("certificatesFetch: An error occurred:");
                console.error(error);
                console.error(responseData);
                callback(new Error(error));
            } else {
                var root = config.roots['cycligent'];
                var sessionDb;
                for(var dbIndex in root.dbs){
                    if (root.dbs.hasOwnProperty(dbIndex)) {
                        if(root.dbs[dbIndex]['authenticatedUser']){
                            if(root.dbs[dbIndex].sessionDb){
                                sessionDb = config.dbs[root.dbs[dbIndex]['authenticatedUser']].db;
                            }
                        }
                    }
                }
                if (dataWeWant.certificates.length == 0) {
                    console.error("certificatesFetch: Received no certificates.");
                    callback(null);
                    return;
                }
                if (!sessionDb) {
                    console.error("certificatesFetch: Could not find a sessionDb to put the certificates into.");
                    callback(new Error("certificatesFetch: Could not find a sessionDb to put the certificates into."));
                    return;
                }
                sessionDb.collection('certificates', function(err, certificatesCollection){
                    if (err) {
                        console.error("certificatesFetch: Error occurred while getting the certificates collection.");
                        console.error(err);
                        callback(err);
                        return;
                    }

                    sessionDb.collection('users', function(err, usersCollection) {
                        if (err) {
                            console.error("certificatesFetch: Error occurred while getting the users collection.");
                            console.error(err);
                            callback(err);
                            return;
                        }

                        var waitingFor = dataWeWant.certificates.length + 1;

                        var usersNeeded = {};
                        var cert_ids = [];
                        for (var i = 0; i < dataWeWant.certificates.length; i++) {
                            var cert = dataWeWant.certificates[i];
                            cert.modAt = new Date(cert.modAt);
                            cert._id = new config.mongodb.ObjectID(cert._id);
                            usersNeeded[cert.user_id] = true;
                            cert_ids.push(cert._id);
                            (function(_id) {
                                certificatesCollection.updateOne({_id: cert._id}, {
                                    $set: {
                                        user_id: cert.user_id,
                                        publicKey: cert.publicKey,
                                        expires: new Date(cert.expires),
                                        modAt: cert.modAt,
                                        modBy: cert.modBy,
                                        modVersion: cert.modVersion
                                    }, $setOnInsert: {
                                        // By default, the support certificates are saved as inactive:
                                        active: (cert.user_id != "support@cycligent.com")
                                    }
                                }, {upsert: true}, function(err) {
                                    if (err) {
                                        console.error("certificatesFetch: Error occurred while saving certificates.");
                                        console.error(err);
                                        callback(err);
                                    } else {
                                        console.error("certificatesFetch: Upserted certificate with _id " + _id + ".");
                                        waitingFor--;
                                        if (waitingFor == 0) {
                                            callback(null);
                                        }
                                    }
                                });
                            })(cert._id);
                        }

                        certificatesCollection.removeMany({_id: {$not: {$in: cert_ids}}}, function(err, results) {
                            if (err) {
                                console.error("certificatesFetch: Error occurred while removing certificates.");
                                console.error(err);
                                callback(err);
                            } else {
                                console.error("certificatesFetch: Removed " + results.result.n + " certificate(s) that were not received from www.cycligent.com.");
                                waitingFor--;
                                if (waitingFor == 0) {
                                    callback(null);
                                }
                            }
                        });

                        usersNeeded = Object.keys(usersNeeded);
                        waitingFor += usersNeeded.length;
                        for (i = 0; i < usersNeeded.length; i++) {
                            var user_id = usersNeeded[i];
                            var user = users.userDocGenerate(config, user_id, user_id, "", "/", "cyvisor@cycligent.com");
                            user.roles[0].authorizations = {
                                functions: ['/cycligent/control/'],
                                paths: ["/"]
                            };
                            user.roles[0].authorizationsCache = user.roles[0].authorizations;
                            delete user._id;
                            // Can't $set and $setOnInsert with the same field:
                            delete user.modAt;
                            delete user.config;

                            var $set = {
                                modAt: new Date()
                            };

                            if (dataWeWant.unique_ids && dataWeWant.unique_ids[user_id]) {
                                var unique_id = dataWeWant.unique_ids[user_id];
                                try {
                                    unique_id = new config.mongodb.ObjectID(unique_id);
                                    $set["config.unique_id"] = unique_id;
                                } catch(e) {
                                    console.error("certificatesFetch: Malformed unique_id received.");
                                }
                            }

                            (function(_id) {
                                usersCollection.updateOne({_id: user_id}, {
                                    $set: $set,
                                    $setOnInsert: user
                                }, {upsert: true}, function(err) {
                                    if (err) {
                                        console.error("certificatesFetch: Error occurred while saving a certificate user.");
                                        console.error(err);
                                        callback(err);
                                    } else {
                                        console.error("certificatesFetch: Upserted user with _id " + _id + ".");
                                        waitingFor--;
                                        if (waitingFor == 0) {
                                            callback(null);
                                        }
                                    }
                                });
                            })(user_id);
                        }
                    });
                });
            }
        });
    });

    req.on('error', function(e) {
        console.error("certificatesFetch: Error connecting to www.cycligent.com:");
        console.error(e);
        callback(e);
    });

    req.end(sendingData);
}

function accountCheck(callback) {
    var postOptions = url.parse("https://www.cycligent.com/account/agentAccountCheck");
    //var postOptions = url.parse("http://localhost:1337/account/agentAccountCheck");
    var sendingData = JSON.stringify({instanceId: instanceId});
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': sendingData.length
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "accountCheck: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
        response.on('data', function(chunk) {
            responseData += chunk;
        }).on('end', function() {
            var data = {
                status: 'unknown',
                daysLeft: 0,
                machinesMax: 0,
                sqlEngine: null,
                versions: {
                    tool: null,
                    cyvisor: null
                },
                emailAddressVerified: true
            };
            try {
                responseData = JSON.parse(responseData);
                for (var i = 0; i < responseData.length; i++) {
                    var datum = responseData[i];
                    if (datum.target == "cycligentCall") {
                        status = datum.status;
                        data = datum.data;
                        error = datum.error;
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "accountCheck: Unable to parse the response from www.cycligent.com.";
                }
            }

            if (data.sqlEngine) {
                if (demoHasSQLServer === null) {
                    data.checkAgainForSQL = true;
                }
                demoHasSQLServer = data.sqlEngine.replace("rds:", "");
                hypervisor.demoSqlSetCheckAndInsert(demoHasSQLServer);
            }

            accountStatus = data.status;
            callback(status, error, data, responseData);
        });
    });

    req.on('error', function(e) {
        console.error("accountCheck: Error connecting to www.cycligent.com:");
        console.error(e);
        callback("error", "accountCheck: Unable to connect to www.cycligent.com check account status.", null, null);
    });

    req.end(sendingData);
}

function probeAllReturnHTTP(state) {
    probeAll(function(responses) {
        var res = state.response;
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(responses);
    });
}
exports.probeAllReturnHTTP = probeAllReturnHTTP;

function probeAll(callback) {
    callback = callback || function() {};
    var numSent = 0;
    var numGot = 0;
    var responses = "";
    cycligentAgentFetchRoleProcessList(function(err, roleProcesses) {
        if (err) {
            responses += "An error occurred while trying to find role process information. Error message was: " + err.message;
            callback(responses);
        } else {
            cycligentAgentFetchSetList(function(err, sets) {
                if (err) {
                    responses += "An error occurred while trying to find role process information. Error message was: " + err.message;
                    callback(responses);
                } else {
                    numSent = roleProcesses.length;
                    var roleProcessesByMachine_id = {};

                    // Send probe requests to the role processes.
                    for (var i = 0; i < roleProcesses.length; i++) {
                        var roleProcess = roleProcesses[i];
                        if (roleProcess.deploymentName == config.deploymentName) {
                            if (roleProcess.urls) {
                                attemptProbe(roleProcess._id, roleProcess.urls, function() {
                                    numGot++;
                                    if (numGot == numSent) {
                                        callback(responses);
                                    }
                                });
                            } else {
                                numSent--;
                            }

                            if (roleProcess.machine_id) {
                                if (!roleProcessesByMachine_id[roleProcess.machine_id]) {
                                    roleProcessesByMachine_id[roleProcess.machine_id] = [];
                                }
                                roleProcessesByMachine_id[roleProcess.machine_id].push(roleProcess);
                            }
                        } else {
                            numSent--;
                        }
                    }

                    // Loop through the machines, and configure any that just came online, and update the status
                    // of any machines with a Pending status.
                    for (i = 0; i < sets.length; i++) {
                        var set = sets[i];

                        if (set.deploymentName == config.deploymentName) {

                            if (set.machineSpec.serviceType == "rds" && accountStatus == "trial" && !demoHasSQLServer) {
                                exports.demoHasSQLServerSet(set.machineSpec.engine);
                            }

                            for (var j = 0; j < set.machines.length; j++) {
                                var machine = set.machines[j];

                                if (machine.status && machine.status.needsConfiguration) {
                                    (function (machine, set) {
                                        if (!machinesConfiguring[machine._id]) {
                                            machinesConfiguring[machine._id] = true;
                                            hypervisor.configureMachine(machine, set, function () {
                                                machinesConfiguring[machine._id] = false;
                                            });
                                        }
                                    })(machine, set);
                                } else if (machine.status && machine.status.major == "Pending") {

                                    if (machine.status.minor == "Start machine"
                                        || machine.status.minor == "Restart machine"
                                        || machine.status.minor == "Resize machine"
                                    ) {
                                        // Time after which we consider an updated status from the role process as indicating
                                        // that the machine is online again.
                                        var validModAtTime = new Date(machine.status.modAt);
                                        validModAtTime.setTime(validModAtTime.getTime() + 7000);

                                        var roleProcessesForMachine = roleProcessesByMachine_id[machine._id] || [];

                                        for (var k = 0; k < roleProcessesForMachine.length; k++) {
                                            var roleProcessForMachine = roleProcessesForMachine[k];

                                            if (roleProcessForMachine.status
                                                && roleProcessForMachine.status.major == "Online"
                                                && roleProcessForMachine.status.minor == "Healthy"
                                                && roleProcessForMachine.modAt > validModAtTime
                                            ) {
                                                setsCollection.updateOne({
                                                    "machines._id": machine._id
                                                }, {
                                                    $set: {
                                                        "machines.$.status.major": "Online",
                                                        "machines.$.status.minor": "Healthy",
                                                        "machines.$.status.modAt": new Date()
                                                    }
                                                }, function(){});
                                            }
                                        }
                                    }
                                } else if (accountStatus == "active"
                                    && machine.status
                                    && machine.status.major == "Online"
                                    && machine.status.minor == "Healthy"
                                    && !machine.status.needsConfiguration) {
                                    if (set.roleSpec.otherRoles[0] && set.roleSpec.otherRoles[0].roleType == "mongo") {
                                        numSent++;
                                        hypervisor.probeMongo(set, machine, function () {
                                            numGot++;
                                            if (numGot == numSent) {
                                                callback(responses);
                                            }
                                        });
                                    } else if (set.roleSpec.otherRoles[0] && set.roleSpec.otherRoles[0].roleType == "sql") {
                                        numSent++;
                                        hypervisor.probeSql(set, machine, function () {
                                            numGot++;
                                            if (numGot == numSent) {
                                                callback(responses);
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if (roleProcesses.length == 0 || numSent == 0) {
                        responses += "No role process information available, so no probes were sent.";
                        callback(responses);
                    }
                }
            });
        }
    });

    function attemptProbe(roleProcess_id, urls, callback) {
        var index = 0;
        var errors = "";
        tryUrl();

        function tryUrl() {
            var urlForRoleProcess = urls[index];
            if (!urlForRoleProcess) {
                responses += roleProcess_id + errors + "\n";
                callback();
            } else {
                var urlForRoleProcessParsed = url.parse(urlForRoleProcess);
                var hostname = urlForRoleProcessParsed.hostname;
                if (urlForRoleProcess.indexOf("[") != -1) { // Test if this is an IPv6 URL.
                    // Was getting some errors from IIS if we didn't surround the host in brackets for IPv6:
                    hostname = "[" + hostname + "]";
                }
                var req = http.request({
                    hostname: hostname,
                    port: urlForRoleProcessParsed.port,
                    method: 'GET',
                    path: '/cycligent/agent/probe'
                }, function(res) {
                    var data = roleProcess_id + " " + res.statusCode.toString() + ": ";
                    res.setEncoding('utf8');
                    res.on('data', function(chunk) {
                        data += chunk;
                    });
                    res.on('end', function() {
                        responses += data + "\n";
                        callback();
                    });
                });
                req.on('error', function(e) {
                    errors += " URL #" + index + ": " + e.message;
                    index++;
                    tryUrl();
                });
                req.end();
            }
        }
    }
}
exports.probeAll = probeAll;

function agentActionSend(cookie, data, callback) {

    roleProcessUrlGet(data.roleProcess_id, function(err, urls) {
        var index = 0;

        if (err) {
            callback(new Error("An error occurred while trying to find URLS for '" + data.roleProcess_id + "'. Error message was: '" + err.message + "'."));
        } else if (urls.length == 0) {
            err = new Error("No URLs found for target '" + data.roleProcess_id + "'.");
            err.code = "noUrlsFound";
            callback(err);
        } else {
            tryUrl();
        }

        var errors = "";
        function tryUrl() {
            var targetUrl = urls[index];
            if (!targetUrl) {
                callback(new Error("'" + data.roleProcess_id + "' didn't respond on any of it's known URLs. Errors were: " + errors));
            } else {
                var postData = JSON.stringify(data);

                var postOptions = url.parse(targetUrl + "/cycligent/agent/command");
                postOptions.method = "POST";
                postOptions.headers = {
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length,
                    'Cookie': cookie
                };

                // Set up the request
                var req = http.request(postOptions, function(response) {
                    var error = null;
                    if (response.statusCode != 200)
                        error = new Error("Role process returned non-success status code: " + response.statusCode);
                    var data = '';
                    response.on('data', function(chunk) {
                        data += chunk;
                    }).on('end', function() {
                        callback(error, data);
                    });
                });
                req.end(postData);

                req.on('error', function(e) {
                    errors += " URL #" + index + ": " + e.message;
                    index++;
                    tryUrl();
                });
            }
        }
    });
}
exports.agentActionSend = agentActionSend;

function roleProcessUrlGet(roleProcess_id, callback) {
    roleProcessesCollection.find({_id: roleProcess_id}).toArray(function(err, docs) {
        if (err) {
            callback(err);
        } else {
            if (docs.length == 0) {
                callback(new Error("Couldn't find an address for the role process '" + roleProcess_id + "' in the roleProcesses collection."));
            } else {
                callback(null, docs[0].urls);
            }
        }
    });
}

function versionTypesGet(callback){

    var versionTypes = {};

    function dbFetch() {
        versionTypesCollection.find({}).toArray(function(err, versionTypesFromDb) {
            if (err) {
                console.error("versionTypes: A database error occurred:");
                console.error(err);
                callback({});
                return;
            }

            for (var i = 0; i < versionTypesFromDb.length; i++) {
                var versionType = versionTypesFromDb[i];

                if (versionTypes[versionType._id]) {
                    versionTypes[versionType._id].title = versionType.title;
                }
            }

            callback(versionTypes);
        });
    }

    if (config.deploymentName == "minimal" || config.deploymentName == "local") {
        for (var versionTypeName in config.versions) {
            if (config.versions.hasOwnProperty(versionTypeName)) {
                var versionNumber = config.versions[versionTypeName];

                versionTypes[versionTypeName] = {
                    _id: versionTypeName,
                    version: versionNumber,
                    title: versionTypeName[0].toUpperCase() + versionTypeName.slice(1),
                    webServerDynamicRequestsEnabled: config.versionTypes[versionTypeName].webServerDynamicRequestsEnabled
                };
            }
        }
        dbFetch();
    } else {
        fs.readFile(path.join(__dirname, "..", "..", "..", "..", "app", "web", "config.js"), function(err, data) {
            if (err) {
                console.error("versionTypes: Error reading file:");
                console.error(err);
                callback({});
                return;
            }

            data = data.toString();
            var results = /\/\/\s*Cycligent.builder.versionTypes.replace.start([\s\S]+)\s*,\s*\/\/\s*Cycligent.builder.versionTypes.replace.end/.exec(data)

            try {
                var asJson =
                    "{" +
                    results[1].
                        replace(/([^\s"]+):/g, '"$1":').
                        replace(/'/g, '"') +
                    "}";

                asJson = JSON.parse(asJson);
            } catch(e) {
                console.error("versionTypes: Error parsing JSON:");
                console.error(e);
                callback({});
                return;
            }

            for (var versionTypeName in asJson.versionTypes) {
                if (asJson.versionTypes.hasOwnProperty(versionTypeName)) {
                    versionTypes[versionTypeName] = {
                        _id: versionTypeName,
                        version: asJson.versionTypes[versionTypeName].version,
                        title: versionTypeName[0].toUpperCase() + versionTypeName.slice(1), // dbFetch may change this value.
                        webServerDynamicRequestsEnabled: asJson.versionTypes[versionTypeName].webServerDynamicRequestsEnabled
                    };
                }
            }

            dbFetch();
        });
    }
}

exports._cycligentCacheServiceExport = {
    versionTypes: function(state, storeName, callback) {
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            callback();
            return;
        }

        var store = {id: storeName, criteria: state.post.criteria, items: [], active_id: 0};
        state.target.stores.push(store);

        versionTypesGet(function(versionTypes){
            for (var versionTypeName in versionTypes) {
                if (versionTypes.hasOwnProperty(versionTypeName)) {
                    store.items.push(versionTypes[versionTypeName]);
                }
            }

            callback();
        });

    },

    cloud: function(state, storeName, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            callback();
            return;
        }
        var activeDeployment = config.activeDeployment;
        var data = {
            title: activeDeployment.title,
            versionTypes: {},
            sets: {}
        };

        versionTypesGet(function(versionTypes){
            data.versionTypes = versionTypes;
            cycligentProbeResults2(function(nullValue, probe) {
                var store = {id: storeName, criteria: state.post.criteria, items: [], active_id: 0};
                data.sets = probe.sets;
                store.items.push(data);
                state.target.stores.push(store);
                callback();
            });
        });

    },

    probeResults: function(state, storeName, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }
        cycligentProbeResults2(function(err, data) {
            if (err) {
                data = {};
            }
            var store = {id: storeName, criteria: state.post.criteria, items: [data], active_id: 0};
            state.target.stores.push(store);
            callback();
        });
    }
};

/**
 * Machine is unresponsive so we cannot send it the action, and we do not have to worry about race conditions
 * as it should not be updating its status.
 */
function machineUnresponsiveAction(state, data, callback){

    hypervisor.action(state, data, callback);

}

function machineWillTransitionThroughUnresponsiveAction(state, data, callback){

    hypervisor.action(state, data, callback);

}

/**
 * Machine is responsive so we send the action to the machine and let it execute it. We do this mostly
 * so that the machine can update its own status and thus we avoid race conditions.
 */
function machineResponsiveAction(state, data, callback){

    agentActionSend(state.request.headers.cookie, data, function (err, data) {
        if (err) {
            state.target.status = "error";
            state.target.error = err.message;
            callback();
        } else {
            state.target.status = "success";
            state.target.response = data;
            callback();
        }
    });


}

// TODO: 3. We'll want to replace deploymentName with something like deploymentType, so the name doesn't matter,
// but what kind of deployment it is does.
exports._cycligentCallExport = {

    machineAction: function(state, data, callback){
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (data.roleProcess_id) {
            try {
                data.roleProcess_id = new state.mongodb.ObjectID(data.roleProcess_id);
            } catch(e) {
                state.target.status = "error";
                state.target.error = "machineAction: roleProcess_id was malformed.";
                callback();
                return;
            }
        }

        if (data.machine_id) {
            try {
                data.machine_id = new state.mongodb.ObjectID(data.machine_id);
            } catch(e) {
                state.target.status = "error";
                state.target.error = "machineAction: machine_id was malformed.";
                callback();
                return;
            }
        }

        if (data.set_id) {
            try {
                data.set_id = new state.mongodb.ObjectID(data.set_id);
            } catch(e) {
                state.target.status = "error";
                state.target.error = "machineAction: set_id was malformed.";
                callback();
                return;
            }
        }

        pendingUpdate(function() {
            function callbackCommon(error, data){
                // TODO: 1. Currently some hypervisor actions are setting state.target for us, while some are calling the callback as expected. We should unify them.
                if (state.target.status == "error") {
                    callback();
                } else if(error){
                    state.target.status = "error";
                    state.target.error = "machineAction: " + error.message;
                    callback();
                } else {
                    state.target.status = "success";
                    state.target.response = data;
                    callback();
                }
            }

            // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
            switch (data.action) {

                case "Shut down machine":
                    machineUnresponsiveAction(state, data, callbackCommon);
                    break;

                case "Stop role process":
                    if (accountStatus == "active") {
                        machineUnresponsiveAction(state, data, callbackCommon);
                    } else {
                        machineResponsiveAction(state, data, callbackCommon);
                    }
                    break;

                case "Ignore role process requests":
                case "Handle role process requests":
                    machineResponsiveAction(state, data, callbackCommon);
                    break;

                case "Create role process":
                case "Delete role process":
                case "Start role process":
                case "Start machine":
                case "Create machine":
                case "Resize machine":
                case "Delete machine":      // Machine may actually be responsive, but will no longer be probed so we don't have to worry about race conditions
                    machineUnresponsiveAction(state, data, callbackCommon);
                    break;

                case "Restart role process":
                case "Restart machine":
                    machineWillTransitionThroughUnresponsiveAction(state, data, callbackCommon);
            }
        });

        function pendingUpdate(next) {
            if (/machine$/.test(data.action)) {
                updateMachineStatus(function() {
                    updateRoleProcessStatus({machine_id: data.machine_id}, next);
                });
            } else {
                updateRoleProcessStatus({_id: data.roleProcess_id}, next);
            }
        }

        function updateMachineStatus(next) {
            setsCollection.updateOne({"machines._id": data.machine_id}, {
                $set: {
                    "machines.$.status.major": "Pending",
                    "machines.$.status.minor": data.action,
                    "machines.$.status.modAt": new Date()
                }
            }, function(error) {
                if (error) {
                    state.target.status = "error";
                    state.target.error = "machineAction: Error updating database, error message was: " + error.message;
                    callback();
                }

                next();
            });
        }

        function updateRoleProcessStatus(query, next) {
            roleProcessesCollection.updateMany(query, {
                $set: {
                    "status.setByCyvisor": true,
                    "status.major": "Pending",
                    "status.minor": data.action,
                    "status.modAt": new Date()
                }
            }, function(error) {
                if (error) {
                    state.target.status = "error";
                    state.target.error = "machineAction: Error updating database, error message was: " + error.message;
                    callback();
                }

                next();
            });
        }
    },

    versionTypesUpdate: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (!Array.isArray(data.versionTypes)) {
            state.target.status = "error";
            state.target.error = "versionTypesUpdate: versionTypes parameter should be array.";
            callback();
            return;
        }

        if (data.versionTypes.length <= 0) {
            state.target.status = "error";
            state.target.error = "versionTypesUpdate: No versionTypes were provided.";
            callback();
            return;
        }

        var updates = {};
        for (var i = 0; i < data.versionTypes.length; i++) {
            var versionType = data.versionTypes[i];
            var updateDoc = {};

            if (typeof versionType._id != "string") {
                state.target.status = "error";
                state.target.error = "versionTypesUpdate: versionType._id was of the wrong type, expected string.";
                callback();
                return;
            }

            if (!/^[a-z][a-z0-9-_]*$/.test(versionType._id)) {
                state.target.status = "error";
                state.target.error = "versionTypesUpdate: versionType._id was malformed.";
                callback();
                return;
            }

            if (typeof versionType.title != "string") {
                state.target.status = "error";
                state.target.error = "versionTypesUpdate: versionType.title was of the wrong type, expected string.";
                callback();
                return;
            }

            updateDoc.title = versionType.title;

            updates[versionType._id] = updateDoc;
        }

        var waitingFor = Object.keys(updates).length;
        var alreadyReturned = false;
        for (var versionTypeId in updates) {
            if (updates.hasOwnProperty(versionTypeId)) {
                versionTypesCollection.update({_id: versionTypeId}, {
                    $set: updates[versionTypeId]
                }, {upsert: true}, function(err) {
                    if (alreadyReturned) {
                        return;
                    }

                    if (err) {
                        alreadyReturned = true;
                        state.target.status = "error";
                        state.target.error = "versionTypesUpdate: An error occurred while updating the database.";
                        callback();
                        return;
                    }

                    waitingFor--;

                    if (waitingFor == 0) {
                        state.target.status = "success";
                        callback();
                    }
                });
            }
        }
    },

    setCreate: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (typeof data.title != "string") {
            state.target.status = "error";
            state.target.error = "setCreate: title was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (data.serviceType != "ec2" && data.serviceType != "rds") {
            state.target.status = "error";
            state.target.error = "setCreate: serviceType was invalid, must be 'ec2' or 'rds'.";
            callback();
            return;
        }

        function storageValidate() {
            if (data.storageType
                && data.storageType != "standard" && data.storageType != "gp2" && data.storageType != "io1") {
                state.target.status = "error";
                state.target.error = "setCreate: storageType was invalid, must be 'standard', 'gp2', or 'io1'.";
                callback();
                return false;
            }

            if (data.storageSize && typeof data.storageSize != "number") {
                state.target.status = "error";
                state.target.error = "setCreate: storageSize was not of the correct type (expected number.)";
                callback();
                return false;
            }

            if (data.iops && typeof data.iops != "number") {
                state.target.status = "error";
                state.target.error = "setCreate: iops was not of the correct type (expected number.)";
                callback();
                return false;
            }

            return true;
        }

        var machineSpec = {
            serviceType: data.serviceType,
            ami: null
        };

        if (data.serviceType == "rds") {
            if (data.size && typeof data.size != "string") {
                state.target.status = "error";
                state.target.error = "setCreate: size was not of the correct type (expected string.)";
                callback();
                return;
            }

            if (!data.size) {
                data.size = "db.t2.small";
            }

            if (data.size.indexOf("db.") != 0) {
                state.target.status = "error";
                state.target.error = "setCreate: RDS sizes start with 'db.' (like 'db.t2.small'.)";
                callback();
                return;
            }

            if (typeof data.engine != "string") {
                state.target.status = "error";
                state.target.error = "setCreate: engine was not of the correct type (expected string.)";
                callback();
                return;
            }

            if (data.engineVersion && typeof data.engineVersion != "string") {
                state.target.status = "error";
                state.target.error = "setCreate: engineVersion was not of the correct type (expected string.)";
                callback();
                return;
            }

            if (data.license && typeof data.license != "string") {
                state.target.status = "error";
                state.target.error = "setCreate: license was not of the correct type (expected string.)";
                callback();
                return;
            }

            if (!storageValidate()) {
                return;
            }

            // engine, [engineVersion], [license], [storageType], [storageSize], [iops]
            hypervisor.sqlParamsNormalize(data);

            machineSpec.size = data.size;
            machineSpec.engine = data.engine;
            machineSpec.engineVersion = data.engineVersion;
            machineSpec.license = data.license;
            machineSpec.storageType = data.storageType;
            machineSpec.storageSize = data.storageSize;
            machineSpec.iops = data.iops;
        } else if (data.serviceType == "ec2") {
            if (data.size && typeof data.size != "string") {
                state.target.status = "error";
                state.target.error = "setCreate: size was not of the correct type (expected string.)";
                callback();
                return;
            }

            if (!data.size) {
                data.size = "db.t2.small";
            }

            if (!storageValidate()) {
                return;
            }

            // [storageType], [storageSize], [iops]
            hypervisor.storageParamsNormalize(data);

            machineSpec.size = data.size;
            machineSpec.storageType = data.storageType;
            machineSpec.storageSize = data.storageSize;
            machineSpec.iops = data.iops;
        }

        var newSetDoc = {
            _id: new state.mongodb.ObjectID(),
            deploymentName: config.deploymentName,
            title: data.title,
            roleSpec: {
                versionedRoles: [],
                otherRoles: []
            },
            machineSpec: machineSpec,
            machines: []
        };

        if (machineSpec.serviceType == "rds") {
            newSetDoc.roleSpec.otherRoles.push({
                _id: new state.mongodb.ObjectID(),
                friendlyName: "common-sql-01",
                title: "SQL Server (" + machineSpec.engine + ")",
                versionType: "common",
                roleType: "sql"
            });
        }

        setsCollection.insertOne(newSetDoc, function(err) {
            if (err) {
                state.target.status = "error";
                state.target.error = "setCreate: Error updating database, error message was: " + err.message;
                callback();
                return;
            }

            if (accountStatus == "trial") {
                exports.demoHasSQLServerSet(machineSpec.engine);
            }

            state.target.status = "success";
            state.target.set_id = newSetDoc._id;
            callback();
        });
    },

    setDelete: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (typeof data.set_id != "string") {
            state.target.status = "error";
            state.target.error = "setDelete: set_id was not of the correct type (expected string.)";
            callback();
            return;
        }
        
        try {
            data.set_id = new state.mongodb.ObjectID(data.set_id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "setDelete: set_id was malformed.";
            callback();
            return;
        }

        setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "setDelete: Error finding set in database, error message was: " + err.message;
                callback();
                return;
            }

            if (!setDoc) {
                state.target.status = "error";
                state.target.error = "setDelete: Could not find the specified set in the database.";
                callback();
                return;
            }

            if (setDoc.machines.length > 0) {
                state.target.status = "error";
                state.target.error = "setDelete: Can't remove a set that still has machines in it.";
                callback();
                return;
            }

            setsCollection.removeOne({_id: data.set_id}, function(err) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "setDelete: Error updating database, error message was: " + err.message;
                    callback();
                    return;
                }

                state.target.status = "success";
                callback();
            });
        });
    },

    setRoleCreate: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        var roleDoc = {_id: new state.mongodb.ObjectID()};

        if (typeof data.set_id != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: set_id was not of the correct type (expected string.)";
            callback();
            return;
        }
        
        try {
            data.set_id = new state.mongodb.ObjectID(data.set_id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "setRoleCreate: set_id was malformed.";
            callback();
            return;
        }

        if (typeof data.friendlyName != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: name was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (!/^[a-z][a-z0-9-_]*$/.test(data.friendlyName)) {
            state.target.status = "error";
            state.target.error = "setRoleCreate: name was malformed.";
            callback();
            return;
        }

        roleDoc.friendlyName = data.friendlyName;

        if (typeof data.title != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: title was not of the correct type (expected string.)";
            callback();
            return;
        }

        roleDoc.title = data.title;

        if (typeof data.versionType != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: versionType was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (!/^[a-z][a-z0-9-_]*$/.test(data.versionType)) {
            state.target.status = "error";
            state.target.error = "setRoleCreate: versionType was malformed.";
            callback();
            return;
        }

        roleDoc.versionType = data.versionType;

        if (typeof data.roleType != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: roleType was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (["web", "cyvisor", "worker", "longWorker", "mongo", "dir", "sql"].indexOf(data.roleType) == -1) {
            state.target.status = "error";
            state.target.error = "setRoleCreate: roleType was not a valid choice. Valid choices are: 'web', 'cyvisor', 'worker', 'longWorker', 'mongo', 'dir', 'sql'";
            callback();
            return;
        }

        roleDoc.roleType = data.roleType;

        if (data.workerType && typeof data.workerType != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: workerType was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (data.workerType) {
            roleDoc.workerType = data.workerType;
        }

        if (typeof data.roleSpecType != "string") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: roleSpecType was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (data.roleSpecType != "versionedRoles" && data.roleSpecType != "otherRoles") {
            state.target.status = "error";
            state.target.error = "setRoleCreate: roleSpecType was invalid, it must be 'versionedRoles' or 'otherRoles'.";
            callback();
            return;
        }

        setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "setRoleCreate: Error accessing database, error message was: " + err.message;
                callback();
                return;
            }

            if (setDoc == null) {
                state.target.status = "error";
                state.target.error = "setRoleCreate: Unable to find specified set.";
                callback();
                return;
            }

            // TODO: 5. In the future, we will want to lift this limitation:
            if (accountStatus == "active"
                && (setDoc.roleSpec.versionedRoles.length > 0 || setDoc.roleSpec.otherRoles.length > 0)) {
                state.target.status = "error";
                state.target.error = "setRoleCreate: Only one role may be on a set at a time.";
                callback();
                return;
            }

            if (roleDoc.roleType != "sql" && setDoc.machineSpec.serviceType == "rds") {
                state.target.status = "error";
                state.target.error = "setRoleCreate: This set can only contain RDS servers.";
                callback();
                return;
            }

            if (roleDoc.roleType == "sql" && setDoc.machineSpec.serviceType != "rds") {
                state.target.status = "error";
                state.target.error = "setRoleCreate: This set cannot contain RDS servers.";
                callback();
                return;
            }

            if (roleDoc.roleType == "sql"
                && (setDoc.roleSpec.versionedRoles.length > 0 || setDoc.roleSpec.otherRoles.length > 0)) {
                state.target.status = "error";
                state.target.error = "setRoleCreate: Only one SQL server role can be in a SQL set.";
                callback();
                return;
            }

            for (var i = 0; i < setDoc.roleSpec.versionedRoles.length; i++) {
                var roleSpec = setDoc.roleSpec.versionedRoles[i];
                if (roleSpec.friendlyName == data.friendlyName) {
                    state.target.status = "error";
                    state.target.error = "setRoleCreate: A role with that friendlyName already exists!";
                    callback();
                    return;
                }
            }

            for (i = 0; i < setDoc.roleSpec.otherRoles.length; i++) {
                roleSpec = setDoc.roleSpec.otherRoles[i];
                if (roleSpec.friendlyName == data.friendlyName) {
                    state.target.status = "error";
                    state.target.error = "setRoleCreate: A role with that friendlyName already exists!";
                    callback();
                    return;
                }

                if (roleSpec.roleType == "loadBalancer") {
                    state.target.status = "error";
                    state.target.error = "setRoleCreate: Additional roles cannot be added to a load balancer set.";
                    callback();
                    return;
                }
            }

            var $push = {};
            $push["roleSpec." + data.roleSpecType] = roleDoc;

            setsCollection.updateOne({_id: data.set_id}, {
                $push: $push
            }, function(err) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "setRoleCreate: Error updating database, error message was: " + err.message;
                    callback();
                    return;
                }

                function shiftMachineAndGo() {
                    var machine = setDoc.machines.shift();

                    if (!machine) {
                        state.target.status = "success";
                        callback();
                        return;
                    }

                    exports._cycligentCallExport.machineAction(state, {
                        action: "Create role process",
                        roleSpec_id: roleDoc._id,
                        friendlyName: data.friendlyName,
                        machine_id: machine._id,
                        set_id: setDoc._id,
                        roleType: data.roleType,
                        versionType: data.versionType
                    }, function() {
                        if (state.target.status != "success") {
                            callback();
                        } else {
                            shiftMachineAndGo();
                        }
                    });
                }

                shiftMachineAndGo();
            });
        });
    },

    setRoleDelete: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (typeof data.set_id != "string") {
            state.target.status = "error";
            state.target.error = "setRoleDelete: set_id was not of the correct type (expected string.)";
            callback();
            return;
        }

        try {
            data.set_id = new state.mongodb.ObjectID(data.set_id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "setRoleDelete: set_id was malformed.";
            callback();
            return;
        }

        if (typeof data._id != "string") {
            state.target.status = "error";
            state.target.error = "setRoleDelete: _id was not of the correct type (expected string.)";
            callback();
            return;
        }

        try {
            data._id = new state.mongodb.ObjectID(data._id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "setRoleDelete: _id was malformed.";
            callback();
            return;
        }

        if (typeof data.roleSpecType != "string") {
            state.target.status = "error";
            state.target.error = "setRoleDelete: roleSpecType was not of the correct type (expected string.)";
            callback();
            return;
        }

        if (data.roleSpecType != "versionedRoles" && data.roleSpecType != "otherRoles") {
            state.target.status = "error";
            state.target.error = "setRoleDelete: roleSpecType was invalid, it must be 'versionedRoles' or 'otherRoles'.";
            callback();
            return;
        }

        var $pull = {};
        $pull["roleSpec." + data.roleSpecType] = {_id: data._id};

        setsCollection.updateOne({_id: data.set_id}, {
            $pull: $pull
        }, function(err) {
            if (err) {
                state.target.status = "error";
                state.target.error = "setRoleDelete: Error updating database, error message was: " + err.message;
                callback();
                return;
            }

            setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "setRoleDelete: Error accessing database, error message was: " + err.message;
                    callback();
                    return;
                }

                if (setDoc == null) {
                    state.target.status = "error";
                    state.target.error = "setRoleDelete: Unable to find specified set.";
                    callback();
                    return;
                }

                function shiftMachineAndGo() {
                    var machine = setDoc.machines.shift();

                    if (!machine) {
                        state.target.status = "success";
                        callback();
                        return;
                    }

                    exports._cycligentCallExport.machineAction(state, {
                        action: "Delete role process",
                        roleSpec_id: data._id,
                        machine_id: machine._id,
                        set_id: setDoc._id
                    }, function() {
                        if (state.target.status != "success") {
                            callback();
                        } else {
                            shiftMachineAndGo();
                        }
                    });
                }

                shiftMachineAndGo();
            });
        });
    },

    setUpdateSize: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (typeof data.set_id != "string") {
            state.target.status = "error";
            state.target.error = "setUpdateSize: set_id was not of the correct type (expected string.)";
            callback();
            return;
        }

        try {
            data.set_id = new state.mongodb.ObjectID(data.set_id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "setUpdateSize: set_id was malformed.";
            callback();
            return;
        }

        if (typeof data.size != "string") {
            state.target.status = "error";
            state.target.error = "setUpdateSize: size was not of the correct type (expected string.)";
            callback();
            return;
        }

        setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "setUpdateSize: Error accessing database, error message was: " + err.message;
                callback();
                return;
            }

            if (setDoc == null) {
                state.target.status = "error";
                state.target.error = "setUpdateSize: Unable to find specified set.";
                callback();
                return;
            }

            function shiftMachineAndGo() {
                var machine = setDoc.machines.shift();

                if (!machine) {
                    finalUpdate();
                    return;
                }

                exports._cycligentCallExport.machineAction(state, {
                    action: "Resize machine",
                    machine_id: machine._id,
                    set_id: setDoc._id,
                    size: data.size
                }, function() {
                    if (state.target.status != "success") {
                        callback();
                    } else {
                        shiftMachineAndGo();
                    }
                });
            }

            shiftMachineAndGo();
        });

        function finalUpdate() {
            setsCollection.updateOne({_id: data.set_id}, {
                $set: {
                    "machineSpec.size": data.size
                }
            }, function(err) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "setUpdateSize: Error updating database, error message was: " + err.message;
                    callback();
                    return;
                }

                state.target.status = "success";
                callback();
            });
        }
    },

    /**
     * state.data JSON document should be as follows:
     *
     *     {"status": "trial", "daysLeft": 25, "machinesMax": 8, "sqlEngine": "rds:sqlserver-ex", "versions": {"tool": "0.0.60", cyvisor: "0.0.54"}, "emailAddressVerified": true}
     *
     * Statuses:
     *     "trial" - Account is a trial account that still has days remaining
     *         daysLeft in trial is provided in document
     *     "expired" - Account is a trial account whose time has expired
     *         daysLeft will be a negative number (the days since the trial expired)
     *     "active" - Account is NOT a trial account and is active and in good standing
     *         daysLeft will be the number of days until the next billing cycle
     *     "delinquent" - Account has missed a payment and is in the grace period, servers will continue
     *                    to run, but no control functions will be allowed.
     *         daysLeft will be the number of days until the account is deleted
     *     "cancelled" - Account was cancelled
     *     "unknown" - Account is not recognized
     *
     * @param {State} state
     * @param {Object} data
     * @param {Function} callback
     */
    accountCheck: function(state, data, callback){
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }
        if (config.debug || config.deploymentName == "minimal" || config.deploymentName == "local") {
            state.target.status = "success";
            state.target.data = {
                status: "trial",
                daysLeft: Math.round(Math.random()*30),
                machinesMax: 8,
                sqlEngine: demoHasSQLServer,
                versions: {
                    tool: null,
                    cyvisor: null
                },
                emailAddressVerified: true
            };
            callback();
            return;
        }

        accountCheck(function(status, error, data, responseData) {
            state.target.status = status;
            state.target.data = data;
            state.target.serverResponse = responseData;
            state.target.error = error;
            callback();
        });
    },

    surveySubmit: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }
        if (data.comment === undefined && data.score === undefined) {
            state.target.status = "error";
            state.target.error = "surveySubmit: Required parameters 'comment' or 'score' weren't provided. At least one must be.";
            callback();
            return;
        }

        var postData = JSON.stringify({
            comment: data.comment,
            score: data.score,
            instanceId: instanceId
        });

        var postOptions = url.parse("https://www.cycligent.com/account/agentSurveySubmit");
        //var postOptions = url.parse("http://localhost:1337/account/agentSurveySubmit");
        postOptions.method = "POST";
        postOptions.headers = {
            'Content-Type': 'application/json',
            'Content-Length': postData.length
        };

        var req = https.request(postOptions, function(response) {
            var error = null;
            var status = "success";
            if (response.statusCode != 200) {
                status = "error";
                error = "surveySubmit: Server returned non-success status code: " + response.statusCode;
            }
            var data = '';
            response.on('data', function(chunk) {
                data += chunk;
            }).on('end', function() {
                try {
                    data = JSON.parse(data);
                    for (var i = 0; i < data.length; i++) {
                        var datum = data[i];
                        if (datum.target == "cycligentCall") {
                            status = datum.status;
                            error = datum.error;
                            break;
                        }
                    }
                } catch(e) {
                    if (!error) {
                        status = "error";
                        error = "surveySubmit: Unable to parse the response from www.cycligent.com.";
                    }
                }

                state.target.status = status;
                state.target.serverResponse = data;
                state.target.error = error;
                callback();
            });
        });

        req.on('error', function(e) {
            console.error("surveySubmit: Error connecting to www.cycligent.com:");
            console.error(e);
            state.target.status = "error";
            state.target.error = "surveySubmit: Unable to connect to www.cycligent.com to submit the survey.";
            callback();
        });

        req.end(postData);
    },

    supportToggle: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }
        if (typeof data.active != "boolean") {
            state.target.status = "error";
            state.target.error = "supportToggle: Argument 'active' was not of expected type boolean.";
            callback();
            return;
        }

        cycligentMongo.docsUpdate(state, state.sessionDbName, 'certificates', {user_id: 'support@cycligent.com'},
            {
                $set: {
                    active: data.active
                }
            }, function() {
                state.target.status = "error";
                state.target.error = "supportToggle: A database error occurred while toggling support access.";
                callback();
            }, function(numUpdated) {
                if (numUpdated == 0) {
                    state.target.status = "error";
                    state.target.error = "supportToggle: Couldn't find the support certificate in the database.";
                    callback();
                } else {
                    if (data.active == true) {
                        state.target.status = "success";
                        callback();
                        return;
                    }

                    cycligentMongo.docUpdate(state, state.sessionDbName, 'users', {_id: 'support@cycligent.com'},
                        {
                            $set: {
                                authorizationTokens: {}
                            }
                        }, function() {
                            state.target.status = "error";
                            state.target.error = "supportToggle: A database error occurred while disabling support access.";
                            callback();
                        }, function() {
                            state.target.status = "success";
                            callback();
                        });
                }
            });
    },

    supportGetValue: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }
        cycligentMongo.docsFind(state, state.sessionDbName, 'certificates', {
                user_id: 'support@cycligent.com',
                active: true
            }, {}, function() {
                state.target.status = "error";
                state.target.error = "supportGetValue: A database error occurred while enabling support access.";
                callback();
            }, function(docs) {
                state.target.status = "success";
                state.target.active = (docs.length > 0);
                callback();
            });
    },

    dbVersionsGet: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        state.target.status = "success";
        state.target.dbVersions = hypervisor.dbVersionsGet();
        callback();
    },

    hostInfoGet: function(state, data, callback) {
        // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        if (!data._id) {
            state.target.status = "error";
            state.target.error = "hostInfoGet: Required argument '_id' was not supplied.";
            callback();
            return;
        }

        if (typeof data._id != "string") {
            state.target.status = "error";
            state.target.error = "hostInfoGet: Argument '_id' was not of expected type string.";
            callback();
            return;
        }

        try {
            data._id = new state.mongodb.ObjectID(data._id);
        } catch(e) {
            state.target.status = "error";
            state.target.error = "hostInfoGet: Argument '_id' was malformed.";
            callback();
            return;
        }

        setsCollection.findOne({"machines._id": data._id}, {
            fields: {
                "machineSpec": 1,
                "machines.$": 1
            }
        }, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "hostInfoGet: Error occurred while trying to access the database.";
                callback();
                return;
            }

            if (!setDoc) {
                state.target.status = "error";
                state.target.error = "hostInfoGet: Machine specified by the given ID could not be found.";
                callback();
                return;
            }

            var machineDoc = setDoc.machines[0];

            if (setDoc.machineSpec.serviceType == "sql") {
                rds.describeDBInstances({
                    DBInstanceIdentifier: machineDoc.awsInstanceId
                }, function(err, data) {
                    if (err) {
                        console.error("hostInfoGet: An error occurred while trying to get instance status information from AWS. Error was:");
                        console.error(err);
                        state.target.status = "error";
                        state.target.error = "hostInfoGet: An error occurred while trying to get instance status " +
                            "information from AWS. Error message was: " + err.message;
                        callback();
                        return;
                    }

                    var instanceData = data.DBInstances[0];

                    state.target.status = "success";
                    state.target.host = instanceData.Endpoint.Address + ":" + instanceData.Endpoint.Port;
                    state.target.users = machineDoc.users;
                    callback();
                });
            } else {
                ec2.describeInstances({
                    InstanceIds: [machineDoc.awsInstanceId]
                }, function(err, data) {
                    if (err) {
                        console.error("hostInfoGet: An error occurred while trying to get instance status information from AWS. Error was:");
                        console.error(err);
                        state.target.status = "error";
                        state.target.error = "hostInfoGet: An error occurred while trying to get instance status " +
                            "information from AWS. Error message was: " + err.message;
                        callback();
                        return;
                    }

                    var instanceData = data.Reservations[0].Instances[0];

                    state.target.status = "success";
                    state.target.host = instanceData.PublicIpAddress;
                    state.target.users = machineDoc.users;
                    callback();
                });
            }
        });
    },

    launchHostnameGet: function(state, data, callback) {
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        setsCollection.findOne({
            "roleSpec.otherRoles.0.roleType": "loadBalancer",
            "machines.0.awsInstanceId": {$exists: true}
        }, function(err, setDoc) {
            if (err) {
                state.target.status = "error";
                state.target.error = "launchUrlGet: A database error occurred while trying to get information about the load balancer.";
                callback();
                return;
            }

            if (!setDoc) {
                state.target.status = "error";
                state.target.error = "launchUrlGet: Could not find the load balancer set.";
                callback();
                return;
            }

            var loadBalancer = setDoc.machines[0];

            if (loadBalancer == null) {
                state.target.status = "error";
                state.target.error = "launchUrlGet: Could not find the load balancer.";
                callback();
                return;
            }

            elb.describeLoadBalancers({
                LoadBalancerNames: [loadBalancer.awsInstanceId]
            }, function(err, data) {
                if (err) {
                    console.error("launchUrlGet: An AWS error occurred while trying to get information about " +
                    "the load balancer. Error message:");
                    console.error(err);
                    state.target.status = "error";
                    state.target.error = "launchUrlGet: An AWS error occurred while trying to get information about " +
                    "the load balancer. Error message was: " + err.message;
                    callback();
                    return;
                }

                if (data.LoadBalancerDescriptions.length == 0) {
                    state.target.status = "error";
                    state.target.error = "launchUrlGet: No load balancer information was returned from AWS.";
                    callback();
                    return;
                }

                state.target.status = "success";
                state.target.hostname = data.LoadBalancerDescriptions[0].DNSName;
                callback();
            });
        });
    }
};

exports._cycligentDownloadExport = {
    pemFromArgs: function(state, data, callback) {
        if (!authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
            state.target.status = 'unauthorized';
            callback();
            return;
        }

        state.target.status = "success";
        state.target.data = data.pemData;
        state.target.contentType = 'application/x-pem-file';
        state.target.filename = data.ipAddress + ".pem";
        state.target.encoding = 'utf8';

        callback();
    }
};

function isFaked(roleProcess_id){
    if (accountStatus == "active") {
        return false;
    }

    var setsToGrab = ["mongoSet", "dirSet"];
    if (demoHasSQLServer) {
        setsToGrab.push("sqlSet");
    }
    var fakedRoleProcesses = fakeRoleProcessesGetBySetId(setsToGrab);
    for (var j = 0; j < fakedRoleProcesses.length; j++) {
        var fakedServer = fakedRoleProcesses[j];
        if (fakedServer._id.equals(roleProcess_id))
            return true;
    }

    return false;
}

function machineStatus(roleProcess_id, callback){

    roleProcessesCollection.findOne({_id: roleProcess_id}, {fields: {status: 1}}, function(err, roleProcess) {
        if (err) {
            callback(err);
        } else {
            if(roleProcess) {
                statusNormalize(roleProcess);
                callback(null, roleProcess.status);
            } else {
                if(isFaked(roleProcess_id)){
                    callback(null, {modAt: new Date(), major: "Online", minor: "Healthy"});
                } else {
                    callback("Unable to locate status of '" + roleProcess_id + "' in roleProcesses collection.");
                }
            }
        }
    });

}
exports.machineStatus = machineStatus;


function statusNormalize(roleProcess){

    var responseTimeout = new Date();
    responseTimeout.setTime(responseTimeout.getTime()-7000);

    if(!roleProcess.status || !roleProcess.status.modAt || roleProcess.status.modAt < responseTimeout){

        if(!roleProcess.status){
            roleProcess.status = {};
        }

        roleProcess.status.modAt = new Date();
        roleProcess.status.major = "Unresponsive";

        switch(roleProcess.status.minor){

            case "Shut down machine":
                roleProcess.status.major = "Off";
                roleProcess.status.minor = "Machine shut down";
                break;

            case "Stop role process":
                roleProcess.status.major = "Stopped";
                roleProcess.status.minor = "Role process stopped";
                break;

            case "Create machine":
                roleProcess.status.major = "Pending";
                roleProcess.status.minor = "Create machine";
                break;

            case "Ignore role process requests":
            case "Handle role process requests":
            case "Start role process":
            case "Start machine":
            case "Resize machine":
            case "Delete machine":      // This shouldn't be able to happen!!
            case "Restart role process":
            case "Restart machine":
                // Nothing to do in these instances
                break;

            default:
                roleProcess.status.minor = "No probes";
                break;

        }

    }
}


function cycligentProbeResults(callback) {

    roleProcessesCollection.find({}, {
        fields: {
            friendlyName: 1,
            machine_id: 1,
            set_id: 1,
            status: 1
        }
    }).toArray(function(err, results) {
        if (err) {
            callback(err);
        } else {

            var data = {};
            var index;

            function roleProcessStatusSet(roleProcess){
                if (!data[roleProcess.set_id]) {
                    data[roleProcess.set_id] = {}
                }
                statusNormalize(roleProcess);
                roleProcess.status._id = roleProcess._id;
                roleProcess.status.friendlyName = roleProcess.friendlyName;
                roleProcess.status.machine_id = roleProcess.machine_id;
                data[roleProcess.set_id][roleProcess._id] = roleProcess.status;
            }

            for(index = 0; index < results.length; index++){
                roleProcessStatusSet(results[index]);
            }

            // TODO: 4. Long-term, we probably want to have some function that exercise the database or
            // directory (via LDAP) that vouches for the health of the instance, or at the very least we
            // should check that it's responding over TCP.
            var setsToGrab;
            if (accountStatus != "active") {
                setsToGrab = ["mongoSet", "dirSet"];
                if (demoHasSQLServer) {
                    setsToGrab.push("sqlSet");
                }
            } else {
                setsToGrab = [];
            }
            var fakedRoleProcesses = fakeRoleProcessesGetBySetId(setsToGrab);
            var fakedRoleProcess;
            for (index = 0; index < fakedRoleProcesses.length; index++) {
                fakedRoleProcess = fakedRoleProcesses[index];
                fakedRoleProcess.status = {modAt: new Date(), major: "Online", minor: "Healthy"};
                roleProcessStatusSet(fakedRoleProcess);
            }

            callback(null, data);
        }
    });
}
exports.cycligentProbeResults = cycligentProbeResults;

function statusGroupStart(){
    return {
        //TODO: 1. Array zeros should really be set by agent.probeSamplesToStoreGet()
        response: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        cpu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        network: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        count: 0,
        onlineSeen: false,
        pendingSeen: false,
        mixed: false,
        major: "",
        minor: "",
        probeCount: 0
    };
}

function statusGroupAddRoleProcess(status, roleProcess){

    status.minor = roleProcess.status.minor;

    if(status.major == ""){
        status.major = roleProcess.status.major;
    } else {
        if(status.major != "Pending" && status.major != roleProcess.status.major){
            status.mixed = true;
            if(roleProcess.status.major == "Pending"){
                status.pendingSeen = true;
            }
        }
    }

    status.probeCount += roleProcess.status.metrics.probeCount ? roleProcess.status.metrics.probeCount : 0;

    if (roleProcess.status.major == "Online") {

        status.onlineSeen = true;

        var metrics = roleProcess.status.metrics;

        if(metrics.cpu && metrics.cpu.length > 0) {

            status.count++;

            var i;
            for (i = 0; i < metrics.cpu.length; i++) {
                status.response[i] = status.response[i] > metrics.response[i] ?
                    status.response[i] :
                    metrics.response[i];

                status.cpu[i] += metrics.cpu[i];

                status.memory[i] += metrics.memory[i];

                status.network[i] += metrics.network[i];
            }
            status.memoryMax = metrics.memoryMax;
            status.probeInterval = metrics.probeInterval;
        }
    }

}

function statusGroupComplete(status){

    var i;

    if(status.count > 0) {
        for(i = 0; i < status.cpu.length; i++) {
            status.cpu[i] /= status.count;
        }
    }

    if(status.mixed){
        if(status.pendingSeen){
            status.major = "Pending";
            status.minor = "Sub item";
        } else if(status.onlineSeen){
            status.major = "Impaired";
            status.minor = "One or more role processes on one or more machines are not online";
        } else {
            status.major = "Offline";
            status.minor = "No role processes on any machine online";
        }
    } else {
        if (status.major == "Unknown") {
            status.minor = "Unknown";
        }
    }

    return {
        major: status.major,
        minor: status.minor,
        metrics: {
            response: status.response,
            cpu: status.cpu,
            memory: status.memory,
            network: status.network,
            memoryMax: status.memoryMax,
            probeInterval: status.probeInterval,
            probeCount: status.probeCount
        }
    };

}

function setsComputeStatuses(sets){
    var setIndex;
    var set;
    var machineIndex;
    var machine;
    var roleProcessIndex;
    var roleProcess;
    var versionTypeIndex;
    var verType;
    var roleIndex;
    var roleSpec;

    for(setIndex in sets){

        set = sets[setIndex];

        set.status = statusGroupStart();

        for(versionTypeIndex in set.versionTypes){
            verType = set.versionTypes[versionTypeIndex];
            verType.status = statusGroupStart();
            for(roleIndex in verType.roles){
                verType.roles[roleIndex].status = statusGroupStart();
            }
        }

        for(roleIndex in set.otherRoles){
            set.otherRoles[roleIndex].status = statusGroupStart();
        }

        for(machineIndex in set.machines){
            machine = set.machines[machineIndex];
            machine.status = statusGroupStart();

            for(roleProcessIndex in machine.roleProcesses){
                roleProcess = machine.roleProcesses[roleProcessIndex];

                statusGroupAddRoleProcess(set.status, roleProcess);
                statusGroupAddRoleProcess(machine.status, roleProcess);

                roleSpec = set.roleMap[roleProcess.roleSpec_id];

                if(roleSpec) {
                    statusGroupAddRoleProcess(roleSpec.status, roleProcess);
                    if(roleSpec.versioned){
                        verType = set.versionTypes[roleProcess.versionType];
                        if(verType){
                            statusGroupAddRoleProcess(verType.status, roleProcess);
                        } else {
                            console.error("Version type configuration mismatch on versionType = '" + roleProcess.versionType + "'.");
                        }
                    } else {
                        statusGroupAddRoleProcess(roleSpec.status, roleProcess);
                    }
                } else {
                    console.error("RoleSpec/RoleProcess configuration mismatch on roleSpec_id = '" + roleProcess.roleSpec_id + "'.");
                }

            }

            machine.status = statusGroupComplete(machine.status);
        }

        for(versionTypeIndex in set.versionTypes){
            verType = set.versionTypes[versionTypeIndex];
            for(roleIndex in verType.roles){
                verType.roles[roleIndex].status = statusGroupComplete(verType.roles[roleIndex].status);
            }
            verType.status = statusGroupComplete(verType.status);
        }

        for(roleIndex in set.otherRoles.length){
            set.otherRoles[roleIndex].status = statusGroupComplete(set.otherRoles[roleIndex].status);
        }

        set.status = statusGroupComplete(set.status);

        delete set.roleMap;
    }
}

// TODO: 1. Rename:
function cycligentProbeResults2(callback) {

    versionTypesGet(function(versionTypes) {

        roleProcessesCollection.find({}, {
            fields: {
                friendlyName: 1,
                machine_id: 1,
                set_id: 1,
                status: 1,
                roleSpec_id: 1,
                roleType: 1,
                versionType: 1,
                version: 1
            }
        }).toArray(function (err, roleProcesses) {
            if (err) {
                callback(err);
                return;
            }

            setsCollection.find({}, {
                fields: {
                    title: 1,
                    machines: 1,
                    roleSpec: 1,
                    machineSpec: 1
                }
            }).toArray(function (err, setDocs) {
                if (err) {
                    callback(err);
                    return;
                }

                var sets = {};
                var setDefault = null;
                var setNew = null;
                var setMap = {};
                var machineMap = {};
                var roleSpecNew = null;

                for (var i = 0; i < setDocs.length; i++) {
                    var setDoc = setDocs[i];

                    if (setDoc._id.equals(new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62"))) {
                        setDefault = setDoc;
                    }

                    setNew = {
                        _id: setDoc._id,
                        title: setDoc.title,
                        roleSpec: setDoc.roleSpec,
                        machineSpec: setDoc.machineSpec,
                        machines: {},
                        versionTypes: {},
                        otherRoles: {},
                        roleMap: {}
                    };

                    setMap[setDoc._id] = setNew;

                    for (var j = 0; j < setDoc.machines.length; j++) {

                        var cloudMachine = setDoc.machines[j];

                        var probeMachine = {
                            _id: cloudMachine._id,
                            roleProcesses: {}
                        };

                        machineMap[cloudMachine._id] = {
                            cloudMachine: cloudMachine,
                            probeMachine: probeMachine,
                            probesSeen: {}
                        };

                        if (cloudMachine.status) {
                            cloudMachine.machineLevelStatus = cloudMachine.status;

                            if (!cloudMachine.machineLevelStatus.responseTimeSamples) {
                                cloudMachine.machineLevelStatus.responseTimeSamples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                            }

                            if (!cloudMachine.machineLevelStatus.memSamples) {
                                cloudMachine.machineLevelStatus.memSamples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                            }

                            if (!cloudMachine.machineLevelStatus.networkTrafficSamples) {
                                cloudMachine.machineLevelStatus.networkTrafficSamples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                            }

                            if (!cloudMachine.machineLevelStatus.cpuSamples) {
                                cloudMachine.machineLevelStatus.cpuSamples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                            }

                            if (!cloudMachine.machineLevelStatus.probeInterval) {
                                cloudMachine.machineLevelStatus.probeInterval = 0;
                            }

                            if (!cloudMachine.machineLevelStatus.probeCount) {
                                cloudMachine.machineLevelStatus.probeCount = 0;
                            }

                            if (!cloudMachine.machineLevelStatus.memoryMax) {
                                cloudMachine.machineLevelStatus.memoryMax = 0;
                            }
                        }

                        setNew.machines[probeMachine._id] = probeMachine;
                    }

                    function roleNewCreate(roleArg, versioned, machines) {
                        var r = {
                            _id: roleArg._id,
                            versioned: versioned
                        };

                        for (var machineIndex in machines) {
                            machineMap[machines[machineIndex]._id].probesSeen[roleArg._id] = {seen: false, roleSpec: roleArg};
                        }
                        return r;
                    }

                    // Add in the versioned roles and while we are at it add in any versionTypes that are referenced.
                    var roleIndex;
                    var roleSpec;
                    var verTypeMatch;
                    var verTypeNew;
                    var verTypeProp;
                    for (roleIndex = 0; roleIndex < setDoc.roleSpec.versionedRoles.length; roleIndex++) {

                        roleSpec = setDoc.roleSpec.versionedRoles[roleIndex];
                        roleSpecNew = roleNewCreate(roleSpec, true, setNew.machines);

                        verTypeNew = setNew.versionTypes[roleSpec.versionType];

                        if(!verTypeNew){
                            // We haven't seen this version before so add it to the set
                            verTypeMatch = versionTypes[roleSpec.versionType];
                            if(verTypeMatch){
                                verTypeNew = {};
                                for(verTypeProp in verTypeMatch){
                                    verTypeNew[verTypeProp] = verTypeMatch[verTypeProp];
                                }
                                verTypeNew.roles = {};
                                setNew.versionTypes[verTypeNew._id] = verTypeNew;
                            } else {
                                console.error("Configuration mismatch role version type set to unknown version type '" + roleSpec.versionType + "'.");
                            }
                        }

                        setNew.roleMap[roleSpec._id] = roleSpecNew;
                        verTypeNew.roles[roleSpecNew._id] = roleSpecNew;
                    }

                    for (roleIndex = 0; roleIndex < setDoc.roleSpec.otherRoles.length; roleIndex++) {
                        roleSpec = setDoc.roleSpec.otherRoles[roleIndex];
                        roleSpecNew = roleNewCreate(roleSpec, false, setNew.machines);
                        setNew.roleMap[roleSpec._id] = roleSpecNew;
                        setNew.otherRoles[roleSpecNew._id] = roleSpecNew;
                    }

                    sets[setNew._id] = setNew;
                }

                function roleProcessProcess(roleProcess) {

                    statusNormalize(roleProcess);

                    var mm = machineMap[roleProcess.machine_id];

                    if (!mm) {
                        console.error("machineMap entry for " + roleProcess.machine_id + " was undefined.");
                        return;
                    }

                    var machine = mm.probeMachine;

                    if (machine) {

                        if (!mm.probesSeen[roleProcess.roleSpec_id]) {
                            console.error("Role process " + roleProcess._id + " has unknown roleSpec_id " + roleProcess.roleSpec_id);
                            return;
                        }

                        mm.probesSeen[roleProcess.roleSpec_id].seen = true;

                        machine.roleProcesses[roleProcess._id] = {
                            _id: roleProcess._id,
                            friendlyName: roleProcess.friendlyName,
                            roleSpec_id: roleProcess.roleSpec_id,
                            machine_id: roleProcess.machine_id,
                            roleType: roleProcess.roleType,
                            versionType: roleProcess.versionType,
                            version: roleProcess.version,

                            status: {
                                major: roleProcess.status.major,
                                minor: roleProcess.status.minor,
                                setByCyvisor: roleProcess.status.setByCyvisor,

                                metrics: {
                                    probeCount: roleProcess.status.probeCount,
                                    probeInterval: roleProcess.status.probeInterval,

                                    cpu: roleProcess.status.cpuSamples,
                                    memory: roleProcess.status.memSamples,
                                    memoryMax: roleProcess.status.memTotal,
                                    network: roleProcess.status.networkTrafficSamples,
                                    response: roleProcess.status.responseTimeSamples,

                                    modAt: roleProcess.status.modAt
                                }
                            }

                        };
                    } else {
                        console.error("Unable to find machine: '" + roleProcess.machine_id + "'.");
                        // TODO: 1. Send flag back to client indicating there is a configuration error!
                    }
                }

                for (var index = 0; index < roleProcesses.length; index++) {
                    roleProcessProcess(roleProcesses[index]);
                }

                // Set roleProcess to Unresponsive (No probes) for any roleProcesses that we didn't see in the file
                var mmi;
                var mm;
                var psi;
                var ps;
                // TODO: 1. _High priority_ In production environments, the load balancer shows up as red (because we don't get any monitoring stats on it.)
                // TODO: 1. If we have a set without any roles in it yet, and we add a virutal machine, it shows up as black, instead of Pending or Online Healhty.
                for (mmi in machineMap) {
                    mm = machineMap[mmi];
                    for (psi in mm.probesSeen) {
                        ps = mm.probesSeen[psi];
                        if (!ps.seen
                            && accountStatus == "trial"
                            && (ps.roleSpec.roleType == 'sql' || ps.roleSpec.roleType == 'mongo' || ps.roleSpec.roleType == 'dir')) {
                            // TODO: 4. Long-term, we probably want to have some function that exercise the database or
                            // directory (via LDAP) that vouches for the health of the instance, or at the very least we
                            // should check that it's responding over TCP.
                            roleProcessProcess({
                                _id: "faked/" + ps.roleSpec.friendlyName + "-" + mmi,
                                friendlyName: ps.roleSpec.friendlyName,
                                roleSpec_id: ps.roleSpec._id,
                                machine_id: mmi,
                                roleType: ps.roleSpec.roleType,
                                versionType: ps.roleSpec.versionType,
                                version: "Unknown",
                                status: {
                                    modAt: new Date(),
                                    major: "Online",
                                    minor: "Healthy"
                                }
                            });
                        } else if (!ps.seen && mm.cloudMachine.machineLevelStatus) {
                            roleProcessProcess({
                                _id: "not-present-1/" + ps.roleSpec.friendlyName + "-" + mmi,
                                friendlyName: psi,
                                roleSpec_id: ps.roleSpec._id,
                                machine_id: mmi,
                                roleType: ps.roleSpec.roleType,
                                versionType: ps.roleSpec.versionType,
                                version: "Unknown",
                                status: mm.cloudMachine.machineLevelStatus
                            });
                        } else if (!ps.seen) {
                            roleProcessProcess({
                                _id: "not-present-2/" + ps.roleSpec.friendlyName + "-" + mmi,
                                friendlyName: psi,
                                roleSpec_id: ps.roleSpec._id,
                                machine_id: mmi,
                                roleType: ps.roleSpec.roleType,
                                versionType: ps.roleSpec.versionType,
                                version: "Unknown",
                                status: {
                                    major: "Unresponsive",
                                    minor: "No probes"
                                }
                            });
                        }
                    }
                }

                setsComputeStatuses(sets);

                callback(null, {sets: sets});
            });
        });
    });
}

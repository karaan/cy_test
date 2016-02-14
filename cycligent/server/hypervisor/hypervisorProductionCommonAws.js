var os = require('os');
var url = require('url');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var child_process = require('child_process');

var agent = require('../agent.js');
var cyvisor = require('../cyvisor.js');
var hypervisor = require("./hypervisor.js");
var config = require('../configProcess.js');

var AWS = require('aws-sdk');
AWS.config.update({region: "us-west-2"});
var ec2 = new AWS.EC2();
var elb = new AWS.ELB();
var rds = new AWS.RDS();
var cloudWatch = new AWS.CloudWatch();
var metadataService = new AWS.MetadataService();

var awsDbMemoryTable = (function() {
    var memoryTable = {
        // Current generation:
        'db.m3.medium': 3.75,
        'db.m3.large': 7.5,
        'db.m3.xlarge': 15,
        'db.m3.2xlarge': 30,

        'db.r3.large': 15,
        'db.r3.xlarge': 30.5,
        'db.r3.2xlarge': 61,
        'db.r3.4xlarge': 122,
        'db.r3.8xlarge': 244,

        'db.t2.micro': 1,
        'db.t2.small': 2,
        'db.t2.medium': 4,

        // Previous Generation:
        'db.m1.small': 1.7,
        'db.m1.medium': 3.75,
        'db.m1.large': 7.5,
        'db.m1.xlarge': 15,

        'db.m2.xlarge': 17.1,
        'db.m2.2xlarge': 34.2,
        'db.m2.4xlarge': 68.4,
        'db.cr1.8xlarge': 244,

        'db.t1.micro': 0.613
    };
    for (var instanceType in memoryTable) {
        if (memoryTable.hasOwnProperty(instanceType)) {
            memoryTable[instanceType] = Math.floor(memoryTable[instanceType] * 1024 * 1024 * 1024);
        }
    }
    return memoryTable;
})();

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
};

var instanceIdsCollection;
exports.instanceIdsCollectionSet = function(collection){
    instanceIdsCollection = collection;
};

var cycligentDb;
exports.cycligentDbSet = function(db){
    cycligentDb = db;
};

function deleteMachine(state, data, callback){
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "deleteMachine: machine_id was malformed.";
        callback();
        return;
    }

    machineDocFindWithAwsInstanceId("deleteMachine", state, data, callback, function(machine, setDoc) {
        if (setDoc.machineSpec.serviceType == "rds") {
            var skipFinalSnapshot = (machine.status == undefined || machine.status.needsConfiguration == true);
            var rdsDeleteParams = {
                DBInstanceIdentifier: machine.awsInstanceId,
                SkipFinalSnapshot: skipFinalSnapshot
            };
            if (skipFinalSnapshot == false) {
                rdsDeleteParams.FinalDBSnapshotIdentifier = machine.awsInstanceId + "-final-snapshot";
            }

            rds.deleteDBInstance(rdsDeleteParams, awsResponseHandle);
        } else {
            ec2.terminateInstances({
                InstanceIds: [machine.awsInstanceId]
            }, awsResponseHandle);
        }
    });

    function awsResponseHandle(err) {
        if (err) {
            console.error("deleteMachine: An AWS error occurred while trying to delete the machine. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = "deleteMachine: An AWS error occurred while trying to delete the machine. " +
                "Error message was: " + err.message;
            callback();
            return;
        }

        machineRemoveFromDb();
    }

    function machineRemoveFromDb() {
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

            roleProcessesCollection.remove({machine_id: data.machine_id}, function(err) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "deleteMachine: A database error occurred when trying to remove the role processes.";
                    callback();
                    return;
                }

                cyvisor.environmentInfoUpdate();
                state.target.status = "success";
                callback();
            });
        });
    }
}
exports.deleteMachine = deleteMachine;

function restartMachine(state, data, callback){
    machineDocFindWithAwsInstanceId("shutdownMachine", state, data, callback, function(machineDoc, setDoc) {
        if (setDoc.machineSpec.serviceType == "rds") {
            rds.rebootDBInstance( {
                DBInstanceIdentifier: machineDoc.awsInstanceId
            }, awsResponseHandler);
        } else {
            ec2.rebootInstances({
                InstanceIds: [machineDoc.awsInstanceId]
            }, awsResponseHandler);
        }
    });

    function awsResponseHandler(err) {
        if (err) {
            console.error("restartMachine: An AWS error occurred while trying to restart the machine. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = "restartMachine: An AWS error occurred while trying to restart the machine. " +
                "Error message was: " + err.message;
            callback();
            return;
        }

        state.target.status = "success";
        callback();
    }
}
exports.restartMachine = restartMachine;

function resizeMachine(state, data, callback){
    machineDocFindWithAwsInstanceId("resizeMachine", state, data, callback, function(machineDoc, setDoc) {
        if (setDoc.machineSpec.serviceType == "rds") {
            rds.modifyDBInstance({
                DBInstanceIdentifier: machineDoc.awsInstanceId,
                DBInstanceClass: data.size,
                // TODO: 5. We might want to expose this option to the user:
                ApplyImmediately: true
            }, function(err) {
                if (err) {
                    console.error("resizeMachine: An AWS error occurred while trying to modify the machine. Error was:");
                    console.error(err);
                    state.target.status = "error";
                    state.target.error = "resizeMachine: An AWS error occurred while trying to modify the machine. " +
                        "Error message was: " + err.message;
                    callback();
                    return;
                }

                setsCollection.updateOne({"machines._id": machineDoc._id}, {
                    $set: {
                        "machines.$.status.modAt": new Date(),
                        modAt: new Date()
                    },
                    $inc: {
                        modVersion: 1
                    }
                }, function(err) {
                    if (err) {
                        console.error("machineResize: A database error occurred while trying to update machine info. " +
                            "Error was:");
                        console.error(err);
                        state.target.status = "error";
                        state.target.error = "machineResize: A database error occurred while trying to update machine info.";
                        callback();
                        return;
                    }

                    state.target.status = "success";
                    callback();
                });
            });
        } else {
            ec2.stopInstances({
                InstanceIds: [machineDoc.awsInstanceId]
            }, function(err, awsData) {
                if (err) {
                    console.error("resizeMachine: An AWS error occurred while trying to stop the machine. Error was:");
                    console.error(err);
                    state.target.status = "error";
                    state.target.error = "resizeMachine: An AWS error occurred while trying to stop the machine. " +
                        "Error message was: " + err.message;
                    callback();
                    return;
                }

                var startAfterResize = awsData.StoppingInstances[0].PreviousState.Name == "running";
                resizeMachine2(state, data.size, startAfterResize, machineDoc, callback);
            });
        }
    });
}
exports.resizeMachine = resizeMachine;

function resizeMachine2(state, instanceType, startAfterResize, machineDoc, callback) {
    ec2.describeInstanceStatus({
        IncludeAllInstances: true,
        InstanceIds: [machineDoc.awsInstanceId]
    }, function (err, data) {
        if (err) {
            console.error("resizeMachine: An error occurred while trying to get instance status information from " +
                "AWS. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = "resizeMachine: An error occurred while trying to get instance status information " +
                "from AWS. Error message was: " + err.message;
            callback();
            return;
        }

        var instanceStatus = data.InstanceStatuses[0];
        if (instanceStatus.InstanceState.Name != "stopped") {
            setTimeout(function() {
                resizeMachine2(state, instanceType, startAfterResize, machineDoc, callback);
            }, 5 * 1000);
            return;
        }

        ec2.modifyInstanceAttribute({
            InstanceId: machineDoc.awsInstanceId,
            InstanceType: {
                Value: instanceType
            }
        }, function(err) {
            if (err) {
                console.error("An AWS error occurred while trying to change an instance's type. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = "resizeMachine: An AWS error occurred while trying to change an instance's " +
                    "type. Error message was: " + err.message;
                callback();
                return;
            }

            var $set = {
                modAt: new Date()
            };
            // This presumes the only reason startAfterResize would be false is because the machine was stopped
            // when we did the resize:
            if (!startAfterResize) {
                $set['machines.$.status.major'] = 'Unresponsive';
                $set['machines.$.status.minor'] = 'Shut down machine';
                $set['machines.$.status.modAt'] = new Date();
            }

            setsCollection.updateOne({"machines._id": machineDoc._id}, {
                $set: $set,
                $inc: {
                    modVersion: 1
                }
            }, function(err) {
                if (err) {
                    console.error("machineResize: A database error occurred while trying to update machine info. " +
                        "Error was:");
                    console.error(err);
                    state.target.status = "error";
                    state.target.error = "machineResize: A database error occurred while trying to update machine info.";
                    callback();
                    return;
                }

                instanceIdsCollection.updateOne({_id: machineDoc.awsInstanceId}, {
                    $set: {
                        "machineSpec.size": instanceType,
                        modAt: new Date()
                    },
                    $inc: {
                        modVersion: 1
                    }
                }, function(err) {
                    if (err) {
                        console.error("machineResize: A database error occurred while trying to update instance info. " +
                            "Error was:");
                        console.error(err);
                        state.target.status = "error";
                        state.target.error = "machineResize: A database error occurred while trying to update instance info.";
                        callback();
                        return;
                    }

                    if (!startAfterResize) {
                        state.target.status = "success";
                        callback();
                        return;
                    }

                    ec2.startInstances({
                        InstanceIds: [machineDoc.awsInstanceId]
                    }, function(err) {
                        if (err) {
                            console.error("An AWS error occurred while trying to start an instance. Error was:");
                            console.error(err);
                            state.target.status = "error";
                            state.target.error = "resizeMachine: An AWS error occurred while trying to start an instance. " +
                                "Error message was: " + err.message;
                            callback();
                            return;
                        }

                        state.target.status = "success";
                        callback();
                    });
                });
            });
        });
    });
}

function startMachine(state, data, callback){
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "deleteMachine: machine_id was malformed.";
        callback();
        return;
    }

    machineDocFindWithAwsInstanceId("startMachine", state, data, callback, function(machineDoc) {
        ec2.startInstances({
            InstanceIds: [machineDoc.awsInstanceId]
        }, function(err) {
            if (err) {
                console.error("startMachine: An AWS error occurred while trying to start the machine. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = "startMachine: An AWS error occurred while trying to start the machine. " +
                    "Error message was: " + err.message;
                callback();
                return;
            }

            roleProcessDocsFindWithMachineId("startMachine", state, data, callback, function(roleProcessDocs) {
                var foundWebRole = false;
                for (var i = 0; i < roleProcessDocs.length; i++) {
                    var roleProcessDoc = roleProcessDocs[i];
                    if (roleProcessDoc.roleType == "web") {
                        foundWebRole = true;
                        break;
                    }
                }

                if (foundWebRole) {
                    ec2ConfigureWebServerWithLoadBalancer(machineDoc, function(err) {
                        if (err) {
                            state.target.status = "error";
                            state.target.error = "startMachine: An error occurred while trying to configure the machine " +
                                "with the load balancer. Error message was: " + err.message;
                            callback();
                        } else {
                            state.target.status = "success";
                            callback();
                        }
                    });
                } else {
                    state.target.status = "success";
                    callback();
                }
            });
        });
    });
}
exports.startMachine = startMachine;

function shutdownMachine(state, data, callback) {
    try {
        data.machine_id = new state.mongodb.ObjectID(data.machine_id);
    } catch(e) {
        state.target.status = "error";
        state.target.error = "deleteMachine: machine_id was malformed.";
        callback();
        return;
    }

    machineDocFindWithAwsInstanceId("shutdownMachine", state, data, callback, function(machineDoc) {
        ec2.stopInstances({
            InstanceIds: [machineDoc.awsInstanceId]
        }, function(err) {
            if (err) {
                console.error("shutdownMachine: An AWS error occurred while trying to shut down the machine. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = "shutdownMachine: An AWS error occurred while trying to shut down the machine. " +
                    "Error message was: " + err.message;
                callback();
                return;
            }

            roleProcessDocsFindWithMachineId("shutdownMachine", state, data, callback, function(roleProcessDocs) {
                var foundWebRole = false;
                for (var i = 0; i < roleProcessDocs.length; i++) {
                    var roleProcessDoc = roleProcessDocs[i];
                    if (roleProcessDoc.roleType == "web") {
                        foundWebRole = true;
                        break;
                    }
                }

                if (foundWebRole == false) {
                    state.target.status = "success";
                    callback();
                    return;
                }

                ec2DeregisterWebServerFromLoadBalancer(machineDoc, function(err) {
                    if (err) {
                        state.target.status = "error";
                        state.target.error = "shutdownMachine: An error occurred while trying to remove the machine from the load balancer.";
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
exports.shutdownMachine = shutdownMachine;

function createMachine(state, data, callback) {

    setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
        if (err) {
            state.target.status = "error";
            state.target.error = "createMachine: A database error occurred while trying to access the set.";
            callback();
            return;
        }

        if (setDoc.machineSpec.serviceType == "rds") {
            var namePrefix = "cyc";
            rdsInstanceCreateHandlingBoilerplate(namePrefix,
                setDoc.machineSpec.engine, setDoc.machineSpec.engineVersion, setDoc.machineSpec.license,
                setDoc.machineSpec.size, setDoc.machineSpec.storageSize, setDoc.machineSpec.storageType,
                setDoc.machineSpec.iops,
                function(instanceCreateErr, instanceData) {
                    if (instanceCreateErr) {
                        var $push = {
                            _id: new state.mongodb.ObjectID(),
                            status: {
                                major: "Unresponsive",
                                minor: "Creation error",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        };
                        if (instanceData) {
                            if (instanceData.awsInstanceId) {
                                $push.awsInstanceId = instanceData.awsInstanceId;
                            }
                            if (instanceData.subscription_id) {
                                $push.subscription_id = instanceData.subscription_id;
                            }
                        }
                        
                        setsCollection.updateOne({_id: data.set_id}, {
                            $push: {
                                machines: $push
                            },
                            $set: {
                                modAt: new Date()
                            },
                            $inc: {
                                modVersion: 1
                            }
                        }, function(err) {
                            state.target.status = "error";
                            state.target.error = "createMachine: " + instanceCreateErr.message;
                            console.error("Error occurred when trying to create machine:");
                            console.error(instanceCreateErr);
                            if (err) {
                                state.target.error += "\nAn error also occurred when trying to update the database.";
                            }

                            callback();
                        });
                        return;
                    }

                    setsCollection.updateOne({_id: data.set_id}, {
                        $push: {
                            machines: {
                                _id: new state.mongodb.ObjectID(),
                                awsInstanceId: instanceData.awsInstanceId,
                                subscription_id: instanceData.subscription_id,
                                users: {
                                    root: instanceData.password
                                },
                                status: {
                                    major: "Pending",
                                    minor: "Create machine",
                                    needsConfiguration: true,
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
                });
        } else {
            var imageType;
            if (os.platform() == "linux") {
                imageType = "ProductionUbuntuWebServerFull";
            } else {
                imageType = "ProductionWebServerFull";
            }

            setsCollection.findOne({_id: data.set_id}, function(err, setDoc) {
                if (err) {
                    state.target.status = "error";
                    state.target.error = "createMachine: A database error occurred while trying to find the set.";
                    callback();
                    return;
                }

                if (setDoc == null) {
                    state.target.status = "error";
                    state.target.error = "createMachine: No set found with the given set_id.";
                    callback();
                    return;
                }

                var machine_id = new state.mongodb.ObjectID();

                ec2InstanceCreateHandlingBoilerplate(imageType, machine_id.toString(), setDoc.machineSpec, function(instanceCreateErr, instanceData) {
                    if (instanceCreateErr) {
                        var $push = {
                            _id: new state.mongodb.ObjectID(),
                            status: {
                                major: "Unresponsive",
                                minor: "Creation error",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        };

                        if (instanceData) {
                            if (instanceData.awsInstanceId) {
                                $push.awsInstanceId = instanceData.awsInstanceId;
                            }
                            if (instanceData.subscription_id) {
                                $push.subscription_id = instanceData.subscription_id;
                            }
                        }

                        setsCollection.updateOne({_id: data.set_id}, {
                            $push: {
                                machines: $push
                            },
                            $set: {
                                modAt: new Date()
                            },
                            $inc: {
                                modVersion: 1
                            }
                        }, function(err) {
                            state.target.status = "error";
                            state.target.error = "createMachine: " + instanceCreateErr.message;
                            console.error("Error occurred when trying to create machine:");
                            console.error(instanceCreateErr);
                            if (err) {
                                state.target.error += "\nAn error also occurred when trying to update the database.";
                            }

                            callback();
                        });
                        return;
                    }

                    setsCollection.updateOne({_id: data.set_id}, {
                        $push: {
                            machines: {
                                _id: machine_id,
                                status: {
                                    major: "Pending",
                                    minor: "Create machine",
                                    needsConfiguration: true,
                                    modAt: new Date()
                                },
                                awsInstanceId: instanceData.awsInstanceId,
                                subscription_id: instanceData.subscription_id,
                                urls: ['http://' + instanceData.privateIpAddress + ':80']
                            }
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
                            return;
                        }

                        instanceIdsCollection.insertOne({
                            _id: instanceData.awsInstanceId,
                            machineSpec: setDoc.machineSpec,
                            modAt: new Date(),
                            modVersion: 1
                        }, function(err) {
                            if (err) {
                                state.target.status = "error";
                                state.target.error = "createMachine: An error occurred while trying to record instance data. " +
                                    "Error message was: " + err.message;
                                callback();
                                return;
                            }

                            cyvisor.environmentInfoUpdate();
                            state.target.status = "success";
                            callback();
                        });
                    });
                });
            });
        }
    });
}
exports.createMachine = createMachine;

function passwordGenerate(length, callback) {
    crypto.randomBytes(length, function(err, buf) {
        if (err) {
            callback(err);
            return;
        }

        var possibleChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
        var possibleCharsNumbersOnly = '1234567890';
        var password = '';
        var haveNumber = false;
        for (var i = 0; i < buf.length; i++) {
            var byte = buf[i];
            var char = possibleChars[byte % possibleChars.length];

            if (/[0-9]/.test(char)) {
                haveNumber = true;
            }

            // Windows password policy requires us to have a number, so if we get to the end without one, make sure it's
            // a number.
            if (i == buf.length-1 && haveNumber == false) {
                char = possibleCharsNumbersOnly[byte % possibleCharsNumbersOnly.length];
            }
            password += char;
        }

        callback(null, password);
    });
}
exports.passwordGenerate = passwordGenerate;

/**
 * Fetches metrics from CloudWatch.
 *
 * @param defaults
 * @param params
 * @param callback
 * @param {Object} [dataByMetric]
 */
function metricsFetch(defaults, params, callback, dataByMetric) {
    dataByMetric = dataByMetric || {};

    var param = params.shift();
    if (param) {
        for (var fieldName in defaults) {
            if (defaults.hasOwnProperty(fieldName)) {
                param[fieldName] = defaults[fieldName];
            }
        }
        fetch();
    } else {
        callback(null, dataByMetric);
    }

    function fetch() {
        cloudWatch.getMetricStatistics(param, function(err, data) {
            if (err) {
                console.error("An error occurred while trying to get " + param.Namespace + " metrics from AWS. Error was:");
                console.error(err);
                callback(err);
                return;
            }

            data = data.Datapoints;
            dataByMetric[param.MetricName] = data
                // Sort so datapoints are oldest first:
                .sort(function(a, b) {
                    return a.Timestamp.valueOf() - b.Timestamp.valueOf();
                })
                // Extract the number we care about:
                .map(function(datum) {
                    if (param.Unit == "Percent") {
                        // Our code expect decimals for percentages, not 0-100:
                        return datum.Average / 100;
                    } else {
                        return datum.Average;
                    }
                })
            ;

            metricsFetch(defaults, params, callback, dataByMetric);
        });
    }
}

function probeSql(setDoc, machineDoc, callback) {
    // CloudWatch requests cost money, so we only want Cyvisors to make them to limit the number of requests we make:
    if (!config.isCyvisor) {
        callback();
        return;
    }

    if (machineDoc.status.needsConfiguration !== false) { // !== false because it could also be undefined.
        callback();
        return;
    }

    rds.describeDBInstances({
        DBInstanceIdentifier: machineDoc.awsInstanceId
    }, function(err, data) {
        if (err) {
            console.error("probeSql: An error occurred while trying to get instance status information from AWS. Error was:");
            console.error(err);
            callback();
            return;
        }

        var instanceData = data.DBInstances[0];

        // No data about the instance. It's possible it has been deleted.
        if (!instanceData) {
            callback();
            return;
        }

        var $set = {};
        // http://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.DBInstance.Status.html
        if (instanceData.DBInstanceStatus == "available") {
            $set["machines.$.status.major"] = "Online";
            $set["machines.$.status.minor"] = "Healthy";
        } else if (["deleting", "failed", "incompatible-network", "incompatible-option-group",
                "incompatible-parameters", "incompatible-restore", "storage-full", "rebooting"
            ].indexOf(instanceData.DBInstanceStatus) != -1) {
            $set["machines.$.status.major"] = "Unresponsive";
            $set["machines.$.status.minor"] = instanceData.DBInstanceStatus;
        } else if (instanceData.DBInstanceStatus == "modifying"
            && machineDoc.status.major == "Pending" && machineDoc.status.minor == "Resize machine") {
            // Do nothing.
        } else {
            // Might be: modifying, renaming, resetting-master-credentials, backing-up, creating or a new
            // status AWS creates.
            $set["machines.$.status.major"] = "Unknown";
            $set["machines.$.status.minor"] = instanceData.DBInstanceStatus;
        }

        if (machineDoc.status.cloudWatchNextFetch && machineDoc.status.cloudWatchNextFetch > new Date()) {
            updateDatabase();
            return;
        }

        // Fetch some CloudWatch metrics.
        var samplesToStore = agent.probeSamplesToStoreGet();
        var startTime = new Date();
        startTime.setTime(startTime.getTime() - 1000 * 60 * (samplesToStore+1));
        var endTime = new Date();

        metricsFetch({
            Namespace: 'AWS/RDS',
            StartTime: startTime,
            EndTime: endTime,
            Period: 60, // Lowest resolution CloudWatch has is every 60 seconds.
            Statistics: ['Average'],
            Dimensions: [
                {
                    Name: 'DBInstanceIdentifier',
                    Value: machineDoc.awsInstanceId
                }
            ]
        }, [{
            MetricName: 'CPUUtilization',
            Unit: 'Percent'
        }, {
            MetricName: 'FreeableMemory',
            Unit: 'Bytes'
        }, {
            MetricName: 'ReadLatency',
            Unit: 'Seconds' // Want to do milliseconds, but dataset is empty if we do that.
        }, {
            MetricName: 'WriteLatency',
            Unit: 'Seconds' // Want to do milliseconds, but dataset is empty if we do that.
        }, {
            MetricName: 'NetworkTransmitThroughput',
            Unit: 'Bytes/Second'
        }, {
            MetricName: 'NetworkReceiveThroughput',
            Unit: 'Bytes/Second'
        }], function(err, dataByMetric) {
            if (err) {
                callback();
                return;
            }

            var cloudWatchNextFetch = new Date();
            cloudWatchNextFetch.setTime(cloudWatchNextFetch.getTime() + 1000 * 60);

            while (dataByMetric.CPUUtilization.length < samplesToStore) {
                dataByMetric.CPUUtilization.unshift(0);
            }

            var memTotal;
            if (awsDbMemoryTable[setDoc.machineSpec.size]) {
                memTotal = awsDbMemoryTable[setDoc.machineSpec.size];
            } else {
                // If it's an instance type we don't know about, just take the highest free memory value we've seen:
                memTotal = Math.max.apply(null, dataByMetric.FreeableMemory);
            }

            dataByMetric.FreeableMemory = dataByMetric.FreeableMemory.map(function(datum) {
                // Used memory should equal the maximum memory minus what is free:
                var percentage = (memTotal - datum) / memTotal;
                // If a resize happens, the percentage could be negative:
                return Math.max(0, percentage);
            });
            while (dataByMetric.FreeableMemory.length < samplesToStore) {
                dataByMetric.FreeableMemory.unshift(0);
            }

            dataByMetric.ReadLatency = dataByMetric.ReadLatency.map(function(datum) {
                return datum * 1000; // Convert to milliseconds.
            });
            while (dataByMetric.ReadLatency.length < samplesToStore) {
                dataByMetric.ReadLatency.unshift(0);
            }

            dataByMetric.WriteLatency = dataByMetric.WriteLatency.map(function(datum) {
                return datum * 1000; // Convert to milliseconds.
            });
            while (dataByMetric.WriteLatency.length < samplesToStore) {
                dataByMetric.WriteLatency.unshift(0);
            }

            var totalLatency = [];
            for (var i = 0; i < samplesToStore; i++) {
                totalLatency.push(dataByMetric.WriteLatency[i] + dataByMetric.ReadLatency[i]);
            }

            while (dataByMetric.NetworkTransmitThroughput.length < samplesToStore) {
                dataByMetric.NetworkTransmitThroughput.unshift(0);
            }

            while (dataByMetric.NetworkReceiveThroughput.length < samplesToStore) {
                dataByMetric.NetworkReceiveThroughput.unshift(0);
            }

            var totalNetwork = [];
            for (i = 0; i < samplesToStore; i++) {
                totalNetwork.push(
                    dataByMetric.NetworkTransmitThroughput[i] + dataByMetric.NetworkReceiveThroughput[i]
                );
            }

            $set["machines.$.status.cloudWatchNextFetch"] = cloudWatchNextFetch;
            $set["machines.$.status.probeInterval"] = agent.probeIntervalGet();

            $set["machines.$.status.cpuSamples"] = dataByMetric.CPUUtilization;
            $set["machines.$.status.memTotal"] = memTotal;
            $set["machines.$.status.memSamples"] = dataByMetric.FreeableMemory;
            $set["machines.$.status.responseTimeSamples"] = totalLatency;
            $set["machines.$.status.networkTrafficSamples"] = totalNetwork;
            $set["machines.$.status.networkTrafficToMBPerSecond"] = 1/(1024 * 1024);
            updateDatabase();
        });

        function updateDatabase() {
            $set["machines.$.status.modAt"] = new Date();
            $set["modAt"] = new Date();
            setsCollection.updateOne({_id: setDoc._id, "machines._id": machineDoc._id}, {
                $set: $set,
                $inc: {
                    modVersion: 1
                }
            }, function(err) {
                if (err) {
                    console.error("probeSql: An error occurred while trying to update server data. " +
                        "Error message was: " + err.message);
                    callback();
                } else {
                    callback();
                }
            });
        }
    });
}
exports.probeSql = probeSql;

function probeMongo(setDoc, machineDoc, callback) {
    // CloudWatch requests cost money, so we only want Cyvisors to make them to limit the number of requests we make:
    if (!config.isCyvisor) {
        callback();
        return;
    }

    var $set = {
        "machines.$.status.major": "Online",
        "machines.$.status.minor": "Healthy"
    };

    var cloudWatchResolution = 5; // That is, every five minutes there's a new data point.

    var samplesToStore = agent.probeSamplesToStoreGet();
    var startTime = new Date();
    startTime.setTime(startTime.getTime() - 1000 * 60 * cloudWatchResolution * (samplesToStore+1));
    var endTime = new Date();

    if (machineDoc.status.cloudWatchNextFetch && machineDoc.status.cloudWatchNextFetch > new Date()) {
        updateDatabase();
        return;
    }

    metricsFetch({
        Namespace: 'AWS/EC2',
        StartTime: startTime,
        EndTime: endTime,
        Period: 60 * cloudWatchResolution, // Default resolution for the Mongo server is every five minutes
        Statistics: ['Average'],
        Dimensions: [
            {
                Name: 'InstanceId',
                Value: machineDoc.awsInstanceId
            }
        ]
    }, [{
        MetricName: 'CPUUtilization',
        Unit: 'Percent'
    }, {
        MetricName: 'NetworkIn',
        Unit: 'Bytes'
    }, {
        MetricName: 'NetworkOut',
        Unit: 'Bytes'
    }], function(err, dataByMetric) {
        if (err) {
            callback();
            return;
        }

        var cloudWatchNextFetch = new Date();
        cloudWatchNextFetch.setTime(cloudWatchNextFetch.getTime() + 1000 * 60);

        while (dataByMetric.CPUUtilization.length < samplesToStore) {
            dataByMetric.CPUUtilization.unshift(0);
        }

        while (dataByMetric.NetworkIn.length < samplesToStore) {
            dataByMetric.NetworkIn.unshift(0);
        }

        while (dataByMetric.NetworkOut.length < samplesToStore) {
            dataByMetric.NetworkOut.unshift(0);
        }

        var totalNetwork = [];
        for (var i = 0; i < samplesToStore; i++) {
            totalNetwork.push(
                dataByMetric.NetworkIn[i] + dataByMetric.NetworkOut[i]
            );
        }

        $set["machines.$.status.cloudWatchNextFetch"] = cloudWatchNextFetch;
        $set["machines.$.status.probeInterval"] = agent.probeIntervalGet();
        $set["machines.$.status.cpuSamples"] = dataByMetric.CPUUtilization;
        $set["machines.$.status.networkTrafficSamples"] = totalNetwork;
        $set["machines.$.status.networkTrafficToMBPerSecond"] = 1/(1024 * 1024 * (60 * cloudWatchResolution));

        var adminDb = cycligentDb.admin();
        adminDb.serverStatus(function(err, info) {
            if (err) {
                console.error("A database error occurred while trying to get information about MongoDB's status. " +
                    "Error was:");
                console.error(err);
                callback();
                return;
            }

            var memToalMB = info.extra_info.ramMB;
            if (!memToalMB) {
                if (awsDbMemoryTable["db." + setDoc.machineSpec.size]) {
                    memToalMB = awsDbMemoryTable["db." + setDoc.machineSpec.size] / 1024 / 1024;
                } else {
                    memToalMB = info.mem.virtual;
                }
            }

            var memSamples;
            if (machineDoc.status.memSamples) {
                memSamples = machineDoc.status.memSamples;
            } else {
                memSamples = [];
            }
            while (memSamples.length < samplesToStore) {
                memSamples.unshift(0);
            }

            memSamples.shift();
            memSamples.push(info.mem.resident / memToalMB);

            $set["machines.$.status.memTotal"] = memToalMB * 1024 * 1024;
            $set["machines.$.status.memSamples"] = memSamples;

            updateDatabase();
        });
    });

    function updateDatabase() {
        $set["machines.$.status.modAt"] = new Date();
        $set["modAt"] = new Date();
        setsCollection.updateOne({_id: setDoc._id, "machines._id": machineDoc._id}, {
            $set: $set,
            $inc: {
                modVersion: 1
            }
        }, function(err) {
            if (err) {
                console.error("probeMongo: An error occurred while trying to update server data. " +
                    "Error message was: " + err.message);
                callback();
            } else {
                callback();
            }
        });
    }
}
exports.probeMongo = probeMongo;

function rdsConfigureMachine(machineDoc, callback) {
    rds.describeDBInstances({
        DBInstanceIdentifier: machineDoc.awsInstanceId
    }, function(err, data) {
        if (err) {
            console.error("An error occurred while trying to get instance status information from AWS. Error was:");
            console.error(err);
            callback();
            return;
        }

        var instanceData = data.DBInstances[0];
        if (instanceData.DBInstanceStatus == "available") {
            rdsConfigureMachine2(machineDoc, instanceData, callback);
        } else if (["deleting", "failed", "incompatible-network", "incompatible-option-group",
                "incompatible-parameters", "incompatible-restore", "storage-full"
            ].indexOf(instanceData.DBInstanceStatus) != -1) {
            rdsCreationError(machineDoc, callback);
        } else {
            callback();
        }
    });
}
exports.rdsConfigureMachine = rdsConfigureMachine;

function rdsConfigureMachine2(machineDoc, instanceData, callback) {
    setsCollection.updateOne({"machines._id": machineDoc._id}, {
        $set: {
            "machines.$.status.setByCyvisor": false,
            "machines.$.status.needsConfiguration": false,
            "machines.$.status.major": "Online",
            "machines.$.status.minor": "Healthy",
            "machines.$.status.modAt": new Date(),
            "machines.$.urls": [ instanceData.Endpoint.Address + ":" + instanceData.Endpoint.Port ],
            modAt: new Date()
        },
        $inc: {
            modVersion: 1
        }
    }, function(err) {
        if (err) {
            console.error("configureMachine: An error occurred while trying to update server data. " +
                "Error message was: " + err.message);
            callback();
        } else {
            callback();
        }
    });
}

function rdsCreationError(machineDoc, callback) {
    setsCollection.updateOne({"machines._id": machineDoc._id}, {
        $set: {
            "machines.$.status.needsConfiguration": false,
            "machines.$.status.major": "Unresponsive",
            "machines.$.status.minor": "Creation error",
            "machines.$.status.modAt": new Date(),
            modAt: new Date()
        },
        $inc: {
            modVersion: 1
        }
    }, function(err) {
        if (err) {
            console.error("configureMachine: An error occurred while trying to update server data. " +
                "Error message was: " + err.message);
            callback();
        } else {
            callback();
        }
    });
}

function ec2ConfigureWebServerWithLoadBalancer(machineDoc, callback) {
    ec2.describeInstanceStatus({
        IncludeAllInstances: true,
        InstanceIds: [machineDoc.awsInstanceId]
    }, function (err, data) {
        if (err) {
            console.error("ec2ConfigureWebServerWithLoadBalancer: An error occurred while trying to get instance status information from AWS. Error was:");
            console.error(err);
            callback(err);
            return;
        }

        var instanceStatus = data.InstanceStatuses[0];
        if (instanceStatus.InstanceState.Name != "running") {
            setTimeout(function() {
                ec2ConfigureWebServerWithLoadBalancer(machineDoc, callback);
            }, 5 * 1000);
            return;
        }

        ec2LoadBalancerSetFind(function(err, setDoc) {
            if (err) {
                console.error("ec2ConfigureWebServerWithLoadBalancer: A database error occurred while trying to find the load balancer. Error was:");
                console.error(err);
                callback(err);
                return;
            }

            if (!setDoc || setDoc.machines.length == 0) {
                console.error("ec2ConfigureWebServerWithLoadBalancer: Could not find the load balancer information in the database.");
                callback(new Error("ec2ConfigureWebServerWithLoadBalancer: Could not find the load balancer information in the database."));
                return;
            }

            var loadBalancerDoc = setDoc.machines[0];

            elb.registerInstancesWithLoadBalancer({
                Instances: [{InstanceId: machineDoc.awsInstanceId}],
                LoadBalancerName: loadBalancerDoc.awsInstanceId
            }, function(err) {
                if (err) {
                    console.error("ec2ConfigureWebServerWithLoadBalancer: An AWS error occurred while trying to " +
                        "register the machine with the load balancer. Error was:");
                    console.error(err);
                    callback(err);
                } else {
                    callback(null);
                }
            });
        });
    });
}
exports.ec2ConfigureWebServerWithLoadBalancer = ec2ConfigureWebServerWithLoadBalancer;

function ec2DeregisterWebServerFromLoadBalancer(machineDoc, callback) {
    ec2LoadBalancerSetFind(function(err, setDoc) {
        if (err) {
            console.error("ec2DeregisterWebServerFromLoadBalancer: A database error occurred while trying to find the load balancer. Error was:")
            console.error(err);
            callback(err);
            return;
        }

        if (!setDoc || setDoc.machines.length == 0) {
            console.error("ec2DeregisterWebServerFromLoadBalancer: Could not find the load balancer information in the database.");
            callback(new Error("ec2DeregisterWebServerFromLoadBalancer: Could not find the load balancer information in the database."));
            return;
        }

        var loadBalancerDoc = setDoc.machines[0];

        elb.deregisterInstancesFromLoadBalancer({
            Instances: [{InstanceId: machineDoc.awsInstanceId}],
            LoadBalancerName: loadBalancerDoc.awsInstanceId
        }, function(err) {
            if (err) {
                console.error("ec2DeregisterWebServerFromLoadBalancer: An AWS error occurred while trying to deregister the " +
                    "machine from the load balancer. Error was:");
                console.error(err);
                callback(err);
                return;
            }

            callback(null);
        });
    });
}
exports.ec2DeregisterWebServerFromLoadBalancer = ec2DeregisterWebServerFromLoadBalancer;

function machineDocFindWithAwsInstanceId(prefix, state, data, errorCallback, successCallback) {
    setsCollection.findOne({"machines._id": data.machine_id}, {
        fields: {
            "machines.$": 1,
            roleSpec: 1,
            machineSpec: 1
        }
    }, function(err, setDoc) {
        if (err) {
            console.error(prefix + ": A database error occurred while trying to fetch machine info. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = prefix + ": A database error occurred while trying to fetch machine info.";
            errorCallback();
            return;
        }

        if (!setDoc) {
            state.target.status = "error";
            state.target.error = prefix + ": Could not find set containing a machine named " + data.machine_id + ".";
            errorCallback();
            return;
        }

        var machine = setDoc.machines[0];
        if (!machine) {
            state.target.status = "error";
            state.target.error = prefix + ": Could not find a machine named " + data.machine_id + ".";
            errorCallback();
            return;
        }

        if (!machine.awsInstanceId) {
            state.target.status = "error";
            state.target.error = prefix + ": There is no AWS instance ID associated with that instance.";
            errorCallback();
            return;
        }

        successCallback(machine, setDoc);
    });
}
exports.machineDocFindWithAwsInstanceId = machineDocFindWithAwsInstanceId;

function machineDocAndInstanceInfoFind(prefix, state, data, errorCallback, successCallback) {
    machineDocFindWithAwsInstanceId(prefix, state, data, errorCallback, function(machineDoc) {
        ec2.describeInstances({
            InstanceIds: [machineDoc.awsInstanceId]
        }, function(err, data) {
            if (err) {
                console.error(prefix + ": An error occurred while trying to get instance status information from AWS. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = prefix + ": An error occurred while trying to get instance status information " +
                    "from AWS. Error message was: " + err.message;
                errorCallback();
                return;
            }

            //noinspection JSUnresolvedVariable
            var instanceData = data.Reservations[0].Instances[0];

            successCallback(machineDoc, instanceData);
        });
    });
}
exports.machineDocAndInstanceInfoFind = machineDocAndInstanceInfoFind;

function roleProcessDocsFindWithMachineId(prefix, state, data, errorCallback, successCallback) {
    roleProcessesCollection.find({machine_id: data.machine_id}).toArray(function(err, roleProcesses) {
        if (err) {
            console.error(prefix + ": A database error occurred while trying to fetch role processes. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = prefix + ": A database error occurred while trying to fetch machine info.";
            errorCallback();
            return;
        }

        successCallback(roleProcesses);
    });
}

function roleProcessDocFindWithAwsInstanceId(prefix, state, data, errorCallback, successCallback) {
    roleProcessesCollection.findOne({_id: data.roleProcess_id}, function(err, roleProcessDoc) {
        if (err) {
            console.error(prefix + ": A database error occurred while trying to fetch role process info. Error was:");
            console.error(err);
            state.target.status = "error";
            state.target.error = prefix + ": A database error occurred while trying to fetch machine info.";
            errorCallback();
            return;
        }

        if (!roleProcessDoc) {
            state.target.status = "error";
            state.target.error = prefix + ": Could not find role process named " + data.roleProcess_id + ".";
            errorCallback();
            return;
        }

        if (!roleProcessDoc.machine_id) {
            state.target.status = "error";
            state.target.error = prefix + ": There is no machine ID associated with that instance.";
            errorCallback();
            return;
        }

        setsCollection.findOne({"machines._id": roleProcessDoc.machine_id}, {
            fields: {
                "machines.$": 1
            }
        }, function(err, setDoc) {
            if (err) {
                console.error(prefix + ": A database error occurred while trying to fetch machine info. Error was:");
                console.error(err);
                state.target.status = "error";
                state.target.error = prefix + ": A database error occurred while trying to fetch machine info.";
                errorCallback();
                return;
            }

            if (!setDoc) {
                state.target.status = "error";
                state.target.error = prefix + ": Could not find set for machine named " + roleProcessDoc.machine_id + ".";
                errorCallback();
                return;
            }

            var machineDoc = setDoc.machines[0];

            if (!machineDoc) {
                state.target.status = "error";
                state.target.error = prefix + ": Could not find machine named " + roleProcessDoc.machine_id + ".";
                errorCallback();
                return;
            }

            if (!machineDoc.awsInstanceId) {
                state.target.status = "error";
                state.target.error = prefix + ": There is no AWS instance ID associated with that machine.";
                errorCallback();
                return;
            }

            successCallback(roleProcessDoc, machineDoc);
        });
    });
}
exports.roleProcessDocFindWithAwsInstanceId = roleProcessDocFindWithAwsInstanceId;

var productionImagesCache;
var productionImagesCacheExpires;
function productionImagesFetch(callback) {
    if (productionImagesCache && productionImagesCacheExpires > Date.now()) {
        // Simulate being async, so we don't accidentally mess with any logic:
        setTimeout(function() {
            callback(null, productionImagesCache);
        }, 0);
        return;
    }

    var postOptions = url.parse("https://www.cycligent.com/account/productionAmiImages");
    //var postOptions = url.parse("http://localhost:1337/account/productionAmiImages");
    postOptions.method = "GET";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': 0
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "productionImagesFetch: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
        var images;
        response.on('data', function(chunk) {
            responseData += chunk;
        }).on('end', function() {
            try {
                responseData = JSON.parse(responseData);
                for (var i = 0; i < responseData.length; i++) {
                    var datum = responseData[i];
                    if (datum.target == "cycligentCall") {
                        status = datum.status;
                        error = datum.error;
                        images = datum.images;
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "productionImagesFetch: Unable to parse the response from www.cycligent.com.";
                }
            }

            if (status == "error") {
                error = new Error("Error occurred while trying to fetch images: " + error);
            } else if (status != "success") {
                error = new Error("www.cycligent.com returned unexpected non-success status: " + status);
            } else if (status == "success") {
                productionImagesCache = images;
                productionImagesCacheExpires = Date.now() + 1000 * 60 * 60;
            }
            callback(error, images);
        });
    });

    req.on('error', function(e) {
        console.error("productionImagesFetch: Error connecting to www.cycligent.com:");
        console.error(e);
        callback(e);
    });
    req.end();
}

function vpcIdFind(callback) {
    metadataService.request('/2014-11-05/meta-data/network/interfaces/macs/', function(err, data) {
        if (err) {
            console.error("An AWS error occurred while trying to find a VPC id. Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        data = data.split('\n')[0];
        metadataService.request(
            '/2014-11-05/meta-data/network/interfaces/macs/' + data + '/vpc-id', function(err, data) {
                if (err) {
                    console.error("An AWS error occurred while trying to find a VPC id. Error message was:");
                    console.error(err);
                    callback(err);
                    return;
                }

                callback(null, data);
            });
    });
}

function securityGroupFind(vpcId, securityGroupName, callback) {
    ec2.describeSecurityGroups({
        Filters: [
            {
                Name: 'vpc-id',
                Values: [vpcId]
            },
            {
                Name: 'group-name',
                Values: [securityGroupName]
            }
        ]
    }, function(err, data) {
        if (err) {
            console.error("An AWS error occurred while trying to find a security group. Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        var securityGroup = data.SecurityGroups[0];
        if (!securityGroup) {
            callback(new Error("securityGroupFind: Could not find a security group named '" + securityGroupName + "'."));
        } else {
            callback(null, securityGroup.GroupId);
        }
    });
}

function subnetsFind(vpcId, callback) {
    ec2.describeSubnets({
        Filters: [
            {
                Name: 'vpc-id',
                Values: [vpcId]
            }
        ]
    }, function(err, data) {
        if (err) {
            console.error("An AWS error occurred while trying to find a subnet. Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        if (data.Subnets.length == 0) {
            callback(new Error("subnetsFind: Could not find any subnets."));
        } else {
            callback(null, data.Subnets.map(function(subnet) {
                return subnet.SubnetId;
            }));
        }
    });
}

function ec2InstanceCreateHandlingBoilerplate(imageType, instanceName, machineSpec, callback) {
    var instanceType = machineSpec.size;
    var storageType = machineSpec.storageType;
    var storageSize = machineSpec.storageSize;
    var iops = machineSpec.iops;

    productionImagesFetch(function(err, images) {
        if (err) {
            callback(err);
            return;
        }

        var image = images[imageType];
        if (!image) {
            callback(new Error("instanceCreateHandlingBoilerplate: Could not find the AMI image we expected to find."));
            return;
        }

        setsCollection.findOne({_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62")}, {
            fields: {
                "machines": {$slice: 1},
                "machines.subscription_id": 1,
                "machines.newMachineKey": 1
            }
        }, function(err, cyvisorDoc) {
            if (err) {
                callback(err);
                return;
            }

            cyvisorDoc = cyvisorDoc.machines[0];
            var subscription_id = cyvisorDoc.subscription_id;
            var newMachineKey = null;
            if (cyvisorDoc.newMachineKey && cyvisorDoc.newMachineKey.name) {
                newMachineKey = cyvisorDoc.newMachineKey.name;
            }

            vpcIdFind(function(err, vpcId) {
                if (err) {
                    callback(err);
                    return;
                }

                securityGroupFind(vpcId, "Cycligent Cloud Default Security Group", function(err, securityGroupId) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    subnetsFind(vpcId, function(err, subnetIds) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        ec2LoadBalancerCreateIfNeeded(subscription_id, vpcId, subnetIds, function(err) {
                            if (err) {
                                callback(err);
                                return;
                            }

                            ec2InstanceCreate(image._id, instanceType, storageType, storageSize, iops, securityGroupId, subnetIds, newMachineKey, function (err, data) {
                                if (err) {
                                    callback(err);
                                    return;
                                }

                                data.subscription_id = subscription_id;
                                instanceTag(data.awsInstanceId, instanceName, subscription_id.toString(),
                                    function(err) {
                                        if (err) {
                                            callback(err, data);
                                            return;
                                        }

                                        callback(null, data);
                                    });
                            });
                        });
                    });
                });
            });
        });
    });
}

function ec2LoadBalancerSetFind(callback) {
    setsCollection.findOne({"roleSpec.otherRoles.roleType": "loadBalancer"}, callback);
}

function ec2LoadBalancerSetCreate(callback) {
    var loadBalancerSet = {
        _id : new config.mongodb.ObjectID(),
        deploymentName: config.deploymentName,
        title: "Load Balancer Set",
        roleSpec: {
            versionedRoles: [],
            otherRoles: [{
                _id: new config.mongodb.ObjectID(),
                friendlyName: "common-load-balancer-01",
                title: "Load Balancer",
                versionType: "common",
                roleType: "loadBalancer"
            }]
        },
        machineSpec: {
            serviceType: "ec2"
        },
        machines: []
    };

    setsCollection.insert(loadBalancerSet, function(err) {
        if (err) {
            callback(err);
        } else {
            callback(null, loadBalancerSet);
        }
    });
}

function ec2LoadBalancerSetFindOrCreate(callback) {
    ec2LoadBalancerSetFind(function(err, setDoc) {
        if (err) {
            callback(err);
            return;
        }

        if (!setDoc) {
            ec2LoadBalancerSetCreate(callback);
        } else {
            callback(null, setDoc);
        }
    });
}

// This function should only create a load balancer if none exists already.
function ec2LoadBalancerCreateIfNeeded(subscription_id, vpcId, subnetIds, callback) {
    ec2LoadBalancerSetFindOrCreate(function(err, setDoc) {
        if (err) {
            console.error("ec2LoadBalancerCreate: A database error occurred while trying to find the load balancer. Error was:");
            console.error(err);
            callback(err);
            return;
        }

        if (setDoc.machines.length > 0) {
            // It already exists, so just return.
            callback(null);
            return;
        }

        securityGroupFind(vpcId, "Cycligent Cloud ELB Security Group", function(err, securityGroupId) {
            if (err) {
                callback(err);
                return;
            }

            passwordGenerate(12, function(err, randomChars) {
                if (err) {
                    callback(err);
                    return;
                }

                var loadBalancerName = 'cmmn-lod-' + randomChars;
                elb.createLoadBalancer({
                    Listeners: [
                        {
                            InstancePort: 80,
                            LoadBalancerPort: 80,
                            Protocol: 'HTTP'
                        }
                    ],
                    LoadBalancerName: loadBalancerName,
                    SecurityGroups: [securityGroupId],
                    Subnets: subnetIds,
                    Tags: [
                        {
                            Key: 'Cycligent',
                            Value: 'true'
                        },
                        {
                            Key: 'subscription_id',
                            Value: subscription_id.toString()
                        }
                    ]
                }, function(err) {
                    if (err) {
                        console.error("ec2LoadBalancerCreate: An AWS error occurred while trying to create an elastic load " +
                            "balancer. Error message was:");
                        console.error(err);
                        callback(err);
                        return;
                    }

                    elb.modifyLoadBalancerAttributes({
                        LoadBalancerAttributes: {
                            ConnectionDraining: {
                                Enabled: true,
                                Timeout: 300
                            },
                            ConnectionSettings: {
                                IdleTimeout: 120
                            },
                            CrossZoneLoadBalancing: {
                                Enabled: true
                            }
                        },
                        LoadBalancerName: loadBalancerName
                    }, function(err) {
                        if (err) {
                            console.error("ec2LoadBalancerCreate: An AWS error occurred while trying to modify an " +
                                "elastic load balancer. Error message was:");
                            console.error(err);
                            callback(err);
                            return;
                        }

                        elb.configureHealthCheck({
                            HealthCheck: {
                                Interval: 6,
                                Timeout: 5,
                                HealthyThreshold: 4,
                                UnhealthyThreshold: 2,
                                Target: 'HTTP:80/cycligent/agent/probe'
                            },
                            LoadBalancerName: loadBalancerName
                        }, function(err) {
                            if (err) {
                                console.error("ec2LoadBalancerCreate: An AWS error occurred while trying to " +
                                    "configure an elastic load balancer. Error message was:");
                                console.error(err);
                                callback(err);
                                return;
                            }

                            setsCollection.updateOne({_id: setDoc._id}, {
                                $push: {
                                    machines: {
                                        _id: new config.mongodb.ObjectID(),
                                        awsInstanceId: loadBalancerName,
                                        subscription_id: subscription_id,
                                        status: {
                                            major: "Online",
                                            minor: "Healthy",
                                            needsConfiguration: false,
                                            modAt: new Date()
                                        }
                                    }
                                }
                            }, function(err) {
                                if (err) {
                                    console.error("ec2LoadBalancerCreate: A database error occurred while trying to " +
                                        "save the load balancer information. Error was:");
                                    console.error(err);
                                    callback(err);
                                } else {
                                    callback(null);
                                }
                            });
                        });
                    });
                });
            });
        });
    });
}

function ec2InstanceCreate(imageId, instanceType, storageType, storageSize, iops, securityGroupId, subnetIds, newMachineKeyName, callback) {
    var subnet = subnetIds[Math.floor(Math.random() * subnetIds.length)];

    var params = {
        ImageId: imageId,
        MaxCount: 1,
        MinCount: 1,
        BlockDeviceMappings: [
            {
                DeviceName: '/dev/sda1',
                Ebs: {
                    DeleteOnTermination: true,
                    VolumeSize: storageSize,
                    VolumeType: storageType
                }
            }
        ],
        DisableApiTermination: false,
        InstanceInitiatedShutdownBehavior: 'stop',
        InstanceType: instanceType,
        Monitoring: {
            Enabled: false
        },
        NetworkInterfaces: [
            {
                AssociatePublicIpAddress: true,
                DeleteOnTermination: true ,
                DeviceIndex: 0,
                Groups: [securityGroupId],
                SubnetId: subnet
            }
        ]
    };

    if (iops) {
        params.BlockDeviceMappings[0].Ebs.Iops = iops;
    }

    if (newMachineKeyName) {
        params.KeyName = newMachineKeyName;
    }

    ec2.runInstances(params, function(err, data) {
        if (err) {
            console.error("ec2InstanceCreate: An AWS error occurred while trying to create an EC2 instance. " +
                "Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        callback(null, {
            awsInstanceId: data.Instances[0].InstanceId,
            privateIpAddress: data.Instances[0].PrivateIpAddress
        });
    });
}

function instanceTag(instanceId, instanceName, subscription_id, callback) {
    ec2.createTags({
        Resources: [instanceId],
        Tags: [
            {
                Key: 'Name',
                Value: instanceName
            },
            {
                Key: 'Cycligent',
                Value: 'true'
            },
            {
                Key: 'subscription_id',
                Value: subscription_id
            }
        ]
    }, function(err) {
        if (err) {
            if (err.code == "InvalidInstanceID.NotFound") {
                // We must've called the API a little too soon, wait a moment and try again.
                setTimeout(function() {
                    instanceTag(instanceId, instanceName, subscription_id, callback)
                }, 1000);
                return;
            }
            console.error("An AWS error occurred while trying to tag an instance. Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        callback(null);
    });
}

function rdsInstanceCreateHandlingBoilerplate(namePrefix, engine, engineVersion, license, instanceType,
                                              allocatedStorage, storageType, iops, callback) {
    vpcIdFind(function(err, vpcId) {
        if (err) {
            callback(err);
            return;
        }

        var subnetGroup = 'cycligent-db-subnet-group-' + vpcId;

        securityGroupFind(vpcId, "Cycligent Cloud Database Security Group", function(err, securityGroupId) {
            if (err) {
                callback(err);
                return;
            }

            // We add some extra characters to the name to help ensure it's unique.
            passwordGenerate(15 - namePrefix.length - 1, function(err, randomChars) {
                if (err) {
                    callback(err);
                    return;
                }

                var instanceId = (namePrefix + "-" + randomChars).toLowerCase();

                passwordGenerate(30, function(err, password) {
                    if (err) {
                        callback(err);
                        return;
                    }

                    setsCollection.findOne({_id: new config.mongodb.ObjectID("5579d80f1e68bca12b62aa62")}, {
                        fields: {
                            "machines": {$slice: 1},
                            "machines.subscription_id": 1
                        }
                    }, function(err, cyvisorDoc) {
                        if (err) {
                            callback(err);
                            return;
                        }

                        cyvisorDoc = cyvisorDoc.machines[0];

                        var subscription_id = cyvisorDoc.subscription_id.toString();

                        rdsInstanceCreate(instanceId, engine, engineVersion, license, instanceType, allocatedStorage,
                            storageType, iops, password, securityGroupId, subnetGroup, subscription_id,
                            function(err, data) {
                                if (data) {
                                    data.subscription_id = cyvisorDoc.subscription_id;
                                    data.password = password;
                                }
                                callback(err, data);
                            });
                    });
                });
            });
        });
    });
}

function rdsInstanceCreate(instanceId, engine, engineVersion, license, instanceSize, allocatedStorage,
                           storageType, iops, password, securityGroup, subnetGroup, subscription_id, callback) {
    // TODO: 3. Currently there is no way for the user to tell us that they want their database to be publicly available.
    // TODO: 5. The UI and the code aren't setup to let the user choose whether or not they want their RDS database in multiple availability zones.
    // TODO: 5. The UI and the code aren't setup to let the user set their backup retention period.

    var params = {
        AllocatedStorage: allocatedStorage,
        DBInstanceClass: instanceSize,
        DBInstanceIdentifier: instanceId,
        Engine: engine,
        MasterUsername: 'root',
        MasterUserPassword: password,
        AutoMinorVersionUpgrade: true,
        BackupRetentionPeriod: 7,
        DBSubnetGroupName: subnetGroup,
        EngineVersion: engineVersion,
        LicenseModel: license,
        PubliclyAccessible: true,
        StorageEncrypted: false,
        StorageType: storageType,
        Tags: [
            {
                Key: 'Cycligent',
                Value: 'true'
            },
            {
                Key: 'subscription_id',
                Value: subscription_id
            }
        ],
        VpcSecurityGroupIds: [securityGroup]
    };

    params.MultiAZ = (engine != "sqlserver-web" && engine != "sqlserver-ex");

    if (storageType == "io1" && iops) {
        params.Iops = iops;
    }

    rds.createDBInstance(params, function(err) {
        if (err) {
            console.error("rdsInstanceCreate: An AWS error occurred while trying to create an RDS instance. " +
                "Error message was:");
            console.error(err);
            callback(err);
            return;
        }

        callback(null, {
            awsInstanceId: instanceId
        });
    });
}
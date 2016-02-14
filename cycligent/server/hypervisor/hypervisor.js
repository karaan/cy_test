var os = require('os');

var mongodb = require('mongodb');
var AWS = require('aws-sdk');
AWS.config.update({region: "us-west-2"});
var rds = new AWS.RDS();

var config;
var cyvisor = require("./../cyvisor.js");
var defaultData = require('.././defaultData.js');

process.nextTick(function() {
    config = require('../configProcess.js');
});

// We hardcode the versions as of 2/5/2015 so we'll always have this data, but below we fetch it from AWS so we'll have the most up-to-date version.
var dbVersions = {
    "mysql": ["5.1.73a","5.1.73b","5.5.40","5.5.40a","5.5.40b","5.6.19a","5.6.19b","5.6.21","5.6.21b"],
    "postgres": ["9.3.1","9.3.2","9.3.3","9.3.5"],
    "sqlserver-ex": ["10.50.2789.0.v1","11.00.2100.60.v1"],
    "sqlserver-ee": ["10.50.2789.0.v1","11.00.2100.60.v1"],
    "sqlserver-se": ["10.50.2789.0.v1","11.00.2100.60.v1"],
    "sqlserver-web": ["10.50.2789.0.v1","11.00.2100.60.v1"],
    "oracle-se1": ["11.2.0.2.v3","11.2.0.2.v4","11.2.0.2.v5","11.2.0.2.v6","11.2.0.2.v7","11.2.0.3.v1","11.2.0.3.v2","11.2.0.4.v1","11.2.0.4.v3"],
    "oracle-se": ["11.2.0.2.v3","11.2.0.2.v4","11.2.0.2.v5","11.2.0.2.v6","11.2.0.2.v7","11.2.0.3.v1","11.2.0.3.v2","11.2.0.4.v1","11.2.0.4.v3"],
    "oracle-ee": ["11.2.0.2.v3","11.2.0.2.v4","11.2.0.2.v5","11.2.0.2.v6","11.2.0.2.v7","11.2.0.3.v1","11.2.0.3.v2","11.2.0.4.v1","11.2.0.4.v3"]
};

var dbLicenseDefault = {
    "mysql": "general-public-license",
    "postgres": "postgresql-license",
    "sqlserver-ex": "license-included",
    "sqlserver-ee": "bring-your-own-license",
    "sqlserver-se": "license-included",
    "sqlserver-web": "license-included",
    "oracle-se1": "license-included",
    "oracle-se": "bring-your-own-license",
    "oracle-ee": "bring-your-own-license"
};

function dbVersionsUpdate() {
    rds.describeDBEngineVersions({}, function(err, data) {
        if (err) {
            console.error("describeDBEngineVersions error:");
            console.error(err);
            return;
        }

        data = data.DBEngineVersions;
        var newDbVersions = {
            "mysql": [],
            "postgres": [],
            "sqlserver-ex": [],
            "sqlserver-ee": [],
            "sqlserver-se": [],
            "sqlserver-web": [],
            "oracle-se1": [],
            "oracle-se": [],
            "oracle-ee": []
        };
        for (var i = 0; i < data.length; i++) {
            var versionArray = newDbVersions[data[i].Engine];
            if (versionArray) {
                versionArray.push(data[i].EngineVersion);
            } else {
                console.error("dbVersionsUpdate: Skipping RDS engine: " + data[i].Engine);
            }
        }

        dbVersions = newDbVersions;
    });
}

function dbVersionsGet() {
    return dbVersions;
}

exports.dbVersionsGet = dbVersionsGet;

var flavor = null;

var config;
function configSet(configArg){
    config = configArg;
}
exports.configSet = configSet;

function accountChecked(accountStatus) {
    if (config.deploymentName != "minimal" && config.deploymentName != "local" && accountStatus == "active") {
        dbVersionsUpdate();
    }
    flavorSet(accountStatus);
}
exports.accountChecked = accountChecked;

function flavorSet(accountStatus) {

    switch(config.deploymentName){

        case "minimal":
            flavor = require("./hypervisorMinimal.js");
            break;

        case "local":
            flavor = require("./hypervisorLocal.js");
            break;

        case "aws":
            if (accountStatus == "active") {
                switch(os.platform()){
                    case "win32":
                        flavor = require("./hypervisorProductionWindowsAws.js");
                        break;
                    case "linux":
                        flavor = require("./hypervisorProductionUbuntuAws.js");
                        break;
                }
            } else { // We're in a demo
                flavor = require("./hypervisorDemoAws.js");
            }
            break;

        default:
            new Error("Cycligent Server doesn't yet know how to perform actions on machines in deployment type '"
            + config.deploymentName + "'");
            break;
    }

    if(roleProcessesCollection && setsCollection && flavor.roleProcessesCollectionSet){
        flavor.roleProcessesCollectionSet(roleProcessesCollection, setsCollection);
    }
    if (instanceIdsCollection && flavor.instanceIdsCollectionSet){
        flavor.instanceIdsCollectionSet(instanceIdsCollection);
    }
    if(cycligentDb && flavor.cycligentDbSet){
        flavor.cycligentDbSet(cycligentDb);
    }
}

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
    if(flavor && flavor.roleProcessesCollectionSet){
        flavor.roleProcessesCollectionSet(roleProcessesCollection, setsCollection);
    }
};

var instanceIdsCollection;
exports.instanceIdsCollectionSet = function(collection){
    instanceIdsCollection = collection;
    if(flavor && flavor.instanceIdsCollectionSet){
        flavor.instanceIdsCollectionSet(instanceIdsCollection);
    }
};

var cycligentDb;
exports.cycligentDbSet = function(db){
    cycligentDb = db;
    if(flavor && flavor.cycligentDbSet){
        flavor.cycligentDbSet(cycligentDb);
    }
};

function action(state, data, callback){
    if(flavor){
        flavor.action(state, data, callback);
    } else {
        state.target.status = "error";
        state.target.error = "Cycligent Server doesn't yet know how to perform actions on machines in deployment type '"
            + config.deploymentName + "'";
        callback();
    }
}
exports.action = action;

function configureMachine(machineDoc, setDoc, callback) {
    if(flavor && flavor.configureMachine){
        flavor.configureMachine(machineDoc, setDoc, callback);
    } else {
        console.error("Cycligent Server doesn't yet know how to configure machines in deployment type '"
            + config.deploymentName + "'");
        callback();
    }
}
exports.configureMachine = configureMachine;

function probeSql(setDoc, machineDoc, callback) {
    if(flavor && flavor.probeSql){
        flavor.probeSql(setDoc, machineDoc, callback);
    } else {
        console.error("Cycligent Server doesn't yet know how to probe SQL servers in deployment type '"
            + config.deploymentName + "'");
        callback();
    }
}
exports.probeSql = probeSql;

function probeMongo(setDoc, machineDoc, callback) {
    if(flavor && flavor.probeMongo){
        flavor.probeMongo(setDoc, machineDoc, callback);
    } else {
        console.error("Cycligent Server doesn't yet know how to probe MongoDB servers in deployment type '"
            + config.deploymentName + "'");
        callback();
    }
}
exports.probeMongo = probeMongo;

function storageParamsNormalize(data) {
    data.storageType = data.storageType || "gp2";
    data.storageSize = data.storageSize || 100;
    if (data.storageType == "io1") {
        data.iops = data.iops || 2000;
    } else {
        data.iops = null;
    }
    return data;
}
exports.storageParamsNormalize = storageParamsNormalize;

function sqlParamsNormalize(data) {
    if (!data.engine && data.type) {
        data.engine = data.type.replace("rds:", "");
    }
    var engineVersions = dbVersions[data.engine];

    if (engineVersions) {
        data.engineVersion = data.engineVersion || engineVersions[engineVersions.length-1];
    }
    data.license = data.license || dbLicenseDefault[data.engine];
    storageParamsNormalize(data);

    return data;
}
exports.sqlParamsNormalize = sqlParamsNormalize;

/**
 * Preannounces a roleProcess.
 *
 * @param {State|Null} state
 * @param {Object} data
 * @param {Function} errorCallback
 * @param {Function} successCallback
 */
function commonCreate(state, data, errorCallback, successCallback) {
    commonCreate2(state, data, roleProcessesCollection, errorCallback, successCallback);
}
exports.commonCreate = commonCreate;

/**
 * Preannounces a roleProcess in the specified collection.
 *
 * @param {State|Null} state
 * @param {Object} data
 * @param {mongodb.Collection} roleProcessesCollection
 * @param {Function} errorCallback
 * @param {Function} successCallback
 */
function commonCreate2(state, data, roleProcessesCollection, errorCallback, successCallback){

    var version = "";
    if (config.versionType) {
        version = config.versions[config.versionType] || "";
    }

    data.roleProcess_id = data.roleProcess_id || new mongodb.ObjectID();

    if (data.roleType == "sql") {
        sqlParamsNormalize(data);

        preannouncePresenceSql(
            roleProcessesCollection,
            data.roleProcess_id, config.deploymentName, data.friendlyName, data.roleSpec_id, data.machine_id || null,
            data.set_id, data.roleType || "", version, data.versionType || "", data.engine,
            data.engineVersion, data.license, data.storageType, data.storageSize,
            data.iops, finish);
    } else {
        preannouncePresence(
            roleProcessesCollection,
            data.roleProcess_id, config.deploymentName, data.friendlyName, data.roleSpec_id, data.machine_id || null,
            data.set_id, data.roleType || "", version, data.versionType || "", data.urls || [], finish);
    }

    function finish(err) {
        if (err) {
            if (state) {
                state.target.status = "error";
                state.target.error = "machineCreate: An error occurred when trying to preannounce the role process." +
                    " Error message was: " + err.message;
            }
            errorCallback(err);
            return;
        }

        successCallback();
    }
}
exports.commonCreate2 = commonCreate2;

/**
 * In advance, before the role process comes online, announce it's presence in the roleProcesses collection,
 * so we'll know a role process isn't around yet.
 *
 * @param {mongodb.Collection} roleProcessesCollection
 * @param {ObjectID} _id
 * @param {String} deploymentName
 * @param {String} friendlyName
 * @param {ObjectID} roleSpec_id
 * @param {ObjectID} machine_id
 * @param {ObjectID} set_id
 * @param {String} roleType
 * @param {String} version
 * @param {String} versionType
 * @param {String[]} urls
 * @param {Function} callback
 */
function preannouncePresence(roleProcessesCollection,
                             _id, deploymentName, friendlyName, roleSpec_id, machine_id, set_id, roleType, version,
                             versionType, urls, callback) {
    roleProcessesCollection.updateOne({_id: _id}, {
        $set: {
            deploymentName: deploymentName,
            friendlyName: friendlyName,
            roleSpec_id: roleSpec_id,
            machine_id: machine_id,
            set_id: set_id,
            roleType: roleType,
            version: version,
            versionType: versionType,
            urls: urls,
            modAt: new Date(),
            "status.setByCyvisor": true,
            "status.modAt": new Date(),
            "status.major": "Pending",
            "status.minor": "Create machine"
        },
        $inc: {modVersion: 1}
    }, {upsert: true}, function(err) {
        if (err) {
            console.error("An error occurred when trying to preannounce the role process." +
                " Error message was: " + err.message);
            callback(err);
        } else {
            callback();
        }
    });
}

// TODO: 5. This likely won't get called anymore. Remove after 7/31/2015:
/**
 * In advance, before the role process comes online, announce it's presence in the roleProcesses collection,
 * so we'll know a role process isn't around yet.
 *
 * @param {mongodb.Collection} roleProcessesCollection
 * @param {ObjectID} _id
 * @param {String} deploymentName
 * @param {String} friendlyName
 * @param {ObjectID} roleSpec_id
 * @param {ObjectID} machine_id
 * @param {ObjectID} set_id
 * @param {String} roleType
 * @param {String} version
 * @param {String} versionType
 * @param {String} engine
 * @param {String} engineVersion
 * @param {String} license
 * @param {String} storageType
 * @param {String} storageSize
 * @param {String} iops
 * @param {Function} callback
 */
function preannouncePresenceSql(roleProcessesCollection,
                                _id, deploymentName, friendlyName, roleSpec_id, machine_id, set_id, roleType, version,
                                versionType, engine, engineVersion, license, storageType, storageSize, iops, callback) {
    roleProcessesCollection.updateOne({_id: _id}, {
        $set: {
            deploymentName: deploymentName,
            friendlyName: friendlyName,
            roleSpec_id: roleSpec_id,
            machine_id: machine_id,
            set_id: set_id,
            roleType: roleType,
            version: version,
            versionType: versionType,
            urls: [],
            modAt: new Date(),

            engine: engine,
            engineVersion: engineVersion,
            license: license,
            storageType: storageType,
            storageSize: storageSize,
            iops: iops,

            "status.setByCyvisor": true,
            "status.modAt": new Date(),
            "status.major": "Pending",
            "status.minor": "Create machine"
        },
        $inc: {modVersion: 1}
    }, {upsert: true}, function(err) {
        if (err) {
            console.error("An error occurred when trying to preannounce the role process." +
            " Error message was: " + err.message);
            callback(err);
        } else {
            callback();
        }
    });
}

function demoSqlSetCheckAndInsert(engine) {
    // Make sure the SQL set is in the database if we have a SQL server:
    setsCollection.findOne({"machineSpec.serviceType": "rds"}, function(err, setDoc) {
        if (err) {
            console.error("demoSqlSetCheckAndInsert: Error accessing database:");
            console.error(e);
            return;
        }

        if (setDoc) {
            return;
        }

        setDoc = defaultData.trial.sqlSet()[0];
        setDoc.machineSpec.engine = engine;
        setDoc.machineSpec.engineVersion = dbVersions[engine][0];
        setDoc.machineSpec.license = dbLicenseDefault[engine];
        setDoc.roleSpec.otherRoles[0].title = "SQL Server (" + engine + ")";

        setsCollection.insertOne(setDoc, function(err) {
            if (err) {
                console.error("demoSqlSetCheckAndInsert: Error inserting document into database:");
                console.error(e);
            }
        })
    });
}
exports.demoSqlSetCheckAndInsert = demoSqlSetCheckAndInsert;
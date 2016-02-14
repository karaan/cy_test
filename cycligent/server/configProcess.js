var fs = require('fs');
var path = require('path');
var url = require('url');
/**@type {ServerConfig}*/ var config = require('../../config.js');
var cycligentProxy = require('./proxy.js');
var authenticators = require('./authenticators.js');
var defaultData = require('./defaultData.js');
var mongodb = require('mongodb');

//=============================//
//===== MAIN MODULE LOGIC =====//
//=============================//

var errorCount = 0;

function configProcessStageOne(callback) {
    rootsProcess();
    copyBlocks();
    configSetUsefulValues();
    configPreValidate();
    commandLineSelect();
    cycligentDbConnectInitAndQuery(function() {
        checkErrorCount();
        callback();
    });
    checkErrorCount();
}

function configProcessStageTwo() {
    roleProcessConfigValuesSet();
    versionsSet();
    configValidate();
    optimize();
    anonymousPathsCompile();
    checkErrorCount();
}

function checkErrorCount() {
    if(errorCount > 0){
        //TODO: 5. Currently not all errors are displayed because stderr is not flushed properly no node exit. Only the first error is displayed.
        throw new Error('Errors were found in configuration file. Startup halted.');
    }
}

module.exports = config;
module.exports.configProcessExecute = function(callback) {

    configProcessStageOne(function() {
        checkErrorCount();
        configProcessStageTwo();

        callback();
    });
};

//============================//
//===== MODULE FUNCTIONS =====//
//============================//

function copyBlocks(){

    var changeMade = true;
    while(changeMade){
        changeMade = copyBlocksRecursive('config','config',config);
    }
}

function cloneConfigBlock(block){

    function regExFixUp(block,clone){

        var propertyName;
        var property;
        for(propertyName in block){
            property = block[propertyName];
            if(property != null && typeof(property) == "object"){
                if(property instanceof RegExp){
                    clone[propertyName] = new RegExp(property.source);
                } else {
                    clone[propertyName] = {};
                    regExFixUp(property,clone[propertyName]);
                }
            } else {
                clone[propertyName] = block[propertyName];
            }
        }

        return clone;
    }

    if (typeof block == "string") {
        return block;
    } else if (typeof block == "function") {
        return block;
    } else {
        return regExFixUp(block,{});
    }
}

function copyBlocksRecursive(propertyChain,property,ref){

    var changeMade = false;

    if(ref.copyBlock){
        try{
            var overrides = ref.copyOverrides;
            eval( propertyChain + '=cloneConfigBlock(config.' + ref.copyBlock + ');' );
            changeMade = true;
            if(overrides){
                for(var override in overrides){
                    eval( propertyChain + '["' + override + '"]=cloneConfigBlock(overrides[override]);');
                }
            }
        } catch(ex){
            errorCount++;
            console.error('Invalid copyBlock reference found in configuration. Property chain: ' + propertyChain + ', copyBlock: ' + ref.copyBlock);
            console.error(ex.message);
            return false;
        }
    }

    for(var property in ref){
        if(ref.hasOwnProperty(property) && !(!isNaN(parseFloat(property)) && isFinite(property))){
            if(ref[property]){
                changeMade |= copyBlocksRecursive(propertyChain + "." + property,property,ref[property]);
            }
        }
    }

    return changeMade;
}

/**
 * Validate some things earlier in the process so that weird errors don't occur later in the configuration processing.
 */
function configPreValidate(){
    var deploymentIndex;
    var deployment;

    for(deploymentIndex in config.deployments){
        deployment = config.deployments[deploymentIndex];

        if (deployment.agentDefaults) {
            if (!deployment.agentDefaults.probe) {
                deployment.agentDefaults.probe = {enabled: false};
            }
            if (!deployment.agentDefaults.control) {
                deployment.agentDefaults.control = {enabled: false};
            }
            if (deployment.agentDefaults.probe.enabled == false && deployment.agentDefaults.control.enabled == true) {
                errorCount++;
                console.error("Error: In deployment '" + deploymentIndex + "' agentDefaults has probe enabled, and control disabled. Control needs probe to function properly, please enable probe.");
            }
            if (deployment.agentDefaults.control.enabled) {
                if (config.roots['cycligent']) {
                    if (!config.roots['cycligent'].supports || !config.roots['cycligent'].supports.provider) {
                        errorCount++;
                        console.error("Error: The deployment '" + deploymentIndex + "' has enabled Cycligent Agent control, but the cycligent root is not configured to support 'provider'. Please set roots.cycligent.supports.provider = true in the configuration.");
                    }
                }
            }
        }

        for(var versionTypeName in config.versions) {
            if (deployment.versionTypes[versionTypeName] === undefined && deployment.versionTypes["common"]) {
                deployment.versionTypes[versionTypeName] = cloneConfigBlock(deployment.versionTypes["common"]);
            }
        }

        for(var versionTypeName in deployment.versionTypes){
            var versionType = deployment.versionTypes[versionTypeName];

            for(var dbName in versionType.dbs){
                if(dbName == 'messageBus'){
                    errorCount++;
                    console.error("CONFIG ERROR: Version type '" + versionTypeName + "' in deployment '" + deploymentIndex + "' has a database named 'messageBus' which is a reserved system database name.");
                }

                if (versionType.dbs[dbName].uri.indexOf("AWS_AUTO_CONFIGURED_MONGODB/") != -1) {
                    versionType.dbs[dbName].uri = makeAWSConnectionString(versionType.dbs[dbName].uri);
                }
                mongoDBNativeParserWorkaround(dbName, versionType.dbs[dbName]);
            }
        }

        if (!deployment.versionTypes["common"]) {
            console.error("CONFIG ERROR: Deployment '" + deploymentIndex + "' does not have a versionTypes database section for 'common'.");
            errorCount++;
        }

        if (!deployment.versionTypes["common"].dbs.cycligent) {
            console.error("CONFIG ERROR: Deployment '" + deploymentIndex + "' does not have a versionTypes database section in 'common' for 'cycligent'.");
            errorCount++;
        }
    }

    if(errorCount > 0){
        throw new Error('Errors were found in configuration file. Startup halted.');
    }
}

function configSetUsefulValues() {
    var versionTypeName;
    var versionType;

    config.roleProcesses = {};
    if (!config.versions && config.versionTypes) {
        config.versions = {};
        for (versionTypeName in config.versionTypes) {
            if (config.versionTypes.hasOwnProperty(versionTypeName)) {
                versionType = config.versionTypes[versionTypeName];
                config.versions[versionTypeName] = versionType.version;
            }
        }
    }

    for (versionTypeName in config.versionTypes) {
        if (config.versionTypes.hasOwnProperty(versionTypeName)) {
            versionType = config.versionTypes[versionTypeName];
            versionType._id = versionTypeName;

            if (versionType.webServerDynamicRequestsEnabled) {
                config.versionTypeWithWebServerDynamicRequestsEnabled = versionType;
            }
        }
    }
    if (!config.versionTypeWithWebServerDynamicRequestsEnabled) {
        config.versionTypeWithWebServerDynamicRequestsEnabled = {
            _id: 'prod',
            version: 'M.m.B',
            webServerDynamicRequestsEnabled: true
        };
    }
}

function roleProcessValidate(roleProcess) {
    var roleProcessIndex = roleProcess.name;
    var deployment = roleProcess.deployment;

    if(config.roleProcesses[roleProcessIndex]){
        throw new Error("Duplicate roleProcess name '" + roleProcessIndex + "' detected in configuration file. Role process names must be globally unique.  Startup process halted.");
    } else {
        config.roleProcesses[roleProcessIndex] = roleProcess;
    }

    if (!roleProcess.size) {
        roleProcess.size = "unknown";
    }

    if(!roleProcess.versionType){
        throw new Error("Missing versionType detected for roleProcess '" + roleProcess.name + "'.  Startup process halted.");
    }

    if(!roleProcess.roleType){
        throw new Error("Missing roleType detected for roleProcess '" + roleProcess.name + "'.  Startup process halted.");
    }

    if(roleProcess.versionType == 'common'){
        for (var versionTypeName in config.versionTypes) {
            if (config.versionTypes.hasOwnProperty(versionTypeName)) {
                var versionType = config.versionTypes[versionTypeName];

                if (versionType.webServerDynamicRequestsEnabled) {
                    roleProcess.version = versionType.version;
                    break;
                }
            }
        }
    } else {
        if (!config.versions[roleProcess.versionType]) {
            config.versions[roleProcess.versionType] = "M.m.B";
        }
        roleProcess.version = config.versions[roleProcess.versionType];
    }

    if(roleProcess.roleType != 'web' && roleProcess.roleType != 'worker' && roleProcess.roleType != 'longWorker' && roleProcess.roleType != 'mongo' && roleProcess.roleType != 'sql' && roleProcess.roleType != 'cyvisor' && roleProcess.roleType != 'dir'){
        throw new Error("Unknown roleType '" + roleProcess.roleType + "' detected in configuration file for roleProcess '" + roleProcess.name + "'.  Startup process halted.");
    }

    if(!roleProcess.processes && roleProcess.roleType != 'mongo' && roleProcess.roleType != 'sql' && roleProcess.roleType != 'cyvisor' && roleProcess.roleType != 'dir'){
        if(deployment.processDefaults[roleProcess.roleType]){
            roleProcess.processes = deployment.processDefaults[roleProcess.roleType];
        } else {
            throw new Error("Role process '" + roleProcess.name + "' does not have the items it processes configured. Startup process halted.");
        }
    }

    if (roleProcess.agent) {
        throw new Error("Role process '" + roleProcess.name + "' has it's own Cycligent Agent configuration. Cycligent Agent currently doesn't support configuration on a per-roleProcess basis. Please specify agentDefaults for the whole deployment.");
    }

    if(!roleProcess.agent){
        if(deployment.agentDefaults){
            roleProcess.agent = deployment.agentDefaults;
        } else {
            throw new Error("Role process '" + roleProcess.name + "' is missing an agent configuration, and no default agent configuration has been specified for the deployment. Startup process halted.");
        }
    }
}

function baseValuesSetViaRoleProcessId(roleProcess_id){

    var roleProcess = config.roleProcesses[roleProcess_id];

    if(roleProcess){
        config.roleProcess = roleProcess;
        config.deploymentName = roleProcess.deploymentName;
        config.versionType = roleProcess.versionType;
        config.version = roleProcess.version;
        config.versionExtended = config.versionType + '-' + config.version;
        config.roleType = roleProcess.roleType;
    } else {
        throw new Error("Unable to find role process name '" + roleProcess_id + "' in configuration file.  Startup process halted.");
    }
}

function commandLineSelect(){
    /*
    By default we'll have two things in process.argv:
    0. Path to node.exe
    1. Path to server.js

    And we'll take the following other arguments
    2. deployment name
    3. role process name
    4. [-initLocal, -initTrial, -initPaid] Creates the initial data structures
    5. [-initClear] Remove the data from the sets and roleProcesses collections before starting up.
    6. [-exitAfterInit] After doing the inititialization of the sets and roleProcesses collection, exit.
    7. [-ignoreInstanceJs] Ignore the isntance.js file, even if it is present.
    8. [-debug] Indicates that the Cycligent Framework should be put in debug mode (most often used in the local
       deployment to stop the Framework from appending version numbers to all the file names.)

    [brackets] indicate that the argument is optional.
     */

    if (fs.existsSync('instance.js') && process.argv.indexOf("-ignoreInstanceJs") == -1) {
        var instanceInfo = require('../../instance.js');
        config.name = instanceInfo.roleProcess_id;
        config.deploymentName = instanceInfo.deploymentName;
    } else if (process.argv.length >= 4) {
        var args = process.argv.slice(2);

        for (var i = 0; i < args.length; i++) {
            var arg = args[i];

            if (arg == "-initLocal") {
                config.cycligentDatabaseInitNeeded = "local";
            } else if (arg == "-initTrial") {
                config.cycligentDatabaseInitNeeded = "trial";
            } else if (arg == "-initPaid") {
                config.cycligentDatabaseInitNeeded = "paid";
            } else if (arg == "-initClear") {
                config.cycligentDatabaseClearBeforeInit = true;
            } else if (arg == "-exitAfterInit") {
                config.cycligentDatabaseExitAfterInit = true;
            } else if (arg == "-debug") {
                config.debug = true;
            } else if (arg[0] != '-') {
                if (!config.deploymentName) {
                    config.deploymentName = arg;
                } else if (!config.name) {
                    config.name = arg;
                } else {
                    console.error("WARN: Unknown argument '" + arg + "' specified on command line.");
                }
            } else if (arg == "-ignoreInstanceJs") {
                // Handled above.
            } else {
                console.error("WARN: Unknown argument '" + arg + "' specified on command line.");
            }
        }
    } else {
        console.error("WARN: Deployment options not present on command line and no instance.js file found; defaults for minimal local deployment used.");
        config.deploymentName = "minimal";
        config.name = new mongodb.ObjectID("000000000000000000000000");
    }

    try {
        config.name = new mongodb.ObjectID(config.name);
    } catch(e) {
        throw new Error("Role process name is malformed.");
    }

    try{
        config.activeDeployment = config.deployments[config.deploymentName];
        if(config.debug){
            config.activeDeployment.supports.multipleVersions = false;
        }
    } catch(ex){
        console.error(ex.message);
        throw new Error("Unable to set active configuration.  Check your command line arguments for correctness, especially versionType and deploymentName");
    }
}

function cycligentDbConnectInitAndQuery(callback) {
    cycligentDbConnect(function(cycligentDb, setsCollection, roleProcessesCollection) {
        checkErrorCount();

        cycligentDbInit(setsCollection, roleProcessesCollection, function() {
            checkErrorCount();

            if (config.cycligentDatabaseExitAfterInit) {
                console.log("Init finished and -exitAfterInit flag was passed, stopping execution.");
                process.exit(0);
            }

            roleProcessQuery(setsCollection, roleProcessesCollection, function() {
                checkErrorCount();
                cycligentDb.close();
                callback();
            });
        });
    });
}

function cycligentDbConnect(callback) {
    var cycligentDbSpec = config.activeDeployment.versionTypes["common"].dbs.cycligent;

    mongodb.MongoClient.connect(cycligentDbSpec.uri, cycligentDbSpec.options, function(err, cycligentDb) {
        if (err) {
            console.error("MongoDB error occurred while trying to connect to the database:");
            console.error(err);
            errorCount++;
            callback();
            return;
        }

        cycligentDb.collection("roleProcesses", {
            strict: false // Create the collection if it doesn't exist.
        }, function(err, roleProcessesCollection) {
            if (err) {
                console.error("MongoDB error occurred while trying to connect to the roleProcesses collection:");
                console.error(err);
                errorCount++;
                callback();
                return;
            }

            cycligentDb.collection("sets", {
                strict: false // Create the collection if it doesn't exist.
            }, function(err, setsCollection) {
                if (err) {
                    console.error("MongoDB error occurred while trying to find the sets collection:");
                    console.error(err);
                    errorCount++;
                    callback();
                    return;
                }

                callback(cycligentDb, setsCollection, roleProcessesCollection);
            });
        });
    });
}

function cycligentDbInit(setsCollection, roleProcessesCollection, callback) {
    cycligentDbClear(setsCollection, roleProcessesCollection, function() {
        checkErrorCount();

        if (!config.cycligentDatabaseInitNeeded) {
            callback();
            return;
        }

        localDeploymentDatabaseInit(setsCollection, roleProcessesCollection, function() {
            callback();
        });
    });
}

function cycligentDbClear(setsCollection, roleProcessesCollection, callback) {
    if (!config.cycligentDatabaseClearBeforeInit) {
        callback();
        return;
    }

    setsCollection.remove({}, function(err) {
        if (err) {
            console.error("MongoDB error occurred while trying to clear the sets collection:");
            console.error(err);
            errorCount++;
            callback();
            return;
        }

        roleProcessesCollection.remove({}, function(err) {
            if (err) {
                console.error("MongoDB error occurred while trying to clear the roleProcseses collection:");
                console.error(err);
                errorCount++;
                callback();
                return;
            }

            callback();
        })
    });
}

function localDeploymentDatabaseInit(setsCollection, roleProcessesCollection, callback) {
    var defaultSets = defaultData[config.cycligentDatabaseInitNeeded].sets();

    setsCollectionInsert();

    function setsCollectionInsert() {
        setsCollection.count({}, function(err, count) {
            if (err) {
                console.error("MongoDB error occurred while trying to count the sets collection:");
                console.error(err);
                errorCount++;
                callback();
                return;
            }

            if (count > 0) {
                console.error("WARN: An -init flag was passed, but sets collection already contained data, so we didn't add the initial data.");
                roleProcessesCollectionInsert();
            } else {
                setsCollection.insertMany(defaultSets, function(err) {
                    if (err) {
                        console.error("MongoDB error occurred while trying to insert the default set document:");
                        console.error(err);
                        errorCount++;
                        callback();
                        return;
                    }

                    roleProcessesCollectionInsert();
                });
            }
        });
    }

    function roleProcessesCollectionInsert() {
        roleProcessesCollection.count({}, function(err, count) {
            if (err) {
                console.error("MongoDB error occurred while trying to count the roleProcesses collection:");
                console.error(err);
                errorCount++;
                callback();
                return;
            }

            if (count > 0) {
                console.error("WARN: An -init flag was passed, but roleProcesses collection already contained data, so we didn't add the initial data.");
                callback();
            } else {
                defaultData.shared.roleProcessesAnnounceForManySets(defaultSets, roleProcessesCollection, function(err) {
                    if (err) {
                        console.error("Error occurred while trying to announce initial role processes:");
                        console.error(err);
                        errorCount++;
                        callback();
                        return;
                    }

                    callback();
                });
            }
        });
    }
}

function roleProcessQuery(setsCollection, roleProcessesCollection, callback) {
    if (config.deploymentName == "minimal") {
        roleProcessValidate({
            deployment: config.deployments["minimal"],
            deploymentName: "minimal",

            name: config.name,

            set_id: new mongodb.ObjectID(),
            machine_id: new mongodb.ObjectID(),
            roleType: "web",
            versionType: "common"
        });
        config.isLeadWebServer = true;
        baseValuesSetViaRoleProcessId(config.name);

        callback();
        return;
    }

    roleProcessesCollection.findOne({_id: config.name}, function(err, roleProcessDoc) {
        if (err) {
            console.error("MongoDB error occurred while trying to find the role process doc:");
            console.error(err);
            errorCount++;
            callback();
            return;
        }

        if (!roleProcessDoc) {
            console.error("CONFIG ERROR: Unknown role process '" + config.name + "' specified.");
            errorCount++;
            callback();
            return;
        }

        setsCollection.findOne({_id: roleProcessDoc.set_id}, function(err, setDoc) {
            if (err) {
                console.error("MongoDB error occurred while trying to find the role process set doc:");
                console.error(err);
                errorCount++;
                callback();
                return;
            }

            if (!setDoc) {
                console.error("CONFIG ERROR: Unknown set '" + roleProcessDoc.set_id + "' specified.");
                errorCount++;
                callback();
                return;
            }

            var machineFound = false;
            for (var i = 0; i < setDoc.machines.length; i++) {
                if (setDoc.machines[i]._id.toString() == roleProcessDoc.machine_id.toString()) {
                    machineFound = true;
                    break;
                }
            }

            if (!machineFound) {
                console.error("CONFIG ERROR: Unknown machine '" + roleProcessDoc.machine_id + "' specified.");
                errorCount++;
                callback();
                return;
            }

            roleProcessValidate({
                deployment: config.deployments[setDoc.deploymentName],
                deploymentName: setDoc.deploymentName,

                name: config.name,

                friendlyName: roleProcessDoc.friendlyName,
                set_id: roleProcessDoc.set_id,
                machine_id: new mongodb.ObjectID(roleProcessDoc.machine_id),
                roleType: roleProcessDoc.roleType,
                versionType: roleProcessDoc.versionType,
                workerActingAsCyvisor: roleProcessDoc.workerActingAsCyvisor
            });

            config.isLeadWebServer = (roleProcessDoc.isLeadWebServer? true : false);
            baseValuesSetViaRoleProcessId(config.name);

            callback();
        });
    });
}

function roleProcessConfigValuesSet() {
    var cyvisor = false;

    if (config.roleProcess.roleType == "cyvisor" || config.roleProcess.workerActingAsCyvisor) {
        cyvisor = true;
    }

    config.name = config.roleProcess.name;
    config.processes = config.roleProcess.processes;
    config.router = false;

    /**
     * Indicates whether or not this role process is acting as the Cyvisor.
     *
     * Cyvisors are usually run independently of the rest of the deployment, but they can
     * be run within workers. So it's important to not confuse this property with
     * config.roleProcess.roleType (which can equal "cyvisor"), since the roleType might be "worker",
     * but it could be acting as the Cyvisor.
     * @type {boolean}
     */
    config.isCyvisor = cyvisor;

    // If we are a web roleType it is possible that we need to be a router, determine based on configuration.
    // Currently the only case when we're not a router is when we're running minimal. We used to base this test on
    // whether any other machines are out there, but this no longer happens because the role processes are in the DB.
    config.router = (config.roleType == 'web' && config.deploymentName != 'minimal');
}

function configValidate(){

    var dbName;

    var set;
    var roleProcess;

    roleProcess = config.roleProcess;

    // Perform web roleProcess checks
    if(roleProcess.roleType == 'web'){
        // Make sure only common version has web routers
        if(roleProcess.versionType != 'common'){
            errorCount++;
            console.error("CONFIG ERROR: Only role processes on the 'common' version type can have the 'web' roleType. Check configuration of roleProcess '" + roleProcess.name + "'.");
        }
        // TODO: 1. Remove after 7/30/2015:
        // Make sure we have a catch all for processing
        /*if(config.router && roleProcess.processes.inInstance != '*' && roleProcess.processes.worker != '*' && roleProcess.processes.longWorker != '*'){
            errorCount++;
            console.error("CONFIG ERROR: Role process '" + roleProcess.name + "' did not specify a catch all process via '*' which is required.");
        }

        // Issue warnings if message bus process filters are not optimal
        if((roleProcess.processes.inInstance instanceof RegExp) && roleProcess.processes.inInstance.source.substr(0,1) != '^'){
            console.error("WARN: The inInstance process filter for the roleProcess '" + roleProcess.name + "' is not optimal as it does not begin with a '^'.");
        }
        if((roleProcess.processes.worker instanceof RegExp) && roleProcess.processes.worker.source.substr(0,1) != '^'){
            console.error("WARN: The worker process filter for the roleProcess '" + roleProcess.name + "' is not optimal as it does not begin with a '^'.");
        }
        if((roleProcess.processes.longWorker instanceof RegExp) && roleProcess.processes.longWorker.source.substr(0,1) != '^'){
            console.error("WARN: The longWorker process filter for the roleProcess '" + roleProcess.name + "' is not optimal as it does not begin with a '^'.");
        }*/
    } else {
        // TODO: 1. Remove after 7/30/2015:
        // Issue warnings if message bus process filters are not optimal
        /*if((roleProcess.processes instanceof RegExp) && roleProcess.processes.source.substr(0,1) != '^'){
            console.error("WARN: The process filter for the roleProcess '" + roleProcess.name + "' is not optimal as it does not begin with a '^'.");
        }*/
    }

    // Make sure version numbers are set
    if(config.versions[roleProcess.versionType] == 'M.m.B' && config.deploymentName != 'minimal' && !config.debug){
        errorCount++;
        console.error("CONFIG ERROR: Role process '" + roleProcess.name + "' specified version type '" + roleProcess.versionType + "' which does not have a specific version associated with it.");
    }

    var messageBusSensibleDefaults = {
        db: {
            uri: 'mongodb://localhost:27017/messageBus',
            options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
        },
        collectionNames: {
            pending: 'messages',
            delivered: 'deliveredMessages',
            problem: 'problemMessages'
        },
        captureDeliveries: true,
        separateProblems: true,
        expiredCleanupInterval: 1000 * 60 * 10,
        cpuMax: 0.75,
        pollDelay: 0,
        pollDelayLong: 5000,
        timeout: 1000 * 25,
        messagesMax: 0
    };

    if (config.deploymentName != 'minimal') {
        for (var key in messageBusSensibleDefaults) {
            var value = config.activeDeployment.messageBus[key];
            if (value == undefined) {
                errorCount++;
                console.error("CONFIG ERROR: In deployment '" + config.deploymentName + "', the messageBus is missing a configuration for " + key +
                    ". A sensible default may be: " + JSON.stringify(messageBusSensibleDefaults[key]) + "\nBut please do a reality-check.");
            } else if ((key == "timeout" || key == "expiredCleanupInterval") && value < 1000) {
                console.error("WARN: In deployment '" + config.deploymentName + "', messageBus." + key + " is set to a value below one second. " +
                    "This is likely too short of an interval.");
            }

            if (key == "db") {
                if (value.uri.indexOf("AWS_AUTO_CONFIGURED_MONGODB/") != -1) {
                    value.uri = makeAWSConnectionString(value.uri);
                }
                mongoDBNativeParserWorkaround("messageBus", value);
            }
        }
    }

    for (var deploymentName in config.deployments) {
        var deployment = config.deployments[deploymentName];

        // Validate some information used by Cycligent Agent.
        if (deployment.title == undefined) {
            deployment.title = deploymentName + " Deployment";
            console.error("WARN: No title specified for deployment '" + deploymentName +"', using '" + deployment.title + "'.");
        }

        if (deployment.httpListenHostname === undefined) {
            deployment.httpListenHostname = "0.0.0.0";
        }

        // Validate the authenticators for each deployment.
        for (var authenticatorName in deployment.authenticators) {
            var authenticator = deployment.authenticators[authenticatorName];

            authenticator.authenticatorName = authenticatorName;

            if (authenticator.authenticatedUserAddIfMissing === undefined) {
                authenticator.authenticatedUserAddIfMissing = false;
            }

            if (authenticator.signOnURL === undefined) {
                authenticator.signOnURL = "signOn";
            }

            if (authenticator.provider === undefined &&
                (authenticators.providerNames().indexOf(authenticatorName) != -1)) {
                authenticator.provider = authenticatorName;
            }

            if (authenticator.provider == undefined) {
                errorCount++;
                console.error("ERROR: No provider specified for authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName +"'.")
            } else if (authenticators.providerNames().indexOf(authenticator.provider) == -1) {
                errorCount++;
                console.error("ERROR: Unknown authentication provider '" + authenticator.provider + "' specified in deployment '" + deploymentName + "'.");
            }

            if (authenticator.provider == 'azure') {
                if (authenticator.on === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'on' wasn't provided.");
                    break;
                }
                if (authenticator.off === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'off' wasn't provided.");
                    break;
                }
                if (authenticator.host === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'host' wasn't provided.");
                    break;
                }
                // Parse the Realm
                authenticator.realm = url.parse(authenticator.on, true).query.wtrealm;
                // Parse and then format to normalize the URL. Not foolproof, but it'll do.
                authenticator.realm = url.format(url.parse(authenticator.realm));

                // Validate Certificate
                if (authenticator.certificate == undefined) {
                    authenticator.certificate = "MIIDPjCCAiqgAwIBAgIQsRiM0jheFZhKk49YD0SK1TAJBgUrDgMCHQUAMC0xKzApBgNVBAMTImFjY291bnRzLmFjY2Vzc2NvbnRyb2wud2luZG93cy5uZXQwHhcNMTQwMTAxMDcwMDAwWhcNMTYwMTAxMDcwMDAwWjAtMSswKQYDVQQDEyJhY2NvdW50cy5hY2Nlc3Njb250cm9sLndpbmRvd3MubmV0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkSCWg6q9iYxvJE2NIhSyOiKvqoWCO2GFipgH0sTSAs5FalHQosk9ZNTztX0ywS/AHsBeQPqYygfYVJL6/EgzVuwRk5txr9e3n1uml94fLyq/AXbwo9yAduf4dCHTP8CWR1dnDR+Qnz/4PYlWVEuuHHONOw/blbfdMjhY+C/BYM2E3pRxbohBb3x//CfueV7ddz2LYiH3wjz0QS/7kjPiNCsXcNyKQEOTkbHFi3mu0u13SQwNddhcynd/GTgWN8A+6SN1r4hzpjFKFLbZnBt77ACSiYx+IHK4Mp+NaVEi5wQtSsjQtI++XsokxRDqYLwus1I1SihgbV/STTg5enufuwIDAQABo2IwYDBeBgNVHQEEVzBVgBDLebM6bK3BjWGqIBrBNFeNoS8wLTErMCkGA1UEAxMiYWNjb3VudHMuYWNjZXNzY29udHJvbC53aW5kb3dzLm5ldIIQsRiM0jheFZhKk49YD0SK1TAJBgUrDgMCHQUAA4IBAQCJ4JApryF77EKC4zF5bUaBLQHQ1PNtA1uMDbdNVGKCmSf8M65b8h0NwlIjGGGy/unK8P6jWFdm5IlZ0YPTOgzcRZguXDPj7ajyvlVEQ2K2ICvTYiRQqrOhEhZMSSZsTKXFVwNfW6ADDkN3bvVOVbtpty+nBY5UqnI7xbcoHLZ4wYD251uj5+lo13YLnsVrmQ16NCBYq2nQFNPuNJw6t3XUbwBHXpF46aLT1/eGf/7Xx6iy8yPJX4DyrpFTutDz882RWofGEO5t4Cw+zZg70dJ/hH/ODYRMorfXEW+8uKmXMKmX2wyxMKvfiPbTy5LmAU8Jvjs2tLg4rOBcXWLAIarZ";
                    if (config.debug)
                        console.error("WARN: In deployment '" + deploymentName + "', in the azure authenticator, the 'certificate' field wasn't set. The roleProcess will proceed with the assumption that it is the certificate defined in this document: https://login.windows.net/common/FederationMetadata/2007-06/FederationMetadata.xml (starts with MIIDPjCCAiqgAwIBAgIQVWmXY.)");
                }
            } else if (authenticator.provider == 'google') {
                if (authenticator.callbackURL === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'callbackURL' wasn't provided.");
                    break;
                }
                if (authenticator.stateless === undefined)
                    authenticator.stateless = true;
            } else if (authenticator.provider == "facebook") {
                if (authenticator.clientID === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'clientID' wasn't provided.");
                    break;
                }
                if (authenticator.clientSecret === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'clientSecret' wasn't provided.");
                    break;
                }
                if (authenticator.callbackURL === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'callbackURL' wasn't provided.");
                    break;
                }
            } else if (authenticator.provider == "github") {
                if (authenticator.clientID === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'clientID' wasn't provided.");
                    break;
                }
                if (authenticator.clientSecret === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'clientSecret' wasn't provided.");
                    break;
                }
                if (authenticator.callbackURL === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'callbackURL' wasn't provided.");
                    break;
                }
            } else if (authenticator.provider == "local") {
                if (authenticator.loginPage === undefined) {
                    authenticator.loginPage = "cycligent/client/login.html";
                }
            } else if (authenticator.provider == "activeDirectory") {
                if (authenticator.activeDirectoryDomain === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'activeDirectoryDomain' wasn't provided.");
                    break;
                }
                if (authenticator.LDAPConnection === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'LDAPConnection' wasn't provided.");
                    break;
                }
                if (authenticator.loginPage === undefined) {
                    authenticator.loginPage = "cycligent/client/login.html";
                }
            } else if (authenticator.provider == "multipleAuthenticatorsHelper") {
                if (authenticator.urlRedirect) {
                    authenticator.fileToServe = authenticator.urlRedirect;
                } else {
                    // We don't want to change the name like we do with authenticator.loginPage, we just want this to raise an error if the file doesn't exist.
                    fileWithVersion(authenticator.fileToServe);
                }
            } else if (authenticator.provider == "certificate") {
                if (authenticator.loginPage === undefined) {
                    errorCount++;
                    console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', the required option 'loginPage' wasn't provided.");
                    break;
                }
                if (authenticator.certificateCollection === undefined) {
                    authenticator.certificateCollection = "certificates";
                }
            }

            if (authenticator.loginAttempts && !authenticator.loginUnlockDelay) {
                errorCount++;
                console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', if you specify loginAttempts, you must specify loginUnlockDelay.");
                break;
            }

            if (!authenticator.loginAttempts && authenticator.loginUnlockDelay) {
                errorCount++;
                console.error("ERROR: In authenticator configuration '" + authenticatorName + "' in deployment '" + deploymentName + "', if you specify loginUnlockDelay, you must specify loginAttempts.");
                break;
            }

            if (authenticator.loginPage) {
                authenticator.loginPage = fileWithVersion(authenticator.loginPage, authenticatorName, deploymentName);
            }
        }

        deployment.proxyInUse = false; // This is set to true in the loop below, if any proxies are defined.

        if (!deployment.proxy) {
            deployment.proxy = {};
        } else if (deployment.proxy == "default") {
            deployment.proxy = {defaultProxy: cycligentProxy.defaultProxy};
        }

        for (var proxyName in deployment.proxy) {
            var proxy = deployment.proxy[proxyName];
            deployment.proxyInUse = true;

            if (!proxy.urlMatcher) {
                errorCount++;
                console.error("ERROR: In proxy configuration '" + proxyName + "' in deployment '" + deploymentName + "', the required option 'urlMatcher' wasn't provided.");
                break;
            }

            if (!proxy.httpMethods) {
                errorCount++;
                console.error("ERROR: In proxy configuration '" + proxyName + "' in deployment '" + deploymentName + "', the required option 'httpMethods' wasn't provided.");
                break;
            }

            if (typeof proxy.httpMethods == 'string' && proxy.httpMethods != '*') {
                errorCount++;
                console.error("ERROR: In proxy configuration '" + proxyName + "' in deployment '" + deploymentName + "', the option 'httpMethods' was of type string, but wasn't \"*\". If you're trying to list HTTP verbs, use a map, for example: {'GET': true, 'POST': true}.");
                break;
            } else if (typeof proxy.httpMethods == "object" && Array.isArray(proxy.httpMethods)) {
                errorCount++;
                console.error("ERROR: In proxy configuration '" + proxyName + "' in deployment '" + deploymentName + "', the option 'httpMethods' was of type array, but should be a map like this: {'GET': true, 'POST': true}.");
                break;
            }

            if (!proxy.action) {
                errorCount++;
                console.error("ERROR: In proxy configuration '" + proxyName + "' in deployment '" + deploymentName + "', the required option 'action' wasn't provided.");
                break;
            }

            proxy.utils = cycligentProxy;
        }
    }

    var root;
    for(var rootName in config.roots){
        root = config.roots[rootName];
        if(root.supports.skins){
            if( root.getStaticTypes['.css'].cache ){
                errorCount++;
                console.error("The root '" + rootName + "' supports skins, but css files are marked to be cached, which will not allow the user to see skin changes.");
            }
        }

        if (root.anonymousUsersAllowed == undefined) {
            root.anonymousUsersAllowed = false;
        }

        if (root.authenticator && root.authenticators) {
            errorCount++;
            console.error("The root '" + rootName + "' has both 'authenticator' and 'authenticators' defined. You can only use one.");
        }

        if (root.authenticator) {
            root.authenticators = [root.authenticator];
        }

        if (!root.authenticators) {
            root.authenticators = [];
        }

        for (var i = 0; i < root.authenticators.length; i++) {
            authenticatorName = root.authenticators[i];
            if (config.activeDeployment.authenticators[authenticatorName] === undefined) {
                errorCount++;
                console.error("ERROR: The root '" + rootName + "' specified an unknown authenticator named '" + authenticatorName + "' for the deployment '" + config.deploymentName +"' " +
                    "\n       (perhaps it's defined for another deployment type and you forgot to define it for this one?)");
            }
        }

        var sessionDbDefined = false;
        for (dbName in root.dbs) {
            if (root.dbs.hasOwnProperty(dbName)) {
                var dbConfig = root.dbs[dbName];
                if (dbConfig.sessionDb) {
                    sessionDbDefined = true;
                }
                if (root.authenticators.length > 0 && !dbConfig.authenticatedUser) {
                    var messagePrefix;
                    if (dbConfig.sessionDb) {
                        errorCount++;
                        messagePrefix = "ERROR: ";
                    } else {
                        messagePrefix = "WARN: ";
                    }
                    console.error(messagePrefix + "The root '" + rootName + "' uses an authenticator, but didn't configure the " +
                        "authenticatedUser field for the database " + dbName + ".");
                }
            }
        }

        if (rootName == "cycligent") {
            if (!root.dbs) {
                root.dbs = {};
            }

            if (!sessionDbDefined && !root.dbs.cycligent) {
                root.dbs.cycligent = {authenticatedUser: 'cycligent', sessionDb: true};
            } else {
                console.error("WARN: Non-standard definition of the DBs for the cycligent root could cause problems.");
            }
        }

        if (root.sessionExpirationTime === undefined) {
            root.sessionExpirationTime = 1000 * 60 * 60 * 24; // 24 hours.
        }
    }

    function fileWithVersion(filename, authenticatorName, deploymentName) {
        if (!fs.existsSync(filename)) {
            var extension = path.extname(filename);
            var r = new RegExp(extension.replace(".", "\\.") + "$");
            var loginPageWithVersion = filename.replace(r, "-" + config.version + extension);

            if (fs.existsSync(loginPageWithVersion)) {
                filename = loginPageWithVersion;
            } else {
                errorCount++;
                console.error("ERROR: Could not find the login page '" + filename + "' or '" + loginPageWithVersion + "' for " + authenticatorName + "' in deployment '" + deploymentName + "'.");
            }
        }

        return filename;
    }
}

// TODO: 5. If the issue with the deployment process gets fixed, remove this workaround.
/**
 * There used to be some bugs in the BSON native parser that prevented us from using it. Those bugs have since been
 * resolved, but now the library causes our deployment process to break, because bson.node ends up with a lock on it,
 * and msdeploy refuses to change it. So, for now, we are leave this disabled until further notice.
 *
 * @param {String} dbName
 * @param {Object} conf
 */
function mongoDBNativeParserWorkaround(dbName, conf) {
    var mongoOptions = conf.options;
    if (mongoOptions.db === undefined)
        mongoOptions.db = {};
    if (mongoOptions.db.native_parser === undefined) {
        mongoOptions.db.native_parser = false;
    } else if (mongoOptions.db.native_parser == true) {
        if (dbName == "messageBus") {
            errorCount++;
            console.error("CONFIG ERROR: As of 12/23/2013, node-mongodb-native v1.3.23, BSON v0.2.5 native_parser is known to have issues, which causes the message bus to break. Cycligent Server will refuse to start until you set native_parser to false for the messageBus.");
        } else {
            console.error("WARN: As of 12/23/2013, node-mongodb-native v1.3.23, BSON v0.2.5 native_parser is known to have issues, tread carefully with this option enabled.");
        }
    }
}

function anonymousPathsCompile(){

    config.anonymousPaths = [];

    var root;
    var authenticator;
    var authenticatorName;
    for(var rootName in config.roots){

        root = config.roots[rootName];

        if (root.authenticators.length > 0) {
            if (!root.anonymousPaths) {
                console.error("WARN: In root '" + rootName + "' an authenticator was specified, but no anonymous paths were configured. Using /signOn and /signOff.");
                root.anonymousPaths = ["/signOn", "/signOff"];
            }

            for (var i = 0; i < root.authenticators.length; i++) {
                authenticatorName = root.authenticators[i];
                authenticator = config.activeDeployment.authenticators[authenticatorName];
                if (authenticator.signOnURL && root.anonymousPaths.indexOf("/" + authenticator.signOnURL) == -1 && root.anonymousPaths.indexOf('/') == -1) {
                    console.error("WARN: For root '" + rootName + "' the authenticator '" + authenticatorName + "' has the signOnURL '" + authenticator.signOnURL + "', but '/" + authenticator.signOnURL + "' isn't in the root's anonymousPaths.");
                }
            }
        }

        if(root.anonymousPaths){
            anonymousPathConcat(rootName,root.anonymousPaths);
        }
    }
}

function rootsProcess(){
    config.cachePlanMap = {};
    config.cacheServiceMap = {};
    config.callMap = {};
    config.downloadMap = {};
    config.queryMap = {};
    config.getMap = {};
    config.postMap = {};

    var rootPath = '.';
    var rootProcessPathOffset = '../../';       // We are assuming here the working directory for node, and thus the root directory, is two level above where configProcess.js is located!
    var fileNames = fs.readdirSync(rootPath);
    var rootName;
    var filePath;
    var stats;

    // Process root configurations
    for( var fileIndex in fileNames ){
        rootName = fileNames[fileIndex];
        filePath = rootPath + "/" + rootName;
        stats = fs.statSync(filePath);
        if(stats.isDirectory() && !excludedDirectory(rootName)){
            filePath += "/server";
            if(fs.existsSync(filePath)){
                stats = fs.statSync(filePath);
                if(stats.isDirectory()){
                    if(config.roots.exclude[rootName]){
                        console.log('Root "' + rootName + '" was excluded as a server root per the config.js file.');
                        if (config.roots[rootName])
                            delete config.roots[rootName];
                    }else{
                        try{
                            fs.statSync(filePath + "/config.js");
                            config.roots[rootName] = require(rootProcessPathOffset + filePath + "/config.js");
                            if(config.roots[rootName].anonymousPaths){
                                anonymousPathConcat(rootName,config.roots[rootName].anonymousPaths);
                            }
                        }catch(ex){
                            if(ex.code == "ENOENT"){ // No such file or directory
                                if(!config.roots[rootName]){
                                    throw "No configuration found for root '" + rootName + "'. If this is not a server root exclude in the main config.js file via roots.exclude";
                                }
                            }else{
                                throw(ex);
                            }
                        }
                    }
                }
            }
        }
    }

    // We don't need roots.exclude anymore and we want to leave the roots structure just containing real roots
    delete config.roots.exclude;

    // Process cycligentCall/cycligentCache/cycligentDownload within the above roots
    for (rootName in config.roots) {
        filePath = rootPath + "/" + rootName + "/server";
        dbsProcess(rootName, config.roots[rootName]);
        config.getMap[rootName] = {};
        config.postMap[rootName] = {};
        dirProcess(config.cachePlanMap, config.cacheServiceMap, config.callMap, config.downloadMap, config.queryMap, config.getMap[rootName], config.postMap[rootName], rootName, filePath, rootProcessPathOffset, "^" + rootName);
    }
}

function dbsProcess(rootName, rootConfig) {
    var foundSessionDb = false;

    if (rootConfig.dbs) {
        for (var dbName in rootConfig.dbs) {
            var dbConfig = rootConfig.dbs[dbName];
            if (dbConfig.collectionConfig === undefined) {
                dbConfig.collectionConfig = {};
            }
            var collectionDefaults = dbConfig.collectionConfigDefaults;
            if (collectionDefaults === undefined) {
                collectionDefaults = {};
                dbConfig.collectionConfigDefaults = collectionDefaults;
            }
            if (collectionDefaults.modHandlingEnabled === undefined)
                collectionDefaults.modHandlingEnabled = true;
            if (collectionDefaults.modAtField === undefined)
                collectionDefaults.modAtField = "modAt";
            if (collectionDefaults.modByField === undefined)
                collectionDefaults.modByField = "modBy";
            if (collectionDefaults.modVersionField === undefined)
                collectionDefaults.modVersionField = "modVersion";

            if (dbConfig.sessionDb === true) {
                if (foundSessionDb == true) {
                    errorCount++;
                    console.error("ERROR: In root '" + rootName + "' more than one database was identified as the sessionDb. Only one database can be the sessionDb for a root.");
                } else {
                    foundSessionDb = true;
                }
            }
        }
    }

    if (rootConfig.authenticator && foundSessionDb == false) {
        errorCount++;
        console.error("ERROR: In root '" + rootName + "' an authenticator was specified, but no sessionDb was configured. In the 'dbs' section of the root configuration, please set sessionDb to true for one of the databases.");
    }
}

function versionsSet(){
    for(var root in config.roots){
        config.roots[root].appVersion = config.version;
    }
}

function anonymousPathConcat(rootName,paths){
    for(var i = 0; i < paths.length; i++){
        config.anonymousPaths.push("/" + rootName + paths[i]);
    }
}

/**
 * Given a cache plan, and some associated data, it expands the cache service names into completely unambiguous names.
 * (i.e. it would take "sessions" and turn it into "^cycligent.startup.sessions"
 *
 * This function assumes that config.roots contains all valid roots.
 *
 * @param {Object[]} cachePlan The cache plan we're operating on.
 * @param {String} dottedName The dotted name of the folder we're in. This is expected to begin with "^".
 * @param {String} fileName The name of the file we're in, without the file extension. (i.e. just "startup" instead of "startup.js")
 */
function cachePlanExpandServiceName(cachePlan, dottedName, fileName) {
    var rootNames = Object.keys(config.roots);

    for (var i = 0; i < cachePlan.length; i++) {
        var part = cachePlan[i];

        //noinspection FallthroughInSwitchStatementJS
        switch (part.service[0]) {
            case '.':   // Force relative to current file.
                part.service = dottedName + part.service;
                break;

            case '^':    // Deploy directory anchor
                // Do nothing, this is already in the format we want.
                break;

            case '/':   // Current application directory anchor
            case '@':   // Current application directory anchor
                part.service = dottedName.split('.')[0] + "." + part.service;
                break;

            default:
                var split = part.service.split('.');
                var firstName = split[0];
                if (split.length == 1) { // It's just one name, and therefore must be referring to a function in the current file.
                    part.service = dottedName + '.' + fileName + '.' + part.service;
                } else if (rootNames.indexOf(firstName) != -1) { // We're referring to a root.
                    part.service = '^' + part.service;
                } else { // We're referring to something in the same folder.
                    part.service = dottedName + '.' + part.service;
                }
                break;
        }

        if (part.subPlans) {
            cachePlanExpandServiceName(part.subPlans, dottedName, fileName);
        }
    }
}

function dirProcess(cachePlanMapCurrent, cacheServiceMapCurrent, callMapCurrent, downloadMapCurrent, queryMapCurrent, getMapCurrent, postMapCurrent, dirName, rootPath, rootProcessPathOffset, dottedName){

    var filePath;
    var fileName;
    var stats;
    var fileNames;
    var fileText;
    var cachePlans;
    var dottedNameForFile;
    var cacheExport;
    var prop;
    var parser = /(?:\\|\/)([^\\\/]+(?:\\|\/))server(?:\\|\/)(.+)\.js/;
    var matches;

    cachePlanMapCurrent[dirName] = {};
    cacheServiceMapCurrent[dirName] = {};
    callMapCurrent[dirName] = {};
    downloadMapCurrent[dirName] = {};
    queryMapCurrent[dirName] = {};

    try{
        fileNames = fs.readdirSync(rootPath);

        for( var fileIndex in fileNames ){
            fileName = fileNames[fileIndex];
            filePath = rootPath + "/" + fileName;
            dottedNameForFile = dottedName + "." + path.basename(fileName,".js");
            stats = fs.statSync(filePath);
            if(stats.isFile() && !excludedFile(filePath)){
                if(path.extname(filePath) == ".js"){
                    fileText = fs.readFileSync(filePath,'utf8');
                    if(fileText.indexOf('_cycligentCachePlanExport') >= 0){
                        cacheExport = require(rootProcessPathOffset + filePath)._cycligentCachePlanExport;
                        if(cachePlanMapCurrent[dirName][path.basename(fileName,".js")]){
                            // The plan already has something in it so we have to copy properties versus just initialize the whole value.
                            for(prop in cacheExport){
                                cachePlanMapCurrent[dirName][path.basename(fileName,".js")][prop] = cacheExport[prop];
                            }
                        }else{
                            cachePlanMapCurrent[dirName][path.basename(fileName,".js")] = cacheExport;
                        }

                        cachePlans = cachePlanMapCurrent[dirName][path.basename(fileName,".js")];
                        for (var cachePlanName in cachePlans) {
                            cachePlanExpandServiceName(cachePlans[cachePlanName], dottedName, path.basename(fileName,".js"));
                        }
                    }
                    if(fileText.indexOf('_cycligentCacheServiceExport') >= 0){
                        cacheExport = require(rootProcessPathOffset + filePath)._cycligentCacheServiceExport;
                        cacheServiceMapCurrent[dirName][path.basename(fileName,".js")] = cacheExport;
                        if (cacheExport) {
                            //noinspection FallthroughInSwitchStatementJS
                            switch(cacheExport.autoPlanServices){
                                case false:
                                case 'none':
                                    // Do nothing
                                    break;

                                case true:
                                case 'absolute':
                                default:
                                    if(!cachePlanMapCurrent[dirName][path.basename(fileName,".js")]){
                                        cachePlanMapCurrent[dirName][path.basename(fileName,".js")] = {};
                                    }
                                    for(prop in cacheExport){
                                        if(prop != 'autoPlanServices'){
                                            matches = parser.exec(filePath);
                                            cachePlanMapCurrent[dirName][path.basename(fileName,".js")][prop] = [{
                                                service: '^' + (matches[1] + matches[2]).replace(/\\|\//g,".") + "." + prop
                                            }];
                                        }
                                    }
                                    break;
                            }
                        }
                    }
                    if(fileText.indexOf('_cycligentCallExport') >= 0){
                        callMapCurrent[dirName][path.basename(fileName,".js")] = require(rootProcessPathOffset + filePath)._cycligentCallExport;
                    }
                    if (fileText.indexOf('_cycligentDownloadExport') >= 0) {
                        downloadMapCurrent[dirName][path.basename(fileName,".js")] = require(rootProcessPathOffset + filePath)._cycligentDownloadExport;
                    }
                    if (fileText.indexOf("_cycligentQueryExport") >= 0) {
                        var queryExport = require(rootProcessPathOffset + filePath)._cycligentQueryExport;
                        queryMapCurrent[dirName][path.basename(fileName,".js")] = queryExport;
                        for (var index in queryExport) {
                            if (queryExport.hasOwnProperty(index)) {
                                var query = queryExport[index];
                                if (query.database === undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentQueryExport '" + index + "' hasn't specified a 'database'.");
                                } else if (query.collection === undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentQueryExport '" + index + "' hasn't specified a 'collection'.");
                                } else if (query.path === undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentQueryExport '" + index + "' hasn't specified a 'path' field for the function authorization (null for none, but this is not recommended.)");
                                }
                            }
                        }
                    }
                    if (fileText.indexOf("_cycligentPOSTExport") >= 0) {
                        var postExport = require(rootProcessPathOffset + filePath)._cycligentPOSTExport;
                        for (var postPath in postExport) {
                            if (postExport.hasOwnProperty(postPath)) {
                                var postConfig = postExport[postPath];
                                if (postConfig.handler === undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentPOSTExport '" + postPath + "' hasn't defined a handler function.");
                                }
                                if (postConfig.postDataRead === undefined) {
                                    postConfig.postDataRead = true;
                                }
                                if (postConfig.preProcess === undefined) {
                                    postConfig.preProcess = true;
                                }
                                if (postConfig.CSRFProtection === undefined) {
                                    postConfig.CSRFProtection = (postConfig.preProcess && postConfig.postDataRead);
                                }
                                if (postConfig.originalRequestRetain === undefined) {
                                    postConfig.originalRequestRetain = false;
                                }
                                if (postConfig.CSRFProtection == true && postConfig.preProcess == false) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentPOSTExport '" + postPath + "' CSRF protection will only be handled automatically if postDataRead and preProcess are set to true.");
                                }
                                if (postConfig.postDataRead == false && postConfig.preProcess == true) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentPOSTExport '" + postPath + "' can't both disable postDataRead and enable preProcses. If we can't read any data we can't pre-process!");
                                }
                                if (postMapCurrent[postPath] !== undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentPOSTExport '" + postPath + "' is overwriting a POST export that already exists.");
                                } else {
                                    postMapCurrent[postPath] = postConfig;
                                }
                            }
                        }
                    }
                    if (fileText.indexOf("_cycligentGETExport") >= 0) {
                        var getExport = require(rootProcessPathOffset + filePath)._cycligentGETExport;
                        for (var getPath in getExport) {
                            if (getExport.hasOwnProperty(getPath)) {
                                var getConfig = getExport[getPath];
                                if (getConfig.handler === undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentGETExport '" + getPath + "' hasn't defined a handler function.");
                                }
                                if (getMapCurrent[getPath] !== undefined) {
                                    errorCount++;
                                    console.error("ERROR: In " + filePath + " the _cycligentGETExport '" + getPath + "' is overwriting a GET export that already exists.");
                                } else {
                                    getMapCurrent[getPath] = getConfig;
                                }
                            }
                        }
                    }
                }
            } else if(stats.isDirectory() && !excludedDirectory(fileName)){
                dirProcess(cachePlanMapCurrent[dirName], cacheServiceMapCurrent[dirName], callMapCurrent[dirName], downloadMapCurrent[dirName], queryMapCurrent[dirName], {}, {}, fileName, filePath, rootProcessPathOffset, dottedNameForFile);
            }
        }
    }catch(ex){
        if(ex.code != "ENOENT" ){ // No such file or directory
            throw(ex);
        }
    }
}

/***
 * Excludes certain cycligent system files from remote call search
 * @param filePath
 * @return {Boolean}
 */
function excludedFile(filePath){

    switch(filePath){
        case './cycligent/server/configProcess.js':
            return true;
    }

    return false;
}

/***
 * Excludes certain directories, such as system directories, from remote call search
 * @param {String} fileName
 * @return {Boolean}
 */
function excludedDirectory(fileName){

    if(fileName.substr(0,1) == '.'){
        return true;
    }

    //noinspection FallthroughInSwitchStatementJS
    switch(fileName){
        case 'examples':
        case 'iisnode':
        case 'iisnodeLogs':
        case 'node_modules':
        case 'server.js.debug':
            return true;
    }

    return false;
}

function optimize(){

    var rootName;
    var root;
    var typeName;
    var type;

    // Optimize HTML types by adding a flag
    for(rootName in config.roots){
        root = config.roots[rootName];
        for(typeName in root.getStaticTypes){
            type = root.getStaticTypes[typeName];
            if(type.type == 'text/html'){
                type.isHtml = true;
            }
        }
    }

}

var makeAWSConnectionStringCachedString;
function makeAWSConnectionString(databaseName) {
    if (makeAWSConnectionStringCachedString === undefined) {
        loadCachedString();
    }

    databaseName = databaseName.replace("AWS_AUTO_CONFIGURED_MONGODB/", "");
    return makeAWSConnectionStringCachedString.replace(/\{database\}/g, databaseName);

    function loadCachedString() {
        var mongoDBConnectionString = "mongodb://localhost:27017/{database}";
        var connectionStringFilePath = path.join(process.cwd(), "..", "mongodb-connection-string.json");
        try {
            if (fs.existsSync(connectionStringFilePath)) {
                mongoDBConnectionString = JSON.parse(fs.readFileSync(connectionStringFilePath));
                if (mongoDBConnectionString.indexOf("{database}") == -1) {
                    console.error("CONFIG ERROR: mongodb-connection-string.json didn't contain the string {database}.");
                    errorCount++;
                }
            }
        } catch(e) {
            console.error("CONFIG ERROR: Exception when trying to load mongodb-connection-string.json:");
            console.error(e);
        }

        makeAWSConnectionStringCachedString = mongoDBConnectionString;
    }
}
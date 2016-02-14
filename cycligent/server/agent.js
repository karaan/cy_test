var config; // We delay loading of this.
var flavor;

var utils = require('./utils.js');
var cyvisor = require('./cyvisor.js');
var authorize = require('./authorize.js');
var querystring = require('querystring');
var crypto = require("crypto");
var https = require('https');
var http = require("http");
var url = require("url");
var os = require("os");
var fs = require("fs");

var AWS = require('aws-sdk');
AWS.config.update({region: "us-west-2"});
var metadataService = new AWS.MetadataService();
var MongoDBConnection = require("./node_modules/mongodb/node_modules/mongodb-core/lib/connection/connection.js");

// TODO: 3. Minimal deployment acts really strange when viewed from Cycligent Agent (and rightly so, but we should handle it somehow.)
// TODO: 3. Reliance on config.activeDeployment means you can't add a set without changing config.js.
// TODO: 2. There are a number of places where we build URLs via concatenation. This is really easy to fool/mess up, we should fix this.

var ignoringRequests = false;
var setsCollection = null;
var roleProcessesCollection = null;
var resumeFunc = null;
var pauseFunc = null;
var portForThisRoleProcess = null;
var instanceSize;

var samplesToStore = 40; // TODO: 5. We might want to make the sample size configurable.
var cpuSamples = [];
var memSamples = [];
var memTotal = 0;
var responseTimeSamples = [];
var networkTrafficSamples = [];
var now = Date.now();

var PROBE_INTERVAL = 2500;  // TODO: 7. Make probe interval configurable.
var BYTES_PER_SEC_FACTOR = 1000 / PROBE_INTERVAL;

var responseTimeInterval = PROBE_INTERVAL; // We average response times over 5 second periods.
var networkTrafficInterval = PROBE_INTERVAL;  // We average response times over 5 second periods.
for (var i = 0; i < samplesToStore; i++) {
    cpuSamples.push(0);
    memSamples.push(0);
    responseTimeSamples.push({samples: 0, total: 0});
    networkTrafficSamples.push({samples: 0, out: 0, in: 0});
}
responseTimeSamples[samplesToStore-1].intervalEndsAt = now - now % responseTimeInterval + responseTimeInterval;
networkTrafficSamples[samplesToStore-1].intervalEndsAt = now - now % networkTrafficInterval + networkTrafficInterval;


var machineStatus = {modAt: new Date(), major: "Online", minor: "Healthy", setByCyvisor: "ignore"};

/**
 * Call this before the server is ready-to-go, so Cycligent Agent can set up a few things.
 */
function agentSetup() {
    config = require('./configProcess.js');
    cyvisor.configSet(config);

    // Set agent
    switch(config.deploymentName){

        case "minimal":
            flavor = require("./agentMinimal.js");
            break;

        case "local":
            flavor = require("./agentLocal.js");
            break;

        case "aws":
            metadataService.request('/2014-11-05/meta-data/instance-type', function(err, data) {
                if (err) {
                    console.error("An AWS error occurred while trying to find instance size. Error message was:");
                    console.error(err);
                    return;
                }

                instanceSize = data;
            });

            flavor = require("./agentAws.js");
            break;

        default:
            console.error(
                new Error("Cycligent Server doesn't yet know how to perform actions on machines in deployment type '"
                + config.deploymentName + "'")
            );
            break;
    }

    if (!config.roleProcess.agent.probe.enabled || !config.roleProcess.agent.control.enabled) {
        for (var callName in exports._cycligentCallExport) {
            if (exports._cycligentCallExport.hasOwnProperty(callName))
                delete exports._cycligentCallExport[callName];
        }
        for (var cacheServiceName in exports._cycligentCacheServiceExport) {
            if (exports._cycligentCacheServiceExport.hasOwnProperty(cacheServiceName))
                delete exports._cycligentCacheServiceExport[cacheServiceName];
        }
    }

    if (config.roleProcess.agent.probe.enabled) {
        networkTrafficInstrumentMongoDB();

        // TODO: 7. Got some funny numbers on when running on Linux, when we officially add Linux support, we'll want to
        // make sure that measuring CPU like this is actually doing what we're expecting.
        var previousCPUData = os.cpus();
        setInterval(function() {
            var newCPUData = os.cpus();
            var averagePercentage = 0;

            for (var i = 0; i < previousCPUData.length; i++) {
                var diffData = diffCPUStats(newCPUData[i].times, previousCPUData[i].times);
                averagePercentage += diffData.percent;
            }
            // TODO: 7. It's possible individual CPU usage may be more important than average usage.
            averagePercentage /= previousCPUData.length;

            cpuSamples.shift();
            cpuSamples.push(averagePercentage);

            memSamples.shift();
            memTotal = os.totalmem();
            memSamples.push((memTotal - os.freemem()) / memTotal);

            previousCPUData = newCPUData;
        }, 1000); // TODO: 5. We might want to make this interval configurable.
    }
}
exports.agentSetup = agentSetup;

/**
 * Call this when the server is ready-to-go (all the database connections are setup, etc.)
 */
function agentReady() {
    if (config.roleProcess.agent.probe.enabled) {
        if (config.isCyvisor || config.isLeadWebServer) {
            setInterval(function() {
                cyvisor.probeAll();
            }, PROBE_INTERVAL);
        }

        announcePresence();
    }
}
exports.agentReady = agentReady;

exports.probeIntervalGet = function(){
    return PROBE_INTERVAL;
};

exports.probeSamplesToStoreGet = function() {
    return samplesToStore;
};

function portSet(port) {
    portForThisRoleProcess = port;
}
exports.portSet = portSet;

function roleProcessDbSet(db) {
    db.collection('roleProcesses',function(err, collectionArg){
        if(err){ throw err; }
        roleProcessesCollection = collectionArg;
        exports.roleProcessesCollection = roleProcessesCollection;
    });
    db.collection('sets',function(err, collectionArg){
        if(err){ throw err; }
        setsCollection = collectionArg;
    });
}
exports.roleProcessDbSet = roleProcessDbSet;

/**
 * This function takes the difference between the 'times' section of two calls to os.cpus().
 *
 * It diffs more than the values we need in case we ever want to display the other values some time in the future.
 * @param dataNew
 * @param dataOld
 * @returns {{total: number}}
 */
function diffCPUStats(dataNew, dataOld) {
    var result = {total: 0};
    var fields = ['user', 'sys', 'irq', 'nice', 'idle'];
    for (var i = 0; i < fields.length; i++) {
        var field = fields[i];
        var num = dataNew[field] - dataOld[field];
        result[field] = num;
        result['total'] += num;
    }
    result['percent'] = (result['total'] - result['idle']) / result['total'];
    return result;
}

function responseTimeAddMeasurement(time) {
    var data = responseTimeSamples[responseTimeSamples.length-1];
    var now = Date.now();
    if (data.intervalEndsAt < now) {
        data = {total: 0, samples: 0, intervalEndsAt: now - now % responseTimeInterval + responseTimeInterval};
        responseTimeSamples.shift();
        responseTimeSamples.push(data);
    }
    data.samples++;
    data.total += time;
}
exports.responseTimeAddMeasurement = responseTimeAddMeasurement;

function networkTrafficGetMostRecentDataObject() {
    var data = networkTrafficSamples[networkTrafficSamples.length-1];
    var now = Date.now();
    if (data.intervalEndsAt < now) {
        data = {out: 0, in: 0, samples: 0, intervalEndsAt: now - now % networkTrafficInterval + networkTrafficInterval};
        networkTrafficSamples.shift();
        networkTrafficSamples.push(data);
    }
    return data;
}

function networkTrafficAddMeasurement(incomingBytes, outgoingBytes) {
    var data = networkTrafficGetMostRecentDataObject();
    data.samples++;
    data.in += incomingBytes;
    data.out += outgoingBytes;
}
exports.networkTrafficAddMeasurement = networkTrafficAddMeasurement;

function networkTrafficInstrumentMongoDB() {
    // As of v2.X of the MongoDB driver, this kind of spying on the connection no longer seems to be possible, at least not in it's current form.
    // TODO: 6. Investigate whether there might be another way to measure it, or just get rid of this code.
    /*var mongoConnectionStartOrig = MongoDBConnection.prototype.start;
    MongoDBConnection.prototype.start = function() {
        var me = this;
        var result = mongoConnectionStartOrig.apply(me, arguments);
        var knownBytesRead = 0;
        var knownBytesWritten = 0;
        me.cycligentRecordReadWrite = function() {
            networkTrafficAddMeasurement(me.connection.bytesRead - knownBytesRead, me.connection.bytesWritten - knownBytesWritten);
            knownBytesRead = me.connection.bytesRead;
            knownBytesWritten = me.connection.bytesWritten;
        };
        me.cycligentRecordReadWrite();
        me.connection.on('data', me.cycligentRecordReadWrite);
        me.connection.on('end', me.cycligentRecordReadWrite);
        me.connection.on('close', me.cycligentRecordReadWrite);
        return result;
    };

    var mongoConnectionWriteOrig = MongoDBConnection.prototype.write;
    MongoDBConnection.prototype.write = function() {
        var me = this;
        var result = mongoConnectionWriteOrig.apply(me, arguments);
        me.cycligentRecordReadWrite();
        return result;
    };*/
}

function announcePresence() {
    urlsGetForSelf(function(err, urls) {
        if (err) {
            console.error("Unable to determine URLs this role process is accessible at." +
                " Error message was: " + err.message);
        } else {
            var $set = {
                version: config.roleProcess.version,
                size: instanceSize,
                urls: urls,
                modAt: new Date()
            };

            roleProcessesCollection.updateOne({_id: config.name}, {
                $set: $set,
                $inc: {modVersion: 1}
            }, function(err) {
                if (err) {
                    console.error("An error occurred when trying to save the URLs for this role process." +
                        " Error message was: " + err.message);
                }

                probe();
            })
        }
    });
}

function networkAddressesGet() {
    var wantInternal = (config.deploymentName == "local" || config.deploymentName == "minimal");
    var interfacesFromOS = os.networkInterfaces();
    var addresses = [];
    for (var index in interfacesFromOS) {
        if (interfacesFromOS.hasOwnProperty(index)) {
            var addressesPerInterface = interfacesFromOS[index];
            for (var i = 0; i < addressesPerInterface.length; i++) {
                var info = addressesPerInterface[i];
                if (info.internal == wantInternal)
                    addresses.push({address: info.address, family: info.family});
            }
        }
    }

    // Put IPv4 addresses first.
    addresses.sort(function(a, b) {
        var aIsIPv6 = a.family == "IPv6";
        var bIsIPv6 = b.family == "IPv6";
        if (aIsIPv6 == bIsIPv6) {
            return 0;
        } else if (aIsIPv6 && !bIsIPv6) {
            return 1;
        } else {
            return -1;
        }
    });

    return addresses;
}
exports.networkAddressesGet = networkAddressesGet;

function portGet(callback) {
    var nameWithoutPrefix = config.name;
    portGet2(nameWithoutPrefix, function(err) {
        if (err && config.roleProcess.friendlyName) {
            var nameWithoutPrefix = config.roleProcess.friendlyName;
            portGet2(nameWithoutPrefix, callback);
        } else {
            callback.apply(this, arguments);
        }
    });
}

function portGet2(nameWithoutPrefix, callback) {
    var path;
    if (process.env["APP_POOL_CONFIG"]) {
        fs.readFile(process.env["APP_POOL_CONFIG"], function(err, data) {
            if (err) {
                callback(err);
            } else {
                var results = /bindingInformation=".*:(.+):.*"/.exec(data);
                // TODO: 5. This will fail (or just act in unexpected ways) if we have multiple bindings.
                if (results) {
                    callback(null, results[1]);
                } else {
                    callback(new Error("Couldn't find a bindingInformation node in APP_POOL_CONFIG."));
                }
            }
        });
    } else if (process.env["IISNODE_VERSION"] !== undefined) {
        // This logic branch is for when IIS doesn't provide us the APP_POOL_CONFIG environment variable for whatever
        // reason. We can make a pretty good guess as to what it's value should be. The file we're reading is
        // an IIS 7+ feature.
        path = "C:\\inetpub\\temp\\appPools\\" + nameWithoutPrefix + "\\" + nameWithoutPrefix + ".config";
        fs.readFile(path, function(err, data) {
            if (err) {
                callback(err);
            } else {
                var results = /bindingInformation=".*:(.+):.*"/.exec(data);
                // TODO: 5. This will fail (or just act in unexpected ways) if we have multiple bindings.
                if (results) {
                    callback(null, results[1]);
                } else {
                    callback(new Error("Couldn't find a bindingInformation node in '" + path + "'."));
                }
            }
        });
    } else if (os.platform() == "linux") {
        path = "/etc/nginx/sites-available/" + nameWithoutPrefix;
        fs.readFile(path, function(err, data) {
            if (err) {
                callback(err);
            } else {
                var results = /listen (\d+)/.exec(data);
                if (results) {
                    callback(null, results[1]);
                } else {
                    callback(new Error("Couldn't find a 'listen' line in '" + path + "'."))
                }
            }
        });
    } else if (process.env["PORT"] !== undefined) {
        // This isn't the default case because iisnode will provide a named port, and we're looking for the
        // external port, in other cases portForThisRoleProcess will contain the correct value.
        callback(null, portForThisRoleProcess.toString());
    } else {
        callback(null, "1337");
    }
}

function urlsGetForSelf(callback) {
    var addresses = networkAddressesGet();
    portGet(function(err, port) {
        if (err) {
            callback(err);
        } else {
            var urls = [];
            for (var i = 0; i < addresses.length; i++) {
                var info = addresses[i];
                // TODO: 2. We need to somehow discover whether we're on HTTP or HTTPS.
                    // maybe: req.connection.encrypted or req.protocol if the API hasn't changed
                    // http://stackoverflow.com/questions/10348906/how-to-know-if-a-request-is-http-or-https-in-node-js
                    // if behind nginx, something like:
                    // app.enable('trust proxy') and req.headers['x-forwarded-proto'] === "http"
                var url = "http://";
                if (info.family == "IPv6") {
                    url += "[" + info.address + "]";
                } else if (info.family == "IPv4") {
                    url += info.address;
                }
                url += ":" + port;
                urls.push(url);
            }
            callback(null, urls);
        }
    });
}

function pauseFuncSet(func) {
    pauseFunc = func;
}
exports.pauseFuncSet = pauseFuncSet;

function resumeFuncSet(func) {
    resumeFunc = func;
}
exports.resumeFuncSet = resumeFuncSet;

/**
 * Given a post request for a Cycligent Agent command, this function verifies that all the parameters are correct
 * and that the user is authorized to execute the command, and then forwards the information on to commandSend.
 * (which will execute the command if it is meant for the role process receiving it.)
 *
 * @param {Object} state
 * @param {Object} state.request
 * @param {Object} state.response
 * @param {Object} state.parsedUrl
 */
function action(state) {
    // TODO: 3. Authorization should be more fine-grained than isNavigable, long-term.
    if (!state.user
        || state.user.type != "authenticated"
        || !authorize.isNavigable(state.user, 'functions', '/cycligent/control/')) {
        state.response.writeHead(401, {'Content-Type': 'text/plain'});
        state.response.end("You aren't authorized to do that.");
        return;
    }

    try {
        var data = JSON.parse(state.requestData);
    } catch(e) {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Malformed data was provided.");
        return;
    }

    if (!data.roleProcess_id || typeof data.roleProcess_id != "string") {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Parameter 'roleProcess_id' was provided invalidly.");
        return;
    }

    try {
        data.roleProcess_id = new config.mongodb.ObjectID(data.roleProcess_id);
    } catch(e) {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Parameter 'roleProcess_id' was malformed.");
        return;
    }

    if (!data.set_id || typeof data.set_id != "string") {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Parameter 'set_id' was provided invalidly.");
        return;
    }

    try {
        data.set_id = new config.mongodb.ObjectID(data.set_id);
    } catch(e) {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Parameter 'set_id' was malformed.");
        return;
    }

    if (!data.action || typeof data.action != "string") {
        state.response.writeHead(400, {'Content-Type': 'text/plain'});
        state.response.end("Parameter 'action' was provided invalidly.");
        return;
    }

    actionExecute(state, data);
}
exports.action = action;

function actionExecute(state, data){


    // Set machine status appropriately based on action
    switch(data.action){

        case "Delete machine":
        case "Stop role process":
        case "Shut down machine":
            machineStatus.major = "Pending";
            machineStatus.minor = data.action;
            break;

        case "Ignore role process requests":
            machineStatus.major = "Offline";
            machineStatus.minor = "Ignoring requests";
            break;

        case "Handle role process requests":
            machineStatus.major = "Online";
            machineStatus.minor = "Healthy";
            break;

    }

    if (flavor) {
        flavor.actionExecute(state, data, function() {
            state.response.writeHead(200, {'Content-Type': 'text/plain'});
            state.response.end("success");
        });
    } else {
        state.response.writeHead(500, {'Content-Type': 'text/plain'});
        state.response.end("Cycligent Server doesn't yet know how to perform actions on machines in deployment type '"
            + config.deploymentName + "'");
    }
}

function ignoreRequests() {
    if (pauseFunc)
        pauseFunc();
    ignoringRequests = true;
    return config.name + ' version ' + config.version + ' is now down for debugging.';
}
exports.ignoreRequests = ignoreRequests;

function handleRequests() {

    if (resumeFunc)
        resumeFunc();
    ignoringRequests = false;
    return config.name + ' version ' + config.version + ' is up again.';
}
exports.handleRequests = handleRequests;

function probeReturnHTTP(state) {
    probe(function(status) {
        var res = state.response;

        if (status.major == 'Online') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end(os.hostname() + ' version ' + config.version + ' healthy: ' + probeCount);
        } else {
            res.writeHead(503, {'Content-Type': 'text/plain'});
            res.end(os.hostname() + ' version ' + config.version + ' ' + status.major + ' (' + status.minor + '): ' + probeCount);
        }
    });
}
exports.probeReturnHTTP = probeReturnHTTP;

var probeCount = 0;

/**
 * Discovers the current status of the role process, and puts the
 * results in the database.
 *
 * @param [callback] Callback to call with the status of the role process.
 */
function probe(callback){

    //TODO: 4. Should check CPU level along with other stuff here to determine true health
    //TODO: 4. Should check for going offline for update here
    //TODO: 4. Think about how to handle preview here!

    // TODO: 2. Implement checks for all these statuses.
    /*
     Possible probe statuses (not all are currently implemented):
     Online (Healthy)
     Pending (Approving, Creating, Starting, Debugging, Maintenance, Restarting, Resizing, Updating application)
     Impaired (High CPU load, Slow responses, Low memory, High net)
     Disconnected (Paused, Message bus, DB)
     Unresponsive (Deleting, Process stopped, Shutdown, No probes)
     */

    // For reasons I don't understand (didn't have enough time to look into it), the wtimeout parameter doesn't
    // seem to be working (or maybe it just does nothing when a timeout happens, I'm not sure.) So I've created
    // my own timeout.
    var updateCompleted = false;
    var findCompleted = false;
    var timedOut = false;

    probeCount++;

    roleProcessesCollection.findOne({_id: config.name}, {fields: {_id: 1, friendlyName: 1, status: 1}}, function(err, doc){
        findCompleted = true;
        if(err || timedOut || !doc){
            machineStatus.major = 'Impaired';
            machineStatus.minor = 'DB';
            if(callback){
                callback(machineStatus);
            }
            return;
        }

        if(doc.status && doc.status.setByCyvisor && machineStatus.setByCyvisor != "ignore"){
            /*
            IF the Cyvisor set the status
            AND it is not the case that the minor status is "Handle role process requests" and it is not the case that ignoring requests == false.
            AND it is not the case that the major status is pending and the minor status is Create machine
            AND it is not the case that the major status is pending and the minor status is Start role process
            THEN update the major and minor status STORED ON THIS MACHINE
             */
            if (!(doc.status.minor == "Handle role process requests" && ignoringRequests == false)
                && !(doc.status.major == "Pending" && doc.status.minor == "Create machine")
                && !(doc.status.major == "Pending" && doc.status.minor == "Start role process")) {
                machineStatus.major = doc.status.major;
                machineStatus.minor = doc.status.minor;
            }
        } else if (ignoringRequests) {
            machineStatus.major = 'Offline';
            machineStatus.minor = 'Ignoring requests';
        } else if(machineStatus.minor == 'DB') {
            machineStatus.major = 'Online';
            machineStatus.minor = 'Healthy';
        }

        machineStatus.cpuSamples = cpuSamples;
        machineStatus.memSamples = memSamples;
        machineStatus.memTotal = memTotal;
        machineStatus.responseTimeSamples = responseTimeSamples.map(
            function(data) {
                if (data.samples == 0)
                    return 0;
                else
                    return data.total / data.samples;
            });
        machineStatus.networkTrafficSamples = networkTrafficSamples.map(
            function(data) {
                if (data.samples == 0)
                    return 0;
                else
                    return Math.round((data.in + data.out) * BYTES_PER_SEC_FACTOR);   // Convert to bytes per second
            });

        machineStatus.modAt = new Date();
        machineStatus.setByCyvisor = false;

        machineStatus.probeCount = probeCount;

        roleProcessesCollection.updateOne({_id: config.name}, {$set: {status: machineStatus}}, function(err){

                updateCompleted = true;

                if(err || timedOut) {
                    machineStatus.major = 'Impaired';
                    machineStatus.minor = 'DB';
                }

                if(callback){
                    callback(machineStatus);
                }
        });

        setTimeout(function() {
            if (!updateCompleted) {
                timedOut = true;
                machineStatus.major = 'Impaired';
                machineStatus.minor = 'DB';
                if(callback){
                    callback(machineStatus);
                }
            }
        }, 5000);
    });

    setTimeout(function() {
        if (!findCompleted) {
            timedOut = true;
            machineStatus.major = 'Impaired';
            machineStatus.minor = 'DB';
            if(callback){
                callback(machineStatus);
            }
        }
    }, 5000);

}
exports.probe = probe;

function versionTypeRedirect(state) {
    var args = querystring.parse(state.parsedUrl.query);

    if (!args || !args.versionType || !args.url) {
        state.response.writeHead(400, {'Content-Type': 'application/json'});
        state.response.end(JSON.stringify({
            status: "error",
            error: "versionTypeRedirect: Expected versionType and url as GET query parameters."
        }));
        return;
    }

    if (!/^[a-z][a-z0-9-_]*$/.test(args.versionType)) {
        state.response.writeHead(400, {'Content-Type': 'application/json'});
        state.response.end(JSON.stringify({
            status: "error",
            error: "versionTypeRedirect: Invalid versionType specified."
        }));
        return;
    }

    state.response.writeHead(302, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'versionType=' + args.versionType + "; Path=/",
        'Location': args.url
    });
    state.response.end("Redirecting you. If your browser does not automatically redirect you, <a href='" +
        utils.htmlAttributeEscape(args.url) + "'>click here</a>.");
}
exports.versionTypeRedirect = versionTypeRedirect;

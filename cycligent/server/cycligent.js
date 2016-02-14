if (process.argv[2] == "-agent") {
    require('./agentCommandLine.js');
    return;
}

console.time(padTo("Startup - Ready"));
console.log("========= S T A R T U P ==========");

console.time(padTo("Startup - Requirements"));

// Built in modules
var http = require("http");
var https = require("https");
var url = require("url");
var path = require("path");
var fs = require("fs");
var os = require("os");
var querystring = require("querystring");
var crypto = require("crypto");

// NPM Modules
var mongodb = require('mongodb');
var mongoClient = mongodb.MongoClient;
var istanbul = require('istanbul');
var instrumenter = new istanbul.Instrumenter({embedSource: true});

// Local Modules
/**@type {Logger}*/ var log = require("./log.js");
var agent = require('./agent.js');
var cyvisor = require('./cyvisor.js');
var proxy = require('./proxy.js');
var State = require('./state.js');
var cache = require('./cache.js');
var call = require('./call.js');
var menu = require('./menu.js');
var query = require('./query.js');
var download = require('./download.js');
var User = require('./user.js');
var users = require('./users.js');
var messageBus = require('./messageBus.js');
/**@type {Authorize}*/ var authorize = require('./authorize.js');
var authenticators = require('./authenticators.js');

var messageBusListenerID;
var httpServer;
var httpsServer;
var getDynamicTypes = {};
var postTypes = {};
var root;
var port = process.env.PORT || 1337;
var portHTTPS = process.env.PORT_HTTPS || 1380;
var cacheRegex = /-\d+\.\d+\.\d+\./;

console.timeEnd(padTo("Startup - Requirements"));

console.time(padTo("Startup - Root Process"));

/**@type {ServerConfig}*/ var config = require('./configProcess.js');

config.configProcessExecute(function() {
    config.mongodb = mongodb;

    console.log("========= CONFIGURATION ==========");
    console.log("----------- DEPLOYMENT -----------");
    console.log("             Name: " + config.deploymentName );
    for(var configName in config.versions){
        console.log("         ".substr(0,9-configName.length) + " " + configName.substr(0,1).toUpperCase() + configName.substr(1) + " Version: " + config.versions[configName]);
    }
    console.log("------------- SERVER -------------");
    console.log("             Name: " + config.name );
    console.log("   Server Version: " + config.version );
    console.log("     Version Type: " + config.versionType );
    console.log("        Role Type: " + config.roleType );
    console.log("           Router: " + (config.router ? 'Yes' : 'No'));
    if(config.roleType == 'web'){
        console.log("----------- PROCESSES ------------");
        console.log("      In Instance: " + config.processes.inInstance);
        console.log("      Long Worker: " + config.processes.longWorker);
        console.log("           Worker: " + config.processes.worker);
    } else {
        console.log("        Processes: " + config.processes);
    }
    console.log("==================================");

    console.timeEnd(padTo("Startup - Root Process"));

    if(config.activeDeployment.conduit && (config.activeDeployment.conduit.enable.server || config.activeDeployment.conduit.enable.controller)){
        console.time(padTo("Startup - Conduit"));
        if(config.activeDeployment.conduit.enable.server){
            var conduit = require('../conduit/server.js');
        }
        if(config.activeDeployment.conduit.enable.controller){
            /**@type {ConduitController}*/ var controller = require('../conduit/controller.js');
            //TODO: 3. Make this more secure by having the certificate come from the DB (each DB would then have to match) and could be changed somehow dynamically by day or week
            controller.encoderSet(sessionEncode);
        }
        console.timeEnd(padTo("Startup - Conduit"));
    }

    startup();
});

// ======================================================================= //
// ================ CYCLIGENT SERVER STARTUP FUNCTIONS =================== //
// ======================================================================= //

function startup(){
    console.time(padTo("Startup - Configure"));
    agentSetup();
    rootsSetup();
    console.timeEnd(padTo("Startup - Configure"));
    console.time(padTo("Startup - Initialize"));
    dbsOpen();
}

function startupError(errorMessage){
    console.error("Cycligent Server startup failure:\n     " + errorMessage + "\nCycligent Server Stopped!" );
    process.exit(1); // Exit with an error
}

function startupMongoDbError(errorMessage) {
    console.error("Cycligent Server MongoDB startup failure:\n     " + errorMessage + "\nCycligent Server Stopped!" );
    process.exit(1); // Exit with an error
}

function pause() {
    if (messageBusListenerID != null)
        messageBus.pause(messageBusListenerID);
}

function resume() {
    if (messageBusListenerID != null)
        messageBus.resume(messageBusListenerID);
}

function agentSetup(){
    if(config.roleProcess.agent){
        agent.agentSetup();

        getDynamicTypes["/cycligent/agent/version-type-redirect"] = agent.versionTypeRedirect;

        if(config.roleProcess.agent.probe.enabled){
            getDynamicTypes["/cycligent/agent/probe"] = agent.probeReturnHTTP;
            getDynamicTypes["/cycligent/agent/probeAll"] = cyvisor.probeAllReturnHTTP;

            // Cycligent Agent Control is dependent on Probe, so only set it up if probe is enabled.
            if (config.roleProcess.agent.control.enabled) {
                postTypes["/cycligent/agent/command"] = {handler: agent.action, preProcess: false};
                agent.pauseFuncSet(pause);
                agent.resumeFuncSet(resume);
            }
        }

        if (config.isCyvisor) {
            postTypes["/cycligent/cyvisor/joined-subscription"] = {handler: cyvisor.joinedSubscription, preProcess: false};
            postTypes["/cycligent/cyvisor/deployment-completed"] = {handler: cyvisor.deploymentCompleted, preProcess: false};
            postTypes["/cycligent/cyvisor/rolling-restart-status"] = {handler: cyvisor.rollingRestartStatus, preProcess: true};
        }

        if(config.roleProcess.agent.instrument){
            postTypes["/cycligent/agent/instrument"] = {handler: cycligentAgentInstrument, preProcess: true};
        }
    }
}

var cycligentAgentInstrumentMap = {};
function cycligentAgentInstrument(state){
    var res = state.response;

    //TODO: 3. Certificate should really be time sensitive
    if(config.roleProcess.agent.instrument.certificate == state.post.certificate){
        cycligentAgentInstrumentMap = state.post;
        res.writeHead(200, {'Content-Type': 'text/plain;charset=utf-8'});
        res.end("Requested files set for code coverage instrumentation via istanbul.");
    } else {
        res.writeHead(403, {'Content-Type': 'text/html;charset=utf-8'});
        res.write("<html><body>");
        res.write("<p>Inappropriate authorization for instrumentation.</p>");
        res.end("</body></html>");
    }

}

function rootsSetup(){
    for(var rootMap in config.roots){

        root = config.roots[rootMap];

        if(root.authenticators.length != 0) {
            for (var i = 0; i < root.authenticators.length; i++) {
                var authenticatorName = root.authenticators[i];
                var authenticatorConfig = config.activeDeployment.authenticators[authenticatorName];

                var authHelpers = authenticators.helpers[authenticatorConfig.provider];
                authHelpers.setup(authenticatorName, authenticatorConfig);

                var specializedSignOn = (function(authenticatorConfig) {
                    return function(state) {
                        return signOn(state, authenticatorConfig);
                    };
                })(authenticatorConfig);
                postTypes["/" + rootMap + "/" + authenticatorConfig.signOnURL] = {handler: specializedSignOn, preProcess: false};
                getDynamicTypes["/" + rootMap + "/" + authenticatorConfig.signOnURL] = specializedSignOn;
            }
            getDynamicTypes["/" + rootMap + "/signOff"] = signOff;
        }

        if(root.supports.provider){
            if (rootMap != "cycligent" || (rootMap == "cycligent" && config.isCyvisor)) { // The provider on cycligent should only work for the Cyvisor.
                postTypes["/" + rootMap + "/provider.aspx"] = {handler: provider, preProcess: true};
            }
        }

        if(root.supports.testSignOn){
            getDynamicTypes["/" + rootMap + "/testSignOn"] = testSignOn;
            if(!root.authenticator){
                getDynamicTypes["/" + rootMap + "/testSignOff"] = signOff;
            }
        }

        if(root.conduit){
            postTypes["/" + rootMap + "/server"] = {handler: conduit, preProcess: false};
        }
        
        var postExports = config.postMap[rootMap];
        for (var path in postExports) {
            if (postExports.hasOwnProperty(path)) {
                postTypes["/" + rootMap + "/" + path] = postExports[path];
            }
        }

        var getExports = config.getMap[rootMap];
        for (var path in getExports) {
            if (getExports.hasOwnProperty(path)) {
                getDynamicTypes["/" + rootMap + "/" + path] = getExports[path].handler;
            }
        }
    }
    cache.mapSet(config.cachePlanMap,config.cacheServiceMap);
    call.mapSet(config.callMap);
    download.mapSet(config.downloadMap);
    query.mapSet(config.queryMap);
}

// Open Configured Databases (step 1 of final ready process)
function dbsOpen(){

    config.dbs = config.activeDeployment.versionTypes[config.versionType].dbs;
    var db;
    var remaining = 0;

    // If the active deployment uses a message bus add the database to the list of databases to open
    if(config.activeDeployment.messageBus){
        config.dbs.messageBus = config.activeDeployment.messageBus.db;
    }

    for(var dbIndex in config.dbs){

        remaining++;

        db = config.dbs[dbIndex];

        console.log(pad("Opening Mongo DB '" + dbIndex + "' via URI connection..."));
        (function(dbIndex) {
            mongoClient.connect(db.uri, db.options, function(err, dbConnected){
                if(err){
                    startupMongoDbError(err.message);
                }
                config.dbs[dbIndex].db = dbConnected;

                var connections = dbConnected.serverConfig.connections();
                for (var i = 0; i < connections.length; i++ ) {
                    if (connections[i].seenByCycligent)
                        continue;
                    (function(connection) {
                        connection.seenByCycligent = true;
                        // The new MongoDB driver makes it hard to measure bytes sent to MongoDB, but bytes received
                        // is relatively simple and is handled by the code below:
                        connection.on('message', function(response) {
                            agent.networkTrafficAddMeasurement(response.length, 0);
                        });
                    })(connections[i]);
                }
                console.log(pad("Mongo DB '" + dbIndex + "' open."));

                if(--remaining <= 0){
                    logsOpen();
                }

            });
        })(dbIndex);
    }
}

function logsOpen(){

    var dbSpec = config.dbs.cycligent;
    var logToConsole = true;

    dbSpec.db.listCollections({name: "log"}).toArray(function(err, names){

        if(err){
            startupMongoDbError(err.message);
        }

        for(var i in names){
            if( names[i].name == "log"){
                console.log(pad("Verified existence of Cycligent system log."));
                log.dbSet(dbSpec.db,logToConsole);
                roleProcessesCollectionOpen();
                return;
            }
        }

        console.log(pad("Creating log collection."));
        dbSpec.db.createCollection("log",{capped: true, size: 400000}, function(err,collection){
            if(err){
                startupMongoDbError(err.message);
            }
            console.log(pad("Cycligent system log collection created."));
            log.dbSet(dbSpec.db,logToConsole);
            roleProcessesCollectionOpen();
        });

    });
}

function roleProcessesCollectionOpen() {
    var dbSpec = config.dbs.cycligent;

    dbSpec.db.listCollections({name: "roleProcesses"}).toArray(function(err, names){

        if(err){
            startupMongoDbError(err.message);
        }

        for(var i in names){
            if( names[i].name == "roleProcesses"){
                console.log(pad("Verified existence of Cycligent system roleProcesses collection."));
                agent.roleProcessDbSet(dbSpec.db);
                cyvisor.roleProcessDbSet(dbSpec.db);
                instanceIdsCollectionOpen();
                return;
            }
        }

        console.log(pad("Creating roleProcesses collection."));
        dbSpec.db.createCollection("roleProcesses", {}, function(err,collection){
            if(err){
                startupMongoDbError(err.message);
            }
            console.log(pad("Cycligent system roleProcesses collection created."));
            agent.roleProcessDbSet(dbSpec.db);
            cyvisor.roleProcessDbSet(dbSpec.db);
            instanceIdsCollectionOpen();
        });

    });
}

function instanceIdsCollectionOpen() {
    var dbSpec = config.dbs.cycligent;

    dbSpec.db.listCollections({name: "instanceIds"}).toArray(function(err, names){

        if(err){
            startupMongoDbError(err.message);
        }

        for(var i in names){
            if( names[i].name == "instanceIds"){
                console.log(pad("Verified existence of Cycligent system instanceIds collection."));
                cyvisor.instanceIdsDBSet(dbSpec.db);
                messageBusOpen();
                return;
            }
        }

        console.log(pad("Creating instanceIds collection."));
        dbSpec.db.createCollection("instanceIds", {}, function(err,collection){
            if(err){
                startupMongoDbError(err.message);
            }
            console.log(pad("Cycligent system instanceIds collection created."));
            cyvisor.instanceIdsDBSet(dbSpec.db);
            messageBusOpen();
        });

    });
}

function messageBusOpen(){

    if(config.router || config.roleType != 'web'){
        messageBus.start(config,messageBusReady);
    } else {
        webListen(false);
    }

}

function messageBusReady(){

    switch(config.roleType){
        case 'web':
            // The web server listens for web requests generally.
            // Messages are only listened for within the specific web request that initiates the message.
            webListen(false);
            break;

        case 'cyvisor':
            webListen(false);
            break;

        case 'worker':
            messageBusListenerID = messageBus.listen('Worker',config.processes,config.versionExtended,workerRequest);
            console.log(pad("Cycligent server listening for worker messages on channel: 'worker', version " + config.version));
            if(config.roleProcess.agent.probe.enabled){
                webListen(true);
            } else {
                systemReady();
            }
            break;

        case 'longWorker':
            messageBusListenerID = messageBus.listen('Long Worker',config.processes,config.versionExtended,workerRequest);
            console.log(pad("Cycligent server listening for worker messages on channel: 'longWorker', version " + config.version));
            if(config.roleProcess.agent.probe.enabled){
                webListen(true);
            } else {
                systemReady();
            }
            break;

        default:
            startupError("CONFIG ERROR: Unknown roleType '" + config.roleType + "' specified.");
            break;
    }
}

function webListen(agentOnly) {
    var httpReady = false;
    var httpsReady = false;

    httpServer = http.createServer();
    serverSetup(httpServer, port, agentOnly, function(actualPort) {
        agent.portSet(actualPort);
        agent.agentReady();
        proxy.proxyReady();
        httpReady = true;
        console.log(pad("Cycligent server listening for client HTTP connections on port: " + actualPort));
        if (httpReady && httpsReady) {
            systemReady();
        }
    });

    if (config.activeDeployment.https) {
        httpsServer = https.createServer(config.activeDeployment.https);
        serverSetup(httpsServer, portHTTPS, agentOnly, function(actualPort) {
            httpsReady = true;
            console.log(pad("Cycligent server listening for client HTTPS connections on port: " + actualPort));
            if (httpReady && httpsReady) {
                systemReady();
            }
        });
    } else {
        httpsReady = true;
    }
}

function serverSetup(server, port, agentOnly, callback) {
    if (agentOnly && !config.isCyvisor) {  // I don't like the && !config.isCyvisor (makes the agentOnly flag more confusing), but can't think of a good alternative at the moment.
        server.on('request', agentRequest);
    } else {
        server.on('request', webRequest);
    }

    // TODO: 5. One day we may want to also listen on IPv6.
    server.listen(port,  config.activeDeployment.httpListenHostname, function() {
        var actualPort = server.address().port; // If port was == 0, we don't know the actual port value until after the call to 'listen'.
        callback(actualPort);
    });
}

function gracefulShutdown() {
    console.log("Cycligent Server is gracefully shutting down.");
    webClose(function() {
        console.log("HTTP Server shut down.");
        dbsClose(function() {
            console.log("Database connections closed.");
            // TODO: 6. In theory, after closing the DB connections and the HTTP server, nodejs should stop running by itself,
            // but it doesn't, we need to figure out what's holding it open, and deal with that.
            process.exit(0);
        });
    });
}
exports.gracefulShutdown = gracefulShutdown;

function dbsClose(callback) {
    for (var dbName in config.dbs) {
        if (config.dbs.hasOwnProperty(dbName)) {
            var db = config.dbs[dbName];
            db.db.close();
        }
    }
    callback();
}

function webClose(callback) {
    var httpClosed = false;
    var httpsClosed = false;
    if (httpServer) {
        httpServer.close(function() {
            httpClosed = true;
            finish();
        });
    } else {
        httpClosed = true;
    }

    if (httpsServer) {
        httpsServer.close(function() {
            httpsClosed = true;
            finish();
        });
    } else {
        httpsClosed = true;
    }

    finish();

    function finish() {
        if (httpClosed && httpsClosed) {
            callback();
        }
    }
}

function systemReady(){

    console.timeEnd(padTo("Startup - Initialize"));
    console.timeEnd(padTo("Startup - Ready"));
    console.log("==================================");
    console.log("===== CYCLIGENT SERVER READY =====");
    console.log("==================================");
    exports.systemReady = true;
}
exports.systemReady = false;

function workerRequest(state){
    if(state.fileCallProcess){
        call.textFileProcess(state,state.fileCallProcess.method,state.fileCallProcess.parameters,fileCallProcessReply);
    } else {
        provider2(state);
    }
}

function fileCallProcessReply(state,replacement){
    switch(config.roleType){
        case 'worker':
            messageBus.send(
                state.returnTo.channel,
                state.returnTo.subChannel,
                state.returnTo.version,
                false,
                replacement
            );
            break;

        case 'longWorker':
            messageBus.send(
                'Long Worker Reply',
                state.returnTo.subChannel,
                state.returnTo.version,
                false,
                replacement
            );
            break;
    }
}

// ========================================================================== //
// ================ CYCLIGENT SERVER PROCESSING FUNCTIONS =================== //
// ========================================================================== //

function sessionEncode(data){
    var cipher = crypto.createCipher("aes192","road37)CYCLING");
    var chunks = [];
    chunks.push(cipher.update(data, 'utf8', 'hex'));
    //noinspection JSUnresolvedFunction,ReservedWordAsName
    chunks.push(cipher.final('hex'));
    return chunks.join('_');
}

function sessionDecode(data){
    try {
        var cipher = crypto.createDecipher("aes192","road37)CYCLING");
        var encodedChunks = data.split("_");
        var chunks = [];
        for(var i=0; i < encodedChunks.length;i++){
            chunks.push(cipher.update(encodedChunks[i], 'hex', 'utf8'));
        }
        //noinspection JSUnresolvedFunction,ReservedWordAsName
        chunks.push(cipher.final('utf8'));
        return chunks.join('');
    } catch(e) {
        return '';
    }
}

function userFetch(state,callback){

    var cookie;
    var user_id;
    var userType;

    state.dbs = {};

    if(state.request.headers){

        cookie = querystring.parse(state.request.headers.cookie,'; ');

        // Sometimes multiple cookies can end up being set, so cookie.user_role will end up as an array, so we
        // have to pick one of the cookies:
        if (Array.isArray(cookie.user_role)) {
            var chosenCookie = cookie.user_role;
            for (var i = 0; i < cookie.user_role.length; i++) {
                if (cookie.user_role[i].indexOf("..") != -1) {
                    chosenCookie = cookie.user_role[i];
                }
            }
            cookie.user_role = chosenCookie;
        }

        if(cookie.user_role){

            var splits = cookie.user_role.split('..');
            var cookieUser = splits[0];
            var cookieRole = splits[1];
            var authorization = sessionDecode(splits[2] || sessionEncode(''));

            var check_id = sessionDecode(cookieUser);

            if(check_id.substr(0,10) === '_CYC_AUTH_'){
                user_id = check_id.substr(10);
                userType = "authenticated";
                state.rootDbsSet(config,userType);
                state.authorization = authorization;
            } else if(check_id.substr(0,10) === '_CYC_TEST_'){
                user_id = check_id.substr(10);
                userType = "test";
                state.rootDbsSet(config,userType);
                state.testUser = true;
                state.authorization = authorization;
            } else if (check_id.substr(0,10) === '_CYC__OFF_'){
                // Do nothing, the user is logged off.
            } else if(config.activeDeployment.conduit && check_id === "_CYC_CNDU_" + config.activeDeployment.conduit.certificate ){
                userType = "conduitController";
                state.rootDbsSet(config,userType);
            }

        }

        if(user_id && state.sessionDb){
            state.timerStart("userFetch");
            state.sessionDb.collection('users',function(err, collection){
                if(err){
                    state.error(err.message);
                    callback(state); // just return
                } else {
                    collection.find({_id: user_id, active: true}).toArray(function(err,results){
                        if(err){
                            state.error(err.message);
                            callback(state);
                        } else {
                            state.timerStop("userFetch");
                            if(results.length == 1){
                                var user = results[0];
                                if (user.authorizationTokens
                                    && user.authorizationTokens[authorization]
                                    && user.authorizationTokens[authorization].expires > new Date()) {
                                    state.user = new User(state,userType, user, sessionDecode(cookieRole), config);
                                    callback(state);
                                } else {
                                    userFetch2(state, callback);
                                }
                                userCleanAuthorizationTokens(user, collection);
                            } else if (results.length == 0) {
                                userFetch2(state, callback);
                            } else {
                                callback(state);
                            }
                        }
                    });
                }
            });
        } else {
            userFetch2(state,callback);
        }
    } else {
        userFetch2(state,callback);
    }
}

// Standard user fetch did not establish a user.
// Create an anonymous user if the root is anonymous.
function userFetch2(state,callback){

    if(!state.user && (state.root.authenticators.length == 0 || state.root.anonymousUsersAllowed)){
        var userDoc = users.userDocGenerate(state, 'anonymous@unknown.com', 'Anonymous', 'User', '/', 'admin@i3.io');

        var cookie = querystring.parse(state.request.headers.cookie,'; ');
        if (cookie && cookie.versionType) {
            userDoc.roles[0].versionType = cookie.versionType;
        }

        state.user = new User(state, 'anonymous', userDoc, userDoc.roleCurrent.toString(), config);
        state.rootDbsSet(config,state.user.type);
    }

    callback(state);
}

function agentRequest(request, response){
    networkTrafficMeasure(request, response);
    var parsedUrl = url.parse(request.url);
    var pathName = parsedUrl.pathname;

    if(pathName == "/cycligent/agent/probe"){
        agent.probeReturnHTTP({response: response});
    } else if (pathName == "/cycligent/agent/probeAll") {
        cyvisor.probeAllReturnHTTP({response: response});
    } else if (config.roleProcess.agent.control.enabled && pathName == "/cycligent/agent/command") {
        if (request.method != "POST") {
            response.writeHead(400, {'Content-Type': 'text/plain'});
            response.end("The server doesn't understand the request method used on the given path.");
        } else {
            var state = new State(config, request, response, parsedUrl, parsedUrl.pathname);
            userFetch(state, function() {
                postDataRead(state, request, function() {
                    agent.action(state);
                });
            });
        }
    } else {
        response.writeHead(404, {'Content-Type': 'text/plain;charset=utf-8'});
        response.end("Unknown agent request. URL: '" + request.url + "'.");
    }
}

/**
 * Will receive all the data from the post request, calling the callback when everything has been loaded into
 * state.requestData.
 *
 * This will destroy the socket if a flood attack is detected.
 *
 * @param {State} state
 * @param {http.IncomingMessage} request
 * @param {Function} callback
 */
function postDataRead(state, request, callback) {
    state.requestData = '';
    request.on('data', function (data) {
        state.requestData += data;
        if (state.requestData.length > 1e6) {
            // Flood attack or faulty client, destroy connection
            log.write('server',state.errorLevels.informationImportant,"POSSIBLE FLOOD ATTACK DETECTED.");
            request.connection.destroy();
        }
    });

    request.on('end', callback);
}

function networkTrafficMeasure(request, response) {
    // Sometimes when there is an issue with the request, we'll be missing response.socket:
    if (!request || !response || !response.socket) {
        return;
    }

    var start = Date.now();
    request.timingStart = start;
    // Note to future readers: Response and request appear to use the same socket (it makes sense, it just seems weird
    // to see response.socket.bytesRead)
    if (!response.socket.cycligent) {
        var socket = response.socket;
        socket.cycligent = true;
        var knownBytesRead = 0;
        var knownBytesWritten = 0;
        socket.recordReadWrite = function() {
            agent.networkTrafficAddMeasurement(socket.bytesRead - knownBytesRead, socket.bytesWritten - knownBytesWritten);
            knownBytesRead = socket.bytesRead;
            knownBytesWritten = socket.bytesWritten;
        };

        socket.recordReadWrite(); // By this point it seems that data has already been read from the socket.
        var writeOrig = socket.write;
        socket.write = function() {
            var result = writeOrig.apply(this, arguments);
            socket.recordReadWrite();
            return result;
        };
        socket.once('end', function() {
            socket.recordReadWrite();
        });

        socket.once('close', function() {
            socket.recordReadWrite();
        });
    } else {
        // Sockets get reused thanks to persistent HTTP connections.
        // Most/all of the reading for the request has already taken place (no data events get emitted if we listen for
        // them.)
        response.socket.recordReadWrite();
    }

    // The 'finish' event is emitted when everything finishes normally, 'close' appears to be emitted in all other
    // circumstances.
    response.on('finish', function() {
        var end = Date.now();
        agent.responseTimeAddMeasurement(end - start);
    });
    // TODO: 2. If the browser terminates the connection early, or if the server takes too long to respond, the socket
    // will close and we'll receive this close event. If we register a 'timeout' listener, we'll specifically get events
    // for when the server takes too long to respond, in addition to the 'close' event. We need to decide whether this
    // is important enough to capture. If we listen for a timeout event, we have to cleanup the socket ourselves,
    // whatever that means. I'd like to check the nodejs source to find out exactly what they do (I'm thinking it's
    // just a call to socket.destroy().)
    response.on('close', function() {
        var end = Date.now();
        agent.responseTimeAddMeasurement(end - start);
    });
}

function webRequest(request, response){
    networkTrafficMeasure(request, response);
    var parsedUrl = url.parse(request.url);
    var pathName = parsedUrl.pathname;

    response.on('timeout', function() {
        console.error('The server took too long to respond to a request for "' + pathName + '" and the socket timed out.');
        response.socket.destroy();
    });

    // The Cyvisor should only serve things out of the /cycligent/ or /control/ roots.
    if (config.roleType != "web" && config.isCyvisor && pathName.indexOf("/cycligent/") < 0 && pathName.indexOf("/control/") < 0) {
        if (pathName == "/") {
            redirect(response, "/control/client/markup-i3i.html");
            return;
        } else {
            response.writeHead(404);
            response.end();
            return;
        }
    }

    var proxies = config.activeDeployment.proxy;
    for (var proxyName in proxies) {
        if (proxies.hasOwnProperty(proxyName)) {
            var proxy = proxies[proxyName];
            if ((proxy.httpMethods == '*' || proxy.httpMethods[request.method])
                && proxy.urlMatcher.test(parsedUrl.href)) {
                proxy.action.call(proxy, parsedUrl, request, response);
                return;
            }
        }
    }

    //TODO: 5. would be nice if we could find a better way for this - parser error trying to set root causes this to fail
    var state;
    var rewrite;
    var rewriteIndex;
    var rewritePath;
    if(config.rewrites){
        for(rewriteIndex = 0; !rewritePath && rewriteIndex < config.rewrites.length; rewriteIndex++){
            rewrite = config.rewrites[rewriteIndex];
            if(rewrite.defaultDoc){
                if(rewrite.replace == pathName){
                    rewritePath = rewrite.with + "/" + rewrite.defaultDoc;
                }
            }
            if(!rewritePath){
                if(rewrite.replace == "/"){
                    if(/^\/[^/]+\.[0-9A-Za-z]+$/.test(pathName)){
                        rewritePath = rewrite.with + "/" + pathName.substr(1);
                    }
                } else {
                    if (pathName.indexOf(rewrite.replace + (rewrite.replace == "" ? "" : "/")) == 0) {
                        rewritePath = rewrite.with + "/" + pathName.substr(rewrite.replace.length + 1);
                    }
                }
            }
        }
        if(rewritePath){
            parsedUrl.href = rewritePath;
            parsedUrl.path = rewritePath;
            parsedUrl.pathName = rewritePath;
            state = new State(config,request,response,parsedUrl,rewritePath);
        }
    }

    if(!rewritePath){
        if(pathName == "/"){
            redirect(response, config.defaultDoc);
            return;
        }
        state = new State(config,request,response,parsedUrl,pathName);
    }

    //var state = new State(config,request,response,parsedUrl,pathName);

    if(state.root){

        // If the method is a post we need to get the data from the request right away before the connection is closed.
        if(request.method == "POST"){
            var postType = postTypes[state.pathName];
            if (postType) {
                if (postType.originalRequestRetain) {
                    state.request = request;
                }
                if (postType.postDataRead == false) {
                    userFetch(state, request2);
                } else {
                    postDataRead(state, request, function() {
                        // Check to see if we have a session
                        userFetch(state, request2);
                    });
                }
            } else {
                response.writeHead(400, {'Content-Type': 'text/plain;charset=utf-8'});
                response.end("The Cycligent Server does not understand a post to '" + state.pathName + "'");
            }
        } else {
            userFetch(state, request2);
        }

    }else{

        var res = state.response;
        res.writeHead(401, {'Content-Type': 'text/plain;charset=utf-8'});
        res.end("Unknown root '" + state.rootName + "'");
    }
}

//TODO: 3. Look to optimize this function
function resourceAnonymous(state){

    for(var i=0; i < config.anonymousPaths.length; i++){
        if(state.pathName.indexOf(config.anonymousPaths[i]) == 0){
            return true;
        }
    }

    return false;
}

function redirectToAuthenticator(state) {
    var authenticatorConfig = state.authenticatorConfig;
    var res = state.response;

    if (authenticatorConfig === undefined) {
        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        res.end("<html><body><p>For root '" + state.rootName + "' no authenticator was configured.</p></body></html>");
        state.error("For root '" + state.rootName + "' no authenticator was configured.");
        return;
    }

    var authHelpers = authenticators.helpers[authenticatorConfig.provider];
    if (authHelpers)
        authHelpers.redirect(state);
    else {
        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        res.end("<html><body><p>There was a problem redirecting you to the authenticator.</p></body></html>");
        state.error("Sign On", state.errorLevels.errorSystemAffected, "An unknown authentication provider named '" + authenticatorConfig.authenticatorName + "' was specified for the application root '" + state.rootName + "'");
    }
}

function request2(state){

    var res = state.response;

    try{
        state.resourceAnonymous = (state.root.authenticators.length == 0) || resourceAnonymous(state);

        if(state.user || state.resourceAnonymous){
            // We do have a session so proceed normally
            switch(state.request.method){
                //case "OPTIONS": //9.2 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                case "GET":     //9.3 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    get(state);
                    break;

                //case "HEAD":    //9.4 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                case "POST":    //9.5 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    post(state);
                    break;

                //case "PUT":     //9.6 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                //case "DELETE":  //9.7 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                //case "TRACE":   //9.8 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                //case "CONNECT": //9.9 of www.w3.org/Protocols/rfc2616/rfc2616-sec9.html
                    //TODO: 3. Complete
                    //break;

                default:
                    state.error('request2',ex.message);
                    res.writeHead(501, {'Content-Type': 'text/html;charset=utf-8'});
                    res.write("<html><body>");
                    res.write("<p>HTTP method not implemented</p>");
                    res.end("</body></html>");
                    break;
            }
        }else{
            redirectToAuthenticator(state);
        }
    } catch (ex){
        state.error('request2',ex.message);
        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        res.write("<html><body>");
        res.write("<p>request2 failed: " + ex.message + "</p>");
        res.end("</body></html>");
    }
}

/**
 *
 * @param {State} state
 * @param {String} getType
 * @param {Number} extLength
 * @param {String} [pathName]
 * @returns {{processingRequired: boolean, fileCallsPossible: boolean, instrumentFile: boolean, headOnly: boolean, bodyOnly: boolean, filename: string}}
 */
function fileAnalyze(state, getType, extLength, pathName){

    var req = state.request;

    // a = Attributes
    var a = {
        processingRequired: false,
        fileCallsPossible: false,
        instrumentFile: false,
        headOnly: false,
        bodyOnly: false,
        filename: "." + (pathName || state.pathName)
    };

    if(getType.isHtml){
        //TODO: 4. Look to optimize this
        if(a.filename.indexOf('.body.htm') >= 0){
            a.filename = a.filename.replace(".body.htm",'.htm');
            a.bodyOnly = true;
            a.processingRequired = true;
        } else if(a.filename.indexOf('.head.htm') >= 0) {
            a.filename = a.filename.replace(".head.htm",'.htm');
            a.headOnly = true;
            a.processingRequired = true;
        }
        //TODO: 4. look to optimize this
        if(config.activeDeployment.supports.multipleVersions){
            a.filename = a.filename.substr(0,a.filename.length-extLength)
                + "-" + (state.user.version || config.version) + a.filename.substr(a.filename.length-extLength);
        }
    }

    if(getType.callSpec && a.filename.indexOf(getType.callSpec.extensionExtender) >= 0){
        if(state.root.supports.dynamicGets){
            a.processingRequired = true;
            a.fileCallsPossible = true;
        } else {
            state.error(state.errorLevels.errorUserAffected,"An attempt was made to call dynamic get functionality which is not allowed by the current configuration. Dynamic content was not served. The requesting url was '" + req.url + "'." );
        }
    }

    if(cycligentAgentInstrumentMap[req.url]){
        a.processingRequired = true;
        a.instrumentFile = true;
    }

    return a;
}
exports.fileAnalyze = fileAnalyze;

function fileProcess(state, getType, attributes){

    var req = state.request;

    fs.readFile(attributes.filename, 'utf8', function (err, data) {
        if(err){
            fileNotFound(state);
        }else{
            if(attributes.bodyOnly){
                try{
                    data = data.split(/(<body[^>]*>|<\/body>)/)[2];
                }catch(ex){
                    state.error(".body.htm exception: " + ex.message);
                }
            } else if(attributes.headOnly){
                try{
                    data = data.split(/(<head[^>]*>|<\/head>)/)[2];
                }catch(ex){
                    state.error(".head.htm exception: " + ex.message);
                }
            } else if(attributes.instrumentFile){
                try{
                    data = instrumenter.instrumentSync(data, '.' + req.url);
                }catch(ex){
                    state.error("Code instrumentation exception: " + ex.message);
                }
            }

            if(attributes.fileCallsPossible){
                fileCallsProcess(state,getType,data);
            } else {
                fileServe(state,getType,data);
            }
        }
    });
}

function get(state){

    var req = state.request;
    var res = state.response;

    try{

        var ext = path.extname(state.pathName);
        var getType = state.root.getStaticTypes[ext];
        var pathName = state.pathName;

        if(getType){
            // Is static type - read the file and send it out
            if(req.url.indexOf("..") < 0 ){

                if (config.isCyvisor || (!config.isCyvisor && req.url.indexOf("/control/client/") < 0)) {

                    if( state.resourceAnonymous || authorize.isAuthorized(state.user,"paths",state.pathName)){

                        //TODO: 2. Check for proxy here!

                        var attributes = fileAnalyze(state, getType, ext.length);

                        if(attributes.processingRequired){
                            fileProcess(state, getType, attributes);
                        } else {
                            // Serve raw file
                            fs.readFile(attributes.filename, function (err, data) {
                                if (err) {
                                    // TODO: 2. I'm not sure that this is the best solution, we should probably do something different.
                                    // Might be trying to load an unprocessed html file.
                                    if (getType.isHtml && config.activeDeployment.supports.multipleVersions) {
                                        attributes.filename = attributes.filename.replace("-" + (state.user.version || config.version), "");
                                        fs.readFile(attributes.filename, function(err, data) {
                                            if (err) {
                                                fileNotFound(state);
                                            } else {
                                                fileServe(state,getType,data);
                                            }
                                        });
                                    } else {
                                        fileNotFound(state);
                                    }
                                } else {
                                    fileServe(state,getType,data);
                                }
                            });
                        }
                    } else {
                        res.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                        res.write("<html><body>");
                        res.write("<p>You aren't authorized to access this page.</p>");
                        res.end("</body></html>");
                    }
                } else {
                    fileNotFound(state);
                }
            } else {
                res.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                res.write("<html><body>");
                res.write("<p>You aren't authorized to access this page.</p>");
                res.end("</body></html>");
                state.error('A request was made to a backward tracking URL which is not allowed.');
            }
        }else{
            if(getDynamicTypes[pathName]){
                getDynamicTypes[pathName](state);
            } else {
                // Check for a default document here
                if(pathName == '/' + state.rootName && state.root.defaultDoc){
                    redirect(res,state.root.defaultDoc);
                } else {
                    // Is unknown type
                    res.writeHead(415, {'Content-Type': 'text/html;charset=utf-8'});
                    res.write("<html><body>");
                    res.write("<p>Unknown content type requested.</p>");
                    res.end("</body></html>");
                }
            }
        }
    } catch (ex) {
        state.error('get',ex.message);
        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        res.write("<html><body>");
        res.write("<p>get failed: " + ex.message + "</p>");
        res.end("</body></html>");
    }
}

function fileNotFound(state){
    state.response.writeHead(404);  // File was not found!
    state.response.end();
}

function fileCallsProcess(state,getType,data,callback){

    callback = callback || fileServe;

    try{
        state.fileCallProcess = {
            getType: getType,
            returnText: "",
            index: 0,
            splits: data.split(getType.callSpec.parser),
            callback: callback
        };
        fileCallsProcess2(state,"");
    } catch (ex) {
        state.error('fileCallsProcess', 'callSpec.parser or split error: ', ex.message);
        callback(state,getType,data);
    }
}
exports.fileCallsProcess = fileCallsProcess;

function fileCallsProcess2(state,replacement){
    var callback = state.fileCallProcess.callback || fileServe;

    var fcp = state.fileCallProcess;

    try{
        fcp.returnText += replacement + fcp.splits[fcp.index++];

        if( fcp.index < fcp.splits.length ){

            var method = fcp.splits[fcp.index++];
            var parameters = fcp.splits[fcp.index++];

            if(parameters != ""){
                parameters = JSON.parse(parameters);
            }

            if(config.router){
                state.subChannel = 'cycligentFileCall:' + method;
                if((!state.user || state.user.onMain) && messageBus.subChannelMatches(config.processes.inInstance,state.subChannel)){
                    // Handle the request in this instance
                    call.textFileProcess(state,method,parameters,fileCallsProcess2);
                } else {
                    if(messageBus.subChannelMatches(config.processes.longWorker,state.subChannel)){
                        textFileProcessViaWorker('Long Worker', 'Long Worker Reply', state,method,parameters);
                    } else {
                        textFileProcessViaWorker('Worker', config.name, state,method,parameters);
                    }
                }
            }else{
                call.textFileProcess(state,method,parameters,fileCallsProcess2);
            }
        } else {
            //TODO: 2. Needs to be checked to confirm works with worker!
            if(fcp.index < 2) {
                callback(state, fcp.getType, fcp.returnText);
            } else {
                fcp.index = 0;
                fcp.splits = fcp.returnText.split(fcp.getType.callSpec.parser);
                fcp.returnText = '';
                fileCallsProcess2(state,"");
            }
        }
    } catch (ex){
        state.error('fileCallsProcess2',ex.message);
        callback(state,fcp.getType,fcp.returnText);
    }
}

function textFileProcessViaWorker(type,channel,state,method,parameters){
    state.fileCallProcess.method = method;
    state.fileCallProcess.parameters = parameters;

    var correlation = messageBus.send(type, state.subChannel, (state.user.versionExtended || config.versionExtended), true, {
        start: state.start,
        request: state.request,
        parsedUrl: state.parsedUrl,
        pathName: state.pathName,
        testUser: state.testUser,
        user: state.user,
        authorization: state.authorization,
        post: JSON.stringify(state.post),
        fileCallProcess: state.fileCallProcess
    });

    messageBus.receive(channel, correlation, config.versionExtended, function(err,timeout,message){
        if(err){
            state.error(state.errorLevels.errorUserAffected,err.message);
            fileCallsProcess2(state,err.message);
        } else {
            if(timeout){
                state.error(state.errorLevels.errorUserAffected,"Timeout occurred on reply channel '" + config.name + "', version " + config.version + " while waiting for worker communicated to via channel '" + type + "'.");
                fileCallsProcess2(state,"Timeout occurred on reply channel '" + config.name + "', version " + config.version + " while waiting for worker communicated to via channel '" + type + "'.");
            } else {
                fileCallsProcess2(state,message.body);
            }
        }
    });
}

function fileServe(state,getType,data,statusCode) {
    if (statusCode === undefined) {
        statusCode = 200;
    }
    // Construct Header (handle caching appropriately)

    var header = {};

    if(getType.isHtml){
        if(config.activeDeployment.xFrameOptions) {
            if(config.activeDeployment.xFrameOptions == "ALLOW"){

                if (config.activeDeployment.xFrameOptionsTest
                    && !config.activeDeployment.xFrameOptionsTest(state)) {
                    header['X-Frame-Options'] = 'SAMEORIGIN';
                }
            } else {
                header['X-Frame-Options'] = config.activeDeployment.xFrameOptions;
            }
        } else {
            header['X-Frame-Options'] = 'SAMEORIGIN';
        }
    }

    var contentType = getType.type;
    if (contentType.substr(0, 4) == "text" || contentType == "application/javascript")
        contentType += ";charset=utf-8";
    header['Content-Type'] = contentType;

    // Only cache if the type is to be cached and the filename contains a version pattern.
    // In this way items will not be cached during development, but items that have been
    // run through CycligentBuilder will be fully cached for 11 months.  See the Cycligent
    // Builder or Cycligent Framework Startup documents for more information.

    var cache = getType.cache && cacheRegex.test(path.basename(state.pathName));
    if(cache){
        header["Cache-Control"] = "max-age=28857600";
        header["Expires"] = (new Date((new Date()).getTime() + 28857600000)).toUTCString();
    } else {
        header["Cache-Control"] = "no-cache, max-age=0";
        header["Expires"] = (new Date((new Date()).getTime() - 60000)).toUTCString();
    }

    state.response.writeHead(statusCode, header);
    state.response.end(data);
}
exports.fileServe = fileServe;

/**
 *
 * @param {State} state
 */
function post(state){

    var res = state.response;
    var postType = postTypes[state.pathName];

    if(postType){

        try{
            // When preProcess is true the data posted from the client is treated as JSON and converted to a JavaScript
            // object prior to calling the handler.  The Handler can then access the object directly at state.post.
            // When false, the handler is just called directly and can access the client post via state.requestData.
            if(!postType.preProcess){
                postType.handler(state);
                return;
            }

            try {
                state.post = JSON.parse(state.requestData);
            } catch (e) {
                // Try again, this time assuming that requestData came from a form.
                // Currently only cycligentDownload does this.
                // Do the initial parse.
                state.post = querystring.parse(state.requestData);
                // Parse the keys, since they will also be JSON values.
                for (var index in state.post) {
                    state.post[index] = JSON.parse(state.post[index]);
                }
            }

            if (postType.CSRFProtection) {
                if (state.post.authorization != state.authorization) {
                    state.response.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                    state.response.write("<html><body>");
                    state.response.write("<p>The client provided incorrect authorization.</p>");
                    state.response.end("</body></html>");
                    return;
                }
            }

            if(state.root.supports.sideBySideRoles){
                if(state.post.role){
                    //TODO: 3. ***SIDE-BY-SIDE***  Need to make sure this works. May need to be if(state.user.role._id == state.post.role._id){
                    if(state.user.role == state.post.role){
                        postType.handler(state);
                    } else {
                        state.user.role = state.user.roleGetById(state.mongodb.ObjectID(state.post.role));
                        if(state.user.role){
                            state.user.version = config.versions[(state.user.versionType || config.versionType)];
                            postType.handler(state);
                        } else {
                            res.writeHead(400, {'Content-Type': 'text/html;charset=utf-8'});
                            res.write("<html><body>");
                            res.write("<p>Authorization failed: Unrecognized role id.</p>");
                            res.end("</body></html>");
                        }
                    }
                } else {
                    res.writeHead(400, {'Content-Type': 'text/html;charset=utf-8'});
                    res.write("<html><body>");
                    res.write("<p>Authorization failed: No role was provided with the request.</p>");
                    res.end("</body></html>");
                }
            } else {
                postType.handler(state);
            }
        }catch(ex){
            res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
            res.write("<html><body>");
            res.write("<p>" + ex.message + "</p>");
            res.end("</body></html>");
        }
    }else{
        res.writeHead(400, {'Content-Type': 'text/plain;charset=utf-8'});
        res.end("The Cycligent Server does not understand a post to '" + state.pathName + "'");
    }
}

/**
 * Dispatch to the correct sign-on handling function.
 *
 * @param {State} state
 * @param {Object} authenticatorConfig
 */
function signOn(state, authenticatorConfig){
    state.authenticatorConfig = authenticatorConfig;
    var res = state.response;
    var authHelpers = authenticators.helpers[authenticatorConfig.provider];

    if (authHelpers)
        authHelpers.signOn(state);
    else {
        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        res.end("<html><body><p>There was a problem contacting the authenticator.</p></body></html>");
        state.error("Sign On", state.errorLevels.errorSystemAffected, "An unknown authentication provider was specified for the application root '" + state.rootName + "'");
    }
}

function testSignOn(state){
    var testUser_id = state.parsedUrl.search.substr(1);
    userCookieCreateAndSend(state, testUser_id, 'testUser', '_CYC_TEST_', state.root.defaultDoc);
}

/**
 * Creates a new cookie based off of the one we currently have, but with a new role.
 *
 * @param {State} state
 * @param {ObjectID} userRole
 * @returns {String} Will return an empty string if for some reason we couldn't create the new cookie. (i.e. the user isn't actually logged in)
 */
function userCookieChangeRole(state, userRole) {
    var cookie = querystring.parse(state.request.headers.cookie,'; ');
    var idHeader = null;
    var userID = null;

    if(cookie.user_role){
        var splits = cookie.user_role.split('..');
        var cookieUser = splits[0];

        var checkID = sessionDecode(cookieUser);
        idHeader = checkID.substr(0, 10);

        if(idHeader === '_CYC_AUTH_'){
            userID = checkID.substr(10);
        } else if(idHeader === '_CYC_TEST_'){
            userID = checkID.substr(10);
        } else {
            // User isn't logged in...
            return "";
        }
    }

    if (idHeader && userID) {
        var cookiePath;
        if (state.root.cookiePath) {
            cookiePath = state.root.cookiePath;
        } else {
            cookiePath = '/' + state.rootName;
        }
        return userCookieCreate(userID, userRole, idHeader, state.authorization, cookiePath, state.request.https);
    } else {
        return "";
    }
}
exports.userCookieChangeRole = userCookieChangeRole;

/**
 * Creates the cookie string placed in the Set-Cookie portion of the HTTP response.
 *
 * @param {String} userID The _id of the user. Ususally their email address as a string.
 * @param {ObjectID} userRole The ObjectID of the user's role.
 * @param {String} idHeader The header in the cookie, _CYC_TEST_ or _CYC_AUTH_.
 * @param {String} authorizationToken The token used to identify the session and to prevent things like CSRF.
 * @param {String} path The Path of the cookie, you'll probably want to make this the application root, i.e. '/c3'.
 * @param {Boolean} secure Whether or not to mark the cookie as 'Secure', so it's only transmitted over HTTPS.
 */
function userCookieCreate(userID, userRole, idHeader, authorizationToken, path, secure) {
    var role = userRole.id;
    var result = 'user_role=' +
        sessionEncode(idHeader + userID) +
        '..' + sessionEncode(role) +
        '..' + sessionEncode(authorizationToken) + '; ' +
        'Path=' + path + "; " +
        'HttpOnly';
    if (secure) {
        result += '; Secure';
    }
    return result;
}
exports.userCookieCreate = userCookieCreate;

/**
 * Gets the users collection based off of the sessionDb for the current root.
 *
 * @param {State} state
 * @param {String} userType
 * @param {Function} callback
 */
function usersCollectionGet(state, userType, callback) {
    var sessionDb;

    try {
        for(var db in state.root.dbs){
            if(state.root.dbs[db].sessionDb){
                sessionDb = config.dbs[state.root.dbs[db][userType]].db;
            }
        }
    } catch(e) {
        callback(e);
        return;
    }

    if(sessionDb){
        sessionDb.collection('users',function(err, collection) {
            if (err) {
                console.error('db.collection(users) failed: ' + err.message);
                callback(err);
            } else {
                callback(null, collection);
            }
        });
    } else {
        state.error('Sign On', state.errorLevels.errorUserAffected, "Unable to determine sessionDb for sign-on of root: " + state.rootName);
        callback(new Error("Unable to determine session DB."));
    }
}

/**
 * Creates a token and saves it on the user document.
 *
 * @param {State} state
 * @param {String} user_id
 * @param {String} userType The type of the user. Used for database access (e.g. testUser or authenticatedUser)
 * @param {Function} callback
 */
function userAuthorizationTokenCreateAndSave(state, user_id, userType, callback) {
    usersCollectionGet(state, userType, function(err, collection) {
        if (err) {
            callback(err);
            return;
        }

        userAuthorizationTokenCreateAndSave2(state, user_id, collection, callback);
    });
}
exports.userAuthorizationTokenCreateAndSave = userAuthorizationTokenCreateAndSave;

/**
 * Creates a token and saves it on the user document.
 *
 * Use this method if you already have the users collection available,
 * otherwise userAuthorizationTokenCreateAndSave will be able to go
 * get that for you.
 *
 * @param {State} state
 * @param {String} user_id
 * @param {Collection} collection
 * @param {Function} callback
 */
function userAuthorizationTokenCreateAndSave2(state, user_id, collection, callback) {
    var authorizationToken = crypto.randomBytes(20).toString('hex');
    var expires = new Date();
    expires.setTime(expires.getTime() + state.root.sessionExpirationTime);
    var update = {$set: {}};
    update.$set['authorizationTokens.' + authorizationToken] = {
        expires: expires
    };
    collection.updateOne({_id: user_id, active: true}, update, function(err) {
        if (err) {
            console.error('users.update() failed: ' + err.message);
            callback(err);
        } else {
            callback(null, authorizationToken);
        }
    });
}

/**
 * Checks the given user document to see if any authorization tokens can be
 * removed from the database, and if it finds any, it removes them.
 *
 * @param {Object} user
 * @param {Collection} collection
 */
function userCleanAuthorizationTokens(user, collection) {
    if (!user.authorizationTokens) {
        return;
    }

    var update = {$unset: {}};
    var removingAny = false;
    var now = new Date();
    for (var token in user.authorizationTokens) {
        if (user.authorizationTokens.hasOwnProperty(token)) {
            var info = user.authorizationTokens[token];
            if (info.expires < now) {
                removingAny = true;
                update.$unset['authorizationTokens.' + token] = 1;
            }
        }
    }

    if (removingAny) {
        collection.updateOne({_id: user._id}, update, function(err) {
            if (err) {
                console.error('users.update() failed while removing authorization tokens: ' + err.message);
            }
        });
    }
}

/**
 * Removes an authorization token that's associated with a user.
 *
 * @param {State} state
 * @param {String} user_id
 * @param {String} userType The type of the user. Used for database access (e.g. testUser or authenticatedUser)
 * @param {String} authorizationToken
 */
function userRemoveAuthorizationToken(state, user_id, userType, authorizationToken) {
    usersCollectionGet(state, userType, function(err, collection) {
        if (err) {
            return;
        }

        var update = {$unset: {}};
        update.$unset['authorizationTokens.' + authorizationToken] = 1;

        collection.updateOne({_id: user_id}, update, function(err) {
            if (err) {
                console.error('users.update() failed while removing authorization tokens: ' + err.message);
            }
        });
    });
}

/**
 * Given a state from a web request, and the email of a user, create and send a cookie
 * so they can can be logged into the system.
 *
 * Please make sure they are authenticated somehow, this function will not do that
 * for you (see signOn and testSignOn, they do that.)
 *
 * This function will make sure that the user is in the database, and will display
 * various error messages if it turns out that they aren't, that there is no user
 * collection, etc.
 *
 * @param {State} state State from a web request.
 * @param {String} email Email address of the user.
 * @param {String} userType What type of user this is, authenticatedUser or testUser?
 * @param {String} idHeader The header in the cookie, _CYC_TEST_ or _CYC_AUTH_.
 * @param {String} redirectTo The URL to redirect the user to, now that they have the cookie.
 */
function userCookieCreateAndSend(state, email, userType, idHeader, redirectTo) {
    email = email.toLowerCase();
    var req = state.request;
    var res = state.response;

    usersCollectionGet(state, userType, function(err, collection) {
        if (err) {
            res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
            res.write("<html><body>");
            res.write("<p>Session error: " + err.message + "</p>");
            res.end("</body></html>");
            return;
        }

        collection.find({_id: email, active: true}).toArray(function(err,results){
            if(err){
                console.error('db.user.find failed: ' + err.message);
                res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
                res.write("<html><body>");
                res.write("<p>db.user.find failed: " + err.message + "</p>");
                res.end("</body></html>");
            } else {
                if(results.length == 0){
                    // User credentials authenticated but unknown to our system!
                    // Should take user to a sign-up page here!
                    res.writeHead(403, {'Content-Type': 'text/html;charset=utf-8'});
                    res.write("<html><body>");
                    res.write("<p>We were able to authenticate you but you are not registered on this system.  Please contact your system administrator or sign-up at [link to be provided later].</p>");
                    res.end("</body></html>");
                } else {
                    if(results.length == 1){
                        userAuthorizationTokenCreateAndSave2(state, email, collection, function (err, authorizationToken) {
                            if (err) {
                                res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
                                res.write("<html><body>");
                                res.write("<p>db.user.update failed: " + err.message + "</p>");
                                res.end("</body></html>");
                                return;
                            }

                            var cookiePath;
                            if (state.root.cookiePath) {
                                cookiePath = state.root.cookiePath;
                            } else {
                                cookiePath = '/' + state.rootName;
                            }

                            var cookie = userCookieCreate(email, results[0].roleCurrent, idHeader, authorizationToken,
                                cookiePath, state.request.https);
                            res.writeHead(302, {
                                'Content-Type': 'text/html;charset=utf-8',
                                Location: redirectTo,
                                'Set-Cookie': cookie
                            });
                            res.write("<html><body>");
                            res.write("<p>If you are not redirected shortly please click: <a href='" +
                            req.url + config.defaultDoc + "'>" + req.url + config.defaultDoc + "</a>.</p>");
                            res.end("</body></html>");
                        });
                    } else {
                        console.error('Duplicate user records found for: ' + email + '.');
                        res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
                        res.write("<html><body>");
                        res.write("<p>Duplicate user records found for: " + email + ".</p>");
                        res.end("</body></html>");
                    }
                }
            }
        });
    });
}
exports.userCookieCreateAndSend = userCookieCreateAndSend;

function signOff(state){
    var res = state.response;
    var location;
    if (state.testUser)
        location = state.root.defaultDoc;
    else {
        var auth = state.authenticatorConfig;
        if (auth && auth.off)
            location = auth.off;
        else
            location = state.root.defaultDoc;
    }

    var cookiePath;
    if (state.root.cookiePath) {
        cookiePath = state.root.cookiePath;
    } else {
        cookiePath = '/' + state.rootName;
    }

    res.writeHead(302, {
        'Content-Type': 'text/html;charset=utf-8',
        'Location': location,
        //TODO: 3. Put back in secure when HTTPS working again
        'Set-Cookie': 'user_role=' + sessionEncode('_CYC__OFF_') + '; ' +
            'Path=' + cookiePath + '; ' +
            'HttpOnly' // + ((req.headers.host.match(/[^:]+/)[0] == 'localhost' || req.headers.host.match(/[^:]+/)[0] == '127.0.0.1') ? '' : '; Secure')
    });
    res.end();

    if (state.authorization && state.user && state.user.type) {
        var userType = state.user.type;
        if (userType != 'conduitController') {
            userType += 'User';
        }
        userRemoveAuthorizationToken(state, state.user._id, userType, state.authorization);
    }
}

function provider(state){
    if (state.post.authorization != state.authorization && !(state.post.target == "cycligentCache" && state.post.criteria.store == "cycligent.startup.set")) {
        state.response.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
        state.response.write("<html><body>");
        state.response.write("<p>The client provided incorrect authorization.</p>");
        state.response.end("</body></html>");
        return;
    }

    if(config.router){
        state.subChannel = subChannelDetermine(state.post);
        if(state.subChannel == 'cycligentRetrieveLongWorker'){
            longWorkerRetrieve(state);
        } else {
            if((!state.user || state.user.onMain) && messageBus.subChannelMatches(config.processes.inInstance,state.subChannel)){
                // Handle the request in this instance
                provider2(state);
            } else {
                if(messageBus.subChannelMatches(config.processes.longWorker,state.subChannel)){
                    provideViaLongWorker(state);
                } else {
                    provideViaWorker(state);
                }
            }
        }
    } else {
        // Handle the request in this instance
        provider2(state);
    }
}

function provider2(state){

    state.targets = [];

    switch(state.post.target){

        case "cycligentCache":
            cache.request(state,provider3);
            break;

        case "cycligentCall":
            call.process(state,provider3);
            break;

        case "cycligentMenu":
            menu.request(state,provider3);
            break;

        case "cycligentQuery":
            query.process(state, provider3);
            break;

        case "cycligentDownload":
            download.process(state, provider3);
            break;

        //TODO: 2. Need to add an error message here for unrecognized type!
    }
}

// TODO: 5. Figure out why chrome gives the "Resource interpreted as Document but transferred with MIME type..."
// I've tried everything I think of, and I'm just going to chalk it up to a bug in Chrome. So, if you ever
// see that error, don't worry about it. Your download will still complete successfully.
function downloadProvider(state) {
    var downloadInfo = state.targets[0];
    cycligentTiming(state);
    cycligentTrace(state);
    if (downloadInfo.status == 'unknown') {
        state.response.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        state.response.write("<html><body>");
        state.response.write("<p>cycligentDownload: download handler failed to set status.</p>");
        state.response.end("</body></html>");
    } else if (downloadInfo.status == 'error') {
        state.response.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        state.response.write("<html><body>");
        state.response.write("<p>cycligentDownload (error): " + downloadInfo.error + "</p>");
        state.response.end("</body></html>");
    } else if (downloadInfo.status == "unauthorized") {
        state.response.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
        state.response.write("<html><body>");
        state.response.write("<p>cycligentDownload: You are not authorized to download that.</p>");
        state.response.end("</body></html>");
    } else if (downloadInfo.status == "success") {
        if (downloadInfo.contentLength == undefined)
            downloadInfo.contentLength = downloadInfo.data.length;
        state.response.writeHead(200, {
            'Content-Type': downloadInfo.contentType,
            'Content-Disposition': 'attachment; filename="' + downloadInfo.filename + '"',
            'Content-Length': downloadInfo.contentLength,
            'Connection': 'close'
        });
        state.response.end(downloadInfo.data, downloadInfo.encoding);
    } else {
        state.response.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
        state.response.write("<html><body>");
        state.response.write("<p>cycligentDownload: download handler returned unrecognized status.</p>");
        state.response.end("</body></html>");
    }
}

function provider3(state){
    cycligentTiming(state);
    cycligentTrace(state);

    var roleType = config.roleType;
    // TODO: 6. The following check feels very hacky, ideally we should refactor the code so that request goes out the same way it came in (over HTTP, over message bus, etc.), instead of checking the roleType.
    if (config.isCyvisor && state.createdFrom === "http") {
        roleType = "web";
    }

    switch(roleType){
        case 'web':
            if (state.targets[0].target == 'cycligentDownload') {
                downloadProvider(state);
            } else {
                var header = { 'Content-Type': 'application/json;charset=utf-8' };
                if (config.activeDeployment.accessControl
                    && config.activeDeployment.accessControl[state.request.headers.origin]) {
                    var accessControl = config.activeDeployment.accessControl[state.request.headers.origin];
                    header['Access-Control-Allow-Origin'] = state.request.headers.origin;
                    header['Access-Control-Allow-Methods'] = accessControl.allowMethods;
                    header['Access-Control-Allow-Headers'] = accessControl.allowHeaders;
                    header['Access-Control-Allow-Credentials'] = accessControl.allowMethods;
                    header['Access-Control-Max-Age'] = accessControl.maxAge;
                }
                state.response.writeHead(200, header);
                state.response.end(JSON.stringify(state.targets));
            }
            break;

        case 'worker':
            agent.responseTimeAddMeasurement(Date.now() - state.start);
            messageBus.send(
                state.returnTo.channel,
                state.returnTo.subChannel,
                state.returnTo.version,
                false,
                JSON.stringify(state.targets)
            );
            break;

        case 'longWorker':
            agent.responseTimeAddMeasurement(Date.now() - state.start);
            messageBus.send(
                'Long Worker Reply',
                state.returnTo.subChannel,
                state.returnTo.version,
                false,
                JSON.stringify(state.targets)
            );
            break;

        default:
            var errMessage = "Server '" + config.name + "' has unknown roleType '" + config.roleType + "'.";
            state.error(state.errorLevels.errorSystemAffected, errMessage);
            var res = state.response;
            res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
            res.write("<html><body>");
            res.write("<p>" + errMessage + "</p>");
            res.end("</body></html>");
            break;

        //TODO: 4. Log error "Unknown roleType '" + config.roleType + "' detected in provider3." (should not be possible due to configuration validations)
    }
}

function workerSend(type,state){
    return messageBus.send(type, state.subChannel, (state.user.versionExtended || config.versionExtended), true, {
        start: state.start,
        request: state.request,
        parsedUrl: state.parsedUrl,
        pathName: state.pathName,
        testUser: state.testUser,
        user: state.user,
        authorization: state.authorization,
        post: JSON.stringify(state.post)
    });
}

function provideViaWorker(state){

    var correlation = workerSend("Worker",state);

    messageBus.receive(config.name, correlation, config.versionExtended, function(err,timeout,message){
        if(err){
            state.error(state.errorLevels.errorUserAffected,err.message);
        } else {
            if(timeout){
                state.error(state.errorLevels.errorUserAffected,"Timeout occurred on reply channel '" + config.name + "', version " + config.version + " while waiting for worker communicated to via channel 'Worker'.");
            } else {
                state.timingAdd("messageReceiveFromWorker", (new Date()).getTime() - message.sent.getTime());
                state.targets = JSON.parse(message.body);
            }
        }
        provider3(state);
    });
}

function provideViaLongWorker(state){
    var correlation = workerSend("Long Worker",state);

    // Technique 1 - Immediately acknowledges receipt and then waits for a retrieval request to look for long worker replies
    //state.response.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
    //state.response.end(JSON.stringify([{target:'cycligentLongWait',retrieve:{channel: 'Long Worker Reply', subChannel: correlation, version: (state.user.version || config.version)}}]));

    // Technique 2 - Wait for worker to respond first, if does not respond in the time out period inform the client of a long wait,
    messageBus.receive('Long Worker Reply', correlation, config.versionExtended, function(err,timeout,message){
        if(err){
            state.error(state.errorLevels.errorUserAffected,err.message);
            provider3(state);
        } else {
            if(timeout){
                if (/^cycligentDownload:/.test(state.subChannel)) {
                    state.post = {channel: "Long Worker Reply", subChannel: correlation};
                    longWorkerRetrieve(state);
                } else {
                    state.response.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
                    state.response.end(JSON.stringify([{target:'cycligentLongWait',retrieve:{channel: 'Long Worker Reply', subChannel: correlation, version: (state.user.version || config.version)}}]));
                }
            } else {
                state.timingAdd("messageReceiveFromWorker", (new Date()).getTime() - message.sent.getTime());
                state.targets = JSON.parse(message.body);
                provider3(state);
            }
        }
    });
}

function longWorkerRetrieve(state){

    messageBus.receive(state.post.channel, state.post.subChannel, config.versionExtended, function(err,timeout,message){
        if(err){
            state.error(state.errorLevels.errorUserAffected,err.message);
            state.response.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
            state.response.write("<html><body>");
            state.response.write("<p>" + err.message + "</p>");
            state.response.end("</body></html>");
        } else {
            if(timeout){
                if (/^cycligentDownload:/.test(state.subChannel)) {
                    longWorkerRetrieve(state);
                } else {
                    state.response.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
                    state.response.end(JSON.stringify([{target:'cycligentLongWait',retrieve:{channel: state.post.channel, subChannel: state.post.subChannel, version: (state.user.version || config.version)}}]));
                }
            } else {
                state.timingAdd("messageReceiveFromWorker", (new Date()).getTime() - message.sent.getTime());
                state.targets = JSON.parse(message.body);
                provider3(state);
            }
        }
    });

}

function subChannelDetermine(post){

    var subChannel = post.target;

    switch(subChannel){

        case "cycligentCache":
            subChannel += ":" + post.criteria.store;
            break;

        case "cycligentCall":
            subChannel += ":" + post.call.name;
            break;

        case "cycligentMenu":
            // Do nothing
            break;

        case "cycligentQuery":
            subChannel += ":" + post.criteria.database + "." + post.criteria.collection;
            break;

        case "cycligentRetrieveLongWorker":
            // Do nothing
            break;

        case "cycligentDownload":
            subChannel += ":" + post.name;
            break;

        //TODO: 2. Need to add an error message here for unrecognized type!
    }

    return subChannel;
}

function cycligentTiming(state){

    if(state.timerName != ""){
        state.error(state.errorLevels.warning,'The performance timer "' + state.timerName + '" was left pending at the close of the request and was stopped.');
        state.timerStop(state.timerName);
    }

    // If cycligentTiming was called previously (for example, in a worker), combine with timings from this server.
    var otherTimings = state.findAndRemoveTimings();
    state.timings.push.apply(state.timings, otherTimings);

    var total = (new Date()).getTime() - state.start;
    var db = 0;

    for(var i in state.timings){
        db += state.timings[i][1];
    }

    var process = total - db;

    state.target = {target:"cycligentTiming",request:state.post.request,totalTime:total,databaseTime:db,processTime:process};
    state.targets.push(state.target);
    state.target.json = state.timings;
}
exports.cycligentTiming = cycligentTiming;

function cycligentTrace(state){

    if( state.errors.length > 0){
        state.target = {target:"cycligentTrace",request:state.post.request};
        state.targets.push(state.target);
        state.target.json = state.errors;
    }
}
exports.cycligentTrace = cycligentTrace;

function redirect(res,defaultDoc){
    res.writeHead(302, {'Content-Type': 'text/html;charset=utf-8', Location: defaultDoc});
    res.write("<html><body>");
    res.write("<p>For quicker loading access the website directly at <a href='" + defaultDoc + "'>" + defaultDoc + "</a>. If you are not automatically redirected please click on the link.</p>");
    res.end("</body></html>");
}

// ---------------------- UTILITY FUNCTION ---------------------- //

function padTo(value,length){
    if(length == undefined){
        length = 25;
    }
    while(value.length < length){
        value = ' ' + value;
    }
    return value;
}

function pad(value){
    return "                " + value;
}

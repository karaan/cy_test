// TODO: 6. Proxying over the message bus.
// TODO: 6. Support for Cycligent authentication (and any other Cycligent features we could pass along.)
    // TODO: 6. Currently the authentication system is too tied to application roots and how requests are handled so that needs to be abstracted out somehow.
    // TODO: 6. Two modes of authentication:
        // TODO: 6. Dumb authentication: Basically Cycligent Server allows or denys access based on whether or not you're logged in and your "paths" authorization tells what paths you can access.
        // TODO: 6. Smart authentication: The app we're proxying to receives some kind of information about the authenticated user, which they can use internally to determine access.

var agent = require("./agent");
var child_process = require('child_process');
var querystring = require('querystring');
var http = require('http');
var https = require('https');
var url = require('url');

var cyvisor;
var cycligent;
var config;
process.nextTick(function() {
    cyvisor = require('./cyvisor.js');
    cycligent = require('./cycligent.js');
    config = require('./configProcess.js');
});

/**
  * @example
  * proxyTargetsByVersionTypeAndRole = {
  *     "flux": {
  *         "worker": {
  *             "i3d-dm0-wrk-vm0": [ 'http://[::1]:64830', 'http://127.0.0.1:64830' ]
  *         }
  *     }
  * }
 */
var proxyTargetsByVersionTypeAndRole = {};
var proxyTargetsByName = {};

/**
 * If enabled, this each worker/longWork in the local deployment
 * will look for a file named proxy-test-helper.js in the deploy
 * directory, and will try to proxy requests to it.'
 *
 * Note that in order to use this, you have to move the proxying
 * checking code above the cyvisor handling in cycligent.js,
 * otherwise the proxy processing will never happen. It seems silly
 * to me to add a check in there to handle things differently for
 * what will certainly be a an infrequent occasion.
 *
 * @type {boolean}
 */
var usingProxyTestHelper = false;
/**
 * The port we're proxying to for the proxy test helper. This
 * will be updated later.
 *
 * @type {string}
 */
var proxyTestHelperPort = "1337";

exports.proxyTargetsByVersionTypeAndRole = function() {
    return proxyTargetsByVersionTypeAndRole;
};

exports.proxyTargetsByName = function() {
    return proxyTargetsByName;
};

var processRoleProcessInfoChecks; // Initialized below.
function processRoleProcessInfo() {
    cyvisor.cycligentAgentFetchRoleProcessList(function(err, roleProcessList) {
        if (err) {
            console.error("Cycligent Proxy: Error occurred while trying to get role process list for proxy. Error message was: " + err.message);
        } else {
            proxyTargetsByName = {};
            for (var i = 0; i < roleProcessList.length; i++) {
                var roleProcess = roleProcessList[i];
                proxyTargetsByName[roleProcess._id] = roleProcess;
            }
        }

        cyvisor.cycligentProbeResults(function(err, results) {
            if (err) {
                console.error("Cycligent Proxy: Error occurred while trying to get role process probes for proxy. Error message was: " + err.message);
            } else {
                proxyTargetsByVersionTypeAndRole = {};
                for (var set_id in results) {
                    if (results.hasOwnProperty(set_id)) {
                        var resultsForSet = results[set_id];
                        for (var instanceName in resultsForSet) {
                            if (resultsForSet.hasOwnProperty(instanceName)) {
                                var probeResult = resultsForSet[instanceName];
                                if (probeResult.major == "Online" && probeResult.minor == "Healthy") {
                                    var roleProcess = proxyTargetsByName[instanceName];
                                    if (roleProcess && config.versions[roleProcess.versionType] == roleProcess.version) {
                                        if (!proxyTargetsByVersionTypeAndRole[roleProcess.versionType])
                                            proxyTargetsByVersionTypeAndRole[roleProcess.versionType] = {};
                                        if (!proxyTargetsByVersionTypeAndRole[roleProcess.versionType][roleProcess.roleType])
                                            proxyTargetsByVersionTypeAndRole[roleProcess.versionType][roleProcess.roleType] = [];
                                        proxyTargetsByVersionTypeAndRole[roleProcess.versionType][roleProcess.roleType].push(roleProcess.urls);
                                        // Sort such that IPv4 is first, because Cycligent may pick up IPv6 addresses,
                                        // but we don't currently listen on them, so requests to them will always fail.
                                        if (roleProcess.urls.length > 1)
                                            roleProcess.urls.sort(function(a, b) {
                                                var aIsIPv6 = a.indexOf("[") != -1;
                                                var bIsIPv6 = b.indexOf("[") != -1;
                                                if (aIsIPv6 == bIsIPv6) {
                                                    return 0;
                                                } else if (aIsIPv6 && !bIsIPv6) {
                                                    return 1;
                                                } else {
                                                    return -1;
                                                }
                                            });
                                    }
                                }
                            }
                        }
                    }
                }
            }

            processRoleProcessInfoChecks++;
            // TODO: 4. This interval should probably be configurable somewhere.
            // TODO: 4. This interval should probably at least be set to whatever the probing interval is.
            if (processRoleProcessInfoChecks < 30)
                setTimeout(processRoleProcessInfo, 1000); // Check more often because a deployment probably just happened.
            else
                setTimeout(processRoleProcessInfo, agent.probeIntervalGet());
        });
    });
}

/**
 * This will get called when the server is ready, and we can begin monitoring things for proxying.
 */
exports.proxyReady = function() {
    if (config.activeDeployment.proxyInUse) {
        if (config.roleProcess.roleType == "web") {
            processRoleProcessInfoChecks = 0;
            processRoleProcessInfo();
        }

        if (usingProxyTestHelper && config.deploymentName === "local") {
            spawnProxyTestChild();
        }
    }
};

/**
 * Creates a child process used for testing the proxying mechanism
 * locally. See {@link usingProxyTestHelper} for some more info.
 */
function spawnProxyTestChild() {
    // Proxy to the child so we can imitate what IIS does.
    var child = child_process.spawn(process.argv[0], ['proxy-test-helper.js'], {
        env: {
            "PORT": "0",
            "INFORMATION": process.argv[2]
        }
    });
    child.stdout.on('data', function(chunk) {
        chunk = chunk.toString();
        var matchData = chunk.match(/http:\/\/127.0.0.1:(\d+)\//);
        if (matchData == null) {
            console.error("proxy-test-helper.js returned an unexpected value!");
            process.exit(0);
        } else {
            proxyTestHelperPort = matchData[1];
            setTimeout(function() { // Call setTimeout so this message is at the bottom.
                console.error("Proxying to port " + proxyTestHelperPort + ".");
            }, 500);
        }
    });
    child.stderr.on('data', function(chunk) {
        process.stderr.write(chunk);
    });
    child.on('error', function() {
        console.error("Child process failed to spawn.");
    });
}

/**
 * Proxy a request somewhere.
 *
 * @param {String} httpOrHttps Whether to use HTTP or HTTPS.
 * @param {String} host The hostname/ip address of the server to proxy to.
 * @param {String} port The port of the server to proxy to.
 * @param {http.ClientRequest} request The nodejs object representing the request that came into the webserver.
 * @param {http.ServerResponse} response The nodejs object representing the response we'll send back to the client.
 * @param {Function} [tryNext] If you want to retry proxy requests, for example if you have multiple URLs a server might be at, this will be called when we receive an ECONNREFUSED error, so you can call proxyIt again with a different URL.
 * @param {Function} [gotResponse] This function gets called after the response from the server we're proxying gets piped back to the client, you can use it to do things like measure timings.
 * @param {Object} [extraHTTPOptions] Extra options or option overrides to pass to http[s].request()
  */
function proxyIt(httpOrHttps, host, port, request, response, tryNext, gotResponse, extraHTTPOptions) {
    if (httpOrHttps == "https")
        httpOrHttps = https;
    else
        httpOrHttps = http;
    var options = {
        host: host,
        port: port,
        method: request.method,
        path: request.url,
        headers: request.headers
    };
    if (extraHTTPOptions) {
        for (var prop in extraHTTPOptions) {
            if (extraHTTPOptions.hasOwnProperty(prop)) {
                options[prop] = extraHTTPOptions[prop];
            }
        }
    }

    var proxyReq = httpOrHttps.request(options, function(proxyRes) {
        response.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(response);
        if (gotResponse)
            gotResponse();
    });
    request.pipe(proxyReq);
    proxyReq.on('error', function(err) {
        if (tryNext && err.code == "ECONNREFUSED") {
            tryNext(err);
        } else {
            console.error("An error occurred while trying to proxy: " + err.message);
            response.writeHead(500, {'Content-Type': 'text/plain'});
            response.end("Cycligent Proxy: An error occurred while trying to proxy.");
        }
    });
}
exports.proxyIt = proxyIt;

/**
 * Given a request, this function will determine the versionType
 * the user making the request should be served.
 *
 * @param {http.ClientRequest} request
 */
function versionTypeDetermine(request) {
    var cookies = querystring.parse(request.headers.cookie,'; ');
    var versionType;
    if (cookies.versionType) {
        versionType = cookies.versionType;
    } else {
        versionType = config.versionTypeWithWebServerDynamicRequestsEnabled._id;
    }
    return versionType;
}
exports.versionTypeDetermine = versionTypeDetermine;

/**
 * Determine the roleType of the role process to proxy the request to,
 * using proxy.proxyPathnamesForLongWorkers to check if a
 * request has been designated as belonging to longWorkers.
 *
 * @param {Object} proxy
 * @param {Object} roleProcessesForVersionType
 * @param {String} pathname
 * @returns {String}
 */
function roleProcessRoleTypeDetermine(proxy, roleProcessesForVersionType, pathname) {
    var roleType;
    if (roleProcessesForVersionType && roleProcessesForVersionType["longWorker"]
        && proxy.proxyPathnamesForLongWorkers[pathname]) {
        roleType = "longWorker";
    } else {
        roleType = "worker";
    }

    return roleType;
}
exports.roleProcessRoleTypeDetermine = roleProcessRoleTypeDetermine;

/**
 * Given an array of role processes, choose one round-robin style
 * (by adding a roundRobin property to the array.)
 *
 * @param {Object[]} roleProcesses
 * @returns {Object}
 */
function roleProcessChooseRoundRobin(roleProcesses) {
    if (roleProcesses.roundRobin === undefined || roleProcesses.roundRobin > roleProcesses.length-1) {
        roleProcesses.roundRobin = 0;
    }
    var chosenRoleProcess = roleProcesses[roleProcesses.roundRobin];
    roleProcesses.roundRobin++;
    return chosenRoleProcess
}
exports.roleProcessChooseRoundRobin = roleProcessChooseRoundRobin;

/**
 * Make a proxy request, and monitor how long they take, marking
 * requests as needing to be handled by long workers as necessary.
 *
 * @param {Object} proxy
 * @param {Object} proxy.proxyPathnamesForLongWorkers A map of pathnames that long workers should handle.
 * @param {Object} proxy.longWorkerResponseTimeThreshold The response time threshold in milliseconds that determines
 * that a long worker should handle these requests.
 * @param {object} proxy.sampleSizeForLongWorkerRequests How many samples to take before deciding whether or not a
 * request should be handled by a long worker.
 * @param {Object} chosenRoleProcess
 * @param {http.ClientRequest} request
 * @param {http.ServerResponse} response
 * @param {String} pathname
 */
function makeProxyRequestWatchingForLongWork(proxy, chosenRoleProcess, request, response, pathname) {
    var urlIndex = 0;
    tryURL();

    function tryURL(err) {
        var urlChosen = chosenRoleProcess[urlIndex];
        if (err && !urlChosen) {
            console.error("Cycligent Proxy: An error occurred while trying to proxy: " + err.message);
            response.writeHead(500, {'Content-Type': 'text/plain'});
            response.end("Cycligent Proxy: An error occurred while trying to proxy. See server logs for more details.");
        } else {
            urlIndex++;
            var urlToHit = url.parse(urlChosen);
            var start = Date.now();
            proxyIt("http", urlToHit.hostname, urlToHit.port, request, response, tryURL, function() {
                if (proxy.proxyPathnamesForLongWorkers[pathname])
                    return;

                var end = Date.now();
                var diff = end - start;
                var stats = proxy.proxyResponseTimes[pathname];
                if (!stats) {
                    stats = [];
                    proxy.proxyResponseTimes[pathname] = stats;
                }
                stats.push(diff);
                if (stats.length > proxy.sampleSizeForLongWorkerRequests) {
                    stats.shift();
                }
                var total = 0;
                for (var i = 0; i < stats.length; i++) {
                    total += stats[i];
                }
                var average = total / stats.length;
                if (stats.length >= proxy.sampleSizeForLongWorkerRequests
                    && average > proxy.longWorkerResponseTimeThreshold) {
                    proxy.proxyPathnamesForLongWorkers[pathname] = true;
                }
            });
        }
    }
}
exports.makeProxyRequestWatchingForLongWork = makeProxyRequestWatchingForLongWork;

var defaultProxy = {
    urlMatcher: /^(?!\/cycligent\/)/, // Everything that doesn't start with /cycligent/
    httpMethods: '*',
    sampleSizeForLongWorkerRequests: 20,
    longWorkerResponseTimeThreshold: 1000,
    proxyRetryTimeout: 90000, // Keep trying for 1 minute and a half. A deployment may have just completed.
    proxyResponseTimes: {},
    proxyPathnamesForLongWorkers: {},
    action: function(parsedUrl, request, response) {
        var proxy = this;
        var versionType = versionTypeDetermine(request);
        var roleProcessesForVersionType = proxyTargetsByVersionTypeAndRole[versionType];
        var roleType = roleProcessRoleTypeDetermine(proxy, roleProcessesForVersionType, parsedUrl.pathname);

        if (usingProxyTestHelper && config.deploymentName == "local" && config.roleType != "web") {
            proxy.utils.proxyIt("http", "127.0.0.1", proxyTestHelperPort, request, response);
        } else if (roleProcessesForVersionType && roleProcessesForVersionType[roleType]) {
            var roleProcesses = roleProcessesForVersionType[roleType];
            var chosenRoleProcess = roleProcessChooseRoundRobin(roleProcesses);
            proxy.utils.makeProxyRequestWatchingForLongWork(proxy, chosenRoleProcess, request, response, parsedUrl.pathname);
        } else {
            if (processRoleProcessInfoChecks !== undefined && ((Date.now() - request.timingStart) <= proxy.proxyRetryTimeout)) {
                setTimeout(function() {
                    proxy.action(parsedUrl, request, response);
                }, 1000);
            } else {
                response.writeHead(500, {'Content-Type': 'text/plain'});
                response.end("Cycligent Proxy: Could not find any servers to proxy to.");
            }
        }
    }
};
exports.defaultProxy = defaultProxy;
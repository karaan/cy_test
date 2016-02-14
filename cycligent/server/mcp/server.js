var http = require('http');
var url = require('url');
var fs = require('fs');
var child_process = require('child_process');

var port = process.env.PORT || 1337;
// These are basically acting as locks for appcmd.exe, which can step over itself and blow up.
// Currently they're sepearate locks though (so adding and removing in quick succession could cause a problem),
// so we'll want to look to combine them.
// Possibly better than a lock would be a special spawning mechanism that will regulate how we run appcmd.exe so
// we only have one instance running at a time, and the others wait.
var creatingSite = false;
var deletingSite = false;

function spawnHelper(pathname, executable, args, next) {
    var child = child_process.spawn(executable, args, {
        env: process.env
    });
    var statusCode = 200;
    var returnText = "";
    child.stdout.on("data", function(data) {
        data = data.toString();
        console.error(pathname + " " + executable + " stdout: " + data);
        returnText += data;
    });
    child.stderr.on("data", function(data) {
        data = data.toString();
        console.error(pathname + " " + executable + " stderr: " + data);
        returnText += data;
    });
    child.on("error", function(e) {
        console.error(pathname + " " + executable + " error: " +  e.message);
        statusCode = 500;
    });
    child.on("exit", function() {
        console.error(pathname + " " + executable + " exited.");
        returnText += "\nThe child process exited.\n";
        next(statusCode, returnText);
    });
}

function appPoolStop(pathname, appPoolName, callback) {
    spawnHelper(pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["stop", "apppool", appPoolName], callback);
}

function appPoolStart(pathname, appPoolName, callback) {
    spawnHelper(pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["start", "apppool", appPoolName], callback);
}

http.createServer(function (req, res) {
    var parsedUrl = url.parse(req.url, true);
    //var child, statusCode, returnText;
    if (parsedUrl.pathname == "/stop" && parsedUrl.query.name) {
        appPoolStop(parsedUrl.pathname, parsedUrl.query.name, function(statusCode, returnText) {
            res.writeHead(statusCode, {"Content-Type": "text/plain"});
            res.end(returnText);
        });
    } else if (parsedUrl.pathname == "/start" && parsedUrl.query.name) {
        appPoolStart(parsedUrl.pathname, parsedUrl.query.name, function(statusCode, returnText) {
            returnText += "\nThe child process exited.\n";
            res.writeHead(statusCode, {"Content-Type": "text/plain"});
            res.end(returnText);
        });
    } else if (parsedUrl.pathname == "/appPoolRestart" && parsedUrl.query.name) {
        appPoolStop(parsedUrl.pathname, parsedUrl.query.name, function(statusCode, returnText) {
            if (statusCode == 500) {
                returnText += "\nThe child process exited.\n";
                res.writeHead(statusCode, {"Content-Type": "text/plain"});
                res.end(returnText);
            } else {
                appPoolStart(parsedUrl.pathname, parsedUrl.query.name, function(statusCode, returnText) {
                    returnText += "\nThe child process exited.\n";
                    res.writeHead(statusCode, {"Content-Type": "text/plain"});
                    res.end(returnText);
                });
            }
        });
    } else if (parsedUrl.pathname == "/shutdown") {
        spawnHelper(parsedUrl.pathname, "shutdown", ["/s", "/t", "30", "/d", "p:0:0", "/c", "Shutdown initiated by Master Control Program."],
            function(statusCode, returnText) {
                res.writeHead(statusCode, {"Content-Type": "text/plain"});
                res.end(returnText);
            });
    } else if (parsedUrl.pathname == "/restart") {
        spawnHelper(parsedUrl.pathname, "shutdown", ["/r", "/t", "30", "/d", "p:0:0", "/c", "Restart initiated by Master Control Program."],
            function(statusCode, returnText) {
                res.writeHead(statusCode, {"Content-Type": "text/plain"});
                res.end(returnText);
            });
    } else if (parsedUrl.pathname == "/create" && parsedUrl.query.deploymentName && parsedUrl.query.roleProcess_id && parsedUrl.query.friendlyName && parsedUrl.query.set_id && parsedUrl.query.roleType && parsedUrl.query.versionType) {
        (function(){
        checkAndWaitForCreate();
        var portUsed; // This is kind of ugly, but both addSite and cycligentProbePing need this.

        function checkAndWaitForCreate() {
            if (creatingSite == false) {
                creatingSite = true;
                portFind();
            } else {
                setTimeout(checkAndWaitForCreate, 100);
            }
        }

        function portFind() {
            spawnHelper(parsedUrl.pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["list", "site"],
                function(statusCode, returnText) {
                    var regex = /bindings:http\/\*:(\d+):.*/gm;
                    var ports = [];
                    var result;
                    var sawPort80 = false;
                    do {
                        result = regex.exec(returnText);
                        if (result != null) {
                            var pushingPort = parseInt(result[1]);
                            ports.push(pushingPort);
                            if (pushingPort == 80) {
                                sawPort80 = true;
                            }
                        }
                    } while (result != null);
                    ports.sort(function(a,b) { return a - b; }); // Sort ports in ascending order.
                    if (statusCode == 500) {
                        creatingSite = false;
                        returnText += "\nThe child process exited.\n";
                        res.writeHead(statusCode, {"Content-Type": "text/plain"});
                        res.end(returnText);
                    } else {
                        var port;
                        if (parsedUrl.query.roleType == "web" && sawPort80 == false) {
                            port = 80;
                        } else {
                            port = ports[ports.length-1] + 1;
                            // Use the next port after the highest port number.
                            if (port == 88) // Port 88 is already taken, so skip it.
                                port++;
                        }

                        addSite(port);
                    }
                });
        }

        function addSite(port) {
            portUsed = port;
            spawnHelper(parsedUrl.pathname, "powershell", [
                'C:\\cycligent\\scripts\\New-CycligentSite.ps1',
                '-deploymentUserName', 'D\\i3d-deploy',
                '-deploymentName', parsedUrl.query.deploymentName,
                "-roleProcess_id", parsedUrl.query.roleProcess_id,
                "-set_id", parsedUrl.query.set_id,
                '-versionType', parsedUrl.query.versionType,
                "-roleType", parsedUrl.query.roleType,
                "-cyvisor", (parsedUrl.query.cyvisor == "true")? "$true" : "$false",
                '-siteName', parsedUrl.query.friendlyName,
                '-sitePhysicalPath', 'c:\\cycligent\\' + parsedUrl.query.friendlyName,
                '-siteAppPoolName', parsedUrl.query.friendlyName,
                '-sitePort', port
            ], function(statusCode, returnText) {
                creatingSite = false;
                if (statusCode == 500) {
                    res.writeHead(statusCode, {"Content-Type": "text/plain"});
                    res.end(returnText);
                } else {
                    appPoolRecycle();
                }
            });
        }

        function appPoolRecycle() {
            spawnHelper(parsedUrl.pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["recycle", "apppool", parsedUrl.query.friendlyName],
                function(statusCode, returnText) {
                    if (statusCode == 500) {
                        res.writeHead(statusCode, {"Content-Type": "text/plain"});
                        res.end(returnText);
                    } else {
                        cycligentProbePing();
                    }
                });
        }

        function cycligentProbePing() {
            var req = http.request({
                host: 'localhost',
                port: portUsed,
                method: 'GET',
                path: '/cycligent/agent/probe'
            }, function(/*probeResponse*/) {
                // TODO: 5. Should we check for 200 OK and then try again?
                res.writeHead(200, {"Content-Type": "text/plain"});
                res.end("Pinged /cycligent/agent/probe. ");
            });

            req.on('error', function(err) {
                res.writeHead(500, {"Content-Type": "text/plain"});
                res.end("Pinging /cycligent/agent/probe failed: " + err.message);
            });
            req.end();
        }
        })();
    } else if (parsedUrl.pathname == "/delete" && parsedUrl.query.name) {
        checkAndWaitForDelete();

        function checkAndWaitForDelete() {
            if (deletingSite == false) {
                deletingSite = true;
                deleteStart();
            } else {
                setTimeout(checkAndWaitForDelete, 100);
            }
        }

        function deleteStart() {
            siteDelete(function() {
                appPoolDelete(directoryDelete);
            });
        }

        function siteDelete(next) {
            spawnHelper(parsedUrl.pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["delete", "site", parsedUrl.query.name],
                function(statusCode, returnText) {
                    if (statusCode == 500) {
                        deletingSite = false;
                        res.writeHead(statusCode, {"Content-Type": "text/plain"});
                        res.end(returnText);
                    } else {
                        next();
                    }
                });
        }

        function appPoolDelete(next) {
            spawnHelper(parsedUrl.pathname, "C:\\Windows\\system32\\inetsrv\\appcmd.exe", ["delete", "apppool", parsedUrl.query.name],
                function(statusCode, returnText) {
                    deletingSite = false;
                    if (statusCode == 500) {
                        res.writeHead(statusCode, {"Content-Type": "text/plain"});
                        res.end(returnText);
                    } else {
                        next();
                    }
                });
        }

        function directoryDelete() {
            var statusCode = 200;
            var returnText = "";
            var child = child_process.exec(['rmdir /s /q ' + "C:\\cycligent\\" + parsedUrl.query.name],
                {env: process.env}, function(error, stdout, stderr) {
                if (error) {
                    console.error(parsedUrl.pathname + " rmdir error: " +  error.message);
                    statusCode = 500;
                }
                stdout = stdout.toString();
                stderr = stderr.toString();
                returnText += stdout;
                returnText += stderr;
                console.error(parsedUrl.pathname + " rmdir stdout: " + stdout);
                console.error(parsedUrl.pathname + " rmdir stderr: " + stderr);

                console.error(parsedUrl.pathname + " rmdir exited.");
                returnText += "\nThe child process exited.\n";
                res.writeHead(statusCode, {"Content-Type": "text/plain"});
                res.end(returnText);
            });
        }
    } else {
        res.writeHead(404, {"Content-Type": "text/plain"});
        res.end("404 Unknown Path Specified.");
    }
}).listen(port);
console.log('Server running at http://127.0.0.1:' + port + '/');
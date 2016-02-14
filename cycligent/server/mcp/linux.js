var sys = require('sys'),
    http = require('http'),
    url = require('url'),
    exec = require('child_process').exec;

var port = process.env.PORT || 9876;

var addingSite = false;

http.createServer(function (req, res) {
    var url_parts = url.parse(req.url, true);
    var query = url_parts.query;

    switch(url_parts.pathname) {
        case '/':
            cy_home(url_parts.pathname, req, res);
        break;
        case '/list':
            cy_list(url_parts.pathname, req, res);
        break;
        case '/create':
            cy_add(url_parts.pathname, req, res);
        break;
        case '/delete':
            cy_directive(url_parts.pathname, req, res, 'remove');
        break;
        case '/start':
            cy_directive(url_parts.pathname, req, res, 'start');
        break;
        case '/stop':
            cy_directive(url_parts.pathname, req, res, 'stop');
        break;
        case '/appPoolRestart':
            cy_directive(url_parts.pathname, req, res, 'restart');
        break;
        case '/restart':
            cy_directive(url_parts.pathname, req, res, 'reboot');
            break;
        default:
            cy_home(url_parts.pathname, req, res);
    }
    return;

    function cy_home(url, req, res) {
        res.writeHead(200, {'Content-Type': 'text/html'});
        var output = " \
            <body><p>This is the Cloud Control server for this machine!</p> \
           <ul> \
             <li><a href=\"/list\">/list</a></li> \
             <li>/create?deploymentName=<em>deploymentName</em>&roleProcess_id=<em>roleProcess_id</em>&amp;friendlyName=<em>friendlyName</em>&amp;set_id=<em>set_id</em>&amp;roleType=<em>roleType</em>&amp;versionType=<em>versionType</em></li> \
             <li>/delete?name=<em>friendlyName</em></li> \
           </ul></body>";
        res.end(output);
    }

    function cy_list(url, req, res) {
        res.writeHead(200, {'Content-Type': 'application/json'});

        function respond (error, stdout, stderr) {
            if (stderr) {
                sys.puts('Error: ' + stderr);
            }
            res.end(stdout);
        }

        exec("/usr/local/bin/cy list", respond);
    }

    function cy_add(url, req, res) {
        res.writeHead(200, {'Content-Type': 'application/json'});

        var deploymentName = query.deploymentName;
        var roleProcess_id = query.roleProcess_id;
        var friendlyName = query.friendlyName;
        var set_id = query.set_id;
        var versionType = query.versionType;
        var roleType = query.roleType;
        var cyvisor = query.cyvisor;

        var cy_cmd = '/usr/local/bin/cy add ' + deploymentName + ' ' + friendlyName + ' ' + roleProcess_id + ' ' +
            set_id + ' ' + versionType + ' ' + roleType + ' ' + cyvisor;

        checkAndWaitForAdd();

        function process_cmd (error, stdout, stderr) {
            addingSite = false;

            var output = {};
            output.data = {};
            output.data.roleProcess_id = roleProcess_id;
            output.data.cmd = cy_cmd;

            var ports = stdout.split("\n").filter(function(line) { return line.indexOf("Port") != -1; });

            ports.forEach(function (line) {
                var columns = line.split(':');
                if (columns[0].indexOf("External") != -1) {
                    output.data.external_port = columns[1].trim();
                }
                if (columns[0].indexOf("App") != -1) {
                    output.data.app_port = columns[1].trim();
                }
                if (columns[0].indexOf("Agent") != -1) {
                    output.data.agent_port = columns[1].trim();
                }
            });

            if (stderr) {
                sys.puts('Error: ' + stderr);
                output.status = 'error';
            } else {
                output.status = 'success';
            }

            res.end(JSON.stringify(output));
        }

        function checkAndWaitForAdd() {
            if (addingSite == false) {
                addingSite = true;
                sys.puts('Running cy command: ' + cy_cmd);
                exec(cy_cmd, process_cmd);
            } else {
                setTimeout(checkAndWaitForAdd, 100);
            }
        }
    }

    function cy_directive(url, req, res, directive) {
        res.writeHead(200, {'Content-Type': 'application/json'});

        var roleProcess_id = query.name;

        var cy_cmd = '/usr/local/bin/cy ' + directive + ' ' + roleProcess_id;

        function process_cmd (error, stdout, stderr) {
            var output = {};
            output.data = {};
            output.data.roleProcess_id = roleProcess_id;
            output.data.cmd = cy_cmd;
            output.status = 'success';

            if (stderr) {
                sys.puts('Error: ' + stderr);
            }

            res.end(JSON.stringify(output));
        }

        exec(cy_cmd, process_cmd);
    }


}).listen(port);
sys.puts('Server running at http://127.0.0.1:' + port);

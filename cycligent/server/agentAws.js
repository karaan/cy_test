var http = require('http');
var agent = require("./agent.js");

function actionExecute(state, data, callback){

    // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
    switch (data.action) {

        case "Shut down machine":
            callback(); // Callback first because we might not be alive anymore in a few moments.
            shutdownMachine();
            break;

        case "Stop role process":
            callback(); // Callback first because we might not be alive anymore in a few moments.
            stopApp(data.roleProcess_id);
            break;

        case "Ignore role process requests":
            agent.ignoreRequests();
            callback();
            break;

        case "Handle role process requests":
            agent.handleRequests();
            callback();
            break;

    }

}
exports.actionExecute = actionExecute;

// This will only get called in trial deployments:
function shutdownMachine(){

    var req = http.get("http://127.0.0.1:9876/shutdown", function(res) {
        var output = "";
        res.on('data', function(chunk) {
            output += chunk.toString();
        });
        res.on('end', function() {
            console.error("Shutting down...");
        });
    });
    req.on('error', function(e) {
        console.error("agentAws: Got an error when trying to shutdown:");
        console.error(e.message);
    });
}

// This will only get called in trial deployments:
function stopApp(roleProcess_id){
    agent.roleProcessesCollection.findOne({_id: roleProcess_id}, function(err, roleProcessDoc) {
        if (err) {
            console.error("deleteRoleProcess: Error accessing the database.");
            console.error(err);
            return;
        }

        // Send command to Ec2 trial deployment admin process
        roleProcess_id = roleProcessDoc.friendlyName;
        var req = http.get("http://127.0.0.1:9876/stop?name=" + roleProcess_id, function (res) {
            var output = "";
            res.on('data', function (chunk) {
                output += chunk.toString();
            });
            res.on('end', function () {
                console.error("Stopping app...");
            });
        });
        req.on('error', function (e) {
            console.error("agentAws: Got an error when trying to stop the app:");
            console.error(e.message);
        });
    });
}


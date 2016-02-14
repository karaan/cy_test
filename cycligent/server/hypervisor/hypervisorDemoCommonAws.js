var url = require('url');
var http = require('http');
var https = require('https');

var cyvisor = require('./../cyvisor.js');
var config = require('./../configProcess.js');

var roleProcessesCollection;
var setsCollection;
exports.roleProcessesCollectionSet = function(roleProcesses, sets){
    roleProcessesCollection = roleProcesses;
    setsCollection = sets;
};

function demoSubscriptionSQLServerRestart(state, callback) {
    var postOptions = url.parse("https://www.cycligent.com/account/demoSubscriptionSQLServerRestart");
    //var postOptions = url.parse("http://localhost:1337/account/demoSubscriptionSQLServerRestart");
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': 0
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "demoSubscriptionSQLServerRestart: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
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
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "demoSubscriptionSQLServerRestart: Unable to parse the response from www.cycligent.com.";
                }
            }

            state.target.status = status;
            state.target.error = error;
            callback();
        });
    });
    req.end();

    req.on('error', function(e) {
        console.error("demoSubscriptionSQLServerRestart: Error connecting to www.cycligent.com:");
        console.error(e);
        state.target.status = "error";
        state.target.error = "demoSubscriptionSQLServerRestart: Unable to connect to www.cycligent.com to restart a SQL server.";
        callback();
    });
}
exports.demoSubscriptionSQLServerRestart = demoSubscriptionSQLServerRestart;

function demoSubscriptionSQLServerDelete(state, callback) {
    var postOptions = url.parse("https://www.cycligent.com/account/demoSubscriptionSQLServerDelete");
    //var postOptions = url.parse("http://localhost:1337/account/demoSubscriptionSQLServerDelete");
    postOptions.method = "POST";
    postOptions.headers = {
        'Content-Type': 'application/json',
        'Content-Length': 0
    };

    var req = https.request(postOptions, function(response) {
        var error = null;
        var status = "success";
        if (response.statusCode != 200) {
            status = "error";
            error = "demoSubscriptionSQLServerDelete: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
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
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "demoSubscriptionSQLServerDelete: Unable to parse the response from www.cycligent.com.";
                }
            }

            cyvisor.demoHasSQLServerSet(null);
            state.target.status = status;
            state.target.error = error;
            callback();
        });
    });
    req.end();

    req.on('error', function(e) {
        console.error("demoSubscriptionSQLServerDelete: Error connecting to www.cycligent.com:");
        console.error(e);
        state.target.status = "error";
        state.target.error = "demoSubscriptionSQLServerDelete: Unable to connect to www.cycligent.com to delete a SQL server.";
        callback();
    });
}
exports.demoSubscriptionSQLServerDelete = demoSubscriptionSQLServerDelete;

function demoSubscriptionSQLServerAdd(state, type, callback) {
    var postOptions = url.parse("https://www.cycligent.com/account/demoSubscriptionSQLServerAdd");
    //var postOptions = url.parse("http://localhost:1337/account/demoSubscriptionSQLServerAdd");
    var postData = JSON.stringify({type: type});
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
            error = "demoSubscriptionSQLServerAdd: Server returned non-success status code: " + response.statusCode;
        }
        var responseData = '';
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
                        break;
                    }
                }
            } catch(e) {
                if (!error) {
                    status = "error";
                    error = "demoSubscriptionSQLServerAdd: Unable to parse the response from www.cycligent.com.";
                }
            }

            cyvisor.demoHasSQLServerSet(type);
            state.target.status = status;
            state.target.error = error;
            callback();
        });
    });
    req.end(postData);

    req.on('error', function(e) {
        console.error("demoSubscriptionSQLServerAdd: Error connecting to www.cycligent.com:");
        console.error(e);
        state.target.status = "error";
        state.target.error = "demoSubscriptionSQLServerAdd: Unable to connect to www.cycligent.com to request a SQL server.";
        callback();
    });
}
exports.demoSubscriptionSQLServerAdd = demoSubscriptionSQLServerAdd;

function resizeMachine(state, data, callback){
    state.target.status = "error";
    state.target.error = "Machines cannot be resized in trial mode.";
    callback();
}
exports.resizeMachine = resizeMachine;

function startMachine(state, data, callback){
    // Machines can't be started in trial mode, because that would require you to shut a machine down. But if you
    // shut a machine down in trial mode, everything would go down since it's all on one machine! And there would
    // be no way to start it all up again.
    state.target.status = "error";
    state.target.error = "Machines cannot be started in trial mode.";
    callback();
}
exports.startMachine = startMachine;

/**
 *
 * @param {State} state The Cycligent state object.
 * @param {Object} data Data we received from the Cloud Control cycligentCall.
 * @param {*} output Any output data from the deletion that we want to send to the browser.
 * @param {Function} callback Callback to call when the removal is done.
 */
function roleProcessRemoveFromDb(state, data, output, callback) {
    roleProcessesCollection.removeOne({_id: data.roleProcess_id}, function(err) {
        if (err) {
            state.target.status = "error";
            state.target.error = "An error occurred when trying to remove the server from the 'roleProcesses' collection.";
            callback();
        } else {
            cyvisor.environmentInfoUpdate();
            state.target.status = "success";
            state.target.reponse = output;
            callback();
        }
    });
}
exports.roleProcessRemoveFromDb = roleProcessRemoveFromDb;
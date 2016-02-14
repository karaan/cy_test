var agent = require("./agent.js");

function actionExecute(state, data, callback){

    // Could make this a map, but I think it is clearer as a list and is not called often, so performance not a concern
    switch (data.action) {

        case "Delete machine":
            callback(); // Callback first because we might not be alive anymore in a few moments.
            deleteMachine();
            break;

        case "Shut down machine":
            callback(); // Callback first because we might not be alive anymore in a few moments.
            shutdownMachine();
            break;

        case "Stop role process":
            callback(); // Callback first because we might not be alive anymore in a few moments.
            stopApp();
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

function deleteMachine(){

    require('./cycligent.js').gracefulShutdown();

}

function shutdownMachine(){

    require('./cycligent.js').gracefulShutdown();

}

function stopApp(){

    require('./cycligent.js').gracefulShutdown();

}


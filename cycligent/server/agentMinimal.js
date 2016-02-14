var agent = require("./agent.js");

function actionExecute(state, data, callback){

    callback(new Error("Minimal deployments to not support Cyvisor actions."));

}
exports.actionExecute = actionExecute;

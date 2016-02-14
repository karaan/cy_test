function action(state, data, callback) {

    callback(new Error("Minimal deployments do not support Cyvisor actions."));

}
exports.action = action;


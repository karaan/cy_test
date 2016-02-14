var dottedNameHandler = require('./utils.js').dottedNameHandler;
//TODO: 2. We need to think about security around calls

module.exports = {
    mapSet: mapSet,
    process: process,
    textFileProcess: textFileProcess
};

var map;

function mapSet(value){
    map = value;
}

/**
 * Process a call from the client
 * @param {State} state
 * @param {Function} callback
 */
function process(state,callback){

    //TODO: 2. We should probably check the security of the call path here! (or in server.js provider function)

    state.target = {target:"cycligentCall",request:state.post.request};
    state.targets.push(state.target);
    state.call = state.post.call;
    state.target.id = state.call.id;

    var handler = dottedNameHandler(state.rootName, state.call.name, state.post.location, map);

    if(handler){
        state.timerStart(state.call.name);
        handler(state, state.call.data, function(){
            state.timerStop(state.call.name);
            callback(state);
        });
    }else{
        state.error('Unable to determine a call handler for "' + state.call.name + '".');
        callback(state);
    }
}

/**
 * Process a call from an HTML file
 * @param {State} state
 * @param {String} method
 * @param {Object} parameters
 * @param {Function} callback
 */
function textFileProcess(state,method,parameters,callback){

    //TODO: 2. We should probably check the security of the call path here!

    var dottedLocation = state.pathName.replace(/\\/g,"/").substr(1,state.pathName.lastIndexOf("/")).replace("/client/",".").replace(/\//g,".");
    var handler = dottedNameHandler(state.rootName, method, dottedLocation, map, '_clientTextFunctions');

    if(handler){
        handler(state,parameters,callback);
    }else{
        state.error('Unable to determine a call handler for "' + method + '".');
        callback(state,"");
    }

}

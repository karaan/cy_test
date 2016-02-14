var dottedNameHandler = require('./utils.js').dottedNameHandler;

module.exports = {
    mapSet: mapSet,
    process: process
};

var map;

function mapSet(value){
    map = value;
}

/**
 * Process a download request from the client.
 * @param {State} state
 * @param {Function} callback
 */
function process(state,callback){
    state.target = {
        target: "cycligentDownload",
        contentType: 'text/plain',
        contentLength: undefined,
        filename: 'download.txt',
        encoding: 'utf8',
        data: 'Hello, World!',
        status: 'unknown'
    };
    state.targets.push(state.target);

    var handler = dottedNameHandler(state.rootName, state.post.name, state.post.location, map);

    if(handler){
        state.timerStart(state.post.name);
        handler(state, state.post.data, function(){
            state.timerStop(state.post.name);
            callback(state);
        });
    }else{
        state.error('Unable to determine a download handler for "' + state.post.name + '".');
        callback(state);
    }
}

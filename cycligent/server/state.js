/**
 * Created by JetBrains WebStorm.
 * User: Frank
 * Date: 3/20/12
 * Time: 9:28 PM
 * To change this template use File | Settings | File Templates.
 */

/**@type {Logger}*/ var log = require("./log.js");
/**@type {RequestNormal}*/var RequestNormal = require("./requestNormal.js");
/**@type {ResponseNormal}*/var ResponseNormal = require("./responseNormal.js");
/**@type {ResponseNormal}*/var ResponseMessage = require("./responseMessage.js");

module.exports = State;

/**
 * State test doc
 * @param request
 * @param response
 * @param pathName
 */
function State(config,request,response,parsedUrl,pathName){

    if(arguments.length == 2){
        // Argument is state object received from message bus, create local state object from it
        var message = request;
        var body = message.body;

        this.startOrigin = body.start;
        this.start = (new Date()).getTime();
        this.timings = [];
        this.timingAdd("messageSendToWorker", (new Date()).getTime() - message.sent.getTime());
        this.request = new RequestNormal(body.request);
        this.response = new ResponseNormal(new ResponseMessage());
        this.parsedUrl = body.parsedUrl;
        this.pathName = body.pathName;
        this.testUser = body.testUser;
        /**@type {UserDoc}*/
        this.user = body.user;
        this.authorization = body.authorization; //@cycligentDoc {Property:String} The authorization the client has to send back on every POST request.

        this.returnTo = message.returnTo;
        this.resourceAnonymous = body.resourceAnonymous;
        this.post = JSON.parse(body.post);
        this.fileCallProcess = body.fileCallProcess;
        this.createdFrom = "messageBus";
    } else {
        // Create a new state object based on the web request
        this.start = (new Date()).getTime();
        this.request = new RequestNormal(request);
        this.response = new ResponseNormal(response);
        this.parsedUrl = parsedUrl;
        this.pathName = pathName;
        this.testUser = false;
        /**@type {UserDoc}*/
        this.user = '';
        this.post = {};
        this.timings = [];
        this.authorization = ''; //@cycligentDoc {Property:String} The authorization the client has to send back on every POST request.
        this.createdFrom = "http";
    }

    //TODO: 2. Document these properties
    this.errors = [];
    this.timerName = "";
    this.timerStarted = 0;
    this.requestData = {};
    this.mongodb = config.mongodb;
    this.target = {};
    this.targets = [];
    this.services_ids = [];
    this.call = '';
    this.dbs = {};
    this.multipleVersions = config.activeDeployment.supports.multipleVersions;

    this.rootName = /\/([^/]+)(?:\/|$)/.exec(this.pathName)[1];
    this.root = config.roots[this.rootName];
    if (this.root) {
        this.authenticatorConfig = config.activeDeployment.authenticators[this.root.authenticators[0]];
    }


    this.errorLevels = {
        criticalSystemFailure: 256,	//@cycligentDoc {Property:Bit} A critical system failure occurred.
        errorDataCorruption: 128,	//@cycligentDoc {Property:Bit} An error causing data corruption occurred.
        errorSystemAffected: 64,	//@cycligentDoc {Property:Bit} The system as a whole, or multiple users, were affected by an error.
        errorUserAffected: 32,		//@cycligentDoc {Property:Bit} A single user was affected by an error.
        warning: 16,				//@cycligentDoc {Property:Bit} The system issued a warning.
        informationImportant: 8,	//@cycligentDoc {Property:Bit} The system is providing important information.
        information: 4,				//@cycligentDoc {Property:Bit} The system is providing status information.
        progress: 2,				//@cycligentDoc {Property:Bit} The system is providing progress information.
        performance: 1				//@cycligentDoc {Property:Bit} The system is providing performance information.
    };

    if(arguments.length == 2){
        this.rootDbsSet(config,this.user.type);
    }
}

/**
 * Begin a timer with the given name. You can only have one timer running at a time.
 * Stop the timer with State.timerStop.
 *
 * @param {String} name
 */
State.prototype.timerStart = function(name){
    if(this.timerName == ""){
        this.timerName = name;
        this.timerStarted = (new Date()).getTime();
    } else {
        this.error(this.errorLevels.warning,'The performance timer "' + name + '" was started while the timer "' + this.timerName + '" was pending. The start of timer "' + name + '" was ignored.');
    }
};

/**
 * Stop a timer with the given name.
 * You can start a timer with State.timerStart.
 *
 * @param {String} name
 */
State.prototype.timerStop = function(name){
    if(this.timerName == name){
        this.timerName = "";
        this.timings.push([name,(new Date()).getTime() - this.timerStarted]);
    } else {
        this.error(this.errorLevels.warning,'The performance timer "' + name + '" was stopped while the timer "' + this.timerName + '" was pending. The stop of timer "' + name + '" was ignored, and timer "' + this.timerName + '" was stopped (potentially prematurely).');
        this.timings.push(["OVERLAP: " + this.timerName + "/" + name,(new Date()).getTime() - this.timerStarted]);
    }
};

/**
 * Add a timing for something you timed without State.timerStart and State.timerStop.
 *
 * @param {String} name
 * @param {Number} milliseconds
 */
State.prototype.timingAdd = function(name, milliseconds) {
    this.timings.push([name, milliseconds]);
};

/**
 * Push an error into the state.  The error will be logged and pushed to the client for display
 * in the trace window. It will also be displayed on the console if the configuration is so set.
 * @param {String} [componentArg=state.root] The level of the error defaults to errorLevels.errorUserAffected (32)
 * @param {Number} [levelArg=32] The level of the error defaults to errorLevels.errorUserAffected (32)
 * @param {String} messageArg The text message of the error.
 * @see {@link State}
 */
State.prototype.error = function(componentArg,levelArg,messageArg){

    var component = this.rootName;
    var level = this.errorLevels.errorUserAffected;
    var message;

    if(arguments.length == 1){
        message = componentArg;
    } else {
        if(arguments.length == 2){
            if( typeof arguments[0] === 'number' ){
                level = arguments[0];
            } else {
                component = arguments[0];
            }
            message = arguments[1];
        } else {
            component = componentArg;
            level = levelArg;
            message = messageArg;
        }
    }

    this.errors.push([level,message]);
    log.write(component,level,message);
};

/**
 * Convenience, code beautification function. Provides a clean method for making Mongo DB calls and handling errors.
 * @param err Error object.  Must have a message property.
 * @param {String} [componentArg=state.root] The level of the error defaults to errorLevels.errorUserAffected (32)
 * @param {Number} [level] Error level
 * @param {Function} [failure] Function to call if a failure was detected.  Failure Function is passed the state object as its only argument.
 * @return {Boolean}  Returns true if no error was detected, false if error was detected
 */
State.prototype.noError = function(err,componentArg,levelArg,failureArg){

    if(err){

        var component = this.rootName;
        var level = this.errorLevels.errorUserAffected;
        var failure;

        if(arguments.length > 1){
            if(typeof arguments[1] === 'string'){
                component = arguments[1];
                if(arguments.length > 2){
                    if(typeof arguments[2] === 'number'){
                        level = arguments[2];
                        if(arguments.length > 3){
                            failure = arguments[3];
                        }
                    } else {
                        failure = arguments[2];
                    }
                }
            } else {
                if(typeof arguments[1] === 'number'){
                    level = arguments[1];
                    if(arguments.length > 2){
                        failure = arguments[2];
                    }
                } else {
                    failure = arguments[1];
                }
            }
        }

        this.error(component,level,err.message);

        if(failure){
            failure(this);
        }

        return false;

    } else {

        return true;

    }

};

State.prototype.rootDbsSet = function(config,type){

    if(type != 'conduitController'){
        type += 'User';
    }

    var dbIndex;

    for(dbIndex in this.root.dbs){
        if(this.root.dbs[dbIndex][type]){
            this.dbs[dbIndex] = config.dbs[this.root.dbs[dbIndex][type]].db;
            if(this.root.dbs[dbIndex].sessionDb){
                this.sessionDb = this.dbs[dbIndex];
                this.sessionDbName = dbIndex;
            }
        }
    }
};


State.prototype.findAndRemoveTimings = function() {
    var i;
    var timings;
    for (i = 0; i < this.targets.length; i++) {
        var target = this.targets[i];
        if (target.target == "cycligentTiming") {
            timings = target.json;
            break;
        }
    }
    if (timings)
        this.targets.splice(i, 1);

    return timings;
};

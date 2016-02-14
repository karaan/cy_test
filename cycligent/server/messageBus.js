/**@type {Logger}*/ var log = require("./log.js");
var State = require('./state.js');

module.exports = Bus = (function(){

    var db;
    var messages;
    var deliveries;
    var problems;
    var captureDeliveries;
    var separateProblems;
    var expiredCleanupInterval;
    var cpuMax = 0.75;
    var pollListenDelay = 50;
    var pollReceiveDelay = 50;
    var pollReceiveDelayLong = 5000;
    var timeout;
    var messagesMax = 0;
    var config;
    var sequence = 0;
    var component;
    var version;
    var versionExtended;
    var listenerID = 0; // Each call to listen returns an ID so you can pause and resume listening for messages.
    var listenerData = []; // Stores the arguments for the listeners.
    var ready = false;

    function deliverySave(message){
        message.history.push({
            component: component,
            version: versionExtended,
            sequence: null,
            timestamp: (new Date())
        });
        deliveries.insertOne(message,function(err/*,result*/){
            if(err){
                log.write('messageBus', 16, "Unable to write to deliveries message store due to the following error: " + err.message);
            }
        });
    }

    function messageHasExpired(message) {
        return message.expires < new Date();
    }

    return {

        /***
         *
         * @param {ServerConfig} configArg
         * @param {Function} callback
         */
        start: function(configArg,callback){
            var me = this;
            config = configArg;

            component = config.name;
            version = config.version;
            versionExtended = config.versionType + '-' + version;

            var bus = config.activeDeployment.messageBus;

            db = config.dbs.messageBus.db;
            captureDeliveries = bus.captureDeliveries;
            separateProblems = bus.separateProblems;
            expiredCleanupInterval = bus.expiredCleanupInterval;
            cpuMax = bus.cpuMax;
            messagesMax = bus.messagesMax;
            timeout = bus.timeout;
            pollListenDelay = bus.pollDelay;
            pollReceiveDelay = bus.pollDelay;
            pollReceiveDelayLong = bus.pollDelayLong;

            db.collection(bus.collectionNames.pending,function(err,collection){
                if(err){
                    throw err;
                }
                messages = collection;
                messages.ensureIndex({channel: 1, version: 1, _id: 1}, function(err/*,collection*/){
                    if(err){
                        throw err;
                    }
                    messages.ensureIndex({channel: 1, version: 1, subChannel: 1, _id: 1}, function(err/*,collection*/){
                        if(err){
                            throw err;
                        }

                        /**
                         * Only one server cleans expired messages because previously we let
                         * every web server do it, and they were stepping over each other,
                         * throwing a number of duplicate key errors.
                         */
                        if (config.isLeadWebServer) {
                            me.expiredProcess(messageBusReadyCheck);
                            me.scheduleExpiredProcessing();
                        }
                    });
                });
            });

            if(bus.captureDeliveries){
                db.collection(bus.collectionNames.delivered,function(err,collection){
                    if(err){
                        throw err;
                    }
                    deliveries = collection;
                    messageBusReadyCheck();
                });
            }

            if(bus.separateProblems){
                db.collection(bus.collectionNames.problem,function(err,collection){
                    if(err){
                        throw err;
                    }
                    problems = collection;
                    messageBusReadyCheck();
                });
            }

            function messageBusReadyCheck(){
                if(!ready){
                    if(captureDeliveries){
                        if(separateProblems){
                            if( messages && deliveries && problems ){
                                ready = true;
                                callback();
                            }
                        } else {
                            if( messages && deliveries ){
                                ready = true;
                                callback();
                            }
                        }
                    } else {
                        if(separateProblems){
                            if( messages && problems){
                                ready = true;
                                callback();
                            }
                        } else {
                            if( messages ){
                                ready = true;
                                callback();
                            }
                        }
                    }
                }
            }
        },

        /**
         * Remove all messages that have a time in their expires field
         * that is before the current time.
         *
         * You likely want to call expiredProcess, not this, because expiredProcess
         * will honor the options set in the configuration.
         *
         * @param {Function} [callback]
         */
        expiredRemove: function(callback) {
            messages.removeMany({expires: {$lt: new Date()}}, function(err) {
                if (err) {
                    log.write('messageBus', 64, "Unable to remove expired messages due to the following error: " + err.message);
                }

                if (callback)
                    callback();
            });
        },

        /**
         * Move messages to problemMessages if they have a time in their
         * expires field that is before the current time.
         *
         * You likely want to call expiredProcess, not this, because expiredProcess
         * will honor the options set in the configuration.
         *
         * @param {Function} [callback]
         * @param {Boolean} [retryingFromDuplicateKeyError] A flag to indicate whether we're calling this again after trying to recover from a duplicate key error.
         */
        expiredMove: function(callback, retryingFromDuplicateKeyError) {
            var me = this;
            var now = new Date();
            if (!callback)
                callback = function() {};
            messages.find({expires: {$lt: now}}).toArray(function(err, docs) {
                if (err) {
                    log.write('messageBus', 64, "Unable to find expired messages due to the following error: " + err.message);
                    callback();
                    return;
                }

                if (docs.length > 0) {
                    problems.insertMany(docs, function(err) {
                        if (err) {
                            // Duplicate key error. Something went wrong in previous cleanup, and we weren't able to
                            // remove problem messages from the messages collection.
                            if (err.name == "MongoError" && err.code == 11000 && !retryingFromDuplicateKeyError) {
                                me.expiredFixDuplicateKeyError(now, function(success) {
                                    if (success) {
                                        log.write('messageBus', 4, "Received a duplicate key error (E11000) when trying to move expired messages to problem messages collection, attempted to fix it, retrying the move.");
                                        me.expiredMove(callback, true);
                                    } else {
                                        log.write('messageBus', 64, "Received a duplicate key error (E11000) when trying to move expired messages to problem messages collection, and was unable to fix it.");
                                    }
                                    callback();
                                });
                                return;
                            } else {
                                log.write('messageBus', 64, "Unable to move expired messages to the problem messages collection due to the following error: " + err.message);
                                callback();
                                return;
                            }
                        }

                        messages.removeMany({expires: {$lt: now}}, function(err) {
                            if (err) {
                                log.write('messageBus', 64, "Unable to remove expired messages due to the following error: " + err.message);
                                callback();
                                return;
                            }

                            callback();
                        });
                    });
                } else {
                    callback();
                }
            });
        },

        /**
         * Occasionally things go wrong when moving problem messages for yet-to-be-determined
         * reasons. The upshot is that it causes a duplicate key error, and it looks like it
         * does successfully move problem messages, it just fails to remove them from messages.
         * This function applies the simple fix of removing these duplicate messages from the
         * messages collection.
         *
         * Long-term, we need to identify all the causes of these duplicate key errors, but
         * so far they've been elusive, so this function stands in the gap until then.
         *
         * @param {Date} time The time we are using to find expired messages. If a message has an 'expires' field less
         * than this, we will consider it.
         * @param {Function} callback Function called when this operation complete. This function will relieve true as
         * an argument if it was successful, and false if it wasn't.
         */
        expiredFixDuplicateKeyError: function(time, callback) {
            messages.find({expires: {$lt: time}}, {_id: 1}).toArray(function(err, docs) {
                if (err) {
                    log.write('messageBus', 64, "Unable to find expired messages due to the following error: " + err.message);
                    callback(false);
                    return;
                }

                var ids = docs.map(function(doc) { return doc._id; });
                problems.find({_id: {$in: ids}}, {_id: 1}).toArray(function(err, docs) {
                    if (err) {
                        log.write('messageBus', 64, "Unable to query problem messages due to the following error: " + err.message);
                        callback(false);
                        return;
                    }

                    var idsAlreadyInProblems = docs.map(function(doc) { return doc._id; });

					//check the array length, if empty no need to remove any problem message
					// 	to avoid this "$in must not start with '$'" error
					if(idsAlreadyInProblems && idsAlreadyInProblems.length <= 0){
						callback(true);
						return;
					}

                    messages.removeMany({_id: {$in: idsAlreadyInProblems}}, function(err) {
                        if (err) {
                            log.write('messageBus', 64, "Unable to remove messages that are already in the problem messages collection due to the following error: " + err.message);
                            callback(false);
                            return;
                        }

                        callback(true);
                    });
                });
            });
        },

        /**
         * This function finds all messages that have expired (expires field
         * is a time before the current time), and then deals with them
         * appropriately. If messageBus.separateProblems is true, then it
         * will move them into the problemMessages collection, otherwise it
         * will delete them.
         *
         * @param {Function} [callback]
         */
        expiredProcess: function(callback) {
            var me = this;

            if (config.activeDeployment.messageBus.separateProblems) {
                me.expiredMove(callback);
            } else {
                me.expiredRemove(callback);
            }
        },

        /**
         * Calls expiredProcess on an interval, to keep the messages collection clean.
         */
        scheduleExpiredProcessing: function() {
            var me = this;
            setInterval(me.expiredProcess.bind(me), expiredCleanupInterval);
        },

        queryBuild: function(channelArg,subChannelArg,versionArg){

            var query = {channel: channelArg};

            if(subChannelArg != '*'){
                query.subChannel = subChannelArg;
            }

            query.version = versionArg;

            return query;
        },

        subChannelMatches: function(filter,subChannel){

            if(filter == '*'){
                return true;
            }

            if(filter instanceof RegExp){
                return filter.test(subChannel);
            }

            return (filter == subChannel);
        },

        listen: function(channelArg,subChannelArg,versionArg,callbackArg){
            listenerData.push({listening: true, args: [listenerID, this.queryBuild(channelArg, subChannelArg, versionArg), callbackArg]});
            this.listen2.apply(this, listenerData[listenerID].args);
            return listenerID++;
        },

        listen2: function(id,query,callbackArg){
            if (!listenerData[id].listening)
                return;

            var me = this;
            messages.findAndRemove(
                query,
                [['_id', 1]],
                function(err,message){
                    if(err){
                        console.error("Error while listening to message on channel: " + query.channel);
                        console.error("Error was: " + err.message);
                        setTimeout(function(){me.listen2(id,query,callbackArg);},pollListenDelay);
                    } else {
                        message = message.value;
                        if(message){
                            if(captureDeliveries){
                                deliverySave(message);
                            }
                            if (messageHasExpired(message)) {
                                me.send("Untimely", message.subChannel, message.version, false, message.body, message.returnTo);
                            } else {
                                callbackArg(new State(config,message));
                            }
                            //TODO: 3. Enhance polling frequency algorithm to include CPU, max messages being processed, etc.
                            if (listenerData[id].listening)
                                me.listen2(id,query,callbackArg);
                        } else {
                            //TODO: 3. Enhance polling frequency algorithm to include CPU, max messages being processed, etc.
                            if (listenerData[id].listening)
                                setTimeout(function(){me.listen2(id,query,callbackArg);},pollListenDelay);
                        }
                    }
                }
            );
        },

        pause: function(id) {
            listenerData[id].listening = false;
        },

        resume: function(id) {
            listenerData[id].listening = true;
            this.listen2.apply(this, listenerData[id].args);
        },

        receive: function(channelArg,subChannelArg,versionArg,callbackArg){

            this.receive2(
                this.queryBuild(channelArg, subChannelArg, versionArg),
                callbackArg,
                (new Date()).getTime() + timeout
            );

        },

        receive2: function(query,callback,timeoutTicks){

            var me = this;

            messages.findAndRemove(
                query,
                [['_id', 1]],
                function(err,message){
                    if(err){
                        callback(err,null, null);
                    } else {
                        message = message.value;
                        if(message){
                            if(captureDeliveries){
                                deliverySave(message);
                            }
                            if (messageHasExpired(message)) {
                                me.send("Untimely", message.subChannel, message.version, false, message.body, message.returnTo);
                            } else {
                                callback(null, null, message);
                            }
                        } else {
                            if((new Date()).getTime() >= timeoutTicks){
                                callback(null, true, null);
                            } else {
                                var pollDelay = pollReceiveDelay;
                                if(query.channel == 'Long Worker Reply'){
                                    pollDelay = pollReceiveDelayLong;
                                }
                                setTimeout(function(){me.receive2(query,callback,timeoutTicks);},pollDelay);
                            }
                        }
                    }
                }
            );
        },

        /***
         * Send a message via the message bus
         * @param {String}      channelArg          The channel on which to send the message
         * @param {String}      subChannelArg       The sub-channel on which to send the message (used for regular expression filtering)
         * @param {String}      versionArg          The version of the component/channel to which to send the message
         * @param {Boolean}     autoSetReturnArg    True when the component is expecting a reply to the message (automatically sets the return address to this component)
         * @param {Object}      bodyArg             The body of the message
         * @param {Object}      returnToArg         Allows the returnTo message header to be set to a destination other than the requesting component. When a return to the requesting component is desired the ReplyExpected argument should be used as that sets the correlation id.
         * @returns {String}    correlation         The message sequence, typically used for correlating message request and replies
         */
        send: function(channelArg, subChannelArg, versionArg, autoSetReturnArg, bodyArg, returnToArg){

            sequence++;

            var correlation = component + "-" + sequence;

            var message = {
                channel: channelArg,
                subChannel: subChannelArg,
                version: versionArg,
                sequence: sequence,
                sent: new Date(),
                expires: new Date((new Date()).getTime() + timeout),
                body: bodyArg
            };

            if(returnToArg){
                message.returnTo = returnToArg;
            }

            if(autoSetReturnArg){
                message.returnTo = {
                    channel: component,
                    subChannel: correlation,
                    version: versionExtended
                };
            }

            if(captureDeliveries){
                message.history = [{
                    component: component,
                    version: versionExtended,
                    sequence: sequence,
                    timestamp: (new Date())
                }];
            }

            if( separateProblems && (channelArg == 'Invalid' || channelArg == 'Dead' || channelArg == 'Untimely')){
                problems.insertOne(message,function(err/*,result*/){
                    if(err){
                        log.write('messageBus', 32, "Unable to write to channel '" + channelArg + "' due to the following error: " + err.message);
                    }
                });

            } else {
                messages.insertOne(message,function(err/*,result*/){
                    if(err){
                        log.write('messageBus', 32, "Unable to write to channel '" + channelArg + "' due to the following error: " + err.message);
                    }
                });
            }

            return correlation;
        }
    };
})();

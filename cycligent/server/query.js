/**@type {Authorize}*/ var authorize = require('../../cycligent/server/authorize.js');
/**@type {CycligentMongo}*/ var cycligentMongo = require('./cycligentMongo.js');
var mongodb = require('mongodb');
var dottedNameHandler = require('./utils.js').dottedNameHandler;

module.exports = {
    process: process,
    mapSet: mapSet,
    findPotentialDuplicates: findPotentialDuplicates,
    removeDuplicates: removeDuplicates
};

var map;

function mapSet(mapValue) {
    map = mapValue;
}

/**
 * Using the extended JSON specification here: http://docs.mongodb.org/manual/reference/mongodb-extended-json/
 * it recurses into the data, and turns extended JSON structures into the appropriate JavaScript objects.
 *
 * It also supports an extra piece, $hotTranTime: 1, which will set that field to the current server time,
 * minus the interval and the timeShift.
 *
 * @param {Object} data
 * @param {Number} timeShift
 * @param {Number} interval
 * @returns {String|Null}
 */
function recurseFillingExtendedJSON(data, timeShift, interval) {
    for (var field in data) {
        if (data.hasOwnProperty(field)) {
            if (field == "$where") {
                return "An cycligentQuery was received that contained a $where clause.";
            }
            var value = data[field];
            if (typeof value == "object" && value != null) {
                try {
                    var keys = Object.keys(value);
                    var numberOfKeys = keys.length;
                    if (numberOfKeys == 2 && contains(keys, "$binary") && contains(keys, "$type")) {
                        data[field] = new mongodb.Binary(value["$binary"], value["$type"]);
                    } else if (numberOfKeys == 1 && contains(keys, "$date")) {
                        data[field] = new Date(value["$date"]);
                    } else if (numberOfKeys == 1 && contains(keys, "$timestamp")) {
                        var timestamp = value["$timestamp"];
                        data[field] = new mongodb.Timestamp(timestamp.t, timestamp.i);
                    } else if (numberOfKeys == 2 && contains(keys, "$regex") && contains(keys, "$options")) {
                        data[field] = new RegExp(value["$regex"], value["$options"])
                    } else if (numberOfKeys == 1 && contains(keys, "$oid")) {
                        data[field] = new mongodb.ObjectID(value["$oid"]);
                    } else if (numberOfKeys == 2 && contains(keys, "$ref") && contains(keys, "$id")) {
                        data[field] = new mongodb.DBRef(value["$ref"], value["$id"]);
                    } else if (numberOfKeys == 1 && contains(keys, "$undefined")) {
                        // The undefined type might be depreciated, so we'll use this.
                        // Alternatively, {$type: 6} might apply, but that's noted as depreciated in some docs, and removed
                        // in other docs.
                        data[field] = undefined;
                    } else if (numberOfKeys == 1 && contains(keys, "$minKey")) {
                        data[field] = new mongodb.MinKey();
                    } else if (numberOfKeys == 1 && contains(keys, "$maxKey")) {
                        data[field] = new mongodb.MaxKey();
                    } else if (numberOfKeys == 1 && contains(keys, "$hotTranTime")) {
                        data[field] = new Date(Date.now() - timeShift - interval);
                    } else {
                        var err = recurseFillingExtendedJSON(value, timeShift, interval);
                        if (err)
                            return err;
                    }
                } catch (ex) {
                    return "An error occurred while trying to parse extended JSON for an cycligentQuery call. Error message was: " + ex.message;
                }
            }
        }
    }

    return null;

    function contains(array, what) {
        return array.indexOf(what) != -1;
    }
}

function process(state, callback) {
    var queryOptions = dottedNameHandler(state.rootName, state.post.id, state.post.location, map);

    state.target = {
        target: "cycligentQuery",
        request: state.post.request,
        id: state.post.id,
        criteria: JSON.parse(JSON.stringify(state.post.criteria)), // Copy the criteria so if/when the criteria gets changed, what the client requested still gets returned to it.
        items: [],

        status: null,
        // These below will be removed before being sent to the client if they are not set to value.
        nextHotTranTime: null,
        futureDuplicates: null,
        // The below will be removed before being sent to the client.
        database: null,
        collection: null,
        query: null,
        context: null,
        path: null,
        dbOptions: null,
        timeShift: null
    };
    state.targets.push(state.target);

    if(!queryOptions || (queryOptions.testUsersOnly && !state.testUser)) {
        state.error('Unrecognized query "' + state.post.id + '" was requested and ignored.');
        state.target.status = "error";
        executeCallback();
        return;
    }

    var now = Date.now();
    var index;
    state.target.database = queryOptions.database;
    state.target.collection = queryOptions.collection;
    state.target.path = queryOptions.path; // path is a required field.
    state.target.dbOptions = queryOptions.dbOptions || {};
    state.target.dbOptions = JSON.parse(JSON.stringify(state.target.dbOptions)); // Copy the options so modifications don't cause strange things to happen.
    state.target.timeShift = queryOptions.timeShift || 250;
    if (queryOptions.context === undefined) {
        state.target.context = queryOptions.collection;
    } else {
        state.target.context = queryOptions.context;
    }
    state.target.status = queryOptions.defaultStatus || "success";
    if (queryOptions.queryDefault) {
        state.target.query = JSON.parse(JSON.stringify(queryOptions.queryDefault));
        for (index in state.post.criteria) {
            if (state.post.criteria.hasOwnProperty(index)) {
                state.target.query[index] = state.post.criteria[index];
            }
        }
    } else {
        state.target.query = state.post.criteria;
    }
    if (queryOptions.queryOverride) {
        var overrideCopy = JSON.parse(JSON.stringify(queryOptions.queryOverride));
        for (index in overrideCopy) {
            if (overrideCopy.hasOwnProperty(index)) {
                state.target.query[index] = overrideCopy[index];
            }
        }
    }

    if (state.target.path) {
        if (!authorize.isAuthorized(state.user, 'functions', state.target.path)) {
            state.target.status = "unauthorized";
            executeCallback();
            return;
        }
    }

    var err = recurseFillingExtendedJSON(state.target.query, state.target.timeShift, state.post.interval);
    if (err) {
        state.error(err);
        state.target.status = "error";
        state.target.error = err;
        executeCallback();
        return;
    }

    if (state.post.useLongPolling) {
        var intervalLowerLimit = 50;
        if (queryOptions.intervalLowerLimit !== undefined) {
            intervalLowerLimit = queryOptions.intervalLowerLimit;
        }
        var interval = Math.max(intervalLowerLimit, state.post.interval);
        var timeLimit = Date.now() + state.post.timeout;
        timeLimit -= Math.max(3000, interval); // Subtracting 3000 to give us some time to return to the client.
    }

    // Ensure that we are receiving the hotTranTime and hotTranSeq fields from the queries.
    if (state.post.hotCaching && state.target.dbOptions.fields) {
        var fields = state.target.dbOptions.fields;
        var someRandomField = Object.keys(fields)[0];
        if (fields[someRandomField] == 1) { // They are including fields.
            fields['hotTranTime'] = 1;
            fields['hotTranSeq'] = 1;
        } else if (fields[someRandomField] == 0) { // They are excluding fields.
            if (fields['hotTranTime'] == 0)
                delete fields['hotTranTime'];
            if (fields['hotTranSeq'] == 0)
                delete fields['hotTranSeq'];
        }
    }

    var fetches = 0;
    var totalTime = 0;
    var startTime;

    if (queryOptions.preFetch) {
        queryOptions.preFetch(state, fetch);
    } else {
        fetch();
    }

    function fetch() {
        if (state.target.status != "success") {
            executeCallback();
            return;
        }

        state.target.dbOptions.limit = state.post.limit;
        state.target.dbOptions.skip = state.post.skip;

        fetches++;
        startTime = Date.now();
        if (state.target.context !== null) {
            cycligentMongo.docsFindAuthorized(state, state.target.database, state.target.collection, state.target.query,
                state.target.context, state.target.dbOptions, failure, success);
        } else {
            cycligentMongo.docsFind(state, state.target.database, state.target.collection, state.target.query,
                state.target.dbOptions, failure, success);
        }

        function failure() {
            totalTime += (Date.now() - startTime);
            state.target.status = "error";
            executeCallback();
        }

        function success(docs) {
            totalTime += (Date.now() - startTime);
            if (state.post.useLongPolling && docs.length == 0 && Date.now() <= timeLimit) {
                setTimeout(function() {
                    if (Date.now() <= timeLimit) {
                        fetch();
                    } else {
                        postFetch();
                    }
                }, interval);
            } else {
                state.target.items = docs;
                postFetch();
            }
        }
    }

    function postFetch() {
        if (state.post.hotCaching) {
            removeDuplicates(state.target.items, state.post.duplicates);
            state.target.futureDuplicates = findPotentialDuplicates(state.target.items, state.target.nextHotTranTime);
            state.target.nextHotTranTime = now - state.target.timeShift;
        }

        if (queryOptions.postFetch) {
            queryOptions.postFetch(state, executeCallback);
        } else {
            executeCallback();
        }
    }

    function executeCallback() {
        // We add the timings ourselves, because simply using state.timerStart and state.timerStop
        // would fill the response with a ton of timings when using longPolling.
        if (state.post.useLongPolling) {
            state.timingAdd(state.post.id + " (average)", totalTime / fetches);
            state.timingAdd(state.post.id + " (total)", totalTime);
        } else {
            state.timingAdd(state.post.id, totalTime);
        }
        // Remove fields we don't need to send back to the client.
        delete state.target.database;
        delete state.target.collection;
        delete state.target.query;
        delete state.target.context;
        delete state.target.path;
        delete state.target.dbOptions;
        delete state.target.timeShift;
        if (state.target.futureDuplicates === null)
            delete state.target.futureDuplicates;
        if (state.target.nextHotTranTime === null)
            delete state.target.nextHotTranTime;
        callback(state);
    }
}

/**
 * Given an array of documents, and a map between their _id and hotTranSeq numbers,
 * remove all documents from the array that are in the map, if their hotTranSeq number
 * is still the same.
 *
 * @param {Object[]} docs The array of documents we pulled out of the database.
 * @param {Object} duplicates The duplicates map produced by the findPotentialDuplicates function.
 */
function removeDuplicates(docs, duplicates) {
    if (!duplicates) {
        return;
    }
    for (var i = docs.length - 1; i >= 0; i--) { // Iterate in reverse so splicing doesn't throw us off.
        var doc = docs[i];
        var dupeSequence = duplicates[doc._id];
        if (dupeSequence !== undefined) {
            if (((doc.hotTranSeq === undefined && dupeSequence === null) // Because we change undefined to null below for JSON.
                || (doc.hotTranSeq !== undefined && doc.hotTranSeq === dupeSequence))) {
                docs.splice(i, 1);
            }
        }
    }
}

/**
 * Given the nextHotTranTime, look and see which documents we have that will
 * be duplicated in the next hot update fetch. Return a map that maps their
 * _ids to their hotTranSeq field, so we can compare them later. If their
 * hotTranSeq field is undefined, we set the value in the map to null.
 *
 * @param {Object[]} docs The array of documents we pulled out of the database.
 * @param {Date} nextHotTranTime The next
 * @returns {Object}
 */
function findPotentialDuplicates(docs, nextHotTranTime) {
    var bewareOfDuplicates = {};
    for (var i = 0; i < docs.length; i++) {
        var doc = docs[i];
        if (doc.hotTranTime >= nextHotTranTime) {
            if (doc.hotTranSeq !== undefined) {
                bewareOfDuplicates[doc._id] = doc.hotTranSeq;
            } else {
                bewareOfDuplicates[doc._id] = null;
            }
        }
    }
    return bewareOfDuplicates;
}
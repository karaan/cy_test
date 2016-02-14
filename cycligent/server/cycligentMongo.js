/**
 * Created with JetBrains WebStorm.
 * User: Frank
 * Date: 5/11/12
 * Time: 4:44 PM
 * To change this template use File | Settings | File Templates.
 */

/**@type {Logger}*/ var log = require("./log.js");
/**@type {Authorize}*/ var authorize = require('./authorize.js');


module.exports = CycligentMongo = {

    /**
     * Will find the documents matching the given query.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the documents you're trying to find.
     * @param {String} collection Name of the collection that has the documents you're trying to find.
     * @param {Object} query MongoDB query that will find the documents.
     * @param {Object} options Options to be passed to the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will be passed the found documents).
     */
    docsFind: function(state,db,collection,query,options,failure,success){

        argsProcess(arguments, function(state, db, collection, query, options, failure, success, mongoArgs){
            collection.find.apply(collection,mongoArgs.args).toArray(function(err,docs){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    success(docs);
                }
            });
        });
    },

    /**
     * Will find multiple documents filtering out those that have a path the user isn't authorized for.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the documents you're trying to find.
     * @param {String} collection Name of the collection that has the documents you're trying to find.
     * @param {Object} query MongoDB query to find the documents.
     * @param {String} context Context of the user's permission to access these documents.
     * @param {Object} options Options to pass to the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will be passed the found documents).
     */
    docsFindAuthorized: function(state,db,collection,query,context,options,failure,success){

        this.docsFind(state,db,collection,query,options,failure,function(docs){
            authorize.authorizedReduction(state.user,context,docs);
            success(docs);
        });
    },

    /**
     * Will find the document matching the given query.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the document you're trying to find.
     * @param {String} collection Name of the collection that has the document you're trying to find.
     * @param {Object} query Query to find the document.
     * @param {Object} options Options for the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will be passed the found document).
     */
    docFind: function(state, db, collection, query, options, failure, success){

        argsProcess(arguments, function(state, db, collection, query, options, failure, success, mongoArgs){
            collection.findOne.apply(collection, mongoArgs.call(function(err,doc){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    success(doc);
                }
            }));
        });

    },

    /**
     * Will find the document with the given ID.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the document you're trying to find.
     * @param {String} collection Name of the collection that has the document you're trying to find.
     * @param {String|ObjectID} id MongoDB ID of the document.
     * @param {Object} options Options to pass to the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will be passed the found document).
     */
    docFindById: function(state,db,collection,id,options,failure,success){

        if(!(id instanceof state.mongodb.ObjectID)){
            id = state.mongodb.ObjectID(id);
        }

        this.docFind(state,db,collection,{_id: id}, options, failure, success);
    },

    /**
     * Will find the document matching the query if the user has permission to access it.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the document you're trying to find.
     * @param {String} collection Name of the collection that has the document you're trying to find.
     * @param {Object} query MongoDB query to find the document.
     * @param {String} context Context of the user's permission to access this document.
     * @param {String} pathProperty Property of the document that acts as the authorization path. (will assume "/" is path if the authorization path isn't present)
     * @param {Object} options Options for the MongoDB driver.
     * @param {Function} failure Function called on failure (for example, if the user wasn't authorized).
     * @param {Function} success Function called on success (will be passed the found document, or null if it couldn't be found).
     */
    docFindAuthorized: function(state,db,collection,query,context,pathProperty,options,failure,success){

        if(typeof pathProperty != 'string'){
            success = failure;
            failure = options;
            options = pathProperty;
            pathProperty = 'path';
        }

        this.docFind(state,db,collection,query,options,failure,function(doc){
            if(doc == null || authorize.isAuthorized(state.user,context,(doc[pathProperty] || "/"))){
                success(doc);
            } else {
                state.error('User was not authorized for document');
                if(failure){
                    failure(state);
                }
            }
        });
    },

    /**
     * Will find the document with the given ID, if the user has permission to access it.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that has the document you're trying to find.
     * @param {String} collection Name of the collection that has the document you're trying to find.
     * @param {String|ObjectID} id MongoDB ID of the document.
     * @param {String} context Context of the user's permissions to this document.
     * @param {String} pathProperty Property of the document that acts as the authorization path.
     * @param {Object} options MongoDB driver options.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will be passed the found document).
     */
    docFindAuthorizedById: function(state,db,collection,id,context,pathProperty,options,failure,success){

        if(!(id instanceof state.mongodb.ObjectID)){
            id = state.mongodb.ObjectID(id);
        }

        this.docFindAuthorized(state,db,collection,{_id: id}, context, pathProperty, options, failure, function(doc) {
            if (doc == null) {
                state.error(state.errorLevels.warning, "Document we expected to find wasn't there.");
                failure(state);
            } else {
                success(doc);
            }
        });
    },

    /**
     * Will save a new document into the database, or update an existing one. (Though, due to what may be a bug in
     * the MongoDB driver, you can't use the update operators like $set and $inc).
     * @param {State} state Instance of the framework State class.
     * @param {String} dbName Name of the database you want to save the document into.
     * @param {String} collectionName Name of the collection you want to save the document into.
     * @param {Object} doc The document to save.
     * @param {Object} options Options to pass to the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success.
     */
    docSave: function(state,dbName,collectionName,doc,options,failure,success){
        argsProcess(arguments, function(state, db, collection, query, options, failure, success, mongoArgs){
            // In practice, mongoArgs.args contains only two things here: the doc and the options.
            var doc = mongoArgs.args[0];
            options = mongoArgs.args[1] || {};
            modAddToDoc(state, dbName, collectionName, doc);

            if (doc._id === undefined) { // Must be an insert.
                // TODO: 6. We'll want to confirm that docSave never gets called with an array, and then change this to insertOne:
                if (Array.isArray(doc)) {
                    console.error("cycligentMongo.docSave: You shouldn't be calling this with an array.");
                }
                collection.insert.apply(collection, mongoArgs.call(callback));
            } else { // Document has an _id, must be update/upsert
                options.upsert = true;
                var args = [
                    {_id: doc._id},
                    doc,
                    options,
                    callback
                ];

                collection.updateOne.apply(collection, args);
            }

            function callback(err,results){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    if(success){
                        var ops = results.ops;
                        if (Array.isArray(ops)) {
                            success(ops[0]);
                        } else {
                            success(results.result.n);
                        }
                    }
                }
            }
        });
    },

    /**
     * Will save a new document into the database with predefined _id field.
     * @param {State} state Instance of the framework State class.
     * @param {String} dbName Name of the database you want to save the document into.
     * @param {String} collectionName Name of the collection you want to save the document into.
     * @param {Object} doc The document to save.
     * @param {Object} options Options to pass to the MongoDB driver.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success.
     */
    docSaveById: function(state,dbName,collectionName,doc,options,failure,success){
        argsProcess(arguments, function(state, db, collection, query, options, failure, success, mongoArgs){
            modAddToDoc(state, dbName, collectionName, doc);
            // TODO: 6. We'll want to confirm that docSaveById never gets called with an array, and then change this to insertOne:
            if (Array.isArray(doc)) {
                console.error("cycligentMongo.docSaveById: You shouldn't be calling this with an array.");
            }
            collection.insert.apply(collection, mongoArgs.call(function(err,results){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    if(success){
                        success(results.ops[0]);
                    }
                }
            }));
        });
    },

    /**
     * Will update a document that matches the given query.
     * @param {State} state Instance of the framework State class.
     * @param {String} dbName Name of the database that the document is in.
     * @param {String} collectionName Name of the collection that the document is in.
     * @param {Object} query Query needed to find the document.
     * @param {Object} updates The updated object, or MongoDB operators (like $inc, $set, etc.)
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will receive the number of documents updated).
     */
    docUpdate: function(state,dbName,collectionName,query,updates,failure,success) {
        argsProcess(arguments, function(state,db,collection,query,updates,failure,success,mongoArgs){
            mongoArgs.push({safe: true});
            modAddToUpdate(state, dbName, collectionName, updates);
            collection.updateOne.apply(collection, mongoArgs.call(function(err,results){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    if(success){
                        success(results.result.n);
                    }
                }
            }));
        });
    },

    /**
     * Will update all documents that match the given query.
     * @param {State} state Instance of the framework State class.
     * @param {String} dbName Name of the database that the document is in.
     * @param {String} collectionName Name of the collection that the document is in.
     * @param {Object} query Query needed to find the document.
     * @param {Object} updates The updated object, or MongoDB operators (like $inc, $set, etc.)
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will receive the number of documents updated).
     */
    docsUpdate: function(state,dbName,collectionName,query,updates,failure,success) {
        argsProcess(arguments, function(state,db,collection,query,updates,failure,success,mongoArgs){
            mongoArgs.push({safe: true});
            modAddToUpdate(state, dbName, collectionName, updates);
            collection.updateMany.apply(collection, mongoArgs.call(function(err,results){
                if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                    if(success){
                        success(results.result.n);
                    }
                }
            }));
        });
    },

    /**
     * Will update a document that matches the given query, if the user is authorized to access it.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that the document is in.
     * @param {String} collection Name of the collection that the document is in.
     * @param {Object} query Query needed to find the document.
     * @param {Object} updates The updated object, or MongoDB operators (like $inc, $set, etc.)
     * @param {String} context Context with which the user is authorized to access this document.
     * @param {String} pathProperty Property of the document that acts as the authorization path.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will receive the number of documents updated).
     */
    docUpdateAuthorized: function(state,db,collection,query,updates,context,pathProperty,failure,success) {
        var me = this;
        me.docFindAuthorized(state, db, collection, query, context, pathProperty, {}, failure, function(doc) {
            if (doc == null) {
                state.error(state.errorLevels.errorDataCorruption, "Document we expected to find wasn't there.");
                failure(state);
            } else {
                me.docUpdate(state, db, collection, query, updates, failure, success);
            }
        });
    },

    /**
     * Will update all document that matches the given query, if the user is authorized to access it.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that the document is in.
     * @param {String} collection Name of the collection that the document is in.
     * @param {Object} query Query needed to find the document.
     * @param {Object} updates The updated object, or MongoDB operators (like $inc, $set, etc.)
     * @param {String} context Context with which the user is authorized to access this document.
     * @param {String} pathProperty Property of the document that acts as the authorization path.
     * @param {Function} failure Function called on failure.
     * @param {Function} success Function called on success (will receive the number of documents updated).
     */
    docsUpdateAuthorized: function(state,db,collection,query,updates,context,pathProperty,failure,success) {
        var me = this;
        me.docsFindAuthorized(state, db, collection, query, context, {}, failure, function(docs) {
            if (docs.length > 0) {
                var ids = docs.map(function(doc) { return doc._id; });
                query["_id"] = {$in: ids};
                me.docsUpdate(state, db, collection, query, updates, failure, success);
            } else {
                success(0);
            }
        });
    },

    /**
     * Will remove the document with the given ID.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that the document is in.
     * @param {String} collection Name of the collection that the document is in.
     * @param {String|ObjectID} id MongoDB ID of the document.
     * @param {String} context Context of the users permissions to this document.
     * @param {String} pathProperty Property of the document that acts as the authorization path.
     * @param {Object} options Options to pass to MongoDB
     * @param {Function} failure Function to call on failure.
     * @param {Function} success Function to call on success.
     */
    docRemoveAuthorizedById: function(state,db,collection,id,context,pathProperty,options,failure,success){

        if(!(id instanceof state.mongodb.ObjectID)){
            id = state.mongodb.ObjectID(id);
        }

        this.docRemoveAuthorized(state,db,collection,{_id: id}, context, pathProperty, options, failure, success);
    },

    /**
     * Will remove the document matching the query from the database.
     * @param {State} state Instance of the framework State class.
     * @param {String} db Name of the database that the document is in.
     * @param {String} collection Name of the collection the document is in.
     * @param {Object} query MongoDB query to find the document you want to remove.
     * @param {String} context Context of the user's permission to access the document.
     * @param {String} pathProperty Property of the document that acts as the autorization path.
     * @param {Object} options Options to be passed to the MongoDB driver.
     * @param {Function} failure Function to call on failure.
     * @param {Function} success Function to call on success (will be passed the number of removed documents).
     */
    docRemoveAuthorized: function(state,db,collection,query,context,pathProperty,options,failure,success){
        this.docFindAuthorized(state, db, collection, query, context, "path", {}, failure, function(document) {
            if (document == null) {
                success(0);
            } else {
                db = state.dbs[db];
                db.collection(collection, function(err, collection) {
                    if (state.noError(err, state.errorLevels.errorDataCorruption, failure)) {
                        collection.removeOne({_id: document._id}, options, function(err) {
                            if (state.noError(err, state.errorLevels.errorDataCorruption, failure)) {
                                success(1);
                            }
                        });
                    }
                });
            }
        });
    },

    /**
     * Will get a list of all collections in the given database.
     * @param {State} state Instance of the framework State class.
     * @param {String} dbName Database you want to get the list from.
     * @param {Function} failure Function to run on failure.
     * @param {Function} success Function to run on success (will receive an array of collection names).
     */
    collectionListNames: function(state, dbName, failure, success) {
        var db = state.dbs[dbName];
        db.listCollections({}).toArray(function(err,collections){
            if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                if (success) {
                    var listOfNames = [];
                    for (var i = 0; i < collections.length; i++) {
                        listOfNames.push(collections[i]["name"]);
                    }
                    success(listOfNames);
                }
            }
        });
    },

    argsProcess: argsProcess
};

function MongoArgs(){
    this.args = [];
}

MongoArgs.prototype.push = function(item){
    this.args.push(item);
};

MongoArgs.prototype.call = function(func){
    this.args.push(func);
    return this.args;
};

/**
 * Returns the fields for the modAt/modBy/modVersion handling.
 * Or, returns null if it's disabled for the given collection.
 * @param {State} state
 * @param {String} dbName
 * @param {String} collectionName
 * @returns {Object}
 */
function modGetFieldConfig(state, dbName, collectionName) {
    var collectionConfig = state.root.dbs[dbName].collectionConfig[collectionName];
    var enabledOnCollectionLevel = false;
    if (collectionConfig) {
        if (collectionConfig.modHandlingEnabled == false) {
            return null;
        } else {
            enabledOnCollectionLevel = true;
        }
    }
    var defaults = state.root.dbs[dbName].collectionConfigDefaults;
    if (!enabledOnCollectionLevel && !defaults.modHandlingEnabled)
        return null;
    var config = {
        modAtField: defaults.modAtField,
        modByField: defaults.modByField,
        modVersionField: defaults.modVersionField
    };
    if (collectionConfig) {
        if (collectionConfig.modAtField !== undefined)
            config.modAtField = collectionConfig.modAtField;
        if (collectionConfig.modByField !== undefined)
            config.modByField = collectionConfig.modByField;
        if (collectionConfig.modVersionField !== undefined)
            config.modVersionField = collectionConfig.modVersionField;
    }
    return config;
}

/**
 * Add modAt, modVersion, and modBy to a document
 * we're about to insert/update.
 * @param {State} state
 * @param {String} dbName
 * @param {String} collectionName
 * @param {Object} doc
 */
function modAddToDoc(state, dbName, collectionName, doc) {
    var config = modGetFieldConfig(state, dbName, collectionName);
    if (config == null) {
        doc.hotTranSeq = 0;
        doc.hotTranTime = new Date(); // TODO: 6. In the future, MongoDB will have a $currentDate operator, but not yet. Consider using that when it gets released.
        return;
    }
    if (config.modVersionField !== null)
        delveAndSetForDoc(doc, config.modVersionField, 0);
    if (config.modByField !== null)
        delveAndSetForDoc(doc, config.modByField, state.user._id);
    if (config.modAtField !== null)
        delveAndSetForDoc(doc, config.modAtField, new Date());
    doc.hotTranSeq = 0;
    doc.hotTranTime = new Date(); // TODO: 6. In the future, MongoDB will have a $currentDate operator, but not yet. Consider using that when it gets released.
}

/**
 * Add modAt, modVersion, and modBy to an update
 * we're about to perform.
 * @param {State} state
 * @param {String} dbName
 * @param {String} collectionName
 * @param {Object} update
 */
function modAddToUpdate(state, dbName, collectionName, update) {
    var config = modGetFieldConfig(state, dbName, collectionName);
    if (update.$set === undefined)
        update.$set = {};
    if (update.$inc === undefined)
        update.$inc = {};
    if (config == null) {
        update.$inc.hotTranSeq = 1;
        update.$set.hotTranTime = new Date(); // TODO: 6. In the future, MongoDB will have a $currentDate operator, but not yet. Consider using that when it gets released.
        return;
    }
    if (config.modVersionField !== null)
        delveAndSetForUpdate(update.$inc, config.modVersionField, 1);
    if (config.modByField !== null)
        delveAndSetForUpdate(update.$set, config.modByField, state.user._id);
    if (config.modAtField !== null)
        delveAndSetForUpdate(update.$set, config.modAtField, new Date());
    update.$inc.hotTranSeq = 1;
    update.$set.hotTranTime = new Date(); // TODO: 6. In the future, MongoDB will have a $currentDate operator, but not yet. Consider using that when it gets released.
}

/**
 * Given a document that is going to be inserted into the database,
 * set the given field, which is described by MongoDB dot notation.
 *
 * So "mod.By" would become {mod: {By: ?}}.
 *
 * This function will do nothing if there is already a value in the
 * place described by the field name.
 * @param {Object} doc
 * @param {String} field
 * @param {*} newVal
 */
function delveAndSetForDoc(doc, field, newVal) {
    var fieldsLeft = leftToGo(field, "");
    delveAndSet(doc, fieldsLeft, newVal);
}
module.exports.delveAndSetForDoc = delveAndSetForDoc;

/**
 * Given an update that is going to be applied to a document in
 * the database, set a certain association for an update, keeping
 * in mind the different ways the update could be specified (i.e.
 * the update could be setting an entire sub-document, and we need
 * to put our update in there, or we might just be able to use dot
 * notation to update the field.)
 *
 * Note that if a value already exists in the update, this function
 * will not overrwrite it.
 *
 * @param {Object} update The update object we're changing. Note that this isn't something like {$set: {a: 'b'} } it's
 * the object _within_ the $set, so {a: 'b'} is what you should pass to this function in that case.
 * @param {String} field
 * @param {*} newVal
 */
function delveAndSetForUpdate(update, field, newVal) {
    var fieldNamesToCheck = piecesOfFieldName(field);
    var fieldNameFound = null;
    var name;
    for (var i = 0; i < fieldNamesToCheck.length; i++) {
        name = fieldNamesToCheck[i];
        if (update[name] !== undefined) {
            fieldNameFound = name;
            break;
        }
    }

    if (fieldNameFound !== null) {
        update = update[fieldNameFound];
        var fieldsLeft = leftToGo(field, fieldNameFound);
        delveAndSet(update, fieldsLeft, newVal);
    } else {
        if (update[field] === undefined)
            update[field] = newVal;
    }
}
module.exports.delveAndSetForUpdate = delveAndSetForUpdate;


/**
 * Access nested fields in an object, and update a field to the
 * given value, if it's not already defined.
 *
 * It's important to note that this will create sub-objects. So if
 * you passed it {} as your object, and {"a", "b", "c"] as your
 * fields, it would end up creating {a: {b: {c: newVal}}}.
 *
 * @param {Object} obj
 * @param {String[]} fields
 * @param {*} newVal
 * @returns {Object}
 */
function delveAndSet(obj, fields, newVal) {
    if (fields.length == 0)
        return obj;

    var origObj = obj;
    var field;
    for (var i = 0; i < fields.length - 1; i++) {
        field = fields[i];
        if (obj[field] === undefined)
            obj[field] = {};
        obj = obj[field];
    }
    field = fields[fields.length-1];
    if (obj[field] === undefined)
        obj[field] = newVal;

    return origObj;
}
module.exports.delveAndSet = delveAndSet;

/**
 * This is a helper method for working with MongoDB dotted names.
 * It's easier to show how it works than describe.
 *
 * If given "a.b.c.d" it will return ["a.b.c.d", "a.b.c", "a.b", "a"].
 * @param {String} fieldName
 * @returns {String[]}
 */
function piecesOfFieldName(fieldName) {
    var split = fieldName.split(".");
    var initialLength = split.length;
    var names = [];
    for (var i = 0; i < initialLength; i++) {
        names.push(split.join("."));
        split = split.slice(0, split.length - 1);
    }
    return names;
}
module.exports.piecesOfFieldName = piecesOfFieldName;

/**
 * This is a helper method for working with MongoDB dotted names.
 * Given a dotted name, and the piece of the dotted name you've accessed
 * so far, it will return the rest of a dotted name split into array.
 *
 * So, if given "a.b.c.d" and "a.b", this function will return ["c", "d"].
 *
 * It will return an empty array if the strings match.
 *
 * @param {String} fieldName
 * @param {String} piece
 * @returns {String[]}
 */
function leftToGo(fieldName, piece) {
    return fieldName.slice(piece.length).split(".").filter(function(str) { return str != ""; });
}
module.exports.leftToGo = leftToGo;

/**
 * Handles grabbing the MongoDB collection and dealing with variations in arguments. This allows options, failure,
 * and success to be optional parameters.
 *
 * @param args List of arguments passed to the cycligentMongo call (order assumed to be [state, db, collection, query, options,
 * failure, success]) Variations supported:
 * [state, db, collection, query, options, failure, success]
 * [state, db, collection, query, options, success]
 * [state, db, collection, query, failure, success]
 * [state, db, collection, query, success]
 * [state, db, collection, query]
 * @param callback Called once we have the MongoDB collection, will be provided the following parameters: state, db,
 * collection, query, options, failure, success, mongoArgs. db and collection will be MongoDB database and collection
 * objects, mongoArgs can be used to apply the needed arguments to MongoDB calls.
 * Ex: collection.findOne.apply(collection, mongoArgs.call(function(err,doc){ ... }));
 */
function argsProcess(args, callback){

    var state = args[0];
    var db = args[1];
    var collection = args[2];
    var query = args[3];
    var options = undefined;
    var failure = undefined;
    var success = undefined;

    var mongoArgs = new MongoArgs();

    if(args[4]){
        if(args[4] instanceof Function){
            if(args[4]){
                if(args[5]){
                    failure = args[4];
                    success = args[5];
                } else {
                    success = args[4];
                }
            } else {
                success = args[5];
            }
        } else {
            options = args[4];
            if(args[5]){
                if(args[6]){
                    failure = args[5];
                    success = args[6];
                } else {
                    success = args[5];
                }
            } else {
                success = args[6];
            }
        }
    }

    mongoArgs.push(query);

    if(options){
        mongoArgs.push(options);
    }

    if(typeof db == 'string'){
        db = state.dbs[db];
    }

    if(!db){
        log.write('cycligentMongo',64,"Unable to access database '" + args[1] + "'.");
        if(failure){
            failure();
        }
        return;
    }

    if(typeof collection == "string"){
        db.collection(collection,function(err,collectionObject){
            if(state.noError(err, state.errorLevels.errorDataCorruption, failure)){
                collection = collectionObject;
                callback(state, db, collection, query, options, failure, success, mongoArgs);
            }
        });
    } else {
        callback(state, db, collection, query, options, failure, success, mongoArgs);
    }
}
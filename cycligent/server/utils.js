/**@type {Authorize}*/ var authorize = require('./authorize.js');

/**
 * Gets a handler out of the given map, avoids using eval as we were doing previously.
 *
 * @param {Object} map
 * @param {String} piecesOfHandler
 * @returns {Function|undefined}
 */
function getHandler(map, piecesOfHandler) {
    if (map == undefined)
        return undefined;

    piecesOfHandler = piecesOfHandler.split('.');

    var current = map;
    for (var i = 0; i < piecesOfHandler.length; i++) {
        current = current[piecesOfHandler[i]];
        if (current == undefined)
            return undefined;
    }
    return current;
}
exports.getHandler = getHandler;

function dottedNameSplit(name){
    var root = name.substring(0,name.indexOf("."));
    var rest = name.substring(name.indexOf(".") + 1);

    if(rest.length > 7 && rest.substring(0,7) == "server."){
        rest = rest.substring(7);
    }

    return {root: root, rest: rest};
}
exports.dottedNameSplit = dottedNameSplit;

exports.dottedNameHandler = function(currentAppRoot, dottedName, dottedLocation, map, mapOffset){

    var full;
    var split;
    var mapBase;

    //noinspection FallthroughInSwitchStatementJS
    switch(dottedName.substr(0,1)){
        case '.':   // HTML file (current window location) relative anchor
            split = dottedNameSplit(dottedLocation + dottedName.substr(1));
            break;

        case '^':    // Deploy directory anchor
            split = dottedNameSplit(dottedName.substr(1));
            break;

        case '/':   // Current application directory anchor
        case '@':   // Current application directory anchor
            split = dottedNameSplit(currentAppRoot + "." + dottedName.substr(1));
            break;

        default:
            split = dottedNameSplit(dottedName);
            // Is the root defined?
            if(!map[split.root]){
                // No, so handle it relative to the HTML file (current window location)
                split = dottedNameSplit(dottedLocation + dottedName);
            }
            break;
    }

    mapBase = map[split.root];

    if(mapBase){
        if(mapOffset){
            mapBase = mapBase[mapOffset];
        }
        return getHandler(mapBase, split.rest);
    }

    return undefined;
};

/**
 * This function performs three kinds of validation that are common to cycligentCall functions:
 * That the user is authorized to use the cycligentCall function, checking for the existence of fields in the data object, and
 * checking to see if certain fields contain a valid ObjectID.
 *
 * This function will convert the fields that need to be ObjectIDs into ObjectIDs, and takes
 * care of setting state.target.status and state.target.error.
 *
 * If this function returns false, meaning the data isn't valid, all you need to do is
 * call the callback.
 *
 * @param {State} state
 * @param {String} errorPrefix The prefix you want on your error messages, i.e. if this is "User update", all error
 * messages will start with "User update:"
 * @param {String} functionPath The function path make sure the user is authorized for. If you provide an empty string
 * or some other false-y value, the function authorization check will not be performed.
 * @param {Object} data The data you received from the client.
 * @param {Object} validateExistence An object that maps fields expected in the data object to error messages to
 * send back if that field isn't present. i.e. {name: "Please provide the user name."}
 * @param {Object} validateNotFalsy  An object that maps fields expected to be in the data object and to not be falsy to
 * error messages to send back if that field isn't present. i.e. {name: "Please provide the user name."}
 * In this context, a value is "falsy" if !value == true. (i.e. null, false)
 * @param {Object} validateObjectID An object that maps fields expected to be strings representing ObjectIDs in the
 * data object to error messages to send back if that field isn't present. i.e. {_id: "Please provide the user ID."}
 * If the value does represent an ObjectID, the value in the data object will be replaced with a proper ObjectID.
 * @returns {boolean} Returns true if the data is valid, false if it isn't.
 */
function validateData(state, errorPrefix, functionPath, data, validateExistence, validateNotFalsy, validateObjectID) {
    if (functionPath && !authorize.isAuthorized(state.user, "functions", functionPath)) {
        state.target.status = 'unauthorized';
        return false;
    }

    var field, errorMessage;
    for (field in validateExistence) {
        if (validateExistence.hasOwnProperty(field)) {
            errorMessage = validateExistence[field];
            if (data[field] == undefined) {
                errorMessage = errorPrefix + ": " + errorMessage;
                state.target.error = errorMessage;
                state.target.status = 'error';
                return false;
            }
        }
    }

    for (field in validateNotFalsy) {
        if (validateNotFalsy.hasOwnProperty(field)) {
            errorMessage = validateNotFalsy[field];
            if (!data[field]) {
                errorMessage = errorPrefix + ": " + errorMessage;
                state.target.error = errorMessage;
                state.target.status = 'error';
                return false;
            }
        }
    }

    for (field in validateObjectID) {
        if (validateObjectID.hasOwnProperty(field)) {
            errorMessage = validateObjectID[field];
            if (data[field] == undefined) {
                errorMessage = errorPrefix + ": " + errorMessage;
                state.target.error = errorMessage;
                state.target.status = 'error';
                return false;
            }

            try {
                data[field] = new state.mongodb.ObjectID(data[field]);
            } catch(e) {
                state.target.status = 'error';
                state.target.error = errorPrefix + ": Malformed ObjectID supplied for " + field + ".";
                return false;
            }
        }
    }

    return true;
}
exports.validateData = validateData;

/**
 * Check to see if there was an unauthorized error after a call to cycligentMongo.docUpdate, if so, set the status to
 * 'unauthorized'. If it's a different kind of error, set the status to 'error', and state.target.error to the
 * error message.
 *
 * This is meant to be used
 *
 * @param {State} state
 * @param {String} prefix The preix of the error message i.e. "Team edit". So if the error message was "Cannot find
 *   document", it would become "Team edit: cannot find document."
 */
function handleUnauthorized(state, prefix) {
    var error = state.errors[state.errors.length-1];
    if (error[0] == state.errorLevels.errorUserAffected) {
        state.target.status = "unauthorized";
    } else {
        state.target.status = "error";
        state.target.error = prefix + ": " + error[1];
    }
}
exports.handleUnauthorized = handleUnauthorized;

/**
 * Finds an item that has the given value in the given field.
 *
 * @param {String} field The field to check on each item in the array.
 * @param {*} value The value you're looking for in an item.
 * @param {Array} data The array of items we're searching through.
 * @param {Boolean} [convertToString] Pass true if you want to check whether the result of toString is equal, instead
 * of the values themselves. This is useful when you're trying to find something via ObjectID, where two different
 * instances won't be ==, but the result of calling toString on them will be ==.
 * @return {*} Will return null if we can't find any item that matches.
 */
function findItemByField(field, value, data, convertToString) {
    for(var index = 0; index < data.length; index++ ){
        if (convertToString && data[index][field].toString() == value.toString()) {
            return data[index];
        } else if(data[index][field] == value){
            return data[index];
        }
    }

    return null;
}

exports.findItemByField = findItemByField;

/**
 * Finds the index of an item that has the given value in the given field.
 * 
 * @param {String} field The field to check on each item in the array.
 * @param {*} value The value you're looking for in an item.
 * @param {Array} data The array of items we're searching through.
 * @param {Boolean} [convertToString] Pass true if you want to check whether the result of toString is equal, instead
 * of the values themselves. This is useful when you're trying to find something via ObjectID, where two different
 * instances won't be ==, but the result of calling toString on them will be ==.
 * @return {Number} Will return null if we can't find any item that matches.
 */
function findItemIndexByField(field, value, data, convertToString) {
    for(var index = 0; index < data.length; index++ ){
        if (convertToString && data[index][field].toString() == value.toString()) {
            return index;
        } else if(data[index][field] == value){
            return index;
        }
    }

    return null;
}
exports.findItemIndexByField = findItemIndexByField;

/**
 * Escape a string for use inside an HTML attribute.
 *
 * Based on OWASP ESAPI https://code.google.com/p/owasp-esapi-java/source/browse/trunk/src/main/java/org/owasp/esapi/codecs/HTMLEntityCodec.java

 * @param {String} str
 * @returns {String}
 */
function htmlAttributeEscape(str) {
    var result = "";
    for (var i = 0; i < str.length; i++) {
        var char = str[i];
        var charCode = char.charCodeAt(0);
        // Alphanumerics can pass through.
        if ((charCode >= 48 && charCode <= 57)
            || (charCode >= 65 && charCode <= 90)
            || (charCode >= 97 && charCode <= 122)) {
            result += char;
        // Illegal characters will be replaced with the Unicode Replacement Character.
        } else if ((charCode <= 31 && char != "\t" && char != "\n" && char != "\r")
            || (charCode >= 127 && charCode <= 159)) {
            result += "&#xfffd;";
        } else {
            result += "&#x" + charCode.toString(16) + ";";
        }
    }
    return result;
}
exports.htmlAttributeEscape = htmlAttributeEscape;
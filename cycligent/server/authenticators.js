var fs = require('fs');
var url = require('url');
var path = require('path');
var https = require('https');
var crypto = require('crypto');
var querystring = require('querystring');

var forge = require('node-forge');
var xmlCrypto = require('xml-crypto');
var xmlDOM = require('xmldom');
var passport = require('passport');

var PassportLocalStrategy = require('passport-local').Strategy;
var PassportGoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
var PassportFacebookStrategy = require('passport-facebook').Strategy;
var PassportGitHubStrategy = require('passport-github').Strategy;

var ActiveDirectory; // We load this on demand since it includes a compiled module and could fail.

var config, cycligent, users, utils;
process.nextTick(function() {
    config = require('./configProcess.js');
    cycligent = require('./cycligent.js');
    users = require('./users.js');
    utils = require('./utils.js');
});

var helpers = {};
exports.helpers = helpers;
exports.providerNames = function providerNames() {
    return Object.keys(helpers);
};

var passportInitialize = passport.initialize();
var passportRedirectHelper = function(state, redirectURL) {
    var parsed = url.parse(redirectURL, true);
    // This will handle OpenID and OAuth, other authentication methods will likely require their own modifications.
    var returning;
    if (parsed.query['openid.return_to']) { // OpenID
        returning = url.parse(parsed.query['openid.return_to'], true);
        returning.query.requestWas = encodeURIComponent(state.request.url);
        delete returning.search;
        parsed.query['openid.return_to'] = url.format(returning);
    } else if (parsed.query['redirect_uri']) { // OAuth
        parsed.query['state'] = 'requestWas:' + encodeURIComponent(state.request.url);
    }
    delete parsed.search;
    redirectURL = url.format(parsed);
    state.response.writeHead(302, {
        'Content-Type': 'text/html;charset=utf-8',
        'Location': redirectURL
    });
    state.response.end("<html><body><p>Redirecting you to the authenticator...</p></body></html>");
};
exports.passportRedirectHelper = passportRedirectHelper;

/**
 * Authenticate using passportjs.
 *
 * @param {State} state The State object for the current request.
 * @param {Object} options Options to pass to passport.authenticate.
 * @param {Function} [noUserHandler] Function to call if error occurred, but no user was authenticated
 * (some authenticators might want to provide a custom redirect.) This function will receive the State object.
 */
function passportAuthenticate(state, options, noUserHandler) {
    var authenticator = state.authenticatorConfig.authenticatorName;
    var res = state.response;
    var req = state.request;

    state.response.redirect = passportRedirectHelper.bind(this, state);
    // This is kind of a hack, because authenticators sometimes need access to state, but passport doesn't give us an
    // easy way to pass it along.
    state.request.state = state;

    passportInitialize(req, res, function() {
        passport.authenticate(authenticator, options, function(err, user) {
            delete state.request.state;
            if (user) {
                redirectAfterSuccessfulLogin(state, user._id);
            } else {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
                    res.end("<html><body><p>An error occurred while trying to authenticate you.</p></body></html>");
                    var message = ".";
                    if (err.message)
                        message = ", message was: '" + err.message + "'";
                    state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to authenticate a user" + message);
                } else {
                    if (noUserHandler) {
                        noUserHandler(state);
                    } else {
                        res.writeHead(403, {'Content-Type': 'text/html;charset=utf-8'});
                        res.write("<html><body>");
                        res.write("<p>We were unable to authenticate you.</p>");
                        res.end("</body></html>");
                    }
                }
            }
        })(req, res, function(err) {
            delete state.request.state;
            if (err) {
                respondWithError(state, "<html><body><p>An error occurred while trying to authenticate you.</p></body></html>", err);
            } else {
                // As far as I can tell, we'll never reach this bit of code...
                // But this logic branch is too obvious to not cover with some sort of response, just in case I'm wrong.
                res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
                res.end("<html><body><p>An unexpected condition occurred during sign-on.</p></body></html>");
                state.error("Sign On", state.errorLevels.errorUserAffected, "An unexpected condition occurred during sign-on.");
            }
        });
    });
}
exports.passportAuthenticate = passportAuthenticate;

function respondWithError(state, messageForUser, err) {
    state.response.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
    state.response.end(messageForUser);
    var message = ".";
    if (err.message)
        message = ", message was: '" + err.message + "'";
    state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to authenticate a user" + message);
}

/**
 * Handle sign-on using authentication providers that are handled via passportjs.
 * @param {State} state
 * @param {Object} options Options to pass to passport.authenticate.
 * @param {Function} [noUserHandler] Function to call if error occurred, but no user was authenticated
 */
function signOnPassport(state, options, noUserHandler) {
    var req = state.request;

    // passport assumes the request will have a 'body' field containing the post info.
    if (typeof state.requestData != "string") {
        req.body = querystring.parse(state.parsedUrl.query);
        req.query = req.body;
    } else {
        req.body = querystring.parse(state.requestData);
        req.query = req.body;
    }
    passportAuthenticate(state, options, noUserHandler);
}
exports.signOnPassport = signOnPassport;

/**
 * Completes the request by sending the user a form that they can use to sign on.
 *
 * @param {State} state
 * @param {Boolean} [failure]
 * @param {String} [failMsg] Custom message to display on failure.
 */
function displayLoginForm(state, failure, failMsg) {
    var res = state.response;
    var auth = state.authenticatorConfig;
    var loginForm = auth.loginPage;

    fs.readFile(loginForm, "utf8", function(err, loginHTML) {
        if (err) {
            res.writeHead(500, {'Content-Type': 'text/html;charset=utf-8'});
            res.write("<html><body>");
            res.write("<p>Server was unable to read login form.</p>");
            res.end("</body></html>");
            state.error('Sign On', state.errorLevels.errorUserAffected, "Error occurred while trying to load login form: '" + loginForm + "', " + err.message);
        } else {
            var ext = path.extname(loginForm);
            var getType = state.root.getStaticTypes[ext];
            var attributes = cycligent.fileAnalyze(state, getType, ext.length, "/" + auth.loginPage);
            if (attributes.fileCallsPossible) {
                cycligent.fileCallsProcess(state, getType, loginHTML, function(state, getType, loginHTML) {
                    replaceAndServe(getType, loginHTML);
                });
            } else {
                replaceAndServe(getType, loginHTML);
            }
        }
    });

    function replaceAndServe(getType, loginHTML) {
        var query = url.parse(state.request.url, true).query;
        var message = "";
        var requestWas = "";
        if (failure) {
            failMsg = failMsg ||  "Either your username or password is incorrect, or you aren't registered in this system.";
            message = "<span style='color: red;'>Error: " + failMsg + "</span>";
        }
        if (query.requestWas)
            requestWas = query.requestWas;
        var statusCode = 200;
        if (failure)
            statusCode = 401;
        loginHTML = loginHTML.replace(/\{\{actionURL\}\}/g, utils.htmlAttributeEscape(state.request.url));
        loginHTML = loginHTML.replace(/\{\{message\}\}/g, message);
        loginHTML = loginHTML.replace(/\{\{requestWas\}\}/g, utils.htmlAttributeEscape(requestWas));
        cycligent.fileServe(state, getType, loginHTML, statusCode);
    }
}
exports.displayLoginForm = displayLoginForm;

/**
 * Handle Azure sign-on.
 *
 * This receives the token that identifies the user, validate it, and then send back a cookie if successful.
 *
 * @param {State} state
 */
function signOnAzure(state) {
    var res = state.response;

    if (typeof state.requestData != "string") { // No requestData, they must've hit /signOn directly.
        helpers['azure'].redirect(state);
        return;
    }

    try {
        var xml = querystring.parse(state.requestData).wresult;
        var doc = new xmlDOM.DOMParser().parseFromString(xml);
        var valid = azureTokenIsValid(state, doc, xml);

        if (valid) {
            var email = xmlCrypto.xpath(doc, "//*[local-name(.)='Attribute' and @Name='http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']/*[local-name(.)='AttributeValue']/text()").toString();
            var query = querystring.parse(state.request.url.split('?')[1]);

            cycligent.userCookieCreateAndSend(state, email, 'authenticatedUser', '_CYC_AUTH_', query.requestWas);
        } else {
            res.writeHead(403, {'Content-Type': 'text/html;charset=utf-8'});
            res.write("<html><body>");
            res.write("<p>We were unable to parse your Windows Azure credentials.</p>");
            res.end("</body></html>");
        }
    } catch(e) {
        res.writeHead(502, {'Content-Type': 'text/html;charset=utf-8'});
        res.write("<html><body>");
        res.write("<p>Windows Azure returned an unexpected response while trying to verify your credentials.</p>");
        res.end("</body></html>");
    }
}
exports.signOnAzure = signOnAzure;

/**
 * Given an Azure security token, check to see if it's valid.
 *
 * It's possible an ill-formed token could make this function throw an error,
 * so you may want to wrap the call to this in a try-catch block.
 *
 * @param {State} state
 * @param {Document} doc The XML parsed document that is the security token.
 * @param {String} xml The XML document as a string.
 * @returns {Boolean} Returns true if it is valid, false if it isn't.
 */
function azureTokenIsValid(state, doc, xml) {
    // Create XML parsing and validating objects.
    var authenticator = state.authenticatorConfig;
    if (authenticator.certificate != getRawCertificate(doc)) {
        return false;
    }

    var certificate = getCertificate(doc);
    var signature = xmlCrypto.xpath(doc, "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']")[0];
    var signedXml = new xmlCrypto.SignedXml();
    signedXml.keyInfoProvider = {
        getKeyInfo: function() {
            return "<X509Data></X509Data>";
        },
        getKey: function () {
            return certificate;
        }
    };
    signedXml.loadSignature(signature.toString());
    // Actually validate the XML.
    if (!signedXml.checkSignature(xml))
        return false;

    // Check that the token is valid for the current time.
    var conditions = xmlCrypto.xpath(doc, localNames("RequestedSecurityToken", "Conditions"))[0];
    var notBefore = new Date(conditions.getAttribute("NotBefore"));
    var notOnOrAfter = new Date(conditions.getAttribute("NotOnOrAfter"));
    // Allow for possible clock skew.
    notBefore.setMinutes(notBefore.getMinutes()-5);
    notOnOrAfter.setMinutes(notOnOrAfter.getMinutes()+5);

    var now = new Date();
    if (now < notBefore || now >= notOnOrAfter)
        return false;

    // All of the above checks passed, so return true.
    return true;

    function split64(str) {
        return str.match(/.{1,64}/g).join("\n");
    }

    function localNames() {
        var result = "";
        for (var i = 0; i < arguments.length; i++) {
            var name = arguments[i];
            result += "//*[local-name(.)='" + name + "']";
        }
        return result;
    }

    function getRawCertificate(doc) {
        return xmlCrypto.xpath(doc, localNames("RequestedSecurityToken", "X509Certificate") + "/text()").toString();
    }

    function getCertificate(doc) {
        var cert = getRawCertificate(doc);
        cert = "-----BEGIN CERTIFICATE-----\n" + split64(cert) + "\n-----END CERTIFICATE-----\n";
        return cert;
    }
}
exports.azureTokenIsValid = azureTokenIsValid;

function redirectToLoginForm(state) {
    var auth = state.authenticatorConfig;
    state.response.writeHead(302, {
        'Content-Type': 'text/html;charset=utf-8',
        'Location': '/' + state.rootName + '/' + auth.signOnURL + '?requestWas=' + encodeURIComponent(state.request.url)
    });
    state.response.write("<html><body>");
    state.response.write("<p>You aren't authorized to access this page.</p>");
    state.response.end("</body></html>");
}

function redirectAfterSuccessfulLogin(state, user_id) {
    user_id = user_id.toLowerCase();

    var auth = state.authenticatorConfig;
    if (auth.userCheckBeforeRedirect) {
        userFetch(state, user_id, function(err, user) {
            if (err) {
                respondWithError(state, "<html><body><p>An error occurred while trying to authenticate you.</p></body></html>", err);
            } else if (user == false) {
                if (auth.authenticatedUserAddIfMissing) {
                    userAdd(state, user_id, function(err) {
                        if (err) {
                            var res = state.response;
                            res.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                            res.write("<html><body>");
                            res.write("<p>We were able to authenticate you, but there was an error registering you. Please contact your system administrator.</p>");
                            res.end("</body></html>");
                        } else {
                            sendCookieAndRedirect();
                        }
                    });
                } else {
                    var res = state.response;
                    res.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                    res.write("<html><body>");
                    res.write("<p>We were able to authenticate you, but you are not registered in this system.</p>");
                    res.end("</body></html>");
                }
            } else {
                sendCookieAndRedirect();
            }
        });
    } else {
        sendCookieAndRedirect();
    }

    function sendCookieAndRedirect() {
        var req = state.request;
        var redirectTo = state.root.defaultDoc;
        if (req.query.state && req.query.state.indexOf('requestWas:') == 0) { // OAuth
            redirectTo = req.query.state.slice(11);
        } else if (req.query.requestWas) { // OpenID (or possibly something else)
            redirectTo = req.query.requestWas;
        }
        if (redirectTo == "/" + state.rootName + "/" + auth.signOnURL) { // Prevent a redirect loop.
            redirectTo = state.root.defaultDoc;
        }
        redirectTo = decodeURIComponent(redirectTo);
        cycligent.userCookieCreateAndSend(state, user_id, 'authenticatedUser', '_CYC_AUTH_', redirectTo);
    }
}

function justSendCookieAfterSuccessfulLogin(state, user) {
    cycligent.userAuthorizationTokenCreateAndSave(state, user._id, 'authenticatedUser', function(err, authorizationToken) {
        var res = state.response;
        if (err) {
            res.writeHead(500, {
                'Content-Type': 'text/html;charset=utf-8'
            });
            res.write("<html><body>");
            res.write("<p>An error occurred while creating the cookie.</p>");
            res.end("</body></html>");
        } else {
            var cookiePath;
            if (state.root.cookiePath) {
                cookiePath = state.root.cookiePath;
            } else {
                cookiePath = '/' + state.rootName;
            }
            var cookie = cycligent.userCookieCreate(user._id, user.roleCurrent, '_CYC_AUTH_', authorizationToken,
                cookiePath, state.request.https);
            res.writeHead(200, {
                'Content-Type': 'text/html;charset=utf-8',
                'Set-Cookie': cookie
            });
            res.write("<html><body>");
            res.write("<p>Successful Service Access Granted.</p>");
            res.end("</body></html>");
        }
    });
}

function userFetch(state, username, callback) {
    username = username.toLowerCase();
    var sessionDb;

    for(var db in state.root.dbs){
        if (state.root.dbs.hasOwnProperty(db)) {
            if(state.root.dbs[db].sessionDb){
                sessionDb = config.dbs[state.root.dbs[db]["authenticatedUser"]].db;
            }
        }
    }

    if(sessionDb){
        sessionDb.collection('users',function(err, collection){
            if(err){
                callback(err, false);
            } else {
                collection.find({_id: username, active: true}).toArray(function(err,results){
                    if(err){
                        callback(err, false);
                    } else {
                        if(results.length == 0){ // No user found!
                            callback(null, false);
                        } else {
                            if(results.length == 1){ // The user exists!
                                var user = results[0];
                                callback(null, user);
                            } else {
                                callback(new Error("Duplicate user records found for: " + username + "."), false);
                            }
                        }
                    }
                });
            }
        });
    } else {
        callback(null, false);
    }
}

function userAdd(state, user_id, callback) {
    var sessionDb;

    for(var db in state.root.dbs){
        if (state.root.dbs.hasOwnProperty(db)) {
            if(state.root.dbs[db].sessionDb){
                sessionDb = config.dbs[state.root.dbs[db]["authenticatedUser"]].db;
            }
        }
    }

    sessionDb.collection('users',function(err, collection){
        if(err){
            callback(err);
        } else {
            var userDoc = users.userDocGenerate(state, user_id, '', '', '/', 'admin@i3.io');
            collection.insertOne(userDoc, function(err) {
                if (err) {
                    callback(err);
                } else {
                    callback(null);
                }
            });
        }
    });
}

function userPasswordVerify(user, password, callback) {
    if (user.password == undefined || user.password == ""
        || user.passwordSalt == undefined || user.passwordSalt == "") {
        callback(null, false);
    } else {
        passwordHash(password, new Buffer(user.passwordSalt, "hex"), function(err, hash) {
            var hashString = hash.toString('hex');
            if (err) {
                callback(err, false);
            } else if (user.password == hashString) {
                callback(null, user);
            } else {
                callback(null, false);
            }
        });
    }
}

function userLoginLockUpdate(state, user, fieldsToUpdate, callback){
    // TODO: 5. We should also update the mod* fields (but they aren't consistent across projects.)
    var sessionDb;

    for(var db in state.root.dbs){
        if (state.root.dbs.hasOwnProperty(db)) {
            if(state.root.dbs[db].sessionDb){
                sessionDb = config.dbs[state.root.dbs[db]["authenticatedUser"]].db;
            }
        }
    }
    if(sessionDb){
        sessionDb.collection('users',function(err, collection){
            if(err){
                callback(err);
            } else {
                collection.updateOne({_id: user._id}, fieldsToUpdate, function(err) {
                    if(err) {
                        callback(err);
                    } else {
                        callback(false);
                    }
                });
            }
        });
    } else {
        callback(new Error("No Session DB was setup."));
    }
}

/**
 * Checks if the user is locked. If the user's lock has expired, this will remove the
 * "loginLockedAt" and "loginFailedAttempts" fields.
 *
 * This function does calls back immediately if auth.loginAttempts and auth.loginUnlockDelay
 * aren't set on the authenticator.
 *
 * @param {State} state
 * @param {User} user
 * @param {Function} callback Function called after checking if the user is locked.
 *  An error is the first argument (null if none), a Boolean indicating if the user is locked (true if locked,
 *  false otherwise) is the second argument, and the number of minutes the user is locked for is the third
 *  argument.
 */
function userIsLocked(state, user, callback) {
    var auth = state.authenticatorConfig;
    var fieldsToUpdate = {};

    if(auth.loginAttempts && auth.loginUnlockDelay && user.loginLockedAt)  {
        var lockedTime =  new Date() - user.loginLockedAt;
        if( lockedTime >= auth.loginUnlockDelay ){
            user.loginLockedAt = undefined;
            user.loginFailedAttempts = 0;
            fieldsToUpdate = {$unset: {loginLockedAt: "", loginFailedAttempts: ""}};
            userLoginLockUpdate(state, user, fieldsToUpdate, function(err){
                if(err) {
                    callback(err);
                } else {
                    callback(null, false);
                }
            });
        } else {
            callback(null, true, auth.loginUnlockDelay/(60*1000));
        }
    } else {
        callback(null, false);
    }
}

/**
 * Updates the "loginLockedAt" and "loginFailedAttempts" fields on the user based on whether or not
 * the login attempt was successful.
 *
 * This function does calls back immediately if auth.loginAttempts and auth.loginUnlockDelay
 * aren't set on the authenticator.
 *
 * @param {State} state
 * @param {User} user
 * @param {Boolean} userAuthenticated
 * @param {Function} callback Function called after updates are done. An error is the first argument (null if none),
 *  a Boolean indicating if the user is locked (true if locked, false otherwise) is the second argument, and the
 *  number of minutes the user is locked for is the third argument.
 */
function userUpdateLocks(state, user, userAuthenticated, callback) {
    var auth = state.authenticatorConfig;
    var fieldsToUpdate = {};
    if( auth.loginAttempts && auth.loginUnlockDelay ){
        if (userAuthenticated) {
            if (user.loginLockedAt || user.loginFailedAttempts > 0) {
                fieldsToUpdate = {$unset: {loginLockedAt: "", loginFailedAttempts: ""}};
                userLoginLockUpdate(state, user, fieldsToUpdate,function(err){
                    if(err) {
                        callback(err);
                    } else {
                        callback(null, false);
                    }
                });
            } else {
                callback(null, false);
            }
        } else {
            var loginFailedAttempts = (user.loginFailedAttempts || 0) + 1;
            var lockedOut = (loginFailedAttempts >= auth.loginAttempts);
            fieldsToUpdate = {$set: {loginFailedAttempts: loginFailedAttempts}};
            if (lockedOut) {
                fieldsToUpdate["$set"]["loginLockedAt"] = new Date();
            }
            userLoginLockUpdate(state, user, fieldsToUpdate,function(err) {
                if (err) {
                    callback(err);
                } else {
                    if (lockedOut) {
                        callback(null, true, auth.loginUnlockDelay / (60 * 1000));
                    } else {
                        callback(null, false);
                    }
                }
            });
        }
    } else {
        callback(null, false);
    }
}

helpers['local'] = {
    setup: function(authenticatorName) {
        passport.use(authenticatorName, new PassportLocalStrategy({passReqToCallback: true}, function(req, username, password, done) {
            username = username.toLowerCase();

            var state = req.state;
            userFetch(state, username, function(err, user) {
                if (err) {
                    done(err, false);
                } else {
                    // This branch became really complicated because of lockouts.
                    // It used to just be this: userPasswordVerify(user, password, done);
                    userIsLocked(state, user, function(err, locked, lockedMinutes) {
                        if (err) {
                            done(err, false);
                        } else if (locked) {
                            state.failMessage = 'You have exceeded maximum login attempts. Please wait ' + lockedMinutes + ' minutes for next login attempt.';
                            done(null, false);
                        } else {
                            userPasswordVerify(user, password, function(err, passwordCorrect) {
                                if (err) {
                                    done(err, passwordCorrect);
                                } else {
                                    userUpdateLocks(state, user, passwordCorrect, function(err, locked, lockedMinutes) {
                                        if (err) {
                                            done(err, passwordCorrect);
                                        } else if (locked) {
                                            state.failMessage = 'You have exceeded maximum login attempts. Please wait ' + lockedMinutes + ' minutes for next login attempt.';
                                            done(null, passwordCorrect);
                                        } else {
                                            done(null, passwordCorrect);
                                        }
                                    })
                                }
                            });
                        }
                    });
                }
            });
        }));
    },

    redirect: function(state) {
        passportAuthenticate(state, {}, redirectToLoginForm);
    },

    signOn: function(state) {
        if (state.request.method == "GET") {
            displayLoginForm(state);
        } else {
            if (typeof state.requestData == "string")
                state.requestData = state.requestData.replace("user_id", "username"); // Because passport will be expecting username.
            signOnPassport(state, {}, function() {
                displayLoginForm(state, true, state.failMessage);
            });
        }
    }
};

helpers['certificate'] = {
    setup: function(authenticatorName) {},

    redirect: redirectToLoginForm,

    /*
     state.post.action == "challengeGet" | "challengeRespond"
     state.post.user_id
     state.post.certificate_id
     state.post.challengeResponse = [1, 2, 3, ...] if state.post.action == "challengeRespond"
     */
    signOn: function(state) {
        var res = state.response;
        if (state.request.method != "POST") {
            displayLoginForm(state);
        } else {
            try {
                state.post = JSON.parse(state.requestData);
            } catch(e) {
                try {
                    state.post = querystring.parse(state.requestData);
                    // Parse the keys, since they will also be JSON values.
                    for (var index in state.post) {
                        state.post[index] = JSON.parse(state.post[index]);
                    }
                } catch(e) {
                    helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'jsonMalformed', 'Request contained malformed JSON.');
                    return;
                }
            }

            if (state.post.action != "challengeGet" && state.post.action != "challengeRespond") {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'actionInvalid', 'The action type was missing from the request, or was not a valid action.');
                return;
            }

            if (typeof state.post.user_id != "string") {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'userIncorrectType', 'The user_id mentioned in the request was of an incorrect type.');
                return;
            }

            if (typeof state.post.certificate_id != "string") {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'certificateIncorrectType', 'The certificate_id mentioned in the request was of an incorrect type.');
                return;
            }

            try {
                state.post.certificate_id = new state.mongodb.ObjectID(state.post.certificate_id);
            } catch(e) {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'certificateMalformed', 'The certificate_id mentioned in the request was malformed.');
                return;
            }

            if (state.post.action == "challengeRespond"
                && (!Array.isArray(state.post.challengeResponse)
                    || typeof state.post.challengeResponse[0] != "number")) {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'challengeResponseIncorrectType', 'The challengeResponse mentioned in the request was of an incorrect type.');
                return;
            }

            helpers['certificate'].certificateFetch(state, function(certificate) {
                helpers['certificate'][state.post.action](state, certificate);
            });
        }
    },

    certificateFetch: function(state, callback) {
        var res = state.response;
        certificateFetch(state, state.post.certificate_id, state.post.user_id, function(err, certificate) {
            if (err) {
                helpers['certificate'].returnWithErrorHelper(state, 500, "error", 'dbError', 'An error occurred while communicating with the database.');
                console.error("certificateFetch error:");
                console.error(err);
                return;
            }

            if (!certificate) {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error", 'certificateDoesNotExist', 'The specified certificate does not exist.');
                return;
            }

            callback(certificate);
        });
    },

    challengeGet: function(state, certificate) {
        var res = state.response;
        crypto.randomBytes(256, function(err, bytes) {
            if (err) {
                helpers['certificate'].returnWithErrorHelper(state, 500, "error", 'challengeGenerateError', 'An error occurred while generating the challenge.');
                console.error("challengeGet challengeGenerateError:");
                console.error(err);
                return;
            }

            certificateCollectionGet(state, function(err, collection) {
                if (err || !collection) {
                    helpers['certificate'].returnWithErrorHelper(state, 500, "error", 'challengeSaveError1', 'An error occurred while saving the challenge to the DB.');
                    console.error("challengeGet challengeSaveError1:");
                    console.error(err);
                    return;
                }

                var expires = new Date();
                expires.setTime(expires.getTime() + 1000 * 60 * 5); // Expires in 5 minutes.
                var byteArray = bytes.toJSON();
                // Return value of Buffer.toJSON() is different across nodejs versions:
                if (!Array.isArray(byteArray) && byteArray.data !== undefined) {
                    byteArray = byteArray.data;
                }
                var challenge = {expires: expires, body: byteArray};
                collection.updateOne({
                    _id: certificate._id
                }, {
                    $push: {challenges: challenge}
                }, function(err) {
                    if (err) {
                        helpers['certificate'].returnWithErrorHelper(state, 500, "error", 'challengeSaveError2', 'An error occurred while saving the challenge to the DB.');
                        console.error("challengeGet challengeSaveError2:");
                        console.error(err);
                    } else {
                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });
                        res.end(JSON.stringify({
                            status: 'success',
                            challenge: challenge
                        }));
                        helpers['certificate'].challengeExpiredRemove(state, certificate._id);
                    }
                });
            });
        });
    },

    challengeRespond: function(state, certificate) {
        var res = state.response;
        var challengeResponse = state.post.challengeResponse;
        var challenges = certificate.challenges;
        var publicKey;
        try {
            publicKey = forge.pki.publicKeyFromPem(certificate.publicKey);
        } catch(err) {
            helpers['certificate'].returnWithErrorHelper(state, 500, "error", 'challengeRespondCheckError', 'An error occurred while tying to check the challenge response.');
            console.error("challengeGet challengeRespondCheckError:");
            console.error(err);
            return;
        }

        var challengePassed = false;
        var now = new Date();
        var signature = new Buffer(challengeResponse).toString();

        for (var i = 0; i < challenges.length; i++) {
            var challenge = challenges[i];
            if (challenge.expires < now) {
                continue;
            }

            var md = forge.md.sha256.create();
            md.update(challenge.body.join(''), 'utf8');
            try {
                var isValidSignature = publicKey.verify(md.digest().bytes(), signature);
                if (isValidSignature) {
                    challengePassed = true;
                    break;
                }
            } catch(e) {} // We don't return an error here, because mis-matched keys will cause an error.
        }

        var expires;
        if (challengePassed && challenge) {
            expires = challenge.expires;
        }

        helpers['certificate'].challengeExpiredRemove(state, certificate._id);

        if (!challengePassed) {
            helpers['certificate'].returnWithErrorHelper(state, 401, "unauthorized",
                'unauthorized', 'You are not authorized.');
            return;
        }

        userFetch(state, state.post.user_id, function(err, user) {
            if (err) {
                helpers['certificate'].returnWithErrorHelper(state, 500, "error",
                    'challengeRespondUserFetchError', 'An error occurred while tying to fetch user data.');
                console.error("challengeGet challengeRespondUserFetchError:");
                console.error(err);
                return;
            }

            if (!user) {
                helpers['certificate'].returnWithErrorHelper(state, 400, "error",
                    'challengeRespondNoSuchUser', 'No such user exists.');
                return;
            }

            cycligent.userAuthorizationTokenCreateAndSave(state, user._id, 'authenticatedUser', function(err, authorizationToken) {
                var res = state.response;
                if (err) {
                    helpers['certificate'].returnWithErrorHelper(state, 500, "error",
                        'cookieCreationError', 'An error occurred while creating the cookie.');
                } else {
                    var cookiePath;
                    if (state.root.cookiePath) {
                        cookiePath = state.root.cookiePath;
                    } else {
                        cookiePath = '/' + state.rootName;
                    }
                    var cookie = cycligent.userCookieCreate(user._id, user.roleCurrent, '_CYC_AUTH_', authorizationToken,
                        cookiePath, state.request.https);
                    res.writeHead(302, {
                        'Content-Type': 'application/json',
                        'Set-Cookie': cookie,
                        'Location': '/control/client/markup-i3i.html'
                    });
                    res.end(JSON.stringify({
                        status: "success",
                        expires: expires
                    }));
                }
            });
        });
    },

    returnWithErrorHelper: function (state, httpStatus, jsonStatus, errorCode, error) {
        var res = state.response;

        if (state.request.headers['accept'] && state.request.headers['accept'].indexOf('application/json') != -1) {
            res.writeHead(httpStatus, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                status: jsonStatus,
                errorCode: errorCode,
                error: error
            }));
        } else {
            displayLoginForm(state, true, error);
        }
    },

    challengeExpiredRemove: function(state, certificate_id) {
        certificateCollectionGet(state, function(err, collection) {
            if (err || !collection) {
                console.error("challengeExpiredRemove collectionGet error:");
                console.error(err);
                return;
            }

            collection.updateOne({_id: certificate_id}, {
                $pull: {
                    challenges: {expires: {$lt: new Date()}}
                }
            }, function(err) {
                if (err) {
                    console.error("challengeExpiredRemove update error:");
                    console.error(err);
                }
            });
        });
    }
};

function certificateCollectionGet(state, callback) {
    var sessionDb;

    for(var db in state.root.dbs){
        if (state.root.dbs.hasOwnProperty(db)) {
            if(state.root.dbs[db].sessionDb){
                sessionDb = config.dbs[state.root.dbs[db]["authenticatedUser"]].db;
            }
        }
    }

    if (sessionDb) {
        sessionDb.collection(state.authenticatorConfig.certificateCollection,function(err, collection) {
            if (err) {
                callback(err, false);
            } else {
                callback(null, collection);
            }
        });
    } else {
        callback(null, false);
    }
}

function certificateFetch(state, certificate_id, user_id, callback) {
    user_id = user_id.toLowerCase();

    certificateCollectionGet(state, function(err, collection) {
        if (err || !collection) {
            callback(err, false);
            return;
        }

        collection.find({_id: certificate_id, user_id: user_id, active: true}).toArray(function(err,results){
            if(err) {
                callback(err, false);
            } else {
                if(results.length == 0) { // No certificate found!
                    callback(null, false);
                } else {
                    if(results.length == 1) { // The certificate exists!
                        var certificate = results[0];
                        if (certificate.expires && certificate.expires < new Date()) {
                            callback(null, false);
                        } else {
                            callback(null, certificate);
                        }
                    } else {
                        callback(new Error("Duplicate certificate records found for: " + certificate_id + "."), false);
                    }
                }
            }
        });
    });
}

helpers['multipleAuthenticatorsHelper'] = {
    setup: function(authenticatorName) {},

    redirect: function(state) {
        var res = state.response;
        var auth = state.authenticatorConfig;
        res.writeHead(302, {
            'Content-Type': 'text/html;charset=utf-8',
            'Location': '/' + auth.fileToServe + '?requestWas=' + encodeURIComponent(state.request.url)
        });
        res.write("<html><body>");
        res.write("<p>You are not currently signed on. Redirecting you to sign-on page.</p>");
        res.end("</body></html>");
    },

    signOn: function(state) {
        var params = querystring.parse(state.requestData);
        if (params.authenticator === undefined) {
            helpers['multipleAuthenticatorsHelper'].redirect(state);
        } else {
            if (params.requestWas && params.requestWas.trim() != "") {
                var requestWasParsed = url.parse(decodeURIComponent(params.requestWas));
                if (requestWasParsed.pathname == "/" + state.rootName + "/" + state.authenticatorConfig.signOnURL) {
                    state.pathname = state.root.defaultDoc;
                    state.request.url = state.root.defaultDoc;
                } else {
                    var hash = requestWasParsed.hash;
                    if (hash == null)
                        hash = "";
                    state.pathName = requestWasParsed.pathname;
                    state.request.url = requestWasParsed.path + hash;
                }
            } else {
                state.pathName = state.root.defaultDoc;
                state.request.url = state.root.defaultDoc;
            }

            var authenticatorName = params.authenticator;
            var authenticator = config.activeDeployment.authenticators[authenticatorName];

            if (authenticator === undefined || state.root.authenticators.indexOf(authenticatorName) == -1) {
                var res = state.response;
                res.writeHead(401, {'Content-Type': 'text/html;charset=utf-8'});
                res.write("<html><body>");
                res.write("<p>Unknown authenticator.</p>");
                res.end("</body></html>");
            } else {
                state.authenticatorConfig = authenticator;
                helpers[authenticator.provider].redirect(state);
            }
        }
    }
};

helpers['activeDirectory'] = {
    setup: function() {
        try {
            ActiveDirectory = require('activedirectory');
        } catch(e) {
            if (e.type == "notCompiled")
                e.message = "Active Directory support requires a working buffertools module, and " + e.message +
                    "\nYou'll need to go into Cycligent Server's node_modules and install it (cycligent/server/node_modules/activedirectory/node_modules/ldapjs/node_modules/buffertools).";
            throw new Error(e.message);
        }
    },
    redirect: redirectToLoginForm,
    signOn: function(state) {
        if (state.request.method == "GET") {
            displayLoginForm(state);
        } else {
            try {
                var parsedData = querystring.parse(state.requestData);
                if (typeof state.requestData != "string") {
                    parsedData = querystring.parse(state.parsedUrl.query);
                } else {
                    parsedData = querystring.parse(state.requestData);
                }
                var noRedirect = (querystring.parse(state.parsedUrl.query).noRedirect == "true");
            } catch(ex) {
                state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred when parsing the query string before authenticating a user via active directory: " + err.message);
                displayLoginForm(state, true);
                return;
            }
            // Some of the helper functions are expecting this...
            state.request.query = parsedData;

            userFetch(state, parsedData.user_id, function(err, user) {
                if (err) {
                    state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to fetch the user: " + err.message);
                    displayLoginForm(state, true);
                } else {
                    if (user) {
                        if (user.activeDirectoryAuth == true) {
                            helpers['activeDirectory'].validateUserToActiveDirectory(state, parsedData.user_id, parsedData.password, finish);
                        } else {
                            userIsLocked(state, user, function(err, locked, lockedMinutes) {
                                if (err) {
                                    state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to check if a user is locked: " + err.message);
                                    displayLoginForm(state, true);
                                } else if (locked) {
                                    displayLoginForm(state, true, 'You have exceeded maximum login attempts. Please wait ' + lockedMinutes + ' minutes for next login attempt.');
                                } else {
                                    userPasswordVerify(user, parsedData.password, finish);
                                }
                            });
                        }
                    } else {
                        displayLoginForm(state, true);
                    }
                }

                function finish(err, userAuthenticated) {
                    if (err) {
                        state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to authenticate a user via active directory: " + err.message);
                        displayLoginForm(state, true);
                    } else {
                        userUpdateLocks(state, user, userAuthenticated, function(err, locked, lockedMinutes) {
                            if (err) {
                                state.error("Sign On", state.errorLevels.errorUserAffected, "An error occurred while trying to check if a user is locked: " + err.message);
                                displayLoginForm(state, true);
                            } else if (locked) {
                                displayLoginForm(state, true, 'You have exceeded maximum login attempts. Please wait ' + lockedMinutes + ' minutes for next login attempt.');
                            } else {
                                if (userAuthenticated) {
                                    if (noRedirect)
                                        justSendCookieAfterSuccessfulLogin(state, user);
                                    else
                                        redirectAfterSuccessfulLogin(state, parsedData.user_id);
                                } else {
                                    displayLoginForm(state, true);
                                }
                            }
                        });
                    }
                }
            });
        }
    },

    validateUserToActiveDirectory: function(state, user_id, password, callback) {
        var auth = state.authenticatorConfig;
        var ad = new ActiveDirectory(auth.LDAPConnection);
        var username = auth.activeDirectoryDomain + "\\" + user_id;

        try {
            ad.authenticate(username, password, function(err, auth) {
                if (err) {
                    callback(err, false);
                }

                if (auth) {
                    callback(null, true);
                } else {
                    callback(null, false);
                }

            });
        } catch(ex) {
            callback(ex, false);
        }
    }
};

helpers['azure'] = {
    setup: function() {},
    redirect: function(state) {
        var res = state.response;
        var auth = state.authenticatorConfig;
        var requestWas;
        // Prevent redirect loops.
        if (state.request.url == ("/" + state.rootName + "/" + auth.signOnURL)) {
            requestWas = encodeURIComponent(state.root.defaultDoc);
        } else {
            requestWas = encodeURIComponent(state.request.url);
        }
        res.writeHead(302, {
            'Content-Type': 'text/html;charset=utf-8',
            Location: auth.on + '&wreply=' + auth.host + '/' + state.rootName + "/" + auth.signOnURL + '?requestWas=' + requestWas
        });
        res.write("<html><body>");
        res.write("<p>You are not currently signed on. Redirecting you to sign-on page.</p>");
        res.end("</body></html>");
    },
    signOn: signOnAzure
};

helpers['google'] = {
    setup: function(authenticatorName, authenticatorConfig) {
        if (authenticatorConfig.userCheckBeforeRedirect === undefined) {
            authenticatorConfig.userCheckBeforeRedirect = true;
        }
        passport.use(authenticatorName, new PassportGoogleStrategy(authenticatorConfig,
            function(identifier, refreshToken, profile, done) {
                if (profile._json.verified_email) {
                    done(null, {_id: profile.emails[0].value});
                } else {
                    done(null, false);
                }
            }));
    },

    passportOptions: {scope: 'openid email'},

    redirect: function(state) {
        passportAuthenticate(state, helpers['google'].passportOptions);
    },

    signOn: function(state) {
        signOnPassport(state, helpers['google'].passportOptions);
    }
};

helpers['facebook'] = {
    setup: function(authenticatorName, authenticatorConfig) {
        if (authenticatorConfig.userCheckBeforeRedirect === undefined) {
            authenticatorConfig.userCheckBeforeRedirect = true;
        }
        passport.use(authenticatorName, new PassportFacebookStrategy(authenticatorConfig,
            function(accessToken, refreshToken, profile, done) {
                var email = profile.emails[0].value; // Even though the field is named "emails", there's only ever one.
                done(null, {_id: email});
            }));
    },

    passportOptions: {scope: ['email']},

    redirect: function(state) {
        passportAuthenticate(state, helpers['facebook'].passportOptions);
    },

    signOn: function(state) {
        signOnPassport(state, helpers['facebook'].passportOptions);
    }
};

helpers['github'] = {
    setup: function(authenticatorName, authenticatorConfig) {
        if (authenticatorConfig.userCheckBeforeRedirect === undefined) {
            authenticatorConfig.userCheckBeforeRedirect = true;
        }
        passport.use(authenticatorName, new PassportGitHubStrategy(authenticatorConfig,
            function(accessToken, refreshToken, profile, done) {
                // GitHub doesn't send the email in the profile, so we have to go query the API for it.
                var httpsOptions = {
                    hostname: "api.github.com",
                    port: 443,
                    path: "/user/emails",
                    method: "GET",
                    headers: {
                        "Authorization": "token " + accessToken,
                        "Accept": "application/vnd.github.v3+json",
                        "User-Agent": "Cycligent Server"
                    }
                };
                var req = https.request(httpsOptions, function(res) {
                    var data = '';
                    res.on('data', function(part) {
                        data += part;
                    });
                    res.on('end', function() {
                        var emails = JSON.parse(data);
                        for (var i = 0; i < emails.length; i++) {
                            var emailInfo = emails[i];
                            if (emailInfo.verified && emailInfo.primary) {
                                return done(null, {_id: emailInfo.email});
                            }
                        }
                        return done(null, false);
                    });
                });
                req.end();

                req.on('error', function(error) {
                    done(error, false);
                });
            }));
    },

    // TODO: 3. Seeing an issue where doing this wipes out the existing scopes (solution might be to not send the scope options, then once we have succses redirect with the scope options...)
    passportOptions: {scope: ['user:email']},

    redirect: function(state) {
        passportAuthenticate(state, helpers['github'].passportOptions);
    },

    signOn: function(state) {
        signOnPassport(state, helpers['github'].passportOptions);
    }
};

/**
 * Generates a random salt for use with passwordHash.
 *
 * @param {Function} callback
 */
function saltCreate(callback) {
    crypto.randomBytes(64, function(err, saltBuffer) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, saltBuffer);
    });
}
exports.saltCreate = saltCreate;

/**
 * Creates a hash of a password, for storing in the database (never store plaintext passwords!)
 *
 * @param {String} plaintext
 * @param {Buffer} saltBuffer
 * @param {Function} callback
 */
function passwordHash(plaintext, saltBuffer, callback) {
    crypto.pbkdf2(plaintext, saltBuffer, 10000, 64, function(err, derivedKey) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, derivedKey);
    });
}
exports.passwordHash = passwordHash;
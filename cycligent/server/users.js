/**@type {CycligentMongo}*/ var cycligentMongo = require("../../cycligent/server/cycligentMongo.js");
/**@type {Authorize}*/ var authorize = require('./authorize.js');
var authenticators = require('./authenticators');
var cycligent = require('./cycligent.js');
var utils = require('./utils.js');

var config;
process.nextTick(function() {
    config = require('./configProcess.js');
});

module.exports = {
    _cycligentCacheServiceExport: {
        autoPlanServices: "absolute",

        /**
         * Fetches users. By default, provided with no criteria, it will fetch all active users you are authorized
         * for.
         *
         * users.all accepts the following criteria:
         *
         * returnInactive: If true, this will return all inactive users.
         * limitData: If true, this will limit the data sent to the client to _id, firstName, lastName, and active.
         * _id: The _id of a single user to fetch. This is useful in combination with limitData, in which you first
         * fetch all users with limitData, and then fill in the details later by specifying an _id when you more
         * detail.
         *
         * @param {State} state
         * @param {String} storeName
         * @param {Function} callback
         */
        all: function(state, storeName, callback) {
            if (!authorize.isAuthorized(state.user, 'functions', '/cycligent/users/read/')) {
                state.target.stores.push({id: storeName, criteria: state.post.criteria, items: [], active_id: 0});
                callback();
                return;
            }

            var query = {active: true};
            if (state.post.criteria.returnInactive) {
                query = {active: false};
            }

            var options = {password: 0, passwordSalt: 0};
            if (state.post.criteria.limitData) {
                // TODO: 2. We really shouldn't send over active. But right now the user/team management app relies on it.
                options = {_id: 1, firstName: 1, lastName: 1, active: 1};
            }

            if (state.post.criteria._id) {
                query._id = state.post.criteria._id;
            }

            state.timerStart("usersFind");
            cycligentMongo.docsFindAuthorized(state, state.sessionDbName, 'users', query, 'users', options, function() {
                state.timerStop("usersFind");
                callback();
            }, function(docs) {
                state.timerStop("usersFind");
                state.target.stores.push({id: storeName, criteria: state.post.criteria, items: docs, active_id: 0});
                callback();
            });
        }
    },

    _cycligentCallExport: {
        /**
         * Adds a new user to the database. It will return the user document to the client.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The ID of this new user (usu. their email address.)
         * @param {String} data.firstName The first name of the new user.
         * @param {String} data.lastName The last name of the new user.
         * @param {String} data.path The authorization path of the new user. You have to be authorized for this path.
         * @param {Function} callback
         */
        add: function(state, data, callback) {
            var valid = utils.validateData(state, 'User add', "/cycligent/users/write/add/", data, {}, {
                _id: "Please provide an ID (usually an email address) for the new user.",
                firstName: "Please provide a first name for the new user.",
                lastName: "Please provide a last name for the new user.",
                path: "Please provide a path for the new user."
            }, {});

            if (!valid) {
                callback();
                return;
            }

            data.path = authorize.pathNormalize(data.path);
            if (!authorize.isAuthorized(state.user, 'users', data.path)) {
                state.target.status = "error";
                state.target.error = "User edit: You can't add a user with a path you don't have access to.";
                callback();
                return;
            }

            var userDoc = userDocGenerate(state, data._id, data.firstName, data.lastName, data.path, state.user._id);

            cycligentMongo.docSave(state, state.sessionDbName, 'users', userDoc, {}, function() {
                state.target.status = "error";
                state.target.error = "User edit: " + state.errors[state.errors.length-1][1];
                callback();
            }, function() {
                state.target.status = "success";
                state.target.targets = userDoc;
                callback();
            });
        },

        /**
         * Removes a user.
         *
         * Note that users aren't actually removed from the database, they're active property is just set to false.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to remove.
         * @param {Function} callback
         */
        remove: function(state, data, callback) {
            var valid = utils.validateData(state, "User remove", "/cycligent/users/write/remove/", data, {
                _id: "Please provide an ID (usually an email address) for the user to remove."
            }, {}, {});

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id},
                {$set: {active: false, modAt: new Date(), modBy: state.user._id}, $inc: {modVersion: 1}},
                "users", "path", function() {
                    utils.handleUnauthorized(state, 'User remove');
                    callback();
                }, function() {
                    state.target.status = "success";
                    callback();
                });
        },

        /**
         * Restores a user.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to restore.
         * @param {Function} callback
         */
        restore: function(state, data, callback) {
            var valid = utils.validateData(state, "User restore", "/cycligent/users/write/restore/", data, {
                _id: "Please provide an ID (usually an email address) for the user to restore."
            }, {}, {});

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id},
                {$set: {active: true, modAt: new Date(), modBy: state.user._id}, $inc: {modVersion: 1}},
                "users", "path", function() {
                    utils.handleUnauthorized(state, 'User restore');
                    callback();
                }, function() {
                    state.target.status = "success";
                    callback();
                });
        },

        /**
         * Edits a few fields on a user.
         *
         * You must provide at least one of the optional data fields, so they're not _completely_ optional.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to edit.
         * @param {String} [data.firstName] The new first name of the user.
         * @param {String} [data.lastName] The new last name of the user.
         * @param {String} [data.path] The new path of the new user. You must have access to both the user's current path and its new path.
         * @param {Function} callback
         */
        edit: function(state, data, callback) {
            var valid = utils.validateData(state, "User edit", "/cycligent/users/write/edit/", data, {
                _id: "Please provide the ID of the user you're trying to edit."
            }, {}, {});

            if (!valid) {
                callback();
                return;
            }

            var changes = {};
            if (data.firstName) {
                changes.firstName = data.firstName;
            }

            if (data.lastName) {
                changes.lastName = data.lastName;
            }

            if (data.path) {
                data.path = authorize.pathNormalize(data.path);
                changes.path = data.path;

                if (authorize.isAuthorized(state.user, 'users', data.path)) {
                    changes.path = data.path;
                } else {
                    state.target.status = "error";
                    state.target.error = "User edit: You can't change the path to something you don't have access to.";
                    callback();
                    return;
                }
            }

            if (Object.keys(changes).length == 0) {
                state.target.status = "error";
                state.target.error = "User edit: Please provide some fields to edit (firstName, lastName, or path)";
                callback();
                return;
            }

            var query = {_id: data._id};
            changes.modBy = state.user._id;
            changes.modAt = new Date();

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', query,
                {$set: changes, $inc: {modVersion: 1}}, 'users', 'path', function() {
                    utils.handleUnauthorized(state, 'User edit');
                    callback();
                }, function() {
                    state.target.status = 'success';
                    callback();
                });
        },

        /**
         * Sets a password on a user.
         *
         * You must provide at least one of the optional data fields, so they're not _completely_ optional.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to edit.
         * @param {String} [data.firstName] The new first name of the user.
         * @param {String} [data.lastName] The new last name of the user.
         * @param {String} [data.path] The new path of the new user. You must have access to both the user's current path and its new path.
         * @param {Function} callback
         */
        passwordSet: function(state, data, callback) {
            var valid = utils.validateData(state, "User set password", "/cycligent/users/write/password/", data, {
                _id: "Please provide the ID of the user you're trying to edit."
            }, {
                password: "Please provide the password you're going to set."
            }, {});

            if (!valid) {
                callback();
                return;
            }

            var query = {_id: data._id};
            var changes = {modAt: new Date(), modBy: state.user._id};
            authenticators.saltCreate(function(err, saltBuffer) {
                if (err) {
                    state.target.status = 'error';
                    state.target.error = "User set password: An error occurred while creating the password salt.";
                    state.error("User set password", state.errorLevels.errorUserAffected, "An error occurred while creating the password salt.");
                    callback();
                    return;
                }

                authenticators.passwordHash(data.password, saltBuffer, function(err, hash) {
                    if (err) {
                        state.target.status = 'error';
                        state.target.error = "User set password: An error occurred while creating the password hash.";
                        state.error("User set password", state.errorLevels.errorUserAffected, "An error occurred while creating the password hash.");
                        callback();
                        return;
                    }
                    var saltString = saltBuffer.toString("hex");
                    var hashString = hash.toString("hex");
                    changes.passwordSalt = saltString;
                    changes.password = hashString;

                    cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', query,
                        {$set: changes, $inc: {modVersion: 1}}, 'users', 'path', function() {
                            utils.handleUnauthorized(state, 'User set password');
                            callback();
                        }, function() {
                            state.target.status = "success";
                            callback();
                        });
                });
            });
        },

        /**
         * Adds a new role to a user.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to add a role to.
         * @param {String} data.name The name of the new role.
         * @param {String} data.description The description of the new role.
         * @param {Function} callback
         */
        roleAdd: function(state, data, callback) {
            var valid = utils.validateData(state, "Role add", "/cycligent/users/write/roles/add/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {
                name: "Please provide a role name.",
                description: "Please provide a role description."
            }, {});

            if (!valid) {
                callback();
                return;
            }

            var roleDoc = roleDocGenerate(state, data.name, data.description);
            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id},
                {$push: {roles: roleDoc}, $set: {modBy: state.user._id, modAt: new Date()}, $inc: {modVersion: 1}},
                "users", "path", function() {
                    utils.handleUnauthorized(state, 'Role add');
                    callback();
                }, function() {
                    state.target.status = "success";
                    state.target.targets = roleDoc;
                    callback();
                });
        },

        /**
         * Removes a role from a user.
         *
         * Note that roles aren't actually removed, instead their 'active' property is set to false.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to remove a role from.
         * @param {String} data.roleID The _id of the role to remove. Note this must be a valid ObjectID.
         * @param {Function} callback
         */
        roleRemove: function(state, data, callback) {
            var valid = utils.validateData(state, "Role remove", "/cycligent/users/write/roles/remove/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {}, {
                roleID: "Please provide an ID for the role you are trying to remove."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, "roles._id": data.roleID},
                {$set: {"roles.$.active": false, modBy: state.user._id, modAt: new Date}, $inc: {modVersion: 1}},
                "users", "path", function() {
                    utils.handleUnauthorized(state, 'Role remove');
                    callback();
                }, function() {
                    // Now check to see if we need to update roleCurrent.
                    cycligentMongo.docFindAuthorized(state, state.sessionDbName, 'users', {_id: data._id}, 'users', 'path',
                        {}, function() {
                            utils.handleUnauthorized(state, 'Role remove');
                            callback();
                        }, function(user) {
                            if (user.roleCurrent.toString() == data.roleID.toString()) {
                                var activeRoles = user.roles.filter(function(x) {  return x.active; });
                                var role = activeRoles[0];
                                if (role) {
                                    cycligentMongo.docUpdate(state, state.sessionDbName, 'users', {_id: data._id},
                                        {$set: {roleCurrent: role._id}}, function() {
                                            state.target.status = "error";
                                            state.target.error = "Role remove: " + state.errors[state.errors.length-1][1];
                                            callback();
                                        }, function() {
                                            state.target.status = "success";
                                            state.target.targets = {roleCurrent: role._id};
                                            callback();
                                        });
                                } else {
                                    state.target.status = "success";
                                    state.target.targets = {roleCurrent: user.roleCurrent};
                                    callback();
                                }
                            } else {
                                state.target.status = "success";
                                state.target.targets = {roleCurrent: user.roleCurrent};
                                callback();
                            }
                        });
                });
        },

        /**
         * Restore a role on a user.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to restore a role on.
         * @param {String} data.roleID The _id of the role to restore. This must be a valid ObjectID.
         * @param {Function} callback
         */
        roleRestore: function(state, data, callback) {
            var valid = utils.validateData(state, "Role restore", "/cycligent/users/write/roles/restore/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {}, {
                roleID: "Please provide an ID for local role you are trying to restore."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, "roles._id": data.roleID},
                {$set: {"roles.$.active": true, modBy: state.user._id, modAt: new Date}, $inc: {modVersion: 1}},
                "users", "path", function() {
                    utils.handleUnauthorized(state, 'Role restore');
                    callback();
                }, function() {
                    state.target.status = "success";
                    callback();
                });
        },

        /**
         * Edit a role.
         *
         * Note that you must supply one of the optional data arguments, or else you wouldn't actually be editing
         * anything!
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user who has the role you want to edit.
         * @param {String} data.roleID The _id of the role you want to edit. This must be a valid ObjectID.
         * @param {String} [data.versionType] The versionType to switch the role to (i.e. main, preview, candidate.)
         * @param {String} [data.name] The new name of the role.
         * @param {String} [data.description] The new description of the role.
         * @param {Function} callback
         */
        roleEdit: function(state, data, callback) {
            var valid = utils.validateData(state, "Role edit", "/cycligent/users/write/roles/edit/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {}, {
                roleID: "Please provide an ID for the role you are trying to edit."
            });

            if (!valid) {
                callback();
                return;
            }

            var changes = {};
            if (data.versionType) {
                changes['roles.$.versionType'] = data.versionType;
            }

            if (data.name) {
                changes['roles.$.name'] = data.name;
            }

            if (data.description) {
                changes['roles.$.description'] = data.description;
            }

            if (Object.keys(changes).length == 0) {
                state.target.status = "error";
                state.target.error = "Role edit: Please provide some fields to edit (versionType, name, or description.)";
                callback();
                return;
            }

            changes.modBy = state.user._id;
            changes.modAt = new Date();
            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, 'roles._id': data.roleID},
                {$set: changes, $inc: {modVersion: 1}}, "users", "path", function() {
                    utils.handleUnauthorized(state, 'Role edit');
                    callback();
                }, function() {
                    state.target.status = "success";
                    callback();
                });
        },

        /**
         * Switches the current role of the user making this request.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data.roleID The _id of the role you want to switch to. This must be a valid ObjectID.
         * @param {Function} callback
         */
        roleCurrentChange: function(state, data, callback) {
            // We aren't checking function authorization, because every user should be able to change their own role.

            if (!data.roleID) {
                state.target.status = "error";
                state.target.error = "Role current change: You must provide the ID of the role you're switching to!";
                callback();
                return;
            }

            try {
                data.roleID = new state.mongodb.ObjectID(data.roleID);
            } catch(e) {
                state.target.status = 'error';
                state.target.error = "Role current change: Malformed ObjectID supplied for roleID.";
                callback();
                return;
            }

            var role = utils.findItemByField('_id', data.roleID, state.user.roles, true);

            if (role == null) {
                state.target.status = 'error';
                state.target.error = 'Role current change: Unknown role specified.';
                callback();
                return;
            }

            if (role.active == false) {
                state.target.status = 'error';
                state.target.error = "Role current change: You can't switch to an inactive role.";
                callback();
                return;
            }

            userChangeCurrentRole(state, state.user._id, data.roleID);

            state.target.status = "success";
            callback();
        },

        /**
         * Add an authorization to a role on a user.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user you want to add an authorization to.
         * @param {String} data.roleID The _id of the role you want to add an authorization to. Must be a valid ObjectID.
         * @param {String} data.context The context of the authorization.
         * @param {String} data.authroization The authorization path to add. The user making this change must be
         * authorized for this path themselves.
         * @param {Function} callback
         */
        authorizationAdd: function(state, data, callback) {
            var valid = utils.validateData(state, "User authorization add", "/cycligent/users/write/roles/authorization/add/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {
                context: "Please provide a context for the authorization you're adding.",
                authorization: "Please provide the authorization string to add."
            }, {
                roleID: "Please provide a role ID."
            });

            if (!valid) {
                callback();
                return;
            }

            data.authorization = authorize.pathNormalize(data.authorization);
            if (!authorize.isAuthorized(state.user, data.context, data.authorization)) {
                state.target.status = "error";
                state.target.error = "User authorization add: You can't add an authorization you don't have yourself.";
                callback();
                return;
            }

            var update = {$push: {}};
            update['$push']['roles.$.authorizations.' + data.context] = data.authorization;
            update['$set'] = {modBy: state.user._id, modAt: new Date()};
            update['$inc'] = {modVersion: 1};

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, 'roles._id': data.roleID},
                update, "users", "path", function() {
                    utils.handleUnauthorized(state, 'User authorization add');
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, data.roleID, function() {
                        state.target.status = "error";
                        state.target.error = "User authorization add: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        },

        /**
         * Remove an authorization from a role on a user.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user you want to remove the authorization from.
         * @param {String} data.roleID The _id of the role you want to remove the authorization from. Must be a valid ObjectID.
         * @param {String} data.context The context of the authorization to remove.
         * @param {String} data.authorization The authorization path to remove.
         * @param {Function} callback
         */
        authorizationRemove: function(state, data, callback) {
            var valid = utils.validateData(state, 'User authorization remove', "/cycligent/users/write/roles/authorization/remove/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {
                context: "Please provide a context for the authorization you're removing.",
                authorization: "Please provide the authorization string to remove."
            }, {
                roleID: "User authorization remove: Please provide a role ID."
            });

            if (!valid) {
                callback();
                return;
            }

            data.authorization = authorize.pathNormalize(data.authorization);
            if (!authorize.isAuthorized(state.user, data.context, data.authorization)) {
                state.target.status = "error";
                state.target.error = "User authorization remove: You can't remove an authorization you don't have yourself.";
                callback();
                return;
            }

            var update = {$pull: {}};
            update['$pull']['roles.$.authorizations.' + data.context] = data.authorization;
            update['$set'] = {modBy: state.user._id, modAt: new Date()};
            update['$inc'] = {modVersion: 1};

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, 'roles._id': data.roleID},
                update, "users", "path", function() {
                    utils.handleUnauthorized(state, 'User authorization remove');
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, data.roleID, function() {
                        state.target.status = "error";
                        state.target.error = "User authorization remove: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        },

        /**
         * Adds the user to a team.
         *
         * (Actually 'teams' is an array in the roles in the user document, so this actually adds the team to the user.)
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to add to the team.
         * @param {String} data.roleID The _id of the role of the user to add the team to. Must be a valid ObjectID.
         * @param {String} data.teamID The _id of the team to add. Must be a valid ObjectID.
         * @param {Function} callback
         */
        teamAdd: function(state, data, callback) {
            var valid = utils.validateData(state, "User team add", "/cycligent/users/write/roles/teams/add/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {}, {
                roleID: "Please provide a role ID.",
                teamID: "Please provide the ID of the team to add the user to."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docFindAuthorized(state, state.sessionDbName, 'teams', {_id: data.teamID}, 'teams', 'path', {path: 1}, function() {
                utils.handleUnauthorized(state, 'User team add');
                callback();
            }, function() {
                cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, 'roles._id': data.roleID},
                    {$push: {'roles.$.teams': data.teamID}, $set: {modBy: state.user._id, modAt: new Date()}, $inc: {modVersion: 1}},
                    "users", "path", function() {
                        utils.handleUnauthorized(state, 'User team add');
                        callback();
                    }, function() {
                        authorizationsCacheUpdate(state, data._id, data.roleID, function() {
                            state.target.status = "error";
                            state.target.error = "User team add: " + state.errors[state.errors.length-1][1];
                            callback();
                        }, function() {
                            state.target.status = "success";
                            callback();
                        });
                    });
            });
        },

        /**
         * Removes a user from a team.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the user to remove from the team.
         * @param {String} data.roleID The _id of the role on the user to remove the team from. Must be a valid ObjectID.
         * @param {String} data.teamID The _id of the team to remove. Must be a valid ObjectID.
         * @param {Function} callback
         */
        teamRemove: function(state, data, callback) {
            var valid = utils.validateData(state, "User team remove", "/cycligent/users/write/roles/teams/remove/", data, {
                _id: "Please provide an ID (usually an email address) for the user."
            }, {}, {
                roleID: "Please provide a role ID.",
                teamID: "Please provide the ID of the team to remove the user to."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docFindAuthorized(state, state.sessionDbName, 'teams', {_id: data.teamID}, 'teams', 'path', {path: 1}, function() {
                    utils.handleUnauthorized(state, 'User team remove');
                    callback();
                }, function() {
                cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'users', {_id: data._id, 'roles._id': data.roleID},
                        {$pull: {'roles.$.teams': data.teamID}, $set: {modBy: state.user._id, modAt: new Date()}, $inc: {modVersion: 1}},
                        "users", "path", function() {
                            utils.handleUnauthorized(state, 'User team remove');
                            callback();
                        }, function() {
                            authorizationsCacheUpdate(state, data._id, data.roleID, function() {
                                state.target.status = "error";
                                state.target.error = "User team remove: " + state.errors[state.errors.length-1][1];
                                callback();
                            }, function() {
                                state.target.status = "success";
                                callback();
                            });
                        });
            });
        }
    }
};

/**
 * Updates the authorizationsCache field for the given role on the given user.
 *
 * @param {State} state
 * @param {String} userID
 * @param {ObjectID} roleID
 * @param {Function} failureCallback
 * @param {Function} successCallback
 */
function authorizationsCacheUpdate(state, userID, roleID, failureCallback, successCallback) {
    cycligentMongo.docFind(state, state.sessionDbName, 'users', {_id: userID}, {}, function() {
        failureCallback();
    }, function(user) {
        var role = utils.findItemByField('_id', roleID, user.roles, true);
        var authorizations = role.authorizations;

        cycligentMongo.docsFind(state, state.sessionDbName, 'teams', {_id: {$in: role.teams}, active: true}, {}, function() {
            failureCallback();
        }, function(teams) {
            for (var i = 0; i < teams.length; i++) {
                var team = teams[i];
                authorizations = authorizationObjectMerge(authorizations, team.authorizations);
            }
            authorizations = authorizationsCacheCompute(authorizations);

            cycligentMongo.docUpdate(state, state.sessionDbName, 'users', {_id: userID, 'roles._id': roleID},
                {$set: {'roles.$.authorizationsCache': authorizations}}, function() {
                    failureCallback();
                }, function() {
                    successCallback();
                });
        });
    });
}

/**
 * Takes two objects that contain maps to arrays of authorizations, and merges them together.
 *
 * @param {Object} auth1
 * @param {Object} auth2
 * @returns {Object}
 */
function authorizationObjectMerge(auth1, auth2) {
    var result = {};

    var key, array;
    for (key in auth1) {
        if (auth1.hasOwnProperty(key)) {
            array = auth1[key];
            result[key] = array.slice(0); // clone the array.
        }
    }

    for (key in auth2) {
        if (auth2.hasOwnProperty(key)) {
            array = auth2[key];
            if (result[key]) {
                result[key].push.apply(result[key], array);
            } else {
                result[key] = array.slice(0); // clone the array.
            }
        }
    }

    return result;
}
module.exports.authorizationObjectMerge = authorizationObjectMerge;

/**
 * Given a map of arrays of authorizations, this will simplify it to the most efficient
 *
 * @param {Object} authorizations
 */
function authorizationsCacheCompute(authorizations) {
    var result = {};

    for (var key in authorizations) {
        if (authorizations.hasOwnProperty(key)) {
            var array = authorizations[key];
            result[key] = [];

            for (var i = 0; i < array.length; i++) {
                var path = array[i];
                if (path.substr(path.length-1,1) != '/')
                    path += "/";
                authAdd(path, result[key]);
            }
        }
    }

    return result;

    function authAdd(pushing, array) {
        var i = 0;
        var auth;

        while(i < array.length){
            auth = array[i];

            // Check for shorter item already authorizing the same path.
            if (pushing.substr(0,auth.length) == auth) {
                return;
            }

            // Check for items which this item will authorize and delete them.
            if (auth.substr(0,pushing.length) == pushing) {
                array.splice(i,1);
            } else {
                i++;
            }
        }

        array.push(pushing);
    }
}
module.exports.authorizationsCacheCompute = authorizationsCacheCompute;

/**
 * Generates a new user document. This is what the cycligentCall users.add uses. If you need to generate a reference
 * user document, or are creating an application-specific user creation function, you'll probably want to call
 * this.
 *
 * Note that this function doesn't validate any of its arguments, so make sure you give it valid data!
 *
 * @param {State} state
 * @param {String} _id The unique ID of the user; basically always their email address.
 * @param {String} firstName The user's first name.
 * @param {String} lastName The user's last name.
 * @param {String} path The authorization path of the user. Used to filter access to the users.
 * @param {String} modBy The email address of who created this documents.
 * @returns {{_id: String, firstName: String, lastName: String, path: String, roleCurrent: state.mongodb.ObjectID, roles: Object[], config: {}, active: Boolean}}
 */
function userDocGenerate(state, _id, firstName, lastName, path, modBy) {
    var role = roleDocGenerate(state, "Default Role", "The default role provided at sign-up.");
    return {
        _id: _id,
        firstName: firstName,
        lastName: lastName,
        path: path,
        roleCurrent: role._id,
        roles: [role],
        config: {},
        active: true,
        modAt: new Date(),
        modBy: modBy,
        modVersion: 0
    };
}
module.exports.userDocGenerate = userDocGenerate;

/**
 * Generates a new role document. This is what the cycligentCall users.roleAdd uses. If you need to generate a reference
 * role document, or are creating an application-specific user/role creation function, you'll probably want to call
 * this.
 *
 * Note that this function doesn't validate any of its arguments, so make sure you give it valid data!
 *
 * @param {State} state
 * @param {String} name The name of this role.
 * @param {String} description The description of this role.
 * @returns {{_id: state.mongodb.ObjectID, name: *, description: *, authorizations: {}, teams: Array, authorizationsCache: {}, versionType: string}}
 */
function roleDocGenerate(state, name, description) {
    return {
        _id: new state.mongodb.ObjectID(),
        name: name,
        description: description,
        authorizations: {},
        teams: [],
        authorizationsCache: {},
        versionType: config.versionTypeWithWebServerDynamicRequestsEnabled._id,
        active: true
    }
}
module.exports.roleDocGenerate = roleDocGenerate;

/**
 * Switch the role of the current user, updating their cookie and their document in the database.
 *
 * This function doesn't do any validation that the role you want to switch to is valid, so
 * please do that before you call it!
 *
 * @param {State} state
 * @param {String} userID
 * @param {ObjectID} roleID
 */
function userChangeCurrentRole(state, userID, roleID) {
    state.response.setHeader('Set-Cookie', cycligent.userCookieChangeRole(state, roleID));

    cycligentMongo.docUpdate(state, state.sessionDbName, 'users', {_id: userID},
        {$set: {roleCurrent: roleID, modBy: userID, modAt: new Date()}, $inc: {modVersion: 1}},
        function() {}, function() {});
}
module.exports.userChangeCurrentRole = userChangeCurrentRole;
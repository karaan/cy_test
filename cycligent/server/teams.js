/**@type {CycligentMongo}*/ var cycligentMongo = require("../../cycligent/server/cycligentMongo.js");
/**@type {Authorize}*/ var authorize = require('./authorize.js');
var usersModule = require('./users.js');
var utils = require('./utils.js');

module.exports = {
    _cycligentCacheServiceExport: {
        autoPlanServices: "absolute",

        /**
         * Fetches teams. By default, provided with no criteria, it will fetch all active teams you are authorized
         * for.
         *
         * teams.all accepts the following criteria:
         *
         * returnInactive: If true, this will return all inactive teams.
         * limitData: If true, this will limit the data sent to the client to _id, name, and active.
         * _id: The _id of a single team to fetch. This is useful in combination with limitData, in which you first
         * fetch all teams with limitData, and then fill in the details later by specifying an _id when you more
         * detail.
         *
         * @param {State} state
         * @param {String} storeName
         * @param {Function} callback
         */
        all: function(state, storeName, callback) {
            if (!authorize.isAuthorized(state.user, 'functions', '/cycligent/teams/read/')) {
                state.target.stores.push({id: storeName, criteria: state.post.criteria, items: [], active_id: 0});
                callback();
                return;
            }

            var query = {active: true};
            if (state.post.criteria.returnInactive) {
                query = {active: false};
            }

            var options = {};
            if (state.post.criteria.limitData) {
                // TODO: 2. We really shouldn't send over active. But right now the user/team management app relies on it.
                options = {_id: 1, name: 1, active: 1};
            }

            if (state.post.criteria._id) {
                try {
                    query._id = new state.mongodb.ObjectID(state.post.criteria._id);
                } catch(e) {
                    state.target.stores.push({id: storeName, criteria: state.post.criteria, items: [], active_id: 0});
                    callback();
                    return;
                }
            }

            state.timerStart("teamsFind");
            cycligentMongo.docsFindAuthorized(state, state.sessionDbName, 'teams', query, 'teams', options, function() {
                state.timerStop("teamsFind");
                callback();
            }, function(docs) {
                state.timerStop("teamsFind");
                state.target.stores.push({id: storeName, criteria: state.post.criteria, items: docs, active_id: 0});
                callback();
            });
        }
    },

    _cycligentCallExport: {
        /**
         * Adds a new team to the database. This returns the new team document to the client.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data.name The name of the new team.
         * @param {String} data.description The description of the new team.
         * @param {String} data.path The path of the new team. The user adding this team must be authorized for this path.
         * @param {Function} callback
         */
        add: function(state, data, callback) {
            var valid = utils.validateData(state, "Team add", "/cycligent/teams/write/add/", data, {}, {
                name: "Please provide a name for the new team.",
                description: "Please provide a description for the new team.",
                path: "Please provide a path for the new team."
            }, {});

            if (!valid) {
                callback();
                return;
            }

            data.path = authorize.pathNormalize(data.path);
            if (!authorize.isAuthorized(state.user, 'teams', data.path)) {
                state.target.status = "error";
                state.target.error = "Team add: You can't create a team with a path you don't have access to!";
                callback();
                return;
            }

            var teamDoc = {
                name: data.name,
                description: data.description,
                authorizations: {},
                path: data.path,
                modBy: state.user._id,
                modAt: new Date(),
                modVersion: 0,
                active: true
            };

            cycligentMongo.docSave(state, state.sessionDbName, 'teams', teamDoc, {}, function() {
                state.target.status = "error";
                state.target.error = "Team add: " + state.errors[state.errors.length-1][1];
                callback();
            }, function(savedDoc) {
                state.target.status = "success";
                state.target.targets = savedDoc;
                callback();
            });
        },

        /**
         * Removes a team.
         *
         * (Note that we don't actually remove them from the database, but instead set their active property to false.)
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the team to remove. Must be a valid ObjectID.
         * @param {Function} callback
         */
        remove: function(state, data, callback) {
            var valid = utils.validateData(state, "Team remove", "/cycligent/teams/write/remove/", data, {}, {}, {
                _id: "Please provide the ID of the team you're trying to remove."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'teams', {_id: data._id},
                {$set: {active: false, modAt: new Date(), modBy: state.user._id}, $inc: {modVersion: 1}},
                'teams', 'path', function() {
                    utils.handleUnauthorized(state, 'Team remove');
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, function() {
                        state.target.status = "error";
                        state.target.error = "Team remove: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        },

        /**
         * Restores a removed team.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id THe _id of the team to restore. Must be a valid ObjectID.
         * @param {Function} callback
         */
        restore: function(state, data, callback) {
            var valid = utils.validateData(state, "Team restore", "/cycligent/teams/write/restore/", data, {}, {}, {
                _id: "Please provide the ID of the team you're trying to restore."
            });

            if (!valid) {
                callback();
                return;
            }

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'teams', {_id: data._id},
                {$set: {active: true, modAt: new Date(), modBy: state.user._id}, $inc: {modVersion: 1}},
                'teams', 'path', function() {
                    utils.handleUnauthorized(state, 'Team restore');
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, function() {
                        state.target.status = "error";
                        state.target.error = "Team restore: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        },

        /**
         * Edits some of the fields on a team.
         *
         * Note that at least one of the optional data fields must be supplied, or else you won't actually be
         * editing anything!
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the team you're trying to edit. Must be a valid ObjectID.
         * @param {String} [data.name] The new name of the team.
         * @param {String} [data.description] The new description of the team.
         * @param {String} [data.path] The new path of the team. The editing user must have access to both the old an new path.
         * @param {Function} callback
         */
        edit: function(state, data, callback) {
            var valid = utils.validateData(state, "Team edit", "/cycligent/teams/write/edit/", data, {}, {}, {
                _id: "Please provide the ID of the team you're trying to edit."
            });

            if (!valid) {
                callback();
                return;
            }

            var changes = {};
            if (data.name) {
                changes.name = data.name;
            }

            if (data.description) {
                changes.description = data.description;
            }

            if (data.path) {
                data.path = authorize.pathNormalize(data.path);
                if (authorize.isAuthorized(state.user, 'teams', data.path)) {
                    changes.path = data.path;
                } else {
                    state.target.status = "error";
                    state.target.error = "Team edit: You can't change the path to something you don't have access to!";
                    callback();
                    return;
                }
            }

            if (Object.keys(changes).length == 0) {
                state.target.status = "error";
                state.target.error = "Team edit: Please provide some fields to edit (name, description, or path)";
                callback();
                return;
            }

            changes.modAt = new Date();
            changes.modBy = state.user._id;
            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'teams', {_id: data._id},
                {$set: changes, $inc: {modVersion: 1}}, 'teams', 'path', function() {
                    utils.handleUnauthorized(state, 'Team edit');
                    callback();
                }, function() {
                    state.target.status = 'success';
                    callback();
                });
        },

        /**
         * Adds an authorization to a team.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the team you're adding an authorization to. Must be a valid ObjectID.
         * @param {String} data.context The context of the authorization.
         * @param {String} data.authorization The authorization path to add.
         * @param {Function} callback
         */
        authorizationAdd: function(state, data, callback) {
            var valid = utils.validateData(state, "Team authorization add", "/cycligent/teams/write/authorization/add/", data,
                {}, {
                    context: "Please provide a context for the authorization you're adding.",
                    authorization: "Please provide the authorization string to add."
                }, {
                    _id: "Please provide the ID of the team you're trying to add authorizations for."
                });

            if (!valid) {
                callback();
                return;
            }

            data.authorization = authorize.pathNormalize(data.authorization);
            if (!authorize.isAuthorized(state.user, data.context, data.authorization)) {
                state.target.status = "error";
                state.target.error = "Team authorization add: You can't add an authorization you don't have yourself to a team.";
                callback();
                return;
            }

            var update = {$push: {}};
            update['$push']['authorizations.' + data.context] = data.authorization;
            update.$set = {modAt: new Date(), modBy: state.user._id};
            update.$inc = {modVersion: 1};

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'teams', {_id: data._id},
                update, 'teams', 'path', function() {
                    utils.handleUnauthorized(state, "Team authorization add");
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, function() {
                        state.target.status = "error";
                        state.target.error = "Team authorization add: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        },

        /**
         * Removes an authorization from a team.
         *
         * @param {State} state
         * @param {Object} data
         * @param {String} data._id The _id of the team. Must be a valid ObjectID.
         * @param {String} data.context The context of the authorization to add.
         * @param {String} data.authorization The authorization path to remove.
         * @param {Function} callback
         */
        authorizationRemove: function(state, data, callback) {
            var valid = utils.validateData(state, "Team authorization remove", "/cycligent/teams/write/authorization/remove/",
                data, {}, {
                    context: "Please provide a context for the authorization you're removing.",
                    authorization: "Please provide the authorization string to remove."
                }, {
                    _id: "Please provide the ID of the team you're trying to remove authorizations from."
                });

            if (!valid) {
                callback();
                return;
            }

            data.authorization = authorize.pathNormalize(data.authorization);
            if (!authorize.isAuthorized(state.user, data.context, data.authorization)) {
                state.target.status = "error";
                state.target.error = "Team authorization remove: You can't remove an authorization you don't have yourself from a team.";
                callback();
                return;
            }

            var update = {$pull: {}};
            update['$pull']['authorizations.' + data.context] = data.authorization;
            update.$set = {modAt: new Date(), modBy: state.user._id};
            update.$inc = {modVersion: 1};

            cycligentMongo.docUpdateAuthorized(state, state.sessionDbName, 'teams', {_id: data._id},
                update, 'teams', 'path', function() {
                    utils.handleUnauthorized(state, "Team authorization remove");
                    callback();
                }, function() {
                    authorizationsCacheUpdate(state, data._id, function() {
                        state.target.status = "error";
                        state.target.error = "Team authorization remove: " + state.errors[state.errors.length-1][1];
                        callback();
                    }, function() {
                        state.target.status = "success";
                        callback();
                    });
                });
        }
    }
};

/**
 * This function updates the authorizationsCache for each user affected by a change to a team.
 * More details on the process follows below.
 *
 * When updating users due to a change in a team, the naive thing to do would be to just call
 * users.authorizationCacheUpdate, but that would result in a trip to the database to process
 * each role in each user, and another trip within that to fetch the teams associated with each
 * role.
 *
 * This function tries to avoid these inefficiencies by first fetching all users associated with
 * the given team. Then it figures out the roles that need to be updated, and fetches all the
 * teams those roles have, since those teams need to be included in the authorizationsCache
 * calculation.
 *
 * Then it updates all relevant roles in each user.
 *
 * @param {State} state
 * @param {ObjectID} teamID
 * @param {Function} failureCallback
 * @param {Function} successCallback
 */
function authorizationsCacheUpdate(state, teamID, failureCallback, successCallback) {
    teamGetAssociatedUsers(state, teamID, failureCallback, function(users) {
        if (users.length == 0) {
            successCallback();
            return;
        }

        var teamIDs = usersGetAssociatedTeamIDs(users, teamID);
        teamsFetchWithIDs(state, teamIDs, failureCallback, function(teamMap) {
            var failureOccurred = false;
            var updatesLeft = users.length;

            for (var i = 0; i < users.length; i++) {
                var user = users[i];
                var updates = {};

                for (var j = 0; j < user.relevantRoles.length; j++) {
                    var role = user.relevantRoles[j];
                    var authorizations = role.authorizations;

                    for (var k = 0; k < role.teams.length; k++) {
                        var team = teamMap[role.teams[k]];
                        if (team) // Because a team could've been deleted, and thus not in the teamMap
                            authorizations = usersModule.authorizationObjectMerge(authorizations, team.authorizations);
                    }
                    authorizations = usersModule.authorizationsCacheCompute(authorizations);

                    updates["roles." + role.index + ".authorizationsCache"] = authorizations;
                }

                if (!failureOccurred) {
                    updates['modBy'] = state.user._id;
                    updates['modAt'] = new Date();

                    cycligentMongo.docUpdate(state, state.sessionDbName, 'users', {_id: user._id}, {$set: updates, $inc: {modVersion: 1}},
                        function() {
                            failureOccurred = true;
                            failureCallback();
                        },
                        function() {
                            updatesLeft--;

                            if (updatesLeft == 0)
                                successCallback();
                        });
                } else {
                    break;
                }
            }
        });
    });
}

/**
 * Gets all the users associated with a team.
 *
 * @param {State} state
 * @param {ObjectID} teamID
 * @param {Function} failureCallback The callback to call if something goes wrong with the database access.
 * @param {Function} successCallback The callback to call when we successfully retrieve the users. Will be passed an
 * array of users as its first argument.
 */
function teamGetAssociatedUsers(state, teamID, failureCallback, successCallback) {
    cycligentMongo.docsFind(state, state.sessionDbName, 'users', {'roles.teams': teamID}, {}, function() {
        failureCallback();
    }, function(users) {
        successCallback(users);
    });
}

/**
 * This function goes through the users, finding the roles that have then given team, and all other teams in
 * that role, so teams.authorizationsCacheUpdate can fetch all the necessary teams.
 *
 * It adds the relevant roles to user.relevantRoles. Because these roles were found via userGetRolesWithTeam,
 * they have an index property that contains their original index.
 *
 * @param {Object[]} users
 * @param {ObjectID} teamID
 * @returns {Array}
 */
function usersGetAssociatedTeamIDs(users, teamID) {
    var teamIDs = [];
    for (var i = 0; i < users.length; i++) {
        var user = users[i];
        var relevantRoles = userGetRolesWithTeam(user, teamID);
        user.relevantRoles = relevantRoles;

        for (var j = 0; j < relevantRoles.length; j++) {
            var role = relevantRoles[j];

            for (var k = 0; k < role.teams.length; k++) {
                var team = role.teams[k];
                teamIDs.push(team);
            }
        }
    }

    return teamIDs;
}

/**
 * Fetches all the teams specified by the teamIDs array from the database.
 *
 * @param {State} state
 * @param {ObjectID[]} teamIDs
 * @param {Function} failureCallback Function called if something goes wrong with the database access.
 * @param {Function} successCallback Function called when we have all the teams from the database. Will be called
 * with a map of ObjectIDs to teams as the first argument.
 */
function teamsFetchWithIDs(state, teamIDs, failureCallback, successCallback) {
    cycligentMongo.docsFind(state, state.sessionDbName, 'teams', {_id: {$in: teamIDs}, active: true}, {}, failureCallback,
        function(teamDocs) {
            var teams = {};
            for (var i = 0; i < teamDocs.length; i++) {
                var teamDoc = teamDocs[i];
                teams[teamDoc._id] = teamDoc;
            }

            successCallback(teams);
        });
}

/**
 * Gets all the roles from the given user that have the given team.
 *
 * Each role returned will be given index property set which will contain their index in user.roles.
 *
 * @param {Object} user
 * @param {ObjectID} teamID
 * @returns {Array} The array of roles.
 */
function userGetRolesWithTeam(user, teamID) {
    var roles = [];

    for (var i = 0; i < user.roles.length; i++) {
        var role = user.roles[i];

        for (var j = 0; j < role.teams.length; j++) {
            var team = role.teams[j];
            if (team.toString() == teamID.toString()) {
                role.index = i;
                roles.push(role);
            }
        }
    }

    return roles;
}
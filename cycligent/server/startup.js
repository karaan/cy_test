/**@type {ServerConfig}*/ var config = null;

module.exports = {

    _cycligentCachePlanExport: {
        set: [
            {service: 'sessions'},
            {service: 'roles'},
            {service: 'userConfigs'},
            {service: 'messages'},
            {service: 'roots'}
        ]
    },

    _cycligentCacheServiceExport: {

        autoPlanServices: 'absolute',

        sessions: function(state, storeName, callback){

            var store = {id: storeName, criteria:{store: storeName}};
            state.target.stores.push(store);

            store.items = [{
                _id: 1,
                user: state.user._id,
                userName: state.user._id,
                userFirstName: state.user.firstName,
                userLastName: state.user.lastName,
                role: state.user.role,
                authorization: state.authorization,
                roleName: state.user.role.name,
                appVersion: state.root.appVersion,
                logoutURL: "/signOff"
            }];

            if (state.authorization
                && state.user._db.authorizationTokens
                && state.user._db.authorizationTokens[state.authorization]
            ) {
                var expirationTime = state.user._db.authorizationTokens[state.authorization].expires.getTime();
                store.items[0].sessionTimeoutMillisecond = expirationTime - Date.now();
            }

            var ids = [];
            for(var i=0; i<store.items.length; i++){
                ids.push(store.items[i].id);
            }
            state.services_ids.push({idName:"session",ids:ids,active_id:1});

            callback();
        },

        roles: function(state, storeName, callback){

            var res = state.response;

            var roles = state.user.roles;

            var active_id = 0;
            if(roles.length > 0){
                active_id = state.user.role;
            }

            var ids = [];

            var store = {id: storeName, active_id:active_id, criteria:{store: storeName},items:[]};
            state.target.stores.push(store);
            for(var i = 0; i < roles.length; i++){
                if(roles[i].active){
                    ids.push(roles[i]._id);
                    store.items.push(roles[i]);
                }
            }

            state.services_ids.push({idName:"role",ids:ids,active_id:active_id});

            callback();
        },

        userConfigs: function(state, storeName, callback){
            var res = state.response;

            var config = state.user.config;
            config._id = 1;
            var active_id = config._id;

            var store = {id: storeName, active_id:active_id, criteria:{store: storeName},items:[config]};
            state.target.stores.push(store);
            state.services_ids.push({idName:"config",ids:[active_id],active_id:active_id});

            callback();
        },

        //TODO: 3. Implement fully
        messages: function(state, storeName, callback){
            var store = {id: storeName, active_id:0, criteria:{store: storeName},items:[]};
            state.target.stores.push(store);
            state.services_ids.push({idName:"message"});
            callback();
        },

        roots: function(state, storeName, callback) {
            if (!config) {
                // Load it here, because for whatever reason, loading it at the top of the file wasn't working...
                config = require('./configProcess.js');
            }

            var store = {
                id: storeName,
                active_id: 0,
                criteria: {store: storeName},
                items: [{
                    _id: 0,
                    names: Object.keys(config.roots)
                }]
            };
            state.target.stores.push(store);
            state.services_ids.push({idName:"roots", ids: [0], active_id: 0});
            callback();
        }
    }
};

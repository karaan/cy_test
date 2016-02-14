/**
 * Authorize
 *
 * Authorization Module
 *
 * <b>Methods</b>
 *
 * <b>authorizedReduction(user,context,array)</b> Reduces an array of authorization paths only to
 * those which the user is authorized.
 *
 * <b>isAuthorize(user,context,path)</b> Checks to see if the user authorized for the provided path.
 * Returns true if they are authorized for the path, false otherwise.
 *
 * <b>isNavigable(user,context,path)</b> Checks to see if the user can navigate the provided path.
 * Returns true if they are authorized to navigate the provided path, false otherwise.
 *
 * <b>navigableReduction(user,context,array)</b> Reduces an array of authorization paths to only
 * those that a user is authorized to navigate.
 */

module.exports = Authorize = {

    /**
     * Checks to see if the user can navigate the provided path.
     * Returns true if they are authorized to navigate to the provided path, false otherwise.
     * @param {UserDoc} user The current user (See Class: {@link User})
     * @param {String} context The context of the path, as in a path that relates to 'functions', 'projects', etc. Normally the context identifies the table or collection to which the path is applied.
     * @param {String} path
     */
    isNavigable: function(user,context,path){

        if(this.isAuthorized(user,context,path)){
            return true;
        }

        path = this.pathNormalize(path);
        if(user.role && user.role.authorizationsCache){

            var contextAuthorizations = user.role.authorizationsCache[context];

            var authPath;
            for(var index in contextAuthorizations){
                authPath = contextAuthorizations[index];
                if(authPath.indexOf(path) == 0){
                    return true;
                }
            }
        }

        return false;
    },

    /**
     * Checks to see if the user can navigate the provided project path.
     * Returns true if they are authorized to navigate to the provided project, false otherwise.
     * @param {Object} userRole The current user (See Class: {@link User})
     * @param {String} context The context of the path, as in a path that relates to 'functions', 'projects', etc. Normally the context identifies the table or collection to which the path is applied.
     * @param {String} path
     */
    isAuthorizedProject: function(userRole,context,path){
        path = this.pathNormalize(path);
        if(userRole && userRole.authorizationsCache){

            var contextAuthorizations = userRole.authorizationsCache[context];

            var authPath;
            for(var index in contextAuthorizations){
                authPath = contextAuthorizations[index];
                if(path.indexOf(authPath) == 0){
                    return true;
                }
            }
        }

        return false;
    },

    /**
     * Checks to see if the user authorized for the provided path.
     * Returns true if they are authorized for the path, false otherwise.
     * @param {UserDoc} user The current user
     * @param {String} context The context of the path, as in a path that relates to 'functions', 'projects', etc. Normally the context identifies the table or collection to which the path is applied.
     * @param {String} path
     */
    isAuthorized: function(user,context,path){
        path = this.pathNormalize(path);
        if(user.role && user.role.authorizationsCache){

            var contextAuthorizations = user.role.authorizationsCache[context];

            var authPath;
            for(var index in contextAuthorizations){
                authPath = contextAuthorizations[index];
                if(path.indexOf(authPath) == 0){
                    return true;
                }
            }
        }

        return false;
    },

    /**
     * Reduces an array of authorization paths to only those that a user is authorized to navigate.
     * @param {UserDoc} user The current user
     * @param {String} context The context of the path, as in a path that relates to 'functions', 'projects', etc. Normally the context identifies the table or collection to which the path is applied.
     * @param {String[]} array The array to be reduced
     */
    navigableReduction: function(user,context,array){
        var i = 0;
        var item;
        while(i < array.length){
            item = array[i];
            if(!this.isNavigable(user,context,item.path)){
                //noinspection JSUnresolvedFunction
                array.splice(i,1);
            }else{
                i++;
            }
        }
    },

    /**
     * Reduces an array of authorization paths only to those which the user is authorized.
     * @param {UserDoc} user The current user
     * @param {String} context The context of the path, as in a path that relates to 'functions', 'projects', etc. Normally the context identifies the table or collection to which the path is applied.
     * @param {String[]} array The array to be reduced
     */
    authorizedReduction: function(user,context,array){
        var i = 0;
        var item;
        while(i < array.length){
            item = array[i];
            if(!this.isAuthorized(user,context,item.path)){
                //noinspection JSUnresolvedFunction
                array.splice(i,1);
            }else{
                i++;
            }
        }
    },

    /**
     * Normalizes a path string so that it ends in '/' and if it is blank it becomes "/".
     *
     * @param {String} path
     */
    pathNormalize: function(path) {
        if (path == undefined) {
            path = '/';
        } else if(path.substr(path.length-1,1) != '/'){
            path += '/';
        }
        return path.trim();
    },

    _cycligentCallExport: {

        /**
         * Returns optimized (fewest possible) security paths that match the authorization request.
         * @param {State} state
         * @param {Object} data
         * @param {Function} callback
         */
        paths: function(state, data, callback){

            var requestIndex;
            var authIndex;
            var request;
            var auth;
            var adds;

            state.target.data = {};

            // Go through each requested context
            for(var context in data){
                if (data.hasOwnProperty(context)) {
                    adds = [];
                    // Go through each check request for the context
                    for(requestIndex = 0; requestIndex < data[context].length; requestIndex++){
                        if (state.user.role.authorizationsCache[context] == undefined)
                            continue;

                        request = data[context][requestIndex];
                        // Step through the authorizations cache finding matches
                        for(authIndex = 0; authIndex < state.user.role.authorizationsCache[context].length; authIndex++){
                            auth = state.user.role.authorizationsCache[context][authIndex];

                            if(request.substr(0,auth.length) == auth){
                                // request is fully authorized
                                matchAdd(auth);
                                break;
                            }

                            if(auth.substr(0,request.length) == request){
                                // this more detailed authorization is matched by the request
                                matchAdd(auth);
                            }

                        }
                    }

                    if(adds.length > 0){
                        state.target.data[context] = adds;
                    }
                }
            }

            state.target.status = 'success';
            callback();

            function matchAdd(match){

                var addIndex = 0;
                var add;

                while(addIndex < adds.length){
                    add = adds[addIndex];

                    // Check for shorter item already authorizing this item
                    if(match.substr(0,add.length) == add ){
                        return;
                    }

                    // Check for items which this item will authorize and delete them.
                    if(add.substr(0,match.length) == match){
                        adds.splice(addIndex,1);
                    }else{
                        addIndex++;
                    }
                }

                adds.push(match);
            }
        }
    }
};




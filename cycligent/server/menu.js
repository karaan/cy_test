/**@type {Authorize}*/ var authorize = require('./authorize.js');

/**
 * @function
 * @param {State} state
 * @param {Function} callback
 */
module.exports.request = generateRequestHandler(function(state, menuItems) {
    standardMenuProcess(state, menuItems);
    state.target.menu = menuItems;
});

//TODO: 2. These seems over complicated, why do we have to generate a request handler????
/**
 * @function
 * Will put in state.target.menu the menu items in the form of {serverPath: authPath} so you can run authorization
 * checks against the menu items.
 * @param {State} state
 * @param {Function} callback
 */
module.exports.requestPathsForAuth = generateRequestHandler(function(state, menuItems) {
    state.target.menu = pathAuthProcess(state, menuItems);
});

function generateRequestHandler(processor){
    return function(state,callback) {
        state.target = {target:"cycligentMenu",request:state.post.request};
        state.targets.push(state.target);

        var version = state.user.config.menuVersion;

        if(!version){
            version = 1;
        }

        state.timerStart("menuFetch");
        state.sessionDb.collection('menus',function(err, collection){
            if(err){
                state.error(err.message);
                callback(state); // just return the
            } else {
                collection.findOne({version:version},function(err,result){
                    if(err){
                        state.error(err.message);
                    } else {
                        state.timerStop("menuFetch");
                        if(result){
                            processor(state, result.menu);
                        } else {
                            state.error("MenusFetch did not return any documents.");
                        }
                    }
                    callback(state); // just return the
                });
            }
        });
    }
}

/**
 *
 * @param {State} state
 * @param menuItems
 */
function standardMenuProcess(state, menuItems){

    var i = 0;
    var item;
    while(i < menuItems.length){
        item = menuItems[i];

        if(!authorize.isNavigable(state.user,'functions',item.path)){
            menuItems.splice(i,1);
            continue;
        }

        if(item.action && item.action.url && item.action.url.substr(0,8) == "[_root_]"){
            item.action.url = "/" + state.rootName + item.action.url.substr(8);
        }

        if(item.children){
            standardMenuProcess(state, item.children);
        }

        i++;
    }
}

function pathAuthProcess(state, menuItems, processedItems) {
    if (processedItems == undefined) {
        processedItems = {};
    }

    var i = 0;
    var item;
    while(i < menuItems.length){
        item = menuItems[i];

        if(item.action && item.action.url && item.action.url.substr(0,8) == "[_root_]"){
            var url = "/" + state.rootName + item.action.url.substr(8);
            processedItems[url] = item.path;
        }

        if(item.children){
            pathAuthProcess(state, item.children, processedItems);
        }

        i++;
    }

    return processedItems;
}
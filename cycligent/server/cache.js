var dottedNameHandler = require('./utils.js').dottedNameHandler;
var query = require('./query.js');
var findPotentialDuplicates = query.findPotentialDuplicates;
var removeDuplicates = query.removeDuplicates;

module.exports = {
    mapSet: mapSet,
    request:request
};

var planMap;
var serviceMap;

function mapSet(planValue, serviceValue){
    planMap = planValue;
    serviceMap = serviceValue;
}

function request(state,callback){
    state.target = {
        target: "cycligentCache",
        request: state.post.request,
        stores: []
    };
    state.targets.push(state.target);

    var plan = dottedNameHandler(state.rootName, state.post.criteria.store, state.post.location, planMap);
    var useLongPolling = state.post.useLongPolling;
    var hotCaching = state.post.hotCaching;

    if (useLongPolling) {
        var interval = Math.max(50, state.post.interval);
        var timeLimit = Date.now() + state.post.timeout;
        timeLimit -= Math.max(3000, interval); // Subtracting 3000 to give us some time to return to the client.
    }

    if (hotCaching) {
        var now = Date.now();
        state.target.nextHotTranTime = now - 250;
        state.target.futureDuplicates = {};
        if (state.post.criteria.hotTranTime) {
            if (state.post.criteria.hotTranTime.$hotTranTime == 1) {
                state.post.criteria.hotTranTime = now - 250 - state.post.interval;
            }
        }
    }

    var storedPost = JSON.stringify(state.post); // Just in case a cache handler modifies it.

    if(plan && plan.length){
        state.services_ids = [];
        process(plan, 0, state, finishedProcessing);
        function finishedProcessing(){
            if (useLongPolling) {
                var noDocs = true;
                for (var i = 0; i < state.target.stores.length; i++) {
                    var store = state.target.stores[i];
                    if (store.items.length > 0)
                        noDocs = false;
                }

                if (noDocs && Date.now() <= timeLimit) {
                    setTimeout(function() {
                        if (Date.now() <= timeLimit) {
                            state.post = JSON.parse(storedPost);
                            state.target.stores.length = 0;
                            process(plan, 0, state, finishedProcessing);
                        } else {
                            finalProcessing();
                        }
                    }, interval);
                } else {
                    finalProcessing();
                }
            } else {
                finalProcessing();
            }
        }
        function finalProcessing() {
            if (hotCaching) {
                var futureDuplicates = {};
                state.target.futureDuplicates = futureDuplicates;
                for (var i = 0; i < state.target.stores.length; i++) {
                    var store = state.target.stores[i];
                    if (state.post.duplicates && state.post.duplicates[store.id])
                        removeDuplicates(store.items, state.post.duplicates[store.id]);
                    futureDuplicates[store.id] = findPotentialDuplicates(store.items, state.target.nextHotTranTime);
                }
            }
            callback(state);
        }
    } else {
        state.error('Unrecognized cache plan "' + state.post.criteria.store + '" was requested and ignored.');
        callback(state);
    }
}

// Step through each service in the plan
function process(plan,serviceIndex,state,callback){

    var serviceName = plan[serviceIndex].service;
    var service = dottedNameHandler(state.rootName, serviceName, state.post.location, serviceMap);

    // Clean up service name if it contains a reference anchor first character
    //noinspection FallthroughInSwitchStatementJS
    switch(serviceName.substr(0,1)){
        case '.':   // HTML file (current window location) relative anchor
        case '^':   // Deploy directory anchor
        case '/':   // Current application directory anchor
        case '@':   // Current application directory anchor
            serviceName = serviceName.substr(1);
    }

    service(state, serviceName, function(){
        var service_id = state.services_ids.pop();
        var subPlans = plan[serviceIndex].subPlans;
        if(subPlans && service_id && subPlans.length > 0 && service_id.ids.length > 0){
            process2(subPlans,0,state,service_id,function(){
                if(++serviceIndex < plan.length){
                    process(plan,serviceIndex,state,callback);
                } else {
                    callback();
                }
            });
        } else {
            if(++serviceIndex < plan.length){
                process(plan,serviceIndex,state,callback);
            } else {
                callback();
            }
        }
    });
}

// Step through each sub-plan in the plan
function process2(subPlans,subPlanIndex,state,service_id,callback){

    process3(subPlans, subPlanIndex, service_id, 0, state, function(){
        if(++subPlanIndex < subPlans.length){
            process2(subPlans,subPlanIndex,state,service_id,callback);
        } else {
            callback();
        }
    });
}

// Process each id, for each sub-plan, returned by the plan service
function process3(subPlans, subPlanIndex, service_id, idIndex, state, callback){

    var id = service_id.ids[idIndex];
    if( subPlans[subPlanIndex].type == "Eager" || (subPlans[subPlanIndex].type == "Active" && id == service_id.active_id)) {
        state.post.criteria[service_id.idName] = id;
        process([subPlans[subPlanIndex]], 0, state, function(){
            if(++idIndex < service_id.ids.length){
                process3(subPlans, subPlanIndex, service_id, idIndex, state, callback);
            } else {
                callback();
            }
        });
    } else {
        if(++idIndex < service_id.ids.length){
            process3(subPlans, subPlanIndex, service_id, idIndex, state, callback);
        } else {
            callback();
        }
    }
}

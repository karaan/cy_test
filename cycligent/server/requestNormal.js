/**
 * Created with JetBrains WebStorm.
 * User: Frank
 * Date: 4/17/13
 * Time: 1:18 PM
 * To change this template use File | Settings | File Templates.
 */

/**
 * Created with JetBrains WebStorm.
 * User: Frank
 * Date: 4/17/13
 * Time: 1:17 PM
 * To change this template use File | Settings | File Templates.
 */

module.exports = RequestNormal;

function RequestNormal(request){

    //this._request = request;
    this.method = request.method;
    this.headers = request.headers;
    this.url = request.url;
    // This requires that we have promoteServerVars="HTTPS" in the iisnode section of our web.config.
    this.https = request.headers['x-iisnode-https'] == "on";
}

/*
RequestNormal.prototype = {

    get method(){return this._request.method;},
    get headers(){return this._request.headers;},
    get url(){return this._request.url;}

};
*/
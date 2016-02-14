/**
 * Created with JetBrains WebStorm.
 * User: Frank
 * Date: 5/11/13
 * Time: 11:34 PM
 * To change this template use File | Settings | File Templates.
 */

var path = require("path");
var config;
process.nextTick(function() {
    config = require('./configProcess.js');
});

module.exports ={

    inject: function(state, url){

        var ext = path.extname(url);

        if(state.multipleVersions && (ext == '.html' || ext == '.htm')){
            url = url.substr(0,url.length-ext.length)
                + "-" + (state.user.version || config.version) + url.substr(url.length-ext.length)
        }

        return url;
    }
};
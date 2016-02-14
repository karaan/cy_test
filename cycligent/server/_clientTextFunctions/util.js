/**
 * Created with JetBrains WebStorm.
 * User: Frank
 * Date: 3/3/13
 * Time: 1:39 PM
 * To change this template use File | Settings | File Templates.
 */

var fs = require("fs");
var path = require("path");
var versionUtil = require("../versionUtil.js");

module.exports = {
    _cycligentCallExport: {
        import: function(state, data, callback){

            //TODO: 3. Allow recursion here so includes can call other includes - currently only works to one level!
            //TODO: 2. Should check path security here
            //TODO: 2. Should check for backward tracking urls here as well.

            if(data.path) {

                var fileName = './';

                if (data.path.substring(0, 1) == '/') {
                    fileName += versionUtil.inject(state, data.path.substring(1));
                } else {
                    fileName += path.dirname(state.request.url) + "/" + versionUtil.inject(state, data.path);
                }

                fs.readFile(fileName, 'utf8', function (err, text) {
                    if (err) {
                        state.error("/cycligent.util.import() could not find '" + fileName + "'.");
                        callback(state, "");
                    } else {
                        callback(state, text);
                    }
                });

            } else {
                callback(state, "");
            }
        }
    }
};

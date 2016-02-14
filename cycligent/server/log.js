


module.exports = Logger = (function(){

    var db;
    var collection;
    var logToConsole = true;

    return {

        dbSet: function(dbArg,logToConsoleArg){
            db = dbArg;
            logToConsole = logToConsoleArg;

            db.collection('log',function(err, collectionArg){
                if(err){ throw err; }
                collection = collectionArg;
            });

        },

        write: function(subSystem,level,message){

            if(logToConsole){

                var levelText = 'Unknown';

                switch(level){
                    case 1: levelText = 'Performance'; break;
                    case 2: levelText = 'Progress'; break;
                    case 4: levelText = 'Information'; break;
                    case 8: levelText = 'Info - Important'; break;
                    case 16: levelText = 'Warning'; break;
                    case 32: levelText = 'Error - User'; break;
                    case 64: levelText = 'Error - System'; break;
                    case 128: levelText = 'Error - Data'; break;
                    case 256: levelText = 'Error - Critical'; break;
                }

                console.log("timestamp: " + (new Date()).toUTCString() +  ", subsystem:" + subSystem + ", level:" + level + " (" + levelText + "), message: " + message);
            }

            if(collection){
                collection.insertOne({timestamp: new Date(), subsystem: subSystem, level: level, message: message},function(err){
                    if(err){
                        console.error("Unable to write to log.");
                        console.dir({timestamp: new Date(), subsystem: subSystem, level: level, message: message});
                    }
                });
            }
        }
    }

})();


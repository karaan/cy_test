/*
 The purpose
 */


module.exports = ResponseMessage;

function ResponseMessage(){
    // Do nothing for now!
}

ResponseMessage.prototype = {

    writeHead: function(status,header){
        console.error("Providers do not currently support response writes across the message bus (writeHead). Use state.targets instead.");
    },

    setHeader: function(name,value) {
        console.error("Providers do not currently support response writes across the message bus (setHeader). Use state.targets instead.");
    },

    write: function(chunk, encoding){
        console.error("Providers do not currently support response writes across the message bus (write). Use state.targets instead.");
    },

    end: function(data, encoding){
        console.error("Providers do not currently support response writes across the message bus (end). Use state.targets instead.");
    }

};
/*
    The purpose
 */



module.exports = ResponseNormal;

function ResponseNormal(response){
    this._response = response;
}

ResponseNormal.prototype = {

    writeHead: function(status,header){
        this._response.writeHead(status,header);
    },

    setHeader: function(name,value) {
        this._response.setHeader(name,value);
    },

    write: function(chunk, encoding){
        this._response.write(chunk,encoding);
    },

    end: function(data, encoding){
        this._response.end(data,encoding);
    }

};
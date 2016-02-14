/**
 * Created by JetBrains WebStorm.
 * User: Frank
 * Date: 3/31/12
 * Time: 4:11 PM
 * To change this template use File | Settings | File Templates.
 */

var cycligent = require('./cycligent.js');
var users = require('./users.js');
/**@type {CycligentMongo}*/ var cycligentMongo = require('./cycligentMongo.js');

module.exports = User;

function User(state,type,data,role,config){

    // Remember to update to UserDoc object below!
    this.type = type;
    this._db = data;

    this.role = this.roleGetById(new state.mongodb.ObjectID(role));

    // If the role from the user's cookie doesn't exist anymore, try to get the default role.
    var changedRole = false;
    if (!this.role || this.role.active == false) {
        changedRole = true;
        // Just grab the first role.
        this.role = this.roleGetFirstActive();
    }

    if (changedRole && this.role) {
        users.userChangeCurrentRole(state, this._id, this.role._id);
    }

    // If we still don't have a role, create a bare bones one.
    if (!this.role) {
        this.roles = [users.roleDocGenerate(state, "Default Role", "The default role provided at sign-up.")];
        this.role = this.roles[0];
    }

    this.versionType = (this.role.versionType ? this.role.versionType : config.versionTypeWithWebServerDynamicRequestsEnabled._id);
    this.onMain = (this.versionType == config.versionTypeWithWebServerDynamicRequestsEnabled._id);
    this.version = config.versions[this.versionType];
    this.versionExtended = this.versionType + '-' + this.version;
}

/**
 *
 * @property {ObjectID} roleCurrent
 */
User.prototype = {

    //    P R O P E R T I E S    //

    // Setup getters & setters for DB object portion

    get _id(){return this._db._id;},

    get firstName(){return this._db.firstName;},
    set firstName(value){this._db.firstName = value;},

    get middleName(){return this._db.middleName;},
    set middleName(value){this._db.middleName = value;},

    get lastName(){return this._db.lastName;},
    set lastName(value){this._db.lastName = value;},

    get skills(){return this._db.skills;},
    set skills(value){this._db.skills = value;},

    get roles(){return this._db.roles;},
    set roles(value){this._db.roles = value;},

    get config(){return this._db.config;},
    set config(value){this._db.config = value;},

    get active(){return this._db.active;},
    set active(value){this._db.active = value;},

    get modBy(){return this._db.modBy;},
    set modBy(value){this._db.modBy = value;},

    get modAt(){return this._db.modAt;},
    set modAt(value){this._db.modAt = value;},

    get modVersion(){return this._db.modVersion;},
    set modVersion(value){this._db.modVersion = value;},

    //    M E T H O D S    //

    /**
     *
     * @param {ObjectID} _id
     * @returns {UserRoleDoc|undefined}
     */
    roleGetById: function(_id){
        for(var i in this._db.roles){
            if(this._db.roles[i]._id.id == _id.id){
                return this._db.roles[i];
            }
        }

        return undefined;
    },

    /**
     * Returns the first active role.
     *
     * @returns {UserRoleDoc|undefined}
     */
    roleGetFirstActive: function() {
        for (var i = 0; i < this._db.roles.length; i++) {
            if (this._db.roles[i].active) {
                return this._db.roles[i];
            }
        }

        return undefined;
    }
};

// Documentation Override needed because of limitation with WebStorm being able to use
//
/**
 * User Object (Documentation Override)
 * @param {Object} data The user object returned from the database
 */
function UserDoc(data){

    if(data){}  // Just to prevent the inspection from firing as this is just doc code and does not actually run

    //    P R O P E R T I E S    //

    /**@type {ObjectID}*/ this._id = undefined;
    /**@type {String} */ this.type = undefined;
    /**@type {String}*/ this.firstName = undefined;
    /**@type {String}*/ this.middleName = undefined;
    /**@type {String}*/ this.lastName = undefined;
    /**@type {UserSkillDoc}*/ this.skills = undefined;
    /**@type {UserRoleDoc[]}*/ this.roles = undefined;
    /**@type {UserConfigDoc}*/ this.config = undefined;

    /**@type {UserRoleDoc}*/ this.role = undefined;

    /**@type {Boolean}*/ this.active = undefined;
    /**@type {String}*/ this.modBy = undefined;
    /**@type {Date}*/  this.modAt = undefined;
    /**@type {Number}*/ this.modVersion = undefined;


    //    M E T H O D S    //

    /**
     * Get a role object by identity
     * @param {ObjectID} _id
     * @returns {UserRoleDoc}
     */
    this.roleGetById = function(_id){if(_id){}};
}


/**
 * Role Object Documentation
 */
function UserRoleDoc(){
    this.name = '';
    this.description = '';
    this.versionType = '';
    this.authorizations = [];
    //noinspection JSUnusedGlobalSymbols
    this.teams = [];
    this.authorizationsCache = [];
    this.active = '';
}

/**
 * User Skill Object Documentation
 */
function UserSkillDoc(){

}

/**
 * Config Object Documentation
 */
function UserConfigDoc(){
    this.menuVersion = 1;
    this.itemsPerPage = 25;
    this.fontSizeModifier = 0;
    this.dropdownMouseAutoClose = true;
    this.popupMouseAutoClose = false;
}
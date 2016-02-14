cycligent.import( "cycligent.ajax" );

// @noDoc {begin}
cycligent.define( "cycligent.Session.Define", function(){
// @noDoc {end}

	cycligent.Session.dataArgs = {
		_id: {type: Number},
		appVersion: {type: String},
		user: {type: String},
		userName: {type: String},
		userFirstName: {type: String},
		userLastName: {type: String},
		role: {type: Object},
		roleName: {type: String},
        authorization: {type: String},
		skinName: {type: String, required: false, defaultValue: "default"},
		sessionTimeoutMillisecond: {type: Number, required: false , defaultValue: (cycligent.config.session.sessionTimeoutMillisecondDefault || 880000)},
		sessionWarningMillisecond: {type: Number, required: false , defaultValue: 40000},
		logoutURL: {type: String, required: false }		
	};

    cycligent.Session.roleDataArgs = {
        _id: {type: String},
        name: {type: String},
        description: {type: String},
        authorizations: {type: Object},
        authorizationsCache: {type: Object},
        teams: {type: Array},
        versionType: {type: String},
        active: {type: Boolean}
    };
	
	cycligent.Session.messageArgs = {
			_id: {type: Number},
			type: {type: Number, required: false},
			name: {type: String, required: false},
			messageAbstract: {type: String, required: false, defaultValue: ""},
			moreContent: {type: String, required: false, defaultValue: ""},
			newTill: {type: Date, required: false},
			deleteOn: {type: Date, required: false},
			popup: {type: Boolean, required: false, defaultValue: false},
			active: {type: Boolean, required: false, defaultValue: true},
			displayOrder: {type: Number, required: false, defaultValue: false}
	};

    cycligent.Session.rootsArgs = {
        _id: {type: Number},
        names: {type: Array}
    };
	
	cycligent.Session.singleton = null;
	
});

cycligent.class({
	name: "cycligent.SessionInternal",
	definition: (function(){
	
		// Private Section //
		
		var ready = false;
		var data = null;
		var timeout = 0 ;
		var timeoutWarning = 0;
		var warningIssued = false;
		var lastCom = new Date().getTime();
		var $displayElements = [];				// Index is property name, value is jQuery element
		var sessions = [];
        var roots = [];
		var gateway;
		var cache;
        var setStore;
		var sessionStore;
        var rootsStore;
		var activeCount = 0;
		var timeoutInterval;
		var roles = [];
		var rolesStore;
		var role = "";
		var fetchNotifies = [];
		var logoffNotifies = [];
        var logoffWarnNotifies = [];
        var logoffClearNotifies = [];
		var userConfigs = [];
		var userConfig = null;
        var userConfigStore;
        var messageStore;
		var messages = [];

		function fetch(){

            //TODO: 2. ***ROLES*** As the framework now passes the role in a cookie this needs to be changed / reviewed.
			var query = window.location.search.substring(1);
			var vars = query.split("&");
            role = "";
			for (var i=0;i<vars.length;i++)
			{ 
				var pair = vars[i].split(":"); 
				if (pair[0] == "role"){
					role = pair[1];
				}
			}
			
			if(role == ""){
                setStore.fetch({}, loaded);
			}else{
                setStore.fetch({authorization: {role: role}}, loaded);
			}
		}
		
		function readySet(){
			
			ready = true;

			displayAll();
			
			var index;
			var notify;
			
			for(index in fetchNotifies){
				if(!fetchNotifies.hasOwnProperty(index)) continue;

				notify = fetchNotifies[index];
				notify.notifyFunction(notify.passData);
			}
		}
			
		/* @cycligentDoc {Method}
		 * INTERNAL USE ONLY. Handles the overall health indicator display
		 * based upon the highest level or error seen by cycligentLink(cycligent.Tracer.trace).
	 	 */
		function loaded(){
            data = sessions[0];
            timeout = sessions[0].sessionTimeoutMillisecond;
            timeoutWarning = timeout - sessions[0].sessionWarningMillisecond;
            if(cycligent.config.session.server.messages){
                messageStore.fetch( {}, messageLoaded );
            }
            if (cycligent.config.session.server.roles) {
                rolesStore.fetch( {}, rolesLoaded );
            }else{if(cycligent.config.session.server.userConfig){
                userConfigStore.fetch( {}, userConfigLoaded );
            }else{
                readySet();
            }}

            if(data.appVersion != cycligent.config.appVersion){
                console.error( "The application version of " + data.appVersion +
                    " returned from the server did not match the version of " + cycligent.config.appVersion +
                    " defined by the client");
            }
		}
		
		function rolesLoaded(){

			if (cycligent.config.session.server.userConfig) {
				userConfigStore.fetch( {}, userConfigLoaded );
			}else{
				readySet();
			}
		}
			
		function userConfigLoaded(){
			userConfig = userConfigs[0];
			readySet();
		}


		function messageLoaded(){
            //TODO: 3. Not sure pushing to cycligent.console.messages makes sense anymore (need to figure out what this is really doing)
			if(cycligent.console.messages.length <= 0){
				for(var index in messages){
					if(!messages.hasOwnProperty(index)) continue;

                    //TODO: 3. Not sure pushing to cycligent.console.messages makes sense anymore (need to figure out what this is really doing)
					cycligent.console.messages.push(messages[index]);
				}			
			}
		}

		function timeoutEvent(){
			
			if(timeout == 0){ // if session fetch is not returned yet, simply return.
				return;
			}

            var index;
            var notify;
			
			var elapsedTime = new Date().getTime() - lastCom;
			
			var timeLeft = new Date(timeout - elapsedTime + 1000);
			var seconds = timeLeft.getSeconds().toString();
			if( seconds.length < 2 ){
				seconds = "0" + seconds;
			}
			
			if (elapsedTime >= timeout) {
				clearInterval(timeoutInterval);

				if ($displayElements["sessionTimeout"] && $displayElements["sessionTimeout"].length > 0){
					$displayElements["sessionTimeout"].text("0:00");
                }

                for(index in logoffNotifies){
					if(!logoffNotifies.hasOwnProperty(index)) continue;
                    notify = logoffNotifies[index];
                    notify.notifyFunction(notify.passData);
                }
			}
			else {
				if( $displayElements["sessionTimeout"] && $displayElements["sessionTimeout"].length > 0){
					$displayElements["sessionTimeout"].text(timeLeft.getMinutes() + ":" + seconds );
                }
			
				if (elapsedTime >= timeoutWarning) {
					if (!warningIssued) {
						//noinspection JSUnusedAssignment
                        warningIssued = true;
                        for(index in logoffWarnNotifies){
							if(!logoffWarnNotifies.hasOwnProperty(index)) continue;
                            notify = logoffWarnNotifies[index];
                            notify.notifyFunction(notify.passData);
                        }
					}
				}
				else {
					if (warningIssued) {
                        for(index in logoffClearNotifies){
							if(!logoffClearNotifies.hasOwnProperty(index)) continue;
                            notify = logoffClearNotifies[index];
                            notify.notifyFunction(notify.passData);
                        }
					}
					warningIssued = false;
				}
			}
		}
		
		function displayAll(){
			cycligent.args(arguments, {});
			
			for(var index in $displayElements)
			{
				if(!$displayElements.hasOwnProperty(index)) continue;

				if( index != "sessionTimeout" && $displayElements[index].length > 0){
					$displayElements[index].text(data[index]);
				}
			}
		}

		return {
		
			// Public Section //
			
			init: function(){
				cycligent.args(arguments, {});

				var me = this;
				
				me.store = "cycligent.startup.sessions";
				me.itemConstructor = cycligent.Session.Data;
				me.itemConstructorArgs = cycligent.Session.dataArgs;
				me.roleStore = "cycligent.startup.roles";
				me.roleItemConstructor = cycligent.Session.RoleData;
				me.roleItemConstructorArgs = cycligent.Session.roleDataArgs;
				me.userConfigStore = "cycligent.startup.userConfigs";
				me.userConfigConstructor = cycligent.Session.UserConfig;
				me.messageStore = "cycligent.startup.messages";
				me.messageConstructor = cycligent.Session.Message;
				me.messageConstructorArgs = cycligent.Session.messageArgs;
                me.rootsStore = "cycligent.startup.roots";
                me.rootsConstructor = cycligent.Session.Roots;
                me.rootsConstructorArgs = cycligent.Session.rootsArgs;
				
				if( cycligent.config.session.server.on ){

					gateway = cycligent.ajax.gateway;
					cache = cycligent.ajax.cache;

                    setStore = cache.register({
                        store: "cycligent.startup.set",
                        itemConstructor: {},
                        itemConstructorArgs: {}
                    });

					sessionStore = cache.register({
						store: me.store,
						itemConstructor: me.itemConstructor,
						itemConstructorArgs: me.itemConstructorArgs,
						injectionArray: sessions
					});

                    rootsStore = cache.register({
                        store: me.rootsStore,
                        itemConstructor: me.rootsConstructor,
                        itemConstructorArgs: me.rootsConstructorArgs,
                        injectionArray: roots
                    });
				}

				if (cycligent.config.session.server.timeoutOn) {
					timeoutInterval = window.setInterval(function(){
						timeoutEvent();
					}, 1000);
				}
				
				if (cycligent.config.session.server.roles) {
						
						rolesStore = cache.register({
							store: me.roleStore,
							itemConstructor: me.roleItemConstructor,
							itemConstructorArgs: me.roleItemConstructorArgs,
							injectionArray: roles
						});

					}
					
					if (cycligent.config.session.server.userConfig) {
						
						userConfigStore = cache.register({
							store: me.userConfigStore,
							itemConstructor: me.userConfigConstructor,
							injectionArray: userConfigs
						});
					}
						
					if (cycligent.config.session.server.messages) {
						
						messageStore = cache.register({
							store: me.messageStore,
							itemConstructor: me.messageConstructor,
							itemConstructorArgs: me.messageConstructorArgs,
							injectionArray: messages
						});
					}


				if( cycligent.config.session.server.on ){
                    fetch();
				}
			},

			registerFetchNotify: function(){
				var args = cycligent.args(arguments, {
					notifyFunction: {type: Function},
					passData: {type: "Any", required: false}
				});
				
				fetchNotifies.push(args);
				
				if( ready ){
					args.notifyFunction(args.passData);
				}
			},
			
			registerLogoffNotify: function(){
				var args = cycligent.args(arguments, {
					notifyFunction: {type: Function},
					passData: {type: "Any", required: false}
				});
				
				logoffNotifies.push(args);
			},

            registerLogoffWarnNotify: function(){
                var args = cycligent.args(arguments, {
                    notifyFunction: {type: Function},
                    passData: {type: "Any", required: false}
                });

                logoffWarnNotifies.push(args);
            },

            registerLogoffClearNotify: function(){
                var args = cycligent.args(arguments, {
                    notifyFunction: {type: Function},
                    passData: {type: "Any", required: false}
                });

                logoffClearNotifies.push(args);
            },

            propertyGet: function(){
				var args = cycligent.args(arguments, {
					propertyName: {type: String}
				});
				
				if( ready ){
					return data[args.propertyName];
				}
				
				throw new Error("Session not ready on propertyGet[" + args.propertyName + "].");
			},

            rolesGet: function() {
                return roles;
            },
			
			propertySet: function(){
				var args = cycligent.args(arguments, {
					propertyName: {type: String},
					propertyValue: {type: "Any", required: false}
				});
				
				if( ready ){
					data[args.propertyName] = args.propertyValue;
					if( $displayElements[args.propertyName] && $displayElements[args.propertyName].length > 0 ){
						$displayElements[args.propertyName].text(data[args.propertyName]);
					}
				}
				else{
					throw new Error("Session not ready on propertySet(" + args.propertyName + ") = " + args.propertyValue + ".");
				}
			},
			
			configGet: function(){
				var args = cycligent.args(arguments, {
					configName: {type: String}
				});
				
				if( ready ){
					return userConfig[args.configName];
				}
				
				throw new Error("Session not ready on configGet[" + args.configName + "].");
			},

            configSet: function(){
                var a = cycligent.args(arguments, {
                    configName: {type: String},
                    configValue: {type: "Any", required: false}
                });

                if( ready ){
                    userConfig[a.configName] = a.configValue;
                    //TODO: 2. We should update the server here
                    return;
                }

                throw new Error("Session not ready on configSet[" + a.configName + "].");
            },

			displaySetStandard: function(){
				cycligent.args(arguments, {});
				
				$displayElements["appVersion"] = $("#appVersion");
				$displayElements["userFirstName"] = $("#userFirstName");
				$displayElements["userLastName"] = $("#userLastName");
				$displayElements["userName"] = $("#userName");
				$displayElements["roleName"] = $("#roleName");
				$displayElements["sessionTimeout"] = $("#sessionTimeout");
				
				for(var index in $displayElements)
				{
					if(!$displayElements.hasOwnProperty(index)) continue;

					if( $displayElements[index].length < 1 ){
                        console.warn( "Session was unable to set display element for property '" + index + "'.");
					}
				}
				
				if(data){
					displayAll();
				}
			},
			
			displaySetProperty: function(){
				var args = cycligent.args(arguments, {
					propertyName: {type: String}
				});
				
				$displayElements[args.propertyName] = $("#" + args.propertyName);
				
				if( $displayElements[args.propertyName].length < 1 ){
                    console.warn( "Session was unable to set display element for property '" + args.propertyName + "'.");
				}
			},

            /**
             * Returns the roots defined on the server-side.
             *
             * If this returns null, it means the roots haven't been loaded yet.
             *
             * @returns {String[]}
             */
            rootsGet: function() {
                if (roots.length > 0)
                    return roots[0].names;
                else
                    return null;
            },
			
			logout: function(){
				if(data.logoutURL.indexOf("http://") > -1 || data.logoutURL.indexOf("https://") > -1){
					window.location =  data.logoutURL;
                }else{
					window.location = cycligent.contextRoot + data.logoutURL;
                }
			},

			isSessionDataLoaded: function(){
				return ready;
			}
			
		};
	})()
});

cycligent.class({
	name: "cycligent.Session",
	definition: {
	
		init: function(){
			var args = cycligent.args(arguments, {});
			
			var me = this;
			
			if( cycligent.Session.singleton === null ){
				//noinspection JSUnresolvedFunction
                cycligent.Session.singleton = new cycligent.SessionInternal(args);
			}
		},
		
		registerFetchNotify: function(){
			var args = cycligent.args(arguments, {
				notifyFunction: {type: Function},
				passData: {type: "Any", required: false}
			});
			
			return cycligent.Session.singleton.registerFetchNotify(args);
		},
		
		registerLogoffNotify: function(){
			var args = cycligent.args(arguments, {
				notifyFunction: {type: Function},
				passData: {type: "Any", required: false}
			});
			
			return cycligent.Session.singleton.registerLogoffNotify(args);
		},

        registerLogoffWarnNotify: function(){
            var args = cycligent.args(arguments, {
                notifyFunction: {type: Function},
                passData: {type: "Any", required: false}
            });

            return cycligent.Session.singleton.registerLogoffWarnNotify(args);
        },

        registerLogoffClearNotify: function(){
            var args = cycligent.args(arguments, {
                notifyFunction: {type: Function},
                passData: {type: "Any", required: false}
            });

            return cycligent.Session.singleton.registerLogoffClearNotify(args);
        },

        propertyGet: function(){
			var args = cycligent.args(arguments, {
				propertyName: {type: String}
			});
			
			return cycligent.Session.singleton.propertyGet(args);
		},
		
		propertySet: function(){
			var args = cycligent.args(arguments, {
				propertyName: {type: String},
				propertyValue: {type: "Any", required: false}
			});
			
			cycligent.Session.singleton.propertySet(args);
		},
		
		configGet: function(){
			var args = cycligent.args(arguments, {
				configName: {type: String}
			});
			
			return cycligent.Session.singleton.configGet(args);
		},

        configSet: function(){
            var a = cycligent.args(arguments, {
                configName: {type: String},
                configValue: {type: "Any", required: false}
            });

            return cycligent.Session.singleton.configSet(a);
        },

		isSessionDataLoaded: function(){
			return cycligent.Session.singleton.isSessionDataLoaded();
		},
		
		displaySetStandard: function(){
			var args = cycligent.args(arguments, {});
			cycligent.Session.singleton.displaySetStandard(args);
		},
		
		displaySetProperty: function(){
			var args = cycligent.args(arguments, {
				propertyName: {type: String}
			});
			
			cycligent.Session.singleton.displaySetProperty(args);
		},
		
		changeRoleAllowed: function(){
			var args = cycligent.args(arguments, {});
			return cycligent.Session.singleton.changeRoleAllowed(args);
		},
		
		logoutURLGet: function(){
			return cycligent.Session.singleton.logoutURLGet();
		},
			
		logout: function(){
			var args = cycligent.args(arguments, {});
			cycligent.Session.singleton.logout(args);
		},
		
		changeRole: function(){
            var args = cycligent.args(arguments, {
                newRole: {type: String}
            });

            if(args.newRole != this.propertyGet("role")){
                window.location = cycligent.contextRoot+"/app/usr/markup.htm?role:"+args.newRole;
            }
		}
	}
});


cycligent.class({
	name: "cycligent.Session.Data",
	definition: {
	
		init: function(){
			var args = cycligent.args(arguments, cycligent.Session.dataArgs);
			
			$.extend(this, args);
		}
	}
});

cycligent.class({
	name: "cycligent.Session.RoleData",
	definition: {
	
		init: function(){
			var args = cycligent.args(arguments, cycligent.Session.roleDataArgs);
			
			$.extend(this, args);
		}
	}
});

cycligent.class({
	name: "cycligent.Session.UserConfig",
	definition: {
	
		init: function(data) {
            // No cycligent.args because the user configuration can basically be anything.
			
			$.extend(this, data);
		}
	}
});

cycligent.class({
	name: "cycligent.Session.Message",
	definition: {
	
		init: function(){
			var args = cycligent.args(arguments, cycligent.Session.messageArgs);
			
			$.extend(this, args);
		}
	}
});

cycligent.class({
    name: "cycligent.Session.Roots",
    definition: {
        init: function() {
            var args = cycligent.args(arguments, cycligent.Session.rootsArgs);

            $.extend(this, args);
        }
    }
});
//TODO: 0. Need to update to latest version

cycligent.config = {

    appName: "Cycligent Hello World",
    appDescription: "Cycligent Hello World (C) Copyright 2014 Improvement Interactive, LLC",
    appVersion: "M.m.B",

    production: false,
    minimizeSource: false,

    startupScript: "main",

    providerUrl: cycligent.root.app + "/provider.aspx",
    providerTimeout: 34000,

    loader: {

        libs: [
            '/cycligent/client/jquery.js'
        ],

        waitFor:{
            dom: false,
            page: false
        },

        timeout: (location.hostname == "localhost" ? 2500 : 70000),

        /* APPLICATION Roots
         * Should always associate with an application, especially for cycligent names.
         */
        roots:{
            jquery: {root: "/cycligent/client", isCycligentName: false },
            cycligent: { root: "/cycligent/client" },
            app: { root: "/app/client" }
        }

    },

    debug: {
        on: true,

        doNotCatchAllExceptionsOnLocalHost: true,

        startup: true,
        scripts: false,

        private:{
            check: true,
            exception: true
        },

        args: {
            check: true,
            exception: true,
            arrays:{
                check: true,
                allElements: false
            }
        },

        interfaces: {
            check: true,
            exception: true
        }
    }
};


//TODO: 0. Need to deal with this
cycligent.config.session = {
    on: true,

    server:{
        on: true,
        timeoutOn: false,
        signOn: true,
        userConfig: true,
        messages: true,
        roles: true,
        skins: true
    },

    cookie:{
        on: false
    }
};
	

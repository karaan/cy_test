module.exports = config = {

    defaultDoc: "/app/client/hello/markup.html",

    standards: {
        getStaticTypes: {
            ".txt": {cache: true, type: 'text/plain'},
            ".js": {cache: true, type: 'application/javascript'},
            ".css": {cache: true, type: 'text/css'},
            ".png": {cache: true, type: 'image/png'},
            ".gif": {cache: true, type: 'image/gif'},
            ".jpg": {cache: true, type: 'image/jpeg'},
            ".jpeg": {cache: true, type: 'image/jpeg'},
            ".ico": {cache: true, type: 'image/vnd.microsoft.icon'},
            ".html": {cache: false, type: 'text/html'},
            ".htm": {cache: false, type: 'text/html'}
        }
    },

    roots: {
        exclude: {},

        app: {
            defaultDoc: "/app/client/hello/markup.html",
            getStaticTypes: {
                copyBlock: 'standards.getStaticTypes',
                copyOverrides: {
                    ".css": {cache: true, type: 'text/css', callSpec: {extensionExtender: '-i3i', parser: /\/\*\s*cycligentCall\s*([^(]*)\((.*?)\)\*\//}},
                    ".html": {cache: false, type: 'text/html', callSpec: {extensionExtender: '-i3i', parser: /<!--\s*cycligentCall\s*([^(]*)\((.*?)\)-->/}},
                    ".htm": {cache: false, type: 'text/html', callSpec: {extensionExtender: '-i3i', parser: /<!--\s*cycligentCall\s*([^(]*)\((.*?)\)-->/}}
                }
            },
            supports: {
                dynamicGets: true,
                provider: true,
                testSignOn: true,
                skins: false,
                sideBySideRoles: false
            },
            authenticator: null,
            anonymousPaths: [
                "/signOn",
                "/signedOn",
                "/testSignOn"
            ],
            dbs: {
                "app": {authenticatedUser: 'app', testUser: 'appTest', sessionDb: true}
            }
        },

        test: {
            defaultDoc: "/app/client/hello/markup.html",
            getStaticTypes: {
                copyBlock: 'standards.getStaticTypes',
                copyOverrides: {
                    ".css": {cache: true, type: 'text/css', callSpec: {extensionExtender: '-i3i', parser: /\/\*\s*cycligentCall\s*([^(]*)\((.*?)\)\*\//}},
                    ".html": {cache: false, type: 'text/html', callSpec: {extensionExtender: '-i3i', parser: /<!--\s*cycligentCall\s*([^(]*)\((.*?)\)-->/}},
                    ".htm": {cache: false, type: 'text/html', callSpec: {extensionExtender: '-i3i', parser: /<!--\s*cycligentCall\s*([^(]*)\((.*?)\)-->/}}
                }
            },
            supports: {
                dynamicGets: true,
                provider: true,
                testSignOn: true,
                skins: false,
                sideBySideRoles: false
            },
            authenticator: null,
            dbs: {
                "app": {anonymousUser: 'appTest', testUser: 'appTest', sessionDb: true}
            }
        },

        cycligent: {
            getStaticTypes: {
                copyBlock: 'standards.getStaticTypes'
            },
            supports: {
                provider: true
            },
            authenticator: null
        },

        iisnodelogs: {
            defaultDoc: "index.html",
            getStaticTypes: { copyBlock: 'standards.getStaticTypes' },
            supports: {},
            authenticator: null
        }
    },

    // All version types are assigned by Cycligent Builder on any build
    // Cycligent.builder.versionTypes.replace.start
    versionTypes: {
        prod: {
            version: 'M.m.B',
            webServerDynamicRequestsEnabled: true
        },
        qa: {
            version: 'M.m.B',
            webServerDynamicRequestsEnabled: false
        },
        dev: {
            version: 'M.m.B',
            webServerDynamicRequestsEnabled: false
        }
    },
    // Cycligent.builder.versionTypes.replace.end

    deployments:{
        minimal: {
            title: "Minimal Deployment",
            supports: {
                multipleVersions: false
            },
            agentDefaults: {
                probe: {enabled: false, cpuMax: 0.79},
                control: {enabled: false, certificate: 'MRmS5UymV%3gynWK'},
                instrument: {enabled: true, certificate: 'MRmS5UymV%3gynWK'}
            },
            authenticators: {
            },
            processDefaults: {
                web: {
                    inInstance: /^(cycligentCache:|cycligentQuery:|cycligentMenu:|cycligentFileCall:|cycligentCall:cycligent\.agent|cycligentCall:getName)/,
                    longWorker: /^cycligentDownload:/,
                    worker: '*'
                },
                worker: '*',
                longWorker: '*'
            },
            versionTypes: {
                common: {
                    dbs: {
                        cycligent: {
                            uri: 'mongodb://localhost:27017/cycligent',
                            options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                        },

                        app: {
                            uri: 'mongodb://localhost:27017/app',
                            options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                        },

                        appTest: {
                            uri: 'mongodb://localhost:27017/appTest',
                            options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                        }
                    }
                },
                prod: { copyBlock: 'deployments.minimal.versionTypes.common' }
            }
        },
        local: {
            title: "Local Deployment",
            supports: {
                multipleVersions: true
            },
            agentDefaults: {
                probe: {enabled: true, cpuMax: 0.79},
                control: {enabled: true},
                instrument: {enabled: true, certificate: 'MRmS5UymV%3gynWK'}
            },
            authenticators: { copyBlock: 'deployments.minimal.authenticators' },
            processDefaults: { copyBlock: 'deployments.minimal.processDefaults' },
            messageBus: {
                db: {
                    uri: 'mongodb://localhost:22199/messageBus',
                    options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                },
                collectionNames: {
                    pending: 'messages',
                    delivered: 'deliveredMessages',
                    problem: 'problemMessages'              // Channels: invalid, dead, untimely
                },
                captureDeliveries: true,
                separateProblems: true,
                expiredCleanupInterval: 1000 * 60 * 10,
                cpuMax: 0.75,
                pollDelay: 15,
                pollDelayLong: 50,
                timeout: 25 * 1000,
                messagesMax: 0
            },
            conduit: {
                enable: {server: false, controller: false},
                certificate: "MultipleHULK11:55,)CeNtURy"
            },
            versionTypes: {
                common: {
                    dbs: { copyBlock: 'deployments.minimal.versionTypes.common.dbs' }
                },
                prod: { copyBlock: 'deployments.local.versionTypes.common' },
                qa: { copyBlock: 'deployments.local.versionTypes.common' },
                dev: { copyBlock: 'deployments.local.versionTypes.common' }
            }
        },
        aws: {
            title: "AWS Deployment",
            supports: {
                multipleVersions: true
            },
            agentDefaults: {
                probe: {enabled: true, cpuMax: 0.79},
                control: {enabled: true}
            },
            authenticators: {
            },
            processDefaults: { copyBlock: 'deployments.minimal.processDefaults' },
            messageBus: {
                copyBlock: 'deployments.local.messageBus',
                copyOverrides: {
                    db: {
                        uri: 'AWS_AUTO_CONFIGURED_MONGODB/messageBus',
                        options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                    }
                }
            },
            conduit: { copyBlock: 'deployments.local.conduit' },
            versionTypes: {
                common: {
                    dbs: {
                        cycligent: {
                            uri: 'AWS_AUTO_CONFIGURED_MONGODB/cycligent',
                            options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                        },

                         app: {
                             uri: 'AWS_AUTO_CONFIGURED_MONGODB/app',
                             options: {server: {auto_reconnect: true}, replSet: {socketOptions: {keepAlive: 1}}}
                         }
                    }
                },
                prod: { copyBlock: 'deployments.aws.versionTypes.common' },
                qa: { copyBlock: 'deployments.aws.versionTypes.common' },
                dev: { copyBlock: 'deployments.aws.versionTypes.common' }
            }
        }
    }
};
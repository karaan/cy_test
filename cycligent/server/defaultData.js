var mongodb = require('mongodb');
var hypervisor = require('./hypervisor/hypervisor.js');

module.exports = {
    shared: {
        sets: function(dn, title) {
            return [
                {
                    _id : new mongodb.ObjectID("5579d80f1e68bca12b62aa62"),
                    title: title,
                    deploymentName: dn,
                    roleSpec: {
                        versionedRoles: [{
                            _id: new mongodb.ObjectID("559d521f59a680437cd0a90b"),
                            friendlyName: "prod-worker-01",
                            title: "Prod Worker 1",
                            versionType: "prod",
                            roleType: "worker",
                            workerType: "standard"
                        }, {
                            _id: new mongodb.ObjectID("559d524059a680437cd0a90f"),
                            friendlyName: "qa-worker-01",
                            title: "QA Worker 1",
                            versionType: "qa",
                            roleType: "worker",
                            workerType: "standard"
                        }, {
                            _id: new mongodb.ObjectID("559d524a59a680437cd0a910"),
                            friendlyName: "dev-worker-01",
                            title: "Dev Worker 1",
                            versionType: "dev",
                            roleType: "worker",
                            workerType: "standard"
                        }],
                        otherRoles: [{
                            _id: new mongodb.ObjectID("559d525159a680437cd0a911"),
                            friendlyName: "common-web-01",
                            title: "Web Router",
                            versionType: "common",
                            roleType: "web"
                        }, {
                            _id: new mongodb.ObjectID("559d525b59a680437cd0a912"),
                            friendlyName: "common-cyvisor-01",
                            title: "Cyvisor",
                            versionType: "common",
                            roleType: "cyvisor"
                        }, {
                            _id: new mongodb.ObjectID("559d526259a680437cd0a913"),
                            friendlyName: "common-mongo-01",
                            title: "MongoDB Server",
                            versionType: "common",
                            roleType: "mongo"
                        }, {
                            _id: new mongodb.ObjectID("559d526859a680437cd0a914"),
                            friendlyName: "common-dir-01",
                            title: "Active Directory",
                            versionType: "common",
                            roleType: "dir"
                        }]
                    },
                    machineSpec: {
                        serviceType: "ec2",
                        ami: null,
                        size: "t2.small",
                        storageType: "gp2",
                        storageSize: 100,
                        iops: null
                    },
                    machines: [
                        {
                            // Create default machine
                            _id: new mongodb.ObjectID("55863ae9c7c5ae4056fe615b"),
                            status: {
                                major: "Online",
                                minor: "Healthy",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        }
                    ]
                }
            ];
        },

        sqlSet: function(dn) {
            return [
                {
                    _id : new mongodb.ObjectID("559587a159ddac18f6923948"),
                    title: "SQL Set",
                    deploymentName: dn,
                    roleSpec: {
                        versionedRoles: [],
                        otherRoles: [{
                            _id: new mongodb.ObjectID("559d527a59a680437cd0a915"),
                            friendlyName: "common-sql-01",
                            title: "SQL Server",
                            versionType: "common",
                            roleType: "sql"
                        }]
                    },
                    machineSpec: {
                        serviceType: "rds",
                        ami: null,
                        size: "db.t2.small",
                        storageType: "gp2",
                        storageSize: 100,
                        iops: null,

                        "engine" : "postgres",
                        "engineVersion" : "9.4.1",
                        "license" : "postgresql-license"
                    },
                    machines: [
                        {
                            // Create default machine
                            _id: new mongodb.ObjectID("559586bb59ddac18f6923947"),
                            status: {
                                major: "Online",
                                minor: "Healthy",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        }
                    ]
                }
            ];
        },

        roleProcessesAnnounceForManySets: function(setDocs, roleProcessesCollection, callback) {
            var calledBack = false;
            var waitingFor = setDocs.length;

            if (waitingFor == 0) {
                callback(null);
                return;
            }

            for (var i = 0; i < setDocs.length; i++) {
                module.exports.shared.roleProcessesAnnounceForOneSet(setDocs[i], roleProcessesCollection, function(err) {
                    if (calledBack) {
                        return;
                    }

                    if (err) {
                        calledBack = true;
                        callback(err);
                        return;
                    }

                    waitingFor--;

                    if (waitingFor == 0) {
                        callback(null);
                    }
                });
            }
        },

        roleProcessesAnnounceForOneSet: function(setDoc, roleProcessesCollection, callback) {
            var machine_id = setDoc.machines[0]._id;

            var roleSpecs = setDoc.roleSpec.versionedRoles.concat(setDoc.roleSpec.otherRoles);
            var calledBack = false;
            var waitingFor = roleSpecs.length;

            var _idMap = {
                "common-web-01": new mongodb.ObjectID("5595648759ddac18f6923945"),
                "common-cyvisor-01": new mongodb.ObjectID("5595648759ddac18f6923946"),
                "prod-worker-01": new mongodb.ObjectID("559563d759ddac18f692393f"),
                "prod-long-worker-01": new mongodb.ObjectID("5595648559ddac18f6923940"),
                "canary-worker-01": new mongodb.ObjectID("5595648659ddac18f6923941"),
                "canary-long-worker-01": new mongodb.ObjectID("5595648659ddac18f6923942"),
                "qa-worker-01": new mongodb.ObjectID("5595648759ddac18f6923943"),
                "dev-worker-01": new mongodb.ObjectID("5595648759ddac18f6923944")
            };

            for (var i = 0; i < roleSpecs.length; i++) {
                var roleSpec = roleSpecs[i];

                (function() {
                    if (roleSpec.roleType == "dir" || roleSpec.roleType == "sql" || roleSpec.roleType == "mongo") {
                        waitingFor--;
                        return;
                    }

                    var commonCreateData = {
                        roleProcess_id: _idMap[roleSpec.friendlyName], // New ID will be created if not found in the map.
                        roleSpec_id: roleSpec._id,
                        friendlyName: roleSpec.friendlyName,
                        machine_id: machine_id,
                        set_id: setDoc._id,
                        roleType: roleSpec.roleType,
                        versionType: roleSpec.versionType
                    };

                    hypervisor.commonCreate2(null, commonCreateData, roleProcessesCollection, function(err) {
                        if (calledBack) {
                            return;
                        }

                        calledBack = true;
                        callback(err);
                    }, function() {
                        roleProcessesCollection.updateOne({_id: commonCreateData.roleProcess_id}, {
                            // Change status so it doesn't show up as the confusing "Pending", "Create machine"
                            $set: {
                                "status.major": "Unresponsive",
                                "status.minor": "No probes"
                            }
                        }, function(err) {
                            if (calledBack) {
                                return;
                            }

                            if (err) {
                                calledBack = true;
                                callback(err);
                                return;
                            }

                            waitingFor--;

                            //noinspection JSReferencingMutableVariableFromClosure
                            if (waitingFor == 0) {
                                callback(null);
                            }
                        });
                    });
                })();
            }

            if (waitingFor == 0) {
                callback(null);
            }
        }
    },

    local: {
        sets: function() {
            return module.exports.shared.sets("local", "Local Set").concat(module.exports.shared.sqlSet("local"));
        }
    },

    trial: {
        sets: function() {
            return module.exports.shared.sets("aws", "Trial Set");
        },

        sqlSet: function() {
            return module.exports.shared.sqlSet("aws");
        }
    },

    paid: {
        sets: function() {
            return [
                {
                    _id : new mongodb.ObjectID("5579d80f1e68bca12b62aa62"),
                    title: "Cyvisor Set",
                    deploymentName: "aws",
                    roleSpec: {
                        versionedRoles: [],
                        otherRoles: [{
                            _id: new mongodb.ObjectID("559d52b859a680437cd0a916"),
                            friendlyName: "common-cyvisor-01",
                            title: "Cyvisor",
                            versionType: "common",
                            roleType: "cyvisor"
                        }]
                    },
                    machineSpec: {
                        serviceType: "ec2",
                        ami: null,
                        size: "t2.small",
                        storageType: "gp2",
                        storageSize: 100,
                        iops: null
                    },
                    machines: [
                        {
                            // Create default machine
                            _id: new mongodb.ObjectID(),
                            status: {
                                major: "Online",
                                minor: "Healthy",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        }
                    ]
                },

                {
                    _id : new mongodb.ObjectID("5595bc9059ddac18f6923949"),
                    title: "MongoDB Set",
                    deploymentName: "aws",
                    roleSpec: {
                        versionedRoles: [],
                        otherRoles: [{
                            _id: new mongodb.ObjectID("559d52d059a680437cd0a917"),
                            friendlyName: "common-mongo-01",
                            title: "MongoDB Server",
                            versionType: "common",
                            roleType: "mongo"
                        }]
                    },
                    machineSpec: {
                        serviceType: "ec2",
                        ami: null,
                        size: "t2.small",
                        storageType: "gp2",
                        storageSize: 100,
                        iops: null
                    },
                    machines: [
                        {
                            // Create default machine
                            _id: new mongodb.ObjectID(),
                            status: {
                                major: "Online",
                                minor: "Healthy",
                                needsConfiguration: false,
                                modAt: new Date()
                            }
                        }
                    ]
                }
            ];
        }
    }
};
var readline = require('readline');
var fs = require('fs');
var forge = require('node-forge');

var Challenge = {
    textGet: function() {
        Challenge.rl.question("Challenge text: ", Challenge.textProcess);
    },

    textProcess: function(answer) {
        try {
            Challenge.body = JSON.parse(answer);
            Challenge.privateKeyNameGet();
        } catch(e) {
            console.log("There was a problem parsing your input. Error message was: " + e.message);
            console.log("Input must be valid JSON.\n");
            Challenge.textGet();
        }
    },

    privateKeyNameGet: function() {
        Challenge.rl.question("Private key name: ", Challenge.privateKeyNameProcess);
    },

    privateKeyNameProcess: function(answer) {
        fs.exists(answer, function(exists) {
            if (!exists) {
                console.log("The path provided does not exist.\n");
                Challenge.privateKeyNameGet();
            } else {
                fs.readFile(answer, function(err, data) {
                    if (err) {
                        console.log("An error occurred while trying to read the private key.");
                        console.log("Error message was: " + err.message);
                        Challenge.privateKeyNameGet();
                    } else {
                        Challenge.privateKeyText = data.toString();
                        Challenge.privateKeyPasswordGet();
                    }
                });
            }
        });
    },

    privateKeyPasswordGet: function() {
        Challenge.rl.question("Private key password (press enter if none): ", Challenge.privateKeyPasswordProcess);
    },

    privateKeyPasswordProcess: function(password) {
        if (password != "") {
            var error = false;
            try {
                Challenge.privateKey = forge.pki.decryptRsaPrivateKey(Challenge.privateKeyText, password);
                if (Challenge.privateKey == null)
                    error = true;
            } catch (e) {
                error = true;
            }

            if (error) {
                console.log("An error occurred trying to parse the private key, did you provide the correct password?");
                console.log("(note: we are expecting the private key to be in PEM format.)\n");
                Challenge.privateKeyPasswordGet();
                return;
            }
        } else {
            try {
                Challenge.privateKey = forge.pki.privateKeyFromPem(Challenge.privateKeyText);
            } catch(e) {
                console.log("An error occurred trying to parse the private key, did you mean to provide a password?");
                console.log("(note: we are expecting the private key to be in PEM format.)\n");
                Challenge.privateKeyPasswordGet();
                return;
            }
        }
        Challenge.signatureCreate();
    },

    signatureCreate: function() {
        var md = forge.md.sha256.create();
        md.update(Challenge.body.join(''), 'utf8');
        var signature = Challenge.privateKey.sign(md);
        var buf = new Buffer(signature);
        var byteArray = buf.toJSON();
        // Return value of Buffer.toJSON() is different across nodejs versions:
        if (!Array.isArray(byteArray) && byteArray.data !== undefined) {
            byteArray = byteArray.data;
        }
        var signatureStr = JSON.stringify(byteArray);

        console.log("Challenge Response:");
        // Print in a special way, because we're not sure how people will copy the text.
        var output = "";
        var line = "";
        for (var i = 0; i < signatureStr.length; i++) {
            var char = signatureStr[i];
            line += char;
            if (char == "," && line.length >= 70) {
                output += line + "\r\n";
                line = "";
            }
        }
        output += line;
        console.log(output);
        Challenge.rl.close();
    }
};

var KeyToJSON = {
    keyNameGet: function() {
        KeyToJSON.rl.question("Path to key: ", KeyToJSON.keyNameProcess);
    },

    keyNameProcess: function(answer) {
        fs.exists(answer, function(exists) {
            if (!exists) {
                console.log("The path provided does not exist.\n");
                KeyToJSON.keyNameGet();
            } else {
                fs.readFile(answer, function(err, data) {
                    if (err) {
                        console.log("An error occurred while trying to read the key.");
                        console.log("Error message was: " + err.message);
                        KeyToJSON.keyNameGet();
                    } else {
                        if (answer.substring(answer.length-4) != ".pub")
                            console.log("Filename didn't end in .pub, be sure that this is the public key you're using.");
                        console.log(JSON.stringify(data.toString()));
                        KeyToJSON.rl.close();
                    }
                });
            }
        });
    }
};

var KeyGenerate = {
    nameGet: function() {
        console.log("WARNING: If you have OpenSSL installed, it would be better to use that to\ngenerate your key instead of this.");
        console.log("Use these commands:");
        console.log("    openssl genrsa -aes256 -out mykey.pem 2048");
        console.log("    openssl rsa -in mykey.pem -pubout > mykey.pub");
        console.log("You can then call this with the 'keytojson' directive instead of the 'keygen'\ndirective to get the JSON form of your public key for config.js.\n");
        KeyGenerate.rl.question("Name to save keypair as (will save .pub and .pem versions): ", KeyGenerate.nameProcess);
    },

    nameProcess: function(answer) {
        if (answer.length == 0) {
            console.log("Name can't be blank.\n");
            KeyGenerate.nameGet();
        } else {
            KeyGenerate.keyBaseName = answer;
            KeyGenerate.passwordGet();
        }
    },

    passwordGet: function() {
        KeyGenerate.rl.question("Password for private key (just press enter for none): ", KeyGenerate.passwordProcess);
    },

    passwordProcess: function(answer) {
        KeyGenerate.keyPassword = answer;
        KeyGenerate.keyGenerate();
    },

    keyGenerate: function() {
        console.log("Generating your key pair, this may take a moment.");
        var keypair = forge.pki.rsa.generateKeyPair({bits: 2048});
        console.log("Done.");
        var privateKeyText;
        if (KeyGenerate.keyPassword != '')
            privateKeyText = forge.pki.encryptRsaPrivateKey(keypair.privateKey, KeyGenerate.keyPassword);
        else
            privateKeyText = forge.pki.privateKeyToPem(keypair.privateKey);
        var publicKeyText = forge.pki.publicKeyToPem(keypair.publicKey);
        var privateKeyFilename = KeyGenerate.keyBaseName + ".pem";
        var publicKeyFilename = KeyGenerate.keyBaseName + ".pub";

        fs.writeFile(publicKeyFilename, publicKeyText, function(err) {
            if (err) {
                console.log("An error occurred while saving the public key as '" + publicKeyFilename + "'. Error message was: " + err.message);
                KeyGenerate.rl.close();
            } else {
                console.log("Wrote " + publicKeyFilename + " to disk.");
                fs.writeFile(privateKeyFilename, privateKeyText, function(err) {
                    if (err) {
                        console.log("An error occurred while saving the private key as '" + privateKeyFilename + "'. Error message was: " + err.message);
                        KeyGenerate.rl.close();
                    } else {
                        console.log("Wrote " + privateKeyFilename + " to disk.");
                        console.log("JSON string of public key (put this in config.js):");
                        console.log(JSON.stringify(publicKeyText));
                        KeyGenerate.rl.close();
                    }
                });
            }
        });
    }
};

var args = process.argv.slice(0);
if (args[3] === undefined) {
    console.log("Cycligent Agent Utilities");
    console.log("usage: node server.js -agent [DIRECTIVE]\n");
    console.log("These are the possible directives:");
    console.log("    challenge - Using your private key, create a valid response to a\n"
              + "                Cycligent Agent challenge.");
    console.log("    keyToJSON - Print out a public key as a JSON string to put in config.js.");
    console.log("    keygen - Generate a keypair for use with Cycligent Agent.");
    process.exit(0);
} else if (args[3].toLowerCase() == "challenge") {
    Challenge.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    Challenge.textGet();
} else if (args[3].toLowerCase() == "keytojson") {
    KeyToJSON.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    KeyToJSON.keyNameGet();
} else if (args[3].toLowerCase() == "keygen") {
    KeyGenerate.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    KeyGenerate.nameGet();
} else {
    console.log("Unknown agent command '" + args[3] + "'");
    process.exit(0);
}
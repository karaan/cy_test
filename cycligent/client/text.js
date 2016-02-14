/* @cycligentDoc {Object}
 * Provides text selection, parsing and formatting capabilities.
 */

//TODO: 4. Automated tests

cycligent.text = {

    selection: {	//@cycligentDoc {Property:Object} Provides text selection capabilities.

        /* @cycligentDoc {Method}
         * Sets the text selection of the specified input control
         * to the start and end values provided.
         */
        set: function(){
            var args = cycligent.args(arguments, {
                input: {type: "HtmlElement"},		// The input control whose text is to be selected.
                start: {type: Number},					// The starting character offset (zero-based) of the selection.
                end: {type: Number},					// The ending character offset (zero-based) of the selection.
                selectData: {type: Boolean, required: false, defaultValue: true} // if false, the field will not be selected.
            });

            if( cycligent.browser.ie ){
//				var range = args.input.createTextRange();
//				range.collapse(true);
//				range.moveStart("character", args.start);
//				range.moveEnd("character", args.end - args.start);
//				if(args.selectData){
//					range.select();
//				}
                if (args.input.setSelectionRange) {
                    if(args.selectData){
                        args.input.focus();
                        args.input.setSelectionRange(args.start, args.start);
                    }
                }
                else if (args.input.createTextRange) {
                    var range = args.input.createTextRange();
                    range.collapse(true);
                    range.moveEnd('character', args.end);
                    range.moveStart('character', args.start);
                    if(args.selectData){
                        range.select();
                    }
                }
            }
            else{
                try {
                    args.input.setSelectionRange( args.start, args.end );
                } catch (e) {
                }
            }
        },

        /* @cycligentDoc {Method}
         * Moves the cursor to the start of the text in the input control.
         */
        gotoStart: function(){
            var args = cycligent.args(arguments, {
                input: {type: "HtmlElement:input"}	// The input control to set the cursor at the start of.
            });

            if( cycligent.browser.ie ){
                var range = document.selection.createRange();
                var range2 = range.duplicate();
                return 0 - range2.moveStart('character',-100000);
            }
            else{
                try {
                    if (args.input.selectionStart) {
                        return args.input.selectionStart;
                    } else {
                        return 1;
                    }
                } catch (e) {
                    return 1;
                }
            }
        },

        /* @cycligentDoc {Method}
         * Moves the cursor to the end of the text in the input control.
         */
        gotoEnd: function(){
            var args = cycligent.args(arguments, {
                input: {type: "HtmlElement:input"}	// The input control to set the cursor at the end of.
            });

            if( cycligent.browser.ie ){
                var range = document.selection.createRange();
                var range2 = range.duplicate();
                var start = 0 - range2.moveStart('character',-100000);
                //noinspection JSUnresolvedVariable
                return start + range.text.Length;
            }
            else{
                return args.input.selectionEnd;
            }
        }
    },

    xml: {   //@cycligentDoc {Property:Object} Provides xml encoding/decoding functionality.

        /* @cycligentDoc {Method}
         * Encodes a string for XML.
         */
        encode: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}	// The value to encode.
            });

            var returnValue = args.value.replace(/&/g,"&amp;");
            returnValue = returnValue.replace(/'/g,"&apos;");
            returnValue = returnValue.replace(/"/g,"&quot;");
            returnValue = returnValue.replace(/</g,"&lt;");
            returnValue = returnValue.replace(/>/g,"&gt;");

            return returnValue;
        },

        /* @cycligentDoc {Method}
         * Decodes an XML string.
         */
        decode: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}	// The value to decode.
            });

            var returnValue = args.value.replace(/&amp;/g,"&");
            returnValue = returnValue.replace(/&apos;/g,"'");
            returnValue = returnValue.replace(/&quot;/g,'"');
            returnValue = returnValue.replace(/&lt;/g,"<");
            returnValue = returnValue.replace(/&gt;/g,">");

            return returnValue;
        }

    },

    number: {	//@cycligentDoc {Property:Object} Provides money parsing and formatting functionality.

        /* @cycligentDoc {Method}
         * Formats a money value.
         */
        format: function(){
            var args = cycligent.args(arguments, {
                value: {type: Number},	// The value to be formatted.
                decimals: {type: Number, required: false, defaultValue: 2}, // The number of digits following the decimal point.
                commas: {type: Boolean, required: false, defaultValue: true}  // When true, commas are inserted every third digit to the left of the decimal point. When false, no commas are inserted into the output.
            });

            // Eliminate -0.00
            if( Math.abs(args.value) < 0.005 ){
                args.value = 0;
            }

            var textOut = parseFloat(args.value).toFixed(args.decimals);

            if( args.commas ){
                var split = textOut.split('.');
                var whole = split[0];
                var fraction = split[1];

                var regEx = /(\d+)(\d{3})/;

                while( regEx.test(whole) ){
                    whole = whole.replace( regEx, '$1' + ',' + '$2');
                }

                textOut = whole;

                if(fraction){
                    textOut += "." + fraction
                }
            }

            return textOut;

        },

        /* @cycligentDoc {Method}
         * Parses text returning a value.
         *
         * @Remarks
         * Will parse strings containing commas, as well as strings
         * that do not contain commas.
         */
        parse: function(){
            var args = cycligent.args(arguments, {
                text: {type: String}	// The text to parse.
            });

            return parseFloat( args.text.replace( /,/g,"" ) );
        },

        round: function(){
            var args = cycligent.args(arguments, {
                num: {type: Number},	// The  number to round up.
                decimals: {type: Number, required: false, defaultValue: 2} // The number of number of decimal points.
            });

            return Math.round(args.num * Math.pow(10,  args.decimals)) / Math.pow(10,  args.decimals);
        }
    },

    date: { //@cycligentDOC {Property:Object} Provides date parsing and formatting functionality.

        /* @cycligentDoc {Method}
         * Formats a date value.
         */
        format: function(){
            var args = cycligent.args(arguments, {
                value: {type: Date},	// The value to be formatted.
                format: {type: String, required: false, defaultValue: "mm/dd/yy"}	// The format template to use in formatting the value.
            });

            var value = args.value;

            var textOut = args.format;

            var day = value.getDate().toString();
            var month = (value.getMonth() + 1).toString();
            var year = value.getFullYear().toString();

            if( textOut.indexOf("dd") >= 0 ){
                if( day.length < 2 ){
                    day = "0" + day;
                }
                textOut = textOut.replace(/dd/,day);
            }

            if( textOut.indexOf("d") >= 0 ){
                textOut = textOut.replace(/d/,day);
            }

            if( textOut.indexOf("mm") >= 0 ){
                if( month.length < 2 ){
                    month = "0" + month;
                }
                textOut = textOut.replace(/mm/,month);
            }

            if( textOut.indexOf("m") >= 0 ){
                textOut = textOut.replace(/m/,month);
            }

            if( textOut.indexOf("yyyy") >= 0 ){
                textOut = textOut.replace(/yyyy/,year);
            }

            if( textOut.indexOf("yy") >= 0 ){
                year = year.substr(2);
                textOut = textOut.replace(/yy/,year);
            }

            return textOut;

        },

        /* @cycligentDoc {Method}
         * Parses text returning a value.
         *
         * @Remarks
         * Will parse strings containing commas, as well as strings
         * that do not contain commas.
         */
        parse: function(){
            var args = cycligent.args(arguments, {
                text: {type: String}	// The text to parse.
            });

            var text = args.text;

            text = text.replace(/-/g,"/");
            text = text.replace(/\./g,"/");
            text = text.replace(/\\/g,"/");

            if( text.indexOf("/") < 0 ){
                if( text.length < 6 ){
                    text = text.substr(0,2) + "/" + text.substr(2);
                }
                else{
                    text = text.substr(0,2) + "/" + text.substr(2,2) + "/" + text.substr(4);
                }
            }

            var components = text.split("/");

            var month = components[0];
            var day = components[1];
            var year = components[2];

            if( !year ){
                year = "";
            }

            if( !day ){
                return undefined;
            }

            if(year.length == 1){
                year = "0" + year;
            }

            if( year.length < 2 ){
                year = (new Date()).getFullYear();
            }
            else if( year.length < 4){
                year = (new Date()).getFullYear().toString().substr(0,2) + year;
            }

            var returnValue = new Date(month + "/" + day + "/" + year);


            if( !isNaN(returnValue) ){
                var iMonth = parseInt(month,10) - 1;
                var iDay = parseInt(day,10);
                var iYear = parseInt(year,10);
                if((iMonth == returnValue.getMonth()) && (iDay == returnValue.getDate()) && (iYear == returnValue.getFullYear())){
                    return returnValue;
                }else{
                    return undefined;
                }
            }
        }

    },

    validate:{  //@cycligentDoc {Property:Object} Provides text validation (using Regular expression) functionality.

        generic: function(){
            var args = cycligent.args(arguments,{
                value: {type: String},  	// String to validate.
                pattern: {type: String}	// Regular expression pattern used to validate.
            });

            var regExp = new RegExp(args.pattern);

            return regExp.test(args.value);
        },

        postalCode: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// Postal code to validate. 99999 or 99999-9999
            });

            return /(^\d{5}$)|(^\d{5}-\d{4}$)/.test(args.value);
        },

        phone: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// Phone to validate. 9999999999 or 999-999-9999 or (999) 999-9999
            });

            return /^(\([2-9]|[2-9])(\d{2}|\d{2}\))(-|.|\s)?\d{3}(-|.|\s)?\d{4}$/.test(args.value);
        },

        newPhone: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// Phone to validate. Only (999) 999-9999 . This is the standard format required for rms
            });

            return /^[0-9]{3}-[0-9]{3}-[0-9]{4}$/.test(args.value);
        },

        ssn: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// Social Security Number to validate. 999999999 or 999 99 9999 or 999-99-9999
            });

            return /^(?!000)([0-6]\d{2}|7([0-6]\d|7[012]))([ -]?)(?!00)\d\d\3(?!0000)\d{4}$/.test(args.value);
        },

        emailAddress: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// Email Address to validate.
            });

            return /^([A-Za-z0-9_\-\.])+\@([A-Za-z0-9_\-\.])+\.([A-Za-z]{2,4})$/.test(args.value);
        },

        time: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// time
            });

            return /^([0-1][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/.test(args.value);
        },

        timeWith12Hours: function(){
            var args = cycligent.args(arguments,{
                value: {type: String}		// time
            });

            return /^([0][1-9]|[1][0-2]):([0-5][0-9]) ([^ap][^pm])$/.test(args.value);
        }

    }
};

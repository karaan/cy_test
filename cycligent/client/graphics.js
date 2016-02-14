
/* =============== STANDARDS ===============

    In this file the following standards apply:

    - a. ALWAYS accesses the arguments passed to the function (see cycligent.args)
    - c. ALWAYS accesses the graphics context
    - s. ALWAYS accesses the cached settings of the object type

    xxxxSet
    xxxxFast
    xxxx

*/

cycligent.class({
    name: "cycligent.Graphics",
    definition: {

        init: function(){
            var a = cycligent.args(arguments,{
                $canvas: {type: jQuery}
            });
            var me = this;

            $.extend(me,a);

            me.context = me.$canvas[0].getContext("2d");

            me.x = 0;
            me.y = 0;

            me.lineSettings = {
                style: "black",
                width: 1,
                cap: "butt"
            };
            
            me.rectSettings = {
                fillStyle: "black",
                borderStyle: "black",
                borderWidth: 1
            };
            
            me.circleSettings = {
                fillStyle: "black",
                borderStyle: "black",
                borderWidth: 1,
                endAngle: 2 * Math.PI
            };
        },

        set: function(){
            var a = cycligent.args(arguments,{
                fillStyle: {type: "Any", required: false, defaultValue: "black"},
                borderStyle: {type: "Any", required: false, defaultValue: "black"},
                borderWidth: {type: Number, required: false, defaultValue: 1}
            });
            var me = this;
            var c = me.context;

            if(a.fillStyle){
                c.fillStyle = a.fillStyle;
            }

            if(a.borderStyle){
                c.strokeStyle = a.borderStyle;
                if(a.borderWidth || a.borderWidth == 0){
                    c.lineWidth = a.borderWidth;
                }
            }
        },

        beginPath: function(){
            var a = cycligent.args(arguments,{});
            var me = this;
            var c = me.context;

            c.beginPath();
        },

        moveTo: function(x,y){
            var a = cycligent.args(arguments,{
                x: {type: Number},
                y: {type: Number}
            });
            var me = this;
            var c = me.context;

            var xDelta = 0;
            var yDelta = 0;

            if(c.lineWidth % 2 == 1 && Math.abs(me.x - a.x) < .5){
                xDelta = .5;
            }

            if(c.lineWidth % 2 == 1 && Math.abs(me.y - a.y) < .5){
                yDelta = .5;
            }

            c.moveTo(a.x + xDelta, a.y + yDelta);
        },

        lineTo: function(x,y){
            var a = cycligent.args(arguments,{
                x: {type: Number},
                y: {type: Number}
            });
            var me = this;
            var c = me.context;

            var xDelta = 0;
            var yDelta = 0;

            if(c.lineWidth % 2 == 1 && Math.abs(me.x - a.x) < .5){
                xDelta = .5;
            }

            if(c.lineWidth % 2 == 1 && Math.abs(me.y - a.y) < .5){
                yDelta = .5;
            }

            c.lineTo(a.x + xDelta, a.y + yDelta);
        },

        stroke: function(style){
            var me = this;
            var c = me.context;

            if( style ){
                c.strokeStyle = style;
            }

            c.stroke();
        },

        fill: function(style){
            var me = this;
            var c = me.context;

            if( style ){
                c.fillStyle = style;
            }

            c.fill();
        },

        lineSet: function(){
            var a = cycligent.args(arguments,{
                style: {type: "Any", required: false, defaultValue: "black"},
                width: {type: Number, required: false, defaultValue: 1.0},
                cap: {type: String, required: false, defaultValue: "butt"}
            });    
            var me = this;
            var c = me.context;
          
            $.extend(me.lineSettings, a);
            
            c.strokeStyle = a.style;
            c.lineWidth = a.width;
            c.lineCap = a.cap;
        },
        
        lineFast: function(){
            var a = cycligent.args(arguments,{
                x1: {type: Number},
                y1: {type: Number},
                x2: {type: Number},
                y2: {type: Number}
            });    
            var me = this;
            var c = me.context;

            c.beginPath();

            var x1Delta = 0;
            var y1Delta = 0;
            var x2Delta = 0;
            var y2Delta = 0;

            if(c.lineWidth % 2 == 1 && Math.abs(a.x1 - a.x2) < .5){
                x1Delta = .5;
                x2Delta = .5;
            }

            if(c.lineWidth % 2 == 1 && Math.abs(a.y1 - a.y2) < .5){
                y1Delta = .5;
                y2Delta = .5;
            }
            //console.log("line start: (" + start.x + "," + start.y + ")   end: (" + end.x + "," + end.y + ")   width: " + args.width);
            //console.log(" fix start: (" + start.newDelta(x1Delta,y1Delta).x + "," + start.newDelta(x1Delta,y1Delta).y + ")   end: (" + end.newDelta(x2Delta,y2Delta).x + "," + end.newDelta(x2Delta,y2Delta).y + ")   width: " + args.width);

            c.moveTo(a.x1 + x1Delta, a.y1 + y1Delta);
            c.lineTo(a.x2 + x2Delta, a.y2 + y2Delta);
            c.stroke();

            me.x = a.x2;
            me.y = a.y2;
        },

        line: function(){
            var a = cycligent.args(arguments,{
                x1: {type: Number},
                y1: {type: Number},
                x2: {type: Number},
                y2: {type: Number},
                style: {type: "Any", required: false, defaultValue: "black"},
                width: {type: Number, required: false, defaultValue: 1.0},
                cap: {type: String, required: false, defaultValue: "butt"}
            });
            var me = this;

            me.lineSet({
                style: a.style,
                width: a.width,
                cap: a.cap
            });

            me.lineFast({
                x1: a.x1,
                y1: a.y1,
                x2: a.x2,
                y2: a.y2
            });
        },

        rectSet: function(){
            var a = cycligent.args(arguments,{
                fillStyle: {type: "Any", required: false, defaultValue: "black"},
                borderStyle: {type: "Any", required: false, defaultValue: "black"},
                borderWidth: {type: Number, required: false, defaultValue: 1}
            });
            var me = this;

            $.extend(me.rectSettings, a);

            me.set(a);
        },

        rectFast: function(){
            var a = cycligent.args(arguments,{
                left: {type: Number},
                top: {type: Number},
                width: {type: Number},
                height: {type: Number}
            });
            var me = this;
            var c = me.context;
            var s = me.rectSettings;

            if(s.fillStyle){
                c.fillRect(a.left, a.top, a.width, a.height);
            }

            if(s.borderStyle){
                c.strokeRect(a.left + c.lineWidth / 2, a.top + c.lineWidth / 2, a.width - c.lineWidth, a.height - c.lineWidth);
            }

            me.x = a.left;
            me.y = a.top;
        },

        rect: function(center,width,height){
            var a = cycligent.args(arguments,{
                left: {type: Number},
                top: {type: Number},
                width: {type: Number},
                height: {type: Number},
                fillStyle: {type: "Any", required: false, defaultValue: "black"},
                borderStyle: {type: "Any", required: false, defaultValue: "black"},
                borderWidth: {type: Number, required: false, defaultValue: 1}
            });
            var me = this;

            me.rectSet({
                fillStyle: a.fillStyle,
                borderStyle: a.borderStyle,
                borderWidth: a.borderWidth
            });

            me.rectFast({
                left: a.left,
                top: a.top,
                width: a.width,
                height: a.height
            });
        },

        circleSet: function(){
            var a = cycligent.args(arguments,{
                fillStyle: {type: "Any", required: false, defaultValue: "black"},
                borderStyle: {type: "Any", required: false, defaultValue: "black"},
                borderWidth: {type: Number, required: false, defaultValue: 1}
            });
            var me = this;

            $.extend(me.circleSettings, a);

            me.set(a);
        },

        circleFast: function(){
            var a = cycligent.args(arguments,{
                left: {type: Number},
                top: {type: Number},
                size: {type: Number}
            });
            var me = this;
            var c = me.context;
            var s = me.circleSettings;

            var radius = a.size / 2;

            var x = a.left + radius;
            var y = a.top + radius;

            if(s.fillStyle){
                c.beginPath();
                c.arc(x, y, radius, 0, s.endAngle, false);
                c.fill();
            }

            if(s.borderStyle){
                c.beginPath();
                c.arc(x, y, radius - s.borderWidth / 2, 0, s.endAngle, false);
                c.stroke();
            }

            me.x = a.left;
            me.y = a.top;
        },

        circle: function(){
            var a = cycligent.args(arguments,{
                left: {type: Number},
                top: {type: Number},
                size: {type: Number},
                fillStyle: {type: "Any", required: false, defaultValue: "black"},
                borderStyle: {type: "Any", required: false, defaultValue: "black"},
                borderWidth: {type: Number, required: false, defaultValue: 1}
            });
            var me = this;

            me.circleSet({
                fillStyle: a.fillStyle,
                borderStyle: a.borderStyle,
                borderWidth: a.borderWidth
            });

            me.circleFast({
                left: a.left,
                top: a.top,
                size: a.size
            });
        },

        textSet: function(){
            var a = cycligent.args(arguments,{
                family: { type: String, required: false, defaultValue: "Verdana" },
                size: { type: String, required: false, defaultValue: "11px" },
                style: { type: "Any", required: false, defaultValue: "black"},
                weight: { type: String, required: false, defaultValue: "normal" },
                align: { type: String, required: false, defaultValue: "start" },
                baseline: {type: String, required: false, defaultValue: "alphabetic" }
            });
            var me = this;
            var c = me.context;

            $.extend(me.textSettings, a);

            c.font = a.weight + " " + a.size + " " + a.family;
            c.fillStyle = a.style;
            c.textAlign = a.align;
            c.textBaseline = a.baseline;
        },

        textFast: function(){
            var a = cycligent.args(arguments,{
                text: {type: String},
                x: {type: Number},
                y: {type: Number},
                maxWidth: {type: Number, required: false}
            });
            var me = this;
            var c = me.context;

            if(a.maxWidth){
                c.fillText(a.text, a.x, a.y, a.maxWidth);
            } else {
                c.fillText(a.text, a.x, a.y);
            }

            me.x = a.x;
            me.y = a.y;
        },

        text: function(){
            var a = cycligent.args(arguments,{
                text: {type: String},
                x: {type: Number},
                y: {type: Number},
                maxWidth: {type: Number, required: false},
                family: { type: String, required: false, defaultValue: "Verdana" },
                size: { type: String, required: false, defaultValue: "11px" },
                style: { type: "Any", required: false, defaultValue: "black"},
                weight: { type: String, required: false, defaultValue: "normal" },
                align: { type: String, required: false, defaultValue: "start" },
                baseline: {type: String, required: false, defaultValue: "alphabetic" }
            });
            var me = this;

            me.textSet({
                family: a.family,
                size: a.size,
                style: a.style,
                weight: a.weight,
                align: a.align,
                baseline: a.baseline
            });

            me.textFast({
                text: a.text,
                x: a.x,
                y: a.y,
                maxWidth: a.maxWidth
            });
        }
    }
});

cycligent.class({
    name: "cycligent.Graphics.Image",
    definition: {
        init: function(){
            var a = cycligent.args(arguments,{
                source: {type: String},
                width: {type: Number},
                height: {type: Number},
                padding: {type: Number, required: false, defaultValue: 4}
            });
            var me = this;

            $.extend(me,a);

            me.image = new Image();
            me.loadPending = true;
            me.drawPending = false;
            me.left = undefined;
            me.top = undefined;

            me.image.onload = function(){
                me.loadPending = false;
                if(me.drawPending){
                    me.draw(me.graphics, me.left, me.top);
                }
            };

            me.image.src = a.source;
        },

        draw: function(){
            var a = cycligent.args(arguments,{
                graphics: {type: cycligent.Graphics},
                left: {type: Number},
                top: {type: Number}
            });
            var me = this;

            if(me.loadPending){
                $.extend(me,a);
                me.drawPending = true;
            } else {
                a.graphics.context.drawImage(me.image, a.left, a.top);
            }

            a.graphics.x = a.left;
            a.graphics.y = a.top;
        }
    }
});


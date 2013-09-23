$ = jQuery;

var port = self.port,
    data = null,
    storage = null;

const RE_LEX_ANCHOR = /var\s(\w)=\{eventName:.*?,eventSrc:.*?,payload:.*?\},\w=.*?;/i;

var EventHelper = (function() {
    function getPrefix(obj) {
        if(obj.eventPrefix === null) {
            return 'GMS.Unknown';
        }

        return obj.eventPrefix;
    }

    return {
        trigger: function (obj, eventType, extraParameters) {
            if(obj.$object === undefined) {
                return;
            }

            obj.$object.trigger(getPrefix(obj) + '.' + eventType, extraParameters);
        },
        bind: function (obj, eventType, eventData, handler) {
            if(obj.$object === undefined) {
                return;
            }

            obj.$object.bind(getPrefix(obj) + '.' + eventType, eventData, handler);
        }
    };
})();

var GMS = (function(port) {
    this.eventPrefix = 'GMS';
    this.ownerDocument = document;

    port.on('gms.construct', function(data) {
        EventHelper.trigger(GMS, 'construct', [data, data.storage !== undefined ? data.storage : {}]);
    });

    return {
        $object: $(this),

        bind: function(eventType, eventData, handler) {
            EventHelper.bind(GMS, eventType, eventData, handler);
        }
    };
})(self.port);

GMS.LoadingMonitor = (function() {
    this.eventPrefix = 'GMS.LoadingMonitor';
    this.ownerDocument = document;

    $('#loading-progress').attrmonitor({
        attributes: ['style'],
        callback: function(event) {
            if(event.attribute == 'style' &&
                event.value !== null &&
                event.value.replace(' ', '').indexOf('display:none;') !== -1)
            {
                EventHelper.trigger(GMS.LoadingMonitor, 'loaded');
                $('#loading-progress').attrmonitor('destroy');
            }
        }
    });

    return {
        $object: $(this),

        bind: function(eventType, eventData, handler) {
            EventHelper.bind(GMS.LoadingMonitor, eventType, eventData, handler);
        }
    };
})();

GMS.SliderMonitor = (function() {
    this.eventPrefix = 'GMS.SliderMonitor';
    this.ownerDocument = document;

    var sliderMin = null,
        sliderMax = null;

    function change(event) {
        if(event.attribute == 'aria-valuenow') {
            EventHelper.trigger(GMS.SliderMonitor, 'positionChange', [sliderMin, sliderMax, event.value]);
        } else if(event.attribute == 'aria-valuemin') {
            sliderMin = event.value;
        } else if(event.attribute == 'aria-valuemax') {
            sliderMax = event.value;
        }
    }

    GMS.LoadingMonitor.bind('loaded', function() {
        $('#slider').attrmonitor({
            attributes: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'],
            interval: 1000,
            start: false,
            callback: change
        });
    });

    return {
        $object: $(this),

        bind: function(eventType, eventData, handler) {
            EventHelper.bind(GMS.SliderMonitor, eventType, eventData, handler);
        }
    };
})();

GMS.HookManager = (function(port) {
    var parent = null,
        dependant_scripts = null;

    function insert_lex_hook(lex_data) {
        var match = RE_LEX_ANCHOR.exec(lex_data);
        var slice_start = match.index + match[0].length;

        var head = lex_data.slice(0, slice_start);
        var tail = lex_data.slice(slice_start, lex_data.length);

        return head + "if(window.gms_event !== undefined){window.gms_event(" + match[1] + ");}" + tail;
    }

    function create_lex(lex_data) {
        var node = document.createElement("script");
        node.type = "text/javascript";
        node.text = insert_lex_hook(lex_data);

        return node;
    }

    function rebuild(lex_data) {
        console.log('Rebuilding client...');

        // Re-insert new lex and dependant scripts into the document
        parent.appendChild(create_lex(lex_data));

        for(var i = 0; i < dependant_scripts.length; i++) {
            parent.appendChild(dependant_scripts[i]);
        }

        console.log('Client rebuilt, finished.')
    }

    function setup(data) {
        console.log("Using \"" + data.lex_location + "\" url for listen_extended");

        var lex_node = $('script[blocked=true]')[0];
        parent = lex_node.parentNode;

        // Pull out all the following dependant script nodes
        dependant_scripts = [];

        var cur = lex_node.nextSibling;
        while(cur != null) {
            if(cur.tagName == 'SCRIPT') {
                dependant_scripts.push(cur);
                parent.removeChild(cur);
            }
            cur = cur.nextSibling;
        }
        console.log('pulled out ' + dependant_scripts.length + ' dependant script nodes');

        // Remove lex node from the document
        parent.removeChild(lex_node);

        // Request lex script, then rebuild the client
        console.log('Requesting lex...');

        port.emit('gms.lex_request', {
            url: data.lex_location
        });

        port.once('gms.lex_response', rebuild);
    }

    GMS.bind('construct', function(event, data) {
        setup(data);
    });

    return {};
})(self.port);

GMS.Scrobbler = (function(lastfm) {
    var current = null,
        playing = false,
        currentTimestamp = null,
        currentSubmitted = false;

    function unpack_song(song) {
        song = song.a;

        return {
            title: song[1],
            album: song[4],
            artist: song[3],
            albumArtist: song[3], // TODO fix this
            track: song[14],
            durationMillis: song[13]
        }
    }

    function setPlayingState(value) {
        if(value === undefined) {
            value = !playing;
        }
        playing = value;

        if(playing == true) {
            $('#slider').attrmonitor('start');
            lastfm.track.updateNowPlaying();
        } else if(playing == false) {
            $('#slider').attrmonitor('stop');
        }
    }

    GMS.SliderMonitor.bind('positionChange', function(min, max, now) {
        if(current === null || currentSubmitted) {
            return;
        }

        // Ignore songs shorter than 30 seconds
        if(max < 30 * 1000) {
            return;
        }

        var perc = now / max;

        // If over 50% played, submit it
        if(perc >= .50) {
            lastfm.track.scrobble();
            currentSubmitted = true;
        }
    });

    document.documentElement.addEventListener('gm.playPause', function() {
        setPlayingState();
    });

    document.documentElement.addEventListener('gm.playSong', function(event) {
        console.log('gm.playSong');

        if(event.detail !== null && event.detail.song !== undefined) {
            current = unpack_song(event.detail.song);
            currentTimestamp = Math.round(new Date().getTime() / 1000);
            currentSubmitted = false;

            console.log('    title: ' + current.title);
            console.log('    album: ' + current.album);
            console.log('    artist: ' + current.artist);
            console.log('    albumArtist: ' + current.albumArtist);
            console.log('    track: ' + current.track);
            console.log('    durationMillis: ' + current.durationMillis);

            setPlayingState(true);
        }
    });

    return {};
})(lastfm);

// Addon (main.js) events
port.on('gms.construct', function(_data) {
    data = _data;
    storage = data.storage;

    // INSERT page.js
    $('body').append('<script type="text/javascript" src="' + data.pageUrl + '"></script>');
});
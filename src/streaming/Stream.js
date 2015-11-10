/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import LiveEdgeFinder from './LiveEdgeFinder.js';
import MediaPlayer from './MediaPlayer.js';
import BufferController from './controllers/BufferController.js';
import RepresentationController from '../dash/controllers/RepresentationController.js';
import ProtectionController from './controllers/ProtectionController.js';
import MediaController from './controllers/MediaController.js';
import EventBus from './utils/EventBus.js';
import Events from './Events.js';
import AbrController from './controllers/AbrController.js';
import VideoModel from './models/VideoModel.js';

let Stream = function () {
    "use strict";

    var streamProcessors = [],
        isStreamActivated = false,
        isMediaInitialized = false,
        streamInfo = null,
        updateError = {},
        isUpdating = false,
        isInitialized = false,
        protectionController,
        boundProtectionErrorHandler,

        eventController = null,

        // Encrypted Media Extensions
        onProtectionError = function(event) {
            if (event.error) {
                this.errHandler.mediaKeySessionError(event.error);
                this.log(event.error);
                this.reset();
            }
        },

        getMimeTypeOrType = function(mediaInfo) {
            return mediaInfo.type === "text"? mediaInfo.mimeType : mediaInfo.type;
        },

        isMediaSupported = function(mediaInfo, mediaSource, manifest) {
            var self = this,
                type = mediaInfo.type,
                codec,
                msg;

            if (type === "muxed" && mediaInfo) {
                msg = "Multiplexed representations are intentionally not supported, as they are not compliant with the DASH-AVC/264 guidelines";
                this.log(msg);
                this.errHandler.manifestError(msg, "multiplexedrep", this.manifestModel.getValue());
                return false;
            }

            if ((type === "text") || (type === "fragmentedText")) return true;

            codec = mediaInfo.codec;
            self.log(type + " codec: " + codec);

            if (!!mediaInfo.contentProtection && !self.capabilities.supportsEncryptedMedia()) {
                self.errHandler.capabilityError("encryptedmedia");
            } else if (!self.capabilities.supportsCodec(VideoModel.getInstance().getElement(), codec)) {
                msg = type + "Codec (" + codec + ") is not supported.";
                self.errHandler.manifestError(msg, "codec", manifest);
                self.log(msg);
                return false;
            }

            return true;
        },

        onCurrentTrackChanged = function(e) {
            if (e.newMediaInfo.streamInfo.id !== streamInfo.id) return;

            var processor = getProcessorForMediaInfo.call(this, e.oldMediaInfo);
            if (!processor) return;

            var currentTime = this.playbackController.getTime(),
                buffer = processor.getBuffer(),
                mediaInfo = e.newMediaInfo,
                manifest = this.manifestModel.getValue(),
                idx = streamProcessors.indexOf(processor),
                mediaSource = processor.getMediaSource();

            if (mediaInfo.type !== "fragmentedText"){
                processor.reset(true);
                createStreamProcessor.call(this, mediaInfo, manifest, mediaSource, {buffer: buffer, replaceIdx: idx, currentTime: currentTime});
                this.playbackController.seek(this.playbackController.getTime());
            }else {
                processor.updateMediaInfo(manifest, mediaInfo);
            }
        },

        createStreamProcessor = function(mediaInfo, manifest, mediaSource, optionalSettings) {
            var self = this,
                streamProcessor = self.system.getObject("streamProcessor"),
                allMediaForType = this.adapter.getAllMediaInfoForType(manifest, streamInfo, mediaInfo.type);

            streamProcessor.initialize(getMimeTypeOrType.call(self, mediaInfo), self.fragmentController, mediaSource, self, eventController);
            self.abrController.updateTopQualityIndex(mediaInfo);

            if (optionalSettings) {
                streamProcessor.setBuffer(optionalSettings.buffer);
                streamProcessors[optionalSettings.replaceIdx] = streamProcessor;
                streamProcessor.setIndexHandlerTime(optionalSettings.currentTime);
            } else {
                streamProcessors.push(streamProcessor);
            }

            if((mediaInfo.type === "text" || mediaInfo.type === "fragmentedText")) {
                var idx;
                for(var i = 0; i < allMediaForType.length; i++){
                    if(allMediaForType[i].index === mediaInfo.index) {
                        idx = i;
                    }
                    streamProcessor.updateMediaInfo(manifest, allMediaForType[i]);//creates text tracks for all adaptations in one stream processor
                }
                if(mediaInfo.type === "fragmentedText"){
                    streamProcessor.updateMediaInfo(manifest, allMediaForType[idx]);//sets the initial media info
                }
            }else {
                streamProcessor.updateMediaInfo(manifest, mediaInfo);
            }

            return streamProcessor;
        },

        initializeMediaForType = function(type, mediaSource) {
            var self = this,
                manifest = self.manifestModel.getValue(),
                allMediaForType = this.adapter.getAllMediaInfoForType(manifest, streamInfo, type),
                mediaInfo = null,
                initialMediaInfo;

            if (!allMediaForType || allMediaForType.length === 0) {
                self.log("No " + type + " data.");
                return;
            }

            for (var i = 0, ln = allMediaForType.length; i < ln; i += 1) {
                mediaInfo = allMediaForType[i];

                if (!isMediaSupported.call(self, mediaInfo, mediaSource, manifest)) continue;

                if (self.mediaController.isMultiTrackSupportedByType(mediaInfo.type)) {
                    self.mediaController.addTrack(mediaInfo, streamInfo);
                }
            }

            if (this.mediaController.getTracksFor(type, streamInfo).length === 0) return;

            this.mediaController.checkInitialMediaSettings(streamInfo);
            initialMediaInfo = this.mediaController.getCurrentTrackFor(type, streamInfo);

            // TODO : How to tell index handler live/duration?
            // TODO : Pass to controller and then pass to each method on handler?

            createStreamProcessor.call(this, initialMediaInfo, manifest, mediaSource);
        },

        initializeMedia = function (mediaSource) {
            var self = this,
                manifest = self.manifestModel.getValue(),
                events;

            eventController = self.system.getObject("eventController");
            events = self.adapter.getEventsFor(manifest, streamInfo);
            eventController.addInlineEvents(events);

            isUpdating = true;
            initializeMediaForType.call(self, "video", mediaSource);
            initializeMediaForType.call(self, "audio", mediaSource);
            initializeMediaForType.call(self, "text", mediaSource);
            initializeMediaForType.call(self, "fragmentedText", mediaSource);
            initializeMediaForType.call(self, "muxed", mediaSource);

            createBuffers.call(self);

            isMediaInitialized = true;
            isUpdating = false;

            if (streamProcessors.length === 0) {
                var msg = "No streams to play.";
                self.errHandler.manifestError(msg, "nostreams", manifest);
                self.log(msg);
            } else {
                self.liveEdgeFinder.initialize(streamProcessors[0]);
                //self.log("Playback initialized!");
                checkIfInitializationCompleted.call(this);
            }
        },

        checkIfInitializationCompleted = function() {
            var self = this,
                ln = streamProcessors.length,
                hasError = !!updateError.audio || !!updateError.video,
                error = hasError ? new Error(Stream.DATA_UPDATE_FAILED_ERROR_CODE, "Data update failed", null) : null,
                i = 0;

            for (i; i < ln; i += 1) {
                if (streamProcessors[i].isUpdating() || isUpdating) return;
            }

            isInitialized = true;
            EventBus.trigger(Events.STREAM_INITIALIZED, {streamInfo: streamInfo, error:error});

            if (!isMediaInitialized || isStreamActivated) return;
            protectionController.init(self.manifestModel.getValue(), getMediaInfo.call(this, "audio"), getMediaInfo.call(this, "video"));
            isStreamActivated = true;
        },

        getMediaInfo = function(type) {
            var ln = streamProcessors.length,
                mediaCtrl = null;

            for (var i = 0; i < ln; i += 1) {
                mediaCtrl = streamProcessors[i];

                if (mediaCtrl.getType() === type) return mediaCtrl.getMediaInfo();
            }

            return null;
        },

        createBuffers = function() {
            for (var i = 0, ln = streamProcessors.length; i < ln; i += 1) {
                streamProcessors[i].createBuffer();
            }
        },

        onBufferingCompleted = function(e) {
            if (e.streamInfo !== streamInfo) return;

            var processors = getProcessors(),
                ln = processors.length,
                i = 0;

            // if there is at least one buffer controller that has not completed buffering yet do nothing
            for (i; i < ln; i += 1) {
                if (!processors[i].isBufferingCompleted()) return;
            }

            EventBus.trigger(Events.STREAM_BUFFERING_COMPLETED, {streamInfo: streamInfo});
        },

        onDataUpdateCompleted = function(e) {
            if (e.sender.streamProcessor.getStreamInfo() !== streamInfo) return;

            var type = e.sender.streamProcessor.getType();

            updateError[type] = e.error;

            checkIfInitializationCompleted.call(this);
        },

        getProcessorForMediaInfo = function(mediaInfo) {
            if (!mediaInfo) return false;

            var processors = getProcessors.call(this);

            return processors.filter(function(processor){
                return (processor.getType() === mediaInfo.type);
            })[0];
        },

        getProcessors = function() {
            var arr = [],
                i = 0,
                ln = streamProcessors.length,
                type,
                controller;

            for (i; i < ln; i += 1) {
                controller = streamProcessors[i];
                type = controller.getType();

                if (type === "audio" || type === "video" || type === "fragmentedText") {
                    arr.push(controller);
                }
            }

            return arr;
        },

        updateData = function (updatedStreamInfo) {
            var self = this,
                ln = streamProcessors.length,
                manifest = self.manifestModel.getValue(),
                i = 0,
                mediaInfo,
                events,
                controller;

            isStreamActivated = false;
            streamInfo = updatedStreamInfo;
            self.log("Manifest updated... set new data on buffers.");

            if (eventController) {
                events = self.adapter.getEventsFor(manifest, streamInfo);
                eventController.addInlineEvents(events);
            }

            isUpdating = true;
            isInitialized = false;

            for (i; i < ln; i +=1) {
                controller = streamProcessors[i];
                mediaInfo = self.adapter.getMediaInfoForType(manifest, streamInfo, controller.getType());
                this.abrController.updateTopQualityIndex(mediaInfo);
                controller.updateMediaInfo(manifest, mediaInfo);
            }

            isUpdating = false;
            checkIfInitializationCompleted.call(self);
        };

    return {
        system: undefined,
        manifestModel: undefined,
        sourceBufferExt: undefined,
        adapter: undefined,
        fragmentController: undefined,
        playbackController: undefined,
        mediaController: undefined,
        capabilities: undefined,
        log: undefined,
        errHandler: undefined,
        liveEdgeFinder: undefined,


        setup: function () {
            EventBus.on(Events.BUFFERING_COMPLETED, onBufferingCompleted, this);
            EventBus.on(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
        },

        initialize: function(strmInfo, protectionCtrl) {
            this.abrController = AbrController.getInstance();

            streamInfo = strmInfo;
            protectionController = protectionCtrl;
            EventBus.on(Events.KEY_ERROR, onProtectionError, this);
            EventBus.on(Events.SERVER_CERTIFICATE_UPDATED, onProtectionError, this);
            EventBus.on(Events.LICENSE_REQUEST_COMPLETE, onProtectionError, this);
            EventBus.on(Events.KEY_SYSTEM_SELECTED, onProtectionError, this);
            EventBus.on(Events.KEY_SESSION_CREATED, onProtectionError, this);
        },

        /**
         * Activates Stream by re-initalizing some of its components
         * @param mediaSource {MediaSource}
         * @memberof Stream#
         */
        activate: function(mediaSource){
            if (!isStreamActivated) {
                EventBus.on(Events.CURRENT_TRACK_CHANGED, onCurrentTrackChanged, this);
                initializeMedia.call(this, mediaSource);
            } else {
                createBuffers.call(this);
            }
        },

        /**
         * Partially resets some of the Stream elements
         * @memberof Stream#
         */
        deactivate: function() {
            var ln = streamProcessors.length,
                i = 0;

            for (i; i < ln; i += 1) {
                streamProcessors[i].reset();
            }

            streamProcessors = [];
            isStreamActivated = false;
            isMediaInitialized = false;
            this.resetEventController();
            EventBus.off(Events.CURRENT_TRACK_CHANGED, onCurrentTrackChanged, this);
        },

        reset: function (errored) {
            this.playbackController.pause();
            this.deactivate();

            isUpdating = false;
            isInitialized = false;

            if (this.fragmentController) {
                this.fragmentController.reset();
            }
            this.fragmentController = undefined;
            this.liveEdgeFinder.abortSearch();

            EventBus.off(Events.DATA_UPDATE_COMPLETED, onDataUpdateCompleted, this);
            EventBus.off(Events.BUFFERING_COMPLETED, onBufferingCompleted, this);
            EventBus.off(Events.KEY_ERROR, onProtectionError, this);
            EventBus.off(Events.SERVER_CERTIFICATE_UPDATED, onProtectionError, this);
            EventBus.off(Events.LICENSE_REQUEST_COMPLETE, onProtectionError, this);
            EventBus.off(Events.KEY_SYSTEM_SELECTED, onProtectionError, this);
            EventBus.off(Events.KEY_SESSION_CREATED, onProtectionError, this);

            updateError = {};
        },

        getDuration: function () {
            return streamInfo.duration;
        },

        getStartTime: function() {
            return streamInfo.start;
        },

        getStreamIndex: function() {
            return streamInfo.index;
        },

        getId: function() {
            return streamInfo.id;
        },

        getStreamInfo: function() {
            return streamInfo;
        },

        hasMedia: function(type){
            return (getMediaInfo.call(this, type) !== null);
        },

        /**
         * @param type
         * @returns {Array}
         * @memberof Stream#
         */
        getBitrateListFor: function(type) {
            var mediaInfo = getMediaInfo.call(this, type);

            return this.abrController.getBitrateList(mediaInfo);
        },

        startEventController: function() {
            eventController.start();
        },

        resetEventController: function() {
            if (eventController) {
                eventController.reset();
            }
        },

        /**
         * Indicates whether the stream has been activated or not
         * @returns {Boolean}
         * @memberof Stream#
         */
        isActivated: function() {
            return isStreamActivated;
        },

        isInitialized: function() {
            return isInitialized;
        },

        updateData: updateData
    };
};

Stream.prototype = {
    constructor: Stream
};

Stream.DATA_UPDATE_FAILED_ERROR_CODE = 1;


export default Stream;
/* global __VERSION__ */
import LicenseCall from '../utils/LicenseCall';
import AnalyticsCall from '../utils/AnalyticsCall';
import Utils from '../utils/Utils';
import logger from '../utils/Logger';
import AdapterFactory from './AdapterFactory';
import AnalyticsStateMachineFactory from './AnalyticsStateMachineFactory';
import CastClient from '../cast/CastClient';
import CastReceiver from '../cast/CastReceiver';

class Analytics {
  static PAGE_LOAD_TYPE               = {
    FOREGROUND: 1, BACKGROUND: 2
  };
  static LICENSE_CALL_PENDING_TIMEOUT = 200;
  static PAGE_LOAD_TYPE_TIMEOUT       = 200;
  static CAST_RECEIVER_CONFIG_MESSAGE = 'CAST_RECEIVER_CONFIG_MESSAGE';

  constructor(config) {
    this.config = config;

    this.licenseCall                  = new LicenseCall();
    this.analyticsCall                = new AnalyticsCall();
    this.castClient                   = new CastClient();
    this.castReceiver                 = new CastReceiver();

    this.droppedSampleFrames = 0;
    this.licensing           = 'waiting';
    this.startupTime         = 0;
    this.pageLoadType        = Analytics.PAGE_LOAD_TYPE.FOREGROUND;

    this.autoplay = undefined;

    this.isCastClient = false;
    this.isCastReceiver = false;
    this.isAllowedToSendSamples = false;
    this.samplesQueue = [];

    if (this.config.cast && this.config.cast.receiver) {
      this.isCastReceiver = true;
      this.castReceiver.setUp();
      this.castReceiver.setCallback((event) => {
        switch (event.type) {
          case Analytics.CAST_RECEIVER_CONFIG_MESSAGE:
            this.castClientConfig = event.data;
            this.updateSampleToCastClientConfig(this.sample, this.castClientConfig);
            this.updateSamplesToCastClientConfig(this.samplesQueue, event.data);
            this.isAllowedToSendSamples = true;
            break;
        }
      });
    }

    this.setPageLoadType();

    this.setupSample();
    this.init();
    this.setupStateMachineCallbacks();
  }

  updateSamplesToCastClientConfig(samples, castClientConfig) {
    for (let i = 0; i < samples.length; i++) {
      this.updateSampleToCastClientConfig(samples[i], castClientConfig);
    }
  }

  updateSampleToCastClientConfig(sample, castClientConfig) {
    const {config, userId, impressionId, domain, path, language, userAgent} = castClientConfig;
    sample.impressionId = impressionId;
    sample.userId = userId;
    sample.userAgent = userAgent;
    sample.domain = domain;
    sample.path = path;
    sample.language = language;

    this.setConfigParameters(sample, config);
  }

  setPageLoadType() {
    window.setTimeout(() => {
      if (document[Utils.getHiddenProp()] === true) {
        this.pageLoadType = Analytics.PAGE_LOAD_TYPE.BACKGROUND;
      }
    }, Analytics.PAGE_LOAD_TYPE_TIMEOUT);
  }

  init() {
    if (!this.isCastReceiver && (this.config.key == '' || !Utils.validString(this.config.key))) {
      console.error('Invalid analytics license key provided');
      return;
    }

    logger.setLogging(this.config.debug || false);

    if (!this.isCastReceiver) {
      this.checkLicensing(this.config.key);
    } else {
      this.licensing = 'granted';
    }

    this.setConfigParameters();

    this.setUserId();
  }

  setConfigParameters(sample = this.sample, config = this.config) {
    sample.key          = config.key;
    sample.playerKey    = config.playerKey;
    sample.player       = config.player;
    sample.cdnProvider  = config.cdnProvider;
    sample.videoId      = config.videoId;
    sample.customUserId = config.userId;

    sample.customData1 = Utils.getCustomDataString(config.customData1);
    sample.customData2 = Utils.getCustomDataString(config.customData2);
    sample.customData3 = Utils.getCustomDataString(config.customData3);
    sample.customData4 = Utils.getCustomDataString(config.customData4);
    sample.customData5 = Utils.getCustomDataString(config.customData5);

    sample.experimentName = config.experimentName;
  }

  setUserId() {
    const userId = Utils.getCookie('bitmovin_analytics_uuid');
    if (!userId || userId === '') {
      document.cookie = 'bitmovin_analytics_uuid=' + Utils.generateUUID();
      this.sample.userId   = Utils.getCookie('bitmovin_analytics_uuid');
    } else {
      this.sample.userId = userId;
    }
  }

  setupStateMachineCallbacks() {
    this.stateMachineCallbacks = {
      // All of these are called in the onLeaveState Method.
      // So it's the last sample
      setup: (time, state, event) => {
        if (!this.isCastReceiver) {
          this.sample.impressionId = Utils.generateUUID();
        }
        logger.log('Setup bitmovin analytics ' + this.sample.analyticsVersion + ' with impressionId: ' + this.sample.impressionId);

        this.setDuration(time);
        this.setState(state);
        this.sample.playerStartupTime = time;
        this.sample.pageLoadType      = this.pageLoadType;

        if (window.performance && window.performance.timing) {
          const loadTime           = Utils.getCurrentTimestamp() - window.performance.timing.navigationStart;
          this.sample.pageLoadTime = loadTime;
          logger.log('Page loaded in ' + loadTime + 'ms');
        }

        this.startupTime = time;

        this.setPlaybackSettingsFromLoadedEvent(event);

        this.sendAnalyticsRequestAndClearValues();

        this.sample.pageLoadType = this.pageLoadType;
        this.sample.pageLoadTime = 0;
      },

      ready: Utils.noOp,

      startup: (time, state) => {
        this.setDuration(time);
        this.sample.videoStartupTime = time;
        this.setState(state);

        this.startupTime += time;
        this.sample.startupTime = this.startupTime;
        this.sample.autoplay = this.autoplay;

        this.sendAnalyticsRequestAndClearValues();
        this.sample.autoplay = undefined;
      },

      updateSample: (playbackSettings) => {
        this.setPlaybackSettingsFromLoadedEvent(playbackSettings);
      },

      playing: (time, state, event) => {
        this.setDuration(time);
        this.setState(state);
        this.sample.played = time;

        this.setDroppedFrames(event);

        this.sendAnalyticsRequestAndClearValues();
      },

      playingAndBye: (time, state, event) => {
        this.setDuration(time);
        this.setState(state);
        this.sample.played = time;

        this.setDroppedFrames(event);

        this.sendUnloadRequest();
      },

      heartbeat: (time, state, event) => {
        this.setDroppedFrames(event);
        this.setState(state);
        this.setDuration(time);

        this.sample.played = this.sample.duration;

        this.sendAnalyticsRequestAndClearValues();
      },

      qualitychange: (time, state) => {
        this.setDuration(time);
        this.setState(state);

        this.sendAnalyticsRequestAndClearValues();
      },

      'qualitychange_pause': (time, state) => {
        this.setDuration(time);
        this.setState(state);

        this.sendAnalyticsRequestAndClearValues();
      },

      'qualitychange_rebuffering': (time, state) => {
        this.setDuration(time);
        this.setState(state);

        this.sendAnalyticsRequestAndClearValues();
      },

      videoChange: (event) => {
        this.stateMachineCallbacks.setVideoTimeEndFromEvent(event);
        this.stateMachineCallbacks.setVideoTimeStartFromEvent(event);
        this.setPlaybackVideoPropertiesFromEvent(event);
      },

      audioChange: (event) => {
        this.stateMachineCallbacks.setVideoTimeEndFromEvent(event);
        this.stateMachineCallbacks.setVideoTimeStartFromEvent(event);
        this.sample.audioBitrate = event.bitrate;
      },

      pause: (time, state, event) => {
        this.setDuration(time);
        this.setState(state);

        this.sample.paused = time;

        this.sendAnalyticsRequestAndClearValues();
      },

      'paused_seeking': (time, state, event) => {
        this.setDuration(time);
        this.setState(state);

        this.sample.seeked = time;

        this.sendAnalyticsRequestAndClearValues();
      },

      'play_seeking': Utils.noOp,

      'end_play_seeking': (time, state, event) => {
        this.setState(state);
        this.setDuration(time);

        this.sample.seeked = time;

        this.sendAnalyticsRequestAndClearValues();
      },

      rebuffering: (time, state, event) => {
        this.setDuration(time);
        this.setState(state);

        this.sample.buffered = time;

        this.sendAnalyticsRequestAndClearValues();
      },

      error: (event) => {
        this.stateMachineCallbacks.setVideoTimeEndFromEvent(event);
        this.stateMachineCallbacks.setVideoTimeStartFromEvent(event);

        this.setState('error');
        this.sample.errorCode    = event.code;
        this.sample.errorMessage = event.message;

        this.sendAnalyticsRequestAndClearValues();

        delete this.sample.errorCode;
        delete this.sample.errorMessage;
      },

      end: (time, state, event) => {
        this.sample.impressionId = Utils.generateUUID();
      },

      ad: (time, state, event) => {
        this.setDuration(time);
        this.setState(state);
        this.sample.ad = time;

        this.setDroppedFrames(event);

        this.sendAnalyticsRequestAndClearValues();
      },

      mute: () => {
        this.sample.isMuted = true;
      },

      unMute: () => {
        this.sample.isMuted = false;
      },

      muting_ready: Utils.noOp,
      muting_play: Utils.noOp,
      muting_pause: Utils.noOp,

      setVideoTimeEndFromEvent: (event) => {
        if (Utils.validNumber(event.currentTime)) {
          this.sample.videoTimeEnd = Utils.calculateTime(event.currentTime);
        }
      },

      setVideoTimeStartFromEvent: (event) => {
        if (Utils.validNumber(event.currentTime)) {
          this.sample.videoTimeStart = Utils.calculateTime(event.currentTime);
        }
      },

      startCasting: (timestamp, event) => {
        if (event && event.resuming) {
          this.isAllowedToSendSamples = false;
          logger.warning('Player started casting but a session is already casting!');
          return;
        }

        this.isCastClient = true;
        this.isAllowedToSendSamples = false;

        const {domain, path, language, userAgent, userId, impressionId} = this.sample;
        const castStartMessage = {
          type: Analytics.CAST_RECEIVER_CONFIG_MESSAGE,
          data: {
            config: this.config,
            userId,
            domain,
            path,
            language,
            userAgent,
            impressionId
          }
        };

        this.castClient.setUp();
        this.castClient.sendMessage(castStartMessage);
      },

      casting: () => {
        this.isCastClient = false;
        this.samplesQueue = [];
        this.isAllowedToSendSamples = true;
      },

      source_changing: () => {
        this.sample.impressionId = Utils.generateUUID();
      }
    };
  }

  setCustomDataOnce = (values) => {
    const oldConfig = this.config;
    this.setCustomData(values);
    this.setCustomData(oldConfig);
  }

  setCustomData = (values) => {
    const filterValues = ({
      customData1,
      customData2,
      customData3,
      customData4,
      customData5,
      experimentName
    }) => {
      const retVal = {};
      if (customData1) {
        retVal.customData1 = customData1;
      }
      if (customData2) {
        retVal.customData2 = customData2;
      }
      if (customData3) {
        retVal.customData3 = customData3;
      }
      if (customData4) {
        retVal.customData4 = customData4;
      }
      if (customData5) {
        retVal.customData5 = customData5;
      }
      if (experimentName) {
        retVal.experimentName = experimentName;
      }
      return retVal;
    };

    this.sendAnalyticsRequestAndClearValues();
    this.config = {
      ...this.config,
      ...filterValues(values)
    };
    this.setConfigParameters();
  };

  register = (player, opts = {}) => {
    if (!opts.starttime) {
      opts.starttime = Utils.getCurrentTimestamp();
    }
    this.analyticsStateMachine = AnalyticsStateMachineFactory.getAnalyticsStateMachine(player, this.stateMachineCallbacks, opts);

    this.adapter = AdapterFactory.getAdapter(player, this.record, this.analyticsStateMachine);
    if (!this.adapter) {
      logger.error('Could not detect player.');
      return;
    }
  };

  getCurrentImpressionId = () => {
    return this.sample.impressionId;
  };

  record = (eventType, eventObject) => {
    eventObject = eventObject || {};

    this.analyticsStateMachine.callEvent(eventType, eventObject, Utils.getCurrentTimestamp());
  };

  setDuration(duration) {
    this.sample.duration = duration;
  }

  setState(state) {
    this.sample.state = state;
  }

  setPlaybackVideoPropertiesFromEvent(event) {
    if (Utils.validNumber(event.width)) {
      this.sample.videoPlaybackWidth = event.width;
    }
    if (Utils.validNumber(event.height)) {
      this.sample.videoPlaybackHeight = event.height;
    }
    if (Utils.validNumber(event.bitrate)) {
      this.sample.videoBitrate = event.bitrate;
    }
  }

  setDroppedFrames = (event) => {
    if (Utils.validNumber(event.droppedFrames)) {
      this.sample.droppedFrames = 0;
    }
  };

  setPlaybackSettingsFromLoadedEvent(loadedEvent) {
    if (Utils.validBoolean(loadedEvent.isLive)) {
      this.sample.isLive = loadedEvent.isLive;
    }
    if (Utils.validString(loadedEvent.version)) {
      this.sample.version = this.sample.player + '-' + loadedEvent.version;
    }
    if (Utils.validString(loadedEvent.type)) {
      this.sample.playerTech = loadedEvent.type;
    }
    if (Utils.validNumber(loadedEvent.duration)) {
      this.sample.videoDuration = Utils.calculateTime(loadedEvent.duration);
    }
    if (Utils.validString(loadedEvent.streamType)) {
      this.sample.streamFormat = loadedEvent.streamType;
    }
    if (Utils.validString(loadedEvent.mpdUrl)) {
      this.sample.mpdUrl = loadedEvent.mpdUrl;
    }
    if (Utils.validString(loadedEvent.m3u8Url)) {
      this.sample.m3u8Url = loadedEvent.m3u8Url;
    }
    if (Utils.validString(loadedEvent.progUrl)) {
      this.sample.progUrl = loadedEvent.progUrl;
    }
    if (Utils.validNumber(loadedEvent.videoWindowWidth)) {
      this.sample.videoWindowWidth = loadedEvent.videoWindowWidth;
    }
    if (Utils.validNumber(loadedEvent.videoWindowHeight)) {
      this.sample.videoWindowHeight = loadedEvent.videoWindowHeight;
    }
    if (Utils.validBoolean(loadedEvent.isMuted)) {
      this.sample.isMuted = loadedEvent.isMuted;
    }
    if (Utils.validBoolean(loadedEvent.autoplay)) {
      this.autoplay = loadedEvent.autoplay;
    }

    if (this.sample.streamFormat === 'progressive') {
      this.sample.videoBitrate = loadedEvent.progBitrate;
    }
  }

  setupSample() {
    this.sample = {
      domain             : Utils.sanitizePath(window.location.hostname),
      path               : Utils.sanitizePath(window.location.pathname),
      language           : navigator.language || navigator.userLanguage,
      userAgent          : navigator.userAgent,
      screenWidth        : screen.width,
      screenHeight       : screen.height,
      isLive             : false,
      isCasting          : this.isCastReceiver,
      videoDuration      : 0,
      size               : 'WINDOW',
      time               : 0,
      videoWindowWidth   : 0,
      videoWindowHeight  : 0,
      droppedFrames      : 0,
      played             : 0,
      buffered           : 0,
      paused             : 0,
      ad                 : 0,
      seeked             : 0,
      videoPlaybackWidth : 0,
      videoPlaybackHeight: 0,
      videoBitrate       : 0,
      audioBitrate       : 0,
      videoTimeStart     : 0,
      videoTimeEnd       : 0,
      videoStartupTime   : 0,
      duration           : 0,
      startupTime        : 0,
      analyticsVersion   : __VERSION__
    };
  }

  checkLicensing(key) {
    this.licenseCall.sendRequest(key,
      this.sample.domain,
      this.sample.analyticsVersion,
      this.handleLicensingResponse.bind(this));
  }

  handleLicensingResponse(licensingResponse) {
    if (licensingResponse.status === 'granted') {
      this.licensing = 'granted';
    } else if (licensingResponse.status === 'skip') {
      this.licensing = 'denied';
      logger.log('Impression should not be sampled');
    } else {
      this.licensing = 'denied';
      logger.log('Analytics license denied, reason: ' + licensingResponse.message);
    }
  }

  sendAnalyticsRequest() {
    if (this.licensing === 'denied') {
      return;
    }

    if (this.licensing === 'granted') {
      this.sample.time = Utils.getCurrentTimestamp();

      if (!this.isCastClient && !this.isCastReceiver) {
        this.analyticsCall.sendRequest(this.sample, Utils.noOp);
        return;
      }

      if (!this.isAllowedToSendSamples) {
        const copySample = {...this.sample};
        this.samplesQueue.push(copySample);
      } else {
        for (let i = 0; i < this.samplesQueue.length; i++) {
          this.analyticsCall.sendRequest(this.samplesQueue[i], Utils.noOp);
        }
        this.samplesQueue = [];

        this.analyticsCall.sendRequest(this.sample, Utils.noOp);
      }
    } else if (this.licensing === 'waiting') {
      this.sample.time = Utils.getCurrentTimestamp();

      logger.log('Licensing callback still pending, waiting...');

      const copySample = {...this.sample};

      window.setTimeout(() => {
        this.analyticsCall.sendRequest(copySample, Utils.noOp);
      }, Analytics.LICENSE_CALL_PENDING_TIMEOUT);
    }
  }

  sendAnalyticsRequestAndClearValues() {
    this.sendAnalyticsRequest();
    this.clearValues();
  }

  sendUnloadRequest() {
    if (this.licensing === 'denied') {
      return;
    }

    if (typeof navigator.sendBeacon === 'undefined') {
      this.sendAnalyticsRequestSynchronous();
    }
    else {
      const success = navigator.sendBeacon(this.analyticsCall.getAnalyticsServerUrl(),
        JSON.stringify(this.sample));
      if (!success) {
        this.sendAnalyticsRequestSynchronous();
      }
    }
  }

  sendAnalyticsRequestSynchronous() {
    if (this.licensing === 'denied') {
      return;
    }

    this.analyticsCall.sendRequestSynchronous(this.sample, Utils.noOp);
  }

  clearValues() {
    this.sample.ad       = 0;
    this.sample.paused   = 0;
    this.sample.played   = 0;
    this.sample.seeked   = 0;
    this.sample.buffered = 0;

    this.sample.playerStartupTime = 0;
    this.sample.videoStartupTime  = 0;
    this.sample.startupTime       = 0;

    this.sample.duration      = 0;
    this.sample.droppedFrames = 0;
    this.sample.pageLoadType  = 0;
  }

  getDroppedFrames(frames) {
    if (frames != undefined && frames != 0) {
      const droppedFrames = frames - this.droppedSampleFrames;
      this.droppedSampleFrames = frames;
      return droppedFrames;
    }
    else {
      return 0;
    }
  }
}

export default Analytics;

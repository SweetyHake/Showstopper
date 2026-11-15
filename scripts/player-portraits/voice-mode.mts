// AVSettings.AV_MODES.DISABLED (FVTT 14); class is not exported on globalThis.
const AV_MODE_DISABLED = 0;

/** Connection quality values rendered by avclient-livekit (dock dots). */
const LIVEKIT_QUALITIES = new Set(["excellent", "good", "poor", "lost", "unknown"]);

/**
 * Native support for Foundry VTT's voice mode (v14, CameraViews application).
 * Integration is always active (no separate toggle setting): while world AV mode
 * is enabled, body.dvp-voice-hud is active.
 *
 * When world AV mode is enabled (audio/video), the portrait panel replaces the
 * default camera dock: #camera-views is hidden completely (body.dvp-voice-hud),
 * and its native controls (div.user-controls — mic / camera / deafen / settings)
 * are reparented into the module's custom UI — inside the stats widget next to
 * ping (span.dvp-voice-controls). If the stats widget is disabled, the controls
 * live in a standalone pill at the same position.
 *
 * The controls node remains an application part element (data-application-part="controls"),
 * so core itself updates its icons/states; clicks are forwarded back to the
 * CameraViews action dispatcher (app.options.actions), avoiding duplication of
 * core logic (warnings, permission checks). After a partial re-render, core
 * recreates the node inside itself — the renderCameraViews hook grabs the fresh
 * node and moves it into the host.
 *
 * WebRTC peers are removed asynchronously and can remain in peers after the user
 * document becomes inactive — core crashes on any CameraViews render in this state
 * (_prepareUserContext returns undefined). The controller filters
 * client.getConnectedUsers down to active users, preventing the crash for all
 * consumers of the list — both ours and core's.
 *
 * Native voice states (speaking / muted / deafened) are mirrored into the portrait
 * panel sets and act alongside Discord Relay states. LiveKit connection quality
 * (the "displayConnectionQuality" dot on dock cameras) is mirrored into
 * panel.nativeQuality and rendered as a dot in the portrait corner: a tap on
 * LiveKitClient.setConnectionQualityIndicator provides instant updates (its call
 * is gated by that same setting), while _syncNativeQuality rebuilds it on the
 * 2-second syncNativeStates interval. The muted flag is broadcast as
 * "mute button || !isAudioEnabled()" at send time, so the FIRST muted broadcast
 * of every session is always "muted" by construction (AVSettings.#initialize fires
 * from the constructor before game.webrtc is created) — _resolveNativeMuted computes
 * the effective value: for self, strictly the button state; for remote users, the
 * flag is trusted starting from the first truthful broadcast, and speaking overrides
 * a stuck mute. Inspecting MediaStreamTracks here is pointless: on a receiver track
 * `enabled` doesn't reflect the sender, and `muted` reacts to RTP flow rather than mute.
 */
export class VoiceModeController {
  declare panel; declare _hooks; declare _destroyed; declare _bootTimers; declare _mutedReal; declare _mutedNudged;
  /** @param {import('./panel.mjs').DiscordVoicePortraits} panel */
  constructor(panel) {
    this.panel = panel;
    this._hooks = [];
    this._destroyed = false;
    this._bootTimers = [];
    /** Users whose muted flag is already TRUTHFUL (see _resolveNativeMuted). */
    this._mutedReal = new Set();
    /** Whether the one-time truthful re-broadcast of our own muted state has run. */
    this._mutedNudged = false;
  }

  init() {
    const register = (hookName, fn) => {
      this._hooks.push({ hookName, id: Hooks.on(hookName, fn) });
    };

    // Initial render and partial dock re-renders: core may have recreated the
    // controls node — grab the current one. The app is recreated when AV mode
    // is enabled, so the speaking tap must be reinstalled.
    register("renderCameraViews", () => {
      this._installSpeakingTap();
      this.refresh();
    });
    // Any AV settings changes (world + client): mode, mute, hideDock, etc.
    register("rtcSettingsChanged", () => this.refresh());
    register("userConnected", () => this.refresh());
    // New user session: their first muted broadcast will again always be "muted"
    // (page load), so trust in the flag must be revoked before they reconnect.
    // Core's stale activity entry also gets in the way: with it present, wasMuted
    // in the tap would mistake the NEW initial bogus flag for a truthful update.
    register("userDisconnected", (user) => {
      this._mutedReal.delete(user.id);
      try { delete game.webrtc?.settings?.activity?.[user.id]; } catch (e) { /* object absent */ }
    });

    this.refresh();

    // State recovery after page reload. Our own mute/hidden lives in client
    // settings and is available immediately, however:
    //   1) core media initialization is async — until it finishes, getUser(self).muted
    //      falsely reports "muted" (muted ||= !isAudioEnabled());
    //   2) other users' states arrive later via peer handshakes and
    //      AVSettings.#initialize re-broadcasts.
    // There are no hooks for these events, so during the first 1.5s we resync
    // more frequently than the panel's 2-second interval.
    for (const delay of [300, 800, 1500]) {
      this._bootTimers.push(setTimeout(() => {
        if (!this._destroyed) this.refresh();
      }, delay));
    }
    // One-time truthful re-broadcast of our own muted state. The initial session
    // flag is always "muted" (see _resolveNativeMuted), and core never re-broadcasts
    // it until the user touches AV settings — so someone joining already muted
    // remained "unmuted" to everyone else. settings.changed() runs through the same
    // path as a settings change, but once media is up the flag comes out truthful.
    // The earlier timers wait for isAudioEnabled; the final (9s) timer nudges
    // unconditionally — "unable to broadcast" is also a truthful muted state per core rules.
    for (const delay of [2500, 5000]) {
      this._bootTimers.push(setTimeout(() => {
        if (!this._destroyed) this._nudgeMutedBroadcast(false);
      }, delay));
    }
    this._bootTimers.push(setTimeout(() => {
      if (!this._destroyed) this._nudgeMutedBroadcast(true);
    }, 9000));
  }

  /**
   * One-time nudge: settings.changed() re-broadcasts our own muted/hidden via
   * the same path as a settings update (100ms debounce -> #onSettingsChanged ->
   * #initialize -> broadcastActivity). The settings diff is empty, so core does
   * no extra work and rtcSettingsChanged hooks receive a harmless no-op call.
   */
  _nudgeMutedBroadcast(force = false) {
    if (this._mutedNudged || this._destroyed) return;
    const settings = game.webrtc?.settings;
    const client = game.webrtc?.client;
    if (!settings?.changed || !client) return;
    if (!force && client.isAudioEnabled?.() !== true) return;
    this._mutedNudged = true;
    try {
      settings.changed();
    }
    catch (e) { /* settings unavailable — handled by next timer or settings change */ }
  }

  destroy() {
    this._destroyed = true;
    this._mutedNudged = false;
    for (const timer of this._bootTimers) clearTimeout(timer);
    this._bootTimers.length = 0;
    for (const { hookName, id } of this._hooks) {
      Hooks.off(hookName, id);
    }
    this._hooks.length = 0;
    this._uninstallSpeakingTap();
    this._uninstallActivityTap();
    this._uninstallQualityTap();
    this._uninstallPeerFilter();
    this._releaseControls();
    document.body.classList.remove("dvp-voice-hud");
    this._clearCameraFeeds();
    this._clearNativeStates();
    this._mutedReal.clear();
  }

  /** Voice mode is active whenever the world AV mode is enabled. */
  _isActive() {
    const mode = game.webrtc?.settings?.world?.mode;
    return Number.isFinite(mode) && mode !== AV_MODE_DISABLED;
  }

  /** Toggles the HUD and reconciles states with the current AV mode. */
  refresh() {
    const active = this._isActive();
    document.body.classList.toggle("dvp-voice-hud", active);
    if (!active) {
      this._uninstallSpeakingTap();
      this._uninstallActivityTap();
      this._uninstallQualityTap();
      this._uninstallPeerFilter();
      this._releaseControls();
      this._clearCameraFeeds();
      this._clearNativeStates();
      return;
    }
    this._installSpeakingTap();
    this._installActivityTap();
    this._installQualityTap();
    this._installPeerFilter();
    this.syncControls();
    this.syncNativeStates();
    this._syncCameraFeeds();
    this._syncVolumeSliders();
  }

  /* -------------------------------------------- */
  /*  AV controls in module UI (next to ping)     */
  /* -------------------------------------------- */

  /**
   * Moves native controls (part "controls" of CameraViews) into the module host.
   * Idempotent: if the node is already in the host and up to date, no-ops;
   * after a core re-render, adopts the fresh node and removes the stale one.
   */
  syncControls() {
    if (!this._isActive()) return;
    const app = ui.webrtc;
    if (!app?.element) return;

    // A fresh node appears inside core's element after its re-render — adopt it
    // and remove the stale one from the host. Querying app.element itself must not
    // be used as a loss indicator: by design the node lives OUTSIDE the app element,
    // so finding nothing there is normal and not a reason to re-render core.
    const fresh = app.element.querySelector('[data-application-part="controls"]');
    if (fresh) {
      const host = this._ensureHost();
      if (!host) return;
      if (fresh.parentElement !== host) {
        host.querySelector(":scope > .user-controls")?.remove();
        host.append(fresh);
      }
      return;
    }

    // Node lives in the module host — leave core untouched, but verify the host
    // is still the preferred one. StatsWidget is created AFTER the initial move
    // (panel.init: voiceMode.init() -> StatsWidget.start()), so a node initially
    // placed in the standalone pill must migrate into the widget once it appears —
    // it won't move on its own, and when alone in the world core never re-renders
    // the dock to trigger another pass.
    const hosted = document.querySelector('.dvp-voice-controls > [data-application-part="controls"]');
    if (hosted) {
      const host = this._ensureHost();
      if (!host) return;
      if (hosted.parentElement !== host) host.append(hosted);
      return;
    }

    // Node was lost completely (stats widget rebuilt, etc.) — ask core to re-render
    // the part; renderCameraViews will adopt it. A render failure (e.g. core's stale
    // peer race) must not escape as an unhandled rejection.
    if (!app._dvpControlsRecovery) {
      app._dvpControlsRecovery = true;
      app.render({ parts: ["controls"] }).catch(() => { /* see _installPeerFilter */ }).finally(() => {
        app._dvpControlsRecovery = false;
      });
    }
  }

  /**
   * Controls host: a span inside the stats widget (next to ping), or a
   * standalone pill at the same position when stats are disabled.
   */
  _ensureHost() {
    // Button tooltips expand UPWARD: core's auto-detection near the bottom screen
    // edge picks DOWN and places the tooltip right under the cursor. Direction is
    // looked up via closest() from the button, so setting it on the host covers
    // all buttons across future re-renders (core doesn't touch the host).
    const widgetHost: any = document.querySelector("#dvp-stats-widget .dvp-voice-controls");
    if (widgetHost) {
      widgetHost.dataset.tooltipDirection = "UP";
      document.querySelector(".dvp-voice-controls--standalone")?.remove();
      this._attachClickForwarding(widgetHost);
      return widgetHost;
    }

    let standalone: any = document.querySelector(".dvp-voice-controls--standalone");
    if (!standalone) {
      standalone = document.createElement("div");
      standalone.classList.add("dvp-voice-controls", "dvp-voice-controls--standalone");
      // Same native #ui-left container as the stats widget.
      (document.getElementById("ui-left") ?? document.body).appendChild(standalone);
    }
    standalone.dataset.tooltipDirection = "UP";
    this._attachClickForwarding(standalone);
    return standalone;
  }

  /**
   * Forward clicks to CameraViews' action dispatcher: the controls node is moved
   * outside the app element, so replicate core's exact dispatch logic
   * (ApplicationV2 #onClickAction): handler.call(app, event, target).
   */
  _attachClickForwarding(host) {
    if (host._dvpForwarding) return;
    host._dvpForwarding = true;
    host.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const app = ui.webrtc;
      let handler = app?.options.actions?.[button.dataset.action];
      if (!handler) return;
      let buttons = [0];
      if (typeof handler === "object") {
        buttons = handler.buttons ?? [0];
        handler = handler.handler;
      }
      if (buttons.includes(event.button)) handler?.call(app, event, button);
    });
  }

  /**
   * Return controls to the application (when AV mode is disabled or the panel
   * is destroyed) so the native dock isn't left without its control bar.
   */
  _releaseControls() {
    const host = document.querySelector(".dvp-voice-controls");
    const controls = host?.querySelector(":scope > .user-controls");
    const app = ui.webrtc;
    if (controls && app?.element) {
      app.element.append(controls);
      try {
        app.render({ parts: ["controls"] }).catch(() => { /* app may already be closed */ });
      } catch (e) { /* app may already be closed */ }
    }
    document.querySelector(".dvp-voice-controls--standalone")?.remove();
  }

  /* -------------------------------------------- */
  /*  Workaround for core crash on stale peers    */
  /* -------------------------------------------- */

  /**
   * Core (v14.2) crashes on ANY CameraViews render while a user with an inactive
   * document remains in peers: _prepareUserContext returns undefined for them,
   * and _configureRenderParts reads .settings on it (TypeError reading 'settings').
   * Peers are removed on delayed close/error events rather than immediately on
   * user disconnect — opening a race window on every disconnect, and on an abrupt
   * connection drop a peer can linger in peers for a long time, breaking core
   * renders too (AVMaster.render during handshakes). A filter on the client
   * instance (modeled after the setUserIsSpeaking tap) returns only active users
   * whose camera views can actually be rendered.
   */
  _installPeerFilter() {
    const client = game.webrtc?.client;
    if (!client || client._dvpOrigGetConnectedUsers) return;
    client._dvpOrigGetConnectedUsers = client.getConnectedUsers;
    client.getConnectedUsers = () => client._dvpOrigGetConnectedUsers
      .call(client)
      .filter((userId) => game.users.get(userId)?.active);
  }

  _uninstallPeerFilter() {
    const client = game.webrtc?.client;
    if (!client?._dvpOrigGetConnectedUsers) return;
    client.getConnectedUsers = client._dvpOrigGetConnectedUsers;
    delete client._dvpOrigGetConnectedUsers;
  }

  /* -------------------------------------------- */
  /*  Voice states on portraits                   */
  /* -------------------------------------------- */

  /**
   * Tap on the CameraViews instance: core calls setUserIsSpeaking for both self
   * and remote users (socket userActivity) — mirror directly into portraits
   * without polling. The instance lives as long as AV mode is active.
   */
  _installSpeakingTap() {
    const app = ui.webrtc;
    if (!app || app._dvpSpeakingTap || typeof app.setUserIsSpeaking !== "function") return;
    app._dvpOrigSetUserIsSpeaking = app.setUserIsSpeaking;
    app.setUserIsSpeaking = (userId, speaking) => {
      app._dvpOrigSetUserIsSpeaking.call(app, userId, speaking);
      this._onNativeSpeaking(userId, !!speaking);
    };
    app._dvpSpeakingTap = true;
  }

  _uninstallSpeakingTap() {
    const app = ui.webrtc;
    if (!app?._dvpSpeakingTap) return;
    app.setUserIsSpeaking = app._dvpOrigSetUserIsSpeaking;
    delete app._dvpOrigSetUserIsSpeaking;
    delete app._dvpSpeakingTap;
  }

  _onNativeSpeaking(userId, speaking) {
    if (speaking) {
      this.panel.nativeSpeaking.add(userId);
      // Someone speaking cannot be muted — clear any stuck muted flag.
      this.panel.nativeMuted.delete(userId);
    } else {
      this.panel.nativeSpeaking.delete(userId);
    }
    this.panel._refreshVoiceDisplay(userId);
  }

  /**
   * Tap on the AVSettings instance: this is the single funnel where remote
   * mute/hidden/speaking updates arrive (userActivity socket and activity
   * exchange during peer handshake). Core only re-renders the dock — triggering
   * our renderCameraViews — when the user already has a video element; without
   * one, state updates would only reach portraits on the 2-second poll.
   * Here we mirror instantly and selectively: the set mutates only on actual
   * change, and DOM updates affect only that single portrait.
   */
  _installActivityTap() {
    const settings = game.webrtc?.settings;
    if (!settings || settings._dvpOrigHandleUserActivity) return;
    settings._dvpOrigHandleUserActivity = settings.handleUserActivity;
    settings.handleUserActivity = (userId, activity) => {
      // Muted state BEFORE merging: distinguishes the initial session flag
      // (bogus by construction, see _resolveNativeMuted) from subsequent truthful ones.
      const wasMuted = settings.activity?.[userId]?.muted;
      settings._dvpOrigHandleUserActivity.call(settings, userId, activity);
      this._onNativeActivity(userId, activity, wasMuted === true);
    };
  }

  _uninstallActivityTap() {
    const settings = game.webrtc?.settings;
    if (!settings?._dvpOrigHandleUserActivity) return;
    settings.handleUserActivity = settings._dvpOrigHandleUserActivity;
    delete settings._dvpOrigHandleUserActivity;
  }

  _onNativeActivity(userId, activity, wasMuted) {
    if (this._destroyed || !foundry.utils.isPlainObject(activity)) return;
    const webrtc = game.webrtc;
    if (!this._isActive() || !webrtc?.settings || !webrtc?.client) return;
    // Same predicate as syncNativeStates: active users with a connected peer.
    // Otherwise the tap would add someone whom a full rebuild immediately removes,
    // causing the status to flap on the 2-second interval.
    if (!game.users.get(userId)?.active) return;
    if (!webrtc.client.getConnectedUsers().includes(userId)) return;
    // getUser merges remote activity with local blocks — that's the source of truth;
    // activity fields merely signal "this property may have updated".
    const merged = webrtc.settings.getUser(userId);
    if (!merged) return;
    const { nativeSpeaking, nativeMuted } = this.panel;
    let changed = false;
    let speaking = nativeSpeaking.has(userId);
    if (typeof activity.speaking === "boolean" && activity.speaking !== speaking) {
      if (activity.speaking) nativeSpeaking.add(userId);
      else nativeSpeaking.delete(userId);
      speaking = activity.speaking;
      changed = true;
    }
    // Re-evaluate mute on ANY voice flag, not just when activity.muted itself updates:
    // muting while speaking arrives in the same packet as speaking-stop — without
    // rechecking here it would wait for the 2-second poll.
    if (typeof activity.muted === "boolean") {
      // The first muted flag of a session is always true (core's page-load broadcast);
      // anything arriving after an existing entry, or any explicit false (which
      // page-load cannot produce), is truthful.
      if (activity.muted === false || wasMuted) this._mutedReal.add(userId);
    }
    if (typeof activity.muted === "boolean" || typeof activity.speaking === "boolean") {
      const muted = this._resolveNativeMuted(userId, merged, speaking);
      if (muted !== nativeMuted.has(userId)) {
        if (muted) nativeMuted.add(userId);
        else nativeMuted.delete(userId);
        changed = true;
      }
    }
    if (changed) this.panel._refreshVoiceDisplay(userId);
  }

  /**
   * Truthful mute resolution. Broadcast as "mute button || !isAudioEnabled()" at
   * send time, so the FIRST muted broadcast of a user's session is always "muted"
   * by construction: AVSettings.#initialize fires from the constructor (core 14.369,
   * client/av/settings.mjs:192-197, 261-279) before game.webrtc exists and before
   * isAudioEnabled is available. That initial broadcast carries no real information —
   * until the first truthful update (the second broadcast, or any false value which
   * the constructor cannot emit), a remote user is not considered muted. Subsequent
   * flags are truthful and updated on every user AV settings change (including the
   * mute button). Checking MediaStreamTracks here is pointless and harmful: on a
   * receiving MediaStreamTrack `enabled` doesn't reflect the sender (local toggle,
   * always true) and `muted` reacts to RTP packet flow rather than sender mute, so
   * the old check suppressed real mutes too (the muted icon never appeared).
   * Speaking still overrides everything: someone speaking cannot be muted.
   */
  _resolveNativeMuted(userId, merged, speaking) {
    if (!merged?.muted) return false;
    const settings = game.webrtc?.settings;
    if (userId === game.user.id) {
      return !!settings?.client?.users?.[game.userId]?.muted;
    }
    if (speaking || this.panel.nativeSpeaking.has(userId)) return false;
    return this._mutedReal.has(userId);
  }

  /**
   * Full rebuild of native voice states from game.webrtc.
   * Public: also called from the panel's 2-second interval — remote user mute
   * (socket userActivity -> activity.muted) arrives WITHOUT a hook and doesn't
   * always re-render the dock, so the speaking tap alone doesn't cover it.
   */
  syncNativeStates() {
    const { nativeSpeaking, nativeMuted, nativeDeafened } = this.panel;
    nativeSpeaking.clear();
    nativeMuted.clear();
    nativeDeafened.clear();

    const webrtc = game.webrtc;
    if (this._isActive() && webrtc?.settings && webrtc?.client) {
      for (const userId of webrtc.client.getConnectedUsers()) {
        if (!game.users.get(userId)?.active) continue;
        // getUser merges: own mute/hidden, remote broadcast (activity),
        // and local blocks (we muted them).
        const merged = webrtc.settings.getUser(userId);
        if (merged.speaking) nativeSpeaking.add(userId);
        if (this._resolveNativeMuted(userId, merged, merged.speaking)) nativeMuted.add(userId);
        // Deafen isn't transmitted in the protocol — we only know our own state.
        if (userId === game.user.id && webrtc.settings.client.muteAll) nativeDeafened.add(userId);
      }
    }

    for (const userId of this.panel.portraits.keys()) {
      this.panel._refreshVoiceDisplay(userId);
    }
    // Also invoked from the panel's 2-second interval: a camera stream can
    // arrive after the dock render without firing any hook.
    this._syncCameraFeeds();
    this._syncNativeQuality();
  }

  _clearNativeStates() {
    const { nativeSpeaking, nativeMuted, nativeDeafened, nativeQuality } = this.panel;
    if (!nativeSpeaking.size && !nativeMuted.size && !nativeDeafened.size && !nativeQuality.size) return;
    nativeSpeaking.clear();
    nativeMuted.clear();
    nativeDeafened.clear();
    nativeQuality.clear();
    for (const userId of this.panel.portraits.keys()) {
      this.panel._refreshVoiceDisplay(userId);
    }
    this._syncCameraFeeds();
  }

  /* -------------------------------------------- */
  /*  LiveKit connection quality on portraits     */
  /* -------------------------------------------- */

  /**
   * Tap on LiveKitClient.setConnectionQualityIndicator: avclient calls it on
   * every ConnectionQualityChanged event, but ONLY when the
   * displayConnectionQuality setting is enabled (early return in its own handler) —
   * so the tap naturally inherits that gate. The setter is also called with a
   * single argument (addConnectionQualityIndicator), in which case we fall back
   * to reading quality from participant state just like avclient does.
   * _liveKitClient appears after media starts — installation is lazy, and
   * refresh() is re-invoked by hooks (rtcSettingsChanged/renderCameraViews/userConnected)
   * and boot timers.
   */
  _installQualityTap() {
    const lk = game.webrtc?.client?._liveKitClient;
    if (!lk || lk._dvpOrigSetQuality || typeof lk.setConnectionQualityIndicator !== "function") return;
    lk._dvpOrigSetQuality = lk.setConnectionQualityIndicator;
    lk.setConnectionQualityIndicator = (userId, quality) => {
      lk._dvpOrigSetQuality.call(lk, userId, quality);
      this._onNativeQuality(userId, quality);
    };
  }

  _uninstallQualityTap() {
    const lk = game.webrtc?.client?._liveKitClient;
    if (!lk?._dvpOrigSetQuality) return;
    lk.setConnectionQualityIndicator = lk._dvpOrigSetQuality;
    delete lk._dvpOrigSetQuality;
  }

  _onNativeQuality(userId, quality) {
    if (this._destroyed || !this._isActive()) return;
    quality ??= game.webrtc?.client?._liveKitClient?.liveKitParticipants?.get?.(userId)?.connectionQuality;
    const norm = LIVEKIT_QUALITIES.has(quality) ? quality : "unknown";
    if (this.panel.nativeQuality.get(userId) === norm) return;
    this.panel.nativeQuality.set(userId, norm);
    this.panel._refreshVoiceDisplay(userId);
  }

  /**
   * Full quality rebuild from liveKitParticipants (same source as the dock
   * indicator). Serves both as initial state (the tap misses quality events that
   * arrived before installation) and self-healing: toggling displayConnectionQuality,
   * reconnects, and new participants arrive without hooks. Called from
   * syncNativeStates — including the panel's 2-second interval.
   */
  _syncNativeQuality() {
    const { nativeQuality, portraits } = this.panel;
    const lk = game.webrtc?.client?._liveKitClient;
    // Same gate as the dock indicator: setting off = no dot.
    if (!this._isActive() || !lk || !game.settings?.get("avclient-livekit", "displayConnectionQuality")) {
      if (!nativeQuality.size) return;
      nativeQuality.clear();
    }
    else {
      const participants = lk.liveKitParticipants;
      let changed = false;
      for (const userId of portraits.keys()) {
        const quality = participants?.get?.(userId)?.connectionQuality;
        const norm = LIVEKIT_QUALITIES.has(quality) ? quality : "unknown";
        if (nativeQuality.get(userId) !== norm) {
          nativeQuality.set(userId, norm);
          changed = true;
        }
      }
      // Prune entries for departed portraits so the map doesn't accumulate stale ids across sessions.
      for (const userId of [...nativeQuality.keys()]) {
        if (!portraits.has(userId)) {
          nativeQuality.delete(userId);
          changed = true;
        }
      }
      if (!changed) return;
    }
    for (const userId of portraits.keys()) {
      this.panel._refreshVoiceDisplay(userId);
    }
  }

  /**
   * Live camera video in place of the portrait image: when a user shares video
   * (canUserShareVideo — mode + permission + camera enabled), their MediaStream
   * is projected into the portrait. Primary source is client.getMediaStreamForUser;
   * fallback is srcObject on the native (hidden, but live) dock video element
   * populated by core on each render. The clone is always muted: audio plays on
   * the native element so sound is never doubled.
   */
  _syncCameraFeeds() {
    const webrtc = game.webrtc;
    for (const [userId, portrait] of this.panel.portraits) {
      const video = portrait.querySelector(".dvp-portrait-video");
      if (!video) continue;
      let live = false;
      if (this._isActive() && webrtc?.client && webrtc.canUserShareVideo?.(userId)) {
        const stream = webrtc.client.getMediaStreamForUser?.(userId)
          ?? ui.webrtc?.getUserVideoElement?.(userId)?.srcObject
          ?? null;
        if (stream) {
          if (video.srcObject !== stream) video.srcObject = stream;
          video.play?.().catch(() => { /* muted video autoplay */ });
          live = true;
        }
      }
      if (!live && video.srcObject) video.srcObject = null;
      portrait.classList.toggle("dvp-camera-live", live);
    }
  }

  /** Detach all camera projections (voice mode disabled). */
  _clearCameraFeeds() {
    for (const portrait of this.panel.portraits.values()) {
      const video = portrait.querySelector(".dvp-portrait-video");
      if (video?.srcObject) video.srcObject = null;
      portrait.classList.remove("dvp-camera-live");
    }
  }

  /**
   * Sync portrait volume sliders with core settings (if someone adjusted volume
   * in the native dock/config, portraits catch up). Skip the focused slider
   * while the user is actively dragging it.
   */
  _syncVolumeSliders() {
    if (!this._isActive()) return;
    const webrtc = game.webrtc;
    if (!webrtc?.settings) return;
    for (const [userId, portrait] of this.panel.portraits) {
      const slider = portrait.querySelector(".dvp-volume-slider");
      if (!slider || slider === document.activeElement) continue;
      let volume = webrtc.settings.getUser(userId)?.volume;
      if (!Number.isFinite(volume)) continue;
      // Settings might contain an out-of-[0, 1] volume (leftover from an old
      // 0..100 slider scale) — clamp and repair it, otherwise core throws when
      // assigning video.volume upon stream connection.
      if (volume < 0 || volume > 1) {
        volume = (Math as any).clamp(volume, 0, 1);
        webrtc.settings.set("client", `users.${userId}.volume`, volume);
      }
      slider.value = foundry.audio.AudioHelper.volumeToInput(volume);
    }
  }
}

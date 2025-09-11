import throttle from "lodash/throttle";
import * as React from "react";
import { createCast } from "ts-safe-cast";

import { createConsumptionEvent } from "$app/data/consumption_analytics";
import { trackMediaLocationChanged } from "$app/data/media_location";
import GuidGenerator from "$app/utils/guid_generator";
import { createJWPlayer } from "$app/utils/jwPlayer";
import { register } from "$app/utils/serverComponentUtil";

import { TranscodingNoticeModal } from "$app/components/Download/TranscodingNoticeModal";
import { useRunOnce } from "$app/components/useRunOnce";

const LOCATION_TRACK_EVENT_DELAY_MS = 10_000;

type SubtitleFile = {
  file: string;
  label: string;
  kind: "captions";
};

type Video = {
  sources: string[];
  guid: string;
  title: string;
  tracks: SubtitleFile[];
  external_id: string;
  latest_media_location: { location: number } | null;
  content_length: number | null;
};

const fakeVideoUrlGuidForObfuscation = "ef64f2fef0d6c776a337050020423fc0";

export const VideoStreamPlayer = ({
  playlist: initialPlaylist,
  index_to_play,
  url_redirect_id,
  purchase_id,
  should_show_transcoding_notice,
  transcode_on_first_sale,
}: {
  playlist: Video[];
  index_to_play: number;
  url_redirect_id: string;
  purchase_id: string | null;
  should_show_transcoding_notice: boolean;
  transcode_on_first_sale: boolean;
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);

  useRunOnce(() => {
    const createPlayer = async () => {
      if (!containerRef.current) return;

      const playerId = `video-player-${GuidGenerator.generate()}`;
      containerRef.current.id = playerId;

      let lastPlayedId: number | undefined;
      let isInitialSeekDone = false;
      const playlist = initialPlaylist;

      const player = await createJWPlayer(playerId, {
        width: "100%",
        height: "100%",
        playlist: playlist.map((video) => ({
          sources: video.sources.map((source) => ({
            file: source.replace(fakeVideoUrlGuidForObfuscation, video.guid),
          })),
          tracks: video.tracks,
          title: video.title,
        })),
      });

      // Temporary diagnostics to help sanity-test stalled/error behavior locally
      // eslint-disable-next-line no-console
      const log = (...args: unknown[]) => console.debug("[JWPlayer]", ...args);

      let lastKnownPosition = 0;
      let lastKnownDuration = 0;
      let isBuffering = false;
      let bufferingStartedAt = 0;
      let consecutiveReloadAttempts = 0;
      let bufferStallCheckTimeout: NodeJS.Timeout | null = null;
      const MAX_RELOAD_ATTEMPTS = 3;
      const BUFFER_STALL_MS = 5000;

      const getCurrentItemConfig = (): jwplayer.PlaylistItem => player.getPlaylistItem();

      const reloadAndResume = () => {
        if (consecutiveReloadAttempts >= MAX_RELOAD_ATTEMPTS) {
          log("Max reload attempts reached, stopping recovery");
          // Consider dispatching an event or calling a callback to notify the UI
          // that playback recovery has failed
          return;
        }
        consecutiveReloadAttempts += 1;
        throttledTrackMediaLocation.cancel();

        const resumeAt = lastKnownPosition || 0;
        log("Reloading item to recover. attempt=", consecutiveReloadAttempts, "resumeAt=", resumeAt);

        const currentItem = getCurrentItemConfig();
        player.load([currentItem]);
        player.once("playlistItem", () => {
          player.play(true);
          if (resumeAt > 0) {
            setTimeout(() => {
              try {
                player.seek(resumeAt);
                log("Sought to", resumeAt);
              } catch (e) {
                log("Seek failed after reload", e);
              }
            }, 250);
          }
        });
      };

      const updateLocalMediaLocation = (position: number, duration: number) => {
        const videoFile = playlist[player.getPlaylistIndex()];
        if (videoFile && isInitialSeekDone && lastPlayedId === player.getPlaylistIndex()) {
          const location = position === duration ? 0 : position;
          if (videoFile.latest_media_location == null) videoFile.latest_media_location = { location };
          else videoFile.latest_media_location.location = location;
        }
      };

      const trackMediaLocation = (position: number) => {
        if (purchase_id != null) {
          const videoFile = playlist[player.getPlaylistIndex()];
          if (!videoFile) return;
          void trackMediaLocationChanged({
            urlRedirectId: url_redirect_id,
            productFileId: videoFile.external_id,
            purchaseId: purchase_id,
            location:
              videoFile.content_length != null && position > videoFile.content_length
                ? videoFile.content_length
                : position,
          });
        }
      };

      const throttledTrackMediaLocation = throttle(trackMediaLocation, LOCATION_TRACK_EVENT_DELAY_MS);

      player.on("ready", () => {
        player.playlistItem(index_to_play);
      });

      player.on("seek", (ev) => {
        trackMediaLocation(ev.offset);
        updateLocalMediaLocation(ev.offset, player.getDuration());
        lastKnownPosition = ev.offset;
      });

      player.on("time", (ev) => {
        throttledTrackMediaLocation(ev.position);
        updateLocalMediaLocation(ev.position, ev.duration);
        lastKnownPosition = ev.position;
        lastKnownDuration = ev.duration;
        isBuffering = false;
        bufferingStartedAt = 0;
        consecutiveReloadAttempts = 0;
        if (bufferStallCheckTimeout) {
          clearTimeout(bufferStallCheckTimeout);
          bufferStallCheckTimeout = null;
        }
      });

      player.on("complete", () => {
        throttledTrackMediaLocation.cancel();
        const videoFile = playlist[player.getPlaylistIndex()];
        if (!videoFile) return;
        trackMediaLocation(videoFile.content_length === null ? player.getDuration() : videoFile.content_length);
        updateLocalMediaLocation(player.getDuration(), player.getDuration());
      });

      player.on("play", () => {
        const itemId = player.getPlaylistIndex();
        const videoFile = playlist[itemId];
        if (videoFile !== undefined && lastPlayedId !== itemId) {
          void createConsumptionEvent({
            eventType: "watch",
            urlRedirectId: url_redirect_id,
            productFileId: videoFile.external_id,
            purchaseId: purchase_id,
          });
          lastPlayedId = itemId;
          isInitialSeekDone = false;
        }
      });

      // Recovery and diagnostics events
      player.on("buffer", () => {
        log("buffer");
        isBuffering = true;
        bufferingStartedAt = Date.now();
        if (bufferStallCheckTimeout) clearTimeout(bufferStallCheckTimeout);
        bufferStallCheckTimeout = setTimeout(() => {
          if (isBuffering && Date.now() - bufferingStartedAt >= BUFFER_STALL_MS) {
            log("buffer stall detected, attempting reload");
            reloadAndResume();
          }
          bufferStallCheckTimeout = null;
        }, BUFFER_STALL_MS + 50);
      });

      // 'stalled' may not be present in jwplayer typings; rely on other events

      player.on("idle", () => {
        log("idle at", lastKnownPosition, "/", lastKnownDuration);
        if (lastKnownDuration > 0 && lastKnownPosition < lastKnownDuration - 1) {
          log("unexpected idle before end, attempting reload");
          reloadAndResume();
        }
      });

      player.on("error", (ev) => {
        log("error", ev);
        reloadAndResume();
      });

      player.on("visualQuality", () => {
        if (isInitialSeekDone && lastPlayedId === player.getPlaylistIndex()) return;
        const videoFile = playlist[player.getPlaylistIndex()];
        if (
          videoFile?.latest_media_location != null &&
          videoFile.latest_media_location.location !== videoFile.content_length
        ) {
          player.seek(videoFile.latest_media_location.location);
        }
        isInitialSeekDone = true;
      });
    };

    void createPlayer();
  });

  return (
    <>
      {should_show_transcoding_notice ? (
        <TranscodingNoticeModal transcodeOnFirstSale={transcode_on_first_sale} />
      ) : null}
      <div ref={containerRef} className="absolute h-full w-full"></div>
    </>
  );
};

export default register({ component: VideoStreamPlayer, propParser: createCast() });

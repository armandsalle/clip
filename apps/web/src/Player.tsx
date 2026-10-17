import { useEffect, useRef, useState, type RefObject } from "react";
import type { Comment } from "@clip/domain";
import type { Chapter } from "./types.ts";
import type { Viewer } from "./live.ts";
import { formatTime, presenceColor } from "./util.ts";

/**
 * Lecteur : HLS de Cloudflare Stream (natif sur Safari, hls.js ailleurs) ou MP4
 * direct du faux Stream local. La timeline porte les commentaires (losanges) et la
 * position des autres spectateurs (pastilles).
 */
export const Player = ({
  src,
  poster,
  videoRef,
  duration: knownDuration,
  comments,
  viewers,
  selfId,
  chapters,
  onTime,
}: {
  src: string;
  poster: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  duration: number;
  comments: ReadonlyArray<Comment>;
  viewers: ReadonlyArray<Viewer>;
  selfId: string | null;
  chapters: ReadonlyArray<Chapter>;
  onTime: (time: number) => void;
}) => {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const duration = mediaDuration || knownDuration || 1;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!src.includes(".m3u8") || video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }
    let destroy = () => {};
    void import("hls.js").then(({ default: Hls }) => {
      if (!Hls.isSupported()) {
        video.src = src;
        return;
      }
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      destroy = () => hls.destroy();
    });
    return () => destroy();
  }, [src, videoRef]);

  const seekTo = (clientX: number, track: HTMLElement) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = track.getBoundingClientRect();
    video.currentTime = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
  };

  const chapter = [...chapters].reverse().find((c) => c.time <= time);
  const pct = (t: number) => `${Math.min(100, (t / duration) * 100)}%`;

  return (
    <div className="player" ref={container}>
      <video
        ref={videoRef}
        poster={poster}
        playsInline
        onClick={() => {
          const v = videoRef.current;
          if (v) void (v.paused ? v.play() : v.pause());
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setMediaDuration(d);
        }}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          onTime(e.currentTarget.currentTime);
        }}
      />
      <div className="controls">
        <div className="track" onClick={(e) => seekTo(e.clientX, e.currentTarget)}>
          {viewers
            .filter((v) => v.id !== selfId)
            .map((v) => (
              <div
                key={v.id}
                className="viewer-dot"
                title={`${v.name} · ${formatTime(v.time)}`}
                style={{ left: pct(v.time), background: presenceColor(v.name) }}
              />
            ))}
          <div className="track-line">
            <div className="track-fill" style={{ width: pct(time) }} />
            {comments
              .filter((c) => c.parentId === null)
              .map((c) => (
                <div
                  key={c.id}
                  className="marker"
                  title={`${c.author} · ${formatTime(c.time)}`}
                  style={{ left: pct(c.time) }}
                />
              ))}
          </div>
        </div>
        <div className="controls-row">
          <div className="group">
            <button
              className="icon-btn"
              aria-label={playing ? "Pause" : "Lecture"}
              onClick={() => {
                const v = videoRef.current;
                if (v) void (v.paused ? v.play() : v.pause());
              }}
            >
              {playing ? (
                <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
                  <path d="M2 1.5h3.5v13H2zM8.5 1.5H12v13H8.5z" fill="#fff" />
                </svg>
              ) : (
                <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden>
                  <path d="M2 1.5v13l11-6.5z" fill="#fff" />
                </svg>
              )}
            </button>
            <span className="time">
              {formatTime(time)} / {formatTime(duration)}
            </span>
            {chapter && (
              <span className="muted" style={{ fontSize: 13 }}>
                {chapter.title}
              </span>
            )}
          </div>
          <button
            className="icon-btn"
            aria-label="Plein écran"
            onClick={() => void container.current?.requestFullscreen?.()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"
                fill="none"
                stroke="#fff"
                strokeWidth="1.3"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

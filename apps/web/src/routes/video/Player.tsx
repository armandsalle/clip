import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { preconnect } from "react-dom";
import type { EnrichmentStatus } from "@clip/domain";
import type { Viewer } from "../../live.ts";
import { formatTime, presenceColor } from "../../util.ts";

// Lecteur v2 : HLS de Cloudflare Stream (natif sur Safari, hls.js ailleurs) ou MP4 du
// faux Stream local. Sous-titres on/off, choix de la qualité avec la rendition en cours,
// badge « HD en cours », timeline avec chapitres, commentaires et spectateurs.

export interface PlayerHandle {
  toggle(): void;
  seek(time: number, play?: boolean): void;
  skip(delta: number): void;
  toggleCaptions(): void;
  fullscreen(): void;
  currentTime(): number;
}

interface Level {
  readonly index: number;
  readonly height: number;
}

/** Contrôle hls.js minimal dont le lecteur a besoin. */
interface HlsLike {
  levels: ReadonlyArray<{ height: number }>;
  currentLevel: number;
  nextLevel: number;
  autoLevelEnabled: boolean;
  destroy(): void;
}

const CAPTIONS_KEY = "clip:cc";
const readCaptions = () => {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== "off";
  } catch {
    return true;
  }
};

const label = (height: number) => (height >= 1080 ? `${height}p HD` : `${height}p`);

export const Player = ({
  ref,
  src,
  poster,
  captions,
  captionsLang,
  duration: knownDuration,
  startAt,
  chapters,
  commentTimes,
  viewers,
  hd,
  onTime,
}: {
  ref: Ref<PlayerHandle>;
  src: string;
  poster: string;
  /** VTT servi par clip-api ; absent tant qu'il n'y a pas de transcription. */
  captions?: string | undefined;
  captionsLang?: string | undefined;
  duration: number;
  /** Position de départ (rafraîchissement, lien ?t=). */
  startAt: number;
  chapters: ReadonlyArray<{ readonly time: number; readonly title: string }>;
  commentTimes: ReadonlyArray<number>;
  viewers: ReadonlyArray<Viewer>;
  /** Étape `hd` : tant qu'elle tourne, la meilleure qualité n'est pas encore prête. */
  hd: EnrichmentStatus | undefined;
  onTime: (time: number, playing: boolean) => void;
}) => {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const hls = useRef<HlsLike | null>(null);
  const [time, setTime] = useState(startAt);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [captionsOn, setCaptionsOn] = useState(readCaptions);
  const [levels, setLevels] = useState<ReadonlyArray<Level>>([]);
  /** -1 : automatique. */
  const [choice, setChoice] = useState(-1);
  const [rendition, setRendition] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const duration = mediaDuration || knownDuration || 1;
  const hdRunning = hd?._tag === "Running";

  useImperativeHandle(ref, () => ({
    toggle: () => {
      const v = video.current;
      if (v) void (v.paused ? v.play() : v.pause());
    },
    seek: (t, play = true) => {
      const v = video.current;
      if (!v) return;
      setTime(t);
      setLoading(true);
      v.currentTime = t;
      if (play) void v.play();
    },
    skip: (delta) => {
      const v = video.current;
      if (!v) return;
      const t = Math.min(duration, Math.max(0, v.currentTime + delta));
      setTime(t);
      v.currentTime = t;
    },
    toggleCaptions: () => setCaptionsOn((on) => !on),
    fullscreen: () =>
      void (document.fullscreenElement
        ? document.exitFullscreen()
        : box.current?.requestFullscreen?.()),
    currentTime: () => video.current?.currentTime ?? 0,
  }));

  // Préconnexion au domaine Stream (DNS + TLS) : le premier saut n'a pas à la payer.
  useEffect(() => {
    if (src.startsWith("http")) preconnect(new URL(src).origin, { crossOrigin: "anonymous" });
  }, [src]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const native = !src.includes(".m3u8") || v.canPlayType("application/vnd.apple.mpegurl");
    if (native) {
      v.src = src;
      return;
    }
    let cancelled = false;
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        v.src = src;
        return;
      }
      const instance = new Hls({
        // Auto : plafond à la taille réelle du lecteur × densité de pixels.
        capLevelToPlayerSize: true,
        abrEwmaDefaultEstimate: 5_000_000,
        // Pas de mesure de débit sur un premier segment basse qualité : on démarre au
        // niveau choisi ci-dessous, l'ABR redescend ensuite si la connexion ne suit pas.
        testBandwidth: false,
        startFragPrefetch: true,
        startPosition: startAt > 0 ? startAt : -1,
      });
      instance.subtitleDisplay = false;
      instance.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        // Démarrage directement dans la meilleure qualité que le lecteur peut afficher
        // (hauteur réelle × densité de pixels), au lieu du premier niveau du manifeste.
        const target = Math.ceil(v.clientHeight * (window.devicePixelRatio || 1));
        const ranked = data.levels
          .map((l, index) => ({ index, height: l.height }))
          .sort((a, b) => a.height - b.height);
        const start = ranked.findLast((l) => l.height <= target) ?? ranked[0];
        if (start) instance.startLevel = start.index;
        setLevels(
          data.levels
            .map((l, index) => ({ index, height: l.height }))
            .filter((l) => l.height > 0)
            .sort((a, b) => b.height - a.height),
        );
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_e, data) =>
        setRendition(instance.levels[data.level]?.height ?? null),
      );
      instance.loadSource(src);
      instance.attachMedia(v);
      hls.current = instance;
    });
    return () => {
      cancelled = true;
      hls.current?.destroy();
      hls.current = null;
    };
  }, [src, startAt]);

  // Sous-titres : piste <track> du Worker, affichée ou masquée, choix mémorisé.
  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (track) track.mode = captionsOn ? "showing" : "hidden";
    try {
      localStorage.setItem(CAPTIONS_KEY, captionsOn ? "on" : "off");
    } catch {
      // facultatif
    }
  }, [captionsOn, captions]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".p-menu, .p-quality")) setMenu(false);
    };
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [menu]);

  const chooseLevel = (index: number) => {
    const instance = hls.current;
    if (!instance) return;
    setChoice(index);
    // nextLevel : bascule au prochain segment, sans couper la lecture.
    instance.nextLevel = index;
    setMenu(false);
  };

  const seekAt = (clientX: number, track: HTMLElement) => {
    const rect = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * duration;
    const v = video.current;
    if (!v) return;
    setTime(t);
    setLoading(true);
    v.currentTime = t;
  };

  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  const segments =
    chapters.length > 0
      ? chapters.map((c, i) => ({ start: c.time, end: chapters[i + 1]?.time ?? duration }))
      : [{ start: 0, end: duration }];
  const best = levels[0]?.height ?? null;
  const hdProgress = hd?._tag === "Running" ? hd.progress : undefined;

  return (
    <div className="p-player" ref={box}>
      <video
        ref={video}
        poster={poster}
        playsInline
        preload="metadata"
        onClick={() => {
          const v = video.current;
          if (v) void (v.paused ? v.play() : v.pause());
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          onTime(video.current?.currentTime ?? 0, false);
        }}
        onSeeking={() => setLoading(true)}
        onWaiting={() => setLoading(true)}
        onSeeked={() => setLoading(false)}
        onPlaying={() => setLoading(false)}
        onCanPlay={() => setLoading(false)}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (Number.isFinite(v.duration)) setMediaDuration(v.duration);
          // Lecture native (Safari, MP4 local) : on se place à la position de départ.
          if (startAt > 0 && v.currentTime < 1) v.currentTime = startAt;
        }}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          onTime(e.currentTarget.currentTime, !e.currentTarget.paused);
        }}
      >
        {captions && (
          <track
            key={captions}
            kind="subtitles"
            src={captions}
            srcLang={captionsLang ?? "fr"}
            label="Sous-titres"
            default={captionsOn}
          />
        )}
      </video>

      <div className="p-top">
        {hdRunning && (
          <span className="p-badge p-badge-hd">
            <span className="c-dot" aria-hidden />
            HD en cours{hdProgress !== undefined && ` · ${Math.floor(hdProgress)} %`}
          </span>
        )}
        {rendition !== null && <span className="p-badge p-badge-rendition">{rendition}p</span>}
      </div>

      {loading && (
        <div className="p-loading" aria-label="Chargement">
          <svg className="spin" width="28" height="28" viewBox="0 0 20 20" aria-hidden>
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="rgba(255,255,255,.25)"
              strokeWidth="2"
            />
            <path
              d="M10 2a8 8 0 0 1 8 8"
              fill="none"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}

      {menu && levels.length > 0 && (
        <div className="p-menu" role="menu" aria-label="Qualité">
          <p className="p-menu-title">Qualité</p>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={choice === -1}
            className={`p-menu-item ${choice === -1 ? "p-menu-active" : ""}`}
            onClick={() => chooseLevel(-1)}
          >
            Auto
            <span className="p-menu-meta">{rendition !== null ? `${rendition}p` : ""}</span>
          </button>
          {hdRunning && best !== null && best < 1080 && (
            <div className="p-menu-item p-menu-pending" aria-disabled="true">
              1080p HD
              <span className="p-menu-progress">
                en cours{hdProgress !== undefined && ` ${Math.floor(hdProgress)} %`}
              </span>
            </div>
          )}
          {levels.map((l) => (
            <button
              key={l.index}
              type="button"
              role="menuitemradio"
              aria-checked={choice === l.index}
              className={`p-menu-item ${choice === l.index ? "p-menu-active" : ""}`}
              onClick={() => chooseLevel(l.index)}
            >
              {label(l.height)}
              {choice === l.index && (
                <svg width="12" height="12" viewBox="0 0 20 20" aria-hidden>
                  <path
                    d="m5 10.5 3.2 3.2L15 6.8"
                    fill="none"
                    stroke="var(--clip-fg)"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="p-bottom">
        <div
          className="p-track"
          role="slider"
          tabIndex={0}
          aria-label="Position de lecture"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatTime(time)} sur ${formatTime(duration)}`}
          onPointerDown={(e) => seekAt(e.clientX, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
          }}
        >
          {segments.map((s) => {
            const fill = Math.min(1, Math.max(0, (time - s.start) / (s.end - s.start || 1)));
            return (
              <span
                key={s.start}
                className="p-seg"
                style={{ flexGrow: Math.max(0.0001, s.end - s.start) }}
              >
                <span className="p-seg-fill" style={{ width: `${fill * 100}%` }} />
              </span>
            );
          })}
          {commentTimes.map((t, i) => (
            <span key={`c${i}`} className="p-marker" style={{ left: pct(t) }} aria-hidden />
          ))}
          {viewers.map((v) => (
            <span
              key={v.id}
              className="p-viewer"
              title={`${v.name} · ${formatTime(v.time)}`}
              style={{ left: pct(v.time), background: presenceColor(v.name) }}
            />
          ))}
          <span className="p-thumb" style={{ left: pct(time) }} aria-hidden />
        </div>
        <div className="p-row">
          <div className="p-group">
            <button
              type="button"
              className="p-icon"
              aria-label={playing ? "Pause" : "Lecture"}
              onClick={() => {
                const v = video.current;
                if (v) void (v.paused ? v.play() : v.pause());
              }}
            >
              {playing ? (
                <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
                  <rect x="4" y="3" width="4" height="14" rx="1" fill="#fff" />
                  <rect x="12" y="3" width="4" height="14" rx="1" fill="#fff" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
                  <path d="M5 3.5v13l11-6.5z" fill="#fff" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="p-icon"
              aria-label={muted ? "Activer le son" : "Couper le son"}
              onClick={() => {
                const v = video.current;
                if (v) v.muted = !v.muted;
              }}
            >
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
                <path d="M3 8h3l4-4v12l-4-4H3z" fill="#fff" />
                {muted ? (
                  <path
                    d="m13 8 4 4m0-4-4 4"
                    stroke="#fff"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                ) : (
                  <path
                    d="M13 7c1.5 1.5 1.5 4.5 0 6M15.5 5c2.6 2.8 2.6 7.2 0 10"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                )}
              </svg>
            </button>
            <span className="p-time">
              {formatTime(time)} / {formatTime(duration)}
            </span>
          </div>
          <div className="p-group p-group-right">
            {captions && (
              <button
                type="button"
                className={`p-cc ${captionsOn ? "p-cc-on" : ""}`}
                aria-pressed={captionsOn}
                aria-label="Sous-titres"
                onClick={() => setCaptionsOn((on) => !on)}
              >
                CC
              </button>
            )}
            {levels.length > 0 && (
              <button
                type="button"
                className="p-quality"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((m) => !m)}
              >
                {choice === -1
                  ? rendition !== null
                    ? `${rendition}p`
                    : "Auto"
                  : `${levels.find((l) => l.index === choice)?.height ?? ""}p`}
                <svg width="10" height="10" viewBox="0 0 20 20" aria-hidden>
                  <path
                    d="m5 12 5-5 5 5"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="p-icon"
              aria-label="Plein écran"
              onClick={() =>
                void (document.fullscreenElement
                  ? document.exitFullscreen()
                  : box.current?.requestFullscreen?.())
              }
            >
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
                <path
                  d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

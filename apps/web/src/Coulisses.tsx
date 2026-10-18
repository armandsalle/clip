import { useEffect, useState } from "react";
import type { EnrichmentStatus, VideoId } from "@clip/domain";
import type { LiveEvent } from "@clip/contract";
import type { Received } from "./live.ts";
import { stepDetail, stepState, Tile, type StepState } from "./ui.tsx";
import { useVideo } from "./useVideo.ts";
import { formatTime, navigate } from "./util.ts";

// Coulisses : l'écran projeté pendant la démo. Chaque tuile suit en direct une
// étape du Workflow (les événements `Step` publiés par le pipeline Effect via le
// Durable Object), à la manière de Visual Effect : attente, en cours, succès,
// échec, nouvelle tentative, désactivé.

const clock = (date: Date) =>
  `${date.toLocaleTimeString("fr-FR", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`;

const stateClass = (s: StepState) => `c-${s}`;

const describe = (event: LiveEvent): { name: string; detail: string; tone: string } => {
  switch (event._tag) {
    case "Step": {
      const s = event.status;
      const tone = stateClass(stepState(s));
      const name = `pipeline.${event.kind}`;
      switch (s._tag) {
        case "Pending":
          return { name, detail: "en attente", tone };
        case "Running":
          return {
            name,
            detail:
              s.attempt > 1
                ? `nouvelle tentative ${s.attempt}/3`
                : s.progress !== undefined
                  ? `${Math.floor(s.progress)} %`
                  : "démarre",
            tone,
          };
        case "Done":
          return { name, detail: `terminé · ${stepDetail(s)}`, tone };
        case "Failed":
          return { name, detail: `échec · ${s.error} (${s.attempts} essais)`, tone };
        case "Disabled":
          return { name, detail: "désactivé (flag)", tone };
      }
    }
    case "VideoChanged":
      return {
        name: "video.changed",
        detail: `${event.video.status._tag}${event.video.title ? ` · ${event.video.title}` : ""}`,
        tone: "",
      };
    case "CommentAdded":
      return {
        name: "comment.new",
        detail: `${event.comment.author} @ ${formatTime(event.comment.time)}`,
        tone: "",
      };
    case "Presence":
      return {
        name: "room.presence",
        detail: `${event.viewers.length} connecté(s)`,
        tone: "faint",
      };
  }
};

/** Nombre d'événements par étape : sert à rejouer l'animation à chaque changement. */
const countByKind = (events: ReadonlyArray<Received>) => {
  const counts: Record<string, number> = {};
  for (const { event } of events)
    if (event._tag === "Step") counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
};

const Branch = ({
  label,
  status,
  flash,
  via,
  now,
}: {
  label: string;
  status: EnrichmentStatus | undefined;
  flash: number | undefined;
  via: string;
  now: number;
}) => {
  const state = stepState(status);
  return (
    <>
      <Tile state={state} size="large" flashKey={flash} />
      <div className="branch-label">
        <span className={state === "pending" || state === "disabled" ? "muted" : ""}>{label}</span>
        <small className={state === "done" ? "faint" : stateClass(state)}>
          {stepDetail(status, now)}
          {state === "done" && ` · ${via}`}
        </small>
      </div>
    </>
  );
};

export const Coulisses = ({ id }: { id: VideoId }) => {
  const { view, comments, steps, live } = useVideo(id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const flashes = countByKind(live.events);
  const perSecond = live.events.filter((e) => now - e.receivedAt.getTime() < 5000).length / 5;
  const status = view?.video.status._tag ?? "Uploading";
  // Le serveur ne marque la vidéo qu'à l'encodage : le premier événement du pipeline
  // sur l'encodage prouve que le fichier est arrivé.
  const uploaded = status !== "Uploading" || steps.encoding !== undefined;
  // Durée totale « dépôt → tout fini » : figée quand plus aucune étape n'est en cours.
  const kinds = Object.values(steps);
  const finished =
    status === "Ready" &&
    kinds.length > 0 &&
    kinds.every((s) => s !== undefined && stepState(s) !== "running" && stepState(s) !== "pending");
  const lastEvent = live.events[0]?.receivedAt.getTime();
  const end = finished && lastEvent !== undefined ? lastEvent : now;
  const elapsed = view
    ? Math.max(0, Math.floor((end - view.video.createdAt.epochMilliseconds) / 1000))
    : 0;

  return (
    <div className="coulisses">
      <header className="coulisses-head">
        <div>
          <div className="eyebrow">
            <a
              href={`/v/${id}`}
              className="faint"
              style={{ textDecoration: "none" }}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/v/${id}`);
              }}
            >
              ← vidéo
            </a>{" "}
            · Coulisses
          </div>
          <h1>{view?.video.title ?? "Vidéo sans titre"}</h1>
        </div>
        <div className="counters">
          <div className="counter">
            <strong>{live.viewers.length}</strong>
            <span>websockets</span>
          </div>
          <div className="counter">
            <strong>{comments.length}</strong>
            <span>commentaires</span>
          </div>
          <div className="counter">
            <strong>{perSecond.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}</strong>
            <span>msg/s</span>
          </div>
          <div className="counter">
            <strong>{formatTime(elapsed).padStart(5, "0")}</strong>
            <span>{finished ? "durée totale" : "workflow"}</span>
          </div>
        </div>
      </header>

      <div className="coulisses-body">
        <section className="graph">
          <div className="graph-flow">
            <div className="graph-stage">
              <Tile state={uploaded ? "done" : "running"} size="xl" />
              upload
              <small>{uploaded ? "R2 · Stream" : "en cours"}</small>
            </div>
            <div className="graph-arrow">→</div>
            <div className="graph-stage">
              <Tile
                state={
                  status === "Ready"
                    ? "done"
                    : status === "Failed"
                      ? "failed"
                      : uploaded
                        ? "running"
                        : "pending"
                }
                size="xl"
                flashKey={flashes.encoding}
              />
              encodage
              <small>
                {steps.encoding
                  ? `${stepDetail(steps.encoding, now)} · Stream`
                  : status === "Ready"
                    ? "lisible · Stream"
                    : "Stream"}
              </small>
            </div>
            <div className="graph-arrow">→</div>
            <div className="branches">
              <div className="branch">
                <Branch
                  label="miniature auto"
                  status={steps.thumbnail}
                  flash={flashes.thumbnail}
                  via="Stream"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="piste audio"
                  status={steps.audio}
                  flash={flashes.audio}
                  via="Stream"
                  now={now}
                />
                <span className="graph-arrow" style={{ paddingTop: 0 }}>
                  →
                </span>
                <Branch
                  label="transcription"
                  status={steps.transcript}
                  flash={flashes.transcript}
                  via="Nova-3"
                  now={now}
                />
                <span className="graph-arrow" style={{ paddingTop: 0 }}>
                  →
                </span>
                <Branch
                  label="titre · résumé"
                  status={steps.summary}
                  flash={flashes.summary}
                  via="Llama"
                  now={now}
                />
                <span className="graph-arrow" style={{ paddingTop: 0 }}>
                  →
                </span>
                <Branch
                  label="sous-titres"
                  status={steps.captions}
                  flash={flashes.captions}
                  via="Stream"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="email « vidéo prête »"
                  status={steps.notify}
                  flash={flashes.notify}
                  via="Email Service"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="qualité HD"
                  status={steps.hd}
                  flash={flashes.hd}
                  via="Stream"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="suggestions"
                  status={steps.suggestions}
                  flash={flashes.suggestions}
                  via="3 images"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="vignettes"
                  status={steps.storyboard}
                  flash={flashes.storyboard}
                  via="Container"
                  now={now}
                />
              </div>
              <div className="branch">
                <Branch
                  label="carte de partage"
                  status={steps.shareCard}
                  flash={flashes.shareCard}
                  via="Images"
                  now={now}
                />
              </div>
            </div>
          </div>
          <div className="legend">
            <span>
              <i /> en attente
            </span>
            <span>
              <i
                style={{
                  borderColor: "var(--clip-running)",
                  background: "color-mix(in oklab, var(--clip-running) 25%, transparent)",
                }}
              />{" "}
              en cours
            </span>
            <span>
              <i
                style={{
                  borderColor: "var(--clip-success)",
                  background: "color-mix(in oklab, var(--clip-success) 25%, transparent)",
                }}
              />{" "}
              succès
            </span>
            <span>
              <i
                style={{
                  borderColor: "var(--clip-failed)",
                  background: "color-mix(in oklab, var(--clip-failed) 25%, transparent)",
                }}
              />{" "}
              échec
            </span>
            <span>
              <i
                style={{
                  borderColor: "var(--clip-retry)",
                  background: "color-mix(in oklab, var(--clip-retry) 25%, transparent)",
                }}
              />{" "}
              nouvelle tentative
            </span>
            <span>
              <i style={{ borderStyle: "dashed", background: "none" }} /> désactivé (flag)
            </span>
          </div>
        </section>

        <section className="feed">
          <div className="feed-head">
            Événements
            <span className={`feed-live ${live.connected ? "" : "off"}`}>
              {live.connected ? "en direct" : "reconnexion…"}
            </span>
          </div>
          <div className="feed-list">
            {live.events.length === 0 && (
              <div className="faint" style={{ fontSize: 13 }}>
                En attente d'événements : déposez une vidéo ou commentez-la.
              </div>
            )}
            {live.events.map((e, i) => {
              const d = describe(e.event);
              return (
                <div
                  key={live.events.length - i}
                  className={`feed-row ${now - e.receivedAt.getTime() < 1500 ? "fresh" : ""}`}
                >
                  <span className="at">{clock(e.receivedAt)}</span>
                  <span className={d.tone}>{d.name}</span>
                  <span className="what">{d.detail}</span>
                </div>
              );
            })}
          </div>
          <div className="feed-foot">
            traces du Workflow et du Worker · Durable Object → WebSocket
          </div>
        </section>
      </div>
    </div>
  );
};

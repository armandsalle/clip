import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { expiresAt, type Expiry, type VideoId } from "@clip/domain";
import { Email, type UpdateVideo, VideoView } from "@clip/contract";
import { errorMessage } from "../../api/client.ts";
import { keys, removeVideo, updateVideo } from "../../api/queries.ts";
import { Button, Segmented } from "../../ui/controls.tsx";
import { copy, formatTime, ownerEmail } from "../../util.ts";

// Réglages du propriétaire (visibles avec le lien d'admin) : miniature, expiration,
// email de notification, lien d'admin, suppression.

const expiries: ReadonlyArray<{ readonly key: Expiry; readonly label: string }> = [
  { key: "1d", label: "24 h" },
  { key: "7d", label: "7 jours" },
  { key: "30d", label: "30 jours" },
  { key: "never", label: "Jamais" },
];

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const isEmail = Schema.is(Email);

export const OwnerSettings = ({
  id,
  view,
  adminKey,
  time,
  onClose,
}: {
  id: VideoId;
  view: VideoView;
  adminKey: string;
  time: number;
  onClose: () => void;
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const video = view.video;
  const [email, setEmail] = useState(() => ownerEmail.of(id) ?? "");
  const [savedEmail, setSavedEmail] = useState(() => ownerEmail.of(id));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (payload: typeof UpdateVideo.Type) => updateVideo(id, adminKey, payload),
    onSuccess: (next) => {
      queryClient.setQueryData<VideoView>(keys.video(id), (v) =>
        v ? new VideoView({ ...v, video: next }) : v,
      );
      setNotice(null);
    },
    onError: (e) => setNotice(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: () => removeVideo(id, adminKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
      void navigate({ to: "/" });
    },
    onError: (e) => setNotice(errorMessage(e)),
  });

  const saveEmail = (next: string | null) =>
    update.mutate(
      { email: next },
      {
        onSuccess: () => {
          setSavedEmail(next);
          if (next === null) ownerEmail.forget(id);
          else ownerEmail.remember(id, next);
        },
      },
    );

  const base = view.playback?.thumbnail.split("?")[0] ?? null;
  const selected = video.thumbnail._tag === "Frame" ? video.thumbnail.time : null;
  const ends = Option.getOrNull(expiresAt(video));
  const duration = video.status._tag === "Ready" ? video.status.duration : 0;
  const adminLink = `${location.origin}/v/${id}?k=${adminKey}`;

  return (
    <div className="v-settings">
      <div className="v-settings-head">
        <div>
          <h2>Réglages de la vidéo</h2>
          <p>Visible uniquement via votre lien d'admin</p>
        </div>
        <button
          type="button"
          className="v-close"
          aria-label="Fermer les réglages"
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path
              d="m2 2 8 8M10 2 2 10"
              stroke="var(--clip-fg-2)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {base && (
        <section className="v-settings-section">
          <div className="v-settings-row">
            <h3>Miniature</h3>
            <button
              type="button"
              className="v-link v-link-muted"
              disabled={duration === 0}
              onClick={() =>
                update.mutate({ thumbnail: { _tag: "Frame", time: Math.min(duration, time) } })
              }
            >
              Utiliser l'instant {formatTime(time)}
            </button>
          </div>
          <div className="v-thumbs">
            {view.thumbnailSuggestions.map((t) => (
              <button
                key={t}
                type="button"
                className={`v-thumb ${selected === t ? "v-thumb-active" : ""}`}
                aria-pressed={selected === t}
                aria-label={`Miniature à ${formatTime(t)}`}
                onClick={() => update.mutate({ thumbnail: { _tag: "Frame", time: t } })}
              >
                <img src={`${base}?time=${Math.floor(t)}s&height=160`} alt="" loading="lazy" />
              </button>
            ))}
          </div>
          <p className="c-mono c-fg-3">
            {view.thumbnailSuggestions.length > 0
              ? `suggestions à ${view.thumbnailSuggestions.map(formatTime).join(" · ")}`
              : "suggestions en cours…"}
            {selected !== null &&
              !view.thumbnailSuggestions.includes(selected) &&
              ` · choisie à ${formatTime(selected)}`}
          </p>
        </section>
      )}

      <section className="v-settings-section">
        <div className="v-settings-row">
          <h3>Expiration</h3>
          <span className="c-mono c-fg-3">
            {ends ? `le ${dateFormat.format(new Date(ends.epochMilliseconds))}` : "jamais"}
          </span>
        </div>
        <Segmented
          label="Expiration"
          choices={expiries}
          value={video.expiry}
          onChange={(expiry) => update.mutate({ expiry })}
        />
      </section>

      <section className="v-settings-section">
        <h3>{savedEmail ? `Emails à ${savedEmail}` : "Emails de notification"}</h3>
        <p className="v-settings-hint">
          Vidéo prête, puis chaque nouveau commentaire : répondez directement depuis votre boîte
          mail.
        </p>
        <form
          className="v-settings-email"
          onSubmit={(e) => {
            e.preventDefault();
            if (isEmail(email.trim())) saveEmail(email.trim());
            else setNotice("Cette adresse semble incomplète.");
          }}
        >
          <input
            className="c-input"
            type="email"
            value={email}
            placeholder="vous@exemple.fr"
            aria-label="Email de notification"
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button
            type="submit"
            variant="quiet"
            disabled={update.isPending || email.trim() === (savedEmail ?? "")}
          >
            Enregistrer
          </Button>
        </form>
        {savedEmail && (
          <button type="button" className="v-link v-link-muted" onClick={() => saveEmail(null)}>
            Ne plus recevoir d'emails
          </button>
        )}
      </section>

      <section className="v-settings-section">
        <h3>Lien d'admin</h3>
        <p className="v-settings-hint">
          Gardez-le pour modifier la vidéo depuis un autre appareil. Ne le partagez pas.
        </p>
        <Button
          variant="quiet"
          onClick={() =>
            void copy(adminLink).then((ok) => setNotice(ok ? "Lien d'admin copié." : adminLink))
          }
        >
          Copier le lien d'admin
        </Button>
      </section>

      <section className="v-settings-section v-settings-danger">
        <div>
          <h3>Supprimer la vidéo</h3>
          <p className="v-settings-hint">Stream, transcription et commentaires</p>
        </div>
        {confirmDelete ? (
          <div className="v-confirm">
            <button
              type="button"
              className="v-delete"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Suppression…" : "Confirmer"}
            </button>
            <button
              type="button"
              className="v-link v-link-muted"
              onClick={() => setConfirmDelete(false)}
            >
              Annuler
            </button>
          </div>
        ) : (
          <button type="button" className="v-delete" onClick={() => setConfirmDelete(true)}>
            Supprimer
          </button>
        )}
      </section>

      {notice && (
        <p className="v-settings-notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
};

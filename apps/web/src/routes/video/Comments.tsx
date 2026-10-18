import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import { Comment, CommentId, type VideoId } from "@clip/domain";
import { keys, postComment } from "../../api/queries.ts";
import { errorMessage } from "../../api/client.ts";
import { CommentItem } from "../../ui/blocks.tsx";
import {
  formatAgo,
  formatTime,
  presenceColor,
  rememberViewerName,
  viewerName,
} from "../../util.ts";

export interface CommentsHandle {
  /** « K » : commenter à l'instant donné. */
  focusAt(time: number): void;
}

const DEFAULT_NAME = "Invité";

interface Draft {
  readonly body: string;
  readonly time: number;
  readonly parentId: CommentId | null;
}

/** Saisie d'un commentaire (ou d'une réponse), horodaté à l'instant de la vidéo. */
const Composer = ({
  textarea,
  time,
  placeholder,
  pending,
  onSubmit,
  onCancel,
  compact = false,
}: {
  textarea?: Ref<HTMLTextAreaElement>;
  time: number | null;
  placeholder: string;
  pending: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
  compact?: boolean;
}) => {
  const [body, setBody] = useState("");
  const submit = async () => {
    const text = body.trim();
    if (!text || pending) return;
    if (await onSubmit(text)) setBody("");
  };
  return (
    <form
      className={`v-composer ${compact ? "v-composer-compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={textarea}
        value={body}
        maxLength={2000}
        rows={compact ? 1 : 2}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") onCancel?.();
        }}
      />
      <div className="v-composer-row">
        {time !== null ? (
          <span className="c-badge c-badge-raised c-mono">
            <svg width="7" height="8" viewBox="0 0 8 10" aria-hidden>
              <path d="M0 0l8 5-8 5z" fill="var(--clip-fg-2)" />
            </svg>
            à {formatTime(time)}
          </span>
        ) : (
          <span />
        )}
        <div className="v-composer-actions">
          {onCancel && (
            <button type="button" className="v-link v-link-muted" onClick={onCancel}>
              Annuler
            </button>
          )}
          <button type="submit" className="v-publish" disabled={!body.trim() || pending}>
            {pending ? "Envoi…" : "Publier"}
          </button>
        </div>
      </div>
    </form>
  );
};

/** Commentaires horodatés en fils : saisie, réponses, timecodes cliquables, temps réel. */
export const Comments = ({
  ref,
  id,
  comments,
  freshIds,
  time,
  duration,
  onSeek,
}: {
  ref: Ref<CommentsHandle>;
  id: VideoId;
  comments: ReadonlyArray<Comment>;
  freshIds: ReadonlySet<string>;
  time: number;
  duration: number;
  onSeek: (t: number) => void;
}) => {
  const queryClient = useQueryClient();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState(() => viewerName() ?? DEFAULT_NAME);
  const [editingName, setEditingName] = useState(false);
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<CommentId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    focusAt: (t) => {
      setPinnedTime(t);
      textarea.current?.focus();
    },
  }));

  // Publication optimiste : le commentaire apparaît tout de suite, retiré si l'API refuse.
  const mutation = useMutation({
    mutationFn: (draft: Draft) =>
      postComment(id, {
        author: name,
        body: draft.body,
        time: draft.time,
        parentId: draft.parentId,
      }),
    onMutate: async (draft) => {
      await queryClient.cancelQueries({ queryKey: keys.comments(id) });
      const previous = queryClient.getQueryData<ReadonlyArray<Comment>>(keys.comments(id));
      const optimistic = new Comment({
        id: CommentId.make(crypto.randomUUID()),
        videoId: id,
        parentId: draft.parentId,
        author: name,
        body: draft.body,
        time: draft.time,
        via: "web",
        createdAt: DateTime.nowUnsafe(),
      });
      queryClient.setQueryData<ReadonlyArray<Comment>>(keys.comments(id), [
        ...(previous ?? []),
        optimistic,
      ]);
      return { previous, optimistic };
    },
    onError: (e, _draft, context) => {
      queryClient.setQueryData(keys.comments(id), context?.previous);
      setError(errorMessage(e));
    },
    onSuccess: (saved, _draft, context) => {
      setError(null);
      queryClient.setQueryData<ReadonlyArray<Comment>>(keys.comments(id), (list) => {
        const rest = (list ?? []).filter(
          (c) => c.id !== context.optimistic.id && c.id !== saved.id,
        );
        return [...rest, saved];
      });
    },
  });

  const publish = async (draft: Draft) => {
    rememberViewerName(name);
    try {
      await mutation.mutateAsync(draft);
      return true;
    } catch {
      return false;
    }
  };

  const at = Math.min(duration, pinnedTime ?? time);
  const roots = comments.filter((c) => c.parentId === null).toSorted((a, b) => a.time - b.time);
  const repliesOf = (rootId: CommentId) =>
    comments
      .filter((c) => c.parentId === rootId)
      .toSorted((a, b) => a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds);
  const ago = (c: Comment) => formatAgo(new Date(c.createdAt.epochMilliseconds));

  return (
    <div className="v-comments">
      <div className="v-comments-head">
        <Composer
          textarea={textarea}
          time={at}
          placeholder="Ajouter un commentaire…"
          pending={mutation.isPending && replyTo === null}
          onSubmit={async (body) => {
            const ok = await publish({ body, time: at, parentId: null });
            if (ok) setPinnedTime(null);
            return ok;
          }}
        />
        {editingName ? (
          <form
            className="v-name"
            onSubmit={(e) => {
              e.preventDefault();
              const next = name.trim().slice(0, 60) || DEFAULT_NAME;
              setName(next);
              rememberViewerName(next);
              setEditingName(false);
            }}
          >
            <input
              value={name}
              maxLength={60}
              autoFocus
              aria-label="Votre nom"
              onChange={(e) => setName(e.target.value)}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            />
          </form>
        ) : (
          <p className="v-panel-note">
            Vous commentez en tant que « {name} ».{" "}
            <button
              type="button"
              className="v-link v-link-muted"
              onClick={() => setEditingName(true)}
            >
              Modifier le nom
            </button>
          </p>
        )}
        {error && (
          <p className="v-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="v-comments-list">
        {roots.length === 0 ? (
          <p className="v-panel-note">
            Aucun commentaire pour l'instant. Le premier sera horodaté à l'instant de la vidéo.
          </p>
        ) : (
          roots.map((c) => {
            const replies = repliesOf(c.id);
            return (
              <div key={c.id} className={`v-thread ${freshIds.has(c.id) ? "v-fresh" : ""}`}>
                <CommentItem
                  author={c.author}
                  color={presenceColor(c.author)}
                  time={formatTime(c.time)}
                  ago={ago(c)}
                  body={c.body}
                  onSeek={() => onSeek(c.time)}
                >
                  {replies.length > 0 && (
                    <div className="v-replies">
                      {replies.map((r) => (
                        <CommentItem
                          key={r.id}
                          reply
                          author={r.author}
                          color={presenceColor(r.author)}
                          time={ago(r)}
                          ago=""
                          body={r.body}
                          viaEmail={r.via === "email"}
                        />
                      ))}
                    </div>
                  )}
                  {replyTo === c.id ? (
                    <Composer
                      compact
                      time={null}
                      placeholder={`Répondre à ${c.author}…`}
                      pending={mutation.isPending}
                      onCancel={() => setReplyTo(null)}
                      onSubmit={async (body) => {
                        const ok = await publish({ body, time: c.time, parentId: c.id });
                        if (ok) setReplyTo(null);
                        return ok;
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="v-link v-link-muted v-reply"
                      onClick={() => setReplyTo(c.id)}
                    >
                      Répondre
                    </button>
                  )}
                </CommentItem>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

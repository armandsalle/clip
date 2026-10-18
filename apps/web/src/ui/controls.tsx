import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

// Contrôles des Fondations Paper. Un seul bouton « primary » (blanc) par écran :
// l'action principale.

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export const Button = ({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) => (
  <button type="button" className={`c-btn c-btn-${variant} ${className}`} {...props} />
);

export const Field = ({
  label,
  error,
  hint,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string | null | undefined;
  hint?: ReactNode;
}) => {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`c-field ${className}`}>
      {label && (
        <label className="c-field-label" htmlFor={id}>
          {label}
        </label>
      )}
      <input
        id={id}
        className={`c-input ${error ? "c-input-error" : ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="c-field-error" role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="c-field-hint">
            {hint}
          </p>
        )
      )}
    </div>
  );
};

export interface Choice<K extends string> {
  readonly key: K;
  readonly label: string;
  /** Compteur discret (ex. nombre de commentaires). */
  readonly count?: number | undefined;
}

/** Onglets : un panneau visible à la fois. */
export const Tabs = <K extends string>({
  choices,
  value,
  onChange,
  label,
}: {
  choices: ReadonlyArray<Choice<K>>;
  value: K;
  onChange: (key: K) => void;
  label: string;
}) => (
  <div className="c-tabs" role="tablist" aria-label={label}>
    {choices.map((c) => (
      <button
        key={c.key}
        type="button"
        role="tab"
        aria-selected={c.key === value}
        className={`c-tab ${c.key === value ? "c-tab-active" : ""}`}
        onClick={() => onChange(c.key)}
      >
        {c.label}
        {c.count !== undefined && <span className="c-tab-count">{c.count}</span>}
      </button>
    ))}
  </div>
);

/** Choix exclusif compact (expiration, filtres). */
export const Segmented = <K extends string>({
  choices,
  value,
  onChange,
  label,
}: {
  choices: ReadonlyArray<Choice<K>>;
  value: K;
  onChange: (key: K) => void;
  label: string;
}) => (
  <div className="c-seg" role="radiogroup" aria-label={label}>
    {choices.map((c) => (
      <button
        key={c.key}
        type="button"
        role="radio"
        aria-checked={c.key === value}
        className={`c-seg-item ${c.key === value ? "c-seg-active" : ""}`}
        onClick={() => onChange(c.key)}
      >
        {c.label}
      </button>
    ))}
  </div>
);

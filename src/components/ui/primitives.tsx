/** Small accessible UI primitives shared by the library and the editor. */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-sky-600 active:bg-sky-700 shadow-sm',
  secondary:
    'bg-white text-ink-800 hover:bg-ink-50 border border-ink-200 dark:bg-ink-800 dark:text-ink-100 dark:border-ink-700 dark:hover:bg-ink-700',
  ghost: 'text-ink-700 hover:bg-ink-200/70 dark:text-ink-200 dark:hover:bg-ink-800',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', ...rest },
  ref,
) {
  const sizing = size === 'sm' ? 'h-9 px-3 text-sm' : 'h-11 px-4 text-sm';
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={`inline-flex touch-target items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${sizing} ${className}`}
      {...rest}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  variant?: ButtonVariant;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active = false, variant = 'ghost', className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={rest['aria-pressed'] ?? (active || undefined)}
      className={`inline-flex h-11 w-11 touch-target items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-accent/15 text-accent ring-1 ring-accent/40'
          : VARIANTS[variant]
      } disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, className = '', id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      {label ? (
        <label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-ink-400">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={`h-11 rounded-lg border border-ink-200 bg-white px-3 text-sm text-ink-900 placeholder-ink-400 focus:border-accent dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100 ${className}`}
        {...rest}
      />
      {hint ? <p className="text-xs text-ink-500 dark:text-ink-400">{hint}</p> : null}
    </div>
  );
});

export interface DialogProps {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const focusTarget = ref.current?.querySelector<HTMLElement>(
      'input, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    focusTarget?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      <div
        className="absolute inset-0 bg-ink-950/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-lg rounded-2xl bg-white p-5 shadow-panel dark:bg-ink-900"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <div className="mt-4 flex flex-col gap-4">{children}</div>
        {footer ? <div className="mt-5 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

export function MenuItem({ icon, children, className = '', ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800 ${className}`}
      {...rest}
    >
      {icon ? <span aria-hidden="true" className="text-ink-500">{icon}</span> : null}
      {children}
    </button>
  );
}

export interface PopoverProps {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
  label: string;
}

/** Lightweight anchored menu with outside-click + Escape handling. */
export function Popover({ open, onClose, children, align = 'right', className = '', label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`absolute z-40 mt-2 min-w-56 rounded-xl border border-ink-200 bg-white p-1.5 shadow-panel dark:border-ink-700 dark:bg-ink-900 ${
        align === 'right' ? 'right-0' : 'left-0'
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-2 text-sm text-ink-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-accent" />
      {label}…
    </span>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' }) {
  const tones = {
    neutral: 'bg-ink-200 text-ink-700 dark:bg-ink-800 dark:text-ink-200',
    accent: 'bg-accent/15 text-accent',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

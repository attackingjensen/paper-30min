import { X } from "lucide-react";
import { useEffect, useId, useRef, type FormEventHandler, type ReactNode, type RefObject } from "react";

interface DialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  onClose?: () => void;
  allowDismiss?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
}

export function Dialog({
  open,
  title,
  description,
  ariaLabel,
  className = "",
  children,
  footer,
  onSubmit,
  onClose,
  allowDismiss = true,
  initialFocus,
  finalFocus,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const finalFocusTarget = finalFocus?.current;
    if (open && !element.open) {
      element.showModal();
      const target = initialFocus?.current ?? element.querySelector<HTMLElement>("input, button, select, textarea");
      target?.focus({ preventScroll: true });
    } else if (!open && element.open) {
      element.close();
    }
    return () => {
      if (element.open) element.close();
      const target = finalFocusTarget ?? previousFocus;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, initialFocus, finalFocus]);

  const content = (
    <>
      {children}
      {footer && <div className="modal-footer">{footer}</div>}
    </>
  );
  return (
    <dialog
      ref={dialogRef}
      className={`modal ${className}`.trim()}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (allowDismiss) onClose?.();
      }}
    >
      <div className="ui-dialog-heading">
        <h2 className="ui-dialog-title" id={titleId}>
          {title}
        </h2>
        {onClose && allowDismiss && (
          <button type="button" className="button ghost icon ui-dialog-close" aria-label="关闭弹窗" onClick={onClose}>
            <X />
          </button>
        )}
      </div>
      {description && <p className="ui-dialog-description">{description}</p>}
      {onSubmit ? (
        <form className="modal-form" onSubmit={onSubmit}>
          {content}
        </form>
      ) : (
        content
      )}
    </dialog>
  );
}

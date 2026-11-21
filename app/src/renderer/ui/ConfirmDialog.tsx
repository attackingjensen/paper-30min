import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{cancelLabel}</Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

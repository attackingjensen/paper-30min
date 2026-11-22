import type { HTMLAttributes, ReactNode } from "react";

type MessageVariant = "info" | "success" | "warning" | "error";

interface InlineMessageProps extends HTMLAttributes<HTMLDivElement> {
  variant?: MessageVariant;
  children: ReactNode;
}

export function InlineMessage({ variant = "info", children, className = "", ...props }: InlineMessageProps) {
  return (
    <div
      className={`inline-message ${variant} ${className}`.trim()}
      role={props.role ?? (variant === "error" ? "alert" : "status")}
      {...props}
    >
      {children}
    </div>
  );
}

export function EmptyState({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`empty ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}

import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "secondary" | "primary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "secondary", type = "button", className = "", ...props }: ButtonProps) {
  return <button type={type} className={`button ${variant} ${className}`.trim()} {...props} />;
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonProps & { label: string; children: ReactNode }) {
  return (
    <Button variant="ghost" className={`icon ${className}`.trim()} title={label} aria-label={label} {...props}>
      {children}
    </Button>
  );
}

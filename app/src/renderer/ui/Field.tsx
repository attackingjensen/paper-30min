import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps } from "react";

function Root(props: ComponentProps<typeof BaseField.Root>) {
  return <BaseField.Root className="ui-field" {...props} />;
}

function Label(props: ComponentProps<typeof BaseField.Label>) {
  return <BaseField.Label className="ui-field-label" {...props} />;
}

function Control(props: ComponentProps<typeof BaseField.Control>) {
  return <BaseField.Control className="ui-input" {...props} />;
}

function Description(props: ComponentProps<typeof BaseField.Description>) {
  return <BaseField.Description className="ui-field-description" {...props} />;
}

function Error(props: ComponentProps<typeof BaseField.Error>) {
  return <BaseField.Error className="ui-field-error" {...props} />;
}

export const Field = { Root, Label, Control, Description, Error };

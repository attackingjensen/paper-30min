import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Save, RotateCcw } from "lucide-react";
import type { ProductSkill } from "../shared/product-skills";
import { Button, IconButton } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { InlineMessage } from "./ui/Feedback";

export function ProductSkillsForm({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [skills, setSkills] = useState<ProductSkill[]>([]);
  const [active, setActive] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const reloadTrigger = useRef<HTMLButtonElement | null>(null);
  const current = skills.find((skill) => skill.id === active);
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .agent<ProductSkill[]>({ type: "listSkills" })
      .then((items) => {
        if (disposed) return;
        setSkills(items);
        setActive(items[0].id);
        setContent(items[0].content);
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const dirty = current && content !== current.content;
  useEffect(() => {
    onDirty(!!dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function save() {
    if (!current) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const skill = await window.desktop.agent<ProductSkill>({
        type: "saveSkill",
        id: active,
        content,
        version: current.version,
      });
      setSkills((items) => items.map((item) => (item.id === skill.id ? skill : item)));
      setContent(skill.content);
      setStatus("已保存");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    try {
      const items = await window.desktop.agent<ProductSkill[]>({ type: "listSkills" });
      setSkills(items);
      setContent(items.find((item) => item.id === active)!.content);
      setError("");
      setStatus("");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      flushSync(() => setBusy(false));
      if (reloadTrigger.current?.isConnected) reloadTrigger.current.focus({ preventScroll: true });
    }
  }
  return (
    <div className="product-skills-form">
      <label htmlFor="product-skill">产品 Skill</label>
      <select
        id="product-skill"
        value={active}
        disabled={busy || !!dirty}
        onChange={(event) => {
          const skill = skills.find((item) => item.id === event.target.value)!;
          setActive(skill.id);
          setContent(skill.content);
          setError("");
          setStatus("");
        }}
      >
        {skills.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.name}
          </option>
        ))}
      </select>
      <label htmlFor="skill-content">提示词</label>
      <textarea
        id="skill-content"
        value={content}
        disabled={busy || !current}
        spellCheck={false}
        onChange={(event) => {
          setContent(event.target.value);
          setStatus("");
        }}
      />
      <div className="row">
        <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
          <Save /> 保存提示词
        </Button>
        <IconButton
          label="重新载入提示词"
          disabled={busy || !current}
          onClick={(event) => {
            reloadTrigger.current = event.currentTarget;
            if (dirty) setConfirmReload(true);
            else void reload();
          }}
        >
          <RotateCcw />
        </IconButton>
        {status && <InlineMessage variant="success">{status}</InlineMessage>}
      </div>
      {error && (
        <InlineMessage variant="error" className="form-error">
          {error}
        </InlineMessage>
      )}
      {confirmReload && (
        <ConfirmDialog
          title="未保存的提示词"
          description="放弃尚未保存的提示词编辑并重新载入？"
          confirmLabel="放弃并重新载入"
          cancelLabel="继续编辑"
          onClose={() => setConfirmReload(false)}
          onConfirm={() => {
            setConfirmReload(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

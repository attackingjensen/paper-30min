import { useEffect, useState } from "react";
import { Save, RotateCcw } from "lucide-react";
import type { ProductSkill } from "../shared/product-skills";

export function ProductSkillsForm({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const [skills, setSkills] = useState<ProductSkill[]>([]);
  const [active, setActive] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const current = skills.find(skill => skill.id === active);
  useEffect(() => {
    let disposed = false;
    void window.desktop.agent<ProductSkill[]>({ type: "listSkills" }).then(items => {
      if (disposed) return;
      setSkills(items); setActive(items[0].id); setContent(items[0].content);
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; };
  }, []);
  const dirty = current && content !== current.content;
  useEffect(() => { onDirty(!!dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function save() {
    if (!current) return;
    setBusy(true); setError(""); setStatus("");
    try {
      const skill = await window.desktop.agent<ProductSkill>({ type: "saveSkill", id: active, content, version: current.version });
      setSkills(items => items.map(item => item.id === skill.id ? skill : item));
      setContent(skill.content); setStatus("已保存");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="product-skills-form">
    <label htmlFor="product-skill">产品 Skill</label>
    <select id="product-skill" value={active} disabled={busy || !!dirty} onChange={event => {
      const skill = skills.find(item => item.id === event.target.value)!;
      setActive(skill.id); setContent(skill.content); setError(""); setStatus("");
    }}>{skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select>
    <label htmlFor="skill-content">提示词</label>
    <textarea id="skill-content" value={content} disabled={busy || !current} spellCheck={false}
      onChange={event => { setContent(event.target.value); setStatus(""); }} />
    <div className="row">
      <button className="primary" disabled={busy || !dirty} onClick={() => void save()}><Save /> 保存提示词</button>
      <button className="icon" title="重新载入提示词" aria-label="重新载入提示词" disabled={busy || !current}
        onClick={() => {
          if (dirty && !window.confirm("放弃尚未保存的提示词编辑并重新载入？")) return;
          setBusy(true);
          void window.desktop.agent<ProductSkill[]>({ type: "listSkills" }).then(items => {
            setSkills(items); setContent(items.find(item => item.id === active)!.content); setError(""); setStatus("");
          }).catch(error => setError(error.message)).finally(() => setBusy(false));
        }}><RotateCcw /></button>
      {status && <span role="status">{status}</span>}
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}

import { useEffect, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { defaultAgentSettings, type AgentSettings } from "../shared/contracts";

export function AgentSettingsForm({ section }: { section: "agent" | "proxy" }) {
  const [settings, setSettings] = useState<AgentSettings>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .agent<AgentSettings>({ type: "settings" })
      .then((s) => {
        if (!disposed) setSettings(s);
      })
      .catch(() => {
        if (!disposed) {
          setSettings({ ...defaultAgentSettings });
          setMessage(
            "模型配置无法读取，请重新填写配置和 API 密钥，或移除旧密钥。",
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function save(clearKey = false) {
    if (!settings) return;
    setBusy(true);
    setMessage("");
    try {
      setSettings(
        await window.desktop.agent<AgentSettings>({
          type: "saveSettings",
          settings,
          apiKey: key || undefined,
          clearKey,
        }),
      );
      setKey("");
      setMessage("已保存");
    } catch (e) {
      setMessage(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  if (!settings) return <p role="status">{message || "正在读取配置…"}</p>;
  const update = (value: Partial<AgentSettings>) => {
    setSettings({ ...settings, ...value });
    setMessage("");
  };
  return (
    <form
      className="agent-settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {section === "agent" ? (
        <>
          <label>
            接口协议
            <select
              aria-label="接口协议"
              value={settings.api}
              onChange={(e) =>
                update({ api: e.target.value as AgentSettings["api"] })
              }
            >
              <option value="openai-completions">
                OpenAI 兼容 Chat Completions
              </option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label>
            模型端点
            <input
              aria-label="模型端点"
              type="url"
              value={settings.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
              placeholder={
                settings.api === "anthropic-messages"
                  ? "https://api.anthropic.com"
                  : "https://api.example.com/v1"
              }
            />
          </label>
          <label>
            模型名称
            <input
              aria-label="模型名称"
              value={settings.model}
              onChange={(e) => update({ model: e.target.value })}
            />
          </label>
          <label>
            API 密钥
            <input
              aria-label="API 密钥"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                settings.hasKey ? "已保存在本机，留空保留" : "尚未配置"
              }
            />
          </label>
          <div className="row">
            <label>
              上下文预算
              <input
                aria-label="上下文预算"
                type="number"
                min="1024"
                max="2000000"
                value={settings.contextWindow}
                onChange={(e) =>
                  update({ contextWindow: Number(e.target.value) })
                }
              />
            </label>
            <label>
              输出上限
              <input
                aria-label="输出上限"
                type="number"
                min="1"
                max={settings.contextWindow}
                value={settings.maxTokens}
                onChange={(e) => update({ maxTokens: Number(e.target.value) })}
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <label>
            连接方式
            <select
              aria-label="连接方式"
              value={settings.proxy}
              onChange={(e) =>
                update({ proxy: e.target.value as AgentSettings["proxy"] })
              }
            >
              <option value="direct">直连</option>
              <option value="environment">环境代理</option>
              <option value="custom">指定 HTTP/HTTPS 代理</option>
            </select>
          </label>
          {settings.proxy === "custom" && (
            <label>
              代理地址
              <input
                aria-label="代理地址"
                type="url"
                placeholder="http://127.0.0.1:7897"
                value={settings.proxyUrl}
                onChange={(e) => update({ proxyUrl: e.target.value })}
                required
              />
            </label>
          )}
        </>
      )}
      <div className="row">
        <button className="borderbtn" type="submit" disabled={busy}>
          <Save /> 保存配置
        </button>
        {section === "agent" && (
          <button
            type="button"
            className="icon"
            title="移除 API 密钥"
            aria-label="移除 API 密钥"
            disabled={busy}
            onClick={() => void save(true)}
          >
            <Trash2 />
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

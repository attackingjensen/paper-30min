import { useEffect, useState } from "react";
import { Check, KeyRound, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import "./agent.css";
import { defaultAgentSettings, type AgentSettings } from "../shared/contracts";

// Keep numeric input drafts as text so clearing/replacing a value does not insert zero.
type SettingsDraft = Omit<AgentSettings, "contextWindow" | "maxTokens"> & {
  contextWindow: number | string;
  maxTokens: number | string;
};

export function AgentSettingsForm({ section }: { section: "agent" | "proxy" }) {
  const [settings, setSettings] = useState<SettingsDraft>();
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
          settings: {
            ...settings,
            contextWindow: Number(settings.contextWindow),
            maxTokens: Number(settings.maxTokens),
          },
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
  const update = (value: Partial<SettingsDraft>) => {
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
      <p className="settings-intro">
        {section === "agent"
          ? "连接你习惯使用的模型，开始对话。"
          : "选择 Agent 访问模型服务时使用的网络连接。"}
      </p>
      <fieldset disabled={busy} className="settings-fields">
        {section === "agent" ? (
          <>
            <section className="settings-group">
              <div className="settings-group-heading">
                <h2>模型连接</h2>
                <span>兼容官方服务与自定义端点</span>
              </div>
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
                  placeholder="填写服务商提供的模型 ID"
                  value={settings.model}
                  onChange={(e) => update({ model: e.target.value })}
                />
              </label>
            </section>
            <section className="settings-group">
              <div className="settings-group-heading">
                <h2>
                  <KeyRound /> API 密钥
                </h2>
                <span
                  className={
                    settings.hasKey ? "key-state configured" : "key-state"
                  }
                >
                  {settings.hasKey ? "已配置" : "未配置"}
                </span>
              </div>
              <label>
                密钥
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
              <div className="key-help">
                <p>密钥保存在本机，留空即可保留现有密钥。</p>
                <button
                  type="button"
                  className="remove-key"
                  title="移除 API 密钥"
                  aria-label="移除 API 密钥"
                  onClick={() => void save(true)}
                >
                  <Trash2 /> 移除密钥
                </button>
              </div>
            </section>
            <section className="settings-group">
              <div className="settings-group-heading">
                <h2>
                  <SlidersHorizontal /> 生成参数
                </h2>
                <span>按模型支持的范围填写</span>
              </div>
              <div className="settings-grid">
                <label>
                  上下文预算
                  <input
                    aria-label="上下文预算"
                    type="number"
                    required
                    min="1024"
                    max="2000000"
                    value={settings.contextWindow}
                    onChange={(e) => update({ contextWindow: e.target.value })}
                  />
                </label>
                <label>
                  输出上限
                  <input
                    aria-label="输出上限"
                    type="number"
                    required
                    min="1"
                    max={settings.contextWindow}
                    value={settings.maxTokens}
                    onChange={(e) => update({ maxTokens: e.target.value })}
                  />
                </label>
              </div>
              <p className="field-help">
                单位为 token；输出上限不能超过上下文预算。
              </p>
            </section>
          </>
        ) : (
          <section className="settings-group">
            <div className="settings-group-heading">
              <h2>网络连接</h2>
            </div>
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
            <p className="field-help">
              {settings.proxy === "direct"
                ? "直接连接模型服务，不经过代理。"
                : settings.proxy === "environment"
                  ? "使用应用启动时的环境代理配置。"
                  : "通过指定的 HTTP 或 HTTPS 代理连接模型服务。"}
            </p>
          </section>
        )}
      </fieldset>
      <div className="settings-save-row">
        <button className="primary" type="submit" disabled={busy}>
          <Save /> {busy ? "正在保存…" : "保存配置"}
        </button>
        {message && (
          <p
            className={
              message === "已保存"
                ? "settings-feedback success"
                : "settings-feedback"
            }
            role="status"
          >
            {message === "已保存" && <Check />}
            {message}
          </p>
        )}
      </div>
    </form>
  );
}

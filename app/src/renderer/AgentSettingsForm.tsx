import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  KeyRound,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import "./agent.css";
import {
  defaultAgentSettings,
  thinkingLevels,
  type AgentApi,
  type AgentSettings,
  type ThinkingLevel,
} from "../shared/contracts";

// Keep numeric input drafts as text so clearing/replacing a value does not insert zero.
type SettingsDraft = {
  api: AgentApi;
  baseUrl: string;
  model: string;
  name: string;
  serviceName: string;
  availableThinking: ThinkingLevel[];
  thinking: ThinkingLevel;
  hasKey: boolean;
  keyError?: boolean;
  proxy: AgentSettings["proxy"];
  proxyUrl: string;
  contextWindow: number | string;
  maxTokens: number | string;
};

function draftOf(
  catalog: AgentSettings,
  serviceId: string,
  modelId: string,
): SettingsDraft {
  const service = catalog.services.find((item) => item.id === serviceId)!;
  const model = catalog.models.find((item) => item.id === modelId)!;
  return {
    api: service.api,
    baseUrl: service.baseUrl,
    serviceName: service.name,
    hasKey: service.hasKey,
    keyError: service.keyError,
    model: model.model,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    availableThinking: model.availableThinking,
    thinking: model.thinking,
    proxy: catalog.proxy,
    proxyUrl: catalog.proxyUrl,
  };
}

export function AgentSettingsForm({
  section,
}: {
  section: "agent" | "proxy" | "search";
}) {
  const [settings, setSettings] = useState<SettingsDraft>();
  const [catalog, setCatalog] = useState<AgentSettings>();
  const [serviceId, setServiceId] = useState("default");
  const [modelId, setModelId] = useState("default");
  const [key, setKey] = useState("");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [clearKeyIds, setClearKeyIds] = useState<string[]>([]);
  const [exaKey, setExaKey] = useState("");
  const [clearExaKey, setClearExaKey] = useState(false);
  const [editingServiceName, setEditingServiceName] = useState(false);
  const [expandedModelId, setExpandedModelId] = useState<string>();
  const [modelInputDrafts, setModelInputDrafts] = useState<
    Record<string, Pick<SettingsDraft, "contextWindow" | "maxTokens">>
  >({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .agent<AgentSettings>({ type: "settings" })
      .then((s) => {
        if (!disposed) load(s);
      })
      .catch(() => {
        if (!disposed) {
          load(structuredClone(defaultAgentSettings));
          setMessage(
            "模型配置无法读取，请重新填写配置和 API 密钥，或移除旧密钥。",
          );
        }
      });
    return () => {
      disposed = true;
    };
  }, []);
  function load(value: AgentSettings) {
    const first =
      value.models.find((item) => item.id === value.selectedModelId) ??
      value.models[0];
    const service =
      value.services.find((item) => item.id === first?.serviceId) ??
      value.services[0];
    setCatalog(value);
    setServiceId(service.id);
    setModelId(first.id);
    setSettings(draftOf(value, service.id, first.id));
    setApiKeys({});
    setClearKeyIds([]);
    setKey("");
    setExaKey("");
    setClearExaKey(false);
    setModelInputDrafts({});
    setExpandedModelId(undefined);
    setEditingServiceName(false);
  }
  function merged(): AgentSettings {
    const base = catalog!;
    const services = base.services.map((service) =>
      service.id === serviceId
        ? {
            ...service,
            name: settings!.serviceName,
            api: settings!.api,
            baseUrl: settings!.baseUrl,
          }
        : service,
    );
    const models = base.models.map((model) =>
      model.id === modelId
        ? {
            ...model,
            name: settings!.name,
            model: settings!.model,
            contextWindow:
              Number(settings!.contextWindow) || model.contextWindow,
            maxTokens: Number(settings!.maxTokens) || model.maxTokens,
            availableThinking: settings!.availableThinking,
            thinking: settings!.thinking,
          }
        : model,
    );
    return {
      ...base,
      services,
      models,
      proxy: settings!.proxy,
      proxyUrl: settings!.proxyUrl,
    };
  }
  function switchTo(next: AgentSettings, service: string, model: string) {
    const entered = { ...apiKeys, ...(key ? { [serviceId]: key } : {}) };
    const nextKeys = Object.fromEntries(
      Object.entries(entered).filter(([id]) =>
        next.services.some((item) => item.id === id),
      ),
    );
    setApiKeys(nextKeys);
    setCatalog(next);
    const numericDrafts = Object.fromEntries(
      Object.entries({
        ...modelInputDrafts,
        [modelId]: {
          contextWindow: settings!.contextWindow,
          maxTokens: settings!.maxTokens,
        },
      }).filter(([id]) => next.models.some((item) => item.id === id)),
    );
    setModelInputDrafts(numericDrafts);
    setServiceId(service);
    setModelId(model);
    setSettings({
      ...draftOf(next, service, model),
      ...numericDrafts[model],
    });
    setKey(nextKeys[service] ?? "");
    setEditingServiceName(false);
    setMessage("");
  }
  async function save(clearKey = false) {
    if (!settings) return;
    setBusy(true);
    setMessage("");
    try {
      const next = merged();
      const numericDrafts = {
        ...modelInputDrafts,
        [modelId]: {
          contextWindow: settings.contextWindow,
          maxTokens: settings.maxTokens,
        },
      };
      next.models = next.models.map((model) => {
        const draft = numericDrafts[model.id];
        if (!draft) return model;
        const contextWindow = Number(draft.contextWindow);
        const maxTokens = Number(draft.maxTokens);
        if (
          draft.contextWindow === "" ||
          draft.maxTokens === "" ||
          !Number.isInteger(contextWindow) ||
          !Number.isInteger(maxTokens) ||
          contextWindow < 1024 ||
          contextWindow > 2000000 ||
          maxTokens < 1 ||
          maxTokens > contextWindow
        ) {
          throw new Error(
            `模型 ${model.name || model.model || "新模型"} 的预算无效`,
          );
        }
        return { ...model, contextWindow, maxTokens };
      });
      const saved = await window.desktop.agent<AgentSettings>({
        type: "saveSettings",
        settings: next,
        apiKeys: { ...apiKeys, ...(key ? { [serviceId]: key } : {}) },
        clearKeyIds: clearKey ? [...clearKeyIds, serviceId] : clearKeyIds,
        exaApiKey: exaKey,
        clearExaKey,
      });
      load(saved);
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
  const serviceModels = catalog!.models.filter(
    (model) => model.serviceId === serviceId,
  );
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
          : section === "search"
            ? "为 Agent 的网页搜索配置服务，所有对话共用。"
            : "选择 Agent 访问模型服务时使用的网络连接。"}
      </p>
      <fieldset disabled={busy} className="settings-fields">
        {section === "agent" ? (
          <div className="agent-model-layout">
            <aside className="agent-service-list" aria-label="服务列表">
              <h2>服务</h2>
              <div className="agent-service-options">
                {catalog!.services.map((service) => (
                  <button
                    key={service.id}
                    type="button"
                    className="agent-service-choice"
                    aria-current={service.id === serviceId}
                    aria-label={`选择服务 ${service.name}`}
                    onClick={() => {
                      if (service.id === serviceId) return;
                      const next = merged();
                      const target = next.models.find(
                        (model) => model.serviceId === service.id,
                      )!;
                      switchTo(next, service.id, target.id);
                      setExpandedModelId(undefined);
                    }}
                  >
                    <SlidersHorizontal aria-hidden="true" />
                    <span>
                      {service.id === serviceId
                        ? settings.serviceName
                        : service.name}
                    </span>
                    {service.hasKey && (
                      <i className="key-dot" title="已配置密钥" />
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="agent-add-item"
                onClick={() => {
                  const next = merged();
                  const id = crypto.randomUUID();
                  const model = crypto.randomUUID();
                  next.services.push({
                    id,
                    name: "新服务",
                    api: "openai-completions",
                    baseUrl: "",
                    hasKey: false,
                  });
                  next.models.push({
                    id: model,
                    serviceId: id,
                    name: "",
                    model: "",
                    contextWindow: 128000,
                    maxTokens: 4096,
                    availableThinking: ["off"],
                    thinking: "off",
                  });
                  next.selectedModelId = model;
                  switchTo(next, id, model);
                  setEditingServiceName(true);
                  setExpandedModelId(model);
                }}
              >
                <Plus /> 添加服务
              </button>
            </aside>
            <div className="agent-service-detail">
              <section className="agent-service-fields">
                <div className="agent-detail-heading">
                  {editingServiceName ? (
                    <input
                      autoFocus
                      aria-label="服务名称"
                      value={settings.serviceName}
                      onChange={(e) => update({ serviceName: e.target.value })}
                      onBlur={() => setEditingServiceName(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setEditingServiceName(false);
                        }
                      }}
                    />
                  ) : (
                    <h2>{settings.serviceName || "新服务"}</h2>
                  )}
                  <button
                    type="button"
                    className="settings-icon"
                    title="编辑服务名称"
                    aria-label="编辑服务名称"
                    onClick={() => setEditingServiceName(true)}
                  >
                    <Pencil />
                  </button>
                  <span
                    className={
                      settings.hasKey ? "key-state configured" : "key-state"
                    }
                  >
                    {settings.hasKey ? "密钥已配置" : "密钥未配置"}
                  </span>
                  <button
                    type="button"
                    className="settings-icon"
                    title="删除服务"
                    aria-label="删除服务"
                    disabled={catalog!.services.length < 2}
                    onClick={() => {
                      const next = merged();
                      next.services = next.services.filter(
                        (item) => item.id !== serviceId,
                      );
                      next.models = next.models.filter(
                        (item) => item.serviceId !== serviceId,
                      );
                      next.selectedModelId = next.models[0].id;
                      switchTo(
                        next,
                        next.models[0].serviceId,
                        next.models[0].id,
                      );
                      setExpandedModelId(undefined);
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
                <label>
                  接口协议
                  <select
                    aria-label="接口协议"
                    value={settings.api}
                    onChange={(e) => {
                      const api = e.target.value as AgentApi;
                      if (api !== "openai-completions") {
                        const withoutUltra = (levels: ThinkingLevel[]) => {
                          const allowed = levels.filter(
                            (level) => level !== "ultra",
                          );
                          return allowed.length
                            ? allowed
                            : ["off" as ThinkingLevel];
                        };
                        setCatalog(
                          (current) =>
                            current && {
                              ...current,
                              models: current.models.map((model) => {
                                if (model.serviceId !== serviceId) return model;
                                const availableThinking = withoutUltra(
                                  model.availableThinking,
                                );
                                return {
                                  ...model,
                                  availableThinking,
                                  thinking: availableThinking.includes(
                                    model.thinking,
                                  )
                                    ? model.thinking
                                    : availableThinking[0],
                                };
                              }),
                            },
                        );
                        const availableThinking = withoutUltra(
                          settings.availableThinking,
                        );
                        update({
                          api,
                          availableThinking,
                          thinking: availableThinking.includes(
                            settings.thinking,
                          )
                            ? settings.thinking
                            : availableThinking[0],
                        });
                      } else update({ api });
                    }}
                  >
                    <option value="openai-completions">
                      OpenAI 兼容 Chat Completions
                    </option>
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="anthropic-messages">
                      Anthropic Messages
                    </option>
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
                <div className="settings-key-heading">
                  <span>
                    <KeyRound /> API 密钥
                  </span>
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
                  <p>
                    {settings.keyError
                      ? "此密钥无法读取，请替换或移除。"
                      : "此服务的模型共用密钥；留空保留现有密钥。"}
                  </p>
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
              <section className="agent-model-list">
                <h3>模型列表</h3>
                <div className="agent-model-rows">
                  {serviceModels.map((model) => {
                    const title =
                      model.id === modelId
                        ? settings.name || settings.model || "新模型"
                        : model.name || model.model || "新模型";
                    const modelCode =
                      model.id === modelId ? settings.model : model.model;
                    return (
                      <div className="agent-model-item" key={model.id}>
                        <div className="agent-model-row">
                          <span className="agent-model-label" title={title}>
                            {title}
                          </span>
                          {modelCode !== title && (
                            <span className="agent-model-id" title={modelCode}>
                              {modelCode}
                            </span>
                          )}
                          <button
                            type="button"
                            className="settings-icon"
                            title={
                              expandedModelId === model.id
                                ? "收起模型"
                                : "编辑模型"
                            }
                            aria-label={`编辑模型 ${title}`}
                            aria-expanded={expandedModelId === model.id}
                            onClick={() => {
                              if (model.id !== modelId)
                                switchTo(merged(), serviceId, model.id);
                              setExpandedModelId(
                                expandedModelId === model.id
                                  ? undefined
                                  : model.id,
                              );
                            }}
                          >
                            {expandedModelId === model.id ? (
                              <ChevronDown />
                            ) : (
                              <Pencil />
                            )}
                          </button>
                          <button
                            type="button"
                            className="settings-icon"
                            title="删除模型"
                            aria-label={`删除模型 ${title}`}
                            disabled={serviceModels.length < 2}
                            onClick={() => {
                              const next = merged();
                              next.models = next.models.filter(
                                (item) => item.id !== model.id,
                              );
                              if (next.selectedModelId === model.id)
                                next.selectedModelId = next.models[0].id;
                              const target = next.models.find(
                                (item) => item.serviceId === serviceId,
                              )!;
                              switchTo(next, serviceId, target.id);
                              setExpandedModelId(undefined);
                            }}
                          >
                            <Trash2 />
                          </button>
                        </div>
                        {expandedModelId === model.id &&
                          modelId === model.id && (
                            <div className="agent-model-editor">
                              <label>
                                显示名称
                                <input
                                  aria-label="模型显示名称"
                                  value={settings.name}
                                  onChange={(e) =>
                                    update({ name: e.target.value })
                                  }
                                  placeholder="可选，默认使用模型 ID"
                                />
                              </label>
                              <label>
                                模型 ID
                                <input
                                  aria-label="模型名称"
                                  placeholder="填写服务商提供的模型 ID"
                                  value={settings.model}
                                  onChange={(e) =>
                                    update({ model: e.target.value })
                                  }
                                />
                              </label>
                              <div className="settings-key-heading">
                                <span>
                                  <SlidersHorizontal /> 生成参数
                                </span>
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
                                    onChange={(e) =>
                                      update({ contextWindow: e.target.value })
                                    }
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
                                    onChange={(e) =>
                                      update({ maxTokens: e.target.value })
                                    }
                                  />
                                </label>
                              </div>
                              <p className="field-help">
                                单位为 token；输出上限不能超过上下文预算。
                              </p>
                              <div className="settings-thinking">
                                <span>可用思考等级</span>
                                <div className="thinking-levels">
                                  {thinkingLevels
                                    .filter(
                                      (level) =>
                                        level !== "ultra" ||
                                        settings.api === "openai-completions",
                                    )
                                    .map((level) => (
                                      <label key={level}>
                                        <input
                                          type="checkbox"
                                          checked={settings.availableThinking.includes(
                                            level,
                                          )}
                                          onChange={(e) => {
                                            const availableThinking = e.target
                                              .checked
                                              ? [
                                                  ...settings.availableThinking,
                                                  level,
                                                ]
                                              : settings.availableThinking.filter(
                                                  (item) => item !== level,
                                                );
                                            if (!availableThinking.length)
                                              return;
                                            update({
                                              availableThinking,
                                              thinking:
                                                availableThinking.includes(
                                                  settings.thinking,
                                                )
                                                  ? settings.thinking
                                                  : availableThinking[0],
                                            });
                                          }}
                                        />
                                        {level === "off" ? "无" : level}
                                      </label>
                                    ))}
                                </div>
                                <p className="field-help">
                                  仅勾选该模型与端点实际支持的等级；ultra
                                  仅适用于明确支持它的 Chat Completions 端点。
                                </p>
                              </div>
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="agent-add-item"
                  onClick={() => {
                    const next = merged();
                    const id = crypto.randomUUID();
                    next.models.push({
                      id,
                      serviceId,
                      name: "",
                      model: "",
                      contextWindow: 128000,
                      maxTokens: 4096,
                      availableThinking: ["off"],
                      thinking: "off",
                    });
                    next.selectedModelId = id;
                    switchTo(next, serviceId, id);
                    setExpandedModelId(id);
                  }}
                >
                  <Plus /> 添加模型
                </button>
              </section>
            </div>
          </div>
        ) : section === "proxy" ? (
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
        ) : null}
      </fieldset>
      {section === "search" && (
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>Exa 网页搜索</h2>
          </div>
          <p className="field-help">
            默认使用免费搜索服务。也可以填写自己的 Exa
            密钥，使用对应账户的额度。
          </p>
          <label>
            Exa API key
            <input
              aria-label="Exa API key"
              type="password"
              autoComplete="off"
              disabled={busy}
              value={exaKey}
              placeholder={
                catalog?.search?.hasKey && !clearExaKey
                  ? "已保存，留空保留"
                  : "未配置，使用免费服务"
              }
              onChange={(e) => {
                setExaKey(e.target.value);
                setClearExaKey(false);
              }}
            />
          </label>
          {catalog?.search?.keyError && !clearExaKey && (
            <p role="alert">Exa 密钥无法读取，请替换或移除。</p>
          )}
          {catalog?.search?.hasKey && (
            <label className="settings-checkbox">
              <input
                type="checkbox"
                disabled={busy}
                checked={clearExaKey}
                onChange={(e) => {
                  setClearExaKey(e.target.checked);
                  if (e.target.checked) setExaKey("");
                }}
              />
              移除 Exa 密钥
            </label>
          )}
        </section>
      )}
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

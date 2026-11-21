import { useEffect, useState } from "react";
import { FileSearch, KeyRound, Save, Trash2 } from "lucide-react";
import { defaultParsingSettings, type ParsingSettings } from "../shared/parsing";
import { Button } from "./ui/Button";
import { InlineMessage } from "./ui/Feedback";
import "./parsing.css";

export function ParsingSettingsForm() {
  const [settings, setSettings] = useState<ParsingSettings>(defaultParsingSettings);
  const [token, setToken] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    void window.desktop
      .parsing<ParsingSettings>({ type: "settings" })
      .then((value) => {
        if (!disposed) setSettings(value);
      })
      .catch((error) => {
        if (!disposed) setMessage(error.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <form
      className="agent-settings parsing-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setMessage("");
        void window.desktop
          .parsing<ParsingSettings>({
            type: "saveSettings",
            settings,
            apiKey: token,
            clearKey,
          })
          .then((value) => {
            setSettings(value);
            setToken("");
            setClearKey(false);
            setMessage("解析配置已保存。");
          })
          .catch((error) => setMessage(error.message))
          .finally(() => setBusy(false));
      }}
    >
      <p className="settings-intro">配置 PDF 云端解析服务，供导入与原页核对使用。</p>
      <fieldset className="settings-fields" disabled={busy}>
        <section className="settings-group">
          <div className="settings-group-heading">
            <h2>
              <FileSearch /> 百度文档解析
            </h2>
            <span>所有工程共用</span>
          </div>
          <label htmlFor="parsing-model">
            解析模型
            <select
              id="parsing-model"
              value={settings.model}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            >
              <option>PaddleOCR-VL-1.6</option>
            </select>
          </label>
          <label htmlFor="parsing-endpoint">
            百度任务地址
            <input
              id="parsing-endpoint"
              type="url"
              value={settings.endpoint}
              onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })}
              required
            />
          </label>
          <div className="settings-key-heading">
            <span>
              <KeyRound /> 服务凭据
            </span>
            <span className={`key-state ${settings.hasKey && !clearKey && !settings.keyError ? "configured" : ""}`}>
              {clearKey ? "待清除" : settings.keyError ? "需要更新" : settings.hasKey ? "已配置" : "未配置"}
            </span>
          </div>
          <label htmlFor="parsing-token">
            百度 Token
            <input
              id="parsing-token"
              type="password"
              autoComplete="off"
              value={token}
              placeholder={
                clearKey
                  ? "保存后清除"
                  : settings.keyError
                    ? "凭据无法解密，请重新填写"
                    : settings.hasKey
                      ? "已保存，留空保留"
                      : "填写百度解析服务的 Token"
              }
              onChange={(event) => {
                setToken(event.target.value);
                setClearKey(false);
              }}
            />
          </label>
          <div className="key-help">
            <p>凭据加密保存在本机，不随论文工程保存。</p>
            <Button
              variant="danger"
              className="remove-key"
              aria-label="清除百度 Token"
              disabled={clearKey}
              onClick={() => {
                setToken("");
                setClearKey(true);
              }}
            >
              <Trash2 /> 清除 Token
            </Button>
          </div>
          {settings.keyError && !clearKey && (
            <InlineMessage variant="error" className="settings-feedback">
              已保存的凭据无法读取，请重新填写或清除。
            </InlineMessage>
          )}
        </section>
      </fieldset>
      <div className="settings-save-row">
        <Button variant="primary" type="submit" disabled={busy}>
          <Save /> {busy ? "正在保存…" : "保存解析配置"}
        </Button>
        {message && (
          <InlineMessage
            variant={message === "解析配置已保存。" ? "success" : "error"}
            className={`settings-feedback ${message === "解析配置已保存。" ? "success" : ""}`}
            role="status"
          >
            {message}
          </InlineMessage>
        )}
      </div>
    </form>
  );
}

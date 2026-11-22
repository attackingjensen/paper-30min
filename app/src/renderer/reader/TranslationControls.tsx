// 语言视图控制面（SPEC-translation §1/§5/§8）：语言切换、译文维护动作、
// 任务状态与停止入口。纯展示组件：异步编排与投影身份由 FullReader 承担。
import type { TranslationLanguage } from "../../shared/translation/contracts";
import { Button } from "../ui/Button";
import { InlineMessage } from "../ui/Feedback";

export function TranslationControls({
  language,
  busy,
  status,
  gaps,
  stale,
  hasProjection,
  onSwitch,
  onAction,
  onStop,
}: {
  language: TranslationLanguage | null;
  busy: boolean;
  status: string;
  gaps: number;
  stale: number;
  hasProjection: boolean;
  onSwitch: (target: TranslationLanguage | null) => void;
  onAction: (action: "fill-gaps" | "update-stale") => void;
  onStop: () => void;
}) {
  return (
    <>
      <div className="reader-language" role="group" aria-label="阅读语言">
        <Button
          className={`reader-language-option${language === null ? " active" : ""}`}
          aria-pressed={language === null}
          onClick={() => onSwitch(null)}
        >
          原文
        </Button>
        <Button
          className={`reader-language-option${language === "zh" ? " active" : ""}`}
          aria-pressed={language === "zh"}
          disabled={busy}
          onClick={() => onSwitch("zh")}
        >
          中文
        </Button>
        <Button
          className={`reader-language-option${language === "en" ? " active" : ""}`}
          aria-pressed={language === "en"}
          disabled={busy}
          onClick={() => onSwitch("en")}
        >
          English
        </Button>
      </div>
      {language !== null && hasProjection && (gaps > 0 || stale > 0) && (
        <div className="reader-translation-actions" role="group" aria-label="译文维护">
          {gaps > 0 && (
            <Button className="reader-translation-action" disabled={busy} onClick={() => onAction("fill-gaps")}>
              补译缺口（{gaps} 项）
            </Button>
          )}
          {stale > 0 && (
            <Button className="reader-translation-action" disabled={busy} onClick={() => onAction("update-stale")}>
              更新过期译文（{stale} 项）
            </Button>
          )}
        </div>
      )}
      {language !== null && (status || busy) && (
        <InlineMessage className="reader-translation-status" role="status">
          {status}
          {busy && (
            <Button className="reader-translation-stop" onClick={onStop}>
              停止翻译
            </Button>
          )}
        </InlineMessage>
      )}
    </>
  );
}

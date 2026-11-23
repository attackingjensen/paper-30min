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
  confirmingFullRetranslate,
  onSwitch,
  onAction,
  onRetranslateFull,
  onConfirmFullRetranslate,
  onCancelFullRetranslate,
  onStop,
}: {
  language: TranslationLanguage | null;
  busy: boolean;
  status: string;
  gaps: number;
  stale: number;
  hasProjection: boolean;
  /** 全文重译单独确认态（SPEC §8.4）：确认前不发起命令。 */
  confirmingFullRetranslate: boolean;
  onSwitch: (target: TranslationLanguage | null) => void;
  onAction: (action: "fill-gaps" | "update-stale") => void;
  onRetranslateFull: () => void;
  onConfirmFullRetranslate: () => void;
  onCancelFullRetranslate: () => void;
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
      {language !== null && hasProjection && (
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
          <Button className="reader-translation-action" disabled={busy} onClick={onRetranslateFull}>
            重译全文
          </Button>
        </div>
      )}
      {language !== null && confirmingFullRetranslate && (
        <InlineMessage
          variant="warning"
          className="reader-retranslate-confirm"
          role="alertdialog"
          aria-label="全文重译确认"
        >
          <p>
            全文重译将重新生成全部单元与标题译文（含已完成内容），可能产生较高模型费用；失败单元保留旧译文。确定继续吗？
          </p>
          <div className="reader-retranslate-confirm-actions">
            <Button className="reader-retranslate-confirm-ok" onClick={onConfirmFullRetranslate}>
              确认全文重译
            </Button>
            <Button onClick={onCancelFullRetranslate}>取消</Button>
          </div>
        </InlineMessage>
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

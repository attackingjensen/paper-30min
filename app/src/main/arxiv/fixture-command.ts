import type { Command } from "../../shared/contracts.js";

export interface ArxivFixtureEnvironment {
  baseUrl?: string;
  testWindow?: string;
  isPackaged: boolean;
}

export function isArxivFixtureEnvironment(environment: ArxivFixtureEnvironment): boolean {
  return Boolean(environment.baseUrl) && environment.testWindow !== undefined && !environment.isPackaged;
}

/** 真实 UI 回归无法改写 contextBridge；仅在未打包测试窗口向未显式注入端点的
 * 创建命令补充受控基址。打包生产模式剥离显式注入，worker 继续复核同一权限。 */
export function withArxivFixtureEndpoint(command: Command, environment: ArxivFixtureEnvironment): Command {
  switch (command.type) {
    case "coreArxivImport":
    case "coreArxivResume":
    case "coreArxivPdfFallback":
    case "coreArxivPdfFallbackImport": {
      if (environment.isPackaged) {
        const { baseUrl: _baseUrl, ...sanitized } = command;
        return sanitized;
      }
      if (!isArxivFixtureEnvironment(environment)) return command;
      return { ...command, baseUrl: command.baseUrl ?? environment.baseUrl };
    }
    default:
      return command;
  }
}

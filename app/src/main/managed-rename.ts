import * as fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 受管原子写的替换步骤。Windows 上 Defender/索引器会短暂打开刚写入或既有的
 * 目标文件，fs.rename 因此偶发 EPERM/EBUSY；只对这两类瞬时错误做有界重试
 * （3 次，20/40/80ms 退避），其余错误原样抛出，不掩盖真实故障。
 */
export interface RenameHooks {
  rename?: (from: string, to: string) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
}

export async function renameManaged(from: string, to: string, hooks: RenameHooks = {}): Promise<void> {
  const rename = hooks.rename ?? fs.rename;
  const wait = hooks.delay ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await wait(20 * 2 ** attempt);
    }
  }
}

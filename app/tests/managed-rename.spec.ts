import { test, expect } from "@playwright/test";
import * as realFs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { renameManaged } from "../src/main/managed-rename";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("managed-rename 瞬时 EPERM/EBUSY 有界重试后成功", async () => {
  const directory = await realFs.mkdtemp(path.join(os.tmpdir(), "managed-rename-"));
  try {
    const source = path.join(directory, "a.tmp");
    const target = path.join(directory, "task.json");
    await realFs.writeFile(source, "payload");
    let calls = 0;
    const rename = async (from: string, to: string) => {
      calls += 1;
      // Defender/索引器短暂占用目标：前两次 EPERM/EBUSY，第三次放行。
      if (calls === 1) throw errno("EPERM");
      if (calls === 2) throw errno("EBUSY");
      await realFs.rename(from, to);
    };
    await renameManaged(source, target, { rename, delay: async () => {} });
    expect(calls).toBe(3);
    expect(await realFs.readFile(target, "utf8")).toBe("payload");
    await expect(realFs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

test("managed-rename 重试预算耗尽后原样抛错，不静默吞掉", async () => {
  let calls = 0;
  const delays: number[] = [];
  const rename = async () => {
    calls += 1;
    throw errno("EPERM");
  };
  await expect(
    renameManaged("a.tmp", "task.json", {
      rename,
      delay: async (ms) => { delays.push(ms); },
    }),
  ).rejects.toMatchObject({ code: "EPERM" });
  expect(calls).toBe(4); // 首次 + 3 次重试
  expect(delays).toEqual([20, 40, 80]);
});

test("managed-rename 非瞬时错误不重试，立即抛出", async () => {
  let calls = 0;
  const rename = async () => {
    calls += 1;
    throw errno("EACCES");
  };
  await expect(
    renameManaged("a.tmp", "task.json", { rename, delay: async () => {} }),
  ).rejects.toMatchObject({ code: "EACCES" });
  expect(calls).toBe(1);
});

test("managed-rename 默认实现真实落盘替换", async () => {
  const directory = await realFs.mkdtemp(path.join(os.tmpdir(), "managed-rename-"));
  try {
    const source = path.join(directory, "a.tmp");
    const target = path.join(directory, "task.json");
    await realFs.writeFile(source, "first");
    await realFs.writeFile(target, "old");
    await renameManaged(source, target);
    expect(await realFs.readFile(target, "utf8")).toBe("first");
  } finally {
    await realFs.rm(directory, { recursive: true, force: true });
  }
});

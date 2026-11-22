import { test, expect } from "@playwright/test";
import type { Command } from "../src/shared/contracts";
import { isArxivFixtureEnvironment, withArxivFixtureEndpoint } from "../src/main/arxiv/fixture-command";

const command = {
  type: "coreArxivImport",
  parent: "C:\\fixture",
  name: "paper",
  input: "2401.01234",
  operationId: "fixture-op",
} as const satisfies Command;

test("arxiv-import 打包生产模式忽略环境变量并剥离显式 baseUrl", () => {
  const environment = {
    baseUrl: "http://127.0.0.1:8123",
    testWindow: "hidden",
    isPackaged: true,
  };
  const result = withArxivFixtureEndpoint(command, environment);
  expect(result).toEqual(command);
  expect("baseUrl" in result).toBe(false);
  expect(withArxivFixtureEndpoint({ ...command, baseUrl: environment.baseUrl }, environment)).toEqual(command);
  expect(isArxivFixtureEnvironment(environment)).toBe(false);
});

test("arxiv-import 非打包测试窗口注入 fixture，显式 baseUrl 优先", () => {
  const fixture = {
    baseUrl: "http://127.0.0.1:8123",
    testWindow: "hidden",
    isPackaged: false,
  };
  expect(withArxivFixtureEndpoint(command, fixture)).toEqual({ ...command, baseUrl: fixture.baseUrl });
  const explicit = { ...command, baseUrl: "http://127.0.0.1:9456" };
  expect(withArxivFixtureEndpoint(explicit, fixture)).toEqual(explicit);
  expect(withArxivFixtureEndpoint(command, { ...fixture, testWindow: undefined })).toEqual(command);
});

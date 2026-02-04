import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

let mockGatewayResponse: {
  status?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  reply?: string;
} = {
  status: "ok",
  startedAt: 111,
  endedAt: 222,
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => mockGatewayResponse),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn(() => noop),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: unknown[]) => announceSpy(...args),
}));

describe("subagent orchestration", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    mockGatewayResponse = {
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    };
    announceSpy.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.resetModules();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  describe("orchestration config storage", () => {
    it("stores orchestration config in run record", async () => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;

      const mod = await import("./subagent-registry.js");

      mod.registerSubagentRun({
        runId: "run-orch-1",
        childSessionKey: "agent:main:subagent:orch",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "test orchestration",
        cleanup: "keep",
        orchestrationConfig: {
          retryOnFailure: true,
          maxRetries: 5,
          verifyCompletion: true,
        },
      });

      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw) as {
        runs?: Record<
          string,
          {
            orchestrationConfig?: {
              retryOnFailure?: boolean;
              maxRetries?: number;
              verifyCompletion?: boolean;
            };
            retryCount?: number;
            maxRetries?: number;
          }
        >;
      };

      const run = parsed.runs?.["run-orch-1"];
      expect(run).toBeDefined();
      expect(run?.orchestrationConfig?.retryOnFailure).toBe(true);
      expect(run?.orchestrationConfig?.maxRetries).toBe(5);
      expect(run?.orchestrationConfig?.verifyCompletion).toBe(true);
      expect(run?.retryCount).toBe(0);
      expect(run?.maxRetries).toBe(5);
    });

    it("uses default orchestration config when not specified", async () => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;

      const mod = await import("./subagent-registry.js");

      mod.registerSubagentRun({
        runId: "run-default-orch",
        childSessionKey: "agent:main:subagent:default",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "test default orchestration",
        cleanup: "keep",
      });

      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw) as {
        runs?: Record<
          string,
          {
            orchestrationConfig?: {
              retryOnFailure?: boolean;
              maxRetries?: number;
            };
            retryCount?: number;
          }
        >;
      };

      const run = parsed.runs?.["run-default-orch"];
      expect(run).toBeDefined();
      // Default is retry disabled
      expect(run?.orchestrationConfig?.retryOnFailure).toBe(false);
      // Default max retries is 3
      expect(run?.orchestrationConfig?.maxRetries).toBe(3);
      expect(run?.retryCount).toBe(0);
    });
  });

  describe("verification hooks", () => {
    it("registers and unregisters verification hooks", async () => {
      const mod = await import("./subagent-registry.js");

      const hookFn = vi.fn(async () => ({ passed: true, reason: "test" }));

      mod.registerVerificationHook("test-hook", hookFn);

      // Can be unregistered
      const unregistered = mod.unregisterVerificationHook("test-hook");
      expect(unregistered).toBe(true);

      // Can't unregister twice
      const unregisteredAgain = mod.unregisterVerificationHook("test-hook");
      expect(unregisteredAgain).toBe(false);
    });

    it("clears verification hooks on reset", async () => {
      const mod = await import("./subagent-registry.js");

      const hookFn = vi.fn(async () => ({ passed: true, reason: "test" }));
      mod.registerVerificationHook("test-hook-2", hookFn);

      mod.resetSubagentRegistryForTests();

      // Hook should be cleared after reset
      const unregistered = mod.unregisterVerificationHook("test-hook-2");
      expect(unregistered).toBe(false);
    });
  });

  describe("run record retry fields", () => {
    it("initializes retry tracking fields correctly", async () => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;

      const mod = await import("./subagent-registry.js");

      mod.registerSubagentRun({
        runId: "run-retry-init",
        childSessionKey: "agent:main:subagent:retry",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "test retry init",
        cleanup: "keep",
        orchestrationConfig: {
          retryOnFailure: true,
          maxRetries: 7,
          initialDelayMs: 2000,
          backoffMultiplier: 3,
        },
      });

      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw) as {
        runs?: Record<
          string,
          {
            retryCount?: number;
            maxRetries?: number;
            orchestrationConfig?: {
              initialDelayMs?: number;
              backoffMultiplier?: number;
            };
          }
        >;
      };

      const run = parsed.runs?.["run-retry-init"];
      expect(run?.retryCount).toBe(0);
      expect(run?.maxRetries).toBe(7);
      expect(run?.orchestrationConfig?.initialDelayMs).toBe(2000);
      expect(run?.orchestrationConfig?.backoffMultiplier).toBe(3);
    });

    it("persists retry fields with orchestration config", async () => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;

      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      const persisted = {
        version: 2,
        runs: {
          "run-persisted-orch": {
            runId: "run-persisted-orch",
            childSessionKey: "agent:main:subagent:persisted",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "persisted task",
            cleanup: "keep",
            createdAt: 1,
            startedAt: 1,
            retryCount: 2,
            maxRetries: 5,
            orchestrationConfig: {
              retryOnFailure: true,
              maxRetries: 5,
              verifyCompletion: true,
            },
          },
        },
      };
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

      const { loadSubagentRegistryFromDisk } = await import("./subagent-registry.store.js");
      const runs = loadSubagentRegistryFromDisk();

      const entry = runs.get("run-persisted-orch");
      expect(entry).toBeDefined();
      expect(entry?.retryCount).toBe(2);
      expect(entry?.maxRetries).toBe(5);
      expect(entry?.orchestrationConfig?.retryOnFailure).toBe(true);
      expect(entry?.orchestrationConfig?.verifyCompletion).toBe(true);
    });
  });

  describe("announce flow with orchestration fields", () => {
    it("includes retryCount and verificationResult in announce params", async () => {
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orch-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;

      const registryPath = path.join(tempStateDir, "subagents", "runs.json");
      const persisted = {
        version: 2,
        runs: {
          "run-announce-orch": {
            runId: "run-announce-orch",
            childSessionKey: "agent:main:subagent:announce",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "announce with orch",
            cleanup: "keep",
            createdAt: 1,
            startedAt: 1,
            endedAt: 2,
            outcome: { status: "ok" },
            retryCount: 1,
            verificationResult: "passed",
          },
        },
      };
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

      vi.resetModules();
      const mod = await import("./subagent-registry.js");
      mod.initSubagentRegistry();

      await new Promise((r) => setTimeout(r, 0));

      expect(announceSpy).toHaveBeenCalled();
      type AnnounceParams = {
        childSessionKey: string;
        retryCount?: number;
        verificationResult?: string;
      };
      const first = announceSpy.mock.calls[0]?.[0] as unknown as AnnounceParams;
      expect(first.childSessionKey).toBe("agent:main:subagent:announce");
      expect(first.retryCount).toBe(1);
      expect(first.verificationResult).toBe("passed");
    });
  });
});

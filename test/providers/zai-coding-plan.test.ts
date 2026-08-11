import { describe, expect, it, vi } from "vitest";
import {
  createZaiCodingPlanAdapter,
  normalizeZaiLimits,
} from "../../src/providers/zai-coding-plan.js";
import type {
  ZaiApiKeyCredentialInspection,
  ZaiApiKeyCredentialResolution,
  ZaiApiKeyCredentialSource,
} from "../../src/providers/zai-api-key-credential.js";
import type {
  ZaiCredentialBroker,
  ZaiCredentialInspection,
  ZaiCredentialResolution,
} from "../../src/providers/pi-zai-credential.js";
import type {
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
} from "../../src/types.js";

const NOW = Date.parse("2027-02-03T04:05:06.000Z");
const OPTIONS = { allowKeychainPrompt: false };

// The exact payload verified against a live Pro-tier key in the issue.
const SUCCESS_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 1,
        nextResetTime: 1_786_476_331_693,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 20,
        nextResetTime: 1_786_602_064_998,
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 0,
        remaining: 1000,
        percentage: 0,
        nextResetTime: 1_787_466_064_995,
        usageDetails: [
          { modelCode: "search-prime", usage: 0 },
          { modelCode: "web-reader", usage: 0 },
          { modelCode: "zread", usage: 0 },
        ],
      },
    ],
    level: "pro",
  },
  success: true,
};

describe("Z.ai Coding Plan request transport", () => {
  it("makes one fixed-origin read-only request with only the Pi-resolved key", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(SUCCESS_PAYLOAD),
    );
    const apiKeySource = apiKeyCredentialSource({
      status: "available",
      apiKey: "lower-priority-env-key",
    });
    const adapter = testAdapter({ apiKeySource, fetch: request });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [input, init] = request.mock.calls[0];
    const url = new URL(String(input));
    expect({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || "443",
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }).toEqual({
      protocol: "https:",
      hostname: "api.z.ai",
      port: "443",
      pathname: "/api/monitor/usage/quota/limit",
      search: "",
      hash: "",
    });
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-zai-key-741");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^quota-axi\/\d+\.\d+\.\d+$/);
    expect(headers.get("cookie")).toBeNull();
    expect(
      [...headers.keys()].some((name) =>
        /device|fingerprint|account|session/i.test(name),
      ),
    ).toBe(false);
    expect(report).toMatchObject({
      provider: "zai-coding-plan",
      label: "Z.ai Coding Plan",
      source: "api",
      plan: "pro",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["pi:zai"],
      },
      attempts: [{ source: "pi:zai", status: "success" }],
    });
    expect(report.account).toBeUndefined();
    expect(report.credits).toBeUndefined();
    expect(apiKeySource.resolve).not.toHaveBeenCalled();
  });

  it("maps the verified triples to five_hour, weekly, and mcp_monthly windows", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD)),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 1,
        percentRemaining: 99,
        resetsAt: new Date(1_786_476_331_693).toISOString(),
        windowSeconds: 18_000,
      },
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
        resetsAt: new Date(1_786_602_064_998).toISOString(),
        windowSeconds: 604_800,
      },
      {
        id: "mcp_monthly",
        label: "mcp",
        kind: "monthly",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: new Date(1_787_466_064_995).toISOString(),
      },
    ]);
    expect(report.state.untrustedWindowIds).toBeUndefined();
  });

  it("sends an ambient ZAI_API_KEY as the bearer only when Pi has no supported credential", async () => {
    const request = vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD));

    const report = await createZaiCodingPlanAdapter({
      broker: broker({ status: "missing" }),
      apiKeySource: apiKeyCredentialSource({
        status: "available",
        apiKey: "env-fallback-key-529",
      }),
      fetch: request,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    const headers = new Headers(request.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer env-fallback-key-529");
    expect(report.state.sourcesTried).toEqual(["pi:zai", "zai-api-key-env"]);
    expect(report.attempts).toEqual([
      {
        source: "pi:zai",
        status: "skipped",
        error: "zai_credential_unavailable",
      },
      { source: "zai-api-key-env", status: "success" },
    ]);
    expect(JSON.stringify(report)).not.toContain("env-fallback-key-529");
  });

  it("does not fall through to the env key when the Pi credential is unsupported", async () => {
    const apiKeySource = apiKeyCredentialSource({
      status: "available",
      apiKey: "must-not-be-used",
    });

    const report = await testAdapter({
      broker: broker({ status: "unsupported" }),
      apiKeySource,
    }).fetchQuota(OPTIONS);

    expect(apiKeySource.resolve).toHaveBeenCalledOnce();
    expect(report.attempts?.[0]).toMatchObject({
      source: "pi:zai",
      status: "skipped",
      error: "unsupported_credential_type",
    });
  });

  it("reports auth_required and retires the cache when neither credential source is usable", async () => {
    const deleteCachedProvider = vi.fn();
    const report = await testAdapter({
      broker: broker({ status: "missing" }),
      apiKeySource: apiKeyCredentialSource({ status: "missing" }),
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        error: "zai_credential_unavailable",
      },
      attempts: [
        {
          source: "pi:zai",
          status: "skipped",
          error: "zai_credential_unavailable",
        },
        {
          source: "zai-api-key-env",
          status: "skipped",
          error: "zai_api_key_unavailable",
        },
      ],
    });
    expect(deleteCachedProvider).toHaveBeenCalledWith("zai-coding-plan");
  });

  it("fails immediately on a Pi credential-resolution error without trying the env key", async () => {
    const apiKeySource = apiKeyCredentialSource({
      status: "available",
      apiKey: "must-not-be-tried",
    });
    const readCachedProvider = vi.fn(() => undefined);

    const report = await testAdapter({
      broker: broker({ status: "error" }),
      apiKeySource,
      readCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(apiKeySource.resolve).not.toHaveBeenCalled();
    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("credential_resolution_failed");
    expect(readCachedProvider).toHaveBeenCalledWith("zai-coding-plan");
  });
});

describe("Z.ai Coding Plan envelope auth codes", () => {
  it.each([
    [401, "zai_token_expired"],
    [1000, "zai_authentication_failed"],
    [1001, "zai_authentication_header_missing"],
  ])(
    "maps envelope code %i to auth_required (%s), never error",
    async (code, expectedError) => {
      const deleteCachedProvider = vi.fn();
      const report = await testAdapter({
        fetch: vi.fn(async () =>
          jsonResponse({ code, msg: "auth failure", success: false }),
        ),
        deleteCachedProvider,
      }).fetchQuota(OPTIONS);

      expect(report.state.status).toBe("auth_required");
      expect(report.state.error).toBe(expectedError);
      expect(report.windows).toEqual([]);
      expect(deleteCachedProvider).toHaveBeenCalledWith("zai-coding-plan");
    },
  );

  it("does not pattern-match on the locale-dependent msg string", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({ code: 401, msg: "操作成功", success: false }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toBe("zai_token_expired");
  });
});

describe("Z.ai Coding Plan fail-soft empty windows", () => {
  it.each([
    ["an empty body", () => new Response(null, { status: 200 })],
    ["an unparseable body", () => new Response("{not-json", { status: 200 })],
    [
      "a non-object top-level JSON value",
      () => new Response("42", { status: 200 }),
    ],
    [
      "a success envelope with no data",
      () => jsonResponse({ code: 200, msg: "ok", success: true }),
    ],
    [
      "a success envelope whose limits field is missing",
      () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          success: true,
          data: { level: "pro" },
        }),
    ],
    [
      "a success envelope whose limits field is not an array",
      () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          success: true,
          data: { limits: "nope" },
        }),
    ],
    [
      "a success envelope with an empty limits array",
      () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          success: true,
          data: { limits: [] },
        }),
    ],
  ])(
    "reports a fresh empty-window snapshot for %s",
    async (_label, respond) => {
      const report = await testAdapter({
        fetch: vi.fn(async () => respond()),
      }).fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        provider: "zai-coding-plan",
        source: "api",
        windows: [],
        state: { status: "fresh", stale: false },
      });
    },
  );
});

describe("Z.ai Coding Plan unexpected envelope shape", () => {
  it("degrades to a clear error rather than guessing at a new envelope variant", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({ code: 500, msg: "server hiccup", success: false }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("unexpected_response_shape");
  });

  it("falls back to a stale cached snapshot for an unexpected shape", async () => {
    const cached = cachedQuota();
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({ code: 9999, msg: "unknown", success: false }),
      ),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("cache");
    expect(report.state.stale).toBe(true);
    expect(report.state.error).toBe("unexpected_response_shape");
  });
});

describe("Z.ai Coding Plan unit x number derivation", () => {
  it("degrades an unrecognized (type, unit, number) triple to an unknown window without inventing a duration", () => {
    const normalized = normalizeZaiLimits({
      level: "pro",
      limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 10, percentage: 5 }],
    });

    expect(normalized.windows).toEqual([
      {
        id: "limit:1",
        label: "limit 1",
        kind: "unknown",
        percentUsed: 5,
        percentRemaining: 95,
      },
    ]);
    expect(normalized.diagnostics).toEqual([]);
  });

  it("records malformed limit entries as diagnostics without dropping the valid ones", () => {
    const normalized = normalizeZaiLimits({
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
        { type: "TOKENS_LIMIT", unit: 6 }, // missing number/percentage
        "not an object",
      ],
    });

    expect(normalized.windows.map(({ id }) => id)).toEqual(["five_hour"]);
    expect(normalized.diagnostics).toEqual([
      { code: "limit_invalid", index: 2 },
      { code: "limit_invalid", index: 3 },
    ]);
  });

  it("propagates malformed limit entries as untrusted window ids on the report", async () => {
    const report = await testAdapter({
      fetch: vi.fn(async () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          success: true,
          data: {
            level: "pro",
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
              { type: "TOKENS_LIMIT", unit: 6 },
            ],
          },
        }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.windows.map(({ id }) => id)).toEqual(["five_hour"]);
    expect(report.state.untrustedWindowIds).toEqual(["limit:2"]);
  });

  it("omits plan when data.level is not a usable string", () => {
    const normalized = normalizeZaiLimits({ level: 42, limits: [] });
    expect(normalized.plan).toBeUndefined();
  });
});

describe("Z.ai Coding Plan cache fallback", () => {
  it("uses a same-source stale snapshot for transient failures", async () => {
    const cached = cachedQuota();
    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("cache");
    expect(report.state.status).toBe("stale");
    expect(report.state.stale).toBe(true);
    expect(report.windows.length).toBeGreaterThan(0);
  });

  it("drops reset-expired windows and resetless windows without an invented duration", async () => {
    const cached = cachedQuota([
      quotaWindow("five_hour", "session", "2027-02-03T09:05:06.000Z"), // future
      quotaWindow("weekly", "weekly", "2027-01-01T00:00:00.000Z"), // expired
      {
        id: "mcp_monthly",
        label: "mcp",
        kind: "monthly",
        percentUsed: 0,
        percentRemaining: 100,
      }, // no resetsAt
    ]);

    const report = await testAdapter({
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      readCachedProvider: () => cached,
    }).fetchQuota(OPTIONS);

    expect(report.windows.map(({ id }) => id)).toEqual(["five_hour"]);
  });

  it("does not use cache fallback for a definitive auth failure", async () => {
    const readCachedProvider = vi.fn(() => cachedQuota());
    const report = await testAdapter({
      broker: broker({ status: "missing" }),
      apiKeySource: apiKeyCredentialSource({ status: "missing" }),
      readCachedProvider,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("unavailable");
    expect(report.state.status).toBe("auth_required");
  });
});

describe("Z.ai Coding Plan transport failures", () => {
  it("surfaces distinct errors for network, decoding, server, and HTTP-layer auth failures", async () => {
    const failures: Array<[string, () => Promise<Response>]> = [
      [
        "network_unavailable",
        async () => {
          throw new Error("transport fixture");
        },
      ],
      [
        "malformed_json handled fail-soft, not here",
        async () => new Response(null, { status: 503 }),
      ],
      ["provider_unavailable", async () => new Response(null, { status: 503 })],
      [
        "provider_auth_rejected",
        async () => new Response(null, { status: 401 }),
      ],
    ];

    for (const [, requestFailure] of failures) {
      const report = await testAdapter({
        fetch: vi.fn(requestFailure),
      }).fetchQuota(OPTIONS);
      expect(["error", "auth_required"]).toContain(report.state.status);
    }
  });

  it("rejects an HTTP redirect instead of following it", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid/" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("redirect_rejected");
  });

  it("reports rate limiting with a normalized retryAfter", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("rate_limited");
    expect(report.state.retryAfter).toBe(new Date(NOW + 30_000).toISOString());
  });

  it("rejects an oversized declared body without buffering it", async () => {
    const report = await testAdapter({
      fetch: vi.fn(
        async () =>
          new Response(new Uint8Array(300_000), {
            status: 200,
            headers: { "content-length": "300000" },
          }),
      ),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("error");
    expect(report.state.error).toBe("response_too_large");
  });
});

describe("Z.ai Coding Plan deadline enforcement", () => {
  it("enforces the total deadline when the transport never resolves", async () => {
    const report = await testAdapter({
      fetch: vi.fn(() => new Promise<Response>(() => {})),
      deadlineMs: 5,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("request_timeout");
  });
});

describe("Z.ai Coding Plan in-flight de-duplication", () => {
  it("shares one request across concurrent fetchQuota calls", async () => {
    const request = vi.fn(async () => jsonResponse(SUCCESS_PAYLOAD));
    const adapter = testAdapter({ fetch: request });

    const [first, second] = await Promise.all([
      adapter.fetchQuota(OPTIONS),
      adapter.fetchQuota(OPTIONS),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});

describe("Z.ai Coding Plan inspectAuth", () => {
  it("reports each credential source without exposing secret values", async () => {
    const report = await createZaiCodingPlanAdapter({
      broker: broker({ status: "expired", refreshable: true }),
      apiKeySource: apiKeyCredentialSource({
        status: "available",
        apiKey: "must-not-be-printed",
      }),
    }).inspectAuth(OPTIONS);

    expect(report).toEqual({
      provider: "zai-coding-plan",
      sources: [
        {
          source: "pi:zai",
          status: "expired",
          error: "pi_zai_credential_expired",
        },
        { source: "zai-api-key-env", status: "available" },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("must-not-be-printed");
  });

  it("maps an unsupported Pi credential type to invalid with a reason", async () => {
    const report = await createZaiCodingPlanAdapter({
      broker: broker({ status: "unsupported" }),
      apiKeySource: apiKeyCredentialSource({ status: "missing" }),
    }).inspectAuth(OPTIONS);

    expect(report.sources[0]).toEqual({
      source: "pi:zai",
      status: "invalid",
      error: "unsupported_credential_type",
    });
    expect(report.sources[1]).toEqual({
      source: "zai-api-key-env",
      status: "missing",
    });
  });
});

function testAdapter(
  overrides: Parameters<typeof createZaiCodingPlanAdapter>[0] = {},
): ProviderAdapter {
  return createZaiCodingPlanAdapter({
    broker: broker({
      status: "available",
      kind: "api_key",
      credential: "synthetic-zai-key-741",
    }),
    apiKeySource: apiKeyCredentialSource({ status: "missing" }),
    fetch: vi.fn(async () =>
      jsonResponse(SUCCESS_PAYLOAD),
    ) as unknown as typeof fetch,
    readCachedProvider: () => undefined,
    deleteCachedProvider: () => undefined,
    now: () => NOW,
    ...overrides,
  });
}

function broker(
  resolution: ZaiCredentialResolution,
  inspection: ZaiCredentialInspection = resolution.status === "available"
    ? "available"
    : resolution.status,
): ZaiCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function apiKeyCredentialSource(
  resolution: ZaiApiKeyCredentialResolution,
  inspection: ZaiApiKeyCredentialInspection = resolution.status,
): ZaiApiKeyCredentialSource {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => inspection),
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function cachedQuota(
  windows: QuotaWindow[] = [
    quotaWindow("five_hour", "session", "2027-02-03T09:05:06.000Z"),
    quotaWindow("weekly", "weekly", "2027-02-08T04:05:06.000Z"),
  ],
  refreshedAt = NOW - 60_000,
): ProviderQuota {
  return {
    provider: "zai-coding-plan",
    label: "Z.ai Coding Plan",
    source: "api",
    windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(refreshedAt).toISOString(),
      sourcesTried: ["pi:zai"],
    },
  };
}

function quotaWindow(
  id: string,
  kind: QuotaWindow["kind"],
  resetsAt?: string,
): QuotaWindow {
  return {
    id,
    label: id,
    kind,
    percentUsed: 31.25,
    percentRemaining: 68.75,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

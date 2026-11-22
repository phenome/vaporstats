function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function boundedError(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret) message = message.split(secret).join("[redacted]");
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 256);
}

function usageDetails(value: unknown): { plan: "free" | "rejected" | "unknown"; remainingCredits: number | null; planUsage: number | null; planLimit: number | null; paygoUsage: number | null; paygoLimit: number | null; valid: boolean } {
  const root = jsonObject(value);
  const account = jsonObject(root.account);
  const planValue = String(account.current_plan ?? root.current_plan ?? account.plan ?? root.plan ?? root.tier ?? "").toLowerCase();
  const plan: "free" | "rejected" | "unknown" = planValue === "free" || planValue === "researcher" ? "free" : planValue ? "rejected" : "unknown";
  const numberValue = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? value : null;
  };
  const planUsage = numberValue(account.plan_usage, root.plan_usage);
  const planLimit = numberValue(account.plan_limit, root.plan_limit);
  const paygoUsage = numberValue(account.paygo_usage, root.paygo_usage);
  const paygoLimit = numberValue(account.paygo_limit, root.paygo_limit);
  const fallbackRemaining = numberValue(root.remaining_credits, root.remainingCredits, account.remaining_credits, account.remainingCredits);
  const remaining = planLimit !== null && planUsage !== null ? planLimit - planUsage : fallbackRemaining;
  const valid = plan === "free" && remaining !== null && remaining > 0 && (paygoLimit === null || paygoLimit === 0) && paygoUsage === 0;
  return { plan, remainingCredits: remaining, planUsage, planLimit, paygoUsage, paygoLimit, valid };
}

type TavilyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type TavilyReply = { response: Response } | { error: unknown };
type SearchAttempt = { kind: "search"; statusCode: number | null; succeeded: boolean; error: string | null };
type SearchOutcome =
  | { class: "success"; body: unknown; attempt: SearchAttempt }
  | {
    class: "provider_stop";
    reason: `tavily_search_http_${number}` | "tavily_search_error";
    progress: "queued" | "stopped";
    action: "break_run" | "stop_searches";
    attempt: SearchAttempt;
  };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function classifyTavilyUsage(reply: TavilyReply | null) {
  if (!reply) return { stop: "tavily_missing_key", details: null } as const;
  try {
    if ("error" in reply) throw reply.error;
    const { response } = reply;
    const details = usageDetails(await readJson(response));
    if (response.ok && details.valid) return { stop: null, details };
    const stop = details.remainingCredits === 0 ? "tavily_credits_exhausted"
      : details.plan === "free" ? "tavily_free_credits_unavailable"
      : "tavily_account_not_free";
    return { stop, details } as const;
  } catch {
    return { stop: "tavily_usage_error", details: null } as const;
  }
}

export async function classifyTavilySearchOutcome(reply: TavilyReply, apiKey?: string): Promise<SearchOutcome> {
  if ("error" in reply) return searchNetworkStop(reply.error, apiKey);
  const { response } = reply;
  const status = response.status;
  if (!response.ok) {
    return {
      class: "provider_stop", reason: `tavily_search_http_${status}`,
      progress: status === 429 ? "stopped" : "queued",
      action: status === 401 || status === 403 ? "break_run" : "stop_searches",
      attempt: { kind: "search", statusCode: status, succeeded: false, error: `HTTP ${status}` },
    };
  }
  try {
    return {
      class: "success", body: await readJson(response),
      attempt: { kind: "search", statusCode: status, succeeded: true, error: null },
    };
  } catch (error) {
    return searchNetworkStop(error, apiKey);
  }
}

function searchNetworkStop(error: unknown, apiKey?: string): SearchOutcome {
  return {
    class: "provider_stop", reason: "tavily_search_error", progress: "queued", action: "stop_searches",
    attempt: { kind: "search", statusCode: null, succeeded: false, error: boundedError(error, apiKey) },
  };
}

export function createTavilyTransport(apiKey: string | undefined, fetchFn: TavilyFetch = fetch) {
  async function request(path: "/usage" | "/search", body?: object): Promise<TavilyReply> {
    const headers = { Authorization: `Bearer ${apiKey}` };
    try {
      return { response: await fetchFn(`https://api.tavily.com${path}`, {
        redirect: "manual",
        ...(body ? { method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } } : { headers }),
      }) };
    } catch (error) {
      return { error };
    }
  }
  return {
    async usage() {
      return classifyTavilyUsage(apiKey ? await request("/usage") : null);
    },
    async search(query: string, domain: string) {
      return classifyTavilySearchOutcome(await request("/search", {
        query, search_depth: "basic", auto_parameters: false, include_domains: [domain],
        max_results: 10, include_answer: false, include_raw_content: false, include_usage: true,
      }), apiKey);
    },
  };
}

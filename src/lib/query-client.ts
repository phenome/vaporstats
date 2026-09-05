import { QueryClient } from "@tanstack/react-query";

export const DEFAULT_QUERY_STALE_TIME = 1000 * 60 * 5; // 5 minutes
export const DEFAULT_QUERY_GC_TIME = 1000 * 60 * 5; // 5 minutes

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_QUERY_STALE_TIME,
        gcTime: DEFAULT_QUERY_GC_TIME,
        refetchOnWindowFocus: false,
      },
    },
  });
}

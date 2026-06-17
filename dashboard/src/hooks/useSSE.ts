import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { tokenStorage, API_BASE } from "../services/api";
import type { SSEEvent } from "../types";

interface UseSSEOptions {
  crisisId: string | null;
  onEvent: (event: SSEEvent) => void;
  enabled?: boolean;
}

export function useSSE({ crisisId, onEvent, enabled = true }: UseSSEOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => { onEventRef.current = onEvent; });

  const connect = useCallback(() => {
    if (!crisisId || !enabled) return;

    const token = tokenStorage.getAccessToken();
    if (!token) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `${API_BASE}/api/dashboard/stream?crisis_id=${crisisId}&token=${token}`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        onEventRef.current(data);
      } catch {
        // Invalid JSON — ignore
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      // Reconnect after 5 seconds — self-reference is intentional (reconnect loop)
      reconnectTimeoutRef.current = setTimeout(() => {
        // eslint-disable-next-line react-hooks/immutability
        connect();
      }, 5000);
    };

    eventSourceRef.current = es;
  }, [crisisId, enabled]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);
}
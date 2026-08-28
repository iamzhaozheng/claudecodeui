import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { expireAuthSession, isAuthTokenExpired } from '../utils/api';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  /**
   * Sends a frame and reports whether it actually reached the socket.
   *
   * Callers that show the message as sent (the composer's user bubble, the
   * queued-draft dispatchers) MUST check the result: a `false` return means
   * the bytes were dropped and the user's text still needs to be preserved.
   */
  sendMessage: (message: unknown) => boolean;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames can never be coalesced or
   * dropped the way a single "latest message" state slot could.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  /**
   * Legacy state-based access to the most recent frame.
   *
   * Kept only for low-frequency consumers (TaskMaster broadcasts). High-rate
   * chat streams must use `subscribe` — React may batch state updates, which
   * makes `latestMessage` lossy under load.
   */
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

/**
 * How long a `chat.ping` may go unanswered before the socket is treated as
 * half-open. Generous enough for a phone reacquiring a mobile signal, far
 * below the server's 30s protocol heartbeat.
 */
const LIVENESS_PROBE_TIMEOUT_MS = 5000;

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /** Timestamp of the last frame received, used by the liveness probe. */
  const lastInboundAtRef = useRef(0);
  const livenessProbeRef = useRef<NodeJS.Timeout | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on token refresh) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed, old-token socket from scheduling
        // a reconnect after the refreshed-token effect has already started.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
        wsRef.current = null;
      }
    };
  }, [isAuthLoading, token, user]); // reconnect after authentication or token refresh

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a token refresh can close them before
      // their handshake completes with stale credentials.
      wsRef.current = websocket;

      websocket.onopen = () => {
        setIsConnected(true);
        lastInboundAtRef.current = Date.now();
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          // Any inbound frame proves the socket is alive, which is what the
          // liveness probe below waits for. `chat_pong` exists only for that
          // proof, so it is not forwarded to feature listeners.
          lastInboundAtRef.current = Date.now();
          if (data.kind === 'chat_pong') {
            return;
          }
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, token, user]); // reconnect with current authentication state

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('WebSocket not connected');
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      // A socket can reject a send between the readyState check and the call
      // itself (the browser tore it down mid-statement). Report the drop.
      console.error('WebSocket send failed:', error);
      return false;
    }
  }, []);

  /**
   * Detects a socket that iOS froze while the tab was backgrounded.
   *
   * Such a socket still reports `readyState === OPEN`, so `send()` succeeds and
   * silently drops the bytes — the failure mode behind messages that render as
   * sent but never reach the server. On return to the foreground we send an
   * application-level ping and give it a short deadline: no inbound frame in
   * that window means the socket is half-open, so close it to trigger the
   * normal reconnect instead of waiting out the server's 30s heartbeat.
   */
  const probeLiveness = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (livenessProbeRef.current) {
      return; // A probe is already pending; don't stack deadlines.
    }

    const probeSentAt = Date.now();
    try {
      socket.send(JSON.stringify({ type: 'chat.ping', nonce: String(probeSentAt) }));
    } catch {
      socket.close();
      return;
    }

    livenessProbeRef.current = setTimeout(() => {
      livenessProbeRef.current = null;
      if (wsRef.current !== socket) {
        return;
      }
      if (lastInboundAtRef.current >= probeSentAt) {
        return; // The pong (or any other frame) came back: the socket is fine.
      }
      // Half-open. `close()` fires onclose, which schedules the reconnect.
      socket.close();
    }, LIVENESS_PROBE_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    const handleWake = () => {
      if (document.visibilityState === 'visible') {
        probeLiveness();
      }
    };

    document.addEventListener('visibilitychange', handleWake);
    window.addEventListener('focus', handleWake);
    window.addEventListener('online', handleWake);

    return () => {
      document.removeEventListener('visibilitychange', handleWake);
      window.removeEventListener('focus', handleWake);
      window.removeEventListener('online', handleWake);
      if (livenessProbeRef.current) {
        clearTimeout(livenessProbeRef.current);
        livenessProbeRef.current = null;
      }
    };
  }, [probeLiveness]);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected
  }), [sendMessage, subscribe, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthSession, User } from '@collabboard/contracts';
import {
  api,
  getAccessToken,
  refreshAccess,
  setClientSession,
} from '../../shared/api/client';

const Context = createContext<{
  user: User | null;
  ready: boolean;
  signIn: (userId: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
} | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  function clear() {
    setClientSession(null);
    setSession(null);
    client.clear();
  }
  function establish(next: AuthSession) {
    client.clear();
    setClientSession(next);
    setSession(next);
    setReady(true);
  }
  useEffect(() => {
    let active = true;
    const refreshed = (event: Event) => {
      const next = (event as CustomEvent<AuthSession>).detail;
      if (next.accessToken === getAccessToken()) {
        setSession(next);
        setReady(true);
      }
    };
    window.addEventListener('collabboard:session-expired', clear);
    window.addEventListener('collabboard:session-refreshed', refreshed);
    void refreshAccess().finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      window.removeEventListener('collabboard:session-expired', clear);
      window.removeEventListener('collabboard:session-refreshed', refreshed);
    };
  }, [client]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(
      () => {
        void refreshAccess().then((next) => {
          if (
            !next &&
            session.accessToken === getAccessToken() &&
            navigator.onLine &&
            Date.now() >= new Date(session.expiresAt).getTime()
          )
            clear();
        });
      },
      Math.max(
        1000,
        new Date(session.expiresAt).getTime() - Date.now() - 60000,
      ),
    );
    const reconnect = () => {
      void refreshAccess();
    };
    window.addEventListener('online', reconnect);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('online', reconnect);
    };
  }, [session]);
  return (
    <Context.Provider
      value={{
        user: session?.user ?? null,
        ready,
        signIn: async (userId) =>
          establish(
            await api<AuthSession>('/auth/local-session', {
              method: 'POST',
              body: { userId },
            }),
          ),
        signInWithEmail: async (email, password) =>
          establish(
            await api<AuthSession>('/auth/sign-in', {
              method: 'POST',
              body: { email, password },
            }),
          ),
        signOut: async () => {
          await api('/auth/session', { method: 'DELETE' });
          clear();
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error('SessionProvider is required.');
  return value;
}

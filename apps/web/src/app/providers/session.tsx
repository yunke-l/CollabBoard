import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@collabboard/contracts';
import { api, setAccessToken } from '../../shared/api/client';

type Session = { user: User; expiresAt: string; accessToken: string };
const Context = createContext<{
  user: User | null;
  signIn: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
} | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const queryClient = useQueryClient();
  const clear = () => {
    setAccessToken(null);
    setSession(null);
    queryClient.clear();
  };
  useEffect(() => {
    if (!session) return;
    const timeout = window.setTimeout(
      clear,
      Math.max(0, new Date(session.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [session]); // Session data stays in memory and expires with its server token.
  return (
    <Context.Provider
      value={{
        user: session?.user ?? null,
        signIn: async (userId) => {
          const next = await api<Session>('/auth/local-session', {
            method: 'POST',
            body: { userId },
          });
          queryClient.clear();
          setAccessToken(next.accessToken);
          setSession(next);
        },
        signOut: async () => {
          try {
            await api('/auth/session', { method: 'DELETE' });
          } finally {
            clear();
          }
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

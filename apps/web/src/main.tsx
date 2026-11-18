import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './app/router/router';
import { SessionProvider } from './app/providers/session';
import './shared/styles/tokens.css';
import './shared/styles/app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10000, retry: false },
    mutations: { retry: false },
  },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);

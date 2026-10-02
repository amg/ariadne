import { Toaster } from '@/components/ui/toaster';
import { router } from '@/router';
import { RouterProvider } from 'react-router';
import { SuperTokensWrapper } from 'supertokens-auth-react';

function App() {
  return (
    <SuperTokensWrapper>
      <RouterProvider router={router} />
      <Toaster />
    </SuperTokensWrapper>
  );
}

export default App;

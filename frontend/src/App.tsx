import { Toaster } from '@/components/ui/toaster';
import { router } from '@/router';
import { RouterProvider } from 'react-router';

function App() {
  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  );
}

export default App;

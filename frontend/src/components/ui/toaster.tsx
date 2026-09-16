import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/**
 * App-wide toast host, mounted in App.tsx (framework entry). Bottom-center
 * placement; `richColors` tints error toasts so failures scan at a glance.
 * The app renders with dark tokens, hence `theme="dark"`.
 */
export function Toaster(props: ToasterProps) {
  return <SonnerToaster position="bottom-center" theme="dark" richColors closeButton {...props} />;
}

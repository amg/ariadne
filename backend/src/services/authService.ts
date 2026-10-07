import { env } from '@config/env';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Session from 'supertokens-node/recipe/session';

export function initAuth() {
  // CORS_ORIGINS is required for SuperTokens to know which origins to accept
  const websiteDomain = env.CORS_ORIGINS.split(',')[0]?.trim() ?? 'http://localhost:5173';
  // The browser reaches the API through the website's own origin (/api is
  // proxied), so session cookies are first-party: SameSite=Lax, and Secure
  // whenever the site is served over https.
  const apiDomain = websiteDomain;

  const supertokensConfig: { connectionURI: string; apiKey?: string } = {
    connectionURI: env.SUPERTOKENS_CONNECTION_URI,
  };
  if (env.SUPERTOKENS_API_KEY) {
    supertokensConfig.apiKey = env.SUPERTOKENS_API_KEY;
  }

  supertokens.init({
    framework: 'fastify',
    supertokens: supertokensConfig,
    appInfo: {
      appName: 'Ari',
      apiDomain: apiDomain,
      websiteDomain: websiteDomain,
      origin: (request) => {
        const origin = request.request?.getHeaderValue('origin');
        return origin !== undefined ? origin : websiteDomain;
      },
      apiBasePath: '/api/auth',
      websiteBasePath: '/auth',
    },
    recipeList: [
      EmailPassword.init({
        override: {
          // With sign-up closed the endpoint is unregistered, so new accounts
          // are refused at the server whatever the login page shows.
          apis: (originalImplementation) =>
            env.AUTH_SIGNUP_ENABLED
              ? originalImplementation
              : { ...originalImplementation, signUpPOST: undefined },
          functions: (originalImplementation) => {
            return {
              ...originalImplementation,
              signUp: async (input) => {
                const response = await originalImplementation.signUp(input);
                if (response.status === 'OK') {
                  const { id } = response.user;
                  // Sync the SuperTokens user to our application database
                  await insertUserIfNotExists({ id });
                }
                return response;
              },
            };
          },
        },
      }),
      Session.init(),
    ],
  });
}

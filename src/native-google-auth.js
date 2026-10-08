import { SocialLogin } from '@capgo/capacitor-social-login';

let initialization;

export async function signInWithGoogle(webClientId) {
  if (!initialization) {
    initialization = SocialLogin.initialize({
      google: { webClientId, mode: 'online' },
    }).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  await initialization;
  const response = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['email', 'profile'] },
  });
  const credential = response.result?.idToken;
  if (!credential) throw new Error('Google no devolvió un ID token');
  return credential;
}

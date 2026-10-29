import { base64 } from '../binary-base64';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
interface CachedToken { token: string; expiresAt: number }
const tokens = new WeakMap<typeof fetch, Map<string, CachedToken>>();

export function serviceAccountProject(credentials: string): string {
  try { const value = JSON.parse(credentials); return typeof value.project_id === 'string' ? value.project_id : ''; }
  catch { return ''; }
}

const url64 = (bytes: Uint8Array) => base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** OAuth JWT bearer exchange; tokens stay in memory and refresh before expiry.
 * https://developers.google.com/identity/protocols/oauth2/service-account */
export async function googleCloudToken(credentials: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  signal?.throwIfAborted();
  const source = credentials.trim();
  if (!source) throw new Error('Укажите данные авторизации Google Cloud.');
  if (!source.startsWith('{')) return source.replace(/^Bearer\s+/i, '');
  let cache = tokens.get(fetcher);
  if (!cache) { cache = new Map(); tokens.set(fetcher, cache); }
  for (const [key, item] of cache) if (item.expiresAt <= Date.now()) cache.delete(key);
  const cached = cache.get(source);
  if (cached) return cached.token;
  let account: { client_email?: string; private_key?: string };
  try { account = JSON.parse(source); } catch { throw new Error('Некорректный JSON сервисного аккаунта Google Cloud.'); }
  if (!account?.client_email || !account.private_key) throw new Error('JSON должен содержать client_email и private_key сервисного аккаунта.');
  const encode = (value: unknown) => url64(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenEndpoint, iat: now, exp: now + 3600,
  })}`;
  const pem = account.private_key.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  signal?.throwIfAborted();
  const response = await fetcher(tokenEndpoint, { method: 'POST', signal,
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${url64(new Uint8Array(signature))}` }),
  });
  const body = await response.json();
  if (!response.ok || typeof body.access_token !== 'string') throw new Error(`Google Cloud OAuth (${response.status}): ${body.error_description || body.error || 'Не удалось получить токен.'}`);
  const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  cache.set(source, { token: body.access_token, expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000 });
  return body.access_token;
}

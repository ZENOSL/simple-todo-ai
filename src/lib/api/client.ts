import { getStoredToken, setStoredToken, getOrCreateDeviceId } from "../auth";

async function fetchAnonymousToken(): Promise<string> {
  const res = await fetch("/api/auth/anonymous", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: getOrCreateDeviceId() }),
  });
  if (!res.ok) throw new Error(`匿名登录失败: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  setStoredToken(data.access_token);
  return data.access_token;
}

export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  let token = getStoredToken();

  const buildHeaders = (t: string | null): HeadersInit => ({
    ...(options.headers as Record<string, string> | undefined),
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  });

  const firstRes = await fetch(path, {
    ...options,
    headers: buildHeaders(token),
  });

  if (firstRes.status !== 401) {
    if (!firstRes.ok) {
      const errBody = await firstRes.json().catch(() => ({})) as { message?: string };
      throw new Error(errBody.message ?? `请求失败: ${firstRes.status}`);
    }
    return firstRes;
  }

  // 401 — 获取新 token 后重试一次
  token = await fetchAnonymousToken();

  const retryRes = await fetch(path, {
    ...options,
    headers: buildHeaders(token),
  });

  if (!retryRes.ok) {
    const errBody = await retryRes.json().catch(() => ({})) as { message?: string };
    throw new Error(errBody.message ?? `请求失败: ${retryRes.status}`);
  }
  return retryRes;
}

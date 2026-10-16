const tokenKey = "achadinhos_token";

export const getToken = () => localStorage.getItem(tokenKey) || "";
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);
export const clearToken = () => localStorage.removeItem(tokenKey);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const api = async <T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return {} as T;
  const text = await response.text();
  let data: { error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(response.status || 502, response.ok ? "Resposta inesperada do servidor." : "O servidor não respondeu. Tente de novo em alguns segundos.");
    }
  }
  if (!response.ok) throw new ApiError(response.status, data.error || "Falha na requisição");
  return data as T;
};

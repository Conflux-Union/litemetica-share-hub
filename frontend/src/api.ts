export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init)
  let body: unknown = null
  try {
    body = await resp.json()
  } catch {
    /* non-JSON error body */
  }
  if (!resp.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `request failed (${resp.status})`
    const retryAfter = Number(resp.headers.get('retry-after')) || undefined
    throw new ApiError(resp.status, message, retryAfter)
  }
  return body as T
}

export const api = {
  config: () => request<import('./types').SiteConfig>('/api/config'),
  me: () => request<{ user: import('./types').User | null }>('/api/auth/me'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  list: (page: number, size: number, q: string) =>
    request<import('./types').ListResponse>(
      `/api/schematics?page=${page}&size=${size}&q=${encodeURIComponent(q)}`,
    ),
  detail: (id: string) => request<import('./types').SchematicDetail>(`/api/schematics/${id}`),
  remove: (id: string) => request<{ ok: boolean }>(`/api/schematics/${id}`, { method: 'DELETE' }),
  upload: (file: File, description: string) => {
    const form = new FormData()
    form.append('file', file)
    if (description.trim()) form.append('description', description.trim())
    return request<{ id: string }>('/api/schematics', { method: 'POST', body: form })
  },
  previewUrl: (id: string) => `/api/schematics/${id}/preview`,
  downloadUrl: (id: string) => `/api/schematics/${id}/download`,
}

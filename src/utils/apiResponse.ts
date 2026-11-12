function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function readApiJson<T>(response: Response, serviceName: string): Promise<T> {
  const body = await response.text();
  let data: unknown;
  let isJson = true;

  try {
    data = JSON.parse(body);
  } catch {
    isJson = false;
  }

  if (!isJson) {
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    const isHtml = contentType.includes('text/html') || body.trimStart().startsWith('<');
    const format = isHtml ? 'HTML thay vì JSON' : 'dữ liệu không phải JSON';
    throw new Error(
      `${serviceName} trả về ${format} (HTTP ${response.status}). Kiểm tra URL backend và cấu hình route /api.`,
    );
  }

  if (!response.ok) {
    const serverError = isRecord(data) && typeof data.error === 'string'
      ? data.error
      : `${serviceName} trả về lỗi HTTP ${response.status}.`;
    throw new Error(serverError);
  }

  return data as T;
}

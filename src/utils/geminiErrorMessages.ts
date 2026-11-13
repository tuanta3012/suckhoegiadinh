export function cleanErrorMessage(rawMessage?: string): string {
  if (!rawMessage) return 'Có lỗi xảy ra khi xử lý dịch vụ AI.';
  let msg = typeof rawMessage === 'string' ? rawMessage.trim() : String(rawMessage);

  for (let depth = 0; depth < 3; depth++) {
    if ((msg.startsWith('{') && msg.endsWith('}')) || (msg.startsWith('[') && msg.endsWith(']'))) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.error === 'string') msg = parsed.error;
          else if (typeof parsed.error?.message === 'string') msg = parsed.error.message;
          else if (typeof parsed.message === 'string') msg = parsed.message;
          else break;
        } else break;
      } catch {
        break;
      }
    } else break;
  }

  if (/Timed out waiting for an available.*quota slot/i.test(msg)) {
    return 'Hệ thống AI đang bận điều phối tài nguyên, vui lòng thử lại sau ít giây.';
  }
  if (/No available projects remain/i.test(msg)) {
    return 'Chưa có API key nào khả dụng. Vui lòng kiểm tra cấu hình Gemini API trong Tài nguyên AI.';
  }
  if (/DEADLINE_EXCEEDED|504|Deadline expired|deadline/i.test(msg)) {
    return 'Yêu cầu AI xử lý bị quá thời gian chờ từ máy chủ Google (504 Deadline Exceeded). Vui lòng thử lại.';
  }
  if (/All configured Gemini API keys have exhausted daily quota/i.test(msg)) {
    return 'Tất cả API key trong Tài nguyên AI đều đã hết quota RPD cho mô hình này. Vui lòng kiểm tra quota Gemini hoặc bổ sung key khác.';
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return 'Gemini đang giới hạn tần suất gọi (429). Vui lòng thử lại sau ít phút.';
  }
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg)) {
    return 'Máy chủ AI Google hiện đang bận hoặc quá tải (503 Service Unavailable). Vui lòng thử lại sau ít giây.';
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return 'Không thể kết nối đến máy chủ AI (Lỗi mạng hoặc kết nối). Vui lòng kiểm tra đường truyền và thử lại.';
  }

  return msg;
}

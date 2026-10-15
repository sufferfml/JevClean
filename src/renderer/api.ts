const fragment = new URLSearchParams(location.hash.slice(1));
const incoming = fragment.get('session');
if (incoming) { sessionStorage.setItem('jevclean.session', incoming); history.replaceState(null, '', location.pathname); }
export async function api<T>(path: string, input?: unknown, options?: { timeoutMs?: number }): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/' + path, {
      method: input === undefined ? 'GET' : 'POST', credentials: 'omit',
      ...(options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      headers: { 'X-JevClean-Token': sessionStorage.getItem('jevclean.session') ?? '', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  } catch { throw new Error('应用连接中断，请重新打开。'); }
  const result = await response.json() as { ok: boolean; value: T; error?: string };
  if (!result.ok) throw new Error(result.error || '操作未完成。');
  return result.value;
}

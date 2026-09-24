export function updateState(previous = null, event = {}) {
  const state = previous ?? {
    status: 'idle', currentVersion: '', version: '', notes: '', error: '', downloaded: 0, total: null,
  };
  switch (event.type) {
    case 'info': return { ...state, currentVersion: event.version };
    case 'checking': return { ...state, status: 'checking', error: '', version: '', notes: '' };
    case 'none': return { ...state, status: 'current', error: '' };
    case 'available': return { ...state, status: 'available', version: event.version, notes: event.notes || '', error: '' };
    case 'check-error': return { ...state, status: 'error', error: event.error };
    case 'installing': return { ...state, status: 'installing', error: '', downloaded: 0, total: null };
    case 'progress': return { ...state, status: 'downloading', downloaded: event.downloaded, total: event.total ?? null };
    case 'downloaded': return { ...state, status: 'installing' };
    case 'install-error': return { ...state, status: 'install-error', error: event.error };
    case 'installed': return { ...state, status: 'installed' };
    default: return state;
  }
}

export function updateStatusText(state) {
  switch (state.status) {
    case 'checking': return '正在检查更新…';
    case 'current': return '当前已是最新版';
    case 'available': return `发现新版本 ${state.version}`;
    case 'error': return `检查失败：${state.error}`;
    case 'downloading': return state.total > 0
      ? `正在下载 ${Math.min(100, Math.round(state.downloaded / state.total * 100))}%`
      : `正在下载 ${Math.round(state.downloaded / 1024 / 1024)} MB`;
    case 'installing': return '下载完成，正在安装…';
    case 'install-error': return `安装失败：${state.error}`;
    case 'installed': return '安装已启动';
    default: return '尚未检查更新';
  }
}

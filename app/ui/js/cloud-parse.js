export function validateParserChoice(provider, settings = {}) {
  if (provider === 'local') return { ok: true };
  if (provider !== 'baidu') return { ok: false, message: '请选择解析方式' };
  if (!settings.accessToken?.trim()) return { ok: false, message: '请先在解析设置中填写百度 Access Token' };
  if (settings.uploadConfirmed !== true) return { ok: false, message: '请先在解析设置中确认上传与费用' };
  return { ok: true };
}

export function cloudTaskInput(paperId, job = null, resubmitConfirmed = false) {
  const batch = job?.batchId ? { batchId: job.batchId } : {};
  if (job?.jobId) return { paperId, action: 'resume', ...batch };
  const unknown = Boolean(job);
  if (unknown && !resubmitConfirmed) throw new Error('受理状态未知；重新提交可能重复计费，需要明确确认');
  return { paperId, action: 'submit', uploadConfirmed: true, ...batch, ...(unknown ? { resubmitConfirmed: true } : {}) };
}

const LABELS = {
  preparing: '准备中', submitting: '正在提交（中断后需核实受理状态）',
  'submit-unknown': '受理状态未知，重新提交可能重复计费', accepted: '已受理',
  querying: '查询远端状态', downloading: '下载原始结果', validating: '校验原始结果',
  downloaded: '原始结果已保存；正文与来源尚未就绪',
  interrupted: '客户端中断，可恢复查询或取回', 'poll-timeout': '等待超时，可恢复查询；远端任务未取消',
  'remote-failed': '远端解析失败',
  failed: '失败', cancelled: '客户端已停止；远端可能继续执行或计费',
};

export function cloudJobView(job = {}) {
  return {
    text: LABELS[job.state] || job.state || '未知状态',
    canResume: Boolean(job.jobId) && job.state !== 'downloaded',
    needsResubmit: !job.jobId && Boolean(job.state),
    failure: {
      cloud_auth_error: '百度凭据无效或权限不足，请检查解析设置',
      cloud_rate_limit: '百度请求限额或额度不足',
      cloud_poll_timeout: '本轮等待超时，恢复查询不会重新上传',
      cloud_submit_unknown: '受理状态未知，重新提交可能重复计费',
      cloud_network_error: '网络请求中断',
      cloud_invalid_result: '原始结果格式校验失败',
      integrity_failed: 'PDF 或结果身份校验失败',
      cloud_remote_failed: '百度远端解析失败，请查看服务控制台',
    }[job.failureCode] || (job.failureCode ? '任务未完成，请检查配置或恢复查询' : ''),
  };
}

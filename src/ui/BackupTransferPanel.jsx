import { useEffect, useRef, useState } from 'react';
import { getCurrentUsername } from '../userData.js';
import { flushPendingSaves } from '../saveCoordinator.js';
import { flushDurableInk } from '../durableInkStorage.js';
import { defaultRestoreSources } from '../backup.js';
import { openBackupDestination, exportManualBackup, parseBackupFile } from '../manualBackup.js';
import { createRestorePlan, applyRestorePlan, openRestoreHistory, recoverRestoreHistory } from '../backupRestorePlan.js';
import { makeConnection, connectionCode, transferCipher, transferCommand, sendDeviceBackup, receiveDeviceFile } from '../deviceTransfer.js';
import './backup-transfer.css';

export default function BackupTransferPanel({ username, appVersion }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(false);
  const [connection, setConnection] = useState(null), [host, setHost] = useState(''), [input, setInput] = useState('');
  const [offer, setOffer] = useState(null), [plan, setPlan] = useState(null), [choices, setChoices] = useState({});
  const [histories, setHistories] = useState([]), [showHistory, setShowHistory] = useState(false);
  const file = useRef(), working = useRef(false), cancelled = useRef(false), mounted = useRef(true), ownedPlan = useRef(null);
  const ownsConnection = useRef(false);
  const active = () => { if (!mounted.current || cancelled.current || getCurrentUsername() !== username) throw new Error('操作已取消或账号已切换'); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; if (ownsConnection.current) void transferCommand('stop').catch(() => {}); void ownedPlan.current?.dispose(); }; }, []);
  async function run(fn) {
    if (working.current) return;
    working.current = true; cancelled.current = false; setBusy(true); setError(false);
    try { await fn(); } catch (e) { if (mounted.current) { setError(true); setMessage(e.message || '操作失败，请重试'); } }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  async function flush() { active(); await flushPendingSaves(); await flushDurableInk(username); active(); }
  async function preview(source) {
    await flush(); let manifest;
    await ownedPlan.current?.dispose(); ownedPlan.current = null; setPlan(null);
    try {
      manifest = await parseBackupFile(source, { active, onProgress: setMessage });
      const next = await createRestorePlan({ manifest, username, sources: defaultRestoreSources({ allowOverwrite: true }), active, onProgress: setMessage });
      await ownedPlan.current?.dispose(); ownedPlan.current = next; setPlan(next); setChoices({});
      setMessage('文件校验通过。请核对新增内容和冲突，再确认导入。');
    } finally { await manifest?.dispose?.(); await source.dispose?.(); }
  }
  useEffect(() => {
    if (!connection) return;
    let stopped = false, polling = false;
    const tick = async () => {
      if (polling || working.current || stopped) return; polling = true;
      try {
        const status = await transferCommand('status'); if (stopped) return;
        if (status.state === 'offered' && !offer) {
          const cipher = await transferCipher(connection);
          const incoming = JSON.parse(new TextDecoder().decode(await cipher.decrypt(0, status.offer)));
          if (!incoming.username || incoming.username !== username) throw new Error(`对方账号为 ${String(incoming.username || '未知').slice(0, 80)}，请先切换到同名账号再接收。`);
          setOffer(incoming); setMessage('已收到连接请求，请确认接收。');
        } else if (status.state === 'accepted') setMessage(`正在接收加密备份：${(status.bytes / 1048576).toFixed(1)} MB`);
        else if (status.state === 'complete') {
          await run(async () => {
            const received = await receiveDeviceFile(connection, status, { active, onProgress: setMessage });
            await preview(received);
          });
          await transferCommand('stop'); setConnection(null); setOffer(null);
        }
      } catch (e) {
        if (!stopped) { setError(true); setMessage(e.message); setConnection(null); setOffer(null); await transferCommand('stop').catch(() => {}); }
      } finally { polling = false; }
    };
    const timer = setInterval(() => void tick(), 900); void tick();
    return () => { stopped = true; clearInterval(timer); };
  }, [connection, offer, username]);
  async function refreshHistory() {
    const history = await openRestoreHistory();
    try { setHistories(await history.list(username)); } finally { history.close(); }
  }
  useEffect(() => {
    let current = true;
    void openRestoreHistory().then(async history => {
      try {
        const list = await history.list(username);
        if (current) {
          setHistories(list);
          if (list.some(h => ['interrupted', 'applying', 'preparing'].includes(h.state))) {
            setShowHistory(true); setMessage('发现未完成的导入，请查看导入历史；已存在的学习内容保留，可恢复被替换版本。');
          }
        }
      } finally { history.close(); }
    }).catch(() => {});
    return () => { current = false; };
  }, [username]);
  async function exportFile() {
    let destination;
    try {
      setMessage('请选择备份保存位置…');
      destination = await openBackupDestination(`wuliao-backup-${username}-${new Date().toISOString().slice(0, 10)}.json`);
      await flush();
      const { counts, saved } = await exportManualBackup({ username, appVersion, destination, active, onProgress: setMessage });
      setMessage(`${saved ? '已保存并校验备份' : '已生成并发起下载'}：${counts.localStorage} 条本地记录、${counts.indexedDB} 条数据库记录、${counts.customPdfs} 个附件；不含 API Key、密码与缓存。`);
    } catch (e) { await destination?.abort().catch(() => {}); throw e; }
  }
  async function apply() {
    await flush(); const history = await openRestoreHistory();
    try {
      const result = await applyRestorePlan({ plan, choices, sources: defaultRestoreSources({ allowOverwrite: true }), history, active, onProgress: setMessage });
      setMessage(`导入完成：写入并逐条校验 ${result.written} 条记录。相同内容已跳过；被替换版本保存在导入历史。请关闭设置后刷新学习页面。`);
      await ownedPlan.current?.dispose(); ownedPlan.current = null; setPlan(null);
    } finally { history.close(); await refreshHistory(); }
  }
  const locked = busy || Boolean(connection);
  return <section className="settings-section backup-transfer">
    <h3>数据备份与设备互传</h3>
    <p className="settings-note">包含当前账号的学习记录、词库、笔迹及自定义资料；不包含 API Key、密码与缓存。另一设备请使用同名本机账号。</p>
    <div className="settings-row"><span>生成并下载备份</span><button className="settings-action primary" disabled={locked} onClick={() => run(exportFile)}>导出备份</button></div>
    <div className="settings-row"><span>从备份文件恢复</span><button className="settings-action" disabled={locked} onClick={() => file.current.click()}>选择备份文件</button></div>
    <input className="visually-hidden" ref={file} type="file" accept=".json,application/json" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (selected) void run(() => preview(selected)); }} />
    <div className="settings-row"><span>同一 Wi-Fi / 热点内免费互传</span><button className="settings-action" disabled={locked || Boolean(plan)} onClick={() => run(async () => {
      const info = await makeConnection();
      try { active(); } catch (e) { await transferCommand('stop').catch(() => {}); throw e; }
      if (!info.hosts.length) { await transferCommand('stop'); throw new Error('未找到局域网地址，请连接 Wi-Fi 或开启热点后重试。'); }
      ownsConnection.current = true; setConnection(info); setHost(info.hosts[0]); setMessage('接收已开启，连接码 10 分钟内有效。请将完整连接码交给发送设备。');
    })}>接收其他设备数据</button></div>
    {connection ? <div className="backup-transfer-card">
      <label>接收地址<select value={host} onChange={e => setHost(e.target.value)}>{connection.hosts.map(h => <option key={h} value={h}>{h}:{connection.port}</option>)}</select></label>
      <label>一次性连接码<textarea readOnly aria-label="本机连接码" value={connectionCode(connection, host)} onFocus={e => e.target.select()} /></label>
      <button className="settings-action" onClick={() => run(async () => { await navigator.clipboard.writeText(connectionCode(connection, host)); setMessage('连接码已复制，请仅发送给你的另一台设备。'); })}>复制连接码</button>
      {offer && <p>发送设备：{offer.platform} · 账号 {offer.username}<button className="settings-action primary" disabled={busy} onClick={() => run(async () => { await transferCommand('accept'); setOffer(null); setMessage('已确认，等待发送端生成并传送备份…'); })}>确认接收</button></p>}
      <p className="settings-note">连接码包含本次加密密钥，仅交给你的设备；页面关闭后失效。</p>
    </div> : <div className="backup-transfer-card">
      <label>另一设备的连接码<textarea aria-label="另一设备的连接码" value={input} disabled={busy} onChange={e => setInput(e.target.value)} placeholder="先在另一设备打开接收，再粘贴完整 WL1 连接码" /></label>
      <button className="settings-action" disabled={busy || !input.trim() || Boolean(plan)} onClick={() => run(async () => { await flush(); await sendDeviceBackup({ code: input, username, appVersion, active, onProgress: setMessage }); setInput(''); })}>发送到其他设备</button>
      <p className="settings-note">Windows 请使用下载版并重新启动；连接失败时检查同网、防火墙或热点隔离，也可通过 USB / LocalSend 传备份文件。</p>
    </div>}
    {(busy || connection) && <button className="settings-action" onClick={() => { cancelled.current = true; void transferCommand('stop').catch(() => {}); setConnection(null); setOffer(null); setMessage('已请求取消；等待当前分块停止。'); }}>取消当前操作</button>}
    {plan && <div className="backup-transfer-card" aria-label="导入差异预览">
      <h4>导入差异预览</h4><p>新增 {plan.counts.added} 条 · 相同 {plan.counts.same} 条 · 冲突 {plan.counts.conflict} 条</p>
      <p className="settings-note">冲突默认保留本机。有关联的记录作为整组选择；保留本机时，该组新增记录也暂不导入。本机独有内容保留，不传播删除操作。</p>
      {plan.groups.map(group => <div key={group.id} className="backup-conflict-group">
        <strong>{group.label}</strong><p>新增 {group.added} 条，冲突 {group.conflicts} 条</p>
        {group.conflicts > 0 && <><select aria-label={`${group.label}的处理方式`} disabled={busy} value={choices[group.id] || 'local'} onChange={e => setChoices({ ...choices, [group.id]: e.target.value })}><option value="local">保留本机这一组</option><option value="incoming">采用导入的这一组，并保存原版本</option></select>
          {group.examples.map((ex, i) => <p key={i} className="settings-note">本机：{ex.local}<br />导入：{ex.incoming}</p>)}{group.conflicts > 3 && <p className="settings-note">以上展示前 3 条冲突摘要；选择会作用于整组。</p>}</>}
      </div>)}
      <button className="settings-action primary" disabled={busy} onClick={() => {
        if (window.confirm('按当前选择导入？被替换记录会先保存恢复版本；本机已有的其他内容保留。')) void run(apply);
      }}>确认导入</button>
      <button className="settings-action" disabled={busy} onClick={() => run(async () => { await ownedPlan.current?.dispose(); ownedPlan.current = null; setPlan(null); setMessage('已放弃本次预览，未写入学习数据。'); })}>放弃预览</button>
    </div>}
    <button className="settings-action" disabled={locked} onClick={() => run(async () => { await refreshHistory(); setShowHistory(!showHistory); })}>导入历史与恢复</button>
    {showHistory && <div className="backup-transfer-card"><p className="settings-note">恢复仅还原被替换的旧版本，新增记录继续保留。后来继续修改过的内容会跳过，避免覆盖新学习。</p>
      {!histories.length && <p>暂无导入历史。</p>}
      {histories.map(h => <div key={h.id} className="backup-conflict-group"><p>{new Date(h.createdAt).toLocaleString()} · {{ complete: '已完成', interrupted: '导入中断，可恢复', preparing: '准备中断', applying: '导入未完成', recovered: '已恢复旧版本', 'recovery-conflicts': '部分记录后来已修改' }[h.state] || h.state} · {h.written}/{h.count} 条</p>
        <button className="settings-action" disabled={busy} onClick={() => { if (window.confirm('恢复这次导入替换前的版本？后续已修改的记录会保留。')) void run(async () => {
          await flush(); const history = await openRestoreHistory(); try { const r = await recoverRestoreHistory({ id: h.id, username, sources: defaultRestoreSources({ allowOverwrite: true }), history, active }); setMessage(`恢复完成：还原 ${r.restored} 条，保留后来已修改的 ${r.changed} 条。请刷新学习页面。`); } finally { history.close(); await refreshHistory(); }
        }); }}>恢复被替换版本</button>
        <button className="settings-action" disabled={busy} onClick={() => { if (window.confirm(`删除这条导入历史和 ${h.count} 条恢复资料？删除后不能再从这里恢复旧版本；现有学习数据不会被删除。`)) void run(async () => { const history = await openRestoreHistory(); try { await history.delete(h.id, username); } finally { history.close(); } await refreshHistory(); }); }}>删除恢复资料</button>
      </div>)}
    </div>}
    {message && <p role="status" className={`settings-note settings-backup-status ${error ? 'is-error' : ''}`}>{message}</p>}
  </section>;
}

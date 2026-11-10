import React from "react";
import { relativeTime, STATUS_LABELS } from "./timeline";
import { deviceActivity, type RelayDeviceStatus } from "./mobile-device";

/** The subset of a relay node a card needs; the phone page passes far more. */
export interface DeviceCardNode {
  id: string;
  name: string;
  workspace: string;
  online: boolean;
  status?: RelayDeviceStatus;
}

/**
 * One laptop on the phone's device tab.
 *
 * The card merges both kinds of work: mesh jobs (a workbench turn or a
 * dispatched task) and sessions the terminal is running right now. Only the
 * first used to be visible, so a busy terminal reported "空闲".
 */
export function MobileDeviceCard({ device, current, onOpen, onJobs, onRemove }: {
  device: DeviceCardNode;
  current: boolean;
  onOpen(): void;
  onJobs(): void;
  onRemove(): void;
}): React.ReactElement {
  const activity = deviceActivity(device.status);
  // The relay keeps the last status it saw, so an offline laptop would still
  // advertise "正在工作" for a session that stopped a while ago.
  const running = device.online ? activity.running : [];
  const latest = activity.latest;
  const busy = activity.active.length + running.length;
  const wrote = running[0]?.updated_at;
  return <div className={`m-card m-device ${current ? "active" : ""}`}>
    <div className="m-device-row">
      <span className={`m-dot ${device.online ? "online" : "offline"}`} />
      <strong>{device.name}</strong>
      <span className={`m-chip ${device.online ? "done" : "failed"}`}>{device.online ? "在线" : "离线"}</span>
      {busy > 1 && <span className="m-chip working">{busy} 个进行中</span>}
    </div>
    <div className="m-device-path">{device.workspace || "未报告工作区"}{device.status?.model ? ` · ${device.status.model}` : ""}</div>
    {running.map(session => <div className="m-device-job" key={session.id}>
      <span className="m-chip working">正在工作</span>
      <span>{session.title || session.id}</span>
    </div>)}
    {running.length > 0 && <div className="m-note" style={{ marginTop: 5 }}>
      终端会话 · {running[0]!.project}{wrote ? ` · ${relativeTime(wrote)}前仍在写` : ""}
    </div>}
    {latest ? <>
      <div className="m-device-job">
        <span className={`m-chip ${latest.status}`}>{STATUS_LABELS[latest.status] ?? latest.status}</span>
        <span>{latest.title || latest.instruction || latest.id}</span>
      </div>
      <div className="m-note" style={{ marginTop: 5 }}>
        {activity.active.includes(latest) ? `进度 ${Math.round(latest.progress)}%` : "最近任务"}
        {latest.updated_at ? ` · ${relativeTime(latest.updated_at)}前更新` : ""}
        {activity.jobs.length > 1 ? ` · 共 ${activity.jobs.length} 条记录` : ""}
      </div>
    </> : running.length === 0 ? <div className="m-note">{device.online ? "空闲，等待派活" : "离线，状态已停止更新"}</div> : null}
    <div className="m-row" style={{ marginTop: 10, marginBottom: 0 }}>
      <button className="m-btn primary" disabled={!device.online} onClick={onOpen}>打开并派活</button>
      <button className="m-btn" onClick={onJobs}>查看任务</button>
      {!device.online && <button className="m-btn" onClick={onRemove}>移除</button>}
    </div>
  </div>;
}

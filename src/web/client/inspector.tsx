import React, { useState } from "react";
import { Preview } from "./preview";
import type { WorkbenchStore } from "./store";
import { relativeTime } from "./timeline";

function Tree({ store }: { store: WorkbenchStore }): React.ReactElement {
  const segments = store.treePath ? store.treePath.split("/") : [];
  return (
    <>
      <div className="crumbs">
        <button onClick={() => void store.browse("")}>workspace</button>
        {segments.map((segment, index) => (
          <React.Fragment key={segment + index}>
            <span className="muted">/</span>
            <button onClick={() => void store.browse(segments.slice(0, index + 1).join("/"))}>{segment}</button>
          </React.Fragment>
        ))}
      </div>
      <div className="tree">
        {store.tree.length === 0 && <span className="muted">目录为空</span>}
        {store.tree.map(entry => (
          <button
            key={entry.path}
            className={`tree-row ${store.file?.path === entry.path ? "active" : ""}`}
            onClick={() => entry.type === "dir" ? void store.browse(entry.path) : void store.openFile(entry.path)}
            title={entry.path}
          >
            <span>{entry.type === "dir" ? "▸" : "·"}</span>
            <span>{entry.name}</span>
            {entry.size !== undefined && <span className="size">{entry.size < 1024 ? `${entry.size}B` : `${(entry.size / 1024).toFixed(1)}K`}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

export function Approvals({ store }: { store: WorkbenchStore }): React.ReactElement | null {
  if (!store.approvals.length) return null;
  return (
    <div className="block">
      <h2>待确认操作 <span className="spacer" /><span className="chip">{store.approvals.length}</span></h2>
      {store.approvals.map(request => (
        <div className="approval" key={request.id}>
          <div className="title">
            <span>Agent 请求执行 {request.tool}</span>
            <span className="risk">{request.risk}</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>{request.description}</div>
          <pre className="args">{JSON.stringify(request.args, null, 2)}</pre>
          <div className="row">
            <button className="action allow" onClick={() => void store.decide(request.id, "once")}>允许一次</button>
            <button className="action" onClick={() => void store.decide(request.id, "tool")}>本任务内允许 {request.tool}</button>
            <button className="action primary wide" onClick={() => void store.decide(request.id, "always")}>本次会话全部放行</button>
            <button className="action deny wide" onClick={() => void store.decide(request.id, "deny")}>拒绝</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Questions({ store }: { store: WorkbenchStore }): React.ReactElement | null {
  const [custom, setCustom] = useState<Record<string, string>>({});
  if (!store.questions.length) return null;
  return <div className="block">
    <h2>等待你的选择 <span className="spacer" /><span className="chip">{store.questions.length}</span></h2>
    {store.questions.map(item => <div className="approval" key={item.id}>
      <div className="title">{item.question}</div>
      <div className="grid">
        {item.options.map(option => <button className="action wide" key={option.label}
          title={option.description} onClick={() => void store.answerQuestion(item.id, option.label)}>
          {option.label}{option.description ? ` · ${option.description}` : ""}
        </button>)}
      </div>
      <div className="row">
        <input className="field wide" aria-label="自定义回答" placeholder="或输入自己的答案"
          value={custom[item.id] ?? ""} onChange={event => setCustom(current => ({ ...current, [item.id]: event.target.value }))}
          onKeyDown={event => { if (event.key === "Enter" && (custom[item.id] ?? "").trim()) void store.answerQuestion(item.id, custom[item.id]!); }} />
        <button className="action" disabled={!(custom[item.id] ?? "").trim()}
          onClick={() => void store.answerQuestion(item.id, custom[item.id] ?? "")}>发送</button>
      </div>
    </div>)}
  </div>;
}

export function Inspector({ store }: { store: WorkbenchStore }): React.ReactElement {
  const [peer, setPeer] = useState("");
  const [text, setText] = useState("");
  const [contact, setContact] = useState({ name: "", host: "", port: "", udp: "" });
  const target = peer || store.peers[0]?.name || "";

  return (
    <aside className="inspect">
      <div className="inspect-preview">
        <Preview store={store} />
      </div>
      <div className="inspect-scroll">
        <Questions store={store} />
        <Approvals store={store} />
        <div className="block">
          <h2>Workspace <span className="spacer" />{store.file?.path && <button className="action" style={{ padding: "2px 7px" }} onClick={() => void store.refreshDiff()}>查看变更</button>}</h2>
          <Tree store={store} />
        </div>
        <div className="block">
          <h2>Mesh peers <span className="spacer" /><span className="muted">{store.peers.filter(item => item.online).length}/{store.peers.length}</span></h2>
          {store.peers.length === 0 && <span className="muted">暂无节点</span>}
          {store.peers.map(item => (
            <div className="peer" key={item.name}>
              <span className={`dot ${item.online ? "online" : "offline"}`} />
              <span className="name" title={`${item.host}:${item.port}`}>{item.name}</span>
              <span className="state">{item.online ? "在线" : relativeTime(item.last_seen) || "离线"}</span>
              {item.version && item.version !== "unknown" && <span className="muted">v{item.version}</span>}
            </div>
          ))}
        </div>
        <div className="block">
          <h2>Inbox</h2>
          {store.inbox.length === 0 && <span className="muted">暂无消息</span>}
          {store.inbox.slice(0, 8).map(item => (
            <div className="peer" key={item.id}>
              <span className="dot online" />
              <span className="name"><b>{item.from}</b> · {item.text}</span>
              <span className="state">{relativeTime(item.received_at)}</span>
            </div>
          ))}
        </div>
        <div className="block">
          <h2>Mesh 操作</h2>
          <div className="grid">
            <select className="field wide" value={target} onChange={event => setPeer(event.target.value)}>
              {store.peers.length === 0 && <option value="">无可用节点</option>}
              {store.peers.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            <button className="action" disabled={!target} onClick={() => void store.syncPeer("push")}>同步推送</button>
            <button className="action" disabled={!target} onClick={() => void store.syncPeer("pull")}>同步拉取</button>
            <input className="field wide" placeholder="发给节点的消息" value={text} onChange={event => setText(event.target.value)} />
            <button className="action wide" disabled={!target || !text} onClick={() => { void store.messagePeer(target, text); setText(""); }}>发送消息</button>
          </div>
        </div>
        <div className="block">
          <h2>添加联系人</h2>
          <div className="grid">
            <input className="field wide" placeholder="名称" value={contact.name} onChange={event => setContact({ ...contact, name: event.target.value })} />
            <input className="field wide" placeholder="主机" value={contact.host} onChange={event => setContact({ ...contact, host: event.target.value })} />
            <input className="field" placeholder="TCP 端口" value={contact.port} onChange={event => setContact({ ...contact, port: event.target.value })} />
            <input className="field" placeholder="UDP 端口" value={contact.udp} onChange={event => setContact({ ...contact, udp: event.target.value })} />
            <button
              className="action primary wide"
              disabled={!contact.name || !contact.host}
              onClick={() => { void store.addContact({ name: contact.name, host: contact.host, port: Number(contact.port || 0), udp_port: Number(contact.udp || 0) }); setContact({ name: "", host: "", port: "", udp: "" }); }}
            >
              保存联系人
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

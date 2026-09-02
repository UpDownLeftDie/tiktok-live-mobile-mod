import type {
  ChatHighlightConfig,
  ChatLogItem,
  ChatUserSignals,
  ConnectionStatus,
  GiftAlertRule,
  GiftLogItem,
  LiveFeed,
  RoomEventType,
  RoomLogItem,
} from '@tiktok-mod/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import {
  addStream,
  checkIn,
  checkOut,
  DEFAULT_CHAT_HIGHLIGHTS,
  fetchPublicConfig,
  getConfig,
  getLiveFeed,
  getPasscode,
  listStreams,
  markDone,
  markGiftDone,
  markGiftPending,
  putConfig,
  removeStream,
  setPasscode,
  statusLabel,
  subscribePush,
  testPush,
  urlBase64ToUint8Array,
} from './api';

type StreamRow = {
  streamId: string;
  addedAt: number;
  isCheckedIn: boolean;
};

type Tab = 'live' | 'streams' | 'settings';

type BootState =
  | { phase: 'loading' }
  | { phase: 'locked'; vapidPublicKey: string | null }
  | {
      phase: 'ready';
      passcodeRequired: boolean;
      vapidPublicKey: string | null;
    }
  | { phase: 'error'; message: string };

const EVENT_FILTER_TYPES: { type: RoomEventType; label: string }[] = [
  { type: 'member', label: 'Joins' },
  { type: 'follow', label: 'Follows' },
  { type: 'share', label: 'Shares' },
  { type: 'subscribe', label: 'Subs' },
  { type: 'like', label: 'Likes' },
  { type: 'stream_end', label: 'End' },
  { type: 'other', label: 'Other' },
];

const EVENT_FILTER_KEY = (streamId: string) =>
  `live-mod:event-filters:${streamId}`;

function defaultEventFilters(): Set<RoomEventType> {
  return new Set(
    EVENT_FILTER_TYPES.map((t) => t.type).filter((t) => t !== 'like'),
  );
}

function loadEventFilters(streamId: string): Set<RoomEventType> {
  try {
    const raw = localStorage.getItem(EVENT_FILTER_KEY(streamId));
    if (!raw) return defaultEventFilters();
    return new Set(JSON.parse(raw) as RoomEventType[]);
  } catch {
    return defaultEventFilters();
  }
}

function saveEventFilters(streamId: string, types: Set<RoomEventType>) {
  localStorage.setItem(EVENT_FILTER_KEY(streamId), JSON.stringify([...types]));
}

const EMPTY_FEED: LiveFeed = {
  streamId: '',
  status: 'idle',
  statusDetail: null,
  isCheckedIn: false,
  chatHighlights: DEFAULT_CHAT_HIGHLIGHTS,
  chat: [],
  events: [],
  gifts: [],
};

export function App() {
  const [boot, setBoot] = useState<BootState>({ phase: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchPublicConfig();
        if (!cfg.passcodeRequired) {
          setBoot({
            phase: 'ready',
            passcodeRequired: false,
            vapidPublicKey: cfg.vapidPublicKey,
          });
          return;
        }
        const stored = getPasscode();
        if (stored) {
          try {
            await listStreams();
            setBoot({
              phase: 'ready',
              passcodeRequired: true,
              vapidPublicKey: cfg.vapidPublicKey,
            });
            return;
          } catch {
            setPasscode('');
          }
        }
        setBoot({ phase: 'locked', vapidPublicKey: cfg.vapidPublicKey });
      } catch (err) {
        setBoot({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  if (boot.phase === 'loading') {
    return (
      <div className="app">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (boot.phase === 'error') {
    return (
      <div className="app">
        <header className="header">
          <div>
            <p className="brand">Live Mod</p>
            <p className="sub">TikTok LIVE alerts — phone-first</p>
          </div>
        </header>
        <div className="banner error">{boot.message}</div>
      </div>
    );
  }

  if (boot.phase === 'locked') {
    return (
      <PasscodeGate
        vapidPublicKey={boot.vapidPublicKey}
        onUnlocked={(vapidPublicKey) =>
          setBoot({
            phase: 'ready',
            passcodeRequired: true,
            vapidPublicKey,
          })
        }
      />
    );
  }

  return (
    <ModApp
      passcodeRequired={boot.passcodeRequired}
      vapidPublicKey={boot.vapidPublicKey}
      onLock={() =>
        setBoot({
          phase: 'locked',
          vapidPublicKey: boot.vapidPublicKey,
        })
      }
    />
  );
}

function PasscodeGate(
  props: Readonly<{
    vapidPublicKey: string | null;
    onUnlocked: (vapidPublicKey: string | null) => void;
  }>,
) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPasscode(value.trim());
    try {
      await listStreams();
      props.onUnlocked(props.vapidPublicKey);
    } catch {
      setPasscode('');
      setError('Incorrect passcode.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="brand">Live Mod</p>
          <p className="sub">Enter the mod passcode to continue</p>
        </div>
      </header>
      <section className="panel gate">
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>Passcode</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="shared passcode"
            />
          </label>
          {error ? <div className="banner error">{error}</div> : null}
          <button
            type="submit"
            className="primary"
            disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </section>
    </div>
  );
}

function ModApp(
  props: Readonly<{
    passcodeRequired: boolean;
    vapidPublicKey: string | null;
    onLock: () => void;
  }>,
) {
  const [tab, setTab] = useState<Tab>('live');
  const [streams, setStreams] = useState<StreamRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [feed, setFeed] = useState<LiveFeed>(EMPTY_FEED);
  const [newStream, setNewStream] = useState('');
  const [passcodeInput, setPasscodeInput] = useState(getPasscode());
  const [pushStatus, setPushStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedStream = useMemo(
    () => streams.find((s) => s.streamId === selected) ?? null,
    [streams, selected],
  );

  const handleUnauthorized = useCallback(() => {
    setPasscode('');
    setStreams([]);
    setFeed(EMPTY_FEED);
    props.onLock();
  }, [props]);

  const refreshStreams = useCallback(async () => {
    try {
      const data = await listStreams();
      setStreams(data.streams);
      setSelected((prev) => {
        if (prev && data.streams.some((s) => s.streamId === prev)) return prev;
        const checked = data.streams.find((s) => s.isCheckedIn);
        return checked?.streamId ?? data.streams[0]?.streamId ?? null;
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      throw err;
    }
  }, [handleUnauthorized]);

  const refreshLive = useCallback(async () => {
    if (!selected) {
      setFeed(EMPTY_FEED);
      return;
    }
    try {
      setFeed(await getLiveFeed(selected));
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      throw err;
    }
  }, [selected, handleUnauthorized]);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('stream');
    if (fromUrl) {
      setSelected(fromUrl);
      setTab('live');
    }
    void refreshStreams().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refreshStreams]);

  useEffect(() => {
    void refreshLive().catch(() => undefined);
    const id = window.setInterval(() => {
      void refreshLive().catch(() => undefined);
      void refreshStreams().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [refreshLive, refreshStreams]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function enablePush() {
    if (!props.vapidPublicKey) {
      setPushStatus('VAPID public key not configured on the Worker.');
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('Push not supported in this browser.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setPushStatus(`Permission: ${permission}`);
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        props.vapidPublicKey,
      ) as BufferSource,
    });
    await subscribePush(sub.toJSON());
    setPushStatus('Subscribed to push.');
  }

  const status: ConnectionStatus = selectedStream?.isCheckedIn
    ? feed.status
    : 'idle';

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="brand">Live Mod</p>
          <p className="sub">
            {selected ? `@${selected}` : 'TikTok LIVE alerts — phone-first'}
          </p>
        </div>
        <StatusChip
          status={status}
          checkedIn={Boolean(selectedStream?.isCheckedIn)}
        />
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      <nav className="tabs">
        {(['live', 'streams', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? 'tab active' : 'tab'}
            type="button"
            onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === 'live' ? (
          <LivePanel
            selected={selected}
            feed={feed}
            busy={busy}
            onDone={(queueItemId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markDone(selected, queueItemId);
                await refreshLive();
              })
            }
            onGiftDone={(giftId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markGiftDone(selected, giftId);
                await refreshLive();
              })
            }
            onGiftUndo={(giftId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markGiftPending(selected, giftId);
                await refreshLive();
              })
            }
          />
        ) : null}

        {tab === 'streams' ? (
          <StreamsPanel
            streams={streams}
            selected={selected}
            newStream={newStream}
            busy={busy}
            onNewStreamChange={setNewStream}
            onSelect={(id) => {
              setSelected(id);
              setTab('live');
            }}
            onAdd={() =>
              void withBusy(async () => {
                await addStream(newStream);
                setNewStream('');
                await refreshStreams();
              })
            }
            onCheckIn={(id) =>
              void withBusy(async () => {
                await checkIn(id);
                setSelected(id);
                setTab('live');
                await refreshStreams();
                await refreshLive();
              })
            }
            onCheckOut={(id) =>
              void withBusy(async () => {
                await checkOut(id);
                await refreshStreams();
                await refreshLive();
              })
            }
            onRemove={(id) =>
              void withBusy(async () => {
                await removeStream(id);
                if (selected === id) setSelected(null);
                await refreshStreams();
              })
            }
            onUnauthorized={handleUnauthorized}
            onStreamSettingsSaved={(id) => {
              if (id === selected) void refreshLive().catch(() => undefined);
            }}
            withBusy={withBusy}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsPanel
            passcode={passcodeInput}
            passcodeRequired={props.passcodeRequired}
            pushStatus={pushStatus}
            busy={busy}
            onPasscodeChange={setPasscodeInput}
            onPasscodeBlur={() => setPasscode(passcodeInput)}
            onLock={() => {
              setPasscode('');
              props.onLock();
            }}
            onEnablePush={() => void enablePush()}
            onTestPush={() =>
              void withBusy(async () => {
                await testPush();
                setPushStatus('Test push sent.');
              })
            }
          />
        ) : null}
      </main>
    </div>
  );
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function FeedTime(props: Readonly<{ at: number }>) {
  return <span className="feed-time">{formatClock(props.at)}</span>;
}

function statusTone(
  checkedIn: boolean,
  status: ConnectionStatus,
): 'idle' | 'live' | 'warn' {
  if (!checkedIn) return 'idle';
  if (status === 'live') return 'live';
  if (status === 'offline' || status === 'disconnected') return 'warn';
  return 'idle';
}

function StatusChip(
  props: Readonly<{ status: ConnectionStatus; checkedIn: boolean }>,
) {
  const label = !props.checkedIn ? 'Checked out' : statusLabel(props.status);
  const tone = statusTone(props.checkedIn, props.status);
  return <span className={`badge status-${tone}`}>{label}</span>;
}

function LivePanel(
  props: Readonly<{
    selected: string | null;
    feed: LiveFeed;
    busy: boolean;
    onDone: (queueItemId: string) => void;
    onGiftDone: (giftId: string) => void;
    onGiftUndo: (giftId: string) => void;
  }>,
) {
  const [eventFilters, setEventFilters] = useState<Set<RoomEventType>>(() =>
    defaultEventFilters(),
  );

  useEffect(() => {
    if (!props.selected) return;
    setEventFilters(loadEventFilters(props.selected));
  }, [props.selected]);

  function toggleEventType(type: RoomEventType) {
    if (!props.selected) return;
    setEventFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      saveEventFilters(props.selected!, next);
      return next;
    });
  }

  if (!props.selected) {
    return (
      <section className="panel">
        <h1>Live</h1>
        <p className="muted">Add and check in to a stream to see the feed.</p>
      </section>
    );
  }

  const highlights = props.feed.chatHighlights ?? DEFAULT_CHAT_HIGHLIGHTS;
  const filteredEvents = props.feed.events.filter((e) =>
    eventFilters.has(e.type),
  );

  return (
    <section className="panel live-panel">
      <div className="live-layout">
        <FeedColumn
          title="Gifts"
          className="feed-primary"
          empty="No gifts yet.">
          <GiftList
            items={props.feed.gifts}
            busy={props.busy}
            onDone={props.onGiftDone}
            onUndo={props.onGiftUndo}
          />
        </FeedColumn>

        <div className="live-secondary">
          <FeedColumn title="Chat" className="feed-chat" empty="No chat yet.">
            <ChatList
              items={props.feed.chat}
              gifts={props.feed.gifts}
              highlights={highlights}
              busy={props.busy}
              onDone={props.onDone}
            />
          </FeedColumn>

          <FeedColumn
            title="Events"
            className="feed-events"
            empty="No room events yet."
            headerExtra={
              <div className="pill-row">
                {EVENT_FILTER_TYPES.map((f) => (
                  <button
                    key={f.type}
                    type="button"
                    className={
                      eventFilters.has(f.type) ? 'pill active' : 'pill'
                    }
                    onClick={() => toggleEventType(f.type)}>
                    {f.label}
                  </button>
                ))}
              </div>
            }>
            <EventList items={filteredEvents} />
          </FeedColumn>
        </div>
      </div>
    </section>
  );
}

function FeedColumn(
  props: Readonly<{
    title: string;
    empty: string;
    className?: string;
    headerExtra?: ReactNode;
    children: ReactNode;
  }>,
) {
  return (
    <div className={`feed-col ${props.className ?? ''}`}>
      <div className="feed-col-header">
        <h2>{props.title}</h2>
        {props.headerExtra}
      </div>
      <div className="feed-scroll">{props.children}</div>
    </div>
  );
}

function recentGifterUsernames(
  gifts: GiftLogItem[],
  highlights: ChatHighlightConfig,
  atTime: number,
): Set<string> {
  const names = new Set<string>();
  if (!highlights.highlightRecentGifters) return names;
  const windowMs = highlights.recentGifterWindowSeconds * 1000;
  for (const g of gifts) {
    if (!g.senderUsername) continue;
    if ((g.diamondValue ?? 0) < highlights.recentGifterMinDiamonds) continue;
    if (atTime - g.createdAt > windowMs || atTime < g.createdAt) continue;
    names.add(g.senderUsername.toLowerCase());
  }
  return names;
}

function ChatList(
  props: Readonly<{
    items: ChatLogItem[];
    gifts: GiftLogItem[];
    highlights: ChatHighlightConfig;
    busy: boolean;
    onDone: (queueItemId: string) => void;
  }>,
) {
  const watchlist = useMemo(
    () =>
      new Set(props.highlights.highlightUsernames.map((u) => u.toLowerCase())),
    [props.highlights.highlightUsernames],
  );

  if (props.items.length === 0) {
    return <p className="muted feed-empty">No chat yet.</p>;
  }
  return (
    <div className="feed-inner">
      {props.items.map((item) => {
        const done = item.queueStatus === 'done';
        const pending = item.queueStatus === 'pending';
        const uname = item.username?.toLowerCase() ?? '';
        const watched = Boolean(uname && watchlist.has(uname));
        const gifters = recentGifterUsernames(
          props.gifts,
          props.highlights,
          item.createdAt,
        );
        const recentGifter = Boolean(uname && gifters.has(uname));
        const classes = [
          'feed-line',
          item.flaggedKeyword ? 'flagged' : '',
          done ? 'faded' : '',
          watched ? 'hl-watch' : '',
          recentGifter ? 'hl-gifter' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={item.id} className={classes}>
            <FeedTime at={item.createdAt} />
            <div className="feed-line-main">
              <span className="chat-user">
                {item.userSignals?.nickname
                  ? `${item.userSignals.nickname} `
                  : null}
                @{item.username ?? 'anon'}
              </span>
              <ChatSignalTags signals={item.userSignals} />
              <span className="chat-body">{item.comment}</span>
              {watched ? <span className="tag"> watch</span> : null}
              {recentGifter ? (
                <span className="tag tag-gift"> gifted</span>
              ) : null}
              {item.flaggedKeyword ? (
                <span className="tag"> {item.flaggedKeyword}</span>
              ) : null}
            </div>
            {pending && item.queueItemId ? (
              <button
                type="button"
                className="primary tiny"
                disabled={props.busy}
                onClick={() => props.onDone(item.queueItemId!)}>
                Done
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ChatSignalTags(
  props: Readonly<{ signals: ChatUserSignals | null }>,
) {
  const s = props.signals;
  if (!s) return null;
  const tags: { key: string; label: string; className: string }[] = [];
  if (s.isModerator) tags.push({ key: 'mod', label: 'mod', className: 'tag-mod' });
  if (s.isSubscriber) tags.push({ key: 'sub', label: 'sub', className: 'tag-sub' });
  if (s.isFollower) tags.push({ key: 'fol', label: 'follow', className: 'tag-follow' });
  if (s.isGiftGiver) tags.push({ key: 'gg', label: 'gifter', className: 'tag-gift' });
  if (s.fansClubName) {
    tags.push({
      key: 'fans',
      label:
        s.fansClubLevel != null
          ? `${s.fansClubName} Lv${s.fansClubLevel}`
          : s.fansClubName,
      className: 'tag-fans',
    });
  }
  if (s.payGradeName || s.payGradeLevel != null) {
    tags.push({
      key: 'pay',
      label:
        s.payGradeLevel != null
          ? `${s.payGradeName ?? 'tier'} ${s.payGradeLevel}`
          : (s.payGradeName ?? 'tier'),
      className: 'tag-pay',
    });
  }
  for (const label of s.badgeLabels.slice(0, 2)) {
    tags.push({ key: `b-${label}`, label, className: 'tag-badge' });
  }
  if (tags.length === 0) return null;
  return (
    <span className="signal-tags">
      {tags.map((t) => (
        <span key={t.key} className={`tag ${t.className}`}>
          {t.label}
        </span>
      ))}
    </span>
  );
}

function EventList(props: Readonly<{ items: RoomLogItem[] }>) {
  if (props.items.length === 0) {
    return <p className="muted feed-empty">No matching events.</p>;
  }
  return (
    <div className="feed-inner">
      {props.items.map((item) => (
        <div key={item.id} className="feed-line">
          <FeedTime at={item.createdAt} />
          <div className="feed-line-main">
            <span className="event-type">{item.type}</span> {item.summary}
          </div>
        </div>
      ))}
    </div>
  );
}

function GiftList(
  props: Readonly<{
    items: GiftLogItem[];
    busy: boolean;
    onDone: (giftId: string) => void;
    onUndo: (giftId: string) => void;
  }>,
) {
  if (props.items.length === 0) {
    return <p className="muted feed-empty">No gifts yet.</p>;
  }
  return (
    <div className="feed-inner gifts">
      {props.items.map((item) => {
        const pending = item.alertStatus !== 'done';
        const done = item.alertStatus === 'done';
        const isAlert = Boolean(item.matchedRule) && pending;
        return (
          <div
            key={item.id}
            className={`feed-line gift-line ${isAlert ? 'alert' : ''} ${done ? 'faded' : ''}`}>
            <FeedTime at={item.createdAt} />
            <div className="feed-line-main">
              <span className="chat-user">
                @{item.senderUsername ?? 'someone'}
              </span>
              <span className="chat-body">
                sent {item.giftName ?? 'gift'} ×{item.giftCount}
                {item.diamondValue != null ? (
                  <span className="muted"> · {item.diamondValue}◆</span>
                ) : null}
                {item.matchedRule ? (
                  <span className="tag"> {item.matchedRule}</span>
                ) : null}
              </span>
            </div>
            {pending ? (
              <button
                type="button"
                className="primary tiny"
                disabled={props.busy}
                onClick={() => props.onDone(item.id)}>
                Done
              </button>
            ) : (
              <button
                type="button"
                className="tiny"
                disabled={props.busy}
                onClick={() => props.onUndo(item.id)}>
                Undo
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StreamsPanel(
  props: Readonly<{
    streams: StreamRow[];
    selected: string | null;
    newStream: string;
    busy: boolean;
    onNewStreamChange: (v: string) => void;
    onSelect: (id: string) => void;
    onAdd: () => void;
    onCheckIn: (id: string) => void;
    onCheckOut: (id: string) => void;
    onRemove: (id: string) => void;
    onUnauthorized: () => void;
    onStreamSettingsSaved: (streamId: string) => void;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
  }>,
) {
  const [settingsStreamId, setSettingsStreamId] = useState<string | null>(null);

  return (
    <section className="panel">
      <h1>Streams</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAdd();
        }}>
        <input
          value={props.newStream}
          onChange={(e) => props.onNewStreamChange(e.target.value)}
          placeholder="tiktok username"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" disabled={props.busy || !props.newStream.trim()}>
          Add
        </button>
      </form>
      <ul className="list">
        {props.streams.map((s) => {
          const settingsOpen = settingsStreamId === s.streamId;
          return (
            <li key={s.streamId} className="list-item">
              <button
                type="button"
                className={
                  props.selected === s.streamId
                    ? 'stream-btn selected'
                    : 'stream-btn'
                }
                onClick={() => props.onSelect(s.streamId)}>
                <span>@{s.streamId}</span>
                <span className="muted">
                  {s.isCheckedIn ? 'checked in' : 'out'}
                </span>
              </button>
              <div className="row tight">
                {s.isCheckedIn ? (
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onCheckOut(s.streamId)}>
                    Check out
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={props.busy}
                    onClick={() => props.onCheckIn(s.streamId)}>
                    Check in
                  </button>
                )}
                <button
                  type="button"
                  className={settingsOpen ? 'primary' : undefined}
                  disabled={props.busy}
                  onClick={() =>
                    setSettingsStreamId((prev) =>
                      prev === s.streamId ? null : s.streamId,
                    )
                  }>
                  {settingsOpen ? 'Close' : 'Settings'}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={props.busy}
                  onClick={() => props.onRemove(s.streamId)}>
                  Remove
                </button>
              </div>
              {settingsOpen ? (
                <StreamSettingsEditor
                  streamId={s.streamId}
                  busy={props.busy}
                  withBusy={props.withBusy}
                  onUnauthorized={props.onUnauthorized}
                  onSaved={() => props.onStreamSettingsSaved(s.streamId)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.streams.length === 0 ? (
        <p className="muted">Add a TikTok username to get started.</p>
      ) : null}
    </section>
  );
}

function StreamSettingsEditor(
  props: Readonly<{
    streamId: string;
    busy: boolean;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
    onUnauthorized: () => void;
    onSaved: () => void;
  }>,
) {
  const { streamId, onUnauthorized } = props;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keywordsText, setKeywordsText] = useState('');
  const [minDiamonds, setMinDiamonds] = useState('100');
  const [highlightUsersText, setHighlightUsersText] = useState('');
  const [highlightRecentGifters, setHighlightRecentGifters] = useState(true);
  const [recentGifterMinDiamonds, setRecentGifterMinDiamonds] = useState('1');
  const [recentGifterWindowSeconds, setRecentGifterWindowSeconds] =
    useState('120');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const cfg = await getConfig(streamId);
        if (cancelled) return;
        setKeywordsText(cfg.chatKeywordFlags.join('\n'));
        const diamondRule = cfg.giftAlertRules.find(
          (r) => typeof r.minDiamondValue === 'number',
        );
        setMinDiamonds(String(diamondRule?.minDiamondValue ?? 100));
        const h = cfg.chatHighlights ?? DEFAULT_CHAT_HIGHLIGHTS;
        setHighlightUsersText(h.highlightUsernames.join('\n'));
        setHighlightRecentGifters(h.highlightRecentGifters);
        setRecentGifterMinDiamonds(String(h.recentGifterMinDiamonds));
        setRecentGifterWindowSeconds(String(h.recentGifterWindowSeconds));
      } catch (err) {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streamId, onUnauthorized]);

  return (
    <div className="stream-settings">
      <h3 className="settings-section">Alerts &amp; highlights</h3>
      {loading ? <p className="muted">Loading settings…</p> : null}
      {loadError ? <p className="banner error">{loadError}</p> : null}
      {!loading && !loadError ? (
        <>
          <label className="field">
            <span>Gift alert: min diamonds</span>
            <input
              type="number"
              min={1}
              value={minDiamonds}
              onChange={(e) => setMinDiamonds(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Flagged chat keywords (one per line)</span>
            <textarea
              rows={3}
              value={keywordsText}
              onChange={(e) => setKeywordsText(e.target.value)}
              placeholder={'spam\nscam'}
            />
          </label>
          <label className="field">
            <span>Always highlight usernames (one per line)</span>
            <textarea
              rows={3}
              value={highlightUsersText}
              onChange={(e) => setHighlightUsersText(e.target.value)}
              placeholder={'vip_user\ncohost'}
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={highlightRecentGifters}
              onChange={(e) => setHighlightRecentGifters(e.target.checked)}
            />
            <span>Highlight chat from recent gifters</span>
          </label>
          <div className="row">
            <label className="field grow">
              <span>Gifter min diamonds</span>
              <input
                type="number"
                min={1}
                value={recentGifterMinDiamonds}
                onChange={(e) => setRecentGifterMinDiamonds(e.target.value)}
              />
            </label>
            <label className="field grow">
              <span>Window (seconds)</span>
              <input
                type="number"
                min={10}
                value={recentGifterWindowSeconds}
                onChange={(e) => setRecentGifterWindowSeconds(e.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            className="primary"
            disabled={props.busy}
            onClick={() =>
              void props.withBusy(async () => {
                const rules: GiftAlertRule[] = [
                  {
                    minDiamondValue: Number(minDiamonds) || 100,
                    label: `Gift ≥ ${Number(minDiamonds) || 100} diamonds`,
                  },
                ];
                const chatKeywordFlags = keywordsText
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean);
                const chatHighlights: ChatHighlightConfig = {
                  highlightUsernames: highlightUsersText
                    .split('\n')
                    .map((s) => s.trim().replace(/^@/, ''))
                    .filter(Boolean),
                  highlightRecentGifters,
                  recentGifterMinDiamonds: Number(recentGifterMinDiamonds) || 1,
                  recentGifterWindowSeconds:
                    Number(recentGifterWindowSeconds) || 120,
                };
                await putConfig(props.streamId, {
                  giftAlertRules: rules,
                  chatKeywordFlags,
                  chatHighlights,
                });
                props.onSaved();
              })
            }>
            Save stream settings
          </button>
        </>
      ) : null}
    </div>
  );
}

function SettingsPanel(
  props: Readonly<{
    passcode: string;
    passcodeRequired: boolean;
    pushStatus: string;
    busy: boolean;
    onPasscodeChange: (v: string) => void;
    onPasscodeBlur: () => void;
    onLock: () => void;
    onEnablePush: () => void;
    onTestPush: () => void;
  }>,
) {
  return (
    <section className="panel">
      <h1>Settings</h1>
      <p className="muted note">
        Per-stream alerts and chat highlights are on each stream card under
        Streams.
      </p>
      {props.passcodeRequired ? (
        <div className="field">
          <span>Session</span>
          <button type="button" onClick={props.onLock}>
            Lock / sign out
          </button>
        </div>
      ) : (
        <label className="field">
          <span>Mod passcode (optional)</span>
          <input
            type="password"
            value={props.passcode}
            onChange={(e) => props.onPasscodeChange(e.target.value)}
            onBlur={props.onPasscodeBlur}
            placeholder="shared passcode"
          />
        </label>
      )}
      <div className="field">
        <span>Push notifications (Android Chrome)</span>
        <div className="row">
          <button type="button" onClick={props.onEnablePush}>
            Enable push
          </button>
          <button type="button" disabled={props.busy} onClick={props.onTestPush}>
            Send test
          </button>
        </div>
        {props.pushStatus ? <p className="muted">{props.pushStatus}</p> : null}
      </div>
    </section>
  );
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('401:');
}
